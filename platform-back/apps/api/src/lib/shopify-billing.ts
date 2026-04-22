import { getSecret } from "@platform-back/crypto";
import { logger } from "@platform-back/logger";
import type { BillingPlan, BillingInterval } from "@platform-back/types";
import { PLANS } from "@platform-back/types";
import type { TenantRecord } from "@platform-back/db";

// SHOPIFY_BILLING_MODE: "disabled" | "test" | "live"
//   disabled — bypass Shopify entirely (required for custom apps + local dev)
//   test     — call Shopify with test:true (no real charges, public/unlisted app staging)
//   live     — call Shopify with test:false (production)
const BILLING_TEST_MODE =
  (process.env["SHOPIFY_BILLING_MODE"] ?? "disabled") === "test";

const PLATFORM_URL = process.env["PLATFORM_URL"] ?? "http://localhost:3002";

const APP_SUBSCRIPTION_CREATE = `
  mutation appSubscriptionCreate(
    $name: String!
    $returnUrl: URL!
    $trialDays: Int!
    $test: Boolean!
    $amount: Decimal!
    $currencyCode: CurrencyCode!
    $interval: AppPricingInterval!
  ) {
    appSubscriptionCreate(
      name: $name
      returnUrl: $returnUrl
      trialDays: $trialDays
      test: $test
      lineItems: [{
        plan: {
          appRecurringPricingDetails: {
            price: { amount: $amount, currencyCode: $currencyCode }
            interval: $interval
          }
        }
      }]
    ) {
      appSubscription { id status }
      confirmationUrl
      userErrors { field message }
    }
  }
`;

const APP_SUBSCRIPTION_CANCEL = `
  mutation appSubscriptionCancel($id: ID!) {
    appSubscriptionCancel(id: $id) {
      appSubscription { id status }
      userErrors { field message }
    }
  }
`;

export async function createSubscription(
  tenant: TenantRecord,
  plan: BillingPlan,
  interval: BillingInterval = "monthly",
): Promise<{ confirmationUrl: string; subscriptionId: string }> {
  const planDef = PLANS[plan];
  if (!planDef || planDef.priceMonthly === 0) {
    throw new Error(`Cannot create Shopify subscription for ${plan} plan`);
  }
  if (!tenant.shopDomain || !tenant.shopifyAccessTokenSecretName) {
    throw new Error("Tenant has no shop domain or access token");
  }

  const accessToken = await getSecret(tenant.shopifyAccessTokenSecretName);
  const returnUrl = `${PLATFORM_URL}/billing/callback?tenant_id=${tenant.id}&plan=${plan}&interval=${interval}`;
  const isAnnual = interval === "annual";
  const amount = isAnnual
    ? (planDef.priceYearly / 100).toFixed(2)
    : (planDef.priceMonthly / 100).toFixed(2);

  const result = await shopifyGraphql(
    tenant.shopDomain,
    accessToken,
    APP_SUBSCRIPTION_CREATE,
    {
      name: `${planDef.name} Plan (${isAnnual ? "Annual" : "Monthly"})`,
      returnUrl,
      trialDays: planDef.limits.trialDays,
      test: BILLING_TEST_MODE,
      amount,
      currencyCode: "USD",
      interval: isAnnual ? "ANNUAL" : "EVERY_30_DAYS",
    },
  );

  const data = result.appSubscriptionCreate as {
    confirmationUrl: string;
    appSubscription: { id: string };
    userErrors: Array<{ message: string }>;
  };
  if (data.userErrors?.length > 0) {
    throw new Error(
      `Shopify billing error: ${data.userErrors.map((e) => e.message).join(", ")}`,
    );
  }
  logger.info(
    { tenantId: tenant.id, plan, subscriptionId: data.appSubscription.id },
    "Shopify subscription created",
  );
  return {
    confirmationUrl: data.confirmationUrl,
    subscriptionId: data.appSubscription.id,
  };
}

export async function cancelSubscription(tenant: TenantRecord): Promise<void> {
  if (!tenant.shopifySubscriptionId) {
    logger.warn({ tenantId: tenant.id }, "cancelSubscription: no subscription to cancel");
    return;
  }
  if (!tenant.shopDomain || !tenant.shopifyAccessTokenSecretName) {
    throw new Error("Tenant has no shop domain or access token");
  }
  const accessToken = await getSecret(tenant.shopifyAccessTokenSecretName);
  const result = await shopifyGraphql(
    tenant.shopDomain,
    accessToken,
    APP_SUBSCRIPTION_CANCEL,
    { id: tenant.shopifySubscriptionId },
  );
  const data = result.appSubscriptionCancel as {
    appSubscription: { id: string };
    userErrors: Array<{ message: string }>;
  };
  if (data.userErrors?.length > 0) {
    throw new Error(
      `Shopify cancel error: ${data.userErrors.map((e) => e.message).join(", ")}`,
    );
  }
  logger.info({ tenantId: tenant.id }, "Shopify subscription cancelled");
}

async function shopifyGraphql(
  shopDomain: string,
  accessToken: string,
  query: string,
  variables: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const url = `https://${shopDomain}/admin/api/2026-01/graphql.json`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": accessToken,
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) {
    throw new Error(`Shopify GraphQL ${res.status}: ${await res.text()}`);
  }
  const json = (await res.json()) as {
    data?: Record<string, unknown>;
    errors?: unknown[];
  };
  if (json.errors) {
    throw new Error(`Shopify GraphQL errors: ${JSON.stringify(json.errors)}`);
  }
  return json.data!;
}

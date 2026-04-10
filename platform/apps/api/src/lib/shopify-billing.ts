/**
 * Shopify Billing API client — manages subscriptions via GraphQL mutations.
 *
 * Custom distribution apps get 0% revenue share. Charges appear on the
 * merchant's Shopify invoice — no credit card collection needed.
 *
 * Flow:
 *   1. createSubscription() → returns confirmationUrl
 *   2. Merchant approves on Shopify's page
 *   3. Shopify sends APP_SUBSCRIPTIONS_UPDATE webhook → handleSubscriptionUpdate()
 *   4. We update tenant billing state in DB
 */
import { logger } from "@new-one-two/logger";
import { getSecret } from "@new-one-two/crypto";
import type { BillingPlan, BillingInterval } from "@new-one-two/types";
import type { Tenant } from "@new-one-two/types";
import { PLANS } from "./plans.js";

const PLATFORM_URL = process.env["PLATFORM_URL"] ?? "http://localhost:3002";
// SHOPIFY_BILLING_MODE: "disabled" | "test" | "live"
//   disabled — bypass Shopify entirely (custom apps, local dev)
//   test     — call Shopify with test:true (no real charges, public app staging)
//   live     — call Shopify with test:false (real charges, production)
const BILLING_TEST_MODE = (process.env["SHOPIFY_BILLING_MODE"] ?? "disabled") === "test";

// ─── GraphQL Mutations ────────────────────────────────────────────────────────

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
      lineItems: [
        {
          plan: {
            appRecurringPricingDetails: {
              price: { amount: $amount, currencyCode: $currencyCode }
              interval: $interval
            }
          }
        }
      ]
    ) {
      appSubscription {
        id
        status
      }
      confirmationUrl
      userErrors {
        field
        message
      }
    }
  }
`;

const APP_SUBSCRIPTION_CANCEL = `
  mutation appSubscriptionCancel($id: ID!) {
    appSubscriptionCancel(id: $id) {
      appSubscription {
        id
        status
      }
      userErrors {
        field
        message
      }
    }
  }
`;

// ─── Client Functions ─────────────────────────────────────────────────────────

/**
 * Create a Shopify recurring subscription for a tenant.
 * Returns the confirmation URL where the merchant approves the charge.
 * Supports both monthly and annual billing intervals.
 */
export async function createSubscription(
  tenant: Tenant,
  plan: BillingPlan,
  interval: BillingInterval = "monthly"
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

  // For annual: use yearly price, Shopify interval ANNUAL
  // For monthly: use monthly price, Shopify interval EVERY_30_DAYS
  const isAnnual = interval === "annual";
  const amount = isAnnual
    ? (planDef.priceYearly / 100).toFixed(2)
    : (planDef.priceMonthly / 100).toFixed(2);
  const shopifyInterval = isAnnual ? "ANNUAL" : "EVERY_30_DAYS";

  const result = await shopifyGraphql(tenant.shopDomain, accessToken, APP_SUBSCRIPTION_CREATE, {
    name: `Ton ${planDef.name} Plan (${isAnnual ? "Annual" : "Monthly"})`,
    returnUrl,
    trialDays: planDef.limits.trialDays,
    test: BILLING_TEST_MODE,
    amount,
    currencyCode: "USD",
    interval: shopifyInterval,
  });

  const data = result.appSubscriptionCreate;
  if (data.userErrors?.length > 0) {
    const errors = data.userErrors.map((e: { message: string }) => e.message).join(", ");
    throw new Error(`Shopify billing error: ${errors}`);
  }

  logger.info(
    { tenantId: tenant.id, plan, subscriptionId: data.appSubscription.id },
    "Shopify subscription created"
  );

  return {
    confirmationUrl: data.confirmationUrl,
    subscriptionId: data.appSubscription.id,
  };
}

/**
 * Cancel an existing Shopify subscription.
 */
export async function cancelSubscription(
  tenant: Tenant
): Promise<void> {
  if (!tenant.shopifySubscriptionId) {
    logger.warn({ tenantId: tenant.id }, "No subscription to cancel");
    return;
  }

  if (!tenant.shopDomain || !tenant.shopifyAccessTokenSecretName) {
    throw new Error("Tenant has no shop domain or access token");
  }

  const accessToken = await getSecret(tenant.shopifyAccessTokenSecretName);

  const result = await shopifyGraphql(tenant.shopDomain, accessToken, APP_SUBSCRIPTION_CANCEL, {
    id: tenant.shopifySubscriptionId,
  });

  const data = result.appSubscriptionCancel;
  if (data.userErrors?.length > 0) {
    const errors = data.userErrors.map((e: { message: string }) => e.message).join(", ");
    logger.error({ tenantId: tenant.id, errors }, "Failed to cancel Shopify subscription");
    throw new Error(`Shopify cancel error: ${errors}`);
  }

  logger.info({ tenantId: tenant.id }, "Shopify subscription cancelled");
}

// ─── Shopify GraphQL Helper ───────────────────────────────────────────────────

async function shopifyGraphql(
  shopDomain: string,
  accessToken: string,
  query: string,
  variables: Record<string, unknown>
): Promise<Record<string, any>> {
  const url = `https://${shopDomain}/admin/api/2026-01/graphql.json`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": accessToken,
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!response.ok) {
    throw new Error(`Shopify GraphQL ${response.status}: ${await response.text()}`);
  }

  const json = await response.json() as { data?: Record<string, any>; errors?: unknown[] };
  if (json.errors) {
    throw new Error(`Shopify GraphQL errors: ${JSON.stringify(json.errors)}`);
  }

  return json.data!;
}

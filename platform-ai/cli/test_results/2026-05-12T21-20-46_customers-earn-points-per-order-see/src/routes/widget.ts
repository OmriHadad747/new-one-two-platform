import { Router } from "express";
import type { Request, Response } from "express";
import { sql } from "../lib/db.js";
import { config } from "../lib/config.js";
import { money } from "../lib/money.js";
import { shopifyClientFor } from "../lib/shopify.js";

export const widgetRouter = Router();

// GET /balance
widgetRouter.get("/balance", async (req: Request, res: Response): Promise<void> => {
  const customerExternalId: string = req.query?.customer_external_id as string;

  // parse customer id to number for DB query
  const customerId = Number(customerExternalId);

  // read configured redemption rate
  const pointsToDiscountRate: number = await config.get("loyalty_points_to_discount_rate", 0.01);

  // fetch customer balance snapshot
  const snapshotRows = await sql<{ available_points: number }[]>`
    SELECT available_points
    FROM customer_balance_snapshots
    WHERE customer_external_id = ${customerId}
    LIMIT 1
  `;

  // resolve available points defaulting to 0 for new customers
  const availablePoints = snapshotRows.length > 0 ? Number(snapshotRows[0]!.available_points) : 0;

  // compute monetary equivalent as plain decimal string
  const monetaryEquivalent = String((availablePoints * pointsToDiscountRate).toFixed(2));

  res.status(200).json({
    available_points: availablePoints,
    monetary_equivalent: monetaryEquivalent,
  });
  return;
});

// GET /redemption/current
widgetRouter.get("/redemption/current", async (req: Request, res: Response): Promise<void> => {
  const cartExternalId: string = req.query?.cart_external_id as string;
  const customerExternalId: string = req.query?.customer_external_id as string;

  // parse customer id to number
  const customerId = Number(customerExternalId);

  // look up active redemption for this cart and customer
  const redemptionRows = await sql<{
    id: string;
    points_applied: number;
    discount_value_minor: number;
    currency: string;
    discount_code: string;
    status: string;
  }[]>`
    SELECT id, points_applied, discount_value_minor, currency, discount_code, status
    FROM point_redemptions
    WHERE cart_external_id = ${cartExternalId}
      AND customer_external_id = ${customerId}
      AND status = 'active'
    LIMIT 1
  `;

  // return null fields when no active redemption exists
  if (redemptionRows.length === 0) {
    res.status(200).json({
      redemption_id: null,
      points_applied: null,
      discount_value: null,
      discount_code: null,
      status: null,
    });
    return;
  } else {
    // format discount value as decimal string using money helper
    const discountValueStr = money.format(
      Number(redemptionRows[0]!.discount_value_minor),
      redemptionRows[0]!.currency,
    );

    res.status(200).json({
      redemption_id: redemptionRows[0]!.id,
      points_applied: redemptionRows[0]!.points_applied,
      discount_value: discountValueStr,
      discount_code: redemptionRows[0]!.discount_code,
      status: redemptionRows[0]!.status,
    });
    return;
  }
});

// POST /redemption/apply
widgetRouter.post("/redemption/apply", async (req: Request, res: Response): Promise<void> => {
  const customerExternalId: string = req.body?.customer_external_id;
  const cartExternalId: string = req.body?.cart_external_id;
  const pointsRequested: number = req.body?.points_requested;
  const currency: string = req.body?.currency;

  // parse customer id to number
  const customerId = Number(customerExternalId);

  // read current balance snapshot for validation
  const snapshotRows = await sql<{ available_points: number }[]>`
    SELECT available_points
    FROM customer_balance_snapshots
    WHERE customer_external_id = ${customerId}
    LIMIT 1
  `;

  // resolve available points
  const availablePoints = snapshotRows.length > 0 ? Number(snapshotRows[0]!.available_points) : 0;

  // reject if requested points exceed available balance or are not positive
  if (pointsRequested > availablePoints || pointsRequested <= 0) {
    res.status(400).json({
      error: "points_requested exceeds available balance or is not positive",
    });
    return;
  }

  // read redemption rate from config
  const pointsToDiscountRate: number = await config.get("loyalty_points_to_discount_rate", 0.01);

  // compute discount value in minor units using money helper
  const discountValueMinor = money.toMinorUnits(
    String((pointsRequested * pointsToDiscountRate).toFixed(2)),
    currency,
  );

  // format discount value as decimal string for Shopify mutation input
  const discountValueDecimal = money.format(discountValueMinor, currency);

  // generate a unique single-use discount code
  const discountCode = `LOYALTY${customerId}${Date.now()}`;

  // build the customer GID for Shopify discount scope
  const customerGid = `gid://shopify/Customer/${customerId}`;

  // build ISO timestamp for discount startsAt
  const startsAt = new Date().toISOString();

  // Atomic INSERT-form claim — insert pending redemption row
  const pendingClaim = await sql<{ id: string }[]>`
    INSERT INTO point_redemptions (customer_external_id, cart_external_id, points_applied, discount_value_minor, currency, status)
    VALUES (${customerId}, ${cartExternalId}, ${pointsRequested}, ${discountValueMinor}, ${currency}, 'pending')
    ON CONFLICT (cart_external_id, customer_external_id, status) DO NOTHING
    RETURNING id
  `;

  // reject if concurrent request already claimed a pending slot for this cart
  if (pendingClaim.length === 0) {
    res.status(409).json({
      error: "an active redemption already exists for this cart",
    });
    return;
  }

  // capture pending redemption id at outer scope for use in response and catch arm
  const pendingRedemptionId = pendingClaim[0]!.id;

  // assemble the full DiscountCodeBasicInput object for the Shopify mutation
  const discountInput = {
    title: `LOYALTY-${customerId}-${Date.now()}`,
    code: discountCode,
    startsAt: startsAt,
    appliesOncePerCustomer: true,
    usageLimit: 1,
    customerGets: {
      items: { all: true },
      value: { discountAmount: { amount: discountValueDecimal, appliesOnEachItem: false } },
    },
    customerSelection: { customers: { add: [customerGid] } },
  };

  // create Shopify discount, activate redemption row, and write ledger debit atomically
  try {
    const shopify = await shopifyClientFor(req.platform!);

    const discountResult = await shopify.graphql<{
      discountCodeBasicCreate: {
        codeDiscountNode: {
          id: string;
          codeDiscount: {
            codes: { nodes: { code: string }[] };
          };
        };
        userErrors: { field: string[] | null; message: string }[];
      };
    }>(
      `mutation CreateLoyaltyDiscount($basicCodeDiscount: DiscountCodeBasicInput!) {
         discountCodeBasicCreate(basicCodeDiscount: $basicCodeDiscount) {
           codeDiscountNode {
             id
             codeDiscount {
               ... on DiscountCodeBasic {
                 codes(first: 1) { nodes { code } }
               }
             }
           }
           userErrors { field message }
         }
       }`,
      { basicCodeDiscount: discountInput },
    );

    if (discountResult.discountCodeBasicCreate.userErrors.length > 0) {
      throw new Error(
        `discountCodeBasicCreate failed: ${discountResult.discountCodeBasicCreate.userErrors.map((e) => e.message).join("; ")}`,
      );
    }

    // extract discount GID and code from mutation result
    const discountInfo = {
      discountGid: discountResult.discountCodeBasicCreate.codeDiscountNode.id,
      discountCodeReturned:
        discountResult.discountCodeBasicCreate.codeDiscountNode.codeDiscount.codes.nodes[0]!.code,
    };

    // atomically activate the redemption row with discount details, insert ledger debit, and decrement balance snapshot
    await sql.begin(async (tx) => {
      await tx`
        UPDATE point_redemptions
        SET status = 'active',
            discount_external_id = ${discountInfo.discountGid},
            discount_code = ${discountInfo.discountCodeReturned},
            updated_at = now()
        WHERE id = ${pendingRedemptionId}
      `;

      await tx`
        INSERT INTO point_ledger (customer_external_id, redemption_id, entry_type, points_delta)
        VALUES (${customerId}, ${pendingRedemptionId}, 'redemption_debit', ${-pointsRequested})
      `;

      await tx`
        UPDATE customer_balance_snapshots
        SET available_points = available_points - ${pointsRequested},
            lifetime_redeemed = lifetime_redeemed + ${pointsRequested},
            updated_at = now()
        WHERE customer_external_id = ${customerId}
      `;
    });

    // compute remaining balance after debit
    const remainingBalance = availablePoints - pointsRequested;

    res.status(200).json({
      redemption_id: pendingRedemptionId,
      points_applied: pointsRequested,
      discount_value: discountValueDecimal,
      discount_code: discountInfo.discountCodeReturned,
      remaining_balance: remainingBalance,
    });
    return;
  } catch (applyError: any) {
    await sql`
      UPDATE point_redemptions
      SET status = 'cancelled',
          failure_reason = ${applyError.message},
          updated_at = now()
      WHERE id = ${pendingRedemptionId}
    `;

    console.error(
      {
        requestId: req.platform!.requestId,
        customer_id: customerId,
        cart_id: cartExternalId,
        error: applyError.message,
      },
      "redemption apply failed",
    );

    res.status(500).json({
      error: "failed to apply redemption",
    });
    return;
  }
});

// POST /redemption/cancel
widgetRouter.post("/redemption/cancel", async (req: Request, res: Response): Promise<void> => {
  const redemptionId: string = req.body?.redemption_id;
  const customerExternalId: string = req.body?.customer_external_id;

  // parse customer id to number
  const customerId = Number(customerExternalId);

  // fetch the active redemption row for the given id and customer
  const redemptionRows = await sql<{
    id: string;
    points_applied: number;
    discount_external_id: string;
    currency: string;
    discount_value_minor: number;
  }[]>`
    SELECT id, points_applied, discount_external_id, currency, discount_value_minor
    FROM point_redemptions
    WHERE id = ${redemptionId}
      AND customer_external_id = ${customerId}
      AND status = 'active'
    LIMIT 1
  `;

  // exit if no active redemption found for this id and customer
  if (redemptionRows.length === 0) {
    res.status(404).json({
      error: "active redemption not found",
    });
    return;
  }

  // extract redemption fields needed for downstream steps
  const redemptionInfo = {
    pointsApplied: Number(redemptionRows[0]!.points_applied),
    discountGid: redemptionRows[0]!.discount_external_id,
    currency: redemptionRows[0]!.currency,
  };

  // void Shopify discount, then atomically mark cancelled and restore balance
  try {
    const shopify = await shopifyClientFor(req.platform!);

    const deactivateResult = await shopify.graphql<{
      discountCodeDeactivate: {
        codeDiscountNode: { id: string };
        userErrors: { field: string[] | null; message: string }[];
      };
    }>(
      `mutation DeactivateLoyaltyDiscount($id: ID!) {
         discountCodeDeactivate(id: $id) {
           codeDiscountNode { id }
           userErrors { field message }
         }
       }`,
      { id: redemptionInfo.discountGid },
    );

    if (deactivateResult.discountCodeDeactivate.userErrors.length > 0) {
      throw new Error(
        `discountCodeDeactivate failed: ${deactivateResult.discountCodeDeactivate.userErrors.map((e) => e.message).join("; ")}`,
      );
    }

    // Atomic UPDATE-form claim — mark redemption cancelled only if still active
    const claimedRedemption = await sql<{ id: string; points_applied: number; currency: string }[]>`
      UPDATE point_redemptions
      SET status = 'cancelled',
          updated_at = now()
      WHERE id = ${redemptionId}
        AND customer_external_id = ${customerId}
        AND status = 'active'
      RETURNING id, points_applied, currency
    `;

    if (claimedRedemption.length === 0) {
      res.status(200).json({
        restored_balance: 0,
        status: "cancelled",
      });
      return;
    }

    // atomically write cancellation credit to ledger and restore balance snapshot
    await sql.begin(async (tx) => {
      await tx`
        INSERT INTO point_ledger (customer_external_id, redemption_id, entry_type, points_delta)
        VALUES (${customerId}, ${redemptionId}, 'cancellation_credit', ${redemptionInfo.pointsApplied})
      `;

      await tx`
        UPDATE customer_balance_snapshots
        SET available_points = available_points + ${redemptionInfo.pointsApplied},
            lifetime_redeemed = GREATEST(0, lifetime_redeemed - ${redemptionInfo.pointsApplied}),
            updated_at = now()
        WHERE customer_external_id = ${customerId}
      `;
    });

    // read restored balance to include in response
    const restoredRows = await sql<{ available_points: number }[]>`
      SELECT available_points
      FROM customer_balance_snapshots
      WHERE customer_external_id = ${customerId}
      LIMIT 1
    `;

    // resolve restored balance value
    const restoredBalance = restoredRows.length > 0 ? Number(restoredRows[0]!.available_points) : 0;

    res.status(200).json({
      restored_balance: restoredBalance,
      status: "cancelled",
    });
    return;
  } catch (cancelError: any) {
    await sql`
      UPDATE point_redemptions
      SET failure_reason = ${cancelError.message},
          updated_at = now()
      WHERE id = ${redemptionId}
        AND status = 'active'
    `;

    console.error(
      {
        requestId: req.platform!.requestId,
        redemption_id: redemptionId,
        error: cancelError.message,
      },
      "redemption cancel failed — row remains active for retry",
    );

    res.status(500).json({
      error: "cancellation failed — discount may still be active; contact support",
    });
    return;
  }
});
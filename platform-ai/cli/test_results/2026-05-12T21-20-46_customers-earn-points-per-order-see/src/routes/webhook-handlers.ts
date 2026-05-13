import type { Request } from "express";
import { sql } from "../lib/db.js";
import { config } from "../lib/config.js";
import { money } from "../lib/money.js";

export const webhookHandlers: Record<
  string,
  (payload: unknown, req: Request) => Promise<void>
> = {
  "orders/paid": async (payload: unknown, req: Request) => {
    const orderId: number = (payload as any)?.id;
    const customerIdRaw: number = (payload as any)?.customer?.id;
    const totalPriceRaw: string = (payload as any)?.total_price;
    const currencyRaw: string = (payload as any)?.currency;

    // null-defend the customer id
    const customerId = customerIdRaw ?? null;

    // skip guest-checkout orders without a customer
    if (customerId === null) {
      console.log(
        { requestId: req.platform!.requestId, order_id: orderId },
        "skipping earn: guest checkout, no customer",
      );
      return;
    }

    // Atomic INSERT-form claim — one row per order; duplicate delivery returns zero rows
    const claimed = await sql<{ order_external_id: number }[]>`
      INSERT INTO earn_idempotency (order_external_id, customer_external_id, points_earned)
      VALUES (${orderId}, ${customerId}, 0)
      ON CONFLICT (order_external_id) DO NOTHING
      RETURNING order_external_id
    `;

    // duplicate webhook delivery — claim returned zero rows; skip
    if (claimed.length === 0) {
      console.log(
        { requestId: req.platform!.requestId, order_id: orderId },
        "skipping earn: duplicate orders/paid webhook",
      );
      return;
    }

    // read configured earn rate from config store
    const pointsPerDollar: number = await config.get("loyalty_points_per_dollar", 1);

    // convert order total to minor units using money helper
    const totalMinor = money.toMinorUnits(totalPriceRaw, currencyRaw);

    // compute integer points earned: floor(dollars * rate)
    const pointsEarned = Math.floor(money.fromMinorUnits(totalMinor, currencyRaw) * pointsPerDollar);

    // atomically write ledger entry, update idempotency record, and upsert balance snapshot
    await sql.begin(async (tx) => {
      await tx`
        INSERT INTO point_ledger (customer_external_id, order_external_id, entry_type, points_delta)
        VALUES (${customerId}, ${orderId}, 'earn', ${pointsEarned})
      `;

      await tx`
        UPDATE earn_idempotency
        SET points_earned = ${pointsEarned}
        WHERE order_external_id = ${orderId}
      `;

      await tx`
        INSERT INTO customer_balance_snapshots (customer_external_id, available_points, lifetime_earned, lifetime_redeemed)
        VALUES (${customerId}, ${pointsEarned}, ${pointsEarned}, 0)
        ON CONFLICT (customer_external_id) DO UPDATE
        SET available_points = customer_balance_snapshots.available_points + ${pointsEarned},
            lifetime_earned = customer_balance_snapshots.lifetime_earned + ${pointsEarned},
            updated_at = now()
      `;
    });

    console.log(
      {
        requestId: req.platform!.requestId,
        order_id: orderId,
        customer_id: customerId,
        points_earned: pointsEarned,
      },
      "loyalty earn credited",
    );
  },

  "refunds/create": async (payload: unknown, req: Request) => {
    const refundId: number = (payload as any)?.id;
    const orderId: number = (payload as any)?.order_id;
    const transactions: object[] = (payload as any)?.transactions;

    // null-defend transactions array
    const safeTransactions = transactions ?? [];

    // extract the first refund transaction's amount and currency (kind='refund')
    const refundTxn = (safeTransactions as any[]).find((t) => t.kind === "refund") ?? null;

    // skip refunds with no monetary refund transaction
    if (refundTxn === null) {
      console.log(
        { requestId: req.platform!.requestId, refund_id: refundId, order_id: orderId },
        "skipping reversal: no refund transaction in payload",
      );
      return;
    }

    // look up the original earn entry for this order
    const earnRows = await sql<{ customer_external_id: number; points_delta: number }[]>`
      SELECT customer_external_id, points_delta
      FROM point_ledger
      WHERE order_external_id = ${orderId}
        AND entry_type = 'earn'
      LIMIT 1
    `;

    // skip if no earn entry exists for this order
    if (earnRows.length === 0) {
      console.log(
        { requestId: req.platform!.requestId, refund_id: refundId, order_id: orderId },
        "skipping reversal: no earn entry found for order",
      );
      return;
    }

    // extract customer id and original points earned from ledger row
    const earnInfo = {
      customerId: earnRows[0]!.customer_external_id,
      originalPoints: earnRows[0]!.points_delta,
    };

    // Atomic INSERT-form claim — one row per refund using resolved customer id
    const claimed = await sql<{ refund_external_id: number }[]>`
      INSERT INTO refund_idempotency (refund_external_id, order_external_id, customer_external_id, points_reversed)
      VALUES (${refundId}, ${orderId}, ${earnInfo.customerId}, 0)
      ON CONFLICT (refund_external_id) DO NOTHING
      RETURNING refund_external_id
    `;

    // duplicate webhook delivery — claim returned zero rows
    if (claimed.length === 0) {
      console.log(
        { requestId: req.platform!.requestId, refund_id: refundId },
        "skipping reversal: duplicate refunds/create webhook",
      );
      return;
    }

    // read configured earn rate
    const pointsPerDollar: number = await config.get("loyalty_points_per_dollar", 1);

    // convert refund amount to minor units using money helper
    const refundMinor = money.toMinorUnits(refundTxn.amount, refundTxn.currency);

    // compute raw points to reverse proportional to refunded amount
    const rawPointsToReverse = Math.min(
      Math.floor(money.fromMinorUnits(refundMinor, refundTxn.currency) * pointsPerDollar),
      earnInfo.originalPoints,
    );

    // read current balance snapshot to determine clamp
    const snapshotRows = await sql<{ available_points: number }[]>`
      SELECT available_points
      FROM customer_balance_snapshots
      WHERE customer_external_id = ${earnInfo.customerId}
      LIMIT 1
    `;

    // clamp points to reverse to available balance (cannot go negative)
    const pointsToReverse = Math.min(
      rawPointsToReverse,
      snapshotRows.length > 0 ? Number(snapshotRows[0]!.available_points) : 0,
    );

    // atomically write ledger debit, update idempotency row, and decrement balance snapshot
    await sql.begin(async (tx) => {
      await tx`
        INSERT INTO point_ledger (customer_external_id, order_external_id, refund_external_id, entry_type, points_delta)
        VALUES (${earnInfo.customerId}, ${orderId}, ${refundId}, 'refund_reversal', ${-pointsToReverse})
      `;

      await tx`
        UPDATE refund_idempotency
        SET points_reversed = ${pointsToReverse}
        WHERE refund_external_id = ${refundId}
      `;

      await tx`
        UPDATE customer_balance_snapshots
        SET available_points = GREATEST(0, available_points - ${pointsToReverse}),
            updated_at = now()
        WHERE customer_external_id = ${earnInfo.customerId}
      `;
    });

    console.log(
      {
        requestId: req.platform!.requestId,
        refund_id: refundId,
        order_id: orderId,
        points_reversed: pointsToReverse,
      },
      "loyalty reversal applied",
    );
  },
};
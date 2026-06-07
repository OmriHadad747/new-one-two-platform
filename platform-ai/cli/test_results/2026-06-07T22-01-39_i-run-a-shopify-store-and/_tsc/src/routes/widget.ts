import type { Request, Response } from "express";
import { sql } from "../lib/db.js";
import { Router } from "express";
import { randomBytes } from "crypto";
import type {
  WidgetSignupRequest,
  WidgetSignupResponse,
  WidgetSignupStatusRequest,
  WidgetSignupStatusResponse,
  UnsubscribeRequest,
  UnsubscribeResponse,
  WaitlistSignupRow,
  UnsubscribeToken,
} from "../types/contracts.js";

export const widgetRouter = Router();

// ─── helpers ────────────────────────────────────────────────────────────────

function safe(s: string): string {
  return s.replace(/\0/g, "");
}

function generateUnsubscribeToken(): UnsubscribeToken {
  return randomBytes(32).toString("hex") as UnsubscribeToken;
}

/** Validate that a value is a plausible numeric string (Shopify external id) */
function isNumericId(val: unknown): val is string {
  return typeof val === "string" && /^\d+$/.test(val) && val.length > 0;
}

// ─── POST /widget/signup ─────────────────────────────────────────────────────

widgetRouter.post("/widget/signup", async (req: Request, res: Response): Promise<void> => {
  const body = req.body as Partial<WidgetSignupRequest>;

  const email = typeof body.email === "string" ? safe(body.email.trim()) : "";
  const itemExternalId = body.item_external_id;
  const itemType = body.item_type;
  const productExternalId = body.product_external_id;

  // Validate inputs
  if (!email || !email.includes("@")) {
    const response: WidgetSignupResponse = {
      result: "error",
      message: "A valid email address is required.",
    };
    res.status(400).json(response);
    return;
  }

  if (!isNumericId(itemExternalId)) {
    const response: WidgetSignupResponse = {
      result: "error",
      message: "item_external_id must be a numeric Shopify id.",
    };
    res.status(400).json(response);
    return;
  }

  if (itemType !== "variant" && itemType !== "product") {
    const response: WidgetSignupResponse = {
      result: "error",
      message: "item_type must be 'variant' or 'product'.",
    };
    res.status(400).json(response);
    return;
  }

  if (!isNumericId(productExternalId)) {
    const response: WidgetSignupResponse = {
      result: "error",
      message: "product_external_id must be a numeric Shopify id.",
    };
    res.status(400).json(response);
    return;
  }

  // Attempt insert — ON CONFLICT makes duplicate a no-op
  const token = generateUnsubscribeToken();

  const inserted = await sql<{ id: string }[]>`
    INSERT INTO waitlist_signups
      (email, item_external_id, item_type, product_external_id, unsubscribe_token, status, signed_up_at)
    VALUES
      (${email}, ${itemExternalId}, ${itemType}, ${productExternalId}, ${token}, 'pending', now())
    ON CONFLICT (email, item_external_id) DO NOTHING
    RETURNING id
  `;

  if (inserted.length === 0) {
    // Duplicate signup — the unique constraint caught it
    const response: WidgetSignupResponse = {
      result: "duplicate",
      message: "You're already on the waitlist for this item. We'll notify you when it's back!",
    };
    res.json(response);
    return;
  }

  console.log(
    {
      requestId: req.platform!.requestId,
      itemExternalId,
      itemType,
    },
    "waitlist signup recorded",
  );

  // Update or create demand stats snapshot for this item
  // Upsert snapshot waitlist_count
  await sql`
    INSERT INTO demand_stats_snapshots
      (item_external_id, item_type, product_external_id, waitlist_count, total_signups,
       total_notified, total_conversions, last_refreshed_at)
    VALUES
      (${itemExternalId}, ${itemType}, ${productExternalId}, 1, 1, 0, 0, now())
    ON CONFLICT (item_external_id)
    DO UPDATE SET
      waitlist_count  = demand_stats_snapshots.waitlist_count + 1,
      total_signups   = demand_stats_snapshots.total_signups + 1,
      last_refreshed_at = now()
  `;

  const response: WidgetSignupResponse = {
    result: "created",
    message: "You're on the list! We'll email you the moment it's back in stock.",
  };
  res.status(201).json(response);
});

// ─── GET /widget/signup/status ───────────────────────────────────────────────

widgetRouter.get(
  "/widget/signup/status",
  async (req: Request, res: Response): Promise<void> => {
    const email =
      typeof req.query.email === "string" ? req.query.email.trim() : null;
    const itemExternalId =
      typeof req.query.item_external_id === "string"
        ? req.query.item_external_id
        : null;

    if (!email || !itemExternalId) {
      const response: WidgetSignupStatusResponse = {
        signed_up: false,
        item_external_id: itemExternalId ?? "",
      };
      res.json(response);
      return;
    }

    const [existing] = await sql<Pick<WaitlistSignupRow, "id" | "status">[]>`
      SELECT id, status
      FROM waitlist_signups
      WHERE email = ${email}
        AND item_external_id = ${itemExternalId}
        AND deleted_at IS NULL
      LIMIT 1
    `;

    const signedUp =
      !!existing && existing.status !== "unsubscribed" && existing.status !== "deleted";

    const response: WidgetSignupStatusResponse = {
      signed_up: signedUp,
      item_external_id: itemExternalId,
    };
    res.json(response);
  },
);

// ─── GET /unsubscribe ─────────────────────────────────────────────────────────

widgetRouter.get("/unsubscribe", async (req: Request, res: Response): Promise<void> => {
  const token =
    typeof req.query.token === "string" ? req.query.token : null;

  if (!token) {
    const response: UnsubscribeResponse = {
      result: "error",
      message: "Unsubscribe token is required.",
    };
    res.status(400).json(response);
    return;
  }

  // Check token exists
  const [signup] = await sql<Pick<WaitlistSignupRow, "id" | "email">[]>`
    SELECT id, email
    FROM waitlist_signups
    WHERE unsubscribe_token = ${token}
    LIMIT 1
  `;

  if (!signup) {
    const response: UnsubscribeResponse = {
      result: "not_found",
      message: "This unsubscribe link is invalid or has already been used.",
    };
    res.status(404).json(response);
    return;
  }

  // Unsubscribe all waitlists for this email (across all items)
  await sql`
    UPDATE waitlist_signups
    SET status = 'unsubscribed'
    WHERE email = ${signup.email}
      AND status IN ('pending', 'notified')
  `;

  console.log(
    { requestId: req.platform!.requestId, email: signup.email },
    "shopper unsubscribed from all waitlists",
  );

  const response: UnsubscribeResponse = {
    result: "success",
    message:
      "You've been unsubscribed from all back-in-stock notifications. You won't receive any further emails.",
  };
  res.json(response);
});

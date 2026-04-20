import { sql } from "@platform-back/db";

// Persists deployment metadata to Postgres. Two writes per deploy:
//   1. handler_sa_email on apps (set once, doesn't change on redeploy)
//   2. deployed_functions row, with the new revision marked active and
//      any prior revision deactivated in the same transaction
//
// Webhook-subscription writes deliberately omitted — that's a separate
// concern (webhook archetype, phase 3).

export async function writeHandlerSaEmail(
  appId: string,
  saEmail: string,
): Promise<void> {
  await sql`
    UPDATE apps
       SET handler_sa_email = ${saEmail},
           updated_at = NOW()
     WHERE id = ${appId}
  `;
}

export interface UpsertDeployedFunctionInput {
  appVersionId: string;
  appId: string;
  tenantId: string;
  functionUrl: string;
  runtime: "nodejs20" | "nodejs18";
  memoryMb: number;
  timeoutSec: number;
}

/**
 * Inserts the new active deployed_functions row and deactivates any
 * prior active rows for the same app — atomic in a single transaction
 * so we never have two "active" rows for one app.
 */
export async function upsertDeployedFunction(
  input: UpsertDeployedFunctionInput,
): Promise<{ id: string }> {
  return sql.begin(async (tx) => {
    await tx`
      UPDATE deployed_functions
         SET is_active = FALSE
       WHERE app_id = ${input.appId} AND is_active = TRUE
    `;
    const rows = await tx<Array<{ id: string }>>`
      INSERT INTO deployed_functions (
        app_version_id, app_id, tenant_id, function_url,
        runtime, memory_mb, timeout_sec, is_active
      ) VALUES (
        ${input.appVersionId}, ${input.appId}, ${input.tenantId}, ${input.functionUrl},
        ${input.runtime}, ${input.memoryMb}, ${input.timeoutSec}, TRUE
      )
      RETURNING id
    `;
    return { id: rows[0]!.id };
  });
}

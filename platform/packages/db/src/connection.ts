import postgres from "postgres";

// ─── Connection Pool ──────────────────────────────────────────────────────────

export const sql = postgres(process.env["DATABASE_URL"]!, {
  max: 20,
  idle_timeout: 30,
  connect_timeout: 10,
  transform: postgres.camel, // snake_case → camelCase automatically
});

// ─── RLS Context Helper ───────────────────────────────────────────────────────
// Sets app.current_tenant_id for the duration of a transaction so RLS policies
// filter correctly. Always use this wrapper for tenant-scoped queries against
// a force-RLS'd table (today: generation_sessions per migration 0003).
//
// The callback receives a `postgres.Sql` handle rather than the library's
// `TransactionSql` — the latter extends `Omit<Sql, ...>` which strips the
// tagged-template call signature and breaks `tx\`SELECT ...\`` at compile
// time. The runtime shape is identical (postgres.begin() hands back the
// same object); this just preserves the callable template overload for
// TypeScript.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type TenantSql = postgres.Sql<any>;

export async function withTenantContext<TResult>(
  tenantId: string,
  fn: (sql: TenantSql) => Promise<TResult>
): Promise<TResult> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return sql.begin(async (tx: any) => {
    await tx`SELECT set_config('app.current_tenant_id', ${tenantId}, TRUE)`;
    return fn(tx as TenantSql);
  }) as Promise<TResult>;
}

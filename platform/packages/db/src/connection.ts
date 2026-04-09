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
// filter correctly. Always use this wrapper for tenant-scoped queries.

export async function withTenantContext<TResult>(
  tenantId: string,
  fn: (sql: postgres.TransactionSql) => Promise<TResult>
): Promise<TResult> {
  // postgres.TransactionSql extends Omit<Sql, ...>, which strips call signatures
  // in TypeScript's type system. Cast tx to any to work around this type bug.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return sql.begin(async (tx: any) => {
    await tx`SELECT set_config('app.current_tenant_id', ${tenantId}, TRUE)`;
    return fn(tx);
  }) as Promise<TResult>;
}

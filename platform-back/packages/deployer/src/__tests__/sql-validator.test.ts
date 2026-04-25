import { describe, it, expect } from "vitest";
import { validateMigrationSql, makeIdempotent } from "../sql-validator.js";

const VALID_SQL = `
CREATE TABLE orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_email TEXT NOT NULL,
  amount INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_orders_customer ON orders (customer_email);
`;

describe("validateMigrationSql — passes valid DDL", () => {
  it("accepts CREATE TABLE", () => {
    expect(() => validateMigrationSql(VALID_SQL)).not.toThrow();
  });

  it("accepts CREATE INDEX", () => {
    expect(() => validateMigrationSql("CREATE INDEX idx_foo ON foo (bar);")).not.toThrow();
  });

  it("accepts CREATE UNIQUE INDEX", () => {
    expect(() => validateMigrationSql("CREATE UNIQUE INDEX idx_foo ON foo (bar);")).not.toThrow();
  });

  it("accepts ALTER TABLE ADD COLUMN IF NOT EXISTS", () => {
    expect(() =>
      validateMigrationSql("ALTER TABLE orders ADD COLUMN IF NOT EXISTS notes TEXT;"),
    ).not.toThrow();
  });

  it("accepts COMMENT ON", () => {
    expect(() => validateMigrationSql("COMMENT ON TABLE orders IS 'order records';")).not.toThrow();
  });
});

describe("validateMigrationSql — rejects destructive statements", () => {
  const cases: [string, string][] = [
    ["DROP TABLE orders;", "DROP TABLE"],
    ["DROP COLUMN foo;", "DROP COLUMN"],
    ["DROP INDEX idx_foo;", "DROP INDEX"],
    ["DROP POLICY my_policy ON orders;", "DROP POLICY"],
    ["DROP SCHEMA tenant_abc;", "DROP SCHEMA"],
    ["DROP DATABASE mydb;", "DROP DATABASE"],
    ["DROP TYPE my_enum;", "DROP TYPE"],
    ["DROP FUNCTION my_fn();", "DROP FUNCTION"],
    ["DROP TRIGGER trig ON orders;", "DROP TRIGGER"],
    ["DROP ROLE readonly;", "DROP ROLE"],
    ["DROP USER bob;", "DROP USER"],
    ["TRUNCATE orders;", "TRUNCATE"],
    ["DELETE FROM orders WHERE id = 1;", "DELETE FROM"],
    ["UPDATE orders SET amount = 0 WHERE id = 1;", "UPDATE … SET"],
  ];

  for (const [sql, label] of cases) {
    it(`rejects ${label}`, () => {
      expect(() => validateMigrationSql(sql)).toThrow();
    });
  }
});

describe("validateMigrationSql — rejects privilege/transaction escapes", () => {
  it("rejects CONCURRENTLY", () => {
    expect(() => validateMigrationSql("CREATE INDEX CONCURRENTLY idx ON foo (bar);")).toThrow();
  });

  it("rejects GRANT", () => {
    expect(() => validateMigrationSql("GRANT SELECT ON orders TO readonly;")).toThrow();
  });

  it("rejects REVOKE", () => {
    expect(() => validateMigrationSql("REVOKE SELECT ON orders FROM readonly;")).toThrow();
  });

  it("rejects SET ROLE", () => {
    expect(() => validateMigrationSql("SET ROLE admin;")).toThrow();
  });

  it("rejects SET SESSION AUTHORIZATION", () => {
    expect(() => validateMigrationSql("SET SESSION AUTHORIZATION alice;")).toThrow();
  });

  it("rejects ALTER POLICY", () => {
    expect(() => validateMigrationSql("ALTER POLICY my_policy ON foo USING (true);")).toThrow();
  });

  it("rejects ALTER ROLE", () => {
    expect(() => validateMigrationSql("ALTER ROLE bob SET search_path TO public;")).toThrow();
  });
});

describe("validateMigrationSql — rejects code-execution escapes", () => {
  it("rejects DO $$ … $$", () => {
    expect(() => validateMigrationSql("DO $$ BEGIN NULL; END $$;")).toThrow();
  });

  it("rejects COPY … FROM PROGRAM", () => {
    expect(() => validateMigrationSql("COPY foo FROM PROGRAM 'echo hello';")).toThrow();
  });

  it("rejects CREATE EXTENSION", () => {
    expect(() => validateMigrationSql("CREATE EXTENSION IF NOT EXISTS pg_trgm;")).toThrow();
  });

  it("rejects CREATE FUNCTION", () => {
    expect(() =>
      validateMigrationSql("CREATE FUNCTION my_fn() RETURNS void AS $$ $$ LANGUAGE sql;"),
    ).toThrow();
  });

  it("rejects CREATE OR REPLACE FUNCTION", () => {
    expect(() =>
      validateMigrationSql(
        "CREATE OR REPLACE FUNCTION my_fn() RETURNS void AS $$ $$ LANGUAGE sql;",
      ),
    ).toThrow();
  });

  it("rejects CREATE TRIGGER", () => {
    expect(() =>
      validateMigrationSql(
        "CREATE TRIGGER trig AFTER INSERT ON foo FOR EACH ROW EXECUTE FUNCTION fn();",
      ),
    ).toThrow();
  });
});

describe("validateMigrationSql — rejects legacy RLS patterns", () => {
  it("rejects ENABLE ROW LEVEL SECURITY", () => {
    expect(() => validateMigrationSql("ALTER TABLE foo ENABLE ROW LEVEL SECURITY;")).toThrow();
  });

  it("rejects CREATE POLICY", () => {
    expect(() => validateMigrationSql("CREATE POLICY my_policy ON foo USING (true);")).toThrow();
  });
});

describe("validateMigrationSql — rejects cron scheduling", () => {
  it("rejects cron.schedule", () => {
    expect(() =>
      validateMigrationSql("SELECT cron.schedule('job', '* * * * *', 'SELECT 1');"),
    ).toThrow();
  });

  it("rejects cron.unschedule", () => {
    expect(() => validateMigrationSql("SELECT cron.unschedule('job');")).toThrow();
  });
});

describe("validateMigrationSql — rejects ALTER TABLE non-ADD-COLUMN", () => {
  it("rejects ALTER TABLE without ADD COLUMN IF NOT EXISTS", () => {
    expect(() =>
      validateMigrationSql("ALTER TABLE orders ALTER COLUMN amount TYPE BIGINT;"),
    ).toThrow(/ADD COLUMN IF NOT EXISTS/);
  });

  it("rejects ALTER TABLE RENAME COLUMN", () => {
    expect(() =>
      validateMigrationSql("ALTER TABLE orders RENAME COLUMN amount TO total;"),
    ).toThrow();
  });
});

describe("makeIdempotent", () => {
  it("adds IF NOT EXISTS to CREATE TABLE", () => {
    const out = makeIdempotent("CREATE TABLE foo (id INT);");
    expect(out).toContain("CREATE TABLE IF NOT EXISTS foo");
  });

  it("does not double-add IF NOT EXISTS", () => {
    const out = makeIdempotent("CREATE TABLE IF NOT EXISTS foo (id INT);");
    expect(out).not.toContain("IF NOT EXISTS IF NOT EXISTS");
    expect(out).toContain("CREATE TABLE IF NOT EXISTS foo");
  });

  it("adds IF NOT EXISTS to CREATE INDEX", () => {
    const out = makeIdempotent("CREATE INDEX idx_foo ON foo (bar);");
    expect(out).toContain("CREATE INDEX IF NOT EXISTS idx_foo");
  });

  it("adds IF NOT EXISTS to CREATE UNIQUE INDEX", () => {
    const out = makeIdempotent("CREATE UNIQUE INDEX idx_foo ON foo (bar);");
    expect(out).toContain("CREATE UNIQUE INDEX IF NOT EXISTS idx_foo");
  });

  it("wraps CREATE POLICY in DO $migration$ block", () => {
    const out = makeIdempotent("CREATE POLICY my_policy ON foo USING (true);");
    expect(out).toContain("DO $migration$");
    expect(out).toContain("EXCEPTION WHEN duplicate_object THEN NULL");
    expect(out).toContain("END $migration$");
  });

  it("handles multi-statement SQL", () => {
    const out = makeIdempotent(VALID_SQL);
    expect(out).toContain("CREATE TABLE IF NOT EXISTS orders");
    expect(out).toContain("CREATE INDEX IF NOT EXISTS idx_orders_customer");
  });

  it("is case-insensitive", () => {
    const out = makeIdempotent("create table foo (id int);");
    expect(out.toLowerCase()).toContain("create table if not exists");
  });
});

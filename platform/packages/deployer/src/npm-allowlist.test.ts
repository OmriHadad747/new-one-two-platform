import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ALLOWED_NPM_PACKAGES,
  MAX_PACKAGES,
  packageBaseName,
  packageVersion,
  toDependenciesMap,
  validateNpmPackages,
} from "./npm-allowlist.js";

describe("packageBaseName", () => {
  it("returns the bare name for unscoped packages", () => {
    expect(packageBaseName("uuid@9.0.1")).toBe("uuid");
  });

  it("returns the scoped name for scoped packages", () => {
    expect(packageBaseName("@xmldom/xmldom@0.8.10")).toBe("@xmldom/xmldom");
  });

  it("returns the input unchanged when no version is present", () => {
    expect(packageBaseName("uuid")).toBe("uuid");
    expect(packageBaseName("@xmldom/xmldom")).toBe("@xmldom/xmldom");
  });

  // The following edge cases can only arise if a caller bypasses
  // validateNpmPackages. We pin the observable behaviour so callers that
  // forward unknown input into packageBaseName get a deterministic answer
  // rather than a surprise.
  it("handles '@scope' with no trailing name or version", () => {
    expect(packageBaseName("@scope")).toBe("@scope");
  });

  it("handles '@scope/name' with no @version", () => {
    expect(packageBaseName("@scope/name")).toBe("@scope/name");
  });
});

describe("packageVersion", () => {
  it("returns the version segment", () => {
    expect(packageVersion("uuid@9.0.1")).toBe("9.0.1");
    expect(packageVersion("@xmldom/xmldom@0.8.10")).toBe("0.8.10");
  });

  it("throws when no version is present", () => {
    expect(() => packageVersion("uuid")).toThrow(/no version/);
  });
});

describe("validateNpmPackages — happy path", () => {
  it("accepts an empty list", () => {
    expect(validateNpmPackages([])).toEqual({ ok: true, errors: [] });
  });

  it("accepts every package on the allowlist at a pinned version", () => {
    const all = [...ALLOWED_NPM_PACKAGES].map((p) => `${p}@1.2.3`);
    const r = validateNpmPackages(all);
    expect(r).toEqual({ ok: true, errors: [] });
  });

  it("accepts a pre-release version", () => {
    const r = validateNpmPackages(["uuid@9.0.1-rc.1"]);
    expect(r.ok).toBe(true);
  });

  it("accepts a scoped package at a pinned version", () => {
    const r = validateNpmPackages(["@xmldom/xmldom@0.8.10"]);
    expect(r.ok).toBe(true);
  });
});

describe("validateNpmPackages — supply-chain attack vectors", () => {
  it("rejects a CLI-flag-shaped entry", () => {
    const r = validateNpmPackages(["--registry=http://evil.example.com"]);
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toMatch(/starts with '-'/);
  });

  it("rejects an unpinned caret range", () => {
    const r = validateNpmPackages(["uuid@^9.0.0"]);
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toMatch(/required form/);
  });

  it("rejects an unpinned tilde range", () => {
    const r = validateNpmPackages(["uuid@~9.0"]);
    expect(r.ok).toBe(false);
  });

  it("rejects a `latest` tag", () => {
    const r = validateNpmPackages(["uuid@latest"]);
    expect(r.ok).toBe(false);
  });

  it("rejects a missing version", () => {
    const r = validateNpmPackages(["uuid"]);
    expect(r.ok).toBe(false);
  });

  it("rejects a partial semver", () => {
    const r = validateNpmPackages(["uuid@9", "uuid@9.0"]);
    expect(r.ok).toBe(false);
    expect(r.errors.length).toBe(2);
  });

  it("rejects a package that is not in the allowlist even at a good version", () => {
    const r = validateNpmPackages(["react@19.0.0"]);
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toMatch(/not in the allowlist/);
  });

  it("rejects an oversized list", () => {
    const big = Array.from({ length: MAX_PACKAGES + 1 }, () => "uuid@9.0.1");
    const r = validateNpmPackages(big);
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toMatch(/limit is 20/);
  });

  it("rejects a non-string entry", () => {
    const r = validateNpmPackages([{ name: "uuid" } as unknown as string]);
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toMatch(/non-string entry/);
  });

  it("rejects an empty-string entry", () => {
    const r = validateNpmPackages([""]);
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toMatch(/empty string/);
  });

  it("accumulates multiple errors across entries", () => {
    const r = validateNpmPackages(["uuid@^9.0.0", "react@19.0.0"]);
    expect(r.ok).toBe(false);
    expect(r.errors.length).toBe(2);
  });
});

describe("toDependenciesMap", () => {
  it("produces an npm-install-compatible dependencies map", () => {
    const deps = toDependenciesMap(["uuid@9.0.1", "@xmldom/xmldom@0.8.10"]);
    expect(deps).toEqual({
      uuid: "9.0.1",
      "@xmldom/xmldom": "0.8.10",
    });
  });

  it("returns an empty object for an empty list", () => {
    expect(toDependenciesMap([])).toEqual({});
  });
});

// ─── Harness transitive overlap guard ─────────────────────────────────────────
//
// Node's module resolver walks `node_modules` from the caller's directory
// upward BEFORE consulting NODE_PATH. Handler deps are installed into
// `/app/handler_modules/node_modules` (exposed via NODE_PATH) but the harness
// tree at `/app/node_modules/` wins the resolution race for any package that
// appears in both.
//
// That silently shadows the handler's pinned-semver version for every
// overlapping package — defeating the core C1 win (pinned-semver enforcement)
// for those packages specifically.
//
// This guard reads the committed harness lockfile and fails CI the moment
// any allowlisted package shows up in the harness's transitive closure
// without being explicitly acknowledged in ACCEPTED_OVERLAPS below. The goal
// is NOT to forbid overlaps outright — the GCP deps have a large transitive
// footprint and the allowlist will keep growing — but to force a conscious
// decision every time a new overlap appears:
//
//   (a) drop the package from ALLOWED_NPM_PACKAGES and document that
//       handlers get the harness-pinned version, or
//   (b) add it to ACCEPTED_OVERLAPS with a short rationale.
//
// Follow-up: file an issue to drop `uuid` from the allowlist (on both sides
// — the TS set here AND generator/subagents/static_validation.py), and note
// in handler-writing docs that require("uuid") is always available via the
// harness at the version pinned by runtime-package-lock.json. Deferred out
// of this PR to avoid a cross-repo / generator-regeneration change.
const ACCEPTED_OVERLAPS: ReadonlySet<string> = new Set([
  // uuid@9.0.1 is transitively pulled by @google-cloud/* and
  // google-auth-library. The allowlist declares uuid at a version that
  // matches what the lockfile pins today, so the overlap is benign —
  // require("uuid") from a handler resolves through /app/node_modules to
  // 9.0.1 either way. To be removed in a follow-up PR that also drops it
  // from the Python side of the allowlist.
  "uuid",
]);

describe("harness transitive overlap guard", () => {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const LOCKFILE = path.resolve(
    __dirname,
    "../../../apps/harness-runtime/runtime-package-lock.json"
  );

  interface NpmLockfile {
    packages?: Record<string, { version?: string }>;
  }

  async function readHarnessPackages(): Promise<Map<string, string>> {
    const raw = await fs.readFile(LOCKFILE, "utf8");
    const parsed = JSON.parse(raw) as NpmLockfile;
    const present = new Map<string, string>();
    for (const [key, value] of Object.entries(parsed.packages ?? {})) {
      if (!key) continue;
      // Keys look like "node_modules/<name>" or
      // "node_modules/<name>/node_modules/<transitive>" for nested installs.
      // We want the LAST segment that comes after "node_modules/".
      const match = [...key.matchAll(/node_modules\/((?:@[^/]+\/)?[^/]+)/g)].pop();
      if (!match) continue;
      const name = match[1];
      if (name !== undefined && value.version) {
        present.set(name, value.version);
      }
    }
    return present;
  }

  it("the lockfile is parseable and non-empty", async () => {
    const harnessPackages = await readHarnessPackages();
    expect(harnessPackages.size).toBeGreaterThan(0);
  });

  it("every overlap between the allowlist and the harness lockfile is acknowledged in ACCEPTED_OVERLAPS", async () => {
    const harnessPackages = await readHarnessPackages();
    const overlap = [...ALLOWED_NPM_PACKAGES].filter((pkg) =>
      harnessPackages.has(pkg)
    );
    const unacknowledged = overlap.filter((pkg) => !ACCEPTED_OVERLAPS.has(pkg));

    if (unacknowledged.length > 0) {
      const details = unacknowledged
        .map((p) => `  - ${p} (harness pins ${harnessPackages.get(p)})`)
        .join("\n");
      throw new Error(
        `New unacknowledged overlap between ALLOWED_NPM_PACKAGES and the harness ` +
          `lockfile at apps/harness-runtime/runtime-package-lock.json:\n${details}\n\n` +
          `A handler declaring any of these packages will silently receive the ` +
          `harness-pinned version (resolved via /app/node_modules, which takes ` +
          `priority over NODE_PATH).\n\n` +
          `Decide one of:\n` +
          `  (a) drop the package from ALLOWED_NPM_PACKAGES and document that ` +
          `handlers get the harness-pinned version via /app/node_modules, or\n` +
          `  (b) add the package to ACCEPTED_OVERLAPS in this test file with a ` +
          `short rationale, when the version-match is intentional and stable.`
      );
    }
    expect(unacknowledged).toEqual([]);
  });

  it("every entry in ACCEPTED_OVERLAPS is still present in the allowlist and the lockfile", async () => {
    // Housekeeping: if a harness dep is dropped or the allowlist changes,
    // stale entries in ACCEPTED_OVERLAPS become dead weight. Fail so the
    // maintainer prunes them.
    const harnessPackages = await readHarnessPackages();
    const stale = [...ACCEPTED_OVERLAPS].filter(
      (pkg) => !ALLOWED_NPM_PACKAGES.has(pkg) || !harnessPackages.has(pkg)
    );
    expect(stale).toEqual([]);
  });
});

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

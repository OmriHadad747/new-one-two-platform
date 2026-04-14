// End-to-end assertion of the build-context shape: what createBuildContext
// actually drops on disk for a Docker build. The reviewer on PR #13 flagged
// that unit-level tests on buildDockerfile alone missed a live install
// regression — these tests compose fs-builder + dockerfile-template together
// and inspect both the generated Dockerfile AND the handler-deps.json shape
// a real `docker build` would consume.

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createBuildContext, removeBuildContext } from "./fs-builder.js";

// createBuildContext copies the harness-runtime bundle and lockfile into the
// build dir. Those artifacts only exist after `pnpm --filter @new-one-two/harness-runtime build`.
// On a fresh checkout (no build yet) the tests in this file would throw ENOENT.
// Skip gracefully with a clear message rather than a cryptic filesystem error.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HARNESS_BUNDLE_FOR_CHECK = path.resolve(
  __dirname,
  "../../../apps/harness-runtime/dist/server.cjs"
);
async function harnessBundleExists(): Promise<boolean> {
  try {
    await fs.access(HARNESS_BUNDLE_FOR_CHECK);
    return true;
  } catch {
    return false;
  }
}
const bundlePresent = await harnessBundleExists();
const describeFs = bundlePresent ? describe : describe.skip;
if (!bundlePresent) {
  // eslint-disable-next-line no-console
  console.warn(
    `[fs-builder.test] skipping — run \`pnpm --filter @new-one-two/harness-runtime build\` to enable these cases`
  );
}

// Fixed UUID + semver so assertions on handler-deps.json are deterministic.
const APP_ID = "00000000-0000-4000-8000-000000000000";
const SEMVER = "1.2.3";
const HANDLER_STUB = "module.exports = { handler: async () => ({}) };";

const buildDirs: string[] = [];

async function build(
  code: Record<string, string>,
  npmPackages: string[] = []
): Promise<string> {
  const dir = await createBuildContext(APP_ID, SEMVER, code, npmPackages);
  buildDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (buildDirs.length > 0) {
    const dir = buildDirs.pop()!;
    await removeBuildContext(dir);
  }
});

describeFs("createBuildContext — common files", () => {
  it("emits server.cjs, harness package.json, lockfile, handler.js, Dockerfile", async () => {
    const dir = await build({ "handler.js": "module.exports = {};" });
    const files = await fs.readdir(dir);
    expect(files).toEqual(expect.arrayContaining([
      "server.cjs",
      "harness-runtime-package.json",
      "harness-runtime-package-lock.json",
      "handler.js",
      "Dockerfile",
    ]));
  });

  it("does not emit handler-deps.json when npmPackages is empty", async () => {
    const dir = await build({ "handler.js": HANDLER_STUB });
    const files = await fs.readdir(dir);
    expect(files).not.toContain("handler-deps.json");
  });
});

describeFs("createBuildContext — with handler deps", () => {
  it("writes a handler-deps.json shaped like a valid npm package.json", async () => {
    const dir = await build(
      { "handler.js": HANDLER_STUB },
      ["uuid@9.0.1", "@xmldom/xmldom@0.8.10"]
    );

    const raw = await fs.readFile(path.join(dir, "handler-deps.json"), "utf8");
    const parsed = JSON.parse(raw) as {
      name: string;
      version: string;
      private: boolean;
      dependencies: Record<string, string>;
    };

    expect(parsed.name).toBe(`handler-${APP_ID}`);
    expect(parsed.version).toBe(SEMVER);
    expect(parsed.private).toBe(true);
    expect(parsed.dependencies).toEqual({
      uuid: "9.0.1",
      "@xmldom/xmldom": "0.8.10",
    });
  });

  it("generates a Dockerfile that installs the handler deps into a subdirectory", async () => {
    const dir = await build({ "handler.js": HANDLER_STUB }, ["uuid@9.0.1"]);
    const dockerfile = await fs.readFile(path.join(dir, "Dockerfile"), "utf8");

    // The reviewer on PR #13 reproduced that `mv handler-deps.json package.json
    // && npm install` at /app prunes the harness deps. The install must
    // happen in /app/handler_modules, leaving /app/node_modules alone.
    expect(dockerfile).toContain("COPY handler-deps.json ./handler_modules/package.json");
    expect(dockerfile).toMatch(/cd handler_modules\s+\\\s+&&\s+npm install/);
    expect(dockerfile).not.toContain("mv handler-deps.json package.json");
    expect(dockerfile).toContain("ENV NODE_PATH=/app/handler_modules/node_modules");
  });

  it("still uses `npm ci` for the harness step even when handler deps are present", async () => {
    const dir = await build({ "handler.js": HANDLER_STUB }, ["uuid@9.0.1"]);
    const dockerfile = await fs.readFile(path.join(dir, "Dockerfile"), "utf8");
    expect(dockerfile).toMatch(/npm ci --omit=dev --ignore-scripts/);
  });
});

describeFs("createBuildContext — stricter input shape", () => {
  it("rejects a non-UUID appId", async () => {
    await expect(
      createBuildContext("not-a-uuid", SEMVER, { "handler.js": HANDLER_STUB })
    ).rejects.toThrow(/appId.*not a UUID/);
  });

  it("rejects an uppercase-hex UUID — npm package names are lowercase-only", async () => {
    // Postgres uuid_generate_v4() always returns lowercase hex, but the
    // deployer no longer relies on that by coincidence: APP_ID_RE is
    // case-sensitive so any upstream code that normalises a UUID to
    // uppercase fails loud here instead of deep inside `npm install`.
    // NB: pick a UUID with actual hex letters (a–f) so .toUpperCase()
    // changes something — the all-zero APP_ID fixture is case-invariant.
    const upper = "ABCDEF12-ABCD-4AB1-8AB1-ABCDEF123456";
    await expect(
      createBuildContext(upper, SEMVER, { "handler.js": HANDLER_STUB })
    ).rejects.toThrow(/appId.*not a UUID/);
  });

  it("rejects a non-semver version", async () => {
    await expect(
      createBuildContext(APP_ID, "latest", { "handler.js": HANDLER_STUB })
    ).rejects.toThrow(/semver.*major\.minor\.patch/);
  });

  it("re-rejects bad npmPackages even if parseMetadata was bypassed", async () => {
    await expect(
      createBuildContext(APP_ID, SEMVER, { "handler.js": HANDLER_STUB }, [
        "--registry=http://evil",
      ])
    ).rejects.toThrow(/npmPackages failed validation/);
  });

  it("rejects a bundle with no handler.js", async () => {
    await expect(
      createBuildContext(APP_ID, SEMVER, {})
    ).rejects.toThrow(/must contain 'handler\.js'/);
  });
});

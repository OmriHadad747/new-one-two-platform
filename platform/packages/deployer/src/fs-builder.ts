import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildDockerfile } from "./dockerfile-template.js";
import { toDependenciesMap, validateNpmPackages } from "./npm-allowlist.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Path to the pre-built harness bundle in the monorepo
const HARNESS_BUNDLE = path.resolve(__dirname, "../../../apps/harness-runtime/dist/server.cjs");
const HARNESS_RUNTIME_PACKAGE = path.resolve(__dirname, "../../../apps/harness-runtime/runtime-package.json");
const HARNESS_RUNTIME_LOCKFILE = path.resolve(__dirname, "../../../apps/harness-runtime/runtime-package-lock.json");

// npm's package.json grammar is stricter than UUIDs / our semver column: names
// must be lowercase, 214 chars max, [a-z0-9._-] with optional @scope/. We pin
// the shapes the deployer actually produces so a malformed input fails at the
// deployer boundary with a clear error rather than mid-Docker-build with an
// opaque npm validation diagnostic.
//
// appId is a uuid_generate_v4() result: 8-4-4-4-12 lowercase hex + hyphens.
// No /i flag — Postgres always returns lowercase, and npm's package-name
// grammar is lowercase-only, so tightening here catches any path that
// somehow produces uppercase hex before it reaches `npm install`.
const APP_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// semver matches the DB CHECK constraint in 0001_core_schema.sql — major.minor.patch
const SEMVER_RE = /^\d+\.\d+\.\d+$/;

export async function createBuildContext(
  appId: string,
  semver: string,
  generatedCode: Record<string, string>,
  npmPackages: string[] = []
): Promise<string> {
  if (!APP_ID_RE.test(appId)) {
    throw new Error(`createBuildContext: appId '${appId}' is not a UUID`);
  }
  if (!SEMVER_RE.test(semver)) {
    throw new Error(`createBuildContext: semver '${semver}' is not major.minor.patch`);
  }

  // Defense in depth: parseMetadata has already validated npmPackages, but
  // re-check here so a future caller that skips the metadata path cannot
  // smuggle a bad list past the allowlist.
  const validation = validateNpmPackages(npmPackages);
  if (!validation.ok) {
    throw new Error(
      `createBuildContext: npmPackages failed validation for appId=${appId}:\n  - ` +
        validation.errors.join("\n  - ")
    );
  }

  const buildDir = await fs.mkdtemp(path.join(os.tmpdir(), `deploy-${appId}-`));

  // 1. Copy harness bundle
  await fs.copyFile(HARNESS_BUNDLE, path.join(buildDir, "server.cjs"));

  // 2. Copy harness runtime package.json + lockfile for reproducible `npm ci`
  await fs.copyFile(HARNESS_RUNTIME_PACKAGE, path.join(buildDir, "harness-runtime-package.json"));
  await fs.copyFile(HARNESS_RUNTIME_LOCKFILE, path.join(buildDir, "harness-runtime-package-lock.json"));

  // 3. Write tenant handler code
  const handlerCode = generatedCode["handler.js"];
  if (!handlerCode) {
    throw new Error(`generatedCode must contain 'handler.js' (appId=${appId}, semver=${semver})`);
  }
  await fs.writeFile(path.join(buildDir, "handler.js"), handlerCode, "utf8");

  // 4. Emit a handler-deps.json for any declared handler dependencies. The
  //    Dockerfile COPYs this file and renames it to package.json at build
  //    time (see dockerfile-template.ts) — nothing from the LLM ever reaches
  //    npm via the command line.
  if (npmPackages.length > 0) {
    const handlerDeps = {
      name: `handler-${appId}`,
      version: semver,
      private: true,
      dependencies: toDependenciesMap(npmPackages),
    };
    await fs.writeFile(
      path.join(buildDir, "handler-deps.json"),
      JSON.stringify(handlerDeps, null, 2) + "\n",
      "utf8"
    );
  }

  // 5. Write Dockerfile
  await fs.writeFile(path.join(buildDir, "Dockerfile"), buildDockerfile(npmPackages), "utf8");

  return buildDir;
}

export async function removeBuildContext(buildDir: string): Promise<void> {
  await fs.rm(buildDir, { recursive: true, force: true });
}

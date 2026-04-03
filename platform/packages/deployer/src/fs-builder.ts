import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildDockerfile } from "./dockerfile-template.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Path to the pre-built harness bundle in the monorepo
const HARNESS_BUNDLE = path.resolve(__dirname, "../../../apps/harness-runtime/dist/server.cjs");
const HARNESS_RUNTIME_PACKAGE = path.resolve(__dirname, "../../../apps/harness-runtime/runtime-package.json");

export async function createBuildContext(
  appId: string,
  semver: string,
  generatedCode: Record<string, string>
): Promise<string> {
  const buildDir = await fs.mkdtemp(path.join(os.tmpdir(), `deploy-${appId}-`));

  // 1. Copy harness bundle
  await fs.copyFile(HARNESS_BUNDLE, path.join(buildDir, "server.cjs"));

  // 2. Copy harness runtime package.json (GCP native deps)
  await fs.copyFile(HARNESS_RUNTIME_PACKAGE, path.join(buildDir, "harness-runtime-package.json"));

  // 3. Write tenant handler code
  const handlerCode = generatedCode["handler.js"];
  if (!handlerCode) {
    throw new Error(`generatedCode must contain 'handler.js' (appId=${appId}, semver=${semver})`);
  }
  await fs.writeFile(path.join(buildDir, "handler.js"), handlerCode, "utf8");

  // 4. Write tenant package.json (optional tenant dependencies)
  const tenantPkgJson = generatedCode["package.json"] ?? '{"dependencies":{}}';
  await fs.writeFile(path.join(buildDir, "tenant-package.json"), tenantPkgJson, "utf8");

  // 5. Write Dockerfile
  await fs.writeFile(path.join(buildDir, "Dockerfile"), buildDockerfile(), "utf8");

  return buildDir;
}

export async function removeBuildContext(buildDir: string): Promise<void> {
  await fs.rm(buildDir, { recursive: true, force: true });
}

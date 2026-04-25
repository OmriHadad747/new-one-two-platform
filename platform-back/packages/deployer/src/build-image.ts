import { spawn } from "node:child_process";
import { CloudBuildClient } from "@google-cloud/cloudbuild";
import { logger } from "@platform-back/logger";
import { dockerImageName, GCP_PROJECT_VALUE } from "./service-namer.js";

// Two build modes:
// development → local docker build + push (fast, requires Docker daemon)
// anything else (staging, production) → Cloud Build submission (runs on GCP)

const IS_LOCAL = process.env["NODE_ENV"] === "development";
const SKIP_DOCKER_PUSH = process.env["SKIP_DOCKER_PUSH"] === "true";

export interface BuildImageInput {
  appId: string;
  version: string;
  buildContextDir: string;
}

export interface BuildImageResult {
  imageName: string;
  /** Build log output. May be empty for cloudrun mode where logs live in GCP. */
  output: string;
}

export async function buildAndPushImage(input: BuildImageInput): Promise<BuildImageResult> {
  const imageName = dockerImageName(input.appId, input.version);
  if (IS_LOCAL) {
    return buildLocal(input.buildContextDir, imageName);
  }
  return buildCloudBuild(input.buildContextDir, imageName);
}

// ─── Local docker shell-out ──────────────────────────────────────────────────

function runCommand(cmd: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { cwd, stdio: "pipe" });
    const chunks: Buffer[] = [];
    proc.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    proc.stderr.on("data", (chunk: Buffer) => chunks.push(chunk));
    proc.on("close", (code) => {
      const output = Buffer.concat(chunks).toString("utf8");
      if (code === 0) {
        resolve(output);
      } else {
        reject(new Error(`${cmd} ${args.join(" ")} exited with code ${code}:\n${output}`));
      }
    });
    proc.on("error", reject);
  });
}

async function buildLocal(buildContextDir: string, imageName: string): Promise<BuildImageResult> {
  logger.info({ imageName, buildContextDir }, "[local] docker build");
  const buildOut = await runCommand("docker", ["build", "-t", imageName, "."], buildContextDir);
  let pushOut = "";
  if (SKIP_DOCKER_PUSH) {
    logger.info({ imageName }, "[local] SKIP_DOCKER_PUSH=true — image stays in local daemon");
  } else {
    logger.info({ imageName }, "[local] docker push");
    pushOut = await runCommand("docker", ["push", imageName], process.cwd());
  }
  return { imageName, output: `${buildOut}\n${pushOut}` };
}

// ─── Cloud Build submission ──────────────────────────────────────────────────
//
// We submit a tarball of `buildContextDir` (caller is responsible for
// staging that directory; sub-phase C builds it from handler-template +
// generated routes) and a Build spec that runs `docker build` + push.
// This is exactly what `gcloud builds submit --tag <image> .` does.
//
// We don't stream the tarball ourselves — the @google-cloud/cloudbuild
// SDK doesn't accept a local path directly. Sub-phase D (orchestrator)
// will handle uploading the build context to a GCS bucket first; this
// function takes a pre-uploaded GCS source.

const cloudBuildClient = new CloudBuildClient();

async function buildCloudBuild(
  buildContextDir: string,
  imageName: string,
): Promise<BuildImageResult> {
  // Stub for now — wired in sub-phase D once we have GCS upload of the
  // build context. We throw rather than silently no-op so any premature
  // call is loud.
  throw new Error(
    `buildCloudBuild not implemented yet — Cloud Build pipeline lands in sub-phase D ` +
      `(call sites: ${buildContextDir} → ${imageName}, project: ${GCP_PROJECT_VALUE}, ` +
      `client ready: ${cloudBuildClient !== null})`,
  );
}

// ─── Image deletion (permanent-delete path) ──────────────────────────────────

/**
 * Best-effort image delete. Called once per stored app_versions.semver
 * during permanentDeleteApp. Non-fatal: a failed delete leaves a
 * cost-only orphan in the registry, not a correctness issue. Logs
 * warn + continues so one stale tag can't block teardown.
 *
 * - local (NODE_ENV=development): `docker rmi -f`. Missing images are
 *   expected on dev machines (never pulled, already pruned); skip quietly.
 * - staging/production: shells out to `gcloud artifacts docker images delete`.
 *   The image name is already in Artifact Registry format.
 */
export async function deleteDockerImage(imageName: string): Promise<void> {
  if (IS_LOCAL) {
    try {
      await runCommand("docker", ["rmi", "-f", imageName], process.cwd());
      logger.info({ imageName }, "[local] docker rmi");
    } catch (err) {
      logger.warn(
        { err, imageName },
        "[local] docker rmi failed (image not present?) — continuing",
      );
    }
    return;
  }

  try {
    await runCommand(
      "gcloud",
      ["artifacts", "docker", "images", "delete", imageName, "--quiet", "--delete-tags"],
      process.cwd(),
    );
    logger.info({ imageName }, "Artifact Registry image deleted");
  } catch (err) {
    logger.warn(
      { err, imageName },
      "deleteDockerImage: Artifact Registry delete failed — continuing",
    );
  }
}

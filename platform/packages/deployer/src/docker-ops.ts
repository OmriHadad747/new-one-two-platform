import { spawn } from "node:child_process";
import { logger } from "@new-one-two/logger";

const SKIP_DOCKER_PUSH = process.env["SKIP_DOCKER_PUSH"] === "true";

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

export async function dockerBuild(buildDir: string, imageName: string): Promise<{ output: string }> {
  logger.info({ imageName }, "Building Docker image");
  const output = await runCommand("docker", ["build", "-t", imageName, "."], buildDir);
  logger.info({ imageName }, "Docker image built");
  return { output };
}

export async function dockerPush(imageName: string): Promise<void> {
  if (SKIP_DOCKER_PUSH) {
    logger.info({ imageName }, "Skipping docker push (SKIP_DOCKER_PUSH=true)");
    return;
  }
  logger.info({ imageName }, "Pushing Docker image");
  await runCommand("docker", ["push", imageName], process.cwd());
  logger.info({ imageName }, "Docker image pushed");
}

/**
 * Deletes a Docker image from the local daemon (local mode) or GCR (cloud mode).
 * Non-fatal — logs a warning and continues on failure.
 */
export async function deleteDockerImage(imageName: string): Promise<void> {
  const deployMode = process.env["DEPLOY_MODE"] ?? "cloudrun";
  try {
    if (deployMode === "local") {
      await runCommand("docker", ["rmi", "-f", imageName], process.cwd());
    } else {
      await runCommand(
        "gcloud",
        ["container", "images", "delete", imageName, "--force-delete-tags", "--quiet"],
        process.cwd()
      );
    }
    logger.info({ imageName }, "Docker image deleted");
  } catch (err) {
    logger.warn({ err, imageName }, "Failed to delete Docker image (continuing)");
  }
}

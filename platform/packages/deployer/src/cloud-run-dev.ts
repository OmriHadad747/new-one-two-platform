import { spawn } from "node:child_process";
import { logger } from "@new-one-two/logger";
import { localContainerName } from "./service-namer.js";

const COMPOSE_NETWORK = process.env["COMPOSE_NETWORK"] ?? "new-one-two_default";

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { stdio: "pipe" });
    const chunks: Buffer[] = [];
    proc.stdout.on("data", (c: Buffer) => chunks.push(c));
    proc.stderr.on("data", (c: Buffer) => chunks.push(c));
    proc.on("close", (code) => {
      const out = Buffer.concat(chunks).toString("utf8").trim();
      if (code === 0) resolve(out);
      else reject(new Error(`${cmd} ${args.join(" ")} failed (${code}): ${out}`));
    });
    proc.on("error", reject);
  });
}

function buildEnvArgs(envVars: Record<string, string>): string[] {
  return Object.entries(envVars).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
}

export async function deployToDockerLocal(
  appId: string,
  imageName: string,
  envVars: Record<string, string>
): Promise<{ functionUrl: string }> {
  const containerName = localContainerName(appId);

  // Stop and remove any existing container for this app
  try {
    await run("docker", ["stop", containerName]);
    await run("docker", ["rm", containerName]);
    logger.info({ containerName }, "Removed existing harness container");
  } catch {
    // Container didn't exist — fine
  }

  // Start new container on the compose network
  const args = [
    "run", "-d",
    "--name", containerName,
    "--network", COMPOSE_NETWORK,
    "--restart", "unless-stopped",
    ...buildEnvArgs(envVars),
    imageName,
  ];

  await run("docker", args);
  logger.info({ containerName, imageName }, "Harness container started");

  // The worker (inside compose) reaches it via container name on the shared network.
  return { functionUrl: `http://${containerName}:8080` };
}

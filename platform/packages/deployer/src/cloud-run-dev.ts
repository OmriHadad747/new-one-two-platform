import { spawn } from "node:child_process";
import { logger } from "@new-one-two/logger";
import { localContainerName } from "./service-namer.js";

const COMPOSE_NETWORK = process.env["COMPOSE_NETWORK"] ?? "new-one-two_default";

// Host that both the host machine and Docker containers can use to reach host-bound ports.
// On Mac/Windows Docker Desktop, host.docker.internal is added to /etc/hosts → 127.0.0.1.
// Override with DEV_HARNESS_HOST env var if needed (e.g. on Linux use the Docker bridge IP).
const DEV_HARNESS_HOST = process.env["DEV_HARNESS_HOST"] ?? "host.docker.internal";

// Deterministic host port per app: last 4 hex chars of appId → offset in 9000–9499 range.
function devHostPort(appId: string): number {
  const hex = appId.replace(/-/g, "").slice(-4);
  return 9000 + (parseInt(hex, 16) % 500);
}

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

  const hostPort = devHostPort(appId);

  // Start new container on the compose network, also bound to a host port so
  // services running outside Docker (e.g. the API in dev mode) can reach it.
  const args = [
    "run", "-d",
    "--name", containerName,
    "--network", COMPOSE_NETWORK,
    "--restart", "unless-stopped",
    "-p", `${hostPort}:8080`,
    ...buildEnvArgs(envVars),
    imageName,
  ];

  await run("docker", args);
  logger.info({ containerName, imageName, hostPort }, "Harness container started");

  // host.docker.internal resolves to the host machine from both the host itself
  // (Docker Desktop adds it to /etc/hosts) and from inside Docker containers.
  return { functionUrl: `http://${DEV_HARNESS_HOST}:${hostPort}` };
}

import { spawnSync } from "node:child_process";
import { logger } from "@platform-back/logger";

// Local-dev deploy: run the handler image as a Docker container on the
// Compose network instead of deploying to Cloud Run.
//
// Configured via env vars (set in platform-back/.env):
//   LOCAL_HANDLER_PORT           — host port to bind (default 9002)
//   LOCAL_HANDLER_DOCKER_NETWORK — Compose network name (default new-one-two_default)
//   LOCAL_HANDLER_DATABASE_URL   — postgres URL reachable from inside the
//                                  container (uses docker service name, not localhost)

const PORT = process.env["LOCAL_HANDLER_PORT"] ?? "9002";
const NETWORK = process.env["LOCAL_HANDLER_DOCKER_NETWORK"] ?? "new-one-two_default";
const LOCAL_DB_URL = process.env["LOCAL_HANDLER_DATABASE_URL"] ?? "";

export interface RunHandlerLocallyInput {
  imageName: string;
  appId: string;
  handlerEnv: Record<string, string>;
}

export interface RunHandlerLocallyResult {
  functionUrl: string;
}

export function runHandlerLocally(
  input: RunHandlerLocallyInput,
): RunHandlerLocallyResult {
  const containerName = `handler-${input.appId.slice(0, 8)}`;

  // Stop + remove any existing container for this app (idempotent).
  spawnSync("docker", ["stop", containerName], { stdio: "pipe" });
  spawnSync("docker", ["rm", containerName], { stdio: "pipe" });

  const env: Record<string, string> = {
    ...input.handlerEnv,
    // Override cloud-specific settings for local context.
    NODE_ENV: "development",
    CLOUD_RUN_SKIP_AUTH: "true",
    PORT: "8080",
    // If a docker-network-aware DB URL is configured, it takes precedence
    // over the localhost URL that the deployer's own process uses.
    ...(LOCAL_DB_URL ? { DATABASE_URL: LOCAL_DB_URL } : {}),
  };

  const envArgs = Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]);

  const result = spawnSync(
    "docker",
    [
      "run", "-d",
      "--name", containerName,
      "--network", NETWORK,
      "-p", `${PORT}:8080`,
      ...envArgs,
      input.imageName,
    ],
    { stdio: "pipe" },
  );

  if (result.status !== 0) {
    throw new Error(
      `docker run failed: ${result.stderr?.toString().trim() ?? "unknown error"}`,
    );
  }

  const functionUrl = `http://localhost:${PORT}`;
  logger.info(
    { containerName, functionUrl, imageName: input.imageName },
    "[local] handler container started",
  );
  return { functionUrl };
}

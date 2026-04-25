import { spawnSync } from "node:child_process";
import { logger } from "@platform-back/logger";

// Local-dev deploy: run the handler image as a Docker container on the
// Compose network instead of deploying to Cloud Run.
//
// Matches the pre-refactor single-harness behaviour: fixed port 9002,
// fixed Compose network. DATABASE_URL from the host env has "localhost"
// replaced with the Compose service name "postgres" so the container
// can reach it — no extra env vars needed.

const PORT = "9002";
const NETWORK = "new-one-two_default";

function localDbUrl(): string {
  const url = process.env["DATABASE_URL"] ?? "";
  return url.replace("localhost", "postgres");
}

export interface RunHandlerLocallyInput {
  imageName: string;
  appId: string;
  handlerEnv: Record<string, string>;
}

export interface RunHandlerLocallyResult {
  functionUrl: string;
}

export function runHandlerLocally(input: RunHandlerLocallyInput): RunHandlerLocallyResult {
  const containerName = `handler-${input.appId.slice(0, 8)}`;

  // Stop + remove any existing container for this app (idempotent).
  spawnSync("docker", ["stop", containerName], { stdio: "pipe" });
  spawnSync("docker", ["rm", containerName], { stdio: "pipe" });

  const env: Record<string, string> = {
    ...input.handlerEnv,
    NODE_ENV: "development",
    PORT: "8080",
    DATABASE_URL: localDbUrl(),
  };

  const envArgs = Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]);

  const result = spawnSync(
    "docker",
    [
      "run",
      "-d",
      "--name",
      containerName,
      "--network",
      NETWORK,
      "-p",
      `${PORT}:8080`,
      ...envArgs,
      input.imageName,
    ],
    { stdio: "pipe" },
  );

  if (result.status !== 0) {
    throw new Error(`docker run failed: ${result.stderr?.toString().trim() ?? "unknown error"}`);
  }

  const functionUrl = `http://localhost:${PORT}`;
  logger.info(
    { containerName, functionUrl, imageName: input.imageName },
    "[local] handler container started",
  );
  return { functionUrl };
}

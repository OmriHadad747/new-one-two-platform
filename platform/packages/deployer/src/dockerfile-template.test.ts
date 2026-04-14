import { describe, expect, it } from "vitest";
import { buildDockerfile } from "./dockerfile-template.js";

describe("buildDockerfile — common shape", () => {
  it("always installs the harness runtime via `npm ci` against the lockfile", () => {
    const df = buildDockerfile([]);
    expect(df).toContain("COPY harness-runtime-package.json ./package.json");
    expect(df).toContain("COPY harness-runtime-package-lock.json ./package-lock.json");
    expect(df).toMatch(/npm ci --omit=dev --ignore-scripts/);
  });

  it("starts the harness via CMD node server.cjs", () => {
    const df = buildDockerfile([]);
    expect(df).toMatch(/CMD \["node", "server\.cjs"\]/);
  });
});

describe("buildDockerfile — empty npmPackages", () => {
  it("omits the handler-deps install step entirely", () => {
    const df = buildDockerfile([]);
    expect(df).not.toContain("handler-deps.json");
    expect(df).not.toContain("handler_modules");
    expect(df).not.toContain("NODE_PATH");
  });
});

describe("buildDockerfile — with handler deps", () => {
  const df = buildDockerfile(["uuid@9.0.1"]);

  it("copies handler-deps.json directly into the handler_modules subdirectory", () => {
    // Using a subdirectory keeps this install isolated from /app/node_modules
    // so the handler step cannot prune the harness GCP deps (regression test
    // for the earlier `mv handler-deps.json package.json && npm install`
    // shape which caused npm to prune leftpad/leftpad-equivalent during the
    // handler install, leaving server.cjs with MODULE_NOT_FOUND at startup).
    expect(df).toContain("COPY handler-deps.json ./handler_modules/package.json");
  });

  it("runs the handler install inside the subdirectory, never at /app", () => {
    expect(df).toMatch(/cd handler_modules\s+\\\s+&&\s+npm install/);
  });

  it("keeps --ignore-scripts on the handler install", () => {
    expect(df).toMatch(/npm install[^\n]*--ignore-scripts/);
  });

  it("exports NODE_PATH so require() from handler.js resolves into handler_modules", () => {
    expect(df).toContain("ENV NODE_PATH=/app/handler_modules/node_modules");
  });

  it("must not overwrite /app/package.json with the handler deps", () => {
    // A shape regression test — any future edit that reintroduces
    //   `mv handler-deps.json package.json`
    // against /app (not /app/handler_modules) will re-open the prune bug.
    expect(df).not.toContain("mv handler-deps.json package.json");
  });

  it("must not feed the handler package list to npm as shell args", () => {
    // The whole point of C1's `handler-deps.json` shape is that no LLM
    // output reaches `npm install` as a command-line argument.
    expect(df).not.toMatch(/npm install[^\n]*uuid@/);
    expect(df).not.toMatch(/npm install[^\n]*\$\{/);
  });
});

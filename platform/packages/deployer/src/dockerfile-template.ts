/**
 * Builds the tenant-container Dockerfile. The npmPackages argument is only a
 * HINT for whether to include the handler-deps install step — the actual
 * package list is written to a separate `handler-deps.json` file by the
 * build-context builder and COPY'd into the image. This sidesteps shell-arg
 * expansion entirely: nothing from the LLM ever reaches `npm install` as a
 * command-line argument.
 *
 * Two install steps:
 *   1. Harness runtime (GCP deps) — reproducible via `npm ci` against a
 *      committed lockfile.
 *   2. Handler deps (LLM-authored, allowlisted + pinned-semver upstream) —
 *      `npm install --ignore-scripts` so a compromised package cannot run
 *      preinstall/postinstall scripts during the build.
 */
export function buildDockerfile(npmPackages: string[] = []): string {
  // Handler deps step is emitted only when the bundle declared any.
  const handlerDepsStep =
    npmPackages.length > 0
      ? `# Handler dependencies (allowlisted + pinned by the deployer validator).
# --ignore-scripts: a compromised/typosquatted package cannot execute its
# preinstall/postinstall during the build. --no-audit/--no-fund: quiet.
COPY handler-deps.json ./handler-deps.json
RUN mv handler-deps.json package.json \\
 && npm install --omit=dev --ignore-scripts --no-audit --no-fund \\
 && rm package.json
`
      : "";

  return `FROM node:20-slim AS runner
WORKDIR /app

# Harness bundle (esbuild CJS output, inlines all non-GCP deps)
COPY server.cjs ./server.cjs

# Harness GCP native deps — installed reproducibly against a committed
# lockfile so a bad transitive release can't break every tenant's next deploy.
COPY harness-runtime-package.json ./package.json
COPY harness-runtime-package-lock.json ./package-lock.json
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund

# Tenant-generated handler code
COPY handler.js ./handler.js

${handlerDepsStep}ENV PORT=8080
ENV NODE_ENV=production
EXPOSE 8080
CMD ["node", "server.cjs"]
`;
}

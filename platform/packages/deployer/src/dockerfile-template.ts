/**
 * Builds the tenant-container Dockerfile.
 *
 * The image contains TWO isolated dependency trees:
 *
 *   /app/node_modules/                        ← harness GCP deps
 *     @google-cloud/kms, @google-cloud/secret-manager, google-auth-library
 *     Installed via `npm ci` against the committed runtime-package-lock.json
 *     so M7 reproducibility holds.
 *
 *   /app/handler_modules/node_modules/         ← handler deps (LLM-authored)
 *     The packages declared in the bundle's _metadata.json, validated against
 *     the allowlist in npm-allowlist.ts and installed with --ignore-scripts.
 *
 * They are kept separate — not merged into a single `/app/package.json` — to
 * prevent `npm install` for the handler step from pruning the harness deps
 * (earlier revision of this template did exactly that: `npm install` against
 * a freshly-written package.json with just the handler deps deleted the
 * harness's /app/node_modules entries, and server.cjs then failed with
 * MODULE_NOT_FOUND on the `@google-cloud/*` externals at startup).
 *
 * Resolution at runtime:
 *   - server.cjs is a Node process started from /app, so `require("@google-cloud/kms")`
 *     resolves via /app/node_modules — the harness tree.
 *   - handler.js is loaded via require(HANDLER_PATH = /app/handler.js). A bare
 *     `require("uuid")` from handler.js walks up from /app/node_modules (not
 *     there) to the ancestor /node_modules (not there) and then falls through
 *     to NODE_PATH, which we set to /app/handler_modules/node_modules.
 *
 * Nothing from the LLM ever reaches npm as a command-line argument — the
 * package list is COPY'd in as handler-deps.json (a package.json-shaped
 * document pre-validated by npm-allowlist.ts) and renamed at build time.
 */
export function buildDockerfile(npmPackages: string[] = []): string {
  // Handler deps step is emitted only when the bundle declared any. Installed
  // into /app/handler_modules/ so the step cannot prune /app/node_modules.
  const handlerDepsStep =
    npmPackages.length > 0
      ? `# Handler dependencies (allowlisted + pinned-semver by the deployer
# validator). Installed into a separate directory so this step can never
# prune /app/node_modules (where the harness GCP deps live). --ignore-scripts:
# a compromised/typosquatted package cannot execute its preinstall/postinstall
# during the build. --no-audit/--no-fund: quiet the irrelevant npm nags.
COPY handler-deps.json ./handler_modules/package.json
RUN cd handler_modules \\
 && npm install --omit=dev --ignore-scripts --no-audit --no-fund
ENV NODE_PATH=/app/handler_modules/node_modules

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

FROM node:22-alpine AS base
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate

# ── Install all dependencies (cached unless lockfile changes) ─────────────────
FROM base AS deps
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json ./apps/api/
COPY packages/crypto/package.json ./packages/crypto/
COPY packages/db/package.json ./packages/db/
COPY packages/deployer/package.json ./packages/deployer/
COPY packages/harness/package.json ./packages/harness/
COPY packages/logger/package.json ./packages/logger/
COPY packages/pubsub-client/package.json ./packages/pubsub-client/
COPY packages/types/package.json ./packages/types/
RUN pnpm install --frozen-lockfile

# ── Build & create production bundle ─────────────────────────────────────────
FROM base AS builder
WORKDIR /app
COPY . .
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=deps /app/packages/crypto/node_modules ./packages/crypto/node_modules
COPY --from=deps /app/packages/db/node_modules ./packages/db/node_modules
COPY --from=deps /app/packages/deployer/node_modules ./packages/deployer/node_modules
COPY --from=deps /app/packages/harness/node_modules ./packages/harness/node_modules
COPY --from=deps /app/packages/logger/node_modules ./packages/logger/node_modules
COPY --from=deps /app/packages/pubsub-client/node_modules ./packages/pubsub-client/node_modules
COPY --from=deps /app/packages/types/node_modules ./packages/types/node_modules
RUN pnpm --filter @new-one-two/api... build
RUN pnpm --filter @new-one-two/api deploy --prod /deploy

# ── Minimal runtime image ─────────────────────────────────────────────────────
FROM node:22-alpine AS runner
# Upgrade Alpine packages in the shipped image only — keeps build layers cached
# while ensuring the deployed container has current security patches.
RUN apk upgrade --no-cache
WORKDIR /app
COPY --from=builder /deploy .

ENV NODE_ENV=production
EXPOSE 3002
CMD ["node", "dist/server.js"]

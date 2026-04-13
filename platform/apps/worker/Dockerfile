FROM node:22-alpine AS base
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate

# ── Install all dependencies (cached unless lockfile changes) ─────────────────
FROM base AS deps
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/worker/package.json ./apps/worker/
COPY packages/db/package.json ./packages/db/
COPY packages/logger/package.json ./packages/logger/
COPY packages/types/package.json ./packages/types/
RUN pnpm install --frozen-lockfile

# ── Build & create production bundle ─────────────────────────────────────────
FROM base AS builder
WORKDIR /app
COPY . .
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/worker/node_modules ./apps/worker/node_modules
COPY --from=deps /app/packages/db/node_modules ./packages/db/node_modules
COPY --from=deps /app/packages/logger/node_modules ./packages/logger/node_modules
COPY --from=deps /app/packages/types/node_modules ./packages/types/node_modules
RUN pnpm --filter @new-one-two/worker... build
RUN pnpm --filter @new-one-two/worker deploy --prod /deploy

# ── Minimal runtime image ─────────────────────────────────────────────────────
FROM node:22-alpine AS runner
RUN apk upgrade --no-cache
WORKDIR /app
COPY --from=builder /deploy .

ENV NODE_ENV=production
CMD ["node", "dist/worker.js"]

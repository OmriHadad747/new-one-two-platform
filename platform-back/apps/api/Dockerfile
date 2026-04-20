# syntax=docker/dockerfile:1.6
FROM node:22-alpine AS base
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate

# ── Install all workspace deps (cached unless lockfile changes) ──────────────
FROM base AS deps
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json ./apps/api/
COPY packages/db/package.json ./packages/db/
COPY packages/logger/package.json ./packages/logger/
RUN pnpm install --frozen-lockfile

# ── Build & create production bundle ─────────────────────────────────────────
FROM base AS builder
WORKDIR /app
COPY . .
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=deps /app/packages/db/node_modules ./packages/db/node_modules
COPY --from=deps /app/packages/logger/node_modules ./packages/logger/node_modules
RUN pnpm --filter @platform-back/api... build
RUN pnpm --filter @platform-back/api deploy --prod /deploy

# ── Minimal runtime image ────────────────────────────────────────────────────
FROM node:22-alpine AS runner
RUN apk upgrade --no-cache
WORKDIR /app
COPY --from=builder /deploy .

RUN addgroup -S app && adduser -S app -G app
USER app

ENV NODE_ENV=production
ENV PORT=3010
EXPOSE 3010
CMD ["node", "dist/server.js"]

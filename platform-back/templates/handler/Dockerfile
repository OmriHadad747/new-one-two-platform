# syntax=docker/dockerfile:1.6
FROM node:22-alpine AS base
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate

# ── Install deps ──────────────────────────────────────────────────────────────
FROM base AS deps
WORKDIR /app
COPY package.json pnpm-lock.yaml* ./
RUN pnpm install --prod=false --frozen-lockfile=false

# ── Build TypeScript ─────────────────────────────────────────────────────────
FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN pnpm build

# ── Runtime image ────────────────────────────────────────────────────────────
FROM node:22-alpine AS runner
RUN apk upgrade --no-cache
WORKDIR /app

COPY package.json pnpm-lock.yaml* ./
RUN corepack enable \
 && corepack prepare pnpm@9.15.9 --activate \
 && pnpm install --prod --frozen-lockfile=false \
 && pnpm store prune

COPY --from=builder /app/dist ./dist
COPY migrations ./migrations

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

RUN addgroup -S app && adduser -S app -G app
USER app

# Default command — Cloud Run runs this. The pre-deploy migration job
# overrides CMD with `node dist/migrate.js` (locked decision 9).
CMD ["node", "dist/server.js"]

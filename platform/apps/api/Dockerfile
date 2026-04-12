FROM node:22-alpine AS base
RUN apk update && apk upgrade --no-cache && \
    corepack enable && corepack prepare pnpm@9.0.0 --activate

FROM base AS deps
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json ./apps/api/
COPY packages/db/package.json ./packages/db/
COPY packages/deployer/package.json ./packages/deployer/
COPY packages/logger/package.json ./packages/logger/
COPY packages/pubsub-client/package.json ./packages/pubsub-client/
COPY packages/types/package.json ./packages/types/
RUN pnpm install --frozen-lockfile

FROM base AS builder
WORKDIR /app
COPY . .
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=deps /app/packages/db/node_modules ./packages/db/node_modules
COPY --from=deps /app/packages/deployer/node_modules ./packages/deployer/node_modules
COPY --from=deps /app/packages/logger/node_modules ./packages/logger/node_modules
COPY --from=deps /app/packages/pubsub-client/node_modules ./packages/pubsub-client/node_modules
COPY --from=deps /app/packages/types/node_modules ./packages/types/node_modules
RUN pnpm --filter @new-one-two/api... build

FROM node:22-alpine AS runner
RUN apk update && apk upgrade --no-cache && \
    corepack enable && corepack prepare pnpm@9.0.0 --activate
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json ./apps/api/
COPY packages/db/package.json ./packages/db/
COPY packages/deployer/package.json ./packages/deployer/
COPY packages/logger/package.json ./packages/logger/
COPY packages/pubsub-client/package.json ./packages/pubsub-client/
COPY packages/types/package.json ./packages/types/
RUN pnpm install --frozen-lockfile --prod
COPY --from=builder /app/apps/api/dist ./apps/api/dist
COPY --from=builder /app/packages/db/dist ./packages/db/dist
COPY --from=builder /app/packages/deployer/dist ./packages/deployer/dist
COPY --from=builder /app/packages/logger/dist ./packages/logger/dist
COPY --from=builder /app/packages/pubsub-client/dist ./packages/pubsub-client/dist
COPY --from=builder /app/packages/types/dist ./packages/types/dist

ENV NODE_ENV=production
EXPOSE 3002
CMD ["node", "apps/api/dist/server.js"]

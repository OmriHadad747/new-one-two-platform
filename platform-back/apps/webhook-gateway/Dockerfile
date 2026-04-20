FROM node:20-alpine AS base
WORKDIR /app
RUN npm install -g pnpm

FROM base AS deps
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/db/package.json packages/db/
COPY packages/crypto/package.json packages/crypto/
COPY packages/logger/package.json packages/logger/
COPY packages/types/package.json packages/types/
COPY apps/webhook-gateway/package.json apps/webhook-gateway/
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY packages packages
COPY apps/webhook-gateway apps/webhook-gateway
COPY tsconfig.base.json .
RUN pnpm --filter @platform-back/types build
RUN pnpm --filter @platform-back/logger build
RUN pnpm --filter @platform-back/crypto build
RUN pnpm --filter @platform-back/db build
RUN pnpm --filter @platform-back/webhook-gateway build

FROM node:20-alpine AS runtime
WORKDIR /app
RUN npm install -g pnpm
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages/*/node_modules ./packages/
COPY --from=build /app/packages/db/dist ./packages/db/dist
COPY --from=build /app/packages/crypto/dist ./packages/crypto/dist
COPY --from=build /app/packages/logger/dist ./packages/logger/dist
COPY --from=build /app/packages/types/dist ./packages/types/dist
COPY --from=build /app/apps/webhook-gateway/dist ./apps/webhook-gateway/dist
COPY --from=build /app/apps/webhook-gateway/package.json ./apps/webhook-gateway/

EXPOSE 3001
CMD ["node", "apps/webhook-gateway/dist/server.js"]

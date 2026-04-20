FROM node:20-alpine AS base
WORKDIR /app
RUN npm install -g pnpm

FROM base AS deps
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/db/package.json packages/db/
COPY packages/logger/package.json packages/logger/
COPY packages/types/package.json packages/types/
COPY apps/worker/package.json apps/worker/
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY packages packages
COPY apps/worker apps/worker
COPY tsconfig.base.json .
RUN pnpm --filter @platform-back/types build
RUN pnpm --filter @platform-back/logger build
RUN pnpm --filter @platform-back/db build
RUN pnpm --filter @platform-back/worker build

FROM node:20-alpine AS runtime
WORKDIR /app
RUN npm install -g pnpm
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/packages/db/dist ./packages/db/dist
COPY --from=build /app/packages/logger/dist ./packages/logger/dist
COPY --from=build /app/packages/types/dist ./packages/types/dist
COPY --from=build /app/apps/worker/dist ./apps/worker/dist
COPY --from=build /app/apps/worker/package.json ./apps/worker/

EXPOSE 8080
CMD ["node", "apps/worker/dist/worker.js"]

export function buildDockerfile(): string {
  return `FROM node:20-alpine AS runner
WORKDIR /app

# Harness bundle (esbuild CJS output, inlines all non-GCP deps)
COPY server.cjs ./server.cjs

# GCP packages with native gRPC binaries — must be installed, not bundled
COPY harness-runtime-package.json ./package.json
RUN npm install --omit=dev --ignore-scripts

# Tenant-generated handler code
COPY handler.js ./handler.js

# Optional: tenant-supplied dependencies (may be an empty file)
COPY tenant-package.json ./tenant-package.json
RUN node -e "const p = require('./tenant-package.json'); if (Object.keys(p.dependencies || {}).length > 0) { require('child_process').execSync('npm install --omit=dev --ignore-scripts', { stdio: 'inherit' }); }"

ENV PORT=8080
ENV NODE_ENV=production
EXPOSE 8080
CMD ["node", "server.cjs"]
`;
}

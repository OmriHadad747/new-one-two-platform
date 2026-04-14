export function buildDockerfile(npmPackages: string[] = []): string {
  const installLine =
    npmPackages.length > 0
      ? `RUN npm install --omit=dev ${npmPackages.join(" ")}\n\n`
      : "";

  return `FROM node:20-slim AS runner
WORKDIR /app

# Harness bundle (esbuild CJS output, inlines all non-GCP deps)
COPY server.cjs ./server.cjs

# GCP packages with native gRPC binaries — must be installed, not bundled
COPY harness-runtime-package.json ./package.json
RUN npm install --omit=dev --ignore-scripts

# Tenant-generated handler code
COPY handler.js ./handler.js

# JS library dependencies declared by the generated handler (empty if none)
${installLine}ENV PORT=8080
ENV NODE_ENV=production
EXPOSE 8080
CMD ["node", "server.cjs"]
`;
}

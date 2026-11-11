# The hosted connector. Build context is the repo root, for the workspace's SDK and MCP packages.
FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc* ./
COPY web/package.json web/
COPY agent/package.json agent/
COPY scripts/package.json scripts/
COPY sdk/package.json sdk/
COPY mcp/package.json mcp/
COPY hosted/connector/package.json hosted/connector/
RUN pnpm install --frozen-lockfile --filter @covenant/connector...
COPY sdk sdk
COPY mcp mcp
COPY hosted/connector hosted/connector
RUN pnpm --filter @covenant/connector... build && pnpm deploy --filter @covenant/connector --prod --legacy /out

FROM node:22-alpine
WORKDIR /app
COPY --from=build /out .
ENV NODE_ENV=production DATA_DIR=/data
EXPOSE 8787
CMD ["node", "dist/index.js"]

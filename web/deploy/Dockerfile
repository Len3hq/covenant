# The dashboard as a static site. Build context is the repo root (see railway.json).
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
RUN pnpm install --frozen-lockfile --filter @covenant/web...
COPY web web
# Only VITE_* values reach the bundle, and they are public. Never pass a secret here.
ARG VITE_VAULT_ACCOUNT_ID
ARG VITE_FACTORY_ACCOUNT_ID
ARG VITE_NEAR_RPC_URL
RUN pnpm --filter @covenant/web build

FROM caddy:2-alpine
COPY web/deploy/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /app/web/dist /srv

# Minimal multi-stage image for the @perch/relay stateless, content-blind relay.
#
# The relay has no workspace dependencies (only `ws`), so the build context is
# this package alone - no monorepo, no repo-root config. Stage 1 compiles the
# TypeScript; stage 2 ships only the runtime deps + compiled JS.
#
# The image runs plain ws:// on PORT (default 8080). TLS is terminated in front
# by the reverse proxy in deploy/docker-compose.yml (Caddy + Let's Encrypt), so
# the phone reaches the relay as wss://. To serve wss:// directly instead, mount
# a cert/key and set RELAY_TLS_CERT / RELAY_TLS_KEY.

# ---- Stage 1: build ----
FROM node:22-alpine AS builder
WORKDIR /app

# Install deps against this package's own manifest (ws + tsc + types). No
# package-lock lives here (the workspace hoists it to the repo root), and the
# relay pulls in nothing from the workspace, so a plain install is reproducible.
COPY package.json ./
RUN npm install --no-audit --no-fund

COPY tsconfig.docker.json ./
COPY src ./src
RUN npx tsc -p tsconfig.docker.json

# ---- Stage 2: runtime ----
FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app

# Runtime deps only (ws). Drops typescript and the type packages.
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force

COPY --from=builder /app/dist ./dist

# Run unprivileged (the node image ships a `node` user).
USER node

ENV PORT=8080
ENV HOST=0.0.0.0
EXPOSE 8080

# The relay answers GET /health with 200 {"status":"ok"}.
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||8080)+'/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "dist/cli.js"]

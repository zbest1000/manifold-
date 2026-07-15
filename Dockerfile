# Manifold — production image (server + built client, no demo stack).
# For the full local demo stack (broker, OPC UA sim, traffic generator) see
# docker-compose.yml / docker/app/Dockerfile instead.
#
# node:22-slim is Debian (glibc): no musl surprises if a native or optional
# dependency ever lands. As of v1.0.0 the server has no optionalDependencies
# and loads no native addon (native/ is a standalone benchmark crate the
# server never requires — topicStore.js is pure JS), so nothing extra to build.

# ---- Stage 1: build the React client ----------------------------------------
FROM node:22-slim AS client-build
WORKDIR /build/client
# client/package-lock.json exists and is in sync -> npm ci for reproducibility
COPY client/package.json client/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY client/ ./
RUN npm run build

# ---- Stage 2: runtime --------------------------------------------------------
FROM node:22-slim

ENV NODE_ENV=production \
    MANIFOLD_DATA_DIR=/data

# Mirror the repo layout: server at /app/server, client bundle at
# /app/client/dist, so server/index.js's path.join(__dirname, '../client/dist')
# resolves unchanged.
WORKDIR /app/server

# Production dependencies only (lockfile present -> npm ci)
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

# Server source, then the built client from stage 1
COPY server/ ./
COPY --from=client-build /build/client/dist /app/client/dist

# Persistent state (connection profiles, history, recordings, OPC UA PKI).
# All stores fall back to <server>/data but honor MANIFOLD_DATA_DIR (set above).
RUN mkdir -p /data && chown node:node /data
VOLUME /data

# Run as the unprivileged 'node' user shipped with the official image
USER node

# server/index.js: const PORT = process.env.PORT || 5000
EXPOSE 5000

# /health is registered outside the /api auth middleware, so it responds 200
# without a bearer token even when MANIFOLD_AUTH_TOKEN is set.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||5000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "index.js"]

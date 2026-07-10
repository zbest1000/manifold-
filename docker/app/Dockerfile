# syntax=docker/dockerfile:1

# ---- Stage 1: build the React client into client/dist ----
FROM node:20 AS client
WORKDIR /app/client
COPY client/package*.json ./
RUN npm install --legacy-peer-deps --no-audit --no-fund
COPY client/ ./
RUN npm run build

# ---- Stage 2: runtime (server + built client) ----
FROM node:20 AS runtime
ENV NODE_ENV=production
ENV TC_DATA_DIR=/data
WORKDIR /app/server

# Server production dependencies
COPY server/package*.json ./
RUN npm install --omit=dev --no-audit --no-fund

# Server source + the built client it serves in production
COPY server/ ./
COPY --from=client /app/client/dist /app/client/dist

# Startup helpers: wait for broker/opcua, seed auto-connect profiles
COPY docker/app/wait-for.js /wait-for.js
COPY docker/app/entrypoint.sh /entrypoint.sh
COPY docker/app/seed/profiles.json /seed/profiles.json
RUN chmod +x /entrypoint.sh

EXPOSE 5000
ENTRYPOINT ["/entrypoint.sh"]

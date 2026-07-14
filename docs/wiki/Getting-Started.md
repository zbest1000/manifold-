# Getting started

## Requirements

- Node.js ≥ 20.19 (or 22+). The OPC UA dependency chain needs `require(ESM)` support.

## Install and run

```bash
npm run install:all
npm run dev            # client on :3000, backend on :5000 (proxied)
```

Production:

```bash
npm run build          # builds the client into client/dist
npm start              # serves API + built client on :5000
```

Docker demo stack (broker + OPC UA simulator + traffic generator, pre-wired):

```bash
docker compose up --build
# open http://localhost:5000
```

## First broker

1. Open **MQTT Brokers** → *Add broker*.
2. Enter host and port. Manifold auto-subscribes to `#` (QoS 1 by default) and
   `$SYS/#` (QoS 0) once connected.
3. Topics appear under **Topics**; the ISA-95 view builds itself under **UNS**
   from the same traffic.

If the broker is a stock EMQX and no data appears, read
[Broker Setup](Broker-Setup) — EMQX's default ACL silently denies wildcard
subscriptions at QoS 1.

## Environment variables

| Variable | Purpose |
|---|---|
| `PORT` | HTTP/socket port (default 5000) |
| `MANIFOLD_AUTH_TOKEN` | Admin bearer token; enables auth on API + socket |
| `MANIFOLD_VIEWER_TOKEN` | Optional read-only token |
| `MANIFOLD_DATA_DIR` | Data directory (profiles, history, outbox spill, audit) |
| `MANIFOLD_NO_RESTORE` | `1` = don't reconnect saved profiles on boot |
| `CLIENT_URL` | CORS origin for the dev client |

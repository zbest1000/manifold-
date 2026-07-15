# Manifold

[![CI](https://github.com/zbest1000/manifold/actions/workflows/ci.yml/badge.svg)](https://github.com/zbest1000/manifold/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](#license)
[![Node](https://img.shields.io/badge/node-%E2%89%A5%2020-brightgreen.svg)](https://nodejs.org)

Industrial data explorer and DataOps toolkit: MQTT, Sparkplug B, OPC UA, CESMII SMIP, and i3X, with a live Unified Namespace view.

<p align="center">
  <img src="docs/wiki/images/uns-topology.png" alt="Live UNS topology" width="850">
</p>

Manifold connects to brokers and servers, streams their data in real time, and renders it as a live UNS topology, interactive topic/address-space graphs, and producer → topic → consumer lineage. A DataOps layer routes and reshapes the stream: pipelines, contextualization models, historian delivery with store-and-forward, recording/replay, schema contracts, and tag bindings with a Sparkplug B publisher. An included MCP server exposes the same backend to AI agents.

## Features

**Explore**
- MQTT topic tree, 2D/3D graphs, and a WebGL renderer for very large namespaces (60k+ topics). JSON, text, binary, and Sparkplug B payloads decoded.
- OPC UA address-space browsing with live monitored values.
- Producer/consumer lineage: Sparkplug topology from BIRTH/DEATH certificates, per-client subscriptions from broker admin APIs (EMQX, HiveMQ), wildcard filters resolved against observed topics.
- Network discovery by CIDR scan with protocol handshake verification.
- Message history survives restarts; any two payloads can be diffed structurally.

**Unified Namespace**
- Live ISA-95 topology built from observed traffic: values on leaves, per-branch message rates, publishing edges animated.
- Per-topic staleness calibrated to each topic's own publish cadence.
- Namespace lint (0–100 score with structural findings), event feed (new topics, Sparkplug lifecycle), editable level ladder, and mounts for OPC UA / i3X sources.

**DataOps**
- Pipelines: filter → transform chain (repath, pick/rename/set, scale, numeric, Sparkplug flatten, TVQ envelope) → broker or historian, with a dry-run preview against live topics and two-layer loop protection.
- Models: merge fields from many topics into one object at a clean UNS path.
- Historians: InfluxDB v2, TimescaleDB/PostgreSQL, and Timebase (Flow Software) — all through a store-and-forward outbox with disk spill and configurable drop policy.
- Recorder and replay, schema contracts with drift detection, alert rules with webhooks.

**Tags**
- Unified tag browser (OPC UA, Sparkplug registry, MQTT trie) with CSV import.
- Bindings publish device tags into the UNS as plain values, TVQ envelopes, or a Sparkplug B device, with deadband and quality mapping. Read-only toward devices.

**Operations**
- Token auth with admin and read-only roles, audit log, Prometheus `/metrics`, config export/import with secrets stripped.

See [ARCHITECTURE.md](ARCHITECTURE.md) for how it works: system design, the message hot path, the API surface, protocol notes, and testing. Operational guides (broker ACLs, historian setup, transform reference, troubleshooting) live in the [wiki](../../wiki), generated from [`docs/wiki/`](docs/wiki).

## Quick start

Requires Node.js ≥ 20.19 (or 22+).

```bash
npm run install:all
npm run dev            # client on :3000, backend on :5000
```

Production build:

```bash
npm run build
npm start              # serves API + built client on :5000
```

A full demo stack (broker, OPC UA simulator, traffic generator) is one command away with Docker — see [DOCKER.md](DOCKER.md).

## Authentication

Manifold is a control plane: it can publish to brokers, send Sparkplug commands, and start network scans. Before exposing it beyond localhost, set a token:

```bash
MANIFOLD_AUTH_TOKEN=$(openssl rand -hex 24) npm start
```

With `MANIFOLD_AUTH_TOKEN` set, all API routes and the socket handshake require `Authorization: Bearer <token>`, and the UI shows an unlock screen. `MANIFOLD_VIEWER_TOKEN` adds an optional read-only role, and `MANIFOLD_TOKENS` (`name:token:role,…`) issues named, individually revocable tokens whose names appear in the audit trail. Failed authentication is rate-limited per IP. Without tokens the server runs open and warns at startup.

Connection profiles persist in `server/data/profiles.json` (mode 0600; directory configurable via `MANIFOLD_DATA_DIR`, restore disabled via `MANIFOLD_NO_RESTORE=1`). The file may contain broker credentials, so protect the host.

## MCP server

Point any MCP client at `mcp/index.js` with the backend running:

```json
{
  "mcpServers": {
    "manifold": {
      "command": "node",
      "args": ["/absolute/path/to/mcp/index.js"],
      "env": { "MANIFOLD_API_URL": "http://localhost:5000" }
    }
  }
}
```

About 50 tools cover MQTT, UNS, Flows, DataOps, OPC UA, CESMII, and i3X. The full list is in [ARCHITECTURE.md](ARCHITECTURE.md#mcp-tools). Set `MANIFOLD_AUTH_TOKEN` in the MCP server's environment when the backend runs authenticated.

## Testing

```bash
cd server && npm test    # 124 tests, node:test, includes real-broker integration
cd client && npm test    # Vitest over the pure logic modules
```

CI additionally runs an integration job against real EMQX, InfluxDB, and TimescaleDB containers. Details in [ARCHITECTURE.md](ARCHITECTURE.md#testing).

## License

MIT

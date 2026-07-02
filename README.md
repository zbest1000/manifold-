# Topic Canvas

**A node-graph explorer for MQTT and OPC UA networks.**

Topic Canvas connects to MQTT brokers and OPC UA servers, streams their data in
real time, and renders the topic namespace / address space as an interactive,
force-directed **node graph** with a live data panel. It ships with a
**Model Context Protocol (MCP) server** so AI assistants and agents can drive the
same backend programmatically.

There is no built-in "AI assistant" chat or mock data — the app does real
protocol work and exposes it cleanly. If you want AI in the loop, point any
MCP-capable client at the included MCP server.

---

## Highlights

- **Live MQTT exploration** — connect to any broker (TCP or TLS), auto-subscribe,
  and watch topics populate. JSON, plain-text, binary and **Sparkplug B** payloads
  are detected and decoded.
- **OPC UA browsing** — connect to an `opc.tcp://` endpoint, walk the address space
  as a graph, read node attributes, and monitor live variable values.
- **Node-graph visualization** — a smooth canvas force graph with pan/zoom, drag,
  hover-highlight and selection. Nodes scale by connectivity; branches and leaves
  are colored by message/node type.
- **Selectable visual styles** — pick from six hand-tuned graph themes
  (Constellation, Blueprint, Aurora, Neon, Circuit, Slate) plus three layout
  presets (Organic, Spacious, Tight). Your choice persists across sessions.
- **Honest network discovery** — TCP port probing across a CIDR range, each hit
  verified with a real protocol handshake. No fabricated results.
- **MCP server** — expose MQTT + OPC UA tools to Claude Desktop, IDE agents, or any
  MCP client.

---

## Architecture

```
Topic Canvas
├── server/   Node.js + Express + Socket.IO backend
│             MQTT (mqtt.js) · OPC UA (node-opcua) · discovery · Sparkplug B
├── client/   React + Vite + Tailwind frontend
│             canvas force-graph, style presets, live data panels
└── mcp/      Model Context Protocol server (stdio) bridging to the backend REST API
```

The backend holds all live state and streams updates over Socket.IO. The client is
a thin, real-time view. The MCP server is a stateless bridge over the backend's REST
API, so a human in the browser and an AI agent over MCP see the exact same data.

### Graph visual styles

The style presets live in `client/src/graph/graphStyles.js`. Each is a
self-contained theme (background, palette, link + node treatment, glow, labels,
optional grid) that the canvas renderer reads every frame, so switching styles
restyles the whole graph instantly without recomputing layout. The looks are
inspired by a range of well-loved graph visualizations but stand on their own and
are named for the aesthetic they produce.

---

## Getting started

### Prerequisites

- Node.js ≥ 18

### Install

```bash
npm run install:all
```

### Run (development)

```bash
npm run dev
```

- Client: http://localhost:3000
- Backend: http://localhost:5000 (the client dev server proxies `/api` and
  `/socket.io` to it)

### Build (production)

```bash
npm run build      # builds the client into client/dist
npm start          # serves the API and the built client from the backend
```

---

## MCP server

The MCP server lets an AI client discover brokers, browse topics, read payloads,
subscribe/publish, and walk an OPC UA address space — all through the running
backend.

1. Start the backend (`npm run dev` or `npm start`).
2. Add the server to your MCP client config:

```json
{
  "mcpServers": {
    "topic-canvas": {
      "command": "node",
      "args": ["/absolute/path/to/mcp/index.js"],
      "env": { "TOPIC_CANVAS_API_URL": "http://localhost:5000" }
    }
  }
}
```

### Tools exposed

| Tool | Purpose |
| --- | --- |
| `system_status` | Backend status: connections and discovery state |
| `discover_scan` / `discover_results` | Scan a CIDR range for MQTT/OPC UA endpoints |
| `mqtt_connect` / `mqtt_disconnect` / `mqtt_list_brokers` | Manage broker connections |
| `mqtt_list_topics` / `mqtt_get_messages` | Read the topic tree and recent payloads |
| `mqtt_subscribe` / `mqtt_publish` | Subscribe to filters and publish messages |
| `opcua_connect` / `opcua_disconnect` / `opcua_list_connections` | Manage OPC UA connections |
| `opcua_browse` / `opcua_read` / `opcua_monitor` | Walk the address space, read and monitor nodes |

---

## HTTP API (selected)

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/api/system/status` | Overall status |
| `POST` | `/api/system/discovery/start` | Start a network scan (`{ range?, mqttPorts?, opcuaPorts? }`) |
| `GET` | `/api/mqtt/brokers` | List broker connections |
| `POST` | `/api/mqtt/brokers` | Connect (`{ host, port?, protocol?, username?, password? }`) |
| `GET` | `/api/mqtt/brokers/:id/topics` | Topic list with counts |
| `GET` | `/api/mqtt/brokers/:id/messages?topic=` | Recent messages for a topic |
| `POST` | `/api/mqtt/brokers/:id/publish` | Publish (`{ topic, payload, qos?, retain? }`) |
| `POST` | `/api/opcua/connections` | Connect (`{ endpointUrl, securityMode?, ... }`) |
| `GET` | `/api/opcua/connections/:id/browse?nodeId=` | Browse a node's children |
| `POST` | `/api/opcua/connections/:id/monitor` | Monitor a variable (`{ nodeId, samplingInterval? }`) |

Real-time updates (messages, broker stats, discovery progress, OPC UA values) are
delivered over Socket.IO.

---

## Tech stack

- **Backend:** Express, Socket.IO, `mqtt`, `node-opcua-client`, `protobufjs`
- **Frontend:** React 18, Vite, Tailwind CSS, `d3-force` / `d3-zoom` (canvas
  rendering), Zustand, Framer Motion, lucide-react
- **MCP:** `@modelcontextprotocol/sdk`

## License

MIT

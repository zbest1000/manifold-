# Manifold

**One live map of your industrial data — UNS, MQTT, OPC UA, CESMII, i3X.**

Like its namesake, Manifold joins many pipes into one system: it connects to
MQTT brokers and OPC UA servers, streams their data in real time, and renders
it as a live **Unified-Namespace topology** (ISA-95 levels, publishing branches
lit up), interactive **node graphs** of every topic namespace / address space,
and **Flows** — producer → topic → consumer lineage with wildcard subscriptions
resolved against reality. It ships with a **Model Context Protocol (MCP)
server** so AI assistants and agents can drive the same backend
programmatically.

*(Formerly "Topic Canvas" — renamed as the tool outgrew topic visualization.)*

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
- **Three views of every broker** — a classic collapsible **topic tree** (live
  values with change-flash, retained flags, per-branch counts, sort + filter,
  publish with QoS/retain, clear-retained, copy, inline plot), an interactive 2D
  **node graph**, and a **3D graph** you orbit with the mouse (drag to rotate
  both axes, scroll to zoom) to reach any node. Switch with one toggle.
- **Node-graph visualization** — a smooth canvas force graph with pan/zoom, drag,
  hover-highlight and selection. Nodes scale by connectivity; branches and leaves
  are colored by message/node type. Stays at 60fps with thousands of topics
  because high-frequency message data is kept out of the React render path.
- **Live message flow** — with a broker connected, incoming messages animate as
  dots travelling from the broker out to their topic node, active nodes pulse, and
  busy topics glow brighter — so you can *see* what your network is doing. Toggle
  it from the graph toolbar (persists across sessions).
- **Selectable visual styles** — pick from six hand-tuned graph themes
  (Constellation, Blueprint, Aurora, Neon, Circuit, Slate). Your choice persists
  across sessions.
- **Live and computed layouts** — interactive physics layouts (Organic, Spacious,
  Tight, Radial, Tree, Cluster) run in the browser, while *computed* layouts
  (Hierarchy, Layered, Balanced, Radial+, Circular, Scalable) are calculated
  server-side by **Graphviz** (`dot`/`sfdp`/`twopi`/`circo`) and **Cytoscape**
  (`fcose`) and applied as fixed coordinates — clean hierarchy and cluster-aware
  layouts without a second rendering engine on the frontend. OPC UA and i3X graphs
  default to the hierarchical `dot` layout; the MQTT graph has a one-click
  **Beautify** action.
- **Show-all at massive scale** — a "show all" toggle renders every topic as a
  node on a lean WebGL renderer (verified at 63k+ nodes, responsive pan/zoom)
  with viewport-culled, zoom-aware **labels**, connection lines, and a
  **label-density slider** (off → dense). A **Force layout** button computes an
  organic, force-directed arrangement server-side (Graphviz `sfdp`, up to 30k
  nodes) — the classic "network graph" look at scale, instead of the
  deterministic radial default.
- **UNS: live Unified-Namespace topology** — the whole namespace as an
  ISA-95-style hierarchy (**Namespace → Business Unit → Site → Area → Line →
  Cell**) on a light, dotted canvas: badge nodes with level glyphs and captions,
  expand/collapse per branch, and edges that turn into animated dashed green
  while data is actually **publishing** through that branch (quiet gray when
  silent). Nodes can be **dragged to rearrange** the map by hand (edges follow);
  **Auto arrange** resets to the tidy layout and refits the view, **Fit** reframes
  while keeping manual moves. Labels get halo rendering and generous row spacing
  so text is never obscured by crossing edges, and the detail panel docks beside
  the canvas instead of covering it. Header chips show every connected source (MQTT brokers, OPC UA, i3X)
  and the live message rate; scope to one namespace or view all side by side.
  Built entirely from observed traffic — the same stream the topic graph uses.
  The namespace is also a **live dashboard**: leaf badges show each topic's
  **latest value**, branch badges show **per-branch msg/s** while data flows,
  and every leaf gets **staleness detection** calibrated to its *own* publish
  cadence (inter-arrival EMA): green = fresh, amber = overdue (3× its typical
  interval), red = dead (10×). A **Lint** panel scores the namespace 0–100 and
  lists structural findings (mixed naming conventions among siblings, payloads
  on branch nodes, empty `//` segments, whitespace in names, redundant
  single-child chains, wildly uneven leaf depth) with jump-to-node; an
  **Events** feed streams namespace changes (new topics appearing, Sparkplug
  BIRTH/DEATH lifecycle incl. cascaded device deaths); the ISA-95 **level
  ladder is editable** (rename/add/remove levels, persisted); and **Mounts**
  graft non-MQTT sources — an **OPC UA address space** or the **i3X object
  graph** — into the same namespace forest, because a UNS is more than one
  broker.
- **Flows: producer → topic → consumer lineage** — live visibility into who
  publishes and who receives what on a broker.
  - *Producers* — the real publishing endpoints of Sparkplug traffic:
    **Group → Edge Node → Device**, reconstructed from BIRTH/DEATH certificates
    (`spBv1.0/…`), with live online/offline state (edge death cascades to its
    devices, per spec), the metric set each endpoint publishes, and — when an
    admin API is connected — **who consumes each endpoint's data**. Alongside it,
    a **broker `$SYS` health panel** (clients, subscriptions, throughput, uptime).
  - *Consumers, with wildcards resolved* — a subscription filter is a query, not
    a destination: two clients on `spBv1.0/#` can effectively receive completely
    different concrete topics. The Consumers tab fetches per-client subscriptions
    from a **broker admin API** (EMQX v5 REST or HiveMQ Enterprise REST; key
    stored server-side) and
    **resolves every filter against the actually-observed topic set** using a
    server-side topic trie: exact match counts (never truncated), covering
    subtree roots, and drill-down to the concrete leaf topics — with proper MQTT
    semantics (`+`/`#` levels, root wildcards excluding `$`-topics, `$share`
    groups). Dormant filters (matching nothing) are flagged — dead wiring is a
    finding. A **"show coverage on topic map"** action paints exactly what a
    client receives onto the main topic graph.
  - *Consumer rates* — EMQX exposes cumulative per-client traffic counters;
    Manifold diffs them between refreshes into live **per-client msg/s in/out**
    on the client card.
  - *Honesty:* MQTT and `$SYS` expose only aggregate counts; per-client
    subscriptions require the admin API, and the UI says so plainly rather than
    implying it can see more than MQTT allows. Mosquitto has **no** admin API
    that lists live per-client subscriptions (`mosquitto_ctrl` manages accounts
    and ACLs, not subscriptions), so there is nothing to integrate against —
    for mosquitto, wildcard resolution over observed traffic is the ceiling.
- **Pipelines: industrial DataOps** — Manifold doesn't just observe the
  namespace, it can *shape* it. Routes consume a topic filter, run an ordered
  transform chain (**re-path** into a UNS-conformant hierarchy with `{n}`
  segment templates, **pick/rename/set** payload fields, **scale** for unit
  conversion, **numeric** coercion, **Sparkplug flatten**), and deliver to a
  broker (optionally retained) or a **historian**. Every route gets a
  **trie-backed dry-run**: before enabling, see exactly which observed topics
  it consumes and the in→out topic/payload mapping — no other tool can preview
  a pipeline against *your live namespace* like this. Feedback loops (a route
  whose output re-matches its own source) are detected and blocked, and
  per-route metrics (in/out/errors/loop-blocked) stream in the UI.
- **Models: contextualization** — bind attributes from many raw topics (even
  across brokers, a field plucked from each payload) and publish them as **one
  merged object at a clean UNS path**, on change (debounced) or on an interval.
  Ten raw topics become one `Pump-7`.
- **Historian integrations** — first-class time-series targets for pipelines
  and the recorder: **InfluxDB v2** (line-protocol writes with proper
  escaping/typing, token auth), **TimescaleDB / PostgreSQL** (batched
  parameterized inserts into a samples table auto-created on first write and
  promoted to a hypertable when Timescale is present — plain Postgres works
  too), **FINOS TimeBase CE** (JSON rows via the
  TimebaseWS gateway on `:8099` — `{$type, symbol, timestamp, value, quality}`
  with optional Deltix HMAC-SHA384 API-key signing; write path overridable per
  gateway version), and **Timebase historian** (TVQ writes into a
  dataset via its public REST API on `:4511`; datasets auto-create, and the
  write path is confirmable/overridable against your instance's own Swagger at
  `:4511/api/help`). Timebase also ingests MQTT/Sparkplug natively, so pointing
  its collector at a pipeline's output namespace is an equally supported path.
  Per-connection **test write** button; secrets stored server-side only.
- **Recorder + Replay** — capture everything under a filter as a time series to
  an append-only local file (bounded, owner-only) or straight into a historian;
  peek at captured points, then **replay** a recording onto a broker with the
  original relative timing (speed factor, loop, topic prefix) — real traffic
  becomes a reusable test fixture.
- **Schema contracts** — lock the inferred JSON shape of a topic and get
  violations the moment a publisher drifts: missing fields, new fields, type
  changes, with exact paths. Catches the "firmware update silently changed the
  payload" failure before consumers do.
- **Tags: browse devices, bind into the UNS** — a unified tag browser over the
  drivers Manifold already speaks: the **OPC UA address space** (lazy,
  node-class aware), the **Sparkplug device registry** (Group → Edge → Device →
  metrics, reconstructed from BIRTH certificates), and the **MQTT topic trie**.
  Tick tags, hit *Add to UNS*, and a wizard binds them to a destination:
  plain MQTT topics (raw value or **TVQ envelope** `{v,t,q}`) or a proper
  **Sparkplug B device**. Report-by-exception (**absolute deadband**) and
  per-binding sampling for OPC UA sources; OPC UA status codes map to real
  quality (Good 192 / Uncertain 64 / Bad 0). **CSV tag import** takes
  Kepware/Ignition-style `nodeId,name` exports straight into the selection.
  Bindings are read-only by design — Manifold monitors and republishes, it
  never writes to a device.
- **A spec-respecting Sparkplug B publisher** — bindings that target Sparkplug
  run on a dedicated session per (broker, group, edge node) with the lifecycle
  the spec demands: CONNECT with an NDEATH will carrying the session's bdSeq,
  NBIRTH (seq 0, `Node Control/Rebirth`), DBIRTH before any DDATA, seq
  numbering mod 256 across all node messages, rebirth on NCMD, and clean
  DDEATH/NDEATH on shutdown. Verified against a real broker in CI.
- **Store-and-forward historian delivery** — every point bound for InfluxDB /
  Timebase goes through a persistent outbox: failed writes spill to disk,
  survive restarts, and drain oldest-first when the historian recovers. Bounds
  are explicit and *reported* (queue depth, spill bytes, dropped counts in the
  UI and `/metrics`) — a historian outage delays data, it doesn't delete it.
- **Roles + audit trail** — `TC_AUTH_TOKEN` (admin) plus optional
  `TC_VIEWER_TOKEN` (read-only: GETs succeed, every mutation and control
  socket event is refused). Every mutating API call and socket command lands
  in an **audit log** (role, IP, route, outcome; secrets redacted) — in the
  Settings UI and append-only on disk.
- **Watchable by your monitoring** — `GET /metrics` exposes Prometheus metrics
  for Manifold itself: event-loop delay percentiles, per-broker ingest, per-route
  pipeline counters, outbox depth, contract violations, binding publishes. Live
  engine metrics also stream to the UI over the existing socket instead of REST
  polling (hidden tabs don't poll at all).
- **Configuration as code** — export the entire DataOps setup (pipelines,
  models, historians, recordings, contracts, bindings, mounts, alert rules) as
  one JSON document with secrets stripped; import merges by id and keeps stored
  secrets. Reviewable in git, promotable between environments.
- **Alert rules** — active watching, not just looking: *branch silent* (nothing
  under a path for N seconds), *topic silent*, and *new topic appears* (under an
  optional prefix). Rules persist, are evaluated server-side every 15s against
  the same trie/store the UI reads, fire on transitions (firing → resolved), and
  each rule can POST its events to a **webhook**. Recent alerts show in Settings
  and stream over the socket.
- **Message history that survives restarts + payload diff** — the per-broker
  recent-message rings snapshot to disk periodically and at shutdown, and
  restore on boot (live traffic always wins over history). In any topic's
  history panel, pick **two messages to diff**: a structural JSON diff shows
  exactly which fields changed (`±`), appeared (`+`), or vanished (`−`) between
  publishes.
- **Honest network discovery** — TCP port probing across a CIDR range, each hit
  verified with a real protocol handshake. No fabricated results.
- **CESMII SMIP integration** — connect to a Smart Manufacturing Innovation Platform
  instance (two-step JWT handshake handled server-side), list equipment and
  attributes, and pull historical time-series with an inline sparkline.
- **i3X integration** — connect to a CESMII i3X server (the Common Contextual
  Manufacturing Information API), discover its namespaces and objects, and
  visualize the object/relationship graph with live values and history. i3X
  servers are also auto-detected during network discovery.
- **MCP server** — expose MQTT, OPC UA, CESMII and i3X tools to Claude Desktop, IDE
  agents, or any MCP client.

---

## Architecture

```
Manifold
├── server/   Node.js + Express + Socket.IO backend
│             MQTT (mqtt.js) · OPC UA (node-opcua) · CESMII SMIP · i3X · discovery · Sparkplug B
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

- Node.js ≥ 20 (the OPC UA dependency chain uses ESM-only packages that require
  Node 20.19+ / 22+)

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

### Authentication & persistence

Manifold is a **control plane** — it can publish to brokers (including
Sparkplug commands that actuate equipment), disconnect connections, and start
network scans. Before exposing it beyond localhost:

```bash
TC_AUTH_TOKEN=$(openssl rand -hex 24) npm start
```

- With `TC_AUTH_TOKEN` set, every `/api` route and the Socket.IO handshake
  require `Authorization: Bearer <token>`; the web UI shows an unlock screen and
  remembers the token locally. `/health` stays open for liveness probes.
  Without it, the server runs open and warns loudly at startup.
- **Connection profiles persist**: brokers (with their admin API configs),
  OPC UA endpoints, and CESMII / i3X configs are saved to
  `server/data/profiles.json` (override with `TC_DATA_DIR`; disable restore with
  `TC_NO_RESTORE=1`) and automatically reconnected on startup. The file can
  contain credentials — that is the point of persistence — so it is written
  `0600` (owner-only). Protect the host and directory accordingly; encrypting it
  without a real key-management story would be theater, so we don't pretend to.
- The MCP server forwards the same token: set `TC_AUTH_TOKEN` in its
  environment when the backend runs authenticated.

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
    "manifold": {
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
| `mqtt_sparkplug_topology` / `mqtt_sys_stats` | Sparkplug device topology and broker `$SYS` health |
| `mqtt_resolve_subscriptions` / `mqtt_topic_tree` | Resolve wildcard filters against observed topics; walk the topic tree |
| `mqtt_admin_pubsub` | Per-client subscriptions from the broker admin API (optionally resolved) |
| `uns_tree` / `uns_lint` / `uns_events` | Nested UNS tree (exact counts, depth-capped), namespace conformance lint, namespace event feed |
| `pipelines_list` / `pipeline_preview` | DataOps routes with live metrics; dry-run a route against observed topics |
| `historians_list` / `models_list` / `contracts_violations` | Historian connections, contextualization models, schema-drift events |
| `bindings_list` / `audit_recent` | Tag bindings with publish/deadband status; the audit trail |
| `opcua_connect` / `opcua_disconnect` / `opcua_list_connections` | Manage OPC UA connections |
| `opcua_browse` / `opcua_read` / `opcua_monitor` | Walk the address space, read and monitor nodes |
| `cesmii_configure` / `cesmii_status` | Configure and authenticate a CESMII SMIP instance |
| `cesmii_list_equipment` / `cesmii_list_attributes` | List SMIP equipment and attributes |
| `cesmii_history` / `cesmii_query` | Pull time-series history or run a raw GraphQL query |
| `i3x_connect` / `i3x_probe` / `i3x_status` | Connect to, probe, or inspect an i3X server |
| `i3x_namespaces` / `i3x_object_types` / `i3x_graph` | Discover namespaces, types, and the object graph |
| `i3x_related` / `i3x_value` / `i3x_history` | Navigate relationships and read current/historical values |

---

## HTTP API (selected)

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/api/system/status` | Overall status |
| `POST` | `/api/system/discovery/start` | Start a network scan (`{ range?, mqttPorts?, opcuaPorts? }`) |
| `GET` | `/api/mqtt/brokers` | List broker connections |
| `POST` | `/api/mqtt/brokers` | Connect (`{ host, port?, protocol?, username?, password? }`) |
| `GET` | `/api/mqtt/brokers/:id/topics` | Topic list with counts |
| `GET` | `/api/mqtt/brokers/:id/sparkplug` | Sparkplug device topology (Group → Edge → Device) |
| `GET` | `/api/mqtt/brokers/:id/sys` | Broker `$SYS` health summary |
| `POST` | `/api/mqtt/brokers/:id/subscriptions/resolve` | Resolve wildcard filters against observed topics (`{ filters }`) |
| `GET` | `/api/mqtt/brokers/:id/topictree?prefix=` | One level of the observed topic tree with subtree counts |
| `GET` | `/api/mqtt/brokers/:id/admin/pubsub?resolve=1` | Per-client subscriptions from the broker admin API, wildcard-resolved |
| `GET` | `/api/mqtt/brokers/:id/uns/tree?prefix=&depth=` | Nested namespace skeleton (exact subtree counts, depth/node-capped) |
| `GET` | `/api/mqtt/brokers/:id/uns/lint` | Namespace conformance report (score + findings) |
| `GET` | `/api/mqtt/brokers/:id/uns/events` | Namespace event feed (new topics + Sparkplug BIRTH/DEATH) |
| `GET/POST/DELETE` | `/api/uns/mounts` | Mount OPC UA / i3X sources into the UNS view |
| `GET/POST/DELETE` | `/api/alerts/rules` | Alert rules (branch-silent, topic-silent, new-topic) |
| `GET` | `/api/alerts/events` | Recent alert firings |
| `GET/POST/DELETE` | `/api/pipelines` · `POST /preview` | DataOps routes (source → transforms → target) + trie-backed dry-run |
| `GET/POST/DELETE` | `/api/historians` · `POST /:id/test` | InfluxDB / Timebase connections + test write |
| `GET/POST/DELETE` | `/api/models` | Contextualization models (multi-source merged objects) |
| `GET/POST/DELETE` | `/api/recorder` · `GET /:id/data` | Recordings (file or historian) + bounded read-back |
| `POST/DELETE` | `/api/recorder/replay` | Start/stop replaying a recording onto a broker |
| `GET/POST/DELETE` | `/api/contracts` · `/infer` · `/violations` | Schema contracts: infer, lock, drift feed |
| `GET` | `/api/tags/sources` · `/browse` | Unified tag browser (OPC UA / Sparkplug / MQTT) |
| `GET/POST/DELETE` | `/api/tags/bindings` | Tag bindings into the UNS (deadband, TVQ, Sparkplug out) |
| `GET` | `/api/audit` | Audit trail of mutating actions (admin only) |
| `GET/POST` | `/api/system/config/export` · `/import` | Configuration as code (secrets stripped/preserved) |
| `GET` | `/metrics` | Prometheus metrics for Manifold itself |
| `GET` | `/api/mqtt/brokers/:id/messages?topic=` | Recent messages for a topic |
| `POST` | `/api/mqtt/brokers/:id/publish` | Publish (`{ topic, payload, qos?, retain? }`) |
| `POST` | `/api/opcua/connections` | Connect (`{ endpointUrl, securityMode?, ... }`) |
| `GET` | `/api/opcua/connections/:id/browse?nodeId=` | Browse a node's children |
| `POST` | `/api/opcua/connections/:id/monitor` | Monitor a variable (`{ nodeId, samplingInterval? }`) |
| `POST` | `/api/cesmii/config` | Configure + authenticate a SMIP instance |
| `GET` | `/api/cesmii/equipment` · `/attributes` | List SMIP equipment / attributes |
| `POST` | `/api/cesmii/history` | Time-series history (`{ ids, startTime, endTime, maxSamples? }`) |
| `POST` | `/api/i3x/connect` · `/probe` | Connect to / probe an i3X server (`{ baseUrl, token? }`) |
| `GET` | `/api/i3x/objects` · `/graph` · `/namespaces` | List objects, the object graph, and namespaces |
| `POST` | `/api/i3x/value` · `/history` | Read current / historical i3X object values |
| `GET` | `/api/layout/engines` | List available layout engines |
| `POST` | `/api/layout` | Compute a graph layout (`{ graph, engine, direction? }`) → node coordinates |

Real-time updates (messages, broker stats, discovery progress, OPC UA values) are
delivered over Socket.IO.

---

## Tests & CI

- **Server tests** run on Node's built-in test runner (no extra dependencies):

  ```bash
  cd server && npm test
  ```

  They cover CIDR expansion, MQTT message-type / Sparkplug detection, the topic
  trie (wildcard semantics), UNS lint rules, the namespace tree/event feeds, the
  read-path decode cache, broker-admin backends (EMQX + HiveMQ, against fake
  REST servers), the alert engine (firing/resolve transitions, watermarks,
  webhooks), history snapshot/restore, auth, profile persistence, CESMII config
  validation, and an HTTP smoke test that boots the app and exercises the REST
  surface. **Integration tests run against a real in-process MQTT broker**
  (aedes): the manager, a pipeline route, and the Sparkplug B publisher are
  exercised end-to-end with an independent witness client — including the
  NBIRTH → DBIRTH → DDATA → DDEATH/NDEATH lifecycle and seq numbering. An
  RBAC suite boots the app with admin + viewer tokens and covers roles, the
  audit trail, `/metrics`, and config export/import.

- **Client tests** run on Vitest over the pure logic modules (topic-filter
  matching, graph builders/collapse/coverage, UNS tree building, payload diff):

  ```bash
  cd client && npm test
  ```

- **GitHub Actions** (`.github/workflows/ci.yml`) runs on every push and PR to
  `main`: server tests on Node 22, client tests + production build, an MCP
  server load check, and an **integration job with real service containers**
  (EMQX 5 + InfluxDB 2) that connects the actual manager to the actual broker
  and queries written points back out of the actual database. A perf-smoke
  suite enforces order-of-magnitude floors on the hot path (200k ingests,
  trie build, 50k pipeline dispatches), and a restart-survival test proves
  DataOps config persists and re-compiles on boot.

---

## Tech stack

- **Backend:** Express, Socket.IO, `mqtt`, `node-opcua-client`, `protobufjs`
- **Frontend:** React 18, Vite, Tailwind CSS, `d3-force` / `d3-zoom` (canvas
  rendering), Zustand, Framer Motion, lucide-react
- **MCP:** `@modelcontextprotocol/sdk`

## License

MIT

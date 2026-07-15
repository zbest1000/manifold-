# Manifold architecture

This document describes how Manifold is built: the system layout, the message
hot path, each subsystem, the API surface, protocol behavior worth knowing,
and the testing strategy. The README stays short; the details live here.

## System overview

```mermaid
flowchart LR
    subgraph sources [Data sources]
        B[MQTT brokers]
        O[OPC UA servers]
        C[CESMII SMIP]
        I[i3X servers]
    end

    subgraph server [server/ - Node.js]
        M[mqttManager<br/>ingest + coalesce]
        OM[opcuaManager]
        T[TopicTrie]
        P[pipelineEngine]
        MD[modelEngine]
        R[recorder / replayer]
        SC[schemaContracts]
        TB[tagBindings]
        SP[sparkplugPublisher]
        OB[historianOutbox]
        H[historians<br/>influx / timescale / timebase]
        AL[alertEngine]
        AU[auditLog]
        MX[metricsExporter]
    end

    subgraph clients [Consumers]
        UI[client/ - React]
        MCP[mcp/ - MCP server]
        PROM[Prometheus]
        HIST[(Historian databases)]
    end

    B --> M
    O --> OM
    M --> T
    M -- message tap --> P & R & SC & TB
    OM -- monitored values --> TB
    P --> OB
    R --> OB
    OB --> H --> HIST
    TB --> SP --> B
    P -- publish --> B
    M -- Socket.IO --> UI
    MCP -- REST --> server
    MX --> PROM
```

The backend owns all live state. The client is a real-time view over
Socket.IO plus REST for configuration. The MCP server is a stateless bridge
over the same REST API, so a browser user and an MCP agent see identical
data.

## Repository layout

```
server/   Express + Socket.IO backend; all protocol drivers and engines
client/   React 18 + Vite + Tailwind; canvas renderers, Zustand store
mcp/      MCP server (stdio), forwards to the backend REST API
native/   Rust/napi hot-path experiment, kept as a reproducible benchmark
docker/   Demo stack: app, mosquitto, OPC PLC simulator, traffic generator
```

## Message hot path

The server is built to survive high publish rates. The design rule: per-message
work is minimal and allocation-free; everything expensive is deferred to a
coalced flush that is bounded by *topics touched*, not messages received.

```mermaid
sequenceDiagram
    participant Broker
    participant handleMessage
    participant TopicStore
    participant Flush as flushBroker (100ms timer)
    participant Consumers as socket + tap engines

    Broker->>handleMessage: publish (topic, payload)
    handleMessage->>TopicStore: ingest - store latest payload, mark dirty
    Note over handleMessage,TopicStore: no JSON parse, no uuid,<br/>no message object allocation
    Flush->>TopicStore: drain dirty rows
    Flush->>Flush: buildMessage once per touched topic<br/>(parse, type cache, Sparkplug decode)
    Flush->>Consumers: one batch: socket emit + engine tap
```

Key mechanics:

- **TopicStore** (`server/services/topicStore.js`) is a struct-of-arrays: one
  `Map(topic → slot)` plus parallel typed arrays, with the latest payload kept
  as a latin1 string (one byte per char in V8, lossless for arbitrary bytes).
  Capped at 2M topics per broker. At 1M topics this measured 425 MB RSS versus
  532 MB for a Map-of-objects; the Rust store measured 380 MB but lost on
  FFI round-trip cost (see `native/README.md` for the full benchmark).
- **Coalescing**: a topic published 10,000 times inside one 100 ms window
  produces one forwarded update. Per-flush forwarding is capped
  (`FORWARD_CAP`), with counts always exact server-side.
- **Per-slot type cache**: a topic's classification (telemetry/alarm/…,
  Sparkplug or not) is a pure function of the topic string, so it is computed
  once per slot, not per flush.
- **Single topic split**: the flush splits each topic once and passes
  `topicParts` to every tap consumer (pipelines, recorder, contracts,
  bindings).
- **Zero-listener guard**: the socket batch is not serialized when no client
  is connected (headless or MCP-only deployments).
- Intake subscribes at QoS 1 by default (configurable per broker). If the
  broker refuses the wildcard grant (SUBACK 0x80), the manager emits
  `subscription-downgraded` and retries at QoS 0. `$SYS/#` stays at QoS 0.

## Wildcard resolution

A subscription filter is a query, not a destination. `TopicTrie` indexes every
observed topic; filters (`+`, `#`, `$share` groups, `$`-topic exclusion rules)
resolve to exact match counts, covering subtree roots, and concrete leaf
topics. The trie builds lazily on first resolve and indexes incrementally
afterward. Flows uses this to show what each consumer actually receives;
pipeline previews and alert rules run on the same index.

## UNS derivation

The UNS view is derived entirely from observed traffic — there is no separate
registration step. The client keeps per-path activity, value, and rate maps
fed by the message stream, aggregated up the ancestor chain. Staleness is
per-topic: an EMA of inter-arrival gaps means a topic publishing every 500 ms
is flagged *overdue* seconds after it stops, while a daily report topic is not
flagged for hours. Server-side, `getUnsTree` returns a depth- and node-capped
skeleton with exact subtree counts, and the lint pass scores structural
conformance (naming-convention mixes, payloads on branches, empty segments,
single-child chains, depth variance).

The topology canvas throttles its draw loop to roughly 8 fps when there is no
traffic and no interaction, returning to full frame rate on either signal.

## Pipelines

```mermaid
flowchart LR
    SRC[broker filter match] --> TR[transform chain]
    TR -->|null| DROP[dropped by filter transform]
    TR --> TGT{target}
    TGT -->|mqtt| LG{loop guards}
    LG -->|static: output re-matches own source| BLOCK[blocked + counted]
    LG -->|hop count > 4 within 10s| BLOCK
    LG -->|ok| PUB[publish to broker]
    TGT -->|historian| OB[outbox enqueue]
```

- The route table is **compiled**: filters pre-split, disabled routes
  excluded, rebuilt only when the profile store revision changes. Steady-state
  per-message cost is array walks against pre-split segments.
- Transforms: `repath` (with `{n}` / `{n-}` / `{topic}` segment templates),
  `pick`, `rename`, `set`, `scale`, `numeric` (drop non-numeric), `sparkplugFlatten`
  (`is_null` metrics propagate as explicit nulls), `envelope` (TVQ `{v,t,q}`).
- Loop protection is two-layer because repath templates defeat static
  analysis: outputs matching the route's own source are blocked outright, and
  a short-lived hop counter on published (broker, topic) pairs catches
  indirect A→B→A cycles across routes and brokers.
- Every route can be dry-run against the observed topic set before enabling:
  the trie resolves the source filter, each sample's latest payload runs
  through the transform chain, and the in→out mapping is reported without
  publishing.

## Historians and store-and-forward

Three backends share one write interface (`writePoints`):

| Backend | Wire format | Notes |
|---|---|---|
| InfluxDB v2 | line protocol | numeric values write `value=`, non-numeric write `raw="…"` — a topic that alternates types cannot cause field-type conflicts in a shard |
| TimescaleDB / PostgreSQL | batched parameterized INSERT | table auto-created, promoted to hypertable when the extension exists; identifier allow-list; pooled connections with bounded connect/query timeouts |
| Timebase (Flow Software) | TVQ REST on `:4511` | datasets auto-create; write path overridable per instance; Timebase's native MQTT/Sparkplug ingestion is an equally valid path |

Delivery always goes through the **outbox** — engines never call a historian
directly:

```mermaid
stateDiagram-v2
    [*] --> Queue: enqueue
    Queue --> Written: flush ok
    Queue --> Spill: write failed / memory cap
    Spill --> Written: drained oldest-first on recovery
    Spill --> Dropped: spill file at cap
    note right of Dropped
        drop policy per historian:
        newest (default, keeps outage start)
        or oldest (keeps latest data)
    end note
```

The spill is an append-only JSONL file per historian that survives restarts.
All bounds are explicit and reported (queue depth, spill bytes, drop counts)
in the UI and `/metrics`.

## Tag bindings and the Sparkplug publisher

Bindings select tags from a source (OPC UA monitored items or Sparkplug
registry metrics; MQTT-source selections compile into pipeline routes
instead) and publish to a UNS destination. Report-by-exception: an absolute
deadband suppresses small numeric changes; non-numeric values publish on
change. OPC UA status codes map to quality (Good 192 / Uncertain 64 / Bad 0).
Bindings never write toward devices.

Sparkplug output runs one session per (broker, group, edge node) with the
lifecycle the specification requires:

```mermaid
sequenceDiagram
    participant P as sparkplugPublisher
    participant B as Broker

    P->>B: CONNECT (will = NDEATH with bdSeq)
    P->>B: NBIRTH seq 0 (Node Control/Rebirth metric)
    P->>B: DBIRTH per device (before any data)
    loop value updates
        P->>B: DDATA (seq mod 256 across all node messages)
    end
    B->>P: NCMD Node Control/Rebirth
    P->>B: NBIRTH (new seq cycle)
    Note over P,B: shutdown: DDEATH per device, then NDEATH,<br/>connection closed gracefully so both frames flush
```

## Security model

- `MANIFOLD_AUTH_TOKEN` (admin) and optional `MANIFOLD_VIEWER_TOKEN` (read-only) gate the
  REST API and the socket handshake. Viewer tokens can read everything but
  every mutation — HTTP or socket — is refused.
- Every mutating action lands in the audit log (role, IP, route, outcome)
  with secrets redacted, kept in a ring buffer and an append-only JSONL file.
- Secrets (broker passwords, historian tokens, admin API keys) are stored
  server-side only: never echoed by the API, redacted from audit entries, and
  stripped from config exports. Config import preserves stored secrets when
  the incoming document omits them.
- `server/data/` is written mode 0600/0700. It is not encrypted: without a
  real key-management story, at-rest encryption of a file the server must
  read on boot adds no protection, so the honest measure is file permissions
  plus host security.

## Protocol notes

Observed behavior that shapes the implementation:

- **EMQX default ACL and QoS 1 wildcards.** Stock EMQX denies `#`
  subscriptions at QoS 1+ from non-localhost clients, and its default
  `deny_action = ignore` makes the denial silent: the SUBACK reports success
  and the subscription simply never exists. No client-side logic can detect
  this. The QoS-0 fallback covers brokers that refuse loudly per spec;
  for EMQX, either grant the permission in the broker ACL or configure
  intake at QoS 0. CI's EMQX container authorizes wildcard intake the way a
  production deployment backing a UNS platform would.
- **Mosquitto has no per-client subscription API.** `mosquitto_ctrl` manages
  accounts and ACLs, not live subscriptions, so consumer resolution against
  mosquitto is limited to observed traffic. The UI states this rather than
  implying MQTT exposes more than it does.
- **Sparkplug edge death cascades to devices**, per specification, and the
  registry applies this when an NDEATH arrives.
- **InfluxDB field types are fixed per shard.** The first write wins; later
  writes with a different type are rejected. Splitting numeric (`value=`) and
  string (`raw=`) fields at the client makes this failure mode impossible.
- **pg defaults block forever.** `connectionTimeoutMillis` defaults to 0; an
  unreachable database turns into a hung process rather than an error. All
  pools set bounded connect/query timeouts and `allowExitOnIdle`.

## HTTP API

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/api/system/status` | Overall status |
| `POST` | `/api/system/discovery/start` | Start a network scan |
| `GET/POST` | `/api/mqtt/brokers` | List / connect brokers |
| `GET` | `/api/mqtt/brokers/:id/topics` · `/messages` | Topic list; recent messages |
| `POST` | `/api/mqtt/brokers/:id/publish` | Publish |
| `GET` | `/api/mqtt/brokers/:id/sparkplug` · `/sys` | Sparkplug topology; `$SYS` summary |
| `POST` | `/api/mqtt/brokers/:id/subscriptions/resolve` | Resolve wildcard filters against observed topics |
| `GET` | `/api/mqtt/brokers/:id/topictree` | One tree level with subtree counts |
| `GET` | `/api/mqtt/brokers/:id/admin/pubsub` | Per-client subscriptions from the broker admin API |
| `GET` | `/api/mqtt/brokers/:id/uns/tree` · `/uns/lint` · `/uns/events` | UNS skeleton, lint report, event feed |
| `GET/POST/DELETE` | `/api/uns/mounts` | Mount OPC UA / i3X sources into the UNS |
| `GET/POST/DELETE` | `/api/alerts/rules` · `GET /api/alerts/events` | Alert rules; recent firings |
| `GET/POST/DELETE` | `/api/pipelines` · `POST /preview` | Routes; dry-run |
| `GET/POST/DELETE` | `/api/historians` · `POST /:id/test` | Historian connections; test write |
| `GET/POST/DELETE` | `/api/models` | Contextualization models |
| `GET/POST/DELETE` | `/api/recorder` · `GET /:id/data` · `POST/DELETE /replay` | Recording; read-back; replay |
| `GET/POST/DELETE` | `/api/contracts` · `/infer` · `/violations` | Schema contracts |
| `GET` | `/api/tags/sources` · `/browse` | Tag browser |
| `GET/POST/DELETE` | `/api/tags/bindings` | Tag bindings |
| `GET` | `/api/audit` | Audit trail (admin only) |
| `GET/POST` | `/api/system/config/export` · `/import` | Config as code |
| `GET` | `/metrics` | Prometheus metrics |
| `POST` | `/api/opcua/connections` · `/:id/monitor` | OPC UA connect; monitor |
| `GET` | `/api/opcua/connections/:id/browse` | Browse the address space |
| `POST` | `/api/cesmii/config` · `/history` | CESMII configure; time-series |
| `POST` | `/api/i3x/connect` · `/probe` · `/value` · `/history` | i3X connect/probe; reads |
| `GET` | `/api/i3x/objects` · `/graph` · `/namespaces` | i3X inventory |

Live updates (messages, broker stats, engine metrics, alerts, OPC UA values,
discovery progress) stream over Socket.IO. Engine metrics push every 2 s only
while a client is connected.

## MCP tools

| Tool | Purpose |
| --- | --- |
| `system_status` | Backend status |
| `discover_scan` / `discover_results` | Network scan |
| `mqtt_connect` / `mqtt_disconnect` / `mqtt_list_brokers` | Broker connections |
| `mqtt_list_topics` / `mqtt_get_messages` | Topics and payloads |
| `mqtt_subscribe` / `mqtt_publish` | Subscribe / publish |
| `mqtt_sparkplug_topology` / `mqtt_sys_stats` | Sparkplug topology; `$SYS` health |
| `mqtt_resolve_subscriptions` / `mqtt_topic_tree` | Wildcard resolution; tree walk |
| `mqtt_admin_pubsub` | Admin-API subscriptions, optionally resolved |
| `uns_tree` / `uns_lint` / `uns_events` | UNS skeleton, lint, events |
| `pipelines_list` / `pipeline_preview` | Routes with metrics; dry-run |
| `historians_list` / `models_list` / `contracts_violations` | DataOps inventory |
| `bindings_list` / `audit_recent` | Bindings; audit trail |
| `opcua_connect` / `opcua_disconnect` / `opcua_list_connections` | OPC UA connections |
| `opcua_browse` / `opcua_read` / `opcua_monitor` | Address space operations |
| `cesmii_configure` / `cesmii_status` / `cesmii_list_equipment` / `cesmii_list_attributes` / `cesmii_history` / `cesmii_query` | CESMII SMIP |
| `i3x_connect` / `i3x_probe` / `i3x_status` / `i3x_namespaces` / `i3x_object_types` / `i3x_graph` / `i3x_related` / `i3x_value` / `i3x_history` | i3X |

## Testing

Server tests (124, `cd server && npm test`) run on `node:test` through a
small serial runner (`server/test/run.js`) that executes each file
in-process. The stock `node --test` runner spawns each file as a child and
streams results over an IPC pipe whose framing corrupts intermittently on CI
runners ("Unable to deserialize cloned data") — observed on Node 20 and 22,
including at concurrency 1. Direct execution produces the same TAP output and
exit semantics with no IPC.

Coverage highlights:

- Topic trie wildcard semantics, UNS lint and feeds, alert transitions,
  history snapshot/restore, auth/RBAC boots with audit and `/metrics`.
- DataOps: every transform, both loop guards (including an A→B→A ping-pong),
  outbox spill/drain across a simulated restart, both drop policies verified
  byte-for-byte on the spill file, all four historian wire formats against
  fakes (including an identifier-injection refusal for TimescaleDB).
- Subscription-refusal fallback against a fake client reproducing mqtt.js's
  error-form SUBACK.
- Real-broker integration via in-process aedes: manager round-trip, a
  pipeline end-to-end, and the full Sparkplug NBIRTH → DBIRTH → DDATA →
  DDEATH/NDEATH lifecycle with sequence assertions, witnessed by an
  independent client.
- Perf smoke: order-of-magnitude floors on 200k ingests, trie build/resolve,
  and 50k tapped messages across 20 compiled routes.

Client tests (Vitest) cover the pure logic modules: topic-filter matching,
graph builders/collapse/coverage, UNS tree building, payload diff.

CI (`.github/workflows/ci.yml`) runs four jobs on every push and PR: server
tests (Node 22), client tests + production build, an MCP load check, and an
integration job against real service containers — EMQX 5 (configured to
authorize wildcard QoS-1 intake), InfluxDB 2 (line-protocol writes queried
back via Flux), and TimescaleDB (rows queried back out of a hypertable).
Jobs carry 15-minute timeouts, the service-wait step fails by name instead of
passing through a dead container, failures dump container logs, and a
concurrency group cancels superseded runs.

## Performance notes

The pure-JS hot path sustains ~4M messages/s ingest on commodity hardware. A
Rust/napi implementation of the same store was benchmarked (`native/`):
Rust wins when Rust owns the loop (12M/s) but loses through per-message or
batched FFI (2.8M/s and 1.4M/s) — the napi boundary costs more than the work
it saves. The struct-of-arrays JS store also recovered most of Rust's memory
advantage (425 MB vs 380 MB at 1M topics). The addon is kept as a
reproducible benchmark, not a dependency.

# Changelog

All notable changes to Manifold are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-07-15

First tagged release.

### Added

- **Value-threshold alert rules.** Watch a numeric payload — or a dot-path
  `field` inside a JSON payload — against `>`, `>=`, `<`, `<=`, `==`, `!=`.
  Evaluated at message latency on the live tap, not on a polling interval.
  Optional `sustainMs` (the condition must hold continuously before firing)
  and `clearValue` hysteresis (a `>` rule resolves only once the value falls
  back to the clear level — no flapping in the deadband).
- **Historian read-back and a Trends page.** `GET /api/historians/:id/tags`
  lists stored tags; `POST /api/historians/:id/query` reads downsampled
  series (InfluxDB via Flux `aggregateWindow`, TimescaleDB via
  `time_bucket`). The Trends page charts up to 10 series with a time-range
  picker and 30 s auto-refresh.
- **MQTT 5, opt-in per broker.** v5 user properties, content type, response
  topic, and correlation data are decoded on inbound messages; user
  properties, content type, and response topic can be set on publish.
- **MQTT over WebSocket.** `ws` and `wss` transports with a configurable
  path (default `/mqtt`).
- **Configurable intake filter.** The auto-subscribe filter is set per
  broker and accepts shared subscriptions (`$share/<group>/<filter>`).
- **Sparkplug B host application STATE.** The registry tracks
  `spBv1.0/STATE/{host}` messages (host online/offline in the UI and event
  feed), and Manifold can itself run a primary-host session publishing
  retained STATE with a matching will (`POST /api/tags/sparkplug/state`).
- **OPC UA security.** Application certificate manager under
  `<data dir>/pki` (self-signed client certificate created on first use),
  Sign and SignAndEncrypt connections, endpoint discovery
  (`POST /api/opcua/discover`), and certificate trust management
  (`GET /api/opcua/certificate`, `GET`/`POST /api/opcua/trust`) with
  optional trust-on-first-connect.
- **Edit in place everywhere.** Brokers (`PUT /api/mqtt/brokers/:id`) and
  OPC UA connections (`PUT /api/opcua/connections/:id`) update without
  delete/re-add; pipelines, historians, models, bindings, and alert rules
  upsert by id.
- **MCP server grew to 75 tools** — 29 new mutation and read tools:
  save/delete for pipelines, historians, models, bindings, recordings,
  contracts, mounts, and alert rules; historian test writes; recorder
  read-back; replay start/stop; subscribe/publish; config export/import.
- **Custom UNS icons.** Upload single-path SVG icons
  (`POST /api/uns/icons`) and assign them in the topology, alongside a
  curated set of roughly 130 industrial icons.
- **Named API tokens.** `MANIFOLD_TOKENS="name:token:role,..."` issues
  individually revocable admin/viewer tokens; the token name appears in the
  audit trail.
- **Global socket-disconnect banner** in the UI, so no panel silently shows
  stale data.
- **Docker image.** `ghcr.io/zbest1000/manifold`, published on `v*` tags;
  one container serves the API and the built UI.
- **CI** integration tests now include a Timebase historian container next
  to EMQX, InfluxDB, and TimescaleDB.

### Changed

- 3D topic graph rewritten on three.js: instanced sphere rendering handles
  50,000 nodes, and three.js loads as a lazy chunk only when the 3D view
  opens.
- Force-directed layout runs in a client Web Worker (d3-force, 30,000-node
  cap) — the UI thread never blocks on layout.
- The UNS icon set ships as a curated ~130-icon industrial subset; the full
  icon library loads on demand in the picker instead of weighing down the
  main bundle.
- All outbound HTTP calls (historian writes and queries, alert webhooks,
  broker admin APIs) carry bounded timeouts.
- The Bench page is development-only.

### Removed

- TimeBase CE historian backend. Three backends remain: InfluxDB v2,
  TimescaleDB/PostgreSQL, and Timebase (Flow Software).
- Server-side graph layout engines — layout is now entirely client-side in
  the Web Worker.

### Fixed

- A failed publish from a timer callback (replayer, model engine) could
  escape its error handler and crash the server; `publish()` now never
  throws synchronously.
- Message-history restore no longer races profile restore on boot — rings
  refill in order after connections are re-established.
- A corrupt profiles file no longer wipes saved connections silently: it is
  backed up to `profiles.json.bak` (mode 0600) so credentials can be
  recovered, and the server starts clean.
- OPC UA monitored items are rebuilt automatically after a reconnect, so
  live values resume without manual re-monitoring.
- Alert webhook delivery failures are counted and surfaced
  (`webhookFailures`, `lastWebhookError` on `/api/alerts/rules`) instead of
  disappearing into the log.

### Security

- CORS is locked to the configured client origin (`CLIENT_URL`, default
  `http://localhost:3000`) instead of allowing any origin.
- Failed authentication is rate-limited per IP: 20 failures per minute,
  then `429` responses.

[1.0.0]: https://github.com/zbest1000/manifold/releases/tag/v1.0.0

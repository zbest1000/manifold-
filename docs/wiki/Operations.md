# Operations

## Authentication and roles

Manifold is a control plane (it can publish, actuate via Sparkplug commands,
and scan networks). Run it authenticated anywhere beyond localhost:

```bash
MANIFOLD_AUTH_TOKEN=$(openssl rand -hex 24) \
MANIFOLD_VIEWER_TOKEN=$(openssl rand -hex 24) \
npm start
```

- Admin token: full access to API and socket.
- Viewer token: all reads succeed; every mutation (HTTP or socket event) is
  refused with 403.
- `/health` stays open for liveness probes.

## Audit log

Every mutating API call and socket command is recorded with role, IP, route,
and outcome; secrets are redacted. View under **Settings → Audit** (admin
only) or read the append-only JSONL in `MANIFOLD_DATA_DIR`.

## Prometheus

`GET /metrics` exposes: event-loop delay percentiles, per-broker ingest
counters, per-route pipeline counters, outbox depth/spill/drops, contract
violations, and binding publishes.

```yaml
scrape_configs:
  - job_name: manifold
    static_configs:
      - targets: ['manifold-host:5000']
```

The UI itself does not poll for engine numbers — they are pushed over the
existing socket every 2 s while a client is connected.

## Configuration as code

**Settings → Config** exports the entire DataOps setup (pipelines, models,
historians, recordings, contracts, bindings, mounts, alert rules) as one JSON
document with secrets stripped. Import merges by id and preserves stored
secrets when the incoming document omits them. Keep the export in git;
promote it between environments through the same review process as code.

## Alerts

Three rule types, evaluated server-side every 15 s against the same
trie/store the UI reads:

- **Branch silent** — nothing under a path for N seconds.
- **Topic silent** — a specific topic stops.
- **New topic** — a topic appears (optionally under a prefix).

Rules fire on transitions (firing → resolved) and can POST each event to a
webhook. Recent events show in **Settings → Alerts** and stream over the
socket.

## Data directory

`MANIFOLD_DATA_DIR` (default `server/data/`) holds profiles, history snapshots,
outbox spill, recordings, and the audit log. Files are written 0600/0700.
The profiles file contains connection credentials — protect the host, and
back the directory up if your DataOps config matters.

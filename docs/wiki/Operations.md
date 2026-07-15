# 🛡️ Operations

> **Goal:** run Manifold like the control plane it is — authenticated,
> audited, monitored, and with its configuration in git.

## At a glance

The Overview page surfaces platform health live — pipelines, historians
(store-and-forward state), tag bindings, and alerts, each card linking to its
module:

![Overview with health cards](images/overview.png)

> *Pipelines, historians, tag bindings, and alerts — live, each card linking to its module.*

## Authentication and roles

Manifold can publish to brokers, actuate equipment through Sparkplug
commands, and scan networks. Run it authenticated anywhere beyond localhost:

```bash
MANIFOLD_AUTH_TOKEN=$(openssl rand -hex 24) \
MANIFOLD_VIEWER_TOKEN=$(openssl rand -hex 24) \
npm start
```

| Role | Token | Can |
|---|---|---|
| 🔑 Admin | `MANIFOLD_AUTH_TOKEN` | everything — API, socket, mutations |
| 👁️ Viewer | `MANIFOLD_VIEWER_TOKEN` | read everything; every mutation refused with 403 |

`/health` stays open for liveness probes. Without tokens the server runs open
and warns loudly at startup.

### Named tokens

For teams, `MANIFOLD_TOKENS` issues **individually revocable** tokens with a
name and a role — the name is what shows up in the audit trail:

```bash
MANIFOLD_TOKENS="alice:$(openssl rand -hex 24):admin,dashboard:$(openssl rand -hex 24):viewer" npm start
```

Format: `name:token:role,...` with role `admin` or `viewer`. Revoking one
person's access means removing one entry — no shared-secret rotation.

### Brute-force protection

Failed authentication is rate-limited per IP: after **20 failures in a
minute**, further attempts get `429` until the window passes. Successful
requests are unaffected.

### CORS

The API only accepts browser requests from `CLIENT_URL` (default
`http://localhost:3000`). Set it to the origin your users actually load the
UI from when the client is served separately.

## Audit log

Every mutating API call and socket command is recorded — role, IP, route,
outcome — with secrets redacted. View under **Settings → Audit** (admin
only), or read the append-only JSONL in `MANIFOLD_DATA_DIR`.

## Prometheus

`GET /metrics` exposes event-loop delay percentiles, per-broker ingest,
per-route pipeline counters, outbox depth/spill/drops, contract violations,
and binding publishes:

```yaml
scrape_configs:
  - job_name: manifold
    static_configs:
      - targets: ['manifold-host:5000']
```

> 💡 The web UI never polls for these numbers — they're pushed over the
> existing socket every 2 s, and only while a client is connected.

## Configuration as code

```mermaid
flowchart LR
    DEV[dev instance] -->|export| J[JSON document<br/>secrets stripped]
    J -->|review in git| PR[pull request]
    PR -->|import| PROD[prod instance<br/>stored secrets preserved]
```

**Settings → Config** exports the entire DataOps setup — pipelines, models,
historians, recordings, contracts, bindings, mounts, alert rules — as one
JSON document with secrets stripped. Import merges by id and keeps stored
secrets when the incoming document omits them.

## Alerts

Four rule types, evaluated server-side:

| Rule | Fires when | Evaluated |
|---|---|---|
| 📉 Branch silent | nothing under a path for N seconds | every 15 s |
| 🔇 Topic silent | a specific topic stops | every 15 s |
| 🆕 New topic | a topic appears (optionally under a prefix) | every 15 s |
| 📈 Value threshold | a numeric value crosses a limit | **per message**, as it arrives |

Value-threshold rules watch a topic's payload — or a dot-path `field` inside
a JSON payload (`motor.temp`) — against `>`, `>=`, `<`, `<=`, `==`, `!=`,
with two anti-flap controls:

- **Sustain** — the condition must hold continuously for `sustainMs` before
  the rule fires (one spiky sample is not an incident).
- **Clear value** — hysteresis: a `> 90` rule with clear value `85` fires at
  90 but only resolves back below 85, so a signal hovering at the threshold
  cannot flap.

Rules fire on transitions (firing → resolved) and can POST each event to a
webhook (5 s timeout). Webhook delivery failures are counted and the last
error is shown with the rules — a dead webhook is visible, not silent. Recent
events show in **Settings → Alerts** and stream over the socket.

## Data directory

`MANIFOLD_DATA_DIR` (default `server/data/`) holds profiles, history
snapshots, outbox spill, recordings, the audit log, and the OPC UA PKI
(`pki/` — Manifold's application certificate and the trusted/rejected server
certificate stores) — written 0600/0700.

> ⚠️ The profiles file contains connection credentials, and `pki/own/private`
> holds the OPC UA private key. Protect the host, and back the directory up
> if your DataOps config matters. If the profiles file is ever corrupted, it
> is backed up to `profiles.json.bak` before the server starts clean —
> credentials are recoverable.

## Docker image

Every `v*` tag publishes `ghcr.io/zbest1000/manifold` — server plus built UI
in one container:

```bash
docker run -p 5000:5000 \
  -v manifold-data:/data \
  -e MANIFOLD_AUTH_TOKEN=... \
  ghcr.io/zbest1000/manifold:latest
```

The image sets `MANIFOLD_DATA_DIR=/data` — mount a volume there or your
profiles, history, spill files, and PKI vanish with the container. `/health`
answers without a token, so it works as a liveness probe even when auth is
on.

# Historians

Historians are configured under **Pipelines → Historians**. Pipelines and the
recorder deliver to them through a store-and-forward outbox; nothing writes to
a historian directly.

## Store-and-forward behavior

- Points queue in memory and flush every 2 s in batches.
- A failed write spills the batch to an append-only JSONL file per historian
  (under `MANIFOLD_DATA_DIR/outbox/`). Spill survives restarts and drains
  oldest-first once writes succeed again.
- The spill file is capped (20 MB per historian). At the cap, the
  per-historian **drop policy** decides:
  - **Drop newest** (default) — keeps the beginning of the outage.
  - **Drop oldest** — keeps the most recent data.
- Queue depth, spill bytes, and drop counts are visible on the historian card
  and in `/metrics`. Use the **Test write** button after configuring.

## InfluxDB v2

| Field | Value |
|---|---|
| URL | `http://influx-host:8086` |
| Org / Bucket | as created in Influx |
| Token | a write-scoped API token |
| Measurement | optional, default `manifold` |

Numeric samples are written as the `value` field; non-numeric payloads go to
a separate `raw` string field. This avoids Influx's per-shard field-type
conflicts when a topic alternates between numbers and strings.

## TimescaleDB / PostgreSQL

| Field | Value |
|---|---|
| Host / Port / Database / User / Password | Postgres connection |
| Table | optional, default `manifold_samples` |
| SSL | toggle for `sslmode`-style TLS |

On first write Manifold creates the table (`ts, topic, value, raw, quality`,
indexed on `topic, ts`) and promotes it to a hypertable when the TimescaleDB
extension is present. Plain PostgreSQL works without promotion. Connections
are pooled with bounded connect/query timeouts, so a database outage surfaces
as a write error (which spills) rather than a hang.

## Timebase historian (Flow Software)

| Field | Value |
|---|---|
| URL | `http://historian-host:4511` |
| Dataset | target dataset (auto-created on first write) |
| API key | optional |
| Write path | optional override; confirm against your instance's `:4511/api/help` |

Writes are TVQ samples. Note that Timebase also ingests MQTT/Sparkplug
natively — pointing its own collector at a pipeline's output namespace is an
equally valid integration.

## FINOS TimeBase CE

| Field | Value |
|---|---|
| URL | TimebaseWS gateway, `http://gateway-host:8099` |
| Stream | target stream |
| Message $type | optional |
| API key / secret | optional; requests are Deltix HMAC-SHA384 signed when set |

Rows are JSON `{$type, symbol, timestamp, value, raw, quality}` with the tag
path as `symbol`.

# 🗄️ Historians

> **Goal:** every sample that matters lands in a time-series database — and a
> historian outage delays data instead of deleting it.

Historians are configured under **Pipelines → Historians**. Pipelines and the
recorder never write to a database directly: everything passes through a
**store-and-forward outbox**.

![Historians tab with store-and-forward status](images/historians.png)

> *Each historian card shows its live store-and-forward state: written, queued, spilled, dropped.*

## How store-and-forward protects your data

```mermaid
flowchart LR
    P[pipeline / recorder] --> Q[memory queue]
    Q -->|flush every 2s| W[historian write]
    W -->|ok| DB[(database)]
    W -->|failed| S[disk spill<br/>JSONL per historian]
    S -->|on recovery,<br/>oldest first| W
    S -->|file at 20MB cap| DP{drop policy}
    DP -->|newest - default| K1[keep outage start]
    DP -->|oldest| K2[keep latest data]
```

- The spill file survives restarts and drains **oldest-first** so ordering
  roughly holds.
- Every bound is explicit and visible — queue depth, spill bytes, and drop
  counts on the card and in `/metrics`. Nothing is dropped silently.
- Use the **Test write** button after configuring — it writes one real point
  and reports the outcome.

> 💡 **Choosing a drop policy:** *newest* (default) preserves the beginning of
> an outage — useful for post-mortems. *Oldest* keeps the freshest data —
> what most dashboards want. Set it per historian.

## Backend setup

### InfluxDB v2

| Field | Value |
|---|---|
| URL | `http://influx-host:8086` |
| Org / Bucket | as created in Influx |
| Token | a write-scoped API token |
| Measurement | optional, default `manifold` |

> 💡 Numeric samples write the `value` field; non-numeric payloads write a
> separate `raw` string field. A topic that alternates types can never cause
> Influx's per-shard field-type conflict.

### TimescaleDB / PostgreSQL

| Field | Value |
|---|---|
| Host / Port / Database / User / Password | Postgres connection |
| Table | optional, default `manifold_samples` |
| SSL | TLS toggle |

On first write, Manifold creates the table (`ts, topic, value, raw, quality`,
indexed) and promotes it to a **hypertable** when the TimescaleDB extension is
present — plain PostgreSQL works without promotion. Connections are pooled
with bounded timeouts: a database outage becomes a write error (which spills),
never a hung process.

### Timebase historian (Flow Software)

| Field | Value |
|---|---|
| URL | `http://historian-host:4511` |
| Dataset | target dataset (auto-created on first write) |
| API key | optional |
| Write path | optional override — confirm against `:4511/api/help` |

Writes are TVQ samples. Timebase also ingests MQTT/Sparkplug natively, so
pointing its own collector at a pipeline's output namespace is an equally
valid integration.

> ℹ️ Timebase has no tag-listing API, so the Trends tag *search* is off for
> it — type the exact tag path instead. Querying works for all three
> backends.

## Where the data comes from

- **Pipelines** with a historian target — see [Pipelines and Models](Pipelines-and-Models).
- The **Recorder** capturing a topic filter straight into a historian.

## Reading it back — the Trends page

**Trends** charts what your historians stored, without leaving Manifold:

```mermaid
flowchart LR
    T[Trends page] -->|pick historian + tags| Q[query API]
    Q -->|InfluxDB| F[Flux aggregateWindow]
    Q -->|TimescaleDB| B[time_bucket average]
    F --> C[chart - up to 10 series]
    B --> C
```

- Pick a historian, search its stored tags, and chart **up to 10 series**
  over a time range (last hour to last month, or custom).
- Downsampling happens **in the database** — the range comes back as at most
  ~1000 averaged points per series, so a month of 1 Hz data charts instantly.
- The chart auto-refreshes every 30 s (paused while the tab is hidden).

> 💡 Trends is also how you verify a pipeline → historian route end to end:
> if the tag appears in the Trends tag search, it landed.

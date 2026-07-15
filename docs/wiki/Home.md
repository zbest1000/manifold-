# 🏭 Manifold

**One live map of your industrial data** — MQTT · Sparkplug B · OPC UA · CESMII SMIP · i3X, explored, unified, and shaped into a Unified Namespace.

[![CI](https://github.com/zbest1000/manifold/actions/workflows/ci.yml/badge.svg)](https://github.com/zbest1000/manifold/actions/workflows/ci.yml) [![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/zbest1000/manifold/blob/main/README.md#license) [![Node](https://img.shields.io/badge/node-%E2%89%A5%2020-brightgreen.svg)](https://nodejs.org)

![Live UNS topology](images/uns-topology.png)

> *The live ISA-95 topology — built entirely from observed traffic: values on leaves, message rates on branches, publishing edges animated.*

---

## 🚀 Start here

| | Guide | You will learn |
|---|---|---|
| 🏁 | **[Getting Started](Getting-Started)** | Install, run (source or Docker image), and connect your first broker in five minutes |
| 🔌 | **[Broker Setup](Broker-Setup)** | Intake QoS, transports and MQTT 5, shared subscriptions, the EMQX ACL recipe, admin APIs for consumer lineage |
| 🗄️ | **[Historians](Historians)** | InfluxDB, TimescaleDB, Timebase — store-and-forward in, Trends charts back out |
| 🔀 | **[Pipelines and Models](Pipelines-and-Models)** | Route, reshape, and contextualize the live stream |
| 🏷️ | **[Tags and Sparkplug](Tags-and-Sparkplug)** | Browse device tags, publish them into the UNS, run a Sparkplug primary host |
| 🛡️ | **[Operations](Operations)** | Auth and named tokens, audit, Prometheus, config as code, alerts |
| 🩺 | **[Troubleshooting](Troubleshooting)** | Symptom → cause → fix |

## 📐 How it fits together

```mermaid
flowchart LR
    SRC[Brokers, OPC UA,<br/>CESMII, i3X] --> M[Manifold server]
    M --> UI[Web UI<br/>graphs, UNS, Flows]
    M --> MCP[MCP server<br/>AI agents]
    M --> H[(Historians)]
    M --> PROM[Prometheus]
```

Deep design documentation lives in the repository:

- 📖 [README](https://github.com/zbest1000/manifold#readme) — overview and quick start
- 🏗️ [ARCHITECTURE.md](https://github.com/zbest1000/manifold/blob/main/ARCHITECTURE.md) — system design, hot path, API surface, testing
- 🐳 [DOCKER.md](https://github.com/zbest1000/manifold/blob/main/DOCKER.md) — one-command demo stack
- 📝 [CHANGELOG.md](https://github.com/zbest1000/manifold/blob/main/CHANGELOG.md) — release history

---

> ✏️ These pages are generated from [`docs/wiki/`](https://github.com/zbest1000/manifold/tree/main/docs/wiki) in the repository and published by CI. **Edit there, not here** — direct wiki edits are overwritten by the next sync.

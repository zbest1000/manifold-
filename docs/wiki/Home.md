# Manifold wiki

Operational guides for running Manifold: connecting sources, delivering to
historians, and operating the platform. Design documentation lives in the
repository itself:

- [README](https://github.com/zbest1000/manifold#readme) — overview and quick start
- [ARCHITECTURE.md](https://github.com/zbest1000/manifold/blob/main/ARCHITECTURE.md) — system design, hot path, API surface, testing
- [DOCKER.md](https://github.com/zbest1000/manifold/blob/main/DOCKER.md) — one-command demo stack

## Guides

| Page | Covers |
|---|---|
| [Getting Started](Getting-Started) | Install, run, first broker connection |
| [Broker Setup](Broker-Setup) | Intake QoS, EMQX ACL for wildcard subscriptions, admin APIs for Flows |
| [Historians](Historians) | InfluxDB, TimescaleDB, Timebase, TimeBase CE; store-and-forward and drop policy |
| [Pipelines and Models](Pipelines-and-Models) | Routes, transform reference, dry-run, loop protection, models |
| [Tags and Sparkplug](Tags-and-Sparkplug) | Tag browser, bindings, CSV import, the Sparkplug B publisher |
| [Operations](Operations) | Auth and roles, audit, Prometheus metrics, config as code, alerts |
| [Troubleshooting](Troubleshooting) | Symptoms, causes, fixes |

These pages are generated from [`docs/wiki/`](https://github.com/zbest1000/manifold/tree/main/docs/wiki)
in the repository — edit there, not here, or changes will be overwritten by
the next sync.

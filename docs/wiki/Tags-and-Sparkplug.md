# Tags and Sparkplug

## Tag browser

**Tags** unifies the sources Manifold already speaks:

- **OPC UA** — the address space of any connected server, browsed lazily.
- **Sparkplug** — the device registry (Group → Edge → Device → metrics)
  reconstructed from BIRTH certificates.
- **MQTT** — the observed topic trie.

Tick tags and use *Add to UNS*. MQTT selections compile into a pipeline route
(common prefix + repath); OPC UA and Sparkplug selections become bindings.

## Bindings

A binding publishes source tag values to a destination:

- **MQTT target** — a path template (`site/area/{name}`), raw value or TVQ
  envelope `{v, t, q}`, optional QoS/retain.
- **Sparkplug target** — a proper Sparkplug B device under a (broker, group,
  edge node) session.

Behavior:

- **Report by exception** — an absolute deadband suppresses numeric changes
  smaller than the band; non-numeric values publish on change only.
- **Quality** — OPC UA status codes map to Good 192 / Uncertain 64 / Bad 0
  and ride in envelope mode.
- **Read-only** — bindings never write toward a device. There is no write
  path in the engine.

## CSV import

Tag lists exported from Kepware/Ignition-style tools import directly:

```csv
nodeId,name
ns=2;s=Channel1.Device1.Temperature,Temperature
ns=2;s=Channel1.Device1.Pressure,Pressure
```

Rows land in the current selection and go through the same wizard.

## The Sparkplug B publisher

Bindings that target Sparkplug run on a dedicated MQTT session per
(broker, group, edge node) implementing the specification lifecycle:

- CONNECT with an NDEATH will carrying the session's `bdSeq`
- NBIRTH at seq 0 including the `Node Control/Rebirth` metric
- DBIRTH for each device before any DDATA
- seq numbering mod 256 across all node messages
- rebirth on NCMD `Node Control/Rebirth`
- DDEATH per device and NDEATH on shutdown, with the connection closed
  gracefully so both frames actually flush

Consumers that implement Sparkplug state management (Ignition, HiveMQ
extensions, Timebase collectors) treat Manifold's output as a first-class
edge node.

# Running Manifold with Docker

A one-command stack to try every feature locally — no external brokers or
servers required.

```bash
docker compose up --build
```

Then open **http://localhost:5000**.

The first build takes a few minutes (it builds the React client and installs
server dependencies). Subsequent starts are fast.

## What comes up

| Service | Image | Purpose | Host port |
|---|---|---|---|
| `app` | built from `docker/app/Dockerfile` | Manifold (server + built client) | `5000` |
| `mqtt` | `eclipse-mosquitto:2` | MQTT broker (anonymous) | `1883`, `9001` (ws) |
| `opcua` | `mcr.microsoft.com/iotedge/opc-plc` | Simulated OPC UA server | `50000` |
| `simulator` | built from `docker/simulator` | Publishes MQTT + Sparkplug B traffic | — |

## Pre-seeded demo data

The app is **pre-seeded** (via `docker/app/seed/profiles.json`) to auto-connect
on startup to:

- the MQTT broker at `mqtt:1883` (auto-subscribed to `#` and `$SYS/#`)
- the OPC UA server at `opc.tcp://opcua:50000`

The simulator continuously publishes a tree of plain JSON telemetry topics
(`factory/…`, `building/…`, `energy/…`) plus valid Sparkplug B
(`spBv1.0/Plant1/…`). So the moment the page loads you should see:

- **Topics** — a live topic node graph (try the 2D / 3D / WebGL renderers)
- **Flows** — producer → topic → consumer lineage
- **Sparkplug** — the Plant1 → Line1 → Robot1 device topology with resolved metrics
- **OPC UA** — browse the OPC-PLC address space, read and monitor nodes
- **MQTT Brokers** — the connected broker with live message/topic counts

## Connecting things manually

You can also add connections from the UI. Because the app runs inside the
compose network, use the **service names** as hosts:

- MQTT broker → host `mqtt`, port `1883`
- OPC UA → `opc.tcp://opcua:50000`

External tools on your host machine can use `localhost:1883` and
`opc.tcp://localhost:50000`.

## Auth

The stack runs **open** by default (fine for localhost). To require a token,
set `MANIFOLD_AUTH_TOKEN` on the `app` service in `docker-compose.yml`, then enter the
same token in the app's unlock screen.

## Common commands

```bash
docker compose up --build        # build + start (foreground)
docker compose up -d --build     # build + start (detached)
docker compose logs -f app       # tail the app logs
docker compose logs -f simulator # watch the data generator
docker compose down              # stop
docker compose down -v           # stop + wipe saved profiles (the app-data volume)
```

## Notes

- Saved connections persist in the `app-data` Docker volume. `down -v` clears
  them and the next start re-seeds the demo connections.
- The simulator re-sends Sparkplug BIRTH certificates on every (re)connect, so
  metric aliases always resolve.
- The Mosquitto config allows anonymous access — it is for local testing only,
  not for exposure to an untrusted network.

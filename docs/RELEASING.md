# Releasing Manifold

## Cutting a release

Releases are driven entirely by git tags. From a checkout of `main`:

```bash
git pull origin main
git tag -a v1.0.0 -m "Manifold 1.0.0"
git push origin v1.0.0
```

(Equivalently: GitHub → Releases → *Draft a new release* → create tag `v1.0.0`
on `main` → publish. Tags created through the Releases UI fire the same
workflow.)

Pushing a `v*` tag triggers `.github/workflows/release.yml`, which:

1. Builds the root `Dockerfile` (client bundled into the server image) and
   pushes `ghcr.io/<owner>/manifold` tagged `<version>`, `<major>.<minor>`,
   and `latest` (linux/amd64).
2. Creates a GitHub Release for the tag with generated notes and a link to
   [CHANGELOG.md](../CHANGELOG.md).

Before tagging: bump the `version` field in `package.json`,
`server/package.json`, `client/package.json`, and `mcp/package.json`, add a
CHANGELOG entry, and merge that to `main` first. (For v1.0.0 this is already
done.)

## Verification status

What's proven versus assumed, as of v1.0.0. CI's integration job runs the
server against **real** EMQX, InfluxDB, TimescaleDB, and Timebase
(`timebase/historian`) containers on every push — see
`server/test/services-int.test.js`.

### Proven in CI against real services

- MQTT intake, QoS-1 fallback, wildcard resolution (real EMQX over TCP).
- MQTT 5 over WebSocket: `ws://…:8083/mqtt`, `protocolVersion 5`, user
  properties surviving the broker round-trip into the topic store.
- InfluxDB: line-protocol writes **and** the Trends read-back path
  (`queryTags` + `querySeries` — the exact functions the UI calls).
- TimescaleDB: batch inserts into a real hypertable and `time_bucket`
  read-back.
- Timebase: TVQ writes to `POST /api/datasets/{dataset}/data` (datasets
  auto-create) and `querySeries` read-back — including a window-before-writes
  emptiness check, so the `start`/`end` query parameters are proven honored,
  not assumed.
- Sparkplug host STATE lifecycle including retained-will delivery on abrupt
  death (real in-process broker).
- OPC UA PKI plumbing: application-certificate generation, trust-store
  listing, and rejected→trusted moves against a real `pki/` folder.

### Still assumed — verify when you have the environment

- **The release pipeline itself.** `release.yml` and the Dockerfile have never
  executed end-to-end (the dev environment had no Docker daemon and no
  tag-push permission). The first `v1.0.0` tag is the real test. If the image
  build fails, start with the `npm ci` steps and the `/app/server` +
  `/app/client/dist` layout.
- **OPC UA Sign/SignAndEncrypt against a real server.** Certificate and trust
  file handling is tested; an actual secure handshake is not (CI has no OPC UA
  server). Try against a real endpoint: *Discover* → pick a secure endpoint →
  connect with *Trust server certificate on first connect*. Known trade-off:
  the trust-on-first-connect flag is per-manager in node-opcua, so a
  concurrent secure connect during that window would also be auto-accepted.
- **WebSocket path defaults.** `wsPath` defaults to `/mqtt` (EMQX/HiveMQ
  convention). Mosquitto's websocket listener uses no path — set `wsPath`
  accordingly per broker.
- **Timebase authentication.** The CI container runs unauthenticated (the
  product's default). The `apiKey` → `Authorization: Bearer` mapping for
  token-fronted deployments follows the vendor docs but has not been exercised
  against a secured instance.
- **Shared subscriptions under load.** `$share/<group>/<filter>` intake is
  proven to subscribe correctly; actual load-balancing behavior across
  multiple Manifold instances hasn't been observed.

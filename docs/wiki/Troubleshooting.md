# Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Broker shows *connected* but no topics appear (EMQX) | Stock EMQX silently denies `#` at QoS 1+ (default ACL, `deny_action=ignore`) — the SUBACK succeeds but the subscription doesn't exist | Allow the intake user in the broker ACL, or set the broker's *Subscribe QoS* to 0 in Manifold. See [Broker Setup](Broker-Setup) |
| `subscription-downgraded` events in the log | The broker refused the wildcard grant loudly (SUBACK 0x80); Manifold fell back to QoS 0 | Expected behavior. Grant QoS 1 in the broker ACL if you want durable intake |
| Historian card shows spill bytes growing | The historian is unreachable or rejecting writes; points are spilling to disk | Check `lastError` on the card, fix connectivity/auth, spill drains oldest-first automatically. At the cap, the drop policy applies |
| TimescaleDB writes error with a timeout | Database unreachable — connections have bounded timeouts by design | Fix connectivity; queued points spill and recover. A hang instead of an error would mean an outdated build |
| Flows → Consumers is empty | No broker admin API configured, or the broker is mosquitto (no per-client subscription API) | Configure EMQX/HiveMQ admin credentials on the broker; for mosquitto this data does not exist |
| Influx rejects writes with a field type conflict | Data written by other tools created the field with a different type in the current shard | Manifold's own writes split `value=` (numeric) and `raw=` (string) and cannot cause this; check other writers to the bucket, or use a fresh bucket |
| UNS staleness marks a slow topic *dead* | The topic publishes rarely and hasn't established its cadence yet | Staleness is calibrated per topic (EMA of inter-arrival gaps); after a few publishes the thresholds adapt |
| Sparkplug devices show offline after a broker restart | Edge nodes haven't re-birthed | Per specification, state comes from BIRTH certificates; ask the edge node for a rebirth (NCMD) or wait for its reconnect BIRTH |
| Server tests fail with "Unable to deserialize cloned data" | Running files through `node --test`'s child-process IPC, which corrupts intermittently | Use `npm test` (the serial in-process runner). This affects the test harness only, never the server |
| UI shows the unlock screen unexpectedly | `MANIFOLD_AUTH_TOKEN` is set on the server | Enter the token; it is remembered locally. Viewer tokens get read-only access |

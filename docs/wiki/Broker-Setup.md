# Broker setup

## Intake QoS

Manifold subscribes to `#` at **QoS 1** by default so the broker retransmits
messages that were not acknowledged. This is configurable per broker
(Brokers → connection form → *Subscribe QoS*). `$SYS/#` always uses QoS 0.

If a broker refuses the wildcard grant (SUBACK 0x80), Manifold emits a
`subscription-downgraded` event and retries the same filter at QoS 0.

## EMQX: allow wildcard subscriptions at QoS 1

Stock EMQX ships a file ACL that denies `#` and `$SYS/#` subscriptions at
QoS 1+ from non-localhost clients — and because the default
`authorization.deny_action` is `ignore`, the denial is **silent**: the
subscribe appears to succeed and simply delivers nothing.

Give the Manifold user an explicit allow rule ahead of the stock deny in
`etc/acl.conf`:

```erlang
%% Manifold intake — allow wildcard subscription at any QoS
{allow, {username, "manifold"}, subscribe, ["#", "$SYS/#"]}.

%% stock rules follow
{allow, {ipaddr, "127.0.0.1"}, all, ["$SYS/#", "#"]}.
{deny, all, subscribe, ["$SYS/#", {eq, "#"}]}.
{allow, all}.
```

For throwaway containers (CI, local testing) you can clear authorization
entirely instead:

```yaml
environment:
  EMQX_AUTHORIZATION__NO_MATCH: allow
  EMQX_AUTHORIZATION__SOURCES: '[]'
```

Do not do that on a shared broker — scope the allow rule to the intake user.

Alternatively, set the broker's *Subscribe QoS* to 0 in Manifold and accept
fire-and-forget intake.

## Mosquitto

Wildcard subscriptions work at any QoS out of the box. Mosquitto has no admin
API that lists live per-client subscriptions (`mosquitto_ctrl` manages
accounts and ACLs), so the Flows → Consumers view is limited to
observed-traffic resolution there.

## Admin APIs for Flows (consumers view)

Per-client subscription data comes from a broker admin API, configured per
broker under Brokers → *Admin API*:

| Broker | API | Notes |
|---|---|---|
| EMQX v5 | REST, API key + secret | also provides per-client traffic counters, which Manifold diffs into live msg/s per client |
| HiveMQ Enterprise | REST | subscriptions per client |

Keys are stored server-side and never echoed back by the API.

## TLS

Use the `mqtts` protocol in the connection form. Self-signed brokers:
disable *Reject unauthorized* in the form (the setting maps to
`rejectUnauthorized`).

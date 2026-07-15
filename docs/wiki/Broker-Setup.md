# 🔌 Broker setup

> **Goal:** durable intake from any broker, plus the extras — consumer
> lineage and per-client rates — that need a broker admin API.

## Intake QoS — what it means and why it matters

Manifold subscribes to `#` at **QoS 1** by default: if the connection hiccups,
the broker retransmits anything Manifold didn't acknowledge, so pipelines and
historians don't silently lose samples. It's configurable per broker
(connection form → *Subscribe QoS*). `$SYS/#` always uses QoS 0 — losing one
diagnostics sample is meaningless.

When a broker **refuses** the wildcard grant, Manifold reacts instead of going
quiet:

```mermaid
sequenceDiagram
    participant M as Manifold
    participant B as Broker

    M->>B: SUBSCRIBE # at QoS 1
    B-->>M: SUBACK 0x80 (refused)
    Note over M: emits subscription-downgraded
    M->>B: SUBSCRIBE # at QoS 0
    B-->>M: granted - intake flows at QoS 0
```

## ⚠️ EMQX: the silent deny

Stock EMQX ships an ACL that denies `#` and `$SYS/#` subscriptions at QoS 1+
from non-localhost clients — and because its default
`authorization.deny_action` is `ignore`, the denial is **invisible**: the
SUBACK reports success, the subscription simply never exists, and no client
in the world can detect it. The symptom is a connected broker with an empty
topic tree.

**Fix — allow the intake user in `etc/acl.conf`** (the allow rule must come
before the stock deny):

```erlang
%% Manifold intake — allow wildcard subscription at any QoS
{allow, {username, "manifold"}, subscribe, ["#", "$SYS/#"]}.

%% stock rules follow
{allow, {ipaddr, "127.0.0.1"}, all, ["$SYS/#", "#"]}.
{deny, all, subscribe, ["$SYS/#", {eq, "#"}]}.
{allow, all}.
```

<details>
<summary>Throwaway containers (CI, local testing) — clear authorization entirely</summary>

```yaml
environment:
  EMQX_AUTHORIZATION__NO_MATCH: allow
  EMQX_AUTHORIZATION__SOURCES: '[]'
```

Never do this on a shared broker — scope the allow rule to the intake user
instead.

</details>

Alternatively set the broker's *Subscribe QoS* to **0** in Manifold and accept
fire-and-forget intake.

## Mosquitto

Wildcard subscriptions work at any QoS out of the box — nothing to configure.
One honest limitation: Mosquitto has **no admin API** that lists live
per-client subscriptions (`mosquitto_ctrl` manages accounts and ACLs), so the
Flows → Consumers view falls back to observed-traffic resolution there.

## Admin APIs — unlocking consumer lineage

The Flows page answers *"who receives what?"* by fetching per-client
subscriptions from the broker's admin API and resolving every wildcard filter
against the topics actually observed:

```mermaid
flowchart LR
    A[Broker admin API<br/>per-client subscriptions] --> R[Wildcard resolution<br/>against observed topics]
    R --> C[Exact match counts,<br/>concrete topics per client]
    R --> D[Dormant filters flagged<br/>dead wiring found]
```

Configure under **Brokers → Admin API**:

| Broker | API | Extras |
|---|---|---|
| EMQX v5 | REST, API key + secret | cumulative per-client counters, diffed into live msg/s per client |
| HiveMQ Enterprise | REST | per-client subscriptions |

Keys are stored server-side only and never echoed back.

## Transports, TLS, and MQTT 5

The connection form takes four transports:

| Protocol | Transport | Notes |
|---|---|---|
| `mqtt` | plain TCP | default, port 1883 |
| `mqtts` | TLS | for self-signed broker certificates, disable *Reject unauthorized* |
| `ws` | WebSocket | set the **path** — there is no universal default (Mosquitto `9001`, EMQX `8083/mqtt`, proxies `443`); Manifold defaults to `/mqtt` |
| `wss` | WebSocket over TLS | same path rule |

**MQTT 5** is opt-in per broker. On a v5 session, user properties, content
type, response topic, and correlation data show up on inbound messages, and
user properties / content type / response topic can be set when publishing.
On v4 sessions these properties are dropped rather than sent (the protocol
has nowhere to put them).

## Intake filter and shared subscriptions

The auto-subscribe filter defaults to `#` but is configurable per broker —
scope intake to a namespace (`plant7/#`) or use a **shared subscription**:

```
$share/manifold/#
```

Messages still arrive on their real topics, so everything downstream (UNS,
pipelines, historians) works unchanged — but the broker load-balances the
stream across every member of the `manifold` share group. That's the knob for
splitting intake across multiple Manifold instances on a very busy broker.

> ⚠️ A shared subscription means *this instance sees only its share* — don't
> use one on the instance that is supposed to render the complete UNS.

Broker connections **edit in place**: change the host, transport, version, or
intake filter on the broker card and Manifold reconnects with the new
settings — no delete/re-add, no lost history.

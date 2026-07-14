# Pipelines and models

## Routes

A route is: source broker + topic filter → ordered transform chain → target
(broker publish or historian). Configure under **Pipelines → Routes**.

Always use **Preview** before enabling: it resolves the filter against the
topics actually observed on the broker and shows the in→out topic/payload
mapping without publishing anything.

## Transform reference

| Transform | Effect |
|---|---|
| `repath` | Rewrite the topic using segment templates: `{1}`…`{n}` = 1-based source segment, `{n-}` = segments n..end joined, `{topic}` = whole source topic. Example: `uns/{2}/{4-}` |
| `pick` | Keep only the listed payload fields |
| `rename` | Rename payload fields by map |
| `set` | Merge fixed values into the payload (a scalar payload becomes `{ value, ...set }`) |
| `scale` | `value * mul + add`, on the whole payload or one field — unit conversion |
| `numeric` | Coerce to number; non-numeric messages are **dropped** (filter semantics) |
| `sparkplugFlatten` | Flatten decoded Sparkplug metrics to `{ name: value }`; metrics with `is_null` become explicit `null` |
| `envelope` | Wrap as TVQ: `{ v, t, q }` with source timestamp and quality |

## Loop protection

Two layers, both counted per route and shown in the UI:

1. **Static** — output matching the route's own source filter is blocked.
2. **Hop count** — every published (broker, topic) is remembered for 10 s; a
   message crossing more than 4 pipeline hops is blocked. This catches
   indirect A→B→A cycles across routes and brokers that repath templates hide
   from static analysis.

## Historian targets

Select a configured historian as the target; delivery goes through the
store-and-forward outbox (see [Historians](Historians)). The route's payload
after transforms becomes the sample value; quality rides along.

## Models

A model merges attributes from many topics into one object published at a
clean UNS path. Each attribute picks a broker, a topic, and optionally a
payload field. Publish on change (debounced) or on a fixed interval. In
envelope mode each attribute carries `{v, t, q}` with staleness-derived
quality (good 192 / uncertain 64 / bad 0), so consumers can tell a live zero
from a dead sensor.

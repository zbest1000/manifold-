# UI Backlog

Running list of UI/UX issues discovered during the overhaul, with evidence and
proposed fixes. Ordered roughly by impact. Checked items are done; the commit or
PR that closed them is noted inline.

## Open

### Medium


- [~] **Modal portal consistency.** A shared portaled `Modal` primitive now
  exists (`components/ui.jsx`) — it renders through `document.body` (escaping any
  `backdrop-blur` ancestor Card, which becomes the containing block for
  `position:fixed` and otherwise traps the modal under its neighbours) and owns
  Esc + backdrop-close. `HelpButton` migrated. **Still to migrate:**
  `components/UnsIconPicker.jsx`, `components/ErrorLog.jsx`, and the two modals in
  `pages/TopicGraph.jsx` (`HistoryChartModal`, expanded `TopicPanel`). None are
  currently *visibly* broken (their ancestors aren't blur-Cards today), so this
  is preventive — migrate them to the primitive as they're touched.

### Low

- [ ] **Accessibility: muted labels fail WCAG AA contrast.** A Lighthouse audit
  of the app (Accessibility 95, Best Practices 100) flagged 35 elements below the
  4.5:1 contrast minimum — worst is `text-slate-600` (#475569) at **2.44** on the
  `#0d1323` background (small uppercase section labels), plus `text-slate-500`
  (#64748b) at 3.88 (muted mono captions). These are deliberate muted tones, so
  bumping them app-wide is a design call (slate-600 → slate-400 clears AA but
  makes the subtle labels noticeably louder). Worth a considered pass on the muted
  palette rather than a blind global replace. (The `label-content-name-mismatch`
  finding — the Logs button's aria-label not containing its visible "Logs" text —
  was fixed, see Done.)

- [ ] **Demo-config gaps found in a full-UI sweep (not UI bugs; pages render
  fine).** Discovery, CESMII, System/Health, and Settings were all real-click /
  interaction tested and work. Observations worth a demo pass: (a) [fixed — see
  the Discovery OPC UA port item under Done]
  (b) **CESMII isn't auto-connected** to its bundled mock (`cesmii-mock:4000`)
  the way i3X is, so the page opens on an empty connect form; there's a real design
  tension (JWT creds are intentionally not stored on disk), but the demo could at
  least pre-fill the mock GraphQL endpoint. (c) **Historian outbox is spilling**
  (System shows Written 0 / Spilled ~18 MB and climbing) — but this is NOT a
  demo-seed bug: the seed only defines the file-based `demo-historian`, no
  Timescale route. The spilling "Demo Timescale" route is stale *runtime* state in
  this instance's `/data` volume from a prior TimescaleDB experiment; a fresh demo
  has no such route. If unwanted, delete the "Demo Timescale" route/historian in
  the running instance (kept as-is here since it's persisted state I didn't clearly
  create). (d) Corroborates the built-in-historian-full item above
  (System shows "Recorder · Built-in historian: 0 points").

- [x] **System sparklines were blank until 2 samples landed.** `Sparkline`
  returned an empty div when it had `< 2` numeric samples (right after a restart,
  or for a metric that hasn't ticked), so a stat tile read as broken on first
  paint. Now renders a faint 1-px baseline (`withAlpha(color, 0.2)`) instead.
  Verified live on the System page. (`components/charts.jsx`.)

- [ ] **Replay scrubber tick marks.** The scrubber is now a real, self-explanatory
  seek control (title + scope, oldest→now track, relative readout, "Replaying"
  indicator, arrow keys, speed selector, role=slider); remaining polish is
  optional density tick marks on the track.

- [ ] **Replay pulses vs live Flow are visually identical.** Both go through the
  same `emitPulse` in `ForceGraph.jsx` (replay just passes `force=true`), so a
  replayed burst flashes nodes exactly like live traffic. The new "Replaying"
  indicator in the scrubber attributes it at the widget level, but the graph
  pulses themselves aren't distinguished. Optional: give replay pulses a distinct
  tint (e.g. accent-2) by threading a style flag through `pulseNode`/`emitPulse`.

- [ ] **Replay only covers one broker in multi-broker mode.** `liveMsgs` is
  buffered per `brokerId` (the first active broker), so with several brokers
  selected the scrubber replays only the first one's traffic. `replayNodeId` is
  now broker-aware, but the buffer feeding it isn't merged. Low priority (replay
  is a single-broker inspection aid); revisit if multi-broker replay is wanted.

- [ ] **Density/spacing audit tail.** Original QA flagged general density on
  UNS/Flows; revisit tile paddings and small-screen breakpoints once the bigger
  items land.

## Done (recent)

- [x] **Accessibility: Logs button's accessible name didn't match its visible
  text.** Lighthouse `label-content-name-mismatch`: the expanded Logs button
  shows "Logs" but its `aria-label` was "View the event log (…)", so the
  accessible name didn't contain "Logs" — voice-control users saying "click Logs"
  couldn't target it. Prefixed the aria-label with "Logs — …". (`components/ErrorLog.jsx`.)
- [x] **Discovery couldn't find OPC UA servers on port 50000 (opc-plc).**
  `DEFAULT_OPCUA_PORTS` was `[4840]` only, so network discovery silently missed
  any OPC UA server on the well-known opc-plc port 50000 — including the demo's own
  (`opc.tcp://opcua:50000`), so a scan surfaced the MQTT brokers and i3X mock but
  no OPC UA. Added 50000 to the default OPC UA scan ports. Verified live: a scan
  now returns the OPC UA endpoints on :50000 (labeled "OPCUA · open port", since
  full OPC UA verification happens on connect). (`server/services/discovery.js`.)
- [x] **UNS over-zoom: OPC-UA / i3X mounts defaulted fully-expanded.** With the
  demo OPC-PLC mount grafted in, the topology's initial seed expanded every root's
  level-1 children — for a mount that meant Objects/Types/Views → ~30 grandchildren
  (Alarm, Boiler, DeviceSet, ObjectTypes, …), which dominated the forest and
  shrank the MQTT broker trees (the thing you usually want) to an unreadable
  sliver. Fixed the seed in `UnsTopology.jsx`: mount roots (`brokerId` starts with
  `mount:`) open only to their root, showing their level-1 children collapsed;
  broker namespaces still open to level 1. Verified live: the OPC-PLC mount now
  shows just Objects/Types/Views collapsed and the broker trees are large and
  legible. Closes both the "over-zoom" and "mounts fully-expanded" backlog items.
  (`graph/UnsTopology.jsx`.)
- [x] **Built-in historian stopped at its file cap, breaking the demo's Trends
  (server-side rollover).** The recorder appended to a JSONL and, at 50 MB, set
  `full = true` and stopped forever — so on a long-running demo, Trends' default
  source ("Recording → Built-in historian") returned no recent data (the file was
  full of stale data). Replaced stop-at-cap with a **two-segment ring buffer**:
  when the current segment fills (cap/2), rotate it to a `.1` previous segment and
  start fresh; `_records` reads previous+current so reads still yield
  oldest→newest, bounded to ~cap total, recording never stops. Updated the
  existing "stops at cap" test to a rollover test; `remove()` now cleans up the
  `.1` segment too. Verified: 5 recorder+replayer unit tests pass, and live on the
  demo — after deploy the stuck `demo-historian` rolled its 50 MB file to `.1`,
  resumed recording (20k points, `full: false`), the series query returned recent
  points, and the Trends chart renders again. (`server/services/recorder.js`,
  `server/test/dataops.test.js`.)
- [x] **Trends showed a misleading empty state for an empty/stopped recording.**
  Found while sweeping pages. With a source (a recording) and a tag both selected,
  but the recorder returning `{series: []}` (e.g. the built-in historian was full/
  stopped, or the data is all outside the range), `TrendChart` computed
  `state==='empty'` (keyed only on `series.length === 0`) and showed *"Pick a
  source and add tags to trend"* — as if nothing were selected. Now `Trends.jsx`
  synthesizes empty-point series for the requested tags when the source returns
  none, so the chart shows the correct *"No samples for these tags in this time
  range."* Verified live. (`pages/Trends.jsx`.)
- [x] **Tags copy: "will announces offline" → "with a Last Will that announces
  offline."** Grammar fix on the Primary Host State explainer. (`pages/Tags.jsx`.)
- [x] **Flows "click a device for its metrics" never showed the card (stacked
  bug).** Found while broad-testing other pages after the property-pane work. The
  Flows Producers/Consumers device trees use the same `ForceGraph`, but wired
  selection wrong: `onSelect={setSelected}` stored the node *object*, while the
  lookup `graph.nodes.find((n) => n.id === selected)` and `selectedId={selected}`
  both expect an *id string* — so `selectedNode` was always null and the metrics
  card never rendered. This was masked until now because the d3-drag capture bug
  meant `onSelect` never fired at all (clicking a device did nothing); fixing
  d3-drag exposed the object/id mismatch. Fixed both `ProducerFlows.jsx` and
  `ConsumerFlows.jsx` to `onSelect={(n) => setSelected(n.id)}`. Verified live:
  dispatching `selected = <edge-node id>` renders the endpoint-detail card with
  full metrics (Messages 12,570, 3 metrics, last seen); a group id renders the
  card header. (The combined live *click* couldn't be pinned under the cursor
  because Flows uses `layoutId="radial"`, whose layout overrides `fx/fy`; the
  ForceGraph click path itself is verified on Topics/i3X/OPC UA.) Other
  ForceGraph consumers (Topics, i3X, OPC UA, UNS) already used the object pattern
  correctly (`selectedId={selected?.id}`), so only Flows was affected.


- [x] **Graph overhaul (2D + 3D).** A large batch driven by user reports:
  - Properties click bug (first attempt, incomplete): moved the selection
    pointerup/pointermove to `window`. This addressed d3-*zoom* but NOT d3-*drag*,
    which was the real swallower — see the dedicated entry below for the actual
    fix.
  - Search-to-select: the graph search now has a clickable results dropdown that
    selects a node and opens its properties — reliable in a dense graph.
  - Legend fix: `groupColor` collided groups to the same colour via
    `palette[idx % len]`; replaced with a fixed semantic `GROUP_COLORS` map.
  - 3D: density-controlled node names, a Values line, node-shape modes (cube/
    diamond/…), and a Flow toggle (nodes flash on message activity).
  - Multi-broker: a multi-select broker picker (one / several / all) with a
    merged graph, plus two new demo broker instances (North/South distinct data).
  - Beautify (2D): a real visual mode — node bloom + glowing links on the radial
    layout, not just a layout switch.
  - Replay redesign: reframed the scrubber so it explains itself (title + scope
    "last N msgs · Xs", relative "-6.4s → now" readout, oldest→now track labels,
    a "Replaying" indicator while active) instead of an unlabelled media widget
    with a meaningless absolute clock. See the dedicated entry below.
  - 3D Activity: size nodes by live message rate in the 3D view (mirrors the 2D
    Activity toggle) — active nodes swell up to 2.2x and relax back. See the
    dedicated entry below.
  - The graph-overhaul batch (all of the user's explicit graph asks) is now
    complete.
- [x] **Property pane didn't open on canvas click (real root cause).** User
  reported the property pane "still does not work" after the earlier window-listener
  attempt. Reproduced with a *real* CDP mouse click (not a synthetic event, which
  wouldn't expose it) and traced it: `ForceGraph`'s d3-drag has a `.subject()` that
  returns the node under the cursor for any graph below the big-mode threshold
  (`nodes.length > 4000`) — i.e. essentially every graph (Topics, i3X, collapsed
  views). Once d3-drag's subject is a node, d3-drag owns the pointer for that
  gesture and suppresses the native pointer events, so the window `pointerup` never
  fired `onUp`/`onSelect`. The drag `end` handler only pinned the node — it never
  selected. No external listener can recover an event d3-drag owns, so selection
  had to move *into* the gesture: the drag `end` handler now treats a press that
  barely moved (≤5px) as a click and calls `onSelect(subject)`, opening the panel.
  Verified with real mouse clicks on the running demo: clicking a Topics node
  opened its panel (`spBv1.0/Plant1/NBIRTH/Line1`), and an i3X node opened its
  panel (`Compressed Air / utilities.air`); Properties button enabled in both.
  Big-mode graphs (>4000 nodes) still select via the window `onUp` path (subject
  returns null there, so d3-drag doesn't capture). (`graph/ForceGraph.jsx`.)
  - Follow-up verification pass (real CDP clicks, one node pinned under the click
    point on each surface): the property/detail pane opens on **Topics 2D**
    (ForceGraph+d3-drag, the fixed path), **i3X 2D** (ForceGraph), **Topics 3D**
    (three.js raycast — camera rotated to align a node to the click point), and
    **UNS** (custom canvas with window `pointerup`, no d3-drag — had to hard-pin
    the node in `manualRef` first because the live 300+/s topology re-lays out and
    drifts nodes out from under the click), and **OPC UA** (same `ForceGraph`;
    notably it has *no* Properties button, so click is the only inspect path — the
    pane opened with the node's OPC UA attributes). No other selection path was
    broken; d3-drag was the sole defect.
  - Also verified with real clicks: the **Properties button** reopen flow
    (select → close pane → button stays enabled → click reopens) and **no console
    errors** on any interaction. Across five renderers + the button flow the pane
    is confirmed working; the reported failure is not reproducible in any view.
    Most likely remaining explanations for a user still seeing it broken: a cached
    pre-fix `index.html` (hard refresh) or a container recreated from the old image
    before the rebuild (now baked in). A concrete repro (page + exact action +
    observed result) would be needed to investigate further.
  - Durable deploy: earlier fixes were hot-copied into the running container
    (`docker cp client/dist → manifold-app`), which is **ephemeral** — a
    `docker compose up` (without `--build`) recreates the container from the old
    image and silently reverts the fix, which likely explains the "still doesn't
    work" reports across sessions. Rebuilt the image (`docker compose build app`)
    so the committed fix is baked in, recreated the container, and re-verified the
    pane opens on a real click. Also cleaned up accumulated stale `index-*.js`
    bundles (docker cp adds but never removes, so a browser holding an old
    `index.html` could load pre-fix code — a hard refresh clears it).
- [x] **3D Activity sizing (size nodes by message rate).** The 2D graph had an
  Activity toggle that swells nodes by their live message rate; the 3D view had
  Flow (colour pulse) but no size equivalent. Added an Activity toggle to the
  shared `Graph3DControls` and the rate model to `ForceGraph3D`: a `rateRef`
  (nodeId→rate) bumped per message, decayed per frame, applied as a per-instance
  scale on the `InstancedMesh` (base radius × up to 2.2x at saturation), relaxing
  to base as it decays — the size analogue of the Flow colour pulse, sharing the
  same activity bus subscription. Kept the on-demand render loop alive via a new
  `activitySizeRef` (mirroring Flow's `flowRef`) so it animates continuously while
  on. Verified against the live demo by reading the three.js instance matrices
  directly: 51 nodes swollen to the exact 2.2x ceiling under traffic, relaxing to
  base (41→10 swollen) once toggled off. Note: the headless verification browser
  doesn't fire requestAnimationFrame without a forced paint, so motion was
  sampled by forcing frames + reading matrix state, not by watching it move.
  (`graph/ForceGraph3D.jsx`, `components/Graph3DControls.jsx`, `pages/TopicGraph.jsx`.)
- [x] **Replay "doesn't make sense" (redesign).** The scrubber worked mechanically
  (seek/speed/keyboard) but read as an unlabelled media widget floating over the
  graph: no title, no scope, and an absolute wall-clock readout (`14:32:07`) with
  no reference point — plus its node-flashes were indistinguishable from live
  Flow. Reframed it as a self-explanatory panel: a `History`-icon title, a scope
  line ("last N msgs · Xs"), the track labelled oldest→now, a *relative* readout
  ("-27s" counting up to "now"), a disabled "waiting for buffered messages…"
  state, and a pulsing "Replaying" chip while active so the graph flashes are
  attributable. Also made `replayNodeId` broker-aware. Verified live: play →
  "Replaying" chip appears, playhead advances 0→34% (−27.0s→−18.0s). Two
  follow-ups filed under Low (distinct replay pulse tint; multi-broker buffer).
  (`components/ReplayScrubber.jsx`, `pages/TopicGraph.jsx`.)
- [x] System health tile grid didn't scale: the Broker-ingest and Recorder
  sections rendered one tile per broker/recording in a flat grid with no cap,
  collapse, or filter, and the fixed process metrics scrolled away. Added a
  ScalableSection with a count badge, a collapse toggle, and a filter past ~12
  items; pinned the Process-health section (sticky). (`pages/System.jsx`.)
- [x] Discovery "Connect" was fire-and-forget — a "Connecting…" toast with no
  outcome. The button now reports state inline: Connecting… → Connected (MQTT
  verified against the live broker status) or Failed + Retry with the error.
  Still open: pre-fill a connect form when a source needs credentials, instead
  of an anonymous attempt. (`pages/Discovery.jsx`.)
- [x] CESMII time-series start/end were free-text fields in exact SMIP format, so
  any typo gave an empty chart. Replaced with datetime-local pickers plus Last
  1h/24h/7d/30d presets and a max-samples field; the local values convert to the
  SMIP UTC form on query. Verified end-to-end against the mock (preset → reload →
  chart renders). (`pages/Cesmii.jsx`.)
- [x] Pipelines transform editor fought the user mid-type: the set / rename /
  pick inputs derived their value from the parsed model every render, so a
  half-typed value (`{"site":`) was rejected and reverted on each keystroke,
  jumping the cursor. Added a `StructuredInput` that buffers raw text, commits
  when it parses, flags invalid JSON with a red border, and reformats (or
  reverts to the last good value) on blur. (`pages/Pipelines.jsx`.)
- [x] The graph tree layout fanned out into a wide, flat horizontal line at the
  leaves. Rewrote it as an indented tree that grows top-to-bottom (one row per
  node, depth = indent, file-explorer style) with a tree-aware fit (width-driven,
  top-anchored). Reverted the earlier auto-collapse — all nodes expand by
  default. Added collapse/expand level controls (collapse to top, expand to
  2/3/4, expand all) to the shared toolbar; collapse/expand re-frames the view.
  Applied to i3X too (collapse state + controls + top-to-bottom tree, matching
  Topics). Verified live on both pages.
- [x] The replay scrubber (Topics) couldn't be scrubbed: the bar was display
  only, duration was hardcoded, no speed/time readout, no keyboard path. Rebuilt
  it as a real seek control (click/drag, arrow-key nudge, Home/End, 0.5x/1x/2x
  speed, replayed-clock readout) with role=slider + aria attributes and a visible
  focus ring. (`components/ReplayScrubber.jsx`.)
- [x] Big brokers (1000+ nodes) rendered as an unreadable wall; in the tree
  layout a thousand leaves fit to a flat horizontal line so no node was
  clickable and the Properties button stayed disabled ("doesn't work"). Seed a
  collapsed view (top 2 levels) once per broker past 200 nodes, so Topics opens
  as a clean navigable tree like i3X, with +N badges (double-click to expand).
  Nodes are selectable again, so Properties works.
- [x] i3X canvas lacked the Topics feature set. Added Beautify to the 2D toolbar
  and the full 3D look-and-feel controls (Beautify, auto-rotate, size/link
  sliders, Properties, Reset view); extracted a shared `Graph3DControls`.
- [x] A shared Y axis flattened mixed-magnitude tags (temperature ~50 went flat
  next to speed ~1450). Added a Normalize toggle to Trends that rescales each
  series to its own 0-100% range so shapes compare directly; the legend keeps
  the real min-max. (`components/TrendChart.jsx`.)
- [x] Trends read empty out of the box and, worse, a file recording of the demo
  charted nothing because `recorder.series()` did `Number(objectPayload)` = NaN.
  Fixed the numeric extraction (handles `{value,unit}`), added a searchable
  captured-tags endpoint, seeded an always-on "Built-in historian" recording
  (`factory/#`), and defaulted Trends to it. Trends now has real persisted
  history on first load, no external DB. (Chose the existing JSONL recorder over
  a new SQLite native dep.)
- [x] Small object graphs (e.g. the i3X hierarchy) collapsed onto one horizontal
  line. Root cause: `treePositions` read `link.source/target` after d3's
  forceLink had mutated them from id strings to node objects, so every node
  looked parentless. Made it endpoint-agnostic and widened the tree gaps; small
  graphs now render as proper trees.
- [x] Right-click to open node properties was unreliable (OS/browser swallows the
  contextmenu). Replaced with a discoverable Properties button in the shared
  GraphToolbar and 3D controls (Topics, i3X, everywhere), tracking panelOpen so
  closing the panel no longer loses access. Extracted a shared GraphLegend used
  across views.
- [x] i3X and CESMII SMIP pages had no server to talk to locally, so they read as
  dead. Added two Docker mock servers (`docker/i3x-mock`, `docker/cesmii-mock`)
  wired into the demo compose stack; verified end-to-end (connect, catalog,
  hierarchy graph, and history chart all render live).
- [x] 3D graph had no look-and-feel controls or Beautify (2D had Beautify but 3D
  didn't). Added a 3D control cluster: Beautify (depth-graded colour ramp from the
  active palette + additive link glow + slow auto-rotate), an Auto-rotate toggle,
  and node-size / link-opacity sliders. Ref-driven so the on-demand render loop
  stays alive during rotation.
- [x] Right-clicking a graph node did nothing (browser context menu) — properties
  panel only opened on left-click. Wired `contextmenu` in all three renderers (2D
  canvas, 3D three.js, WebGL) to open the properties panel; also fixed WebGL
  click-vs-drag threshold to be HiDPI-aware.
- [x] No colour legend on the Topic graph, so group colours were unexplained.
  Added a collapsible legend (Broker / Branch / Data / Sparkplug…) to the 2D and
  3D views.
- [x] Destructive deletes (route, model, historian, recording, contract) fired
  with no confirmation. Wrapped all five in a confirm, warning about credential
  loss / data loss where relevant.
- [x] UNS "Mounts" panel only listed OPC UA / i3X, so MQTT and Sparkplug looked
  like they weren't UNS sources. Reworked into a "UNS sources" panel that shows
  Live sources (MQTT brokers, Sparkplug decoded within them) alongside Mounted
  sources (OPC UA, i3X), and explains how they connect (one namespace; bridge
  values with a Pipeline route or Tag binding).
- [x] Expanded in-app help with concrete examples and plainer wording (no
  em-dashes, no filler): richer Pipelines help; added help to UNS topology,
  Trends, and UNS sources; tightened Tags help.


- [x] Charts flashing / resetting every data tick — memoize uPlot options on a
  structural key so live data flows through `setData` (PR #43).
- [x] Health-metric popup see-through / trapped under cards — `createPortal`
  to `document.body` (PR #43).
- [x] Every chart migrated to uPlot (mature, lightweight; Grafana's engine),
  Recharts removed (~300KB off the bundle) (PR #42).
- [x] Health tiles → click to expand a full time chart (PR #42).
- [x] UNS moved nodes fighting their position — absolute pinning (PR #42).
- [x] UNS didn't center on load; lint findings now jump-to-node + explain (#41).
- [x] Sparklines rendered as filled blocks — domain padding + flat baseline (#41).
- [x] UNS multi-select + group move; Topics detail pane expandable (#41).

## How this list is maintained

Appended to during the UI-overhaul loop: each pass inspects a surface (live via
Chrome DevTools and/or by reading its component), records concrete,
evidence-backed issues here, and fixes the highest-value safe ones. Keep entries
specific — name the file, the symptom, and the proposed fix.

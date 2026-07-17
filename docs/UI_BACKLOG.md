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

- [ ] **UNS topology over-zooms when a deep mount is present.** With the demo
  OPC-UA mount (opc-plc, hundreds of nodes) grafted in, the "fit everything on
  load" framing shrinks the whole forest to unreadable (k clamps near the 0.2
  floor). The MQTT broker trees — the thing you usually want — become tiny.
  Options: (a) exclude/soft-weight deep mounts from the initial fit, (b) fit to
  the broker subtrees and let the user pan to mounts, or (c) collapse mounts to
  their root by default. Needs a design call.

- [ ] **OPC-UA / i3X mounts default fully-expanded in UNS.** Compounds the
  over-zoom above and makes the paper canvas very tall. Mounts probably want to
  seed collapsed (root only), unlike broker namespaces which seed to level 1.

### Low

- [ ] **System "Process health" sparklines are blank right after a restart.**
  Expected (needs ≥2 samples, ~6s) but reads as broken on first paint. Consider a
  1-px baseline placeholder until the first two samples land.

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
    drifts nodes out from under the click). No other selection path was broken;
    d3-drag was the sole defect. OPC UA uses the same `ForceGraph`, so it inherits
    the fix.
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

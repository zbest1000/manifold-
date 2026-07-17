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

- [ ] **Replay scrubber tick marks.** The scrubber is now a real seek control
  (drag/click to scrub, arrow keys, speed selector, clock readout, role=slider);
  remaining polish is optional density tick marks on the track.

- [ ] **Density/spacing audit tail.** Original QA flagged general density on
  UNS/Flows; revisit tile paddings and small-screen breakpoints once the bigger
  items land.

## Done (recent)

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

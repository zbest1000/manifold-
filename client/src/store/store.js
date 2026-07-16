import { create } from 'zustand';
import toast from 'react-hot-toast';
import { socket } from '@/lib/socket';
import { api } from '@/lib/api';
import { humanizeError } from '@/lib/humanizeError';
import { DEFAULT_STYLE, DEFAULT_LAYOUT } from '@/graph/graphStyles';

const MAX_LIVE_MESSAGES = 300;
const TICK_MS = 300; // how often high-frequency data changes surface to React (~3Hz)

// -----------------------------------------------------------------------------
// High-frequency message data lives OUTSIDE React state. At thousands of
// messages/sec, updating reactive state per message would re-render the whole UI
// on every message and drop the graph to single-digit FPS. Instead we keep the
// live buffers + topic index in plain module maps (mutated synchronously, no
// render), drive the flow animation through the activity bus, and only bump a
// low-frequency `dataTick` / per-broker `topicVersion` so views refresh at ~3Hz
// and structure changes rebuild the graph immediately.
// -----------------------------------------------------------------------------
const liveBuffers = new Map(); // brokerId -> msg[] (newest first)
const topicIndex = new Map(); // brokerId -> Map(topic -> { topic, messageCount, lastActivity, type, payload })

const activityListeners = new Set();
export function onMessageActivity(cb) {
  activityListeners.add(cb);
  return () => activityListeners.delete(cb);
}
function emitActivity(msg) {
  for (const cb of activityListeners) {
    try {
      cb(msg);
    } catch {
      // a bad listener must not break message ingestion
    }
  }
}

let tickScheduled = false;
let errorSeq = 0;

const DEFAULT_LOG_FILTERS = { error: true, warning: true, info: true, verbose: false };
function loadLogFilters() {
  try {
    const raw = localStorage.getItem('tc.logFilters');
    return raw ? { ...DEFAULT_LOG_FILTERS, ...JSON.parse(raw) } : { ...DEFAULT_LOG_FILTERS };
  } catch {
    return { ...DEFAULT_LOG_FILTERS };
  }
}
function saveLogFilters(f) {
  try {
    localStorage.setItem('tc.logFilters', JSON.stringify(f));
  } catch {
    // ignore persistence failures
  }
}
function brokerLabel(c) {
  if (!c) return 'broker';
  return c.name || `${c.host}:${c.port}`;
}

// Resolve a broker id (UUID) to a human-friendly label via the current broker
// list; falls back to a short id if the broker is already gone (e.g. disconnect).
function brokerName(brokerId) {
  const b = useStore.getState().brokers.find((x) => x.id === brokerId);
  if (b) return b.name || `${b.host}:${b.port}`;
  return brokerId ? `broker ${String(brokerId).slice(0, 8)}` : 'broker';
}

// Log a backend/network error as a human-readable summary (+ hint + short code),
// keeping the raw text as meta.raw, and surface it as a toast. Repeated identical
// errors (e.g. a down broker retrying) are always logged (coalesced), but the
// toast is throttled so it doesn't spam.
const lastToastAt = new Map();
function reportError(s, source, rawMessage, { prefix, ...meta } = {}) {
  const h = humanizeError(rawMessage);
  const summary = prefix ? `${prefix}: ${h.summary}` : h.summary;
  s.pushLog('error', source, summary, { ...meta, raw: rawMessage, code: h.code, hint: h.hint });
  const key = `${source}|${summary}`;
  const now = Date.now();
  if (now - (lastToastAt.get(key) || 0) > 20000) {
    lastToastAt.set(key, now);
    toast.error(summary);
  }
}
function scheduleTick(store) {
  if (tickScheduled) return;
  tickScheduled = true;
  setTimeout(() => {
    tickScheduled = false;
    store.setState((s) => ({ dataTick: s.dataTick + 1 }));
  }, TICK_MS);
}

export const useStore = create((set, get) => ({
  connected: false,
  brokers: [],
  opcua: [],
  discovery: { scanning: false, results: [], progress: null },

  // Reactive change signals for the high-frequency data (see note above).
  dataTick: 0,
  topicVersion: {}, // brokerId -> integer, bumped only when the topic SET changes

  opcuaValues: {}, // connectionId -> { nodeId: { value, ... } } (low frequency)

  // Graph view preferences (persisted to localStorage)
  graphStyle: localStorage.getItem('tc.graphStyle') || DEFAULT_STYLE,
  graphLayout: localStorage.getItem('tc.graphLayout') || DEFAULT_LAYOUT,
  flowEnabled: localStorage.getItem('tc.flowEnabled') !== 'false',
  activitySize: localStorage.getItem('tc.activitySize') === 'true',
  showValues: localStorage.getItem('tc.showValues') !== 'false',
  showMinimap: localStorage.getItem('tc.showMinimap') === 'true',

  // Cross-view coverage paint: set by the Flows view ("show on topic map"),
  // consumed by the Topics graph as matchIds. Session-only, not persisted.
  coverage: null, // { brokerId, matchIds: Set, label }
  setCoverage: (coverage) => set({ coverage }),

  setGraphStyle: (id) => {
    localStorage.setItem('tc.graphStyle', id);
    set({ graphStyle: id });
  },
  setGraphLayout: (id) => {
    localStorage.setItem('tc.graphLayout', id);
    set({ graphLayout: id });
  },
  setFlowEnabled: (v) => {
    localStorage.setItem('tc.flowEnabled', String(v));
    set({ flowEnabled: v });
  },
  setActivitySize: (v) => {
    localStorage.setItem('tc.activitySize', String(v));
    set({ activitySize: v });
  },
  setShowValues: (v) => {
    localStorage.setItem('tc.showValues', String(v));
    set({ showValues: v });
  },
  setShowMinimap: (v) => {
    localStorage.setItem('tc.showMinimap', String(v));
    set({ showMinimap: v });
  },

  setConnected: (connected) => set({ connected }),
  setBrokers: (brokers) => set({ brokers }),
  setOpcua: (opcua) => set({ opcua }),

  upsertBroker: (broker) =>
    set((s) => {
      const idx = s.brokers.findIndex((b) => b.id === broker.id);
      if (idx === -1) return { brokers: [...s.brokers, broker] };
      const next = [...s.brokers];
      next[idx] = { ...next[idx], ...broker };
      return { brokers: next };
    }),

  removeBroker: (brokerId) => {
    liveBuffers.delete(brokerId);
    topicIndex.delete(brokerId);
    set((s) => {
      const tv = { ...s.topicVersion };
      delete tv[brokerId];
      return { brokers: s.brokers.filter((b) => b.id !== brokerId), topicVersion: tv };
    });
  },

  // Non-reactive getters for the high-frequency data.
  getTopics: (brokerId) => Array.from(topicIndex.get(brokerId)?.values() || []),
  getLiveMessages: (brokerId) => liveBuffers.get(brokerId) || [],
  getTopicMessages: (brokerId, topic) => (liveBuffers.get(brokerId) || []).filter((m) => m.topic === topic),

  // Seed the topic index from an authoritative API fetch (bumps structure).
  setTopics: (brokerId, topics) => {
    const map = topicIndex.get(brokerId) || new Map();
    for (const t of topics) map.set(t.topic, { ...map.get(t.topic), ...t });
    topicIndex.set(brokerId, map);
    set((s) => ({ topicVersion: { ...s.topicVersion, [brokerId]: (s.topicVersion[brokerId] || 0) + 1 } }));
  },

  ingestMessage: (msg) => {
    emitActivity(msg);

    // Live buffer (newest first, capped)
    let buf = liveBuffers.get(msg.brokerId);
    if (!buf) {
      buf = [];
      liveBuffers.set(msg.brokerId, buf);
    }
    buf.unshift(msg);
    if (buf.length > MAX_LIVE_MESSAGES) buf.length = MAX_LIVE_MESSAGES;

    // Topic index (mutated in place — no React render)
    let map = topicIndex.get(msg.brokerId);
    if (!map) {
      map = new Map();
      topicIndex.set(msg.brokerId, map);
    }
    const existing = map.get(msg.topic);
    const isNewTopic = !existing;
    map.set(msg.topic, {
      topic: msg.topic,
      messageCount: (existing?.messageCount || 0) + 1,
      lastActivity: msg.timestamp,
      type: msg.type,
      payload: msg.payload,
      retain: msg.retain
    });

    // Only a NEW topic changes graph structure → bump version (rare). Value
    // changes just schedule the throttled tick.
    if (isNewTopic) {
      set((s) => ({ topicVersion: { ...s.topicVersion, [msg.brokerId]: (s.topicVersion[msg.brokerId] || 0) + 1 } }));
    }
    scheduleTick(useStore);
  },

  setOpcuaValue: (connectionId, nodeId, value) =>
    set((s) => ({
      opcuaValues: {
        ...s.opcuaValues,
        [connectionId]: { ...(s.opcuaValues[connectionId] || {}), [nodeId]: value }
      }
    })),

  setDiscovery: (patch) => set((s) => ({ discovery: { ...s.discovery, ...patch } })),
  addDiscoveryResult: (result) =>
    set((s) => ({
      discovery: {
        ...s.discovery,
        results: [...s.discovery.results.filter((r) => !(r.host === result.host && r.port === result.port)), result]
      }
    })),

  // Central LEVELED log (error / warning / info / verbose). Toasts are transient;
  // every notable event is recorded here so it can be reviewed and filtered by
  // level. Capped at 200, newest first.
  logs: [], // { id, ts, level, source, message, meta }
  unseen: 0, // unseen error+warning entries — drives the sidebar badge
  logFilters: loadLogFilters(), // { error, warning, info, verbose } — which levels are shown
  pushLog: (level, source, message, meta = {}) =>
    set((s) => {
      const msg = String(message ?? '');
      const top = s.logs[0];
      // Coalesce consecutive identical entries (a down broker emits the same error
      // every reconnect) so the log stays readable: bump a count and refresh the
      // timestamp instead of adding hundreds of duplicates. Badge doesn't re-bump.
      if (top && top.level === level && top.source === source && top.message === msg) {
        const merged = { ...top, ts: Date.now(), count: (top.count || 1) + 1, meta: { ...top.meta, ...meta } };
        return { logs: [merged, ...s.logs.slice(1)] };
      }
      return {
        logs: [
          { id: `log-${++errorSeq}`, ts: Date.now(), level, source, message: msg, meta, count: 1 },
          ...s.logs
        ].slice(0, 200),
        unseen: level === 'error' || level === 'warning' ? s.unseen + 1 : s.unseen
      };
    }),
  clearLogs: () => set({ logs: [], unseen: 0 }),
  logOpen: false,
  logBrokerFilter: null, // when set, the panel shows only this broker's entries
  openLog: (brokerId = null) => set({ logOpen: true, logBrokerFilter: brokerId ?? null, unseen: 0 }),
  closeLog: () => set({ logOpen: false, logBrokerFilter: null }),
  clearBrokerFilter: () => set({ logBrokerFilter: null }),
  toggleLogFilter: (level) =>
    set((s) => {
      const logFilters = { ...s.logFilters, [level]: !s.logFilters[level] };
      saveLogFilters(logFilters);
      return { logFilters };
    })
}));

let wired = false;
export function initRealtime() {
  if (wired) return;
  wired = true;
  const s = useStore.getState();

  socket.on('connect', () => useStore.getState().setConnected(true));
  socket.on('disconnect', () => useStore.getState().setConnected(false));

  // Throttle connect_error: socket.io retries every second while the server is
  // down, so log it at most once per 15s instead of flooding.
  let lastConnErr = 0;
  socket.on('connect_error', (err) => {
    const now = Date.now();
    if (now - lastConnErr < 15000) return;
    lastConnErr = now;
    const h = humanizeError(err?.message || 'Socket connection error');
    s.pushLog('warning', 'socket', h.summary, { raw: err?.message, code: h.code, hint: h.hint });
  });

  socket.on('state-snapshot', (snap) => {
    useStore.getState().setBrokers(snap.mqtt || []);
    useStore.getState().setOpcua(snap.opcua || []);
    if (snap.discovery) useStore.getState().setDiscovery(snap.discovery);
  });

  socket.on('mqtt-connection-attempt', ({ connection }) => s.upsertBroker(connection));
  socket.on('mqtt-connected', ({ connection }) => s.upsertBroker(connection));
  socket.on('mqtt-offline', ({ brokerId }) => s.upsertBroker({ id: brokerId, status: 'offline' }));
  socket.on('mqtt-reconnecting', ({ brokerId }) => s.upsertBroker({ id: brokerId, status: 'reconnecting' }));
  socket.on('mqtt-error', ({ brokerId, error }) => {
    if (brokerId) s.upsertBroker({ id: brokerId, status: 'error' });
    if (error) reportError(s, 'mqtt', error, { brokerId });
  });
  socket.on('subscription-error', ({ brokerId, topic, error }) =>
    reportError(s, 'mqtt', error, { brokerId, topic, prefix: `Subscribe "${topic}"` }));
  socket.on('unsubscription-error', ({ brokerId, topic, error }) =>
    reportError(s, 'mqtt', error, { brokerId, topic, prefix: `Unsubscribe "${topic}"` }));
  socket.on('publish-error', ({ brokerId, topic, error }) =>
    reportError(s, 'mqtt', error, { brokerId, topic, prefix: `Publish "${topic}"` }));
  socket.on('mqtt-disconnected', ({ brokerId }) => s.removeBroker(brokerId));
  // The server batches forwarded messages so a huge broker's initial retained
  // burst arrives as arrays rather than millions of individual events.
  socket.on('mqtt-messages', (batch) => {
    if (Array.isArray(batch)) for (const msg of batch) s.ingestMessage(msg);
  });
  socket.on('mqtt-message', (msg) => s.ingestMessage(msg)); // backward compat
  socket.on('broker-stats', (stats) => {
    for (const st of stats) s.upsertBroker({ id: st.brokerId, status: st.status, metrics: st.metrics });
  });

  socket.on('opcua-connection-attempt', () => refreshOpcua());
  socket.on('opcua-connected', () => refreshOpcua());
  socket.on('opcua-disconnected', () => refreshOpcua());
  socket.on('opcua-value', ({ connectionId, nodeId, ...rest }) => s.setOpcuaValue(connectionId, nodeId, rest));

  socket.on('discovery-started', (d) => s.setDiscovery({ scanning: true, results: [], progress: { ...d, completed: 0 } }));
  socket.on('discovery-progress', (p) => s.setDiscovery({ progress: p }));
  socket.on('discovery-result', (r) => s.addDiscoveryResult(r));
  socket.on('discovery-complete', (d) => s.setDiscovery({ scanning: false, results: d.results || [] }));
  socket.on('discovery-error', ({ error } = {}) => {
    s.setDiscovery({ scanning: false });
    if (error) reportError(s, 'discovery', error);
  });

  // --- Leveled logging of notable events (extra listeners; the state handlers
  // above are unchanged). info = lifecycle, warning = degraded, verbose = success.
  socket.on('mqtt-connected', ({ connection }) =>
    s.pushLog('info', 'mqtt', `Connected to ${brokerLabel(connection)}`, { brokerId: connection?.id }));
  socket.on('mqtt-disconnected', ({ brokerId }) => s.pushLog('info', 'mqtt', `Disconnected from ${brokerName(brokerId)}`, { brokerId }));
  socket.on('mqtt-offline', ({ brokerId }) => s.pushLog('warning', 'mqtt', `${brokerName(brokerId)} went offline`, { brokerId }));
  socket.on('mqtt-reconnecting', ({ brokerId }) => s.pushLog('warning', 'mqtt', `Reconnecting to ${brokerName(brokerId)}`, { brokerId }));
  socket.on('subscription-success', ({ brokerId, topic }) =>
    s.pushLog('verbose', 'mqtt', `Subscribed "${topic}"`, { brokerId, topic }));
  socket.on('unsubscription-success', ({ brokerId, topic }) =>
    s.pushLog('verbose', 'mqtt', `Unsubscribed "${topic}"`, { brokerId, topic }));
  socket.on('publish-success', ({ brokerId, topic }) =>
    s.pushLog('verbose', 'mqtt', `Published "${topic}"`, { brokerId, topic }));
  socket.on('discovery-started', () => s.pushLog('info', 'discovery', 'Discovery started'));
  socket.on('discovery-complete', (d) =>
    s.pushLog('info', 'discovery', `Discovery complete — ${d?.results?.length ?? 0} host(s)`));
  socket.on('opcua-connected', () => s.pushLog('info', 'opcua', 'OPC UA connected'));
  socket.on('opcua-disconnected', () => s.pushLog('info', 'opcua', 'OPC UA disconnected'));
  socket.on('opcua-reconnecting', () => s.pushLog('warning', 'opcua', 'OPC UA reconnecting'));
  socket.on('opcua-error', ({ error } = {}) => {
    if (error) reportError(s, 'opcua', error);
  });
}

// Dev-only: expose the store for scale/perf testing harnesses to seed the topic
// index directly (the render path is identical to live ingestion).
if (import.meta.env?.DEV && typeof window !== 'undefined') {
  window.__tcStore = useStore;
}

async function refreshOpcua() {
  // Use the api client, not a raw fetch: it attaches the bearer token, so on an
  // auth-enabled server this no longer 401s and wipes the OPC UA list to empty.
  try {
    const body = await api.listOpcua();
    useStore.getState().setOpcua(body?.connections || []);
  } catch (error) {
    // Don't clobber a good list on a transient failure — just log it.
    useStore.getState().pushLog('warning', 'opcua', `OPC UA refresh failed: ${error.message}`);
  }
}

import { create } from 'zustand';
import { socket } from '@/lib/socket';
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
    }))
}));

let wired = false;
export function initRealtime() {
  if (wired) return;
  wired = true;
  const s = useStore.getState();

  socket.on('connect', () => useStore.getState().setConnected(true));
  socket.on('disconnect', () => useStore.getState().setConnected(false));

  socket.on('state-snapshot', (snap) => {
    useStore.getState().setBrokers(snap.mqtt || []);
    useStore.getState().setOpcua(snap.opcua || []);
    if (snap.discovery) useStore.getState().setDiscovery(snap.discovery);
  });

  socket.on('mqtt-connection-attempt', ({ connection }) => s.upsertBroker(connection));
  socket.on('mqtt-connected', ({ connection }) => s.upsertBroker(connection));
  socket.on('mqtt-offline', ({ brokerId }) => s.upsertBroker({ id: brokerId, status: 'offline' }));
  socket.on('mqtt-reconnecting', ({ brokerId }) => s.upsertBroker({ id: brokerId, status: 'reconnecting' }));
  socket.on('mqtt-error', ({ brokerId }) => brokerId && s.upsertBroker({ id: brokerId, status: 'error' }));
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
  socket.on('discovery-error', () => s.setDiscovery({ scanning: false }));
}

// Dev-only: expose the store for scale/perf testing harnesses to seed the topic
// index directly (the render path is identical to live ingestion).
if (import.meta.env?.DEV && typeof window !== 'undefined') {
  window.__tcStore = useStore;
}

async function refreshOpcua() {
  try {
    const res = await fetch('/api/opcua/connections');
    const body = await res.json();
    useStore.getState().setOpcua(body.connections || []);
  } catch {
    // ignore transient refresh failures
  }
}

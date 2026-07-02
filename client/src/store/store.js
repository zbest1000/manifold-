import { create } from 'zustand';
import { socket } from '@/lib/socket';
import { DEFAULT_STYLE, DEFAULT_LAYOUT } from '@/graph/graphStyles';

const MAX_LIVE_MESSAGES = 200;

export const useStore = create((set, get) => ({
  connected: false,
  brokers: [], // MQTT connections
  opcua: [], // OPC UA connections
  discovery: { scanning: false, results: [], progress: null },

  // topics[brokerId] = [{ topic, messageCount, lastActivity, type, ... }]
  topics: {},
  // liveMessages[brokerId] = recent message objects (ring buffer)
  liveMessages: {},
  // opcuaValues[connectionId] = { nodeId: { value, sourceTimestamp, ... } }
  opcuaValues: {},

  // Graph view preferences (persisted to localStorage)
  graphStyle: localStorage.getItem('tc.graphStyle') || DEFAULT_STYLE,
  graphLayout: localStorage.getItem('tc.graphLayout') || DEFAULT_LAYOUT,

  setGraphStyle: (id) => {
    localStorage.setItem('tc.graphStyle', id);
    set({ graphStyle: id });
  },
  setGraphLayout: (id) => {
    localStorage.setItem('tc.graphLayout', id);
    set({ graphLayout: id });
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

  removeBroker: (brokerId) =>
    set((s) => ({
      brokers: s.brokers.filter((b) => b.id !== brokerId),
      topics: omit(s.topics, brokerId),
      liveMessages: omit(s.liveMessages, brokerId)
    })),

  setTopics: (brokerId, topics) => set((s) => ({ topics: { ...s.topics, [brokerId]: topics } })),

  ingestMessage: (msg) =>
    set((s) => {
      const buf = s.liveMessages[msg.brokerId] || [];
      const next = [msg, ...buf].slice(0, MAX_LIVE_MESSAGES);
      // Keep a lightweight topic index fresh from the live stream
      const existing = s.topics[msg.brokerId] || [];
      let topics = existing;
      if (!existing.some((t) => t.topic === msg.topic)) {
        topics = [...existing, { topic: msg.topic, messageCount: 1, lastActivity: msg.timestamp, type: msg.type }];
      } else {
        topics = existing.map((t) =>
          t.topic === msg.topic
            ? { ...t, messageCount: t.messageCount + 1, lastActivity: msg.timestamp, type: msg.type }
            : t
        );
      }
      return {
        liveMessages: { ...s.liveMessages, [msg.brokerId]: next },
        topics: { ...s.topics, [msg.brokerId]: topics }
      };
    }),

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

function omit(obj, key) {
  const next = { ...obj };
  delete next[key];
  return next;
}

// Wire socket events into the store exactly once.
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
  socket.on('mqtt-message', (msg) => s.ingestMessage(msg));
  socket.on('broker-stats', (stats) => {
    for (const st of stats) s.upsertBroker({ id: st.brokerId, status: st.status, metrics: st.metrics });
  });

  socket.on('opcua-connection-attempt', ({ connection }) => refreshOpcua());
  socket.on('opcua-connected', () => refreshOpcua());
  socket.on('opcua-disconnected', () => refreshOpcua());
  socket.on('opcua-value', ({ connectionId, nodeId, ...rest }) =>
    s.setOpcuaValue(connectionId, nodeId, rest)
  );

  socket.on('discovery-started', (d) => s.setDiscovery({ scanning: true, results: [], progress: { ...d, completed: 0 } }));
  socket.on('discovery-progress', (p) => s.setDiscovery({ progress: p }));
  socket.on('discovery-result', (r) => s.addDiscoveryResult(r));
  socket.on('discovery-complete', (d) => s.setDiscovery({ scanning: false, results: d.results || [] }));
  socket.on('discovery-error', () => s.setDiscovery({ scanning: false }));
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

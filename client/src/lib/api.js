// Thin REST client for the Manifold backend. All calls are relative so the
// Vite dev proxy (and production static serving) route them to the API.
import { useStore } from '@/store/store';
import { humanizeError } from '@/lib/humanizeError';

// Bearer token for servers started with MANIFOLD_AUTH_TOKEN. Kept in localStorage and
// attached to every request; the AuthGate sets it after the user unlocks.
export function getAuthToken() {
  return localStorage.getItem('tc.authToken') || '';
}

export function setAuthToken(token) {
  if (token) localStorage.setItem('tc.authToken', token);
  else localStorage.removeItem('tc.authToken');
}

async function request(path, options = {}) {
  const token = getAuthToken();
  let res;
  try {
    res = await fetch(path, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(options.headers || {})
      }
    });
  } catch (e) {
    // Network-level failure (server unreachable, CORS, etc.)
    const h = humanizeError(e.message || 'Network request failed');
    useStore.getState().pushLog('error', 'api', h.summary, { path, raw: e.message, code: h.code, hint: h.hint });
    throw new Error(h.summary);
  }
  const text = await res.text();
  let body = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text };
  }
  if (!res.ok) {
    const raw = body.error || `Request failed (${res.status})`;
    const h = humanizeError(raw);
    useStore.getState().pushLog('error', 'api', h.summary, { path, status: res.status, raw, code: h.code, hint: h.hint });
    throw new Error(h.summary);
  }
  return body;
}

export const api = {
  systemStatus: () => request('/api/system/status'),

  // MQTT
  listBrokers: () => request('/api/mqtt/brokers'),
  connectBroker: (config) => request('/api/mqtt/brokers', { method: 'POST', body: JSON.stringify(config) }),
  disconnectBroker: (id) => request(`/api/mqtt/brokers/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  brokerTopics: (id) => request(`/api/mqtt/brokers/${encodeURIComponent(id)}/topics`),
  topicMessages: (id, topic, limit = 50) =>
    request(`/api/mqtt/brokers/${encodeURIComponent(id)}/messages?topic=${encodeURIComponent(topic)}&limit=${limit}`),
  brokerSparkplug: (id) => request(`/api/mqtt/brokers/${encodeURIComponent(id)}/sparkplug`),
  brokerSys: (id) => request(`/api/mqtt/brokers/${encodeURIComponent(id)}/sys`),
  getBrokerAdmin: (id) => request(`/api/mqtt/brokers/${encodeURIComponent(id)}/admin`),
  setBrokerAdmin: (id, config) =>
    request(`/api/mqtt/brokers/${encodeURIComponent(id)}/admin`, { method: 'POST', body: JSON.stringify(config) }),
  clearBrokerAdmin: (id) => request(`/api/mqtt/brokers/${encodeURIComponent(id)}/admin`, { method: 'DELETE' }),
  brokerAdminPubSub: (id, { resolve = false, sampleLimit = 50 } = {}) =>
    request(
      `/api/mqtt/brokers/${encodeURIComponent(id)}/admin/pubsub${resolve ? `?resolve=1&sampleLimit=${sampleLimit}` : ''}`
    ),
  resolveSubscriptions: (id, filters, opts = {}) =>
    request(`/api/mqtt/brokers/${encodeURIComponent(id)}/subscriptions/resolve`, {
      method: 'POST',
      body: JSON.stringify({ filters, ...opts })
    }),
  unsTree: (id, { prefix = '', depth = 4, maxNodes = 2000 } = {}) =>
    request(
      `/api/mqtt/brokers/${encodeURIComponent(id)}/uns/tree?prefix=${encodeURIComponent(prefix)}&depth=${depth}&maxNodes=${maxNodes}`
    ),
  unsLint: (id) => request(`/api/mqtt/brokers/${encodeURIComponent(id)}/uns/lint`),
  unsEvents: (id, limit = 200) => request(`/api/mqtt/brokers/${encodeURIComponent(id)}/uns/events?limit=${limit}`),

  // UNS mounts (external sources grafted into the namespace view)
  listMounts: () => request('/api/uns/mounts'),
  addMount: (mount) => request('/api/uns/mounts', { method: 'POST', body: JSON.stringify(mount) }),
  removeMount: (id) => request(`/api/uns/mounts/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  // Historians (InfluxDB / Timebase)
  listHistorians: () => request('/api/historians'),
  saveHistorian: (h) => request('/api/historians', { method: 'POST', body: JSON.stringify(h) }),
  deleteHistorian: (id) => request(`/api/historians/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  testHistorian: (id) => request(`/api/historians/${encodeURIComponent(id)}/test`, { method: 'POST' }),

  // Pipelines
  listPipelines: () => request('/api/pipelines'),
  savePipeline: (route) => request('/api/pipelines', { method: 'POST', body: JSON.stringify(route) }),
  deletePipeline: (id) => request(`/api/pipelines/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  previewPipeline: (route, sampleLimit = 25) =>
    request('/api/pipelines/preview', { method: 'POST', body: JSON.stringify({ route, sampleLimit }) }),

  // Recorder + replay
  listRecordings: () => request('/api/recorder'),
  saveRecording: (rec) => request('/api/recorder', { method: 'POST', body: JSON.stringify(rec) }),
  deleteRecording: (id) => request(`/api/recorder/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  recordingData: (id, params = {}) => {
    const q = new URLSearchParams(params).toString();
    return request(`/api/recorder/${encodeURIComponent(id)}/data${q ? `?${q}` : ''}`);
  },
  startReplay: (body) => request('/api/recorder/replay', { method: 'POST', body: JSON.stringify(body) }),
  stopReplay: () => request('/api/recorder/replay', { method: 'DELETE' }),

  // Schema contracts
  listContracts: () => request('/api/contracts'),
  inferContract: (brokerId, topic) =>
    request('/api/contracts/infer', { method: 'POST', body: JSON.stringify({ brokerId, topic }) }),
  saveContract: (c) => request('/api/contracts', { method: 'POST', body: JSON.stringify(c) }),
  deleteContract: (id) => request(`/api/contracts/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  contractViolations: (limit = 200) => request(`/api/contracts/violations?limit=${limit}`),

  // Models
  listModels: () => request('/api/models'),
  saveModel: (m) => request('/api/models', { method: 'POST', body: JSON.stringify(m) }),
  deleteModel: (id) => request(`/api/models/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  // Tag browser + bindings
  tagSources: () => request('/api/tags/sources'),
  tagBrowse: (type, id, node = '') =>
    request(`/api/tags/browse?type=${encodeURIComponent(type)}&id=${encodeURIComponent(id)}&node=${encodeURIComponent(node)}`),
  listBindings: () => request('/api/tags/bindings'),
  saveBinding: (b) => request('/api/tags/bindings', { method: 'POST', body: JSON.stringify(b) }),
  deleteBinding: (id) => request(`/api/tags/bindings/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  // Config as code + audit
  exportConfig: () => request('/api/system/config/export'),
  importConfig: (cfg) => request('/api/system/config/import', { method: 'POST', body: JSON.stringify(cfg) }),
  auditRecent: (limit = 100) => request(`/api/audit?limit=${limit}`),

  // Alerts
  listAlertRules: () => request('/api/alerts/rules'),
  saveAlertRule: (rule) => request('/api/alerts/rules', { method: 'POST', body: JSON.stringify(rule) }),
  deleteAlertRule: (id) => request(`/api/alerts/rules/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  alertEvents: (limit = 200) => request(`/api/alerts/events?limit=${limit}`),

  topicTree: (id, prefix = '', limit = 500) =>
    request(`/api/mqtt/brokers/${encodeURIComponent(id)}/topictree?prefix=${encodeURIComponent(prefix)}&limit=${limit}`),
  subscribe: (id, topic, qos = 0) =>
    request(`/api/mqtt/brokers/${encodeURIComponent(id)}/subscribe`, {
      method: 'POST',
      body: JSON.stringify({ topic, qos })
    }),
  publish: (id, topic, payload, opts = {}) =>
    request(`/api/mqtt/brokers/${encodeURIComponent(id)}/publish`, {
      method: 'POST',
      body: JSON.stringify({ topic, payload, ...opts })
    }),

  // OPC UA
  listOpcua: () => request('/api/opcua/connections'),
  connectOpcua: (config) => request('/api/opcua/connections', { method: 'POST', body: JSON.stringify(config) }),
  disconnectOpcua: (id) => request(`/api/opcua/connections/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  opcuaBrowse: (id, nodeId) =>
    request(`/api/opcua/connections/${encodeURIComponent(id)}/browse${nodeId ? `?nodeId=${encodeURIComponent(nodeId)}` : ''}`),
  opcuaRead: (id, nodeId) =>
    request(`/api/opcua/connections/${encodeURIComponent(id)}/read?nodeId=${encodeURIComponent(nodeId)}`),
  opcuaMonitor: (id, nodeId, samplingInterval = 500) =>
    request(`/api/opcua/connections/${encodeURIComponent(id)}/monitor`, {
      method: 'POST',
      body: JSON.stringify({ nodeId, samplingInterval })
    }),

  // Discovery
  startDiscovery: (options) => request('/api/system/discovery/start', { method: 'POST', body: JSON.stringify(options) }),
  stopDiscovery: () => request('/api/system/discovery/stop', { method: 'POST' }),
  discoveryResults: () => request('/api/system/discovery/results'),

  // CESMII SMIP
  cesmiiStatus: () => request('/api/cesmii/status'),
  cesmiiConfig: (config) => request('/api/cesmii/config', { method: 'POST', body: JSON.stringify(config) }),
  cesmiiReset: () => request('/api/cesmii/config', { method: 'DELETE' }),
  cesmiiEquipment: () => request('/api/cesmii/equipment'),
  cesmiiAttributes: () => request('/api/cesmii/attributes'),
  cesmiiHistory: (body) => request('/api/cesmii/history', { method: 'POST', body: JSON.stringify(body) }),

  // i3X
  i3xStatus: () => request('/api/i3x/status'),
  i3xConnect: (config) => request('/api/i3x/connect', { method: 'POST', body: JSON.stringify(config) }),
  i3xReset: () => request('/api/i3x/connect', { method: 'DELETE' }),
  i3xNamespaces: () => request('/api/i3x/namespaces'),
  i3xObjectTypes: () => request('/api/i3x/objecttypes'),
  i3xObjects: (params = {}) => {
    const q = new URLSearchParams(params).toString();
    return request(`/api/i3x/objects${q ? `?${q}` : ''}`);
  },
  i3xValue: (elementIds, maxDepth = 1) =>
    request('/api/i3x/value', { method: 'POST', body: JSON.stringify({ elementIds, maxDepth }) }),
  i3xHistory: (body) => request('/api/i3x/history', { method: 'POST', body: JSON.stringify(body) }),

  // Server-side graph layout (Graphviz dot/sfdp/twopi/circo, Cytoscape fcose).
  // Only ids + edges are sent — enough for layout, and keeps the payload small.
  layoutEngines: () => request('/api/layout/engines'),
  computeLayout: (graph, engine, direction) =>
    request('/api/layout', {
      method: 'POST',
      body: JSON.stringify({
        graph: {
          nodes: graph.nodes.map((n) => ({ id: n.id })),
          links: graph.links.map((l) => ({ source: l.source, target: l.target }))
        },
        engine,
        direction
      })
    })
};

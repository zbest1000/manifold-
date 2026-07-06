// Thin REST client for the Topic Canvas backend. All calls are relative so the
// Vite dev proxy (and production static serving) route them to the API.
async function request(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }
  });
  const text = await res.text();
  let body = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text };
  }
  if (!res.ok) {
    throw new Error(body.error || `Request failed (${res.status})`);
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
  brokerAdminPubSub: (id) => request(`/api/mqtt/brokers/${encodeURIComponent(id)}/admin/pubsub`),
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

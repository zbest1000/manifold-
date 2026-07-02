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
  discoveryResults: () => request('/api/system/discovery/results')
};

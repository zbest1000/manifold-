const { EventEmitter } = require('events');
const { guardedFetch } = require('./egressGuard');

/**
 * Client for a CESMII i3X server — the "Common Contextual Manufacturing
 * Information API": a vendor-neutral REST interface over contextualized
 * manufacturing data (namespaces, object types, objects, relationships,
 * current values and history).
 *
 * i3X models data as a graph of objects connected by hierarchical, composition
 * and graph relationships, which maps directly onto this tool's node-graph views.
 * This client is a thin, stateless wrapper over the REST endpoints plus a couple
 * of convenience helpers.
 */
class I3xClient extends EventEmitter {
  constructor() {
    super();
    this.config = null; // { baseUrl, token }
    this.info = null;
  }

  isConfigured() {
    return Boolean(this.config?.baseUrl);
  }

  status() {
    return {
      configured: this.isConfigured(),
      baseUrl: this.config?.baseUrl || null,
      info: this.info
    };
  }

  configure(config = {}) {
    if (!config.baseUrl) throw new Error('baseUrl is required (e.g. https://api.i3x.dev/v1)');
    this.config = {
      baseUrl: config.baseUrl.replace(/\/$/, ''),
      token: config.token || null
    };
    this.info = null;
    return this.status();
  }

  reset() {
    this.config = null;
    this.info = null;
    return this.status();
  }

  headers() {
    const h = { 'Content-Type': 'application/json' };
    if (this.config?.token) h.Authorization = `Bearer ${this.config.token}`;
    return h;
  }

  async request(path, { method = 'GET', body, baseUrl, timeoutMs } = {}) {
    const root = (baseUrl || this.config?.baseUrl || '').replace(/\/$/, '');
    if (!root) throw new Error('i3X client is not configured');
    let res;
    try {
      res = await guardedFetch(`${root}${path}`, {
        method,
        headers: this.headers(),
        body: body ? JSON.stringify(body) : undefined
      }, timeoutMs);
    } catch (error) {
      throw new Error(`i3X request failed: ${error.message}`);
    }
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(json.error || json.message || `i3X HTTP ${res.status}`);
    }
    return json;
  }

  /**
   * Probe a base URL to see whether it is a live i3X server. Returns the /info
   * payload on success or null otherwise. Used by connect + network discovery.
   */
  async probe(baseUrl) {
    try {
      const info = await this.request('/info', { baseUrl, timeoutMs: 3000 });
      if (info && (info.specVersion || info.serverName)) return info;
      return null;
    } catch {
      return null;
    }
  }

  async connect(config = {}) {
    this.configure(config);
    const info = await this.probe(this.config.baseUrl);
    if (!info) {
      const bad = this.config.baseUrl;
      this.reset();
      throw new Error(`No i3X server responded at ${bad}/info`);
    }
    this.info = info;
    this.emit('connected', this.status());
    return this.status();
  }

  getInfo() {
    return this.request('/info');
  }

  listNamespaces() {
    return this.request('/namespaces').then((r) => r.result || []);
  }

  listObjectTypes(namespaceUri) {
    const q = namespaceUri ? `?namespaceUri=${encodeURIComponent(namespaceUri)}` : '';
    return this.request(`/objecttypes${q}`).then((r) => r.result || []);
  }

  listRelationshipTypes(namespaceUri) {
    const q = namespaceUri ? `?namespaceUri=${encodeURIComponent(namespaceUri)}` : '';
    return this.request(`/relationshiptypes${q}`).then((r) => r.result || []);
  }

  listObjects({ typeElementId, root, includeMetadata } = {}) {
    const params = new URLSearchParams();
    if (typeElementId) params.set('typeElementId', typeElementId);
    if (root) params.set('root', root);
    if (includeMetadata) params.set('includeMetadata', 'true');
    const q = params.toString() ? `?${params}` : '';
    return this.request(`/objects${q}`).then((r) => r.result || []);
  }

  async getRelated(elementIds, relationshipType) {
    if (!Array.isArray(elementIds) || elementIds.length === 0) {
      throw new Error('elementIds must be a non-empty array');
    }
    return this.request('/objects/related', {
      method: 'POST',
      body: { elementIds, relationshipType, includeMetadata: false }
    }).then((r) => r.results || []);
  }

  async getValues(elementIds, maxDepth = 1) {
    if (!Array.isArray(elementIds) || elementIds.length === 0) {
      throw new Error('elementIds must be a non-empty array');
    }
    return this.request('/objects/value', {
      method: 'POST',
      body: { elementIds, maxDepth }
    }).then((r) => r.results || []);
  }

  async getHistory(elementIds, startTime, endTime, maxDepth = 1) {
    if (!Array.isArray(elementIds) || elementIds.length === 0) {
      throw new Error('elementIds must be a non-empty array');
    }
    if (!startTime || !endTime) throw new Error('startTime and endTime are required');
    return this.request('/objects/history', {
      method: 'POST',
      body: { elementIds, startTime, endTime, maxDepth }
    }).then((r) => r.results || []);
  }

  /**
   * Assemble a { nodes, links } graph from the object list. Hierarchical edges
   * come from parentId; each node keeps its type/composition metadata so the UI
   * and MCP consumers can colour and inspect it.
   */
  buildGraph(objects) {
    const ids = new Set(objects.map((o) => o.elementId));
    const nodes = objects.map((o) => ({
      elementId: o.elementId,
      displayName: o.displayName,
      typeElementId: o.typeElementId || null,
      parentId: o.parentId || null,
      isComposition: Boolean(o.isComposition)
    }));
    const links = [];
    for (const o of objects) {
      if (o.parentId && ids.has(o.parentId)) {
        links.push({ source: o.parentId, target: o.elementId, kind: o.isComposition ? 'composition' : 'hierarchical' });
      }
    }
    return { nodes, links };
  }
}

module.exports = I3xClient;

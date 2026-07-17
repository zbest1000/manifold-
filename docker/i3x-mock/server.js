'use strict';
// Minimal mock CESMII i3X server for local Manifold testing. Zero dependencies —
// Node's built-in http only. Answers exactly the endpoints Manifold's i3X client
// (server/services/i3xClient.js) calls, with the shapes it expects: GET /info,
// /namespaces, /objecttypes, /relationshiptypes, /objects, and POST
// /objects/{related,value,history}.

const http = require('http');

const PORT = Number(process.env.PORT) || 8080;
const HOST = process.env.HOST || '0.0.0.0';
const SERVER_NAME = process.env.I3X_SERVER_NAME || 'Manifold Mock i3X';
const SPEC_VERSION = process.env.I3X_SPEC_VERSION || '1.0.0';
const NAMESPACE_URI = 'urn:manifold:mock:acme';

const NAMESPACES = [
  { namespaceUri: NAMESPACE_URI, name: 'Acme Mock Namespace', version: '1.0.0' }
];

const OBJECT_TYPES = [
  { elementId: 'type/Enterprise', displayName: 'Enterprise', namespaceUri: NAMESPACE_URI },
  { elementId: 'type/Area', displayName: 'Area', namespaceUri: NAMESPACE_URI },
  { elementId: 'type/ProductionLine', displayName: 'ProductionLine', namespaceUri: NAMESPACE_URI },
  { elementId: 'type/Motor', displayName: 'Motor', namespaceUri: NAMESPACE_URI },
  { elementId: 'type/Sensor', displayName: 'Sensor', namespaceUri: NAMESPACE_URI }
];

const RELATIONSHIP_TYPES = [
  { elementId: 'rel/hasChild', displayName: 'hasChild', namespaceUri: NAMESPACE_URI },
  { elementId: 'rel/hasComponent', displayName: 'hasComponent', namespaceUri: NAMESPACE_URI }
];

// A small ISA-95-ish hierarchy. Fields consumed by Manifold:
// elementId / displayName / parentId / typeElementId / isComposition
const OBJECTS = [
  { elementId: 'acme', displayName: 'Acme Plant', parentId: null, typeElementId: 'type/Enterprise' },
  { elementId: 'utilities', displayName: 'Utilities', parentId: 'acme', typeElementId: 'type/Area', isComposition: true },
  { elementId: 'line-1', displayName: 'Line 1', parentId: 'acme', typeElementId: 'type/ProductionLine' },
  { elementId: 'line-2', displayName: 'Line 2', parentId: 'acme', typeElementId: 'type/ProductionLine' },
  { elementId: 'motor-1', displayName: 'Motor 1', parentId: 'line-1', typeElementId: 'type/Motor', isComposition: true },
  { elementId: 'motor-1.temp', displayName: 'Temperature', parentId: 'motor-1', typeElementId: 'type/Sensor' },
  { elementId: 'motor-1.speed', displayName: 'Speed', parentId: 'motor-1', typeElementId: 'type/Sensor' },
  { elementId: 'motor-2', displayName: 'Motor 2', parentId: 'line-2', typeElementId: 'type/Motor', isComposition: true },
  { elementId: 'motor-2.temp', displayName: 'Temperature', parentId: 'motor-2', typeElementId: 'type/Sensor' },
  { elementId: 'motor-2.speed', displayName: 'Speed', parentId: 'motor-2', typeElementId: 'type/Sensor' },
  { elementId: 'utilities.air', displayName: 'Compressed Air', parentId: 'utilities', typeElementId: 'type/Sensor' }
];

function baseValue(elementId) {
  let h = 0;
  for (const ch of elementId) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  if (elementId.endsWith('.temp')) return 20 + (h % 60); // °C
  if (elementId.endsWith('.speed')) return 500 + (h % 2500); // rpm
  if (elementId.endsWith('.air')) return 5 + (h % 4); // bar
  return h % 100;
}

function currentValue(elementId) {
  const wobble = ((Date.now() / 1000) % 10) - 5;
  return {
    elementId,
    value: Math.round((baseValue(elementId) + wobble) * 100) / 100,
    timestamp: new Date().toISOString(),
    quality: 'Good'
  };
}

function historyFor(elementId, startTime, endTime) {
  const start = Date.parse(startTime) || Date.now() - 7 * 864e5;
  const end = Date.parse(endTime) || Date.now();
  const N = 48;
  const step = (end - start) / N;
  const base = baseValue(elementId);
  const values = [];
  for (let i = 0; i <= N; i++) {
    values.push({
      timestamp: new Date(start + i * step).toISOString(),
      value: Math.round((base + Math.sin(i / 3) * base * 0.1) * 100) / 100,
      quality: 'Good'
    });
  }
  return { elementId, values };
}

function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 1e6) req.destroy();
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        resolve({});
      }
    });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const method = req.method.toUpperCase();

  if (method === 'GET' && path === '/info') {
    return send(res, 200, {
      serverName: SERVER_NAME,
      specVersion: SPEC_VERSION,
      vendor: 'Manifold Mock',
      namespaceCount: NAMESPACES.length,
      objectCount: OBJECTS.length
    });
  }
  if (method === 'GET' && path === '/namespaces') return send(res, 200, { result: NAMESPACES });
  if (method === 'GET' && path === '/objecttypes') return send(res, 200, { result: OBJECT_TYPES });
  if (method === 'GET' && path === '/relationshiptypes') return send(res, 200, { result: RELATIONSHIP_TYPES });

  if (method === 'GET' && path === '/objects') {
    const typeElementId = url.searchParams.get('typeElementId');
    let result = OBJECTS.map((o) => ({ isComposition: false, ...o }));
    if (typeElementId) result = result.filter((o) => o.typeElementId === typeElementId);
    return send(res, 200, { result });
  }

  if (method === 'POST' && path === '/objects/related') {
    const { elementIds = [] } = await readBody(req);
    const results = elementIds.map((id) => ({
      elementId: id,
      related: OBJECTS.filter((o) => o.parentId === id).map((o) => o.elementId)
    }));
    return send(res, 200, { results });
  }
  if (method === 'POST' && path === '/objects/value') {
    const { elementIds = [] } = await readBody(req);
    return send(res, 200, { results: elementIds.map(currentValue) });
  }
  if (method === 'POST' && path === '/objects/history') {
    const { elementIds = [], startTime, endTime } = await readBody(req);
    return send(res, 200, { results: elementIds.map((id) => historyFor(id, startTime, endTime)) });
  }

  return send(res, 404, { error: `no such i3X route: ${method} ${path}` });
});

server.listen(PORT, HOST, () => {
  console.log(`mock i3X server listening on ${HOST}:${PORT} (serverName="${SERVER_NAME}", spec=${SPEC_VERSION})`);
});

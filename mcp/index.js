#!/usr/bin/env node
/**
 * Manifold MCP server.
 *
 * Exposes the MQTT + OPC UA exploration backend as Model Context Protocol tools
 * so any MCP-capable client (Claude Desktop, IDE agents, etc.) can discover
 * brokers, browse topics, read live payloads, and walk an OPC UA address space.
 *
 * It is a thin, stateless bridge over the backend REST API — start the backend
 * first (default http://localhost:5000) and point MANIFOLD_API_URL at it.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const API_URL = (process.env.MANIFOLD_API_URL || 'http://localhost:5000').replace(/\/$/, '');
// Matches the backend's MANIFOLD_AUTH_TOKEN when the server runs authenticated.
const AUTH_TOKEN = process.env.MANIFOLD_AUTH_TOKEN || '';

async function api(path, options = {}) {
  const url = `${API_URL}${path}`;
  let res;
  try {
    res = await fetch(url, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...(AUTH_TOKEN ? { Authorization: `Bearer ${AUTH_TOKEN}` } : {}),
        ...(options.headers || {})
      }
    });
  } catch (error) {
    throw new Error(`Cannot reach Manifold backend at ${API_URL}: ${error.message}`);
  }
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text };
  }
  if (!res.ok) {
    throw new Error(body.error || `Request failed (${res.status}) for ${path}`);
  }
  return body;
}

function ok(data) {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

function fail(error) {
  return { isError: true, content: [{ type: 'text', text: `Error: ${error.message}` }] };
}

const server = new McpServer({ name: 'manifold', version: '2.0.0' });

// ---------------------------------------------------------------------------
// System / discovery
// ---------------------------------------------------------------------------
server.tool(
  'system_status',
  'Get the current status of the Manifold backend: connected MQTT brokers, OPC UA endpoints, and discovery state.',
  {},
  async () => {
    try {
      return ok(await api('/api/system/status'));
    } catch (error) {
      return fail(error);
    }
  }
);

server.tool(
  'discover_scan',
  'Start a network scan for MQTT brokers and OPC UA servers. Probes TCP ports across a CIDR range and verifies each hit with a real protocol handshake. Omit range to auto-detect the local subnet.',
  {
    range: z.string().optional().describe('CIDR range to scan, e.g. "192.168.1.0/24". Defaults to the local subnet.'),
    mqttPorts: z.array(z.number()).optional().describe('MQTT ports to probe (default [1883, 8883]).'),
    opcuaPorts: z.array(z.number()).optional().describe('OPC UA ports to probe (default [4840]).')
  },
  async (args) => {
    try {
      return ok(await api('/api/system/discovery/start', { method: 'POST', body: JSON.stringify(args) }));
    } catch (error) {
      return fail(error);
    }
  }
);

server.tool(
  'discover_results',
  'Get the results of the most recent (or in-progress) network discovery scan.',
  {},
  async () => {
    try {
      return ok(await api('/api/system/discovery/results'));
    } catch (error) {
      return fail(error);
    }
  }
);

server.tool(
  'discovery_stop',
  'Stop an in-progress network discovery scan (changes server state).',
  {},
  async () => {
    try {
      return ok(await api('/api/system/discovery/stop', { method: 'POST' }));
    } catch (error) {
      return fail(error);
    }
  }
);

server.tool(
  'config_export',
  'Export the full DataOps configuration (pipelines, historians, models, recordings, contracts, bindings, mounts, alert rules) as one JSON document. Secrets are stripped.',
  {},
  async () => {
    try {
      return ok(await api('/api/system/config/export'));
    } catch (error) {
      return fail(error);
    }
  }
);

server.tool(
  'config_import',
  'Import a DataOps configuration export (changes server state): merges by id — existing ids are overwritten, nothing is deleted. Stored secrets are kept when the import carries none.',
  {
    config: z.object({ manifoldConfig: z.number() }).passthrough()
      .describe('A config document from config_export (must carry manifoldConfig: 1).')
  },
  async ({ config }) => {
    try {
      return ok(await api('/api/system/config/import', { method: 'POST', body: JSON.stringify(config) }));
    } catch (error) {
      return fail(error);
    }
  }
);

// ---------------------------------------------------------------------------
// MQTT
// ---------------------------------------------------------------------------
server.tool(
  'mqtt_list_brokers',
  'List all MQTT broker connections with their status and metrics.',
  {},
  async () => {
    try {
      return ok(await api('/api/mqtt/brokers'));
    } catch (error) {
      return fail(error);
    }
  }
);

server.tool(
  'mqtt_connect',
  'Connect to an MQTT broker. Returns a brokerId used by the other mqtt_* tools.',
  {
    host: z.string().describe('Broker hostname or IP.'),
    port: z.number().optional().describe('Broker port (default 1883, or 8883 for mqtts).'),
    protocol: z.enum(['mqtt', 'mqtts']).optional(),
    username: z.string().optional(),
    password: z.string().optional(),
    name: z.string().optional().describe('Friendly display name.'),
    autoSubscribe: z.boolean().optional().describe('Auto-subscribe to "#" on connect (default true).')
  },
  async (args) => {
    try {
      return ok(await api('/api/mqtt/brokers', { method: 'POST', body: JSON.stringify(args) }));
    } catch (error) {
      return fail(error);
    }
  }
);

server.tool(
  'mqtt_disconnect',
  'Disconnect from an MQTT broker.',
  { brokerId: z.string() },
  async ({ brokerId }) => {
    try {
      return ok(await api(`/api/mqtt/brokers/${encodeURIComponent(brokerId)}`, { method: 'DELETE' }));
    } catch (error) {
      return fail(error);
    }
  }
);

server.tool(
  'mqtt_list_topics',
  'List all topics seen on a broker, with message counts and last-activity timestamps. Ideal for building a topic tree.',
  { brokerId: z.string() },
  async ({ brokerId }) => {
    try {
      return ok(await api(`/api/mqtt/brokers/${encodeURIComponent(brokerId)}/topics`));
    } catch (error) {
      return fail(error);
    }
  }
);

server.tool(
  'mqtt_get_messages',
  'Get recent messages for a specific topic on a broker, including decoded Sparkplug B payloads where applicable.',
  {
    brokerId: z.string(),
    topic: z.string(),
    limit: z.number().optional().describe('Max messages to return (default 50, max 500).')
  },
  async ({ brokerId, topic, limit }) => {
    try {
      const q = new URLSearchParams({ topic, ...(limit ? { limit: String(limit) } : {}) });
      return ok(await api(`/api/mqtt/brokers/${encodeURIComponent(brokerId)}/messages?${q}`));
    } catch (error) {
      return fail(error);
    }
  }
);

server.tool(
  'mqtt_sparkplug_topology',
  'Sparkplug B device topology observed on a broker: Group → Edge Node → Device with online/offline state (BIRTH/DEATH) and the metric set each real publishing endpoint emits.',
  { brokerId: z.string() },
  async ({ brokerId }) => {
    try {
      return ok(await api(`/api/mqtt/brokers/${encodeURIComponent(brokerId)}/sparkplug`));
    } catch (error) {
      return fail(error);
    }
  }
);

server.tool(
  'mqtt_sys_stats',
  "Broker $SYS health summary (clients, subscription counts, throughput, uptime). Aggregate only — per-client subscriptions require the broker admin API (see mqtt_admin_pubsub).",
  { brokerId: z.string() },
  async ({ brokerId }) => {
    try {
      return ok(await api(`/api/mqtt/brokers/${encodeURIComponent(brokerId)}/sys`));
    } catch (error) {
      return fail(error);
    }
  }
);

server.tool(
  'mqtt_resolve_subscriptions',
  'Resolve MQTT subscription filters (with + / # wildcards) against the topics actually observed on a broker: exact match counts, covering subtree roots, and a sample of concrete matched topics. Answers "what would this filter receive?".',
  {
    brokerId: z.string(),
    filters: z.array(z.string()).describe('Subscription filters, e.g. ["spBv1.0/#", "factory/+/temp"]'),
    sampleLimit: z.number().optional().describe('Max concrete topics per filter (default 100, max 2000).')
  },
  async ({ brokerId, filters, sampleLimit }) => {
    try {
      return ok(
        await api(`/api/mqtt/brokers/${encodeURIComponent(brokerId)}/subscriptions/resolve`, {
          method: 'POST',
          body: JSON.stringify({ filters, sampleLimit })
        })
      );
    } catch (error) {
      return fail(error);
    }
  }
);

server.tool(
  'mqtt_topic_tree',
  'One level of the observed topic tree under a prefix, with per-child subtree counts — for drilling into large namespaces without transferring them.',
  {
    brokerId: z.string(),
    prefix: z.string().optional().describe('Topic path prefix; omit for the root level.'),
    limit: z.number().optional()
  },
  async ({ brokerId, prefix, limit }) => {
    try {
      const q = new URLSearchParams({ ...(prefix ? { prefix } : {}), ...(limit ? { limit: String(limit) } : {}) });
      return ok(await api(`/api/mqtt/brokers/${encodeURIComponent(brokerId)}/topictree?${q}`));
    } catch (error) {
      return fail(error);
    }
  }
);

server.tool(
  'uns_tree',
  'Nested Unified Namespace tree observed on a broker (depth- and node-capped skeleton). Every node carries its exact subtree topic count even when children are cut off, so large namespaces summarize honestly. Use prefix to drill below the cut.',
  {
    brokerId: z.string(),
    prefix: z.string().optional().describe('Start below this path instead of the namespace root.'),
    depth: z.number().optional().describe('Levels to expand (default 4, max 12).'),
    maxNodes: z.number().optional().describe('Total node cap (default 2000, max 10000).')
  },
  async ({ brokerId, prefix, depth, maxNodes }) => {
    try {
      const q = new URLSearchParams({
        ...(prefix ? { prefix } : {}),
        ...(depth ? { depth: String(depth) } : {}),
        ...(maxNodes ? { maxNodes: String(maxNodes) } : {})
      });
      return ok(await api(`/api/mqtt/brokers/${encodeURIComponent(brokerId)}/uns/tree?${q}`));
    } catch (error) {
      return fail(error);
    }
  }
);

server.tool(
  'uns_lint',
  'UNS conformance lint over the observed namespace: mixed naming conventions among siblings, payloads on branch nodes, empty segments, whitespace in names, redundant single-child chains, uneven leaf depth. Returns a 0-100 score, bounded findings, and exact per-rule counts.',
  { brokerId: z.string() },
  async ({ brokerId }) => {
    try {
      return ok(await api(`/api/mqtt/brokers/${encodeURIComponent(brokerId)}/uns/lint`));
    } catch (error) {
      return fail(error);
    }
  }
);

server.tool(
  'uns_events',
  'Namespace event feed for a broker, newest first: new topics appearing plus Sparkplug BIRTH/DEATH lifecycle events (edge nodes and devices coming online/offline, including cascaded device deaths).',
  {
    brokerId: z.string(),
    limit: z.number().optional().describe('Max events (default 200, max 2000).')
  },
  async ({ brokerId, limit }) => {
    try {
      const q = limit ? `?limit=${Number(limit)}` : '';
      return ok(await api(`/api/mqtt/brokers/${encodeURIComponent(brokerId)}/uns/events${q}`));
    } catch (error) {
      return fail(error);
    }
  }
);

server.tool(
  'pipelines_list',
  'DataOps pipeline routes (source → transforms → target) with live per-route metrics: matched/published/error counts, loop-blocked messages, last error.',
  {},
  async () => {
    try {
      return ok(await api('/api/pipelines'));
    } catch (error) {
      return fail(error);
    }
  }
);

server.tool(
  'pipeline_preview',
  'Dry-run a pipeline route against the topics actually observed on a broker: exact match count and the in→out topic/payload mapping after transforms. Nothing is published. Route shape: { source: {brokerId, filter}, transforms: [...], target: {...} }.',
  {
    route: z.object({}).passthrough().describe('Route definition: { source: {brokerId, filter}, transforms?, target }'),
    sampleLimit: z.number().optional()
  },
  async ({ route, sampleLimit }) => {
    try {
      return ok(await api('/api/pipelines/preview', { method: 'POST', body: JSON.stringify({ route, sampleLimit }) }));
    } catch (error) {
      return fail(error);
    }
  }
);

server.tool(
  'pipeline_save',
  'Create or update a DataOps pipeline route (changes server state). Pass id to update an existing route; omit it to create one. Target is { type: "mqtt", brokerId, topicPrefix?, ... } or { type: "historian", historianId, ... }. Use pipeline_preview first to dry-run.',
  {
    id: z.string().optional().describe('Route id to update; omit to create.'),
    name: z.string().optional(),
    enabled: z.boolean().optional().describe('Default true.'),
    source: z.object({ brokerId: z.string(), filter: z.string() }).describe('Source broker and topic filter (wildcards + / # allowed).'),
    transforms: z.array(z.object({ type: z.string() }).passthrough()).optional()
      .describe('Transform steps: repath, pick, rename, set, scale, numeric, sparkplugFlatten, envelope.'),
    target: z.object({ type: z.enum(['mqtt', 'historian']) }).passthrough()
      .describe('Target: { type: "mqtt", brokerId, ... } or { type: "historian", historianId, ... }.')
  },
  async (args) => {
    try {
      return ok(await api('/api/pipelines', { method: 'POST', body: JSON.stringify(args) }));
    } catch (error) {
      return fail(error);
    }
  }
);

server.tool(
  'pipeline_delete',
  'Delete a DataOps pipeline route (changes server state).',
  { id: z.string() },
  async ({ id }) => {
    try {
      return ok(await api(`/api/pipelines/${encodeURIComponent(id)}`, { method: 'DELETE' }));
    } catch (error) {
      return fail(error);
    }
  }
);

server.tool(
  'historians_list',
  'Configured historian connections (InfluxDB v2, Timebase) that pipelines and the recorder can write time-series into. Secrets are redacted.',
  {},
  async () => {
    try {
      return ok(await api('/api/historians'));
    } catch (error) {
      return fail(error);
    }
  }
);

server.tool(
  'historian_save',
  'Create or update a historian connection (changes server state). influxdb needs url, org, bucket (token for auth); timebase needs url, dataset (apiKey for auth); timescaledb needs host, database, user (password for auth). Omitted secrets keep their stored value on edit.',
  {
    id: z.string().optional().describe('Historian id to update; omit to create.'),
    name: z.string().optional(),
    type: z.enum(['influxdb', 'timebase', 'timescaledb']),
    url: z.string().optional().describe('Base URL (influxdb, timebase).'),
    org: z.string().optional().describe('InfluxDB organization.'),
    bucket: z.string().optional().describe('InfluxDB bucket.'),
    token: z.string().optional().describe('InfluxDB API token.'),
    measurement: z.string().optional().describe('InfluxDB measurement name.'),
    dataset: z.string().optional().describe('Timebase dataset.'),
    writePath: z.string().optional().describe('Timebase write path override.'),
    apiKey: z.string().optional().describe('Timebase API key.'),
    host: z.string().optional().describe('TimescaleDB host.'),
    port: z.number().optional().describe('TimescaleDB port.'),
    database: z.string().optional().describe('TimescaleDB database.'),
    user: z.string().optional().describe('TimescaleDB user.'),
    password: z.string().optional().describe('TimescaleDB password.'),
    ssl: z.boolean().optional().describe('TimescaleDB SSL.'),
    table: z.string().optional().describe('TimescaleDB table.'),
    dropPolicy: z.enum(['newest', 'oldest']).optional().describe('Which points to drop when the store-and-forward outbox is full (default newest).')
  },
  async (args) => {
    try {
      return ok(await api('/api/historians', { method: 'POST', body: JSON.stringify(args) }));
    } catch (error) {
      return fail(error);
    }
  }
);

server.tool(
  'historian_delete',
  'Delete a historian connection (changes server state).',
  { id: z.string() },
  async ({ id }) => {
    try {
      return ok(await api(`/api/historians/${encodeURIComponent(id)}`, { method: 'DELETE' }));
    } catch (error) {
      return fail(error);
    }
  }
);

server.tool(
  'historian_test',
  'Test a historian connection by writing one test point (tag "manifold/connection-test"). Writes real data to the historian.',
  { id: z.string() },
  async ({ id }) => {
    try {
      return ok(await api(`/api/historians/${encodeURIComponent(id)}/test`, { method: 'POST' }));
    } catch (error) {
      return fail(error);
    }
  }
);

server.tool(
  'contracts_list',
  'List schema contracts (locked payload shapes per topic filter) with check/violation counters.',
  {},
  async () => {
    try {
      return ok(await api('/api/contracts'));
    } catch (error) {
      return fail(error);
    }
  }
);

server.tool(
  'contract_infer',
  'Infer a JSON schema from the latest observed payload on a topic — use the result as the schema for contract_lock. Read-only.',
  { brokerId: z.string(), topic: z.string() },
  async (args) => {
    try {
      return ok(await api('/api/contracts/infer', { method: 'POST', body: JSON.stringify(args) }));
    } catch (error) {
      return fail(error);
    }
  }
);

server.tool(
  'contract_lock',
  'Lock a schema contract on a topic filter (changes server state): payloads that drift from the schema are reported as violations. Derive the schema with contract_infer first.',
  {
    id: z.string().optional().describe('Contract id to update; omit to create.'),
    name: z.string().optional(),
    brokerId: z.string(),
    filter: z.string().describe('Topic filter (wildcards + / # allowed).'),
    schema: z.object({ type: z.string() }).passthrough().describe('Schema object (from contract_infer).'),
    enabled: z.boolean().optional().describe('Default true.')
  },
  async (args) => {
    try {
      return ok(await api('/api/contracts', { method: 'POST', body: JSON.stringify(args) }));
    } catch (error) {
      return fail(error);
    }
  }
);

server.tool(
  'contract_delete',
  'Delete a schema contract (changes server state).',
  { id: z.string() },
  async ({ id }) => {
    try {
      return ok(await api(`/api/contracts/${encodeURIComponent(id)}`, { method: 'DELETE' }));
    } catch (error) {
      return fail(error);
    }
  }
);

server.tool(
  'contracts_violations',
  'Recent schema-contract violations: payload drift (missing fields, new fields, type changes) on topics whose shape was locked. Newest first.',
  { limit: z.number().optional() },
  async ({ limit }) => {
    try {
      return ok(await api(`/api/contracts/violations${limit ? `?limit=${Number(limit)}` : ''}`));
    } catch (error) {
      return fail(error);
    }
  }
);

server.tool(
  'models_list',
  'Contextualization models: multi-source attribute bindings published as merged objects at UNS paths, with publish/error status.',
  {},
  async () => {
    try {
      return ok(await api('/api/models'));
    } catch (error) {
      return fail(error);
    }
  }
);

server.tool(
  'model_save',
  'Create or update a contextualization model (changes server state): multi-source attributes merged into one object published at a UNS path.',
  {
    id: z.string().optional().describe('Model id to update; omit to create.'),
    name: z.string().optional(),
    enabled: z.boolean().optional().describe('Default true.'),
    target: z.object({ brokerId: z.string(), topic: z.string(), retain: z.boolean().optional() })
      .describe('Where the merged object is published.'),
    publishMode: z.enum(['on-change', 'interval']).optional().describe('Default on-change.'),
    intervalMs: z.number().optional().describe('Publish interval for interval mode (default 5000).'),
    attributes: z.array(
      z.object({
        name: z.string(),
        source: z.object({ brokerId: z.string(), topic: z.string() }).passthrough()
      }).passthrough()
    ).describe('Attributes: each has a name and a source { brokerId, topic }.')
  },
  async (args) => {
    try {
      return ok(await api('/api/models', { method: 'POST', body: JSON.stringify(args) }));
    } catch (error) {
      return fail(error);
    }
  }
);

server.tool(
  'model_delete',
  'Delete a contextualization model (changes server state).',
  { id: z.string() },
  async ({ id }) => {
    try {
      return ok(await api(`/api/models/${encodeURIComponent(id)}`, { method: 'DELETE' }));
    } catch (error) {
      return fail(error);
    }
  }
);

server.tool(
  'tags_sources',
  'List browsable tag sources right now: connected OPC UA servers, Sparkplug registries, and MQTT topic tries.',
  {},
  async () => {
    try {
      return ok(await api('/api/tags/sources'));
    } catch (error) {
      return fail(error);
    }
  }
);

server.tool(
  'tags_browse',
  'Browse one level of device tags under a node in a source (from tags_sources). Nodes are { id, name, kind: "folder"|"tag", address }.',
  {
    type: z.enum(['opcua', 'sparkplug', 'mqtt']).describe('Source type.'),
    id: z.string().describe('Source id (connectionId or brokerId).'),
    node: z.string().optional().describe('Node to browse under; omit for the root level.')
  },
  async ({ type, id, node }) => {
    try {
      const q = new URLSearchParams({ type, id, ...(node ? { node } : {}) });
      return ok(await api(`/api/tags/browse?${q}`));
    } catch (error) {
      return fail(error);
    }
  }
);

server.tool(
  'bindings_list',
  'Tag bindings: device tags (OPC UA nodes, Sparkplug metrics) bound into the UNS, with per-binding publish/deadband/error status and Sparkplug edge-node session state.',
  {},
  async () => {
    try {
      return ok(await api('/api/tags/bindings'));
    } catch (error) {
      return fail(error);
    }
  }
);

server.tool(
  'binding_save',
  'Create or update a tag binding (changes server state): bind OPC UA nodes or Sparkplug metrics into the UNS. Opcua source needs { type: "opcua", connectionId, tags: [...] }; sparkplug source needs { type: "sparkplug", brokerId, group, edge }. Target: { mode: "mqtt"|"sparkplug", brokerId, ... } (sparkplug mode also needs group and edge).',
  {
    id: z.string().optional().describe('Binding id to update; omit to create.'),
    name: z.string().optional(),
    enabled: z.boolean().optional().describe('Default true.'),
    source: z.object({ type: z.enum(['opcua', 'sparkplug']) }).passthrough()
      .describe('Source: { type: "opcua", connectionId, tags } or { type: "sparkplug", brokerId, group, edge }.'),
    target: z.object({ mode: z.enum(['mqtt', 'sparkplug']), brokerId: z.string() }).passthrough()
      .describe('Target: { mode, brokerId, ... }; sparkplug mode also needs group and edge.')
  },
  async (args) => {
    try {
      return ok(await api('/api/tags/bindings', { method: 'POST', body: JSON.stringify(args) }));
    } catch (error) {
      return fail(error);
    }
  }
);

server.tool(
  'binding_delete',
  'Delete a tag binding (changes server state).',
  { id: z.string() },
  async ({ id }) => {
    try {
      return ok(await api(`/api/tags/bindings/${encodeURIComponent(id)}`, { method: 'DELETE' }));
    } catch (error) {
      return fail(error);
    }
  }
);

server.tool(
  'recorder_list',
  'List recordings with live capture status, plus the active replay state.',
  {},
  async () => {
    try {
      return ok(await api('/api/recorder'));
    } catch (error) {
      return fail(error);
    }
  }
);

server.tool(
  'recorder_save',
  'Create or update a recording (changes server state): captures messages matching a topic filter to a file or historian. Set enabled: false to stop capture without deleting data (there is no separate stop endpoint).',
  {
    id: z.string().optional().describe('Recording id to update; omit to create.'),
    name: z.string().optional(),
    brokerId: z.string(),
    filter: z.string().describe('Topic filter (wildcards + / # allowed).'),
    target: z.object({ type: z.enum(['file', 'historian']), historianId: z.string().optional() }).optional()
      .describe('Where captured points go (default { type: "file" }); historian targets need historianId.'),
    maxBytes: z.number().optional().describe('Size cap for file recordings.'),
    enabled: z.boolean().optional().describe('Default true; false stops capture.')
  },
  async (args) => {
    try {
      return ok(await api('/api/recorder', { method: 'POST', body: JSON.stringify(args) }));
    } catch (error) {
      return fail(error);
    }
  }
);

server.tool(
  'recorder_delete',
  'Delete a recording config AND its captured data file (changes server state). To merely stop capture, use recorder_save with enabled: false.',
  { id: z.string() },
  async ({ id }) => {
    try {
      return ok(await api(`/api/recorder/${encodeURIComponent(id)}`, { method: 'DELETE' }));
    } catch (error) {
      return fail(error);
    }
  }
);

server.tool(
  'recorder_data',
  'Read back captured points from a recording (bounded).',
  {
    id: z.string(),
    topic: z.string().optional().describe('Filter to one topic.'),
    from: z.number().optional().describe('Start timestamp (ms epoch).'),
    to: z.number().optional().describe('End timestamp (ms epoch).'),
    limit: z.number().optional().describe('Max points (default 500).')
  },
  async ({ id, topic, from, to, limit }) => {
    try {
      const q = new URLSearchParams({
        ...(topic ? { topic } : {}),
        ...(from ? { from: String(from) } : {}),
        ...(to ? { to: String(to) } : {}),
        ...(limit ? { limit: String(limit) } : {})
      });
      const qs = q.toString() ? `?${q}` : '';
      return ok(await api(`/api/recorder/${encodeURIComponent(id)}/data${qs}`));
    } catch (error) {
      return fail(error);
    }
  }
);

server.tool(
  'replay_start',
  'Start replaying a recording onto a broker (changes server state: publishes the recorded messages live).',
  {
    recordingId: z.string(),
    brokerId: z.string().describe('Broker to publish onto.'),
    speed: z.number().optional().describe('Playback speed multiplier.'),
    loop: z.boolean().optional().describe('Restart from the beginning when done.'),
    topicPrefix: z.string().optional().describe('Prefix prepended to replayed topics.')
  },
  async (args) => {
    try {
      return ok(await api('/api/recorder/replay', { method: 'POST', body: JSON.stringify(args) }));
    } catch (error) {
      return fail(error);
    }
  }
);

server.tool(
  'replay_stop',
  'Stop the active replay (changes server state).',
  {},
  async () => {
    try {
      return ok(await api('/api/recorder/replay', { method: 'DELETE' }));
    } catch (error) {
      return fail(error);
    }
  }
);

server.tool(
  'alert_rule_save',
  'Create or update an alert rule (changes server state). Types: branch-silent (no traffic under path), topic-silent (a specific topic goes quiet; requires topic), new-topic (new topic appears under prefix). Optional webhookUrl is POSTed on firing.',
  {
    id: z.string().optional().describe('Rule id to update; omit to create.'),
    name: z.string().optional(),
    type: z.enum(['branch-silent', 'topic-silent', 'new-topic']),
    brokerId: z.string(),
    path: z.string().optional().describe('UNS branch path for branch-silent rules.'),
    topic: z.string().optional().describe('Exact topic for topic-silent rules (required for that type).'),
    prefix: z.string().optional().describe('Topic prefix for new-topic rules.'),
    thresholdMs: z.number().optional().describe('Silence threshold in ms (default 60000).'),
    webhookUrl: z.string().optional().describe('Webhook to POST when the rule fires.'),
    enabled: z.boolean().optional().describe('Default true.')
  },
  async (args) => {
    try {
      return ok(await api('/api/alerts/rules', { method: 'POST', body: JSON.stringify(args) }));
    } catch (error) {
      return fail(error);
    }
  }
);

server.tool(
  'alert_rule_delete',
  'Delete an alert rule (changes server state).',
  { id: z.string() },
  async ({ id }) => {
    try {
      return ok(await api(`/api/alerts/rules/${encodeURIComponent(id)}`, { method: 'DELETE' }));
    } catch (error) {
      return fail(error);
    }
  }
);

server.tool(
  'alert_events',
  'Recent alert firings, newest first.',
  { limit: z.number().optional().describe('Max events (default 200, max 500).') },
  async ({ limit }) => {
    try {
      return ok(await api(`/api/alerts/events${limit ? `?limit=${Number(limit)}` : ''}`));
    } catch (error) {
      return fail(error);
    }
  }
);

server.tool(
  'mount_save',
  'Add a UNS mount (changes server state): graft an external source (an OPC UA connection or the i3X namespace) into the Unified Namespace view. Always creates a new mount.',
  {
    type: z.enum(['opcua', 'i3x']),
    connectionId: z.string().optional().describe('OPC UA connectionId (required for opcua mounts).'),
    label: z.string().optional().describe('Display label in the UNS tree.'),
    nodeId: z.string().optional().describe('OPC UA node to mount from (defaults to Objects).')
  },
  async (args) => {
    try {
      return ok(await api('/api/uns/mounts', { method: 'POST', body: JSON.stringify(args) }));
    } catch (error) {
      return fail(error);
    }
  }
);

server.tool(
  'mount_delete',
  'Remove a UNS mount (changes server state).',
  { id: z.string() },
  async ({ id }) => {
    try {
      return ok(await api(`/api/uns/mounts/${encodeURIComponent(id)}`, { method: 'DELETE' }));
    } catch (error) {
      return fail(error);
    }
  }
);

server.tool(
  'audit_recent',
  'Recent audit-trail entries: every mutating API call and control socket event (role, route, outcome), newest first. Requires the admin token.',
  { limit: z.number().optional() },
  async ({ limit }) => {
    try {
      return ok(await api(`/api/audit${limit ? `?limit=${Number(limit)}` : ''}`));
    } catch (error) {
      return fail(error);
    }
  }
);

server.tool(
  'mqtt_admin_pubsub',
  'Per-client subscriptions from the broker admin API (must be configured in the UI first), optionally wildcard-resolved against observed topics — the full "who receives what" map that core MQTT cannot provide.',
  {
    brokerId: z.string(),
    resolve: z.boolean().optional().describe('Also resolve each filter against observed topics.')
  },
  async ({ brokerId, resolve }) => {
    try {
      return ok(await api(`/api/mqtt/brokers/${encodeURIComponent(brokerId)}/admin/pubsub${resolve ? '?resolve=1' : ''}`));
    } catch (error) {
      return fail(error);
    }
  }
);

server.tool(
  'mqtt_subscribe',
  'Subscribe to an MQTT topic filter (supports wildcards + and #).',
  { brokerId: z.string(), topic: z.string(), qos: z.number().optional() },
  async ({ brokerId, topic, qos }) => {
    try {
      return ok(await api(`/api/mqtt/brokers/${encodeURIComponent(brokerId)}/subscribe`, {
        method: 'POST',
        body: JSON.stringify({ topic, qos })
      }));
    } catch (error) {
      return fail(error);
    }
  }
);

server.tool(
  'mqtt_publish',
  'Publish a message to an MQTT topic.',
  {
    brokerId: z.string(),
    topic: z.string(),
    payload: z.string().describe('Message payload (string; send JSON as a stringified value).'),
    qos: z.number().optional(),
    retain: z.boolean().optional()
  },
  async ({ brokerId, topic, payload, qos, retain }) => {
    try {
      return ok(await api(`/api/mqtt/brokers/${encodeURIComponent(brokerId)}/publish`, {
        method: 'POST',
        body: JSON.stringify({ topic, payload, qos, retain })
      }));
    } catch (error) {
      return fail(error);
    }
  }
);

// ---------------------------------------------------------------------------
// OPC UA
// ---------------------------------------------------------------------------
server.tool(
  'opcua_list_connections',
  'List all OPC UA server connections with their status.',
  {},
  async () => {
    try {
      return ok(await api('/api/opcua/connections'));
    } catch (error) {
      return fail(error);
    }
  }
);

server.tool(
  'opcua_connect',
  'Connect to an OPC UA server. Returns a connectionId used by the other opcua_* tools.',
  {
    endpointUrl: z.string().describe('OPC UA endpoint URL, e.g. "opc.tcp://host:4840".'),
    securityMode: z.enum(['None', 'Sign', 'SignAndEncrypt']).optional(),
    securityPolicy: z.string().optional().describe('e.g. "None", "Basic256Sha256".'),
    username: z.string().optional(),
    password: z.string().optional(),
    name: z.string().optional()
  },
  async (args) => {
    try {
      return ok(await api('/api/opcua/connections', { method: 'POST', body: JSON.stringify(args) }));
    } catch (error) {
      return fail(error);
    }
  }
);

server.tool(
  'opcua_disconnect',
  'Disconnect from an OPC UA server.',
  { connectionId: z.string() },
  async ({ connectionId }) => {
    try {
      return ok(await api(`/api/opcua/connections/${encodeURIComponent(connectionId)}`, { method: 'DELETE' }));
    } catch (error) {
      return fail(error);
    }
  }
);

server.tool(
  'opcua_browse',
  'Browse the OPC UA address space at a node. Omit nodeId to start at the Root folder (ns=0;i=84), whose children include the Objects folder (ns=0;i=85). Returns child references for building an address-space tree/graph.',
  {
    connectionId: z.string(),
    nodeId: z.string().optional().describe('Node to browse, e.g. "ns=2;s=Devices". Defaults to Objects root.')
  },
  async ({ connectionId, nodeId }) => {
    try {
      const q = nodeId ? `?nodeId=${encodeURIComponent(nodeId)}` : '';
      return ok(await api(`/api/opcua/connections/${encodeURIComponent(connectionId)}/browse${q}`));
    } catch (error) {
      return fail(error);
    }
  }
);

server.tool(
  'opcua_read',
  'Read the attributes and current value of a single OPC UA node.',
  { connectionId: z.string(), nodeId: z.string() },
  async ({ connectionId, nodeId }) => {
    try {
      const q = `?nodeId=${encodeURIComponent(nodeId)}`;
      return ok(await api(`/api/opcua/connections/${encodeURIComponent(connectionId)}/read${q}`));
    } catch (error) {
      return fail(error);
    }
  }
);

server.tool(
  'opcua_monitor',
  'Start monitoring an OPC UA variable node. Value changes stream live to connected UI clients over WebSocket.',
  {
    connectionId: z.string(),
    nodeId: z.string(),
    samplingInterval: z.number().optional().describe('Sampling interval in ms (default 500).')
  },
  async ({ connectionId, nodeId, samplingInterval }) => {
    try {
      return ok(await api(`/api/opcua/connections/${encodeURIComponent(connectionId)}/monitor`, {
        method: 'POST',
        body: JSON.stringify({ nodeId, samplingInterval })
      }));
    } catch (error) {
      return fail(error);
    }
  }
);

// ---------------------------------------------------------------------------
// CESMII SMIP (Smart Manufacturing Innovation Platform)
// ---------------------------------------------------------------------------
server.tool(
  'cesmii_status',
  'Get the CESMII SMIP connection status (configured, authenticated, endpoint).',
  {},
  async () => {
    try {
      return ok(await api('/api/cesmii/status'));
    } catch (error) {
      return fail(error);
    }
  }
);

server.tool(
  'cesmii_configure',
  'Configure and authenticate the CESMII SMIP GraphQL connection. Runs the two-step JWT handshake and returns status.',
  {
    endpoint: z.string().describe('SMIP GraphQL endpoint, e.g. https://<instance>.cesmii.net/graphql'),
    authenticator: z.string().describe('Registered authenticator name.'),
    role: z.string().describe('GraphQL role for permissions.'),
    userName: z.string().describe('User identifier.'),
    secret: z.string().describe('Authenticator secret / password / API key.')
  },
  async (args) => {
    try {
      return ok(await api('/api/cesmii/config', { method: 'POST', body: JSON.stringify(args) }));
    } catch (error) {
      return fail(error);
    }
  }
);

server.tool(
  'cesmii_list_equipment',
  'List equipment instances (id, displayName) from the configured SMIP instance.',
  {},
  async () => {
    try {
      return ok(await api('/api/cesmii/equipment'));
    } catch (error) {
      return fail(error);
    }
  }
);

server.tool(
  'cesmii_list_attributes',
  'List attributes/tags (id, displayName) from the configured SMIP instance. Attribute ids are used for history queries.',
  {},
  async () => {
    try {
      return ok(await api('/api/cesmii/attributes'));
    } catch (error) {
      return fail(error);
    }
  }
);

server.tool(
  'cesmii_history',
  'Retrieve historical time-series samples for SMIP attribute ids via getRawHistoryDataWithSampling.',
  {
    ids: z.array(z.string()).describe('Attribute/tag ids to query.'),
    startTime: z.string().describe('Start timestamp, e.g. "2024-01-01 00:00:00+00".'),
    endTime: z.string().describe('End timestamp.'),
    maxSamples: z.number().optional().describe('Max samples (0 disables down-sampling, default 100).')
  },
  async (args) => {
    try {
      return ok(await api('/api/cesmii/history', { method: 'POST', body: JSON.stringify(args) }));
    } catch (error) {
      return fail(error);
    }
  }
);

server.tool(
  'cesmii_query',
  'Run a raw GraphQL query against the configured SMIP instance (authenticated).',
  {
    query: z.string().describe('GraphQL query string.'),
    variables: z.record(z.any()).optional().describe('GraphQL variables.')
  },
  async ({ query, variables }) => {
    try {
      return ok(await api('/api/cesmii/query', { method: 'POST', body: JSON.stringify({ query, variables }) }));
    } catch (error) {
      return fail(error);
    }
  }
);

// ---------------------------------------------------------------------------
// i3X (CESMII Common Contextual Manufacturing Information API)
// ---------------------------------------------------------------------------
server.tool(
  'i3x_status',
  'Get the i3X connection status (configured base URL and server /info).',
  {},
  async () => {
    try {
      return ok(await api('/api/i3x/status'));
    } catch (error) {
      return fail(error);
    }
  }
);

server.tool(
  'i3x_connect',
  'Connect to an i3X server by base URL. Verifies it via /info and stores it for subsequent calls.',
  {
    baseUrl: z.string().describe('i3X server base URL, e.g. https://api.i3x.dev/v1'),
    token: z.string().optional().describe('Optional bearer token.')
  },
  async (args) => {
    try {
      return ok(await api('/api/i3x/connect', { method: 'POST', body: JSON.stringify(args) }));
    } catch (error) {
      return fail(error);
    }
  }
);

server.tool(
  'i3x_probe',
  'Check whether a base URL is a live i3X server (calls /info) without changing state.',
  { baseUrl: z.string() },
  async ({ baseUrl }) => {
    try {
      return ok(await api('/api/i3x/probe', { method: 'POST', body: JSON.stringify({ baseUrl }) }));
    } catch (error) {
      return fail(error);
    }
  }
);

server.tool(
  'i3x_namespaces',
  'List namespaces published by the connected i3X server.',
  {},
  async () => {
    try {
      return ok(await api('/api/i3x/namespaces'));
    } catch (error) {
      return fail(error);
    }
  }
);

server.tool(
  'i3x_object_types',
  'List object type definitions from the connected i3X server.',
  { namespaceUri: z.string().optional() },
  async ({ namespaceUri }) => {
    try {
      const q = namespaceUri ? `?namespaceUri=${encodeURIComponent(namespaceUri)}` : '';
      return ok(await api(`/api/i3x/objecttypes${q}`));
    } catch (error) {
      return fail(error);
    }
  }
);

server.tool(
  'i3x_graph',
  'Get the i3X object graph (nodes + hierarchical/composition links) for visualization or reasoning.',
  {
    typeElementId: z.string().optional().describe('Filter to objects of a type.'),
    root: z.string().optional().describe('Start from a specific root object id.')
  },
  async (args) => {
    try {
      const params = new URLSearchParams();
      if (args.typeElementId) params.set('typeElementId', args.typeElementId);
      if (args.root) params.set('root', args.root);
      const q = params.toString() ? `?${params}` : '';
      return ok(await api(`/api/i3x/graph${q}`));
    } catch (error) {
      return fail(error);
    }
  }
);

server.tool(
  'i3x_related',
  'Get objects related to the given object ids (hierarchical, composition, or graph relationships).',
  {
    elementIds: z.array(z.string()),
    relationshipType: z.string().optional()
  },
  async (args) => {
    try {
      return ok(await api('/api/i3x/related', { method: 'POST', body: JSON.stringify(args) }));
    } catch (error) {
      return fail(error);
    }
  }
);

server.tool(
  'i3x_value',
  'Read current value(s) for i3X object ids.',
  { elementIds: z.array(z.string()), maxDepth: z.number().optional() },
  async (args) => {
    try {
      return ok(await api('/api/i3x/value', { method: 'POST', body: JSON.stringify(args) }));
    } catch (error) {
      return fail(error);
    }
  }
);

server.tool(
  'i3x_history',
  'Read historical time-series values for i3X object ids over a time range.',
  {
    elementIds: z.array(z.string()),
    startTime: z.string(),
    endTime: z.string(),
    maxDepth: z.number().optional()
  },
  async (args) => {
    try {
      return ok(await api('/api/i3x/history', { method: 'POST', body: JSON.stringify(args) }));
    } catch (error) {
      return fail(error);
    }
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`Manifold MCP server running (backend: ${API_URL})`);

/**
 * Graph builders: turn domain data into { nodes, links } for the force graph.
 *
 * Node shape: { id, label, group, kind, degree, meta }
 * Link shape: { source, target }
 */

const MESSAGE_TYPE_GROUP = {
  sparkplug: 'sparkplug',
  alarm: 'alarm',
  command: 'command',
  configuration: 'config',
  telemetry: 'telemetry',
  json: 'data',
  text: 'data',
  unknown: 'data'
};

/**
 * Build a hierarchical topic graph from a flat topic list.
 * Each topic "a/b/c" contributes nodes a, a/b, a/b/c linked parent→child, all
 * rooted at the broker node.
 */
export function buildMqttGraph(broker, topics, { maxNodes = Infinity } = {}) {
  const nodes = new Map();
  const links = [];
  let capped = false;

  const rootId = `broker:${broker.id}`;
  nodes.set(rootId, {
    id: rootId,
    label: broker.name || `${broker.host}:${broker.port}`,
    group: 'broker',
    kind: 'broker',
    degree: 0,
    meta: { status: broker.status, brokerId: broker.id }
  });

  for (const t of topics) {
    const segments = t.topic.split('/').filter(Boolean);
    let parentId = rootId;
    let pathAcc = '';

    for (let idx = 0; idx < segments.length; idx++) {
      const seg = segments[idx];
      pathAcc = idx === 0 ? seg : `${pathAcc}/${seg}`;
      const id = `topic:${broker.id}:${pathAcc}`;
      const isLeaf = idx === segments.length - 1;

      if (!nodes.has(id)) {
        // At the node budget: don't add more nodes — roll this (and the rest of
        // the topic) up into a "+N" badge on the nearest kept ancestor so the
        // graph stays renderable at massive scale. The Tree view shows them all.
        if (nodes.size >= maxNodes) {
          const parent = nodes.get(parentId);
          if (parent) parent.collapsedCount = (parent.collapsedCount || 0) + 1;
          capped = true;
          break;
        }
        nodes.set(id, {
          id,
          label: seg,
          group: isLeaf ? MESSAGE_TYPE_GROUP[t.type] || 'data' : 'topic',
          kind: 'topic',
          degree: 0,
          meta: {
            fullTopic: pathAcc,
            brokerId: broker.id,
            isLeaf,
            messageCount: isLeaf ? t.messageCount : undefined,
            lastActivity: isLeaf ? t.lastActivity : undefined,
            type: isLeaf ? t.type : undefined
          }
        });
        links.push({ source: parentId, target: id });
      } else if (isLeaf) {
        const node = nodes.get(id);
        node.group = MESSAGE_TYPE_GROUP[t.type] || 'data';
        node.meta.isLeaf = true;
        node.meta.messageCount = t.messageCount;
        node.meta.lastActivity = t.lastActivity;
        node.meta.type = t.type;
      }
      parentId = id;
    }
  }

  computeDegree(nodes, links);
  return { nodes: Array.from(nodes.values()), links, capped };
}

/**
 * Build an OPC UA address-space graph from a root plus a map of expanded nodes.
 * expanded: Map(nodeId -> references[]) collected as the user drills in.
 */
export function buildOpcuaGraph(connection, expanded) {
  const nodes = new Map();
  const links = [];

  const rootId = `opcua:${connection.id}:root`;
  nodes.set(rootId, {
    id: rootId,
    label: connection.name || connection.endpointUrl,
    group: 'server',
    kind: 'opcua-server',
    degree: 0,
    meta: { connectionId: connection.id, nodeId: 'ns=0;i=84' }
  });

  const nodeIdToGraphId = new Map();
  nodeIdToGraphId.set('ns=0;i=84', rootId);

  for (const [parentNodeId, references] of expanded.entries()) {
    const parentGraphId = nodeIdToGraphId.get(parentNodeId) || rootId;
    for (const ref of references) {
      const graphId = `opcua:${connection.id}:${ref.nodeId}`;
      if (!nodes.has(graphId)) {
        nodes.set(graphId, {
          id: graphId,
          label: ref.displayName || ref.browseName,
          group: opcuaGroup(ref.nodeClass),
          kind: 'opcua-node',
          degree: 0,
          meta: {
            connectionId: connection.id,
            nodeId: ref.nodeId,
            nodeClass: ref.nodeClass,
            browseName: ref.browseName
          }
        });
      }
      nodeIdToGraphId.set(ref.nodeId, graphId);
      links.push({ source: parentGraphId, target: graphId });
    }
  }

  computeDegree(nodes, links);
  return { nodes: Array.from(nodes.values()), links };
}

/**
 * Build an i3X object graph. Objects carry elementId / displayName / parentId /
 * isComposition / typeElementId; hierarchical + composition edges come from
 * parentId. A synthetic server node roots any objects that have no parent.
 */
export function buildI3xGraph(server, objects) {
  const nodes = new Map();
  const links = [];

  const rootId = `i3x:${server.baseUrl}:root`;
  nodes.set(rootId, {
    id: rootId,
    label: server.info?.serverName || server.baseUrl,
    group: 'server',
    kind: 'i3x-server',
    degree: 0,
    meta: { baseUrl: server.baseUrl }
  });

  const ids = new Set(objects.map((o) => o.elementId));
  for (const o of objects) {
    const id = `i3x:${server.baseUrl}:${o.elementId}`;
    nodes.set(id, {
      id,
      label: o.displayName || o.elementId,
      group: o.isComposition ? 'config' : 'topic',
      kind: 'i3x-object',
      degree: 0,
      meta: {
        elementId: o.elementId,
        typeElementId: o.typeElementId || null,
        isComposition: Boolean(o.isComposition)
      }
    });
  }

  for (const o of objects) {
    const childId = `i3x:${server.baseUrl}:${o.elementId}`;
    if (o.parentId && ids.has(o.parentId)) {
      // i3X distinguishes hierarchical vs composition relationships; the renderer
      // draws each edge kind differently (solid / dashed).
      links.push({
        source: `i3x:${server.baseUrl}:${o.parentId}`,
        target: childId,
        kind: o.isComposition ? 'composition' : 'hierarchical'
      });
    } else {
      // Orphan objects attach to the server root so nothing floats free
      links.push({ source: rootId, target: childId, kind: 'hierarchical' });
    }
  }

  computeDegree(nodes, links);
  return { nodes: Array.from(nodes.values()), links };
}

function opcuaGroup(nodeClass) {
  switch (nodeClass) {
    case 'Variable':
      return 'telemetry';
    case 'Object':
      return 'topic';
    case 'Method':
      return 'command';
    case 'ObjectType':
    case 'VariableType':
    case 'DataType':
      return 'config';
    default:
      return 'data';
  }
}

function computeDegree(nodes, links) {
  for (const link of links) {
    const s = nodes.get(link.source);
    const t = nodes.get(link.target);
    if (s) s.degree++;
    if (t) t.degree++;
  }
}

// Stable color assignment per group index, resolved against the active palette.
export const GROUP_ORDER = ['broker', 'server', 'topic', 'telemetry', 'data', 'command', 'config', 'alarm', 'sparkplug'];

export function groupColor(group, palette) {
  const idx = GROUP_ORDER.indexOf(group);
  if (idx === -1) return palette[0];
  return palette[idx % palette.length];
}

/**
 * Collapse subtrees: hide every descendant of a node in `collapsed`, and annotate
 * each collapsed node with `collapsedCount` (number of hidden descendants) so the
 * renderer can show a badge. Works on any parent→child link graph.
 */
export function collapseGraph(graph, collapsed) {
  if (!collapsed || collapsed.size === 0) return graph;

  const childrenOf = new Map();
  for (const l of graph.links) {
    if (!childrenOf.has(l.source)) childrenOf.set(l.source, []);
    childrenOf.get(l.source).push(l.target);
  }

  // Collect all hidden descendants of collapsed roots
  const hidden = new Set();
  const counts = new Map();
  for (const rootId of collapsed) {
    if (!graph.nodes.some((n) => n.id === rootId)) continue;
    let count = 0;
    const stack = [...(childrenOf.get(rootId) || [])];
    const seen = new Set();
    while (stack.length) {
      const id = stack.pop();
      if (seen.has(id)) continue;
      seen.add(id);
      hidden.add(id);
      count++;
      for (const c of childrenOf.get(id) || []) stack.push(c);
    }
    counts.set(rootId, count);
  }

  const nodes = graph.nodes
    .filter((n) => !hidden.has(n.id))
    .map((n) => (counts.has(n.id) ? { ...n, collapsedCount: counts.get(n.id) } : n));
  const links = graph.links.filter((l) => !hidden.has(l.source) && !hidden.has(l.target));
  return { nodes, links };
}

/**
 * Merge several source graphs into one. Node ids are already namespaced per
 * source (broker:/topic:/opcua:/i3x:) so there are no collisions; a `protocol`
 * tag is stamped on every node for color-coding in the unified view.
 */
export function mergeGraphs(parts) {
  const nodes = [];
  const links = [];
  const seen = new Set();
  for (const { protocol, graph } of parts) {
    for (const n of graph.nodes) {
      if (seen.has(n.id)) continue;
      seen.add(n.id);
      nodes.push({ ...n, protocol });
    }
    for (const l of graph.links) links.push(l);
  }
  return { nodes, links };
}

// Protocol → accent color for the unified cross-source view.
export const PROTOCOL_COLORS = {
  mqtt: '#38bdf8',
  opcua: '#a78bfa',
  i3x: '#34d399'
};

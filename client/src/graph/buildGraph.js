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
export function buildMqttGraph(broker, topics) {
  const nodes = new Map();
  const links = [];

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

    segments.forEach((seg, idx) => {
      pathAcc = idx === 0 ? seg : `${pathAcc}/${seg}`;
      const id = `topic:${broker.id}:${pathAcc}`;
      const isLeaf = idx === segments.length - 1;

      if (!nodes.has(id)) {
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
        // Existing intermediate node is now also a leaf — refresh its metadata
        const node = nodes.get(id);
        node.group = MESSAGE_TYPE_GROUP[t.type] || 'data';
        node.meta.isLeaf = true;
        node.meta.messageCount = t.messageCount;
        node.meta.lastActivity = t.lastActivity;
        node.meta.type = t.type;
      }
      parentId = id;
    });
  }

  computeDegree(nodes, links);
  return { nodes: Array.from(nodes.values()), links };
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
      links.push({ source: `i3x:${server.baseUrl}:${o.parentId}`, target: childId });
    } else {
      // Orphan objects attach to the server root so nothing floats free
      links.push({ source: rootId, target: childId });
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

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

/**
 * Build a Sparkplug B device topology graph: Broker → Group → Edge Node → Device.
 * These are REAL publishing endpoints (identity from the Sparkplug topic + BIRTH
 * certificates), not topic strings. Online endpoints are grouped as 'telemetry',
 * offline (post-DEATH) as 'alarm' so the renderer colors them distinctly.
 */
export function buildSparkplugGraph(broker, topology) {
  const nodes = new Map();
  const links = [];
  const rootId = `sp:${broker.id}:root`;
  nodes.set(rootId, {
    id: rootId,
    label: broker.name || `${broker.host}:${broker.port}`,
    group: 'broker',
    kind: 'broker',
    degree: 0,
    meta: { brokerId: broker.id }
  });

  const stateGroup = (online) => (online ? 'telemetry' : 'alarm');

  for (const g of topology.groups || []) {
    const groupId = `sp:${broker.id}:g:${g.id}`;
    nodes.set(groupId, {
      id: groupId,
      label: g.id,
      group: 'topic',
      kind: 'sparkplug-group',
      degree: 0,
      meta: { kind: 'group', edgeNodes: g.edgeNodes.length }
    });
    links.push({ source: rootId, target: groupId });

    for (const e of g.edgeNodes) {
      const edgeId = `sp:${broker.id}:e:${g.id}/${e.id}`;
      nodes.set(edgeId, {
        id: edgeId,
        label: e.id,
        group: stateGroup(e.online),
        kind: 'sparkplug-edge',
        degree: 0,
        meta: {
          kind: 'edgeNode',
          online: e.online,
          metrics: e.metrics,
          msgCount: e.msgCount,
          lastSeen: e.lastSeen,
          lastBirth: e.lastBirth,
          lastDeath: e.lastDeath,
          deviceCount: e.devices.length
        }
      });
      links.push({ source: groupId, target: edgeId });

      for (const d of e.devices) {
        const devId = `sp:${broker.id}:d:${g.id}/${e.id}/${d.id}`;
        nodes.set(devId, {
          id: devId,
          label: d.id,
          group: stateGroup(d.online),
          kind: 'sparkplug-device',
          degree: 0,
          meta: {
            kind: 'device',
            online: d.online,
            metrics: d.metrics,
            msgCount: d.msgCount,
            lastSeen: d.lastSeen,
            lastBirth: d.lastBirth,
            lastDeath: d.lastDeath
          }
        });
        links.push({ source: edgeId, target: devId });
      }
    }
  }

  computeDegree(nodes, links);
  return { nodes: Array.from(nodes.values()), links };
}

/**
 * Build a wildcard-RESOLVED consumer lineage graph:
 *
 *   Broker → Client → Filter (with exact match count) → matched subtree ROOTS
 *          → (lazily expanded) topic hierarchy → concrete leaf topics
 *
 * A filter is a query, not a destination — `spBv1.0/#` from two clients can
 * cover completely different concrete topics. `resolution.byFilter` (from the
 * server trie) supplies exact matchCounts + covering roots per filter, so shared
 * filters remain visible hubs but no longer HIDE what each actually receives.
 * `expanded` is a Map(path -> children[]) from /topictree, so leaves appear only
 * where the user drills in; children beyond the budget roll into collapsedCount
 * ("+N") badges. Filters that match nothing are flagged (group 'alarm') —
 * dormant subscriptions are an audit finding, not noise.
 */
export function buildLineageGraph(broker, { clients = [], subscriptions = [] }, resolution = null, expanded = null) {
  const nodes = new Map();
  const links = [];
  const rootId = `ps:${broker.id}:root`;
  nodes.set(rootId, {
    id: rootId,
    label: broker.name || `${broker.host}:${broker.port}`,
    group: 'broker',
    kind: 'broker',
    degree: 0,
    meta: { brokerId: broker.id }
  });

  for (const c of clients) {
    const id = `ps:${broker.id}:c:${c.id}`;
    nodes.set(id, {
      id,
      label: c.id,
      group: c.connected ? 'telemetry' : 'alarm',
      kind: 'mqtt-client',
      degree: 0,
      meta: { kind: 'client', username: c.username, ip: c.ip, connected: c.connected, subscriptionsCount: c.subscriptionsCount }
    });
    links.push({ source: rootId, target: id });
  }

  // Filter nodes (shared across clients — fan-out is real signal).
  const byFilter = resolution?.byFilter || {};
  const filterIds = new Map(); // filter -> node id
  for (const s of subscriptions) {
    const clientNode = `ps:${broker.id}:c:${s.clientId}`;
    if (!nodes.has(clientNode)) {
      nodes.set(clientNode, {
        id: clientNode,
        label: s.clientId,
        group: 'telemetry',
        kind: 'mqtt-client',
        degree: 0,
        meta: { kind: 'client' }
      });
      links.push({ source: rootId, target: clientNode });
    }
    let fid = filterIds.get(s.topic);
    if (!fid) {
      fid = `ps:${broker.id}:f:${s.topic}`;
      filterIds.set(s.topic, fid);
      const r = byFilter[s.topic];
      const dormant = r ? r.matchCount === 0 : false;
      nodes.set(fid, {
        id: fid,
        label: r ? `${s.topic}  ·  ${r.matchCount.toLocaleString()}` : s.topic,
        group: dormant ? 'alarm' : 'topic',
        kind: 'sub-filter',
        degree: 0,
        meta: {
          kind: 'filter',
          topic: s.topic,
          matchCount: r?.matchCount ?? null,
          dormant,
          share: r?.share || null,
          roots: r?.roots || [],
          rootsTruncated: r?.rootsTruncated || false,
          sample: r?.sample || [],
          sampleTruncated: r?.sampleTruncated || false
        }
      });
    }
    links.push({ source: clientNode, target: fid, kind: 'subscribe' });
  }

  // Covering-root aggregates under each resolved filter: `spBv1.0/#` links to a
  // `spBv1.0 (15,234)` aggregate instead of an opaque hub — expandable to leaves.
  const aggIds = new Map(); // path -> node id (shared across filters covering the same subtree)
  const ensureAgg = (path, count, isLeaf) => {
    let id = aggIds.get(path);
    if (id) return id;
    id = `ps:${broker.id}:t:${path}`;
    aggIds.set(path, id);
    if (!nodes.has(id)) {
      nodes.set(id, {
        id,
        label: isLeaf ? path.split('/').pop() : `${path.split('/').pop()} · ${count.toLocaleString()}`,
        group: isLeaf ? 'data' : 'config',
        kind: isLeaf ? 'topic-leaf' : 'topic-agg',
        degree: 0,
        collapsedCount: !isLeaf && !expanded?.has(path) ? count : 0,
        meta: { kind: isLeaf ? 'topic' : 'aggregate', path, subtreeCount: count, expandable: !isLeaf }
      });
    }
    return id;
  };

  for (const [filter, fid] of filterIds) {
    const r = byFilter[filter];
    if (!r) continue;
    for (const root of r.roots) {
      const aggId = ensureAgg(root.prefix, root.count, root.isLeaf);
      links.push({ source: fid, target: aggId, kind: 'resolves' });
    }
  }

  // Lazily expanded levels: children fetched from /topictree appear under their
  // parent aggregate, leaves as concrete topics.
  if (expanded) {
    for (const [path, children] of expanded) {
      const parentId = aggIds.get(path) || `ps:${broker.id}:t:${path}`;
      if (!nodes.has(parentId)) continue;
      nodes.get(parentId).collapsedCount = 0;
      for (const child of children) {
        const childId = ensureAgg(child.path, child.subtreeCount, child.isTopic && child.subtreeCount === 1);
        links.push({ source: parentId, target: childId, kind: 'topic' });
      }
    }
  }

  computeDegree(nodes, links);
  return { nodes: Array.from(nodes.values()), links };
}

/**
 * Turn a set of resolved filters into matchIds for coverage paint on the real
 * topic-hierarchy graph (buildMqttGraph id scheme: `topic:${brokerId}:${path}`).
 * Includes every ancestor of each matched path so the painted trail runs from
 * the broker all the way down to the leaves the client actually receives.
 */
export function coverageToMatchIds(brokerId, results) {
  const ids = new Set();
  const addWithAncestors = (path) => {
    const segs = path.split('/').filter(Boolean);
    let acc = '';
    for (let i = 0; i < segs.length; i++) {
      acc = i === 0 ? segs[i] : `${acc}/${segs[i]}`;
      ids.add(`topic:${brokerId}:${acc}`);
    }
  };
  for (const r of results || []) {
    for (const root of r.roots || []) addWithAncestors(root.prefix);
    for (const s of r.sample || []) addWithAncestors(s.topic);
  }
  return ids;
}

/**
 * (Legacy) flat pub/sub graph: Broker → Client → literal filter strings. Kept for
 * reference; the Flows view uses buildLineageGraph, which resolves wildcards.
 */
export function buildPubSubGraph(broker, { clients = [], subscriptions = [] }) {
  const nodes = new Map();
  const links = [];
  const rootId = `ps:${broker.id}:root`;
  nodes.set(rootId, {
    id: rootId,
    label: broker.name || `${broker.host}:${broker.port}`,
    group: 'broker',
    kind: 'broker',
    degree: 0,
    meta: { brokerId: broker.id }
  });

  for (const c of clients) {
    const id = `ps:${broker.id}:c:${c.id}`;
    nodes.set(id, {
      id,
      label: c.id,
      group: c.connected ? 'telemetry' : 'alarm',
      kind: 'mqtt-client',
      degree: 0,
      meta: { kind: 'client', username: c.username, ip: c.ip, connected: c.connected, subscriptionsCount: c.subscriptionsCount }
    });
    links.push({ source: rootId, target: id });
  }

  for (const s of subscriptions) {
    const clientNode = `ps:${broker.id}:c:${s.clientId}`;
    if (!nodes.has(clientNode)) {
      // A subscription for a client not in the clients list — add a stub client.
      nodes.set(clientNode, {
        id: clientNode,
        label: s.clientId,
        group: 'telemetry',
        kind: 'mqtt-client',
        degree: 0,
        meta: { kind: 'client' }
      });
      links.push({ source: rootId, target: clientNode });
    }
    const topicId = `ps:${broker.id}:t:${s.topic}`;
    if (!nodes.has(topicId)) {
      nodes.set(topicId, {
        id: topicId,
        label: s.topic,
        group: 'topic',
        kind: 'sub-filter',
        degree: 0,
        meta: { kind: 'filter', topic: s.topic }
      });
    }
    links.push({ source: clientNode, target: topicId, kind: 'subscribe' });
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

// Fixed, semantic colour per node group. Previously groupColor indexed into the
// active style's palette (palette[idx % len]) — but the styles are short and
// sometimes single-hue, so different groups collided to the SAME colour and the
// legend couldn't tell them apart. These nine distinct hues are shared by every
// renderer AND the legend (both call groupColor), so the legend always matches
// the on-screen node colour, and each group is now visually distinct.
export const GROUP_COLORS = {
  broker: '#a78bfa', // violet — the root/broker
  server: '#818cf8', // indigo — OPC UA / i3X server root
  topic: '#38bdf8', // sky — branch (intermediate topic)
  telemetry: '#34d399', // green — live/connected telemetry
  data: '#fbbf24', // amber — leaf data topics
  command: '#f472b6', // pink — command topics
  config: '#2dd4bf', // teal — configuration
  alarm: '#fb7185', // red — alarm / offline / dormant
  sparkplug: '#fb923c' // orange — Sparkplug
};

export function groupColor(group, palette) {
  return GROUP_COLORS[group] || palette?.[0] || '#38bdf8';
}

/**
 * Merge every connected broker into one graph, each broker's topic tree hanging
 * off a synthetic "All brokers" root. Node ids are already namespaced per broker
 * (broker:ID, topic:ID:PATH) so there are no collisions. A per-broker node budget
 * keeps one busy broker from crowding out the others.
 */
export function buildAllBrokersGraph(brokers, topicsByBroker, { maxNodes = Infinity } = {}) {
  const perBrokerCap = Number.isFinite(maxNodes) ? Math.max(50, Math.floor(maxNodes / Math.max(1, brokers.length))) : Infinity;
  const rootId = 'all:root';
  const nodes = [{ id: rootId, label: 'All brokers', group: 'broker', kind: 'all-root', degree: 0, meta: { allBrokers: true } }];
  const links = [];
  for (const b of brokers) {
    const g = buildMqttGraph(b, topicsByBroker[b.id] || [], { maxNodes: perBrokerCap });
    for (const n of g.nodes) nodes.push(n);
    for (const l of g.links) links.push(l);
    // Hang each broker's root under the synthetic all-root.
    if (g.nodes.some((n) => n.id === `broker:${b.id}`)) links.push({ source: rootId, target: `broker:${b.id}`, kind: 'broker' });
  }
  return { nodes, links };
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

import { api } from '@/lib/api';

/**
 * UNS mounts: graft non-MQTT sources (OPC UA address space, the i3X object
 * graph) into the Unified Namespace forest as additional roots. This is what
 * moves the UNS view past "MQTT visualization" — one namespace, many fabrics.
 *
 * Builders return nodes in the exact shape buildUnsTree produces
 * ({ id, path, name, depth, brokerId, children: Map, topicCount }) so the
 * topology renderer, tree view, and detail panel need no special cases.
 * `brokerId` is the mount pseudo-id (`mount:<id>`) — liveness/value maps are
 * keyed by it, so mounted nodes simply have no live state (honest: we're
 * mirroring structure, not subscribing to data).
 */

const OPCUA_CHILD_CAP = 50; // per browsed level
const OPCUA_TOTAL_CAP = 400; // per mount
const I3X_NODE_CAP = 2000;

function makeNode(mountKey, path, name, depth) {
  return {
    id: `uns:${mountKey}:${path}`,
    path,
    name,
    depth,
    brokerId: mountKey,
    children: new Map(),
    topicCount: 0
  };
}

/** i3X: full object list -> tree via parentId. */
async function buildI3xRoot(mount) {
  const mountKey = `mount:${mount.id}`;
  const { objects = [] } = await api.i3xObjects();
  const root = makeNode(mountKey, '', mount.label || 'i3X namespace', 0);
  root.sourceType = 'i3x';

  const byId = new Map();
  for (const o of objects.slice(0, I3X_NODE_CAP)) byId.set(o.elementId, o);

  // Resolve each object's ancestor chain to place it; memoized by elementId.
  const placed = new Map(); // elementId -> node
  const place = (obj, guard = 0) => {
    if (placed.has(obj.elementId)) return placed.get(obj.elementId);
    let parentNode = root;
    if (obj.parentId && byId.has(obj.parentId) && guard < 50) {
      parentNode = place(byId.get(obj.parentId), guard + 1);
    }
    const name = obj.displayName || obj.elementId;
    let node = parentNode.children.get(name);
    if (!node) {
      const path = parentNode.path ? `${parentNode.path}/${name}` : name;
      node = makeNode(mountKey, path, name, parentNode.depth + 1);
      node.meta = { elementId: obj.elementId };
      parentNode.children.set(name, node);
    }
    placed.set(obj.elementId, node);
    return node;
  };
  for (const o of byId.values()) place(o);

  // topicCount = leaves at-or-below, mirroring buildUnsTree semantics.
  const count = (n) => {
    if (n.children.size === 0) {
      n.topicCount = 1;
      return 1;
    }
    let sum = 0;
    for (const c of n.children.values()) sum += count(c);
    n.topicCount = sum;
    return sum;
  };
  count(root);
  return root;
}

/** OPC UA: shallow browse (2 levels, capped) from the mount's start node. */
async function buildOpcuaRoot(mount, connection) {
  const mountKey = `mount:${mount.id}`;
  const root = makeNode(mountKey, '', mount.label || connection?.name || 'OPC UA', 0);
  root.sourceType = 'opcua';
  let total = 0;

  const browseInto = async (parentNode, nodeId, depth) => {
    if (depth > 2 || total >= OPCUA_TOTAL_CAP) return;
    let res;
    try {
      res = await api.opcuaBrowse(mount.connectionId, nodeId);
    } catch {
      return; // node not browsable — keep what we have
    }
    for (const ref of (res.references || []).slice(0, OPCUA_CHILD_CAP)) {
      if (total >= OPCUA_TOTAL_CAP) break;
      const name = ref.displayName || ref.browseName || ref.nodeId;
      if (parentNode.children.has(name)) continue;
      const path = parentNode.path ? `${parentNode.path}/${name}` : name;
      const node = makeNode(mountKey, path, name, parentNode.depth + 1);
      node.meta = { nodeId: ref.nodeId };
      parentNode.children.set(name, node);
      total++;
      await browseInto(node, ref.nodeId, depth + 1);
    }
  };
  await browseInto(root, mount.nodeId || undefined, 1);

  const count = (n) => {
    if (n.children.size === 0) {
      n.topicCount = 1;
      return 1;
    }
    let sum = 0;
    for (const c of n.children.values()) sum += count(c);
    n.topicCount = sum;
    return sum;
  };
  count(root);
  return root;
}

/**
 * Build UNS roots for all mounts. Failures are per-mount (a dead source yields
 * a stub root labeled unavailable rather than sinking the whole forest).
 */
export async function buildMountRoots(mounts, { opcuaConnections = [] } = {}) {
  const out = [];
  for (const mount of mounts) {
    try {
      if (mount.type === 'i3x') {
        out.push(await buildI3xRoot(mount));
      } else if (mount.type === 'opcua') {
        const conn = opcuaConnections.find((c) => c.id === mount.connectionId);
        out.push(await buildOpcuaRoot(mount, conn));
      }
    } catch {
      const stub = makeNode(`mount:${mount.id}`, '', `${mount.label || mount.type} (unavailable)`, 0);
      stub.sourceType = mount.type;
      out.push(stub);
    }
  }
  return out;
}

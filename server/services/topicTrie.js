'use strict';

/**
 * Topic trie: resolves MQTT subscription FILTERS against the set of actually
 * observed topics.
 *
 * A subscription like `spBv1.0/#` is a query, not a destination — two clients on
 * the same broad filter can effectively receive completely different concrete
 * topics. Collapsing them onto one filter-string node hides that. This trie
 * answers, for any filter: exactly how many observed topics it matches, the
 * minimal set of matched subtree roots (for aggregated display), and a bounded
 * sample of concrete matched topics (for drill-down to real leaves like
 * `spBv1.0/Plant-A/DDATA/EdgeNode-01/Pump-7`).
 *
 * Semantics implemented (MQTT 3.1.1 / 5.0):
 * - `+` matches exactly one level; `#` matches the remainder (including zero
 *   levels: `a/#` matches `a`).
 * - Wildcards at the FIRST level do not match topics beginning with `$`
 *   (`#` must not claim `$SYS/...`); explicit `$SYS/...` filters match normally.
 * - `$share/{group}/{filter}` (shared subscriptions, as reported by EMQX) is
 *   normalized to `{filter}` with the share group reported alongside.
 * - Empty segments are preserved (`a//b` is a legal three-level topic).
 *
 * Costs: insert O(depth). Literal resolve O(depth). `+` fans out only at its own
 * level. `#` match COUNTS are O(1) via `subtreeCount` maintained on insert —
 * counts are always exact even when samples/roots are truncated. Sample
 * collection walks at most `sampleLimit` leaves (DFS, namespace order).
 */

class TrieNode {
  constructor() {
    this.children = null; // Map(segment -> TrieNode), lazily created
    this.slot = -1; // >= 0 iff a topic terminates here
    this.subtreeCount = 0; // number of terminal topics at-or-below this node
  }
}

class TopicTrie {
  constructor() {
    this.root = new TrieNode();
  }

  /** Insert an observed topic. O(segments). Idempotent per (topic, slot). */
  insert(topic, slot) {
    // Keep empty segments: "a//b".split('/') -> ['a','','b'] is correct MQTT.
    const segments = topic.split('/');
    let node = this.root;
    const path = [node];
    for (const seg of segments) {
      if (!node.children) node.children = new Map();
      let child = node.children.get(seg);
      if (!child) {
        child = new TrieNode();
        node.children.set(seg, child);
      }
      node = child;
      path.push(node);
    }
    if (node.slot >= 0) {
      node.slot = slot; // re-observation of a known topic: refresh slot, no recount
      return;
    }
    node.slot = slot;
    for (const n of path) n.subtreeCount++;
  }

  /**
   * Resolve one filter. Returns:
   *   { filter, share, kind: 'exact'|'wildcard', matchCount,
   *     roots: [{ prefix, count, isLeaf }], rootsTruncated,
   *     sample: [{ topic, slot }], sampleTruncated }
   * `matchCount` is always exact. `roots` is the minimal covering set of matched
   * subtree roots (one per `#`-anchored subtree / per terminal for `+`/literal).
   */
  resolve(rawFilter, { sampleLimit = 100, rootsLimit = 50 } = {}) {
    let filter = String(rawFilter);
    let share = null;
    // Normalize EMQX shared subscriptions: $share/{group}/{actual filter}
    if (filter.startsWith('$share/')) {
      const rest = filter.slice('$share/'.length);
      const slash = rest.indexOf('/');
      if (slash > 0) {
        share = rest.slice(0, slash);
        filter = rest.slice(slash + 1);
      }
    }

    const parts = filter.split('/');
    const wildcard = parts.includes('#') || parts.includes('+');

    if (!wildcard) {
      // Exact-topic subscription: O(depth) walk.
      let node = this.root;
      for (const seg of parts) {
        node = node.children?.get(seg);
        if (!node) break;
      }
      const hit = Boolean(node && node.slot >= 0);
      return {
        filter: rawFilter,
        share,
        kind: 'exact',
        matchCount: hit ? 1 : 0,
        roots: hit ? [{ prefix: filter, count: 1, isLeaf: true }] : [],
        rootsTruncated: false,
        sample: hit ? [{ topic: filter, slot: node.slot }] : [],
        sampleTruncated: false
      };
    }

    // Wildcard: walk the trie, fanning out at `+`, stopping at `#`.
    // `frontier` holds { node, prefixSegs } pairs still alive at this depth.
    let frontier = [{ node: this.root, prefix: null }];
    let matchCount = 0;
    const roots = []; // covering set
    let rootsTruncated = false;
    const terminalNodes = []; // nodes whose subtree (or self) is fully matched

    for (let i = 0; i < parts.length; i++) {
      const seg = parts[i];
      const first = i === 0;

      if (seg === '#') {
        // `#` matches the remainder INCLUDING zero levels: each frontier node's
        // whole subtree matches, plus the node itself if it's a terminal.
        for (const f of frontier) {
          if (f.node === this.root) {
            // Filter is exactly `#` (or `$share/g/#`): match every root child
            // except `$...` (MQTT spec), counting exactly.
            for (const [cSeg, child] of f.node.children || []) {
              if (cSeg.startsWith('$')) continue;
              matchCount += child.subtreeCount;
              terminalNodes.push({ node: child, prefix: cSeg });
              if (roots.length < rootsLimit) {
                roots.push({ prefix: cSeg, count: child.subtreeCount, isLeaf: child.slot >= 0 && child.subtreeCount === 1 });
              } else rootsTruncated = true;
            }
          } else {
            matchCount += f.node.subtreeCount;
            terminalNodes.push(f);
            if (roots.length < rootsLimit) {
              roots.push({ prefix: f.prefix, count: f.node.subtreeCount, isLeaf: f.node.slot >= 0 && f.node.subtreeCount === 1 });
            } else rootsTruncated = true;
          }
        }
        frontier = [];
        break;
      }

      const next = [];
      for (const f of frontier) {
        const kids = f.node.children;
        if (!kids) continue;
        if (seg === '+') {
          for (const [cSeg, child] of kids) {
            if (first && cSeg.startsWith('$')) continue; // `+` at level 1 skips $-topics
            next.push({ node: child, prefix: f.prefix === null ? cSeg : `${f.prefix}/${cSeg}` });
          }
        } else {
          const child = kids.get(seg);
          if (child) next.push({ node: child, prefix: f.prefix === null ? seg : `${f.prefix}/${seg}` });
        }
      }
      frontier = next;
      if (frontier.length === 0) break;
    }

    // If we consumed all parts without hitting `#`, the surviving frontier nodes
    // that are terminals are the matches (e.g. `factory/+/temp`).
    if (frontier.length) {
      for (const f of frontier) {
        if (f.node.slot >= 0) {
          matchCount += 1;
          terminalNodes.push({ node: f.node, prefix: f.prefix, exactOnly: true });
          if (roots.length < rootsLimit) roots.push({ prefix: f.prefix, count: 1, isLeaf: true });
          else rootsTruncated = true;
        }
      }
    }

    // Bounded DFS sample of concrete matched topics, in namespace order.
    const sample = [];
    let sampleTruncated = false;
    outer: for (const t of terminalNodes) {
      if (t.exactOnly) {
        if (sample.length >= sampleLimit) { sampleTruncated = true; break; }
        sample.push({ topic: t.prefix, slot: t.node.slot });
        continue;
      }
      // full-subtree match: DFS from t.node
      const stack = [{ node: t.node, prefix: t.prefix }];
      while (stack.length) {
        const { node, prefix } = stack.pop();
        if (node.slot >= 0) {
          if (sample.length >= sampleLimit) { sampleTruncated = true; break outer; }
          sample.push({ topic: prefix, slot: node.slot });
        }
        if (node.children) {
          // push in reverse key order so pops come out in insertion order
          const entries = [...node.children];
          for (let k = entries.length - 1; k >= 0; k--) {
            stack.push({ node: entries[k][1], prefix: `${prefix}/${entries[k][0]}` });
          }
        }
      }
    }
    if (!sampleTruncated && matchCount > sample.length) sampleTruncated = true;

    return { filter: rawFilter, share, kind: 'wildcard', matchCount, roots, rootsTruncated, sample, sampleTruncated };
  }

  /**
   * Children of a prefix, for lazy drill-down. Returns
   * [{ segment, path, subtreeCount, isTopic }] in insertion order, capped.
   */
  children(prefix, { limit = 500 } = {}) {
    let node = this.root;
    if (prefix != null && prefix !== '') {
      for (const seg of String(prefix).split('/')) {
        node = node.children?.get(seg);
        if (!node) return { prefix, children: [], truncated: false };
      }
    }
    const out = [];
    let truncated = false;
    for (const [seg, child] of node.children || []) {
      if (out.length >= limit) { truncated = true; break; }
      out.push({
        segment: seg,
        path: prefix ? `${prefix}/${seg}` : seg,
        subtreeCount: child.subtreeCount,
        isTopic: child.slot >= 0
      });
    }
    return { prefix: prefix || '', children: out, truncated };
  }
}

module.exports = TopicTrie;

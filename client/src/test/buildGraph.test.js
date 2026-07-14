import { describe, it, expect } from 'vitest';
import { buildMqttGraph, collapseGraph, coverageToMatchIds, mergeGraphs } from '@/graph/buildGraph';

const broker = { id: 'bk1', name: 'test broker' };
const topics = [
  { topic: 'plant/line1/temp', type: 'telemetry', messageCount: 5 },
  { topic: 'plant/line1/press', type: 'telemetry', messageCount: 2 },
  { topic: 'plant/line2/state', type: 'json', messageCount: 1 }
];

describe('buildMqttGraph', () => {
  it('builds the hierarchy rooted at the broker', () => {
    const g = buildMqttGraph(broker, topics);
    const ids = g.nodes.map((n) => n.id);
    expect(ids).toContain('broker:bk1');
    expect(ids).toContain('topic:bk1:plant');
    expect(ids).toContain('topic:bk1:plant/line1');
    expect(ids).toContain('topic:bk1:plant/line1/temp');
    // one link per parent->child relation, no duplicates
    const linkKeys = g.links.map((l) => `${l.source}>${l.target}`);
    expect(new Set(linkKeys).size).toBe(linkKeys.length);
    expect(linkKeys).toContain('broker:bk1>topic:bk1:plant');
    expect(linkKeys).toContain('topic:bk1:plant>topic:bk1:plant/line1');
  });

  it('caps node count when maxNodes is set', () => {
    const many = Array.from({ length: 100 }, (_, i) => ({ topic: `t/${i}`, type: 'text', messageCount: 1 }));
    const g = buildMqttGraph(broker, many, { maxNodes: 20 });
    expect(g.nodes.length).toBeLessThanOrEqual(21); // broker + cap
  });
});

describe('collapseGraph', () => {
  it('hides descendants of a collapsed node and annotates the count', () => {
    const g = buildMqttGraph(broker, topics);
    const collapsed = collapseGraph(g, new Set(['topic:bk1:plant/line1']));
    const ids = collapsed.nodes.map((n) => n.id);
    expect(ids).toContain('topic:bk1:plant/line1');
    expect(ids).not.toContain('topic:bk1:plant/line1/temp');
    expect(ids).not.toContain('topic:bk1:plant/line1/press');
    const root = collapsed.nodes.find((n) => n.id === 'topic:bk1:plant/line1');
    expect(root.collapsedCount).toBe(2);
    // no dangling links into hidden nodes
    for (const l of collapsed.links) {
      expect(ids).toContain(l.source);
      expect(ids).toContain(l.target);
    }
  });

  it('is a no-op for an empty collapse set', () => {
    const g = buildMqttGraph(broker, topics);
    expect(collapseGraph(g, new Set())).toBe(g);
  });
});

describe('coverageToMatchIds', () => {
  it('includes matched paths AND their ancestors so painted coverage is connected', () => {
    const ids = coverageToMatchIds('bk1', [
      { roots: [{ prefix: 'plant/line1' }], sample: [{ topic: 'plant/line1/temp' }] }
    ]);
    expect(ids.has('topic:bk1:plant')).toBe(true);
    expect(ids.has('topic:bk1:plant/line1')).toBe(true);
    expect(ids.has('topic:bk1:plant/line1/temp')).toBe(true);
    expect(ids.has('topic:bk1:plant/line2')).toBe(false);
  });
});

describe('mergeGraphs', () => {
  it('concatenates parts and dedupes node ids', () => {
    const a = buildMqttGraph(broker, topics.slice(0, 1));
    const b = buildMqttGraph(broker, topics.slice(0, 2));
    const merged = mergeGraphs([
      { protocol: 'mqtt', graph: a },
      { protocol: 'mqtt', graph: b }
    ]);
    const ids = merged.nodes.map((n) => n.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

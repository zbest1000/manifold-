const { test } = require('node:test');
const assert = require('node:assert');

const TopicTrie = require('../services/topicTrie');

function trieOf(topics) {
  const t = new TopicTrie();
  topics.forEach((topic, i) => t.insert(topic, i));
  return t;
}

const FLEET = [
  'spBv1.0/Plant-A/NBIRTH/EdgeNode-01',
  'spBv1.0/Plant-A/DDATA/EdgeNode-01/Pump-7',
  'spBv1.0/Plant-A/DDATA/EdgeNode-01/Valve-3',
  'spBv1.0/Plant-B/DDATA/EdgeNode-09/Sensor-A',
  'factory/line1/dev1/temp',
  'factory/line1/dev2/temp',
  'factory/line2/dev3/temp',
  'factory/line1/dev1/pressure',
  'alerts/high',
  '$SYS/broker/version',
  '$SYS/broker/clients/connected'
];

test('exact filter: hit and miss', () => {
  const t = trieOf(FLEET);
  const hit = t.resolve('alerts/high');
  assert.strictEqual(hit.kind, 'exact');
  assert.strictEqual(hit.matchCount, 1);
  assert.deepStrictEqual(hit.sample, [{ topic: 'alerts/high', slot: 8 }]);

  const miss = t.resolve('alerts/low');
  assert.strictEqual(miss.matchCount, 0);
  assert.deepStrictEqual(miss.sample, []);
});

test('# resolves a whole subtree with exact count and concrete leaves', () => {
  const t = trieOf(FLEET);
  const r = t.resolve('spBv1.0/#');
  assert.strictEqual(r.kind, 'wildcard');
  assert.strictEqual(r.matchCount, 4);
  assert.deepStrictEqual(r.roots, [{ prefix: 'spBv1.0', count: 4, isLeaf: false }]);
  const topics = r.sample.map((s) => s.topic).sort();
  assert.deepStrictEqual(topics, [
    'spBv1.0/Plant-A/DDATA/EdgeNode-01/Pump-7',
    'spBv1.0/Plant-A/DDATA/EdgeNode-01/Valve-3',
    'spBv1.0/Plant-A/NBIRTH/EdgeNode-01',
    'spBv1.0/Plant-B/DDATA/EdgeNode-09/Sensor-A'
  ]);
});

test('+ matches exactly one level', () => {
  const t = trieOf(FLEET);
  const r = t.resolve('factory/+/dev1/temp');
  assert.strictEqual(r.matchCount, 1);
  assert.deepStrictEqual(r.sample.map((s) => s.topic), ['factory/line1/dev1/temp']);

  const r2 = t.resolve('factory/line1/+/temp');
  assert.strictEqual(r2.matchCount, 2);
  assert.deepStrictEqual(r2.sample.map((s) => s.topic).sort(), ['factory/line1/dev1/temp', 'factory/line1/dev2/temp']);
});

test('a/# includes a itself (zero-level match)', () => {
  const t = trieOf(['a', 'a/b', 'a/b/c']);
  const r = t.resolve('a/#');
  assert.strictEqual(r.matchCount, 3);
  assert.ok(r.sample.some((s) => s.topic === 'a'));
});

test('root wildcards do not match $-topics; explicit $SYS filters do', () => {
  const t = trieOf(FLEET);
  const all = t.resolve('#');
  // 11 topics minus the two $SYS ones
  assert.strictEqual(all.matchCount, 9);
  assert.ok(!all.sample.some((s) => s.topic.startsWith('$')));

  const plus = t.resolve('+/broker/version');
  assert.strictEqual(plus.matchCount, 0, '+ at level 1 must not match $SYS');

  const sys = t.resolve('$SYS/#');
  assert.strictEqual(sys.matchCount, 2);
  const sysExact = t.resolve('$SYS/broker/+');
  assert.strictEqual(sysExact.matchCount, 1); // version (clients/connected is deeper)
});

test('$share/{group}/{filter} normalizes and reports the group', () => {
  const t = trieOf(FLEET);
  const r = t.resolve('$share/analytics/factory/#');
  assert.strictEqual(r.share, 'analytics');
  assert.strictEqual(r.matchCount, 4);
});

test('empty segments are preserved (a//b)', () => {
  const t = trieOf(['a//b', 'a/x/b']);
  assert.strictEqual(t.resolve('a//b').matchCount, 1);
  assert.strictEqual(t.resolve('a/+/b').matchCount, 2);
});

test('matchCount stays exact when sample and roots truncate', () => {
  const topics = [];
  for (let i = 0; i < 500; i++) topics.push(`big/ns${i % 100}/dev${i}`);
  const t = trieOf(topics);
  const r = t.resolve('big/#', { sampleLimit: 10, rootsLimit: 5 });
  assert.strictEqual(r.matchCount, 500);
  assert.strictEqual(r.sample.length, 10);
  assert.ok(r.sampleTruncated);
  assert.deepStrictEqual(r.roots, [{ prefix: 'big', count: 500, isLeaf: false }]); // one covering root, no truncation needed
  const plus = t.resolve('big/+/#', { sampleLimit: 10, rootsLimit: 5 });
  assert.strictEqual(plus.matchCount, 500);
  assert.strictEqual(plus.roots.length, 5);
  assert.ok(plus.rootsTruncated);
});

test('filter deeper than the tree matches nothing', () => {
  const t = trieOf(['a/b']);
  assert.strictEqual(t.resolve('a/b/c').matchCount, 0);
  assert.strictEqual(t.resolve('a/b/+').matchCount, 0);
});

test('re-inserting a known topic does not double-count', () => {
  const t = new TopicTrie();
  t.insert('x/y', 0);
  t.insert('x/y', 0);
  assert.strictEqual(t.resolve('x/#').matchCount, 1);
});

test('children() lists one level with subtree counts, capped', () => {
  const t = trieOf(FLEET);
  const top = t.children('');
  assert.ok(top.children.some((c) => c.segment === 'factory' && c.subtreeCount === 4));
  const fac = t.children('factory');
  assert.deepStrictEqual(fac.children.map((c) => c.segment).sort(), ['line1', 'line2']);
  const capped = t.children('factory', { limit: 1 });
  assert.strictEqual(capped.children.length, 1);
  assert.ok(capped.truncated);
  const missing = t.children('no/such/prefix');
  assert.deepStrictEqual(missing.children, []);
});

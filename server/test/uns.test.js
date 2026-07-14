const { test } = require('node:test');
const assert = require('node:assert');

const MqttManager = require('../services/mqttManager');
const TopicStore = require('../services/topicStore');
const TopicTrie = require('../services/topicTrie');
const SparkplugRegistry = require('../services/sparkplugRegistry');
const { lintTrie } = require('../services/unsLint');

const fakeIo = { emit() {} };

function managerWithTopics(brokerId, topics) {
  const m = new MqttManager(fakeIo);
  m.connections.set(brokerId, { id: brokerId, metrics: { messagesReceived: 0, bytesReceived: 0, topicCount: 0, errors: 0 } });
  m.stores.set(brokerId, new TopicStore());
  m.rowCache.set(brokerId, new Map());
  m.sparkplug.set(brokerId, new SparkplugRegistry());
  const store = m.stores.get(brokerId);
  for (const [t, payload] of topics) store.ingest(t, Buffer.from(payload), 0, false);
  return m;
}

// ---- topicStore: firstSeen + namespace events -------------------------------

test('topicStore records firstSeen and topic-added events, bounded', () => {
  const s = new TopicStore();
  const before = Date.now();
  s.ingest('a/b', Buffer.from('1'), 0, false);
  s.ingest('a/b', Buffer.from('2'), 0, false); // same topic: no second event
  s.ingest('a/c', Buffer.from('3'), 0, false);
  assert.strictEqual(s.events.length, 2);
  assert.strictEqual(s.events[0].type, 'topic-added');
  assert.strictEqual(s.events[0].topic, 'a/b');
  assert.ok(s.firstSeen[0] >= before);
  // firstSeen does not move on re-ingest
  const fs0 = s.firstSeen[0];
  s.ingest('a/b', Buffer.from('4'), 0, false);
  assert.strictEqual(s.firstSeen[0], fs0);
  // ring is bounded
  for (let i = 0; i < 2500; i++) s.ingest(`bulk/t${i}`, Buffer.from('x'), 0, false);
  assert.ok(s.events.length <= 2000);
});

// ---- read-path decode cache --------------------------------------------------

test('getTopics reuses cached rows while count is unchanged', () => {
  const m = managerWithTopics('rc1', [
    ['plant/a', '{"v":1}'],
    ['plant/b', 'hello']
  ]);
  const first = m.getTopics('rc1').topics;
  const second = m.getTopics('rc1').topics;
  // identical object refs => served from cache
  assert.strictEqual(first[0], second[0]);
  assert.strictEqual(first[1], second[1]);
  // a new message invalidates only that topic's entry
  m.stores.get('rc1').ingest('plant/a', Buffer.from('{"v":2}'), 0, false);
  const third = m.getTopics('rc1').topics;
  assert.notStrictEqual(third[0], second[0]);
  assert.deepStrictEqual(third[0].payload, { v: 2 });
  assert.strictEqual(third[1], second[1]);
  m.shutdown();
});

// ---- namespace events feed ----------------------------------------------------

test('getNamespaceEvents merges topic-added and Sparkplug lifecycle, newest first', () => {
  const m = managerWithTopics('ev1', [['factory/line1/temp', '20']]);
  const registry = m.sparkplug.get('ev1');
  registry.update('spBv1.0/G/NBIRTH/E1', { metrics: [] }, 100);
  registry.update('spBv1.0/G/DBIRTH/E1/D1', { metrics: [] }, 200);
  registry.update('spBv1.0/G/NDEATH/E1', null, 300);

  const feed = m.getNamespaceEvents('ev1', { limit: 10 });
  assert.ok(feed.events.length >= 4);
  // newest first
  for (let i = 1; i < feed.events.length; i++) {
    assert.ok(feed.events[i - 1].ts >= feed.events[i].ts);
  }
  const types = feed.events.map((e) => e.type);
  assert.ok(types.includes('topic-added'));
  assert.ok(types.includes('edge-birth'));
  assert.ok(types.includes('device-birth'));
  assert.ok(types.includes('edge-death'));
  // NDEATH cascaded a device-death for D1
  const cascaded = feed.events.find((e) => e.type === 'device-death' && e.device === 'D1');
  assert.ok(cascaded && cascaded.cascaded === true);
  m.shutdown();
});

// ---- UNS tree ------------------------------------------------------------------

test('getUnsTree returns nested skeleton with exact counts, skips $SYS', () => {
  const m = managerWithTopics('ut1', [
    ['site/area/line/cell/temp', '1'],
    ['site/area/line/cell/press', '2'],
    ['site/area/line2/state', '3'],
    ['$SYS/broker/version', 'v']
  ]);
  const tree = m.getUnsTree('ut1', { depth: 3 });
  assert.strictEqual(tree.nodes.length, 1); // just "site" — $SYS skipped
  const site = tree.nodes[0];
  assert.strictEqual(site.name, 'site');
  assert.strictEqual(site.count, 3);
  const area = site.children[0];
  assert.strictEqual(area.count, 3);
  // depth cap: "line" (depth 3) has children but they are cut
  const line = area.children.find((c) => c.name === 'line');
  assert.strictEqual(line.count, 2);
  assert.ok(!line.children);
  assert.strictEqual(tree.truncated, true);
  // prefix drill-down resumes below the cut
  const sub = m.getUnsTree('ut1', { prefix: 'site/area/line', depth: 2 });
  assert.deepStrictEqual(sub.nodes[0].children.map((c) => c.name).sort(), ['press', 'temp']);
  m.shutdown();
});

test('getUnsTree caps total nodes and reports truncation', () => {
  const pairs = [];
  for (let i = 0; i < 50; i++) pairs.push([`root/branch${i}/leaf`, 'x']);
  const m = managerWithTopics('ut2', pairs);
  const tree = m.getUnsTree('ut2', { depth: 6, maxNodes: 10 });
  assert.ok(tree.truncated);
  const countNodes = (ns) => ns.reduce((acc, n) => acc + 1 + (n.children ? countNodes(n.children) : 0), 0);
  assert.ok(countNodes(tree.nodes) <= 10);
  m.shutdown();
});

// ---- UNS lint --------------------------------------------------------------------

function trieOf(topics) {
  const t = new TopicTrie();
  topics.forEach((topic, i) => t.insert(topic, i));
  return t;
}

test('lint: clean consistent namespace scores high with no findings', () => {
  const r = lintTrie(trieOf([
    'site/area1/line1/temp',
    'site/area1/line1/press',
    'site/area1/line2/temp',
    'site/area2/line1/temp'
  ]));
  assert.strictEqual(r.findings.length, 0);
  assert.strictEqual(r.score, 100);
  assert.strictEqual(r.stats.topics, 4);
});

test('lint: empty segment is an error', () => {
  const r = lintTrie(trieOf(['site//temp']));
  const f = r.findings.find((x) => x.rule === 'empty-segment');
  assert.ok(f);
  assert.strictEqual(f.severity, 'error');
  assert.ok(r.score < 100);
});

test('lint: sibling naming-convention mix is flagged at the parent', () => {
  const r = lintTrie(trieOf([
    'site/pump_station/v',
    'site/mixing-line/v',
    'site/coolingTower/v'
  ]));
  const f = r.findings.find((x) => x.rule === 'naming-mix');
  assert.ok(f);
  assert.strictEqual(f.path, 'site');
  assert.match(f.detail, /snake_case/);
  assert.match(f.detail, /kebab-case/);
});

test('lint: payload on a branch node is reported', () => {
  const r = lintTrie(trieOf(['site/line', 'site/line/temp']));
  const f = r.findings.find((x) => x.rule === 'data-on-branch');
  assert.ok(f);
  assert.strictEqual(f.path, 'site/line');
});

test('lint: long single-child chains and depth variance are surfaced', () => {
  const r = lintTrie(trieOf([
    'a/b/c/d/e/f/leafdeep', // chain a→b→c→d→e→f all single-child
    'shallow'
  ]));
  assert.ok(r.findings.some((x) => x.rule === 'deep-chain'));
  const dv = r.findings.find((x) => x.rule === 'depth-variance');
  assert.ok(dv, 'leaf depths 1 vs 7 must trigger depth-variance');
});

test('lint: whitespace in segment names is flagged; $SYS is ignored', () => {
  const r = lintTrie(trieOf(['site/tank farm/level', '$SYS/broker/uptime']));
  assert.ok(r.findings.some((x) => x.rule === 'space-in-name'));
  assert.ok(!r.findings.some((x) => x.path.startsWith('$SYS')));
});

test('lint: findings truncate but per-rule counts stay exact', () => {
  const topics = [];
  for (let i = 0; i < 40; i++) topics.push(`p/b${i}//x`);
  const r = lintTrie(trieOf(topics), { maxFindings: 5 });
  assert.strictEqual(r.findings.length, 5);
  assert.ok(r.truncated);
  assert.strictEqual(r.stats.byRule['empty-segment'], 40);
});

const { test } = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');

const { matchFilter } = require('../services/mqttMatch');
const historians = require('../services/historians');
const HistorianOutbox = require('../services/historianOutbox');
const { PipelineEngine, applyTransforms, applyTemplate } = require('../services/pipelineEngine');
const Recorder = require('../services/recorder');
const Replayer = require('../services/replayer');
const { SchemaContracts, inferSchema, validate } = require('../services/schemaContracts');
const ModelEngine = require('../services/modelEngine');
const MqttManager = require('../services/mqttManager');
const TopicStore = require('../services/topicStore');

const tick = () => new Promise((r) => setImmediate(r));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fakeProfiles(data = {}) {
  return {
    listIn: (c) => Object.values(data[c] || {}),
    getIn: (c, id) => (data[c] || {})[id] || null
  };
}

function msg(brokerId, topic, payload, extra = {}) {
  return { brokerId, topic, payload, qos: 0, retain: false, timestamp: new Date().toISOString(), ...extra };
}

// ---- matchFilter ---------------------------------------------------------------

test('matchFilter implements MQTT semantics', () => {
  assert.ok(matchFilter('a/b', 'a/b'));
  assert.ok(matchFilter('a/+/c', 'a/x/c'));
  assert.ok(!matchFilter('a/+/c', 'a/x/y/c'));
  assert.ok(matchFilter('a/#', 'a/b/c'));
  assert.ok(matchFilter('a/#', 'a'), 'a/# matches a itself');
  assert.ok(!matchFilter('#', '$SYS/broker/uptime'));
  assert.ok(!matchFilter('+/x', '$SYS/x'));
  assert.ok(matchFilter('$SYS/#', '$SYS/broker/uptime'), 'explicit $SYS filter matches');
  assert.ok(matchFilter('a//b', 'a//b'), 'empty segments significant');
  assert.ok(!matchFilter('a/b', 'a/b/c'));
});

// ---- historians -----------------------------------------------------------------

test('influxdb backend writes line protocol with escaping and token auth', async () => {
  let captured;
  const fetchImpl = async (url, opts) => {
    captured = { url, opts };
    return { ok: true, status: 204, text: async () => '' };
  };
  const conn = { type: 'influxdb', url: 'http://influx:8086/', org: 'acme', bucket: 'uns', token: 'sekrit', measurement: 'plant data' };
  const out = await historians.writePoints(
    conn,
    [
      { tag: 'a,b c/temp', ts: 1700000000000, value: 21.5 },
      { tag: 'x/state', ts: 1700000000001, value: 'running' }
    ],
    fetchImpl
  );
  assert.strictEqual(out.written, 2);
  assert.match(captured.url, /^http:\/\/influx:8086\/api\/v2\/write\?/);
  assert.match(captured.url, /org=acme/);
  assert.match(captured.url, /bucket=uns/);
  assert.match(captured.url, /precision=ms/);
  assert.strictEqual(captured.opts.headers.Authorization, 'Token sekrit');
  const lines = captured.opts.body.split('\n');
  assert.strictEqual(lines[0], 'plant\\ data,topic=a\\,b\\ c/temp value=21.5 1700000000000');
  // strings land in a SEPARATE field so a mixed-type topic can't poison the
  // numeric field's shard type
  assert.strictEqual(lines[1], 'plant\\ data,topic=x/state raw="running" 1700000000001');
});

test('timebase backend groups TVQs per tag into the dataset', async () => {
  let captured;
  const fetchImpl = async (url, opts) => {
    captured = { url, body: JSON.parse(opts.body), headers: opts.headers };
    return { ok: true, status: 200, text: async () => '' };
  };
  const conn = { type: 'timebase', url: 'http://hist:4511', dataset: 'Manifold', apiKey: 'k1' };
  await historians.writePoints(
    conn,
    [
      { tag: 'plant/temp', ts: 1700000000000, value: 20 },
      { tag: 'plant/temp', ts: 1700000001000, value: 21 },
      { tag: 'plant/press', ts: 1700000000500, value: 3.2 }
    ],
    fetchImpl
  );
  assert.strictEqual(captured.url, `http://hist:4511${historians.DEFAULT_TIMEBASE_PATH}`);
  assert.strictEqual(captured.headers.Authorization, 'Bearer k1');
  assert.strictEqual(captured.body.dataset, 'Manifold');
  const temp = captured.body.tags.find((t) => t.n === 'plant/temp');
  assert.strictEqual(temp.data.length, 2);
  assert.deepStrictEqual(Object.keys(temp.data[0]).sort(), ['q', 't', 'v']);
  assert.strictEqual(temp.data[0].q, 192);
  assert.strictEqual(temp.data[0].t, new Date(1700000000000).toISOString());
});

test('timescaledb backend creates schema once and batch-inserts parameterized rows', async () => {
  const queries = [];
  const fakePool = { query: async (text, values) => (queries.push({ text: text.replace(/\s+/g, ' ').trim(), values }), { rows: [] }) };
  const conn = { type: 'timescaledb', host: 'h', database: 'd', user: 'u', __pool: fakePool, __schemaReady: new Set() };

  await historians.writePoints(conn, [
    { tag: 'plant/temp', ts: 1700000000000, value: 21.5, quality: 192 },
    { tag: 'plant/state', ts: 1700000001000, value: 'RUNNING', quality: 64 }
  ]);
  // schema: table + index + hypertable attempt, then one multi-row insert
  assert.match(queries[0].text, /CREATE TABLE IF NOT EXISTS manifold_samples/);
  assert.match(queries[1].text, /CREATE INDEX IF NOT EXISTS manifold_samples_topic_ts/);
  assert.match(queries[2].text, /create_hypertable\('manifold_samples', 'ts', if_not_exists => TRUE\)/);
  const insert = queries[3];
  assert.match(insert.text, /INSERT INTO manifold_samples \(ts, topic, value, raw, quality\) VALUES \(\$1,\$2,\$3,\$4,\$5\),\(\$6,\$7,\$8,\$9,\$10\)/);
  assert.strictEqual(insert.values[1], 'plant/temp');
  assert.strictEqual(insert.values[2], 21.5);
  assert.strictEqual(insert.values[7], null, 'non-numeric value → NULL numeric column');
  assert.strictEqual(insert.values[8], 'RUNNING');
  assert.strictEqual(insert.values[9], 64);

  // second write: schema is cached, straight to insert
  await historians.writePoints(conn, [{ tag: 't', ts: 1, value: 2 }], null);
  assert.match(queries[4].text, /INSERT INTO/);

  // identifier injection is refused
  await assert.rejects(
    () => historians.writePoints({ ...conn, table: 'x; DROP TABLE users;--' }, [{ tag: 't', ts: 1, value: 2 }]),
    /invalid table name/
  );
});

test('timebase writePath override and unsupported types', async () => {
  let url;
  const fetchImpl = async (u) => {
    url = u;
    return { ok: true, status: 200, text: async () => '' };
  };
  await historians.writePoints({ type: 'timebase', url: 'http://h:4511', dataset: 'D', writePath: '/api/v2/custom' }, [{ tag: 't', ts: 1, value: 2 }], fetchImpl);
  assert.strictEqual(url, 'http://h:4511/api/v2/custom');
  await assert.rejects(() => historians.writePoints({ type: 'nope', url: 'x' }, [{ tag: 't', ts: 1, value: 2 }], fetchImpl), /unsupported historian/);
});

// ---- transforms ------------------------------------------------------------------

test('applyTemplate substitutes segments, tails, and the whole topic', () => {
  const topic = 'vlokkenheim/emmeloord/production/line1/filler/temperature';
  assert.strictEqual(applyTemplate('uns/{1}/{2}/{4-}', topic), 'uns/vlokkenheim/emmeloord/line1/filler/temperature');
  assert.strictEqual(applyTemplate('copy/{topic}', topic), `copy/${topic}`);
  assert.strictEqual(applyTemplate('{9}', topic), '', 'out-of-range segment is empty');
});

test('transform chain: repath, pick, rename, set, scale, sparkplugFlatten', () => {
  const m = msg('b', 'plant/line1/temp', { tempC: 20, junk: 'x' });
  const out = applyTransforms(
    [
      { type: 'repath', to: 'uns/site/{2}/{3}' },
      { type: 'pick', fields: ['tempC'] },
      { type: 'scale', field: 'tempC', mul: 1.8, add: 32 },
      { type: 'rename', map: { tempC: 'tempF' } },
      { type: 'set', values: { unit: 'F' } }
    ],
    m
  );
  assert.strictEqual(out.topic, 'uns/site/line1/temp');
  assert.deepStrictEqual(out.payload, { tempF: 68, unit: 'F' });

  const sp = applyTransforms([{ type: 'sparkplugFlatten' }], msg('b', 'spBv1.0/G/DDATA/E/D', 'raw', { sparkplug: { metrics: [{ name: 'rpm', value: 900 }, { name: 'ok', value: true }] } }));
  assert.deepStrictEqual(sp.payload, { rpm: 900, ok: true });

  assert.strictEqual(applyTransforms([{ type: 'numeric' }], msg('b', 't', 'not-a-number')), null, 'numeric drops non-numeric payloads');
  assert.strictEqual(applyTransforms([{ type: 'numeric' }], msg('b', 't', '42.5')).payload, 42.5);
});

// ---- pipeline engine ---------------------------------------------------------------

test('pipeline routes match, transform, publish, and block feedback loops', async () => {
  const m = new MqttManager({ emit() {} });
  const published = [];
  m.publish = async (brokerId, topic, payload, opts) => {
    published.push({ brokerId, topic, payload, opts });
  };
  const routes = {
    r1: {
      id: 'r1',
      enabled: true,
      source: { brokerId: 'b1', filter: 'raw/#' },
      transforms: [{ type: 'repath', to: 'uns/{2-}' }],
      target: { type: 'mqtt', brokerId: 'b1', retain: true }
    },
    loopy: {
      id: 'loopy',
      enabled: true,
      source: { brokerId: 'b1', filter: 'raw/#' },
      transforms: [], // output topic == input topic == matches own filter
      target: { type: 'mqtt', brokerId: 'b1' }
    }
  };
  const eng = new PipelineEngine({ mqttManager: m, profiles: fakeProfiles({ pipelines: routes }) });
  eng.start();

  m.emit('message', msg('b1', 'raw/line1/temp', 21));
  m.emit('message', msg('b2', 'raw/line1/temp', 21)); // wrong broker: ignored
  await tick();

  assert.strictEqual(published.length, 1);
  assert.strictEqual(published[0].topic, 'uns/line1/temp');
  assert.strictEqual(published[0].opts.retain, true);
  const metrics = eng.getMetrics();
  assert.strictEqual(metrics.r1.published, 1);
  assert.strictEqual(metrics.loopy.loopBlocked, 1, 'self-feeding route must be blocked');
  assert.match(metrics.loopy.lastError, /loop blocked/);
  eng.stop();
  m.shutdown();
});

test('pipeline historian target delivers through the outbox', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manifold-ob-'));
  const m = new MqttManager({ emit() {} });
  let captured;
  const fetchImpl = async (url, opts) => {
    captured = { url, body: opts.body };
    return { ok: true, status: 204, text: async () => '' };
  };
  const profiles = fakeProfiles({
    pipelines: {
      r: { id: 'r', enabled: true, source: { brokerId: 'b1', filter: 'plant/#' }, transforms: [{ type: 'numeric' }], target: { type: 'historian', historianId: 'h1' } }
    },
    historians: { h1: { id: 'h1', type: 'influxdb', url: 'http://i:8086', org: 'o', bucket: 'bk' } }
  });
  const outbox = new HistorianOutbox({ profiles, dir, fetchImpl });
  const eng = new PipelineEngine({ mqttManager: m, profiles, outbox });
  eng.start();
  m.emit('message', msg('b1', 'plant/temp', '20.5'));
  m.emit('message', msg('b1', 'plant/label', 'text-drops-via-numeric'));
  await outbox.flush();
  assert.ok(captured, 'influx write must have happened');
  assert.match(captured.body, /topic=plant\/temp value=20\.5/);
  assert.ok(!captured.body.includes('label'), 'numeric transform filtered the non-numeric point');
  eng.stop();
  m.shutdown();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('outbox store-and-forward: failed writes spill to disk and drain on recovery', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manifold-ob-'));
  let failing = true;
  const writes = [];
  const fetchImpl = async (url, opts) => {
    if (failing) return { ok: false, status: 503, text: async () => 'down' };
    writes.push(opts.body);
    return { ok: true, status: 204, text: async () => '' };
  };
  const profiles = fakeProfiles({ historians: { h1: { id: 'h1', type: 'influxdb', url: 'http://i:8086', org: 'o', bucket: 'bk' } } });
  const outbox = new HistorianOutbox({ profiles, dir, fetchImpl });

  outbox.enqueue('h1', [{ tag: 'a/t', ts: 1000, value: 1 }]);
  await outbox.flush(); // historian down → spill
  let stats = outbox.getStats().h1;
  assert.strictEqual(stats.spilled, 1);
  assert.ok(stats.spillBytes > 0, 'points must be on disk while the historian is down');
  assert.match(stats.lastError, /503/);

  // A restart must not lose the spill: a fresh outbox over the same dir drains it.
  failing = false;
  const outbox2 = new HistorianOutbox({ profiles, dir, fetchImpl });
  outbox2.enqueue('h1', [{ tag: 'a/t', ts: 2000, value: 2 }]);
  await outbox2.flush();
  stats = outbox2.getStats().h1;
  assert.strictEqual(stats.drained, 1, 'spilled point recovered after restart');
  assert.strictEqual(stats.written, 2);
  assert.strictEqual(stats.spillBytes, 0, 'spill file removed after drain');
  // spilled (older) point must have been written before the new one
  assert.match(writes[0], /value=1 1000/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('outbox spill cap honors dropPolicy: oldest rewrites the file head, newest drops incoming', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manifold-ob-'));
  const fetchImpl = async () => ({ ok: false, status: 503, text: async () => 'down' });
  const point = (n) => ({ tag: 'a/t', ts: n, value: n });
  const lineBytes = JSON.stringify(point(1)).length + 1;
  const profiles = fakeProfiles({
    historians: {
      hNew: { id: 'hNew', type: 'influxdb', url: 'http://i:8086', org: 'o', bucket: 'bk' },
      hOld: { id: 'hOld', type: 'influxdb', url: 'http://i:8086', org: 'o', bucket: 'bk', dropPolicy: 'oldest' }
    }
  });
  // Cap fits exactly 3 lines; every point serializes to the same length.
  const outbox = new HistorianOutbox({ profiles, dir, fetchImpl, spillMaxBytes: lineBytes * 3 });

  // Later flush rounds retry the spill and overwrite lastError with the plain
  // write failure, so capture each policy message right after it fires.
  const capMessages = {};
  for (const id of ['hNew', 'hOld']) {
    outbox.enqueue(id, [point(1), point(2), point(3)]);
    await outbox.flush(); // historian down → 3 points spill, file is at cap
    outbox.enqueue(id, [point(4)]);
    await outbox.flush(); // over cap → policy decides which end goes
    capMessages[id] = outbox.getStats()[id].lastError;
  }

  const readTs = (id) =>
    fs
      .readFileSync(outbox.spillPath(id), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l).ts);

  assert.deepStrictEqual(readTs('hNew'), [1, 2, 3], 'default keeps the outage start, drops the new point');
  assert.strictEqual(outbox.getStats().hNew.dropped, 1);
  assert.match(capMessages.hNew, /dropping new/);

  assert.deepStrictEqual(readTs('hOld'), [2, 3, 4], 'oldest policy cuts the head to keep the newest point');
  assert.strictEqual(outbox.getStats().hOld.dropped, 1);
  assert.match(capMessages.hOld, /oldest/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('pipeline hop guard blocks indirect A→B→A cycles', async () => {
  const m = new MqttManager({ emit() {} });
  const published = [];
  m.publish = async (brokerId, topic, payload) => {
    published.push(topic);
  };
  const profiles = fakeProfiles({
    pipelines: {
      ab: { id: 'ab', enabled: true, source: { brokerId: 'b1', filter: 'a/#' }, transforms: [{ type: 'repath', to: 'b/{2-}' }], target: { type: 'mqtt', brokerId: 'b1' } },
      ba: { id: 'ba', enabled: true, source: { brokerId: 'b1', filter: 'b/#' }, transforms: [{ type: 'repath', to: 'a/{2-}' }], target: { type: 'mqtt', brokerId: 'b1' } }
    }
  });
  const eng = new PipelineEngine({ mqttManager: m, profiles, outbox: null });
  eng.start();
  // Simulate the broker echoing each publish back through the tap.
  let guard = 0;
  const origPublish = m.publish;
  m.publish = async (brokerId, topic, payload) => {
    await origPublish(brokerId, topic, payload);
    if (guard++ < 50) m.emit('message', msg(brokerId, topic, payload));
  };
  m.emit('message', msg('b1', 'a/x', 1));
  await new Promise((r) => setTimeout(r, 50));
  const metrics = eng.getMetrics();
  const blocked = (metrics.ab?.loopBlocked || 0) + (metrics.ba?.loopBlocked || 0);
  assert.ok(blocked >= 1, 'cycle must be cut by the hop guard');
  assert.ok(published.length <= 6, `hop guard must stop the ping-pong (published ${published.length})`);
  eng.stop();
  m.shutdown();
});

test('envelope transform wraps values as TVQ', () => {
  const out = applyTransforms([{ type: 'repath', to: 'uns/{2-}' }, { type: 'envelope' }], msg('b', 'raw/line/temp', 21.5));
  assert.strictEqual(out.topic, 'uns/line/temp');
  assert.strictEqual(out.payload.v, 21.5);
  assert.strictEqual(out.payload.q, 192);
  assert.ok(Number.isFinite(out.payload.t));
});

test('pipeline preview dry-runs against observed topics without publishing', () => {
  const m = new MqttManager({ emit() {} });
  m.connections.set('b1', { id: 'b1', metrics: { messagesReceived: 0, bytesReceived: 0, topicCount: 0, errors: 0 } });
  m.stores.set('b1', new TopicStore());
  m.stores.get('b1').ingest('raw/line1/temp', Buffer.from('21'), 0, false);
  m.stores.get('b1').ingest('raw/line2/temp', Buffer.from('22'), 0, false);
  let published = 0;
  m.publish = async () => {
    published++;
  };
  const eng = new PipelineEngine({ mqttManager: m, profiles: fakeProfiles() });
  const route = {
    source: { brokerId: 'b1', filter: 'raw/#' },
    transforms: [{ type: 'repath', to: 'uns/{2-}' }],
    target: { type: 'mqtt', brokerId: 'b2' }
  };
  const p = eng.preview(route);
  assert.strictEqual(p.matchCount, 2);
  assert.strictEqual(p.rows.length, 2);
  const row = p.rows.find((r) => r.inTopic === 'raw/line1/temp');
  assert.strictEqual(row.outTopic, 'uns/line1/temp');
  assert.strictEqual(row.loop, false);
  assert.strictEqual(published, 0, 'preview must not publish');
  m.shutdown();
});

// ---- recorder + replayer -------------------------------------------------------------

test('recorder captures matching messages to jsonl and reads them back', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manifold-rec-'));
  const m = new MqttManager({ emit() {} });
  const rec = { id: 'rec1', brokerId: 'b1', filter: 'plant/#', enabled: true, target: { type: 'file' } };
  const r = new Recorder({ mqttManager: m, profiles: fakeProfiles({ recordings: { rec1: rec } }), dir });
  r.start();
  m.emit('message', msg('b1', 'plant/temp', 20));
  m.emit('message', msg('b1', 'plant/temp', 21));
  m.emit('message', msg('b1', 'other/x', 9)); // filtered out
  const data = await r.read('rec1', {});
  assert.strictEqual(data.points.length, 2);
  assert.strictEqual(data.points[1].v, 21);
  const byTopic = await r.read('rec1', { topic: 'plant/temp', limit: 1 });
  assert.strictEqual(byTopic.points.length, 1);
  assert.strictEqual(byTopic.truncated, true);
  assert.strictEqual(r.getStatus('rec1').points, 2);
  r.stop();
  r.remove('rec1');
  m.shutdown();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('recorder stops at the file cap and reports full', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manifold-rec-'));
  const m = new MqttManager({ emit() {} });
  const rec = { id: 'tiny', brokerId: 'b1', filter: '#', enabled: true, target: { type: 'file' }, maxBytes: 80 };
  const r = new Recorder({ mqttManager: m, profiles: fakeProfiles({ recordings: { tiny: rec } }), dir });
  r.start();
  for (let i = 0; i < 10; i++) m.emit('message', msg('b1', 'a/b', { i, pad: 'xxxxxxxxxx' }));
  const s = r.getStatus('tiny');
  assert.ok(s.full);
  assert.ok(s.bytes <= 80);
  assert.match(s.lastError, /cap reached/);
  r.stop();
  m.shutdown();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('replayer republishes a recording with scaled timing', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manifold-rep-'));
  fs.mkdirSync(path.join(dir, 'recordings'), { recursive: true });
  const base = 1700000000000;
  const lines = [
    { t: base, topic: 'a/x', v: 1, q: 0 },
    { t: base + 100, topic: 'a/y', v: 2, q: 0 },
    { t: base + 200, topic: 'a/z', v: 3, q: 0 }
  ];
  const m = new MqttManager({ emit() {} });
  const r = new Recorder({ mqttManager: m, profiles: fakeProfiles(), dir });
  fs.writeFileSync(r.filePath('rr'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');

  const published = [];
  m.requireClient = () => ({});
  m.publish = async (brokerId, topic, payload) => {
    published.push({ topic, payload });
  };
  const rep = new Replayer({ mqttManager: m, recorder: r });
  await rep.start({ recordingId: 'rr', brokerId: 'b1', speed: 20, topicPrefix: 'replay/' });
  const deadline = Date.now() + 3000;
  while (rep.getStatus().running && Date.now() < deadline) await sleep(20);
  assert.strictEqual(rep.getStatus().running, false, 'replay must finish');
  assert.strictEqual(published.length, 3);
  assert.deepStrictEqual(published.map((p) => p.topic), ['replay/a/x', 'replay/a/y', 'replay/a/z']);
  assert.strictEqual(rep.getStatus().lastRun.state, 'finished');
  m.shutdown();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('replayer refuses concurrent replays and missing files', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manifold-rep-'));
  const m = new MqttManager({ emit() {} });
  const r = new Recorder({ mqttManager: m, profiles: fakeProfiles(), dir });
  const rep = new Replayer({ mqttManager: m, recorder: r });
  await assert.rejects(() => rep.start({ recordingId: 'nope', brokerId: 'b1' }), /no data file/);
  m.shutdown();
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---- schema contracts -------------------------------------------------------------

test('inferSchema and validate detect drift precisely', () => {
  const schema = inferSchema({ temp: 21.5, meta: { unit: 'C', seq: 1 }, tags: ['a'] });
  assert.strictEqual(schema.type, 'object');
  assert.strictEqual(schema.props.temp.type, 'number');
  assert.strictEqual(schema.props.tags.type, 'array');

  // conforming payload → no violations
  assert.deepStrictEqual(validate(schema, { temp: 20, meta: { unit: 'F', seq: 2 }, tags: ['b'] }), []);

  const drift = validate(schema, { temp: 'twenty', meta: { unit: 'C' }, tags: ['a'], extra: true });
  const kinds = Object.fromEntries(drift.map((d) => [d.path, d.kind]));
  assert.strictEqual(kinds['temp'], 'type-changed');
  assert.strictEqual(kinds['meta.seq'], 'missing-field');
  assert.strictEqual(kinds['extra'], 'new-field');
});

test('contracts engine records violations from the message tap', async () => {
  const m = new MqttManager({ emit() {} });
  const emitted = [];
  const io = { emit: (ev, data) => emitted.push({ ev, data }) };
  const schema = inferSchema({ v: 1 });
  const c = new SchemaContracts({
    mqttManager: m,
    profiles: fakeProfiles({ contracts: { c1: { id: 'c1', brokerId: 'b1', filter: 'plant/#', schema, enabled: true } } }),
    io
  });
  c.start();
  m.emit('message', msg('b1', 'plant/ok', { v: 2 })); // conforms
  m.emit('message', msg('b1', 'plant/bad', { v: 'oops', extra: 1 })); // drifts
  assert.strictEqual(c.getViolations().length, 1);
  const v = c.getViolations()[0];
  assert.strictEqual(v.topic, 'plant/bad');
  assert.ok(v.problems.some((p) => p.kind === 'type-changed'));
  assert.strictEqual(emitted[0].ev, 'contract-violation');
  assert.strictEqual(c.getCounters().c1.checked, 2);
  c.stop();
  m.shutdown();
});

// ---- model engine ------------------------------------------------------------------

test('model merges multi-source attributes and publishes one object (debounced)', async () => {
  const m = new MqttManager({ emit() {} });
  const published = [];
  m.publish = async (brokerId, topic, payload, opts) => {
    published.push({ brokerId, topic, payload, opts });
  };
  const model = {
    id: 'pump',
    enabled: true,
    publishMode: 'on-change',
    target: { brokerId: 'b1', topic: 'uns/site/pump7', retain: true },
    attributes: [
      { name: 'rpm', source: { brokerId: 'b1', topic: 'raw/pump7/rpm' } },
      { name: 'temp', source: { brokerId: 'b1', topic: 'raw/pump7/temp', field: 'value' } }
    ]
  };
  const eng = new ModelEngine({ mqttManager: m, profiles: fakeProfiles({ models: { pump: model } }) });
  eng.start();
  m.emit('message', msg('b1', 'raw/pump7/rpm', 900));
  m.emit('message', msg('b1', 'raw/pump7/temp', { value: 61.5, unit: 'C' }));
  await sleep(350); // debounce window
  assert.strictEqual(published.length, 1, 'burst must coalesce into one publish');
  const p = published[0];
  assert.strictEqual(p.topic, 'uns/site/pump7');
  assert.strictEqual(p.payload.rpm, 900);
  assert.strictEqual(p.payload.temp, 61.5);
  assert.ok(p.payload._ts);
  assert.strictEqual(p.opts.retain, true);
  eng.stop();
  m.shutdown();
});

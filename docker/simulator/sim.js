'use strict';

// Demo data generator for Manifold. Publishes a full-plant worth of traffic to
// the bundled broker so every view has a realistic load to show:
//   1. A large hierarchical tree of plain JSON telemetry (factories, buildings,
//      energy, utilities) with per-sensor value models and mixed update rates.
//   2. Valid Sparkplug B NBIRTH/DBIRTH/NDATA/DDATA for several edge nodes and
//      devices (Sparkplug topology).
//
// Self-contained (only mqtt + protobufjs) and resilient: it reconnects and
// re-sends BIRTH certificates on every (re)connect so a late subscriber can
// always resolve metric aliases.
//
// Scale knobs (env): TICK_MS (base publish interval), SIM_SCALE (multiplies the
// number of lines/rooms; 1 ≈ 350 topics, 2 ≈ 700).

const mqtt = require('mqtt');
const protobuf = require('protobufjs');

const URL = process.env.MQTT_URL || 'mqtt://mqtt:1883';
const TICK_MS = Number(process.env.TICK_MS || 1500);
const SCALE = Math.max(1, Number(process.env.SIM_SCALE || 1));

const pick = (a) => a[Math.floor(Math.random() * a.length)];
const jitter = (base, spread) => +(base + (Math.random() - 0.5) * spread).toFixed(2);
const range = (n) => Array.from({ length: n }, (_, i) => i + 1);

// ---------------------------------------------------------------------------
// Per-sensor value models. Each returns a payload object; some carry state
// across ticks (counters) via the `s` scratch object stored on the topic.
// ---------------------------------------------------------------------------
const SENSORS = {
  temperature: () => ({ value: jitter(46, 10), unit: 'C' }),
  pressure: () => ({ value: jitter(4.2, 0.9), unit: 'bar' }),
  vibration: () => ({ value: jitter(2.1, 1.4), unit: 'mm/s' }),
  speed_rpm: () => ({ value: Math.round(jitter(1450, 160)), unit: 'rpm' }),
  power_kw: () => ({ value: jitter(28, 10), unit: 'kW' }),
  current: () => ({ value: jitter(42, 8), unit: 'A' }),
  flow: () => ({ value: jitter(12, 4), unit: 'L/min' }),
  level: () => ({ value: jitter(62, 25), unit: '%' }),
  humidity: () => ({ value: jitter(48, 14), unit: '%' }),
  co2: () => ({ value: Math.round(jitter(620, 260)), unit: 'ppm' }),
  occupancy: () => ({ value: Math.round(Math.random() * 24) }),
  hvac_setpoint: () => ({ value: jitter(21.5, 1.5), unit: 'C' }),
  voltage: () => ({ value: jitter(400, 8), unit: 'V' }),
  energy_kwh: (s) => ({ value: +(s.kwh = (s.kwh || 1000) + Math.random() * 0.2).toFixed(2), unit: 'kWh' }),
  cycle_count: (s) => ({ value: (s.count = (s.count || 0) + Math.floor(Math.random() * 3)) }),
  state: () => ({ value: pick(['running', 'running', 'running', 'idle', 'fault', 'maintenance']) })
};

const MACHINE_SENSORS = {
  press: ['temperature', 'pressure', 'vibration', 'power_kw', 'current', 'state', 'cycle_count'],
  cnc: ['temperature', 'speed_rpm', 'vibration', 'power_kw', 'current', 'state', 'cycle_count'],
  robot: ['temperature', 'speed_rpm', 'power_kw', 'state', 'cycle_count'],
  conveyor: ['speed_rpm', 'power_kw', 'state'],
  packer: ['temperature', 'vibration', 'power_kw', 'state', 'cycle_count'],
  mixer: ['temperature', 'speed_rpm', 'level', 'power_kw', 'state']
};
const MACHINES = Object.keys(MACHINE_SENSORS);

// ---------------------------------------------------------------------------
// Build the topic set programmatically. Each entry: { topic, gen, s, every }.
// `every` (>1) publishes on a subset of ticks so the namespace shows a mix of
// fast and slow (occasionally "overdue") branches, like a real plant.
// ---------------------------------------------------------------------------
// Optional site prefix so multiple broker instances carry distinct namespaces
// (e.g. SITE=north -> north/factory/...). Blank = the default flat namespace.
const SITE = (process.env.SITE || '').replace(/[^a-zA-Z0-9_-]/g, '');

function buildTopics() {
  const topics = [];
  const add = (topic, sensor, every = 1) =>
    topics.push({ topic: SITE ? `${SITE}/${topic}` : topic, gen: SENSORS[sensor], s: {}, every });

  // Factories: plant-a/-b/-c → lines → machines → sensors
  const plants = ['plant-a', 'plant-b', 'plant-c'];
  for (const plant of plants) {
    for (const l of range(4 * SCALE)) {
      const line = `line${l}`;
      // 3-4 machines per line, varied types
      const count = 3 + (l % 2);
      for (let m = 0; m < count; m++) {
        const type = MACHINES[(l + m) % MACHINES.length];
        const machine = `${type}${m + 1}`;
        for (const sensor of MACHINE_SENSORS[type]) {
          // state + cycle_count tick slower
          const every = sensor === 'state' ? 4 : sensor === 'cycle_count' ? 2 : 1;
          add(`factory/${plant}/${line}/${machine}/${sensor}`, sensor, every);
        }
      }
    }
  }

  // Buildings: floors → rooms → environment sensors
  for (const b of ['building-1', 'building-2']) {
    for (const f of range(3)) {
      for (const r of ['roomA', 'roomB', 'roomC'].slice(0, 2 + (f % 2))) {
        for (const sensor of ['temperature', 'humidity', 'co2', 'occupancy', 'hvac_setpoint']) {
          const every = sensor === 'occupancy' ? 3 : 1;
          add(`building/${b}/floor${f}/${r}/${sensor}`, sensor, every);
        }
      }
    }
  }

  // Energy: main + per-plant submeters
  add('energy/main/power_kw', 'power_kw');
  add('energy/main/voltage', 'voltage');
  add('energy/main/current', 'current');
  add('energy/main/energy_kwh', 'energy_kwh');
  for (const plant of plants) {
    add(`energy/${plant}/power_kw`, 'power_kw');
    add(`energy/${plant}/energy_kwh`, 'energy_kwh');
  }

  // Utilities: water / air / steam
  for (const util of ['water', 'compressed_air', 'steam']) {
    add(`utility/${util}/flow`, 'flow');
    add(`utility/${util}/pressure`, 'pressure', 2);
    add(`utility/${util}/level`, 'level', 2);
  }

  return topics;
}

const TOPICS = buildTopics();

// ---------------------------------------------------------------------------
// Sparkplug B — several edge nodes and devices.
// ---------------------------------------------------------------------------
const PROTO = `
  syntax = "proto2";
  message Payload {
    message Metric {
      optional string name = 1;
      optional uint64 alias = 2;
      optional uint64 timestamp = 3;
      optional uint32 datatype = 4;
      oneof value {
        uint32 int_value = 10;
        uint64 long_value = 11;
        float  float_value = 12;
        double double_value = 13;
        bool   boolean_value = 14;
        string string_value = 15;
      }
    }
    optional uint64 timestamp = 1;
    repeated Metric metrics = 2;
    optional uint64 seq = 3;
  }
`;
const root = protobuf.parse(PROTO, { keepCase: true }).root;
const Payload = root.lookupType('Payload');
const DT = { Int32: 3, Float: 9, Double: 10, Boolean: 11, String: 12 };
const encode = (obj) => Buffer.from(Payload.encode(Payload.fromObject(obj)).finish());

// Edge nodes, each with one or two devices. Aliases are unique per edge.
const EDGES = [
  { group: 'Plant1', node: 'Line1', devices: ['Robot1', 'Press1'] },
  { group: 'Plant1', node: 'Line2', devices: ['CNC1'] },
  { group: 'Plant2', node: 'PackHall', devices: ['Packer1', 'Palletizer1'] }
];

const DEVICE_METRICS = [
  { name: 'AxisTemp', dt: DT.Float, base: 38, spread: 6 },
  { name: 'Payload', dt: DT.Float, base: 5, spread: 3 },
  { name: 'Speed', dt: DT.Float, base: 1450, spread: 120 },
  { name: 'CycleCount', dt: DT.Int32, counter: true },
  { name: 'Online', dt: DT.Boolean, bool: true }
];

// assign each edge a running seq + each device an alias map
for (const e of EDGES) {
  e.seq = 0;
  e.next = () => (e.seq = (e.seq + 1) % 256);
  e.aliases = {}; // `${device}/${metric}` -> alias
  let a = 1;
  e.nodeMetrics = [
    { name: 'Node Control/Rebirth', alias: a++, dt: DT.Boolean, bool: false },
    { name: 'Line/Speed', alias: a++, dt: DT.Float, base: 12, spread: 2 },
    { name: 'Line/Uptime', alias: a++, dt: DT.Int32, uptime: true }
  ];
  e.devMeta = {};
  for (const d of e.devices) {
    e.devMeta[d] = DEVICE_METRICS.map((m) => ({ ...m, alias: a++, count: 0 }));
  }
}

function metricValue(m) {
  if (m.counter) return { int_value: (m.count += Math.floor(Math.random() * 3)) };
  if (m.uptime) return { int_value: Math.floor(process.uptime()) };
  if (m.bool !== undefined) return { boolean_value: m.bool };
  if (m.dt === DT.Int32) return { int_value: Math.round(jitter(m.base, m.spread)) };
  return { float_value: jitter(m.base, m.spread) };
}

function nodeBirth(e) {
  return encode({
    timestamp: Date.now(),
    seq: 0,
    metrics: e.nodeMetrics.map((m) => ({ name: m.name, alias: m.alias, datatype: m.dt, ...metricValue(m) }))
  });
}
function deviceBirth(e, d) {
  return encode({
    timestamp: Date.now(),
    seq: e.next(),
    metrics: e.devMeta[d].map((m) => ({ name: `${d}/${m.name}`, alias: m.alias, datatype: m.dt, ...metricValue(m) }))
  });
}
function nodeData(e) {
  return encode({
    timestamp: Date.now(),
    seq: e.next(),
    metrics: e.nodeMetrics.filter((m) => !m.bool).map((m) => ({ alias: m.alias, datatype: m.dt, ...metricValue(m) }))
  });
}
function deviceData(e, d) {
  return encode({
    timestamp: Date.now(),
    seq: e.next(),
    metrics: e.devMeta[d].filter((m) => m.bool === undefined).map((m) => ({ alias: m.alias, datatype: m.dt, ...metricValue(m) }))
  });
}

// ---------------------------------------------------------------------------
console.log(`simulator: ${TOPICS.length} plain topics + ${EDGES.length} Sparkplug edges → ${URL}`);
const client = mqtt.connect(URL, { reconnectPeriod: 3000, clientId: `manifold-sim-${Date.now()}` });

function sendBirths() {
  if (!client.connected) return;
  for (const e of EDGES) {
    e.seq = 0;
    client.publish(`spBv1.0/${e.group}/NBIRTH/${e.node}`, nodeBirth(e), { retain: true });
    for (const d of e.devices) client.publish(`spBv1.0/${e.group}/DBIRTH/${e.node}/${d}`, deviceBirth(e, d), { retain: true });
  }
}

client.on('connect', () => {
  console.log('simulator: connected, publishing BIRTH certificates');
  sendBirths();
});
setInterval(sendBirths, 20000);
client.on('error', (err) => console.error('simulator: mqtt error:', err.message));
client.on('reconnect', () => console.log('simulator: reconnecting'));

let tick = 0;
setInterval(() => {
  if (!client.connected) return;
  tick++;

  for (const t of TOPICS) {
    if (tick % t.every !== 0) continue;
    const payload = { ...t.gen(t.s), ts: new Date().toISOString() };
    client.publish(t.topic, JSON.stringify(payload), { retain: true });
  }

  for (const e of EDGES) {
    client.publish(`spBv1.0/${e.group}/NDATA/${e.node}`, nodeData(e));
    for (const d of e.devices) client.publish(`spBv1.0/${e.group}/DDATA/${e.node}/${d}`, deviceData(e, d));
  }
}, TICK_MS);

process.on('SIGTERM', () => client.end(true, () => process.exit(0)));
process.on('SIGINT', () => client.end(true, () => process.exit(0)));

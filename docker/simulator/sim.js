'use strict';

// Demo data generator for Topic Canvas. Publishes two kinds of traffic to the
// bundled broker so every view has something to show:
//   1. A hierarchical tree of plain JSON telemetry topics (Topics graph, Flows)
//   2. Valid Sparkplug B NBIRTH/DBIRTH/NDATA/DDATA (Sparkplug device topology)
//
// It is intentionally self-contained (only mqtt + protobufjs) and resilient:
// it reconnects, and re-sends BIRTH certificates on every (re)connect so a late
// subscriber can always resolve metric aliases.

const mqtt = require('mqtt');
const protobuf = require('protobufjs');

const URL = process.env.MQTT_URL || 'mqtt://mqtt:1883';
const TICK_MS = Number(process.env.TICK_MS || 1500);

// ---------------------------------------------------------------------------
// Sparkplug B payload schema (subset), parsed with keepCase so field names stay
// snake_case to match how we build the objects below.
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

// Sparkplug datatype ids
const DT = { Int32: 3, Float: 9, Double: 10, Boolean: 11, String: 12 };

function encodeSparkplug(obj) {
  return Buffer.from(Payload.encode(Payload.fromObject(obj)).finish());
}

// ---------------------------------------------------------------------------
// Plain telemetry tree — a realistic-ish factory/building hierarchy.
// ---------------------------------------------------------------------------
const PLAIN_TOPICS = [
  'factory/line1/press/inlet',
  'factory/line1/press/outlet',
  'factory/line1/temp/motor',
  'factory/line1/flow/coolant',
  'factory/line2/temp/motor',
  'factory/line2/vibration/spindle',
  'factory/line2/state/mode',
  'building/floor1/roomA/temp',
  'building/floor1/roomA/humidity',
  'building/floor1/roomB/co2',
  'building/floor2/roomC/temp',
  'building/floor2/roomC/occupancy',
  'energy/main/power_kw',
  'energy/main/voltage'
];

function jitter(base, spread) {
  return +(base + (Math.random() - 0.5) * spread).toFixed(2);
}

function plainValue(topic) {
  if (topic.includes('temp')) return { value: jitter(45, 6), unit: 'C' };
  if (topic.includes('press')) return { value: jitter(4.2, 0.8), unit: 'bar' };
  if (topic.includes('flow')) return { value: jitter(12, 3), unit: 'L/min' };
  if (topic.includes('humidity')) return { value: jitter(48, 10), unit: '%' };
  if (topic.includes('co2')) return { value: Math.round(jitter(600, 200)), unit: 'ppm' };
  if (topic.includes('power_kw')) return { value: jitter(320, 40), unit: 'kW' };
  if (topic.includes('voltage')) return { value: jitter(400, 8), unit: 'V' };
  if (topic.includes('vibration')) return { value: jitter(2.1, 1.2), unit: 'mm/s' };
  if (topic.includes('occupancy')) return { value: Math.round(Math.random() * 20) };
  if (topic.includes('mode') || topic.includes('state')) {
    return { value: ['running', 'idle', 'fault'][Math.floor(Math.random() * 3)] };
  }
  return { value: jitter(50, 20) };
}

// ---------------------------------------------------------------------------
// Sparkplug topology: Group "Plant1" / Edge "Line1" / Device "Robot1".
// ---------------------------------------------------------------------------
const GROUP = 'Plant1';
const EDGE = 'Line1';
const DEVICE = 'Robot1';
let seq = 0;
const nextSeq = () => (seq = (seq + 1) % 256);

function nodeBirth() {
  return encodeSparkplug({
    timestamp: Date.now(),
    seq: 0,
    metrics: [
      { name: 'Node Control/Rebirth', alias: 0, datatype: DT.Boolean, boolean_value: false },
      { name: 'Line/Speed', alias: 1, datatype: DT.Float, float_value: 12.0 },
      { name: 'Line/Uptime', alias: 2, datatype: DT.Int32, int_value: 0 }
    ]
  });
}
function deviceBirth() {
  return encodeSparkplug({
    timestamp: Date.now(),
    seq: nextSeq(),
    metrics: [
      { name: 'Robot/AxisTemp', alias: 10, datatype: DT.Float, float_value: 38.0 },
      { name: 'Robot/Payload', alias: 11, datatype: DT.Float, float_value: 5.0 },
      { name: 'Robot/CycleCount', alias: 12, datatype: DT.Int32, int_value: 0 },
      { name: 'Robot/Online', alias: 13, datatype: DT.Boolean, boolean_value: true }
    ]
  });
}
let cycles = 0;
function nodeData() {
  return encodeSparkplug({
    timestamp: Date.now(),
    seq: nextSeq(),
    metrics: [
      { alias: 1, datatype: DT.Float, float_value: jitter(12, 2) },
      { alias: 2, datatype: DT.Int32, int_value: Math.floor(process.uptime()) }
    ]
  });
}
function deviceData() {
  cycles += Math.floor(Math.random() * 3);
  return encodeSparkplug({
    timestamp: Date.now(),
    seq: nextSeq(),
    metrics: [
      { alias: 10, datatype: DT.Float, float_value: jitter(38, 4) },
      { alias: 11, datatype: DT.Float, float_value: jitter(5, 2) },
      { alias: 12, datatype: DT.Int32, int_value: cycles }
    ]
  });
}

// ---------------------------------------------------------------------------
console.log(`simulator: connecting to ${URL}`);
const client = mqtt.connect(URL, { reconnectPeriod: 3000, clientId: `tc-sim-${Date.now()}` });

// Publish BIRTH certificates. Retained so any late-joining subscriber gets the
// topology + metric name↔alias map immediately, and re-sent periodically so a
// consumer that connects mid-stream (or a registry that lost state) self-heals.
function sendBirths() {
  if (!client.connected) return;
  seq = 0; // NBIRTH resets the sequence
  client.publish(`spBv1.0/${GROUP}/NBIRTH/${EDGE}`, nodeBirth(), { retain: true });
  client.publish(`spBv1.0/${GROUP}/DBIRTH/${EDGE}/${DEVICE}`, deviceBirth(), { retain: true });
}

client.on('connect', () => {
  console.log('simulator: connected — publishing BIRTH certificates');
  sendBirths();
});

// Periodic re-birth so a late-joining app always sees the device come online.
setInterval(sendBirths, 20000);

client.on('error', (err) => console.error('simulator: mqtt error:', err.message));
client.on('reconnect', () => console.log('simulator: reconnecting…'));

setInterval(() => {
  if (!client.connected) return;

  // Plain telemetry
  for (const topic of PLAIN_TOPICS) {
    const payload = { ...plainValue(topic), ts: new Date().toISOString() };
    client.publish(topic, JSON.stringify(payload), { retain: true });
  }

  // Sparkplug data (alias-only — resolves against the BIRTH above)
  client.publish(`spBv1.0/${GROUP}/NDATA/${EDGE}`, nodeData());
  client.publish(`spBv1.0/${GROUP}/DDATA/${EDGE}/${DEVICE}`, deviceData());
}, TICK_MS);

process.on('SIGTERM', () => client.end(true, () => process.exit(0)));
process.on('SIGINT', () => client.end(true, () => process.exit(0)));

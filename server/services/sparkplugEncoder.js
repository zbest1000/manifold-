'use strict';

const SparkplugDecoder = require('./sparkplugDecoder');

/**
 * Sparkplug B payload encoder — the outbound half of the story. Reuses the
 * decoder's protobuf schema (keepCase snake_case fields) so anything we encode
 * round-trips through our own decoder, which the tests enforce.
 *
 * Datatype mapping is deliberately minimal and honest: JS numbers → Double
 * (10), booleans → Boolean (11), strings → String (12), objects → String (12,
 * JSON), bdSeq → Int64 (4). Rich types (templates, datasets) are out of scope
 * until something needs them.
 */

const decoder = new SparkplugDecoder(); // schema parses synchronously in the constructor

const DataType = { Int64: 4, Double: 10, Boolean: 11, String: 12 };

function metricValue(m) {
  const v = m.value;
  if (v === null || v === undefined) return { datatype: m.datatype || DataType.String, is_null: true };
  if (typeof v === 'boolean') return { datatype: DataType.Boolean, boolean_value: v };
  if (typeof v === 'number') return { datatype: DataType.Double, double_value: v };
  if (typeof v === 'object') return { datatype: DataType.String, string_value: JSON.stringify(v) };
  return { datatype: DataType.String, string_value: String(v) };
}

/**
 * Encode a Sparkplug payload. `metrics`: [{ name, value, ts?, datatype?, isBdSeq? }].
 */
function encodePayload({ metrics = [], seq = null, ts = Date.now() }) {
  if (!decoder.Payload) throw new Error('Sparkplug protobuf schema unavailable');
  const payload = {
    timestamp: ts,
    metrics: metrics.map((m) => ({
      name: m.name,
      timestamp: m.ts || ts,
      ...(m.isBdSeq ? { datatype: DataType.Int64, long_value: m.value } : metricValue(m))
    }))
  };
  if (seq !== null) payload.seq = seq;
  const err = decoder.Payload.verify(payload);
  if (err) throw new Error(`invalid sparkplug payload: ${err}`);
  return Buffer.from(decoder.Payload.encode(decoder.Payload.create(payload)).finish());
}

module.exports = { encodePayload, DataType };

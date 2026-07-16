'use strict';

/**
 * Alert engine — turns the namespace's passive observability into active
 * notification. Rules live in the profile store (they survive restarts) and are
 * evaluated on a fixed interval against the same structures the UI reads (topic
 * store, trie, event rings) — no extra ingest-path cost.
 *
 * Rule types:
 * - `branch-silent`: fires when nothing under `path` has published for
 *   `thresholdMs`. Stateful — fires on the silent transition, resolves on the
 *   first message back.
 * - `topic-silent`: same, for one exact topic.
 * - `new-topic`: fires once per new topic appearing under `prefix` (watermark
 *   over the store's topic-added event ring; not stateful).
 * - `value-threshold`: fires when a numeric payload value (optionally a
 *   dot-path `field` into a JSON payload) crosses `value` per `op`. Evaluated
 *   on the manager's live message tap (not the 15s poll) so alerts land at
 *   message latency. Supports `sustainMs` (condition must hold continuously
 *   before firing) and `clearValue` hysteresis (for '>' rules, resolve only
 *   once the value falls back to <= clearValue — no flapping in the deadband).
 *   `topic` may be exact or an MQTT filter with +/#.
 *
 * Every firing is emitted on the socket (`alert`), kept in a bounded history
 * ring (GET /api/alerts/events), and optionally POSTed to the rule's
 * `webhookUrl` (5s timeout, failures logged and swallowed — a dead webhook
 * must never break evaluation).
 */

const { matchParts, compiledView } = require('./mqttMatch');

const EVAL_MS = 15_000;
const HISTORY_MAX = 500;
const WEBHOOK_TIMEOUT_MS = 5_000;
// A wildcard value-threshold rule keeps one state machine PER concrete topic it
// matches; bound that fan-out so a rule over a huge namespace can't grow state
// without limit. Oldest-inserted topic is evicted past the cap.
const VALUE_STATE_MAX_TOPICS = 5000;

const RULE_TYPES = ['branch-silent', 'topic-silent', 'new-topic', 'value-threshold'];

const VALUE_OPS = ['>', '>=', '<', '<=', '==', '!='];
const OPS = {
  '>': (a, b) => a > b,
  '>=': (a, b) => a >= b,
  '<': (a, b) => a < b,
  '<=': (a, b) => a <= b,
  '==': (a, b) => a === b,
  '!=': (a, b) => a !== b
};

/**
 * Pull the numeric value a value-threshold rule watches out of a tapped
 * message payload. `fieldParts` is the pre-split dot-path (null = the payload
 * itself). Returns a finite number or null (null = "not our kind of message",
 * never an error — namespaces mix types on the same branch all the time).
 */
function extractValue(payload, fieldParts) {
  let v = payload;
  if (fieldParts) {
    for (const seg of fieldParts) {
      if (v === null || typeof v !== 'object') return null;
      v = v[seg];
    }
  }
  // Reject non-scalar shapes and JS coercion traps (Number('') === 0,
  // Number(true) === 1, Number([5]) === 5) — only real numbers alert.
  if (typeof v === 'object' || typeof v === 'boolean' || v === '' || v === undefined || v === null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

class AlertEngine {
  constructor({ io, profiles, mqttManager, fetchImpl = globalThis.fetch, intervalMs = EVAL_MS }) {
    this.io = io;
    this.profiles = profiles;
    this.manager = mqttManager;
    this.fetchImpl = fetchImpl;
    this.intervalMs = intervalMs;
    this.state = new Map(); // ruleId -> { firing, since, watermark } (silence/new-topic rules)
    this.valueState = new Map(); // ruleId -> Map(topic -> { firing, since, breachedSince, lastValue })
    this.history = []; // bounded ring, newest last
    this.timer = null;
    this.webhookFailures = 0;
    this.lastWebhookError = null;
    this.tapping = false;
    this.onMessage = this.onMessage.bind(this);
    // Compiled value-rule table (filters and field paths pre-split, disabled
    // rules excluded), rebuilt only when the profile store's revision changes —
    // same pattern as the pipeline engine, so the steady-state per-message
    // cost is an integer compare plus array walks.
    this.valueTable = profiles
      ? compiledView(profiles, () =>
          (profiles.alertRules() || [])
            .filter((r) => r.type === 'value-threshold' && r.enabled !== false && r.brokerId && r.topic && OPS[r.op])
            .map((r) => ({
              rule: r,
              parts: String(r.topic).split('/'),
              fieldParts: r.field ? String(r.field).split('.') : null
            }))
        )
      : () => [];
  }

  start() {
    // Value rules ride the live message tap; silence rules keep the interval.
    if (!this.tapping && this.manager?.on) {
      this.manager.on('message', this.onMessage);
      this.tapping = true;
    }
    if (this.timer) return;
    this.timer = setInterval(() => this.evaluate(), this.intervalMs);
    this.timer.unref?.();
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
    if (this.tapping) {
      this.manager?.off?.('message', this.onMessage);
      this.tapping = false;
    }
  }

  /** One evaluation pass over all rules. Exposed for tests. */
  evaluate(now = Date.now()) {
    const rules = this.profiles?.alertRules() || [];
    const liveIds = new Set(rules.map((r) => r.id));
    for (const id of this.state.keys()) if (!liveIds.has(id)) this.state.delete(id);
    for (const id of this.valueState.keys()) if (!liveIds.has(id)) this.valueState.delete(id);

    for (const rule of rules) {
      try {
        if (rule.enabled === false) continue;
        if (rule.type === 'new-topic') this._evalNewTopic(rule);
        else if (rule.type === 'branch-silent' || rule.type === 'topic-silent') this._evalSilent(rule, now);
      } catch (error) {
        // One bad rule (e.g. broker gone) must not stop the rest.
        console.warn(`alertEngine: rule ${rule.id} (${rule.name || rule.type}): ${error.message}`);
      }
    }
  }

  _ruleState(rule) {
    let s = this.state.get(rule.id);
    if (!s) {
      // silence + new-topic rules only; value-threshold rules use _valueState.
      s = { firing: false, since: 0, armed: false, watermark: 0 };
      this.state.set(rule.id, s);
    }
    return s;
  }

  /**
   * Per-(rule, concrete topic) state for value-threshold rules. A wildcard rule
   * like `plant/+/temp` must track each pump independently — sharing one state
   * machine (the old bug) let a normal reading on one topic reset another's
   * sustain clock, suppressing a real breach, and made 'resolved' events cite
   * the wrong topic.
   */
  _valueState(rule, topic) {
    let byTopic = this.valueState.get(rule.id);
    if (!byTopic) {
      byTopic = new Map();
      this.valueState.set(rule.id, byTopic);
    }
    let s = byTopic.get(topic);
    if (!s) {
      if (byTopic.size >= VALUE_STATE_MAX_TOPICS) {
        byTopic.delete(byTopic.keys().next().value); // evict oldest-inserted
      }
      s = { firing: false, since: 0, breachedSince: 0, lastValue: null };
      byTopic.set(topic, s);
    }
    return s;
  }

  _evalSilent(rule, now) {
    const threshold = Number(rule.thresholdMs) || 60_000;
    let last;
    if (rule.type === 'topic-silent') {
      const store = this.manager.stores.get(rule.brokerId);
      if (!store) return; // broker unknown/not connected — nothing to say
      const row = store.getLatest(rule.topic);
      last = row ? row.ts : 0;
    } else {
      last = this.manager.branchLastActivity(rule.brokerId, rule.path || '');
    }
    if (last === null) return; // broker unknown/not connected — nothing to say

    const silentFor = last > 0 ? now - last : Infinity;
    const shouldFire = silentFor > threshold;
    const s = this._ruleState(rule);
    if (shouldFire && !s.firing) {
      s.firing = true;
      s.since = now;
      this._emit(rule, 'firing', {
        silentForMs: last > 0 ? silentFor : null,
        lastActivity: last || null,
        detail: last > 0 ? `Silent for ${Math.round(silentFor / 1000)}s (threshold ${Math.round(threshold / 1000)}s)` : 'No data ever observed'
      });
    } else if (!shouldFire && s.firing) {
      s.firing = false;
      this._emit(rule, 'resolved', { lastActivity: last, detail: 'Data is flowing again' });
    }
  }

  _evalNewTopic(rule) {
    const store = this.manager.stores.get(rule.brokerId);
    if (!store) return;
    const s = this._ruleState(rule);
    // Watermark on the store's monotonic event seq, not wall-clock time — two
    // events in the same millisecond would otherwise slip past a ts watermark.
    if (!s.armed) {
      s.armed = true;
      s.watermark = store.eventSeq; // pre-existing topics never fire
      return;
    }
    const prefix = rule.prefix || '';
    const fresh = store.events.filter(
      (e) => e.type === 'topic-added' && e.seq > s.watermark && (!prefix || e.topic.startsWith(prefix))
    );
    s.watermark = store.eventSeq;
    for (const e of fresh.slice(0, 20)) {
      this._emit(rule, 'event', { topic: e.topic, detail: `New topic appeared: ${e.topic}` });
    }
    if (fresh.length > 20) {
      this._emit(rule, 'event', { detail: `…and ${fresh.length - 20} more new topics in this window` });
    }
  }

  /**
   * Live-tap handler for value-threshold rules. Hot path: nothing allocates
   * until a rule's broker matches (topic split is lazy and reuses the
   * manager's pre-split parts when present), and the rule table is compiled.
   * `now` is injectable for deterministic sustain tests.
   */
  onMessage(msg, now = Date.now()) {
    const table = this.valueTable();
    if (!table.length) return;
    let topicParts = null;
    for (const entry of table) {
      if (entry.rule.brokerId !== msg.brokerId) continue;
      if (!topicParts) topicParts = msg.topicParts || msg.topic.split('/');
      if (!matchParts(entry.parts, topicParts)) continue;
      try {
        this._evalValue(entry, msg, now);
      } catch (error) {
        console.warn(`alertEngine: rule ${entry.rule.id} (${entry.rule.name || entry.rule.type}): ${error.message}`);
      }
    }
  }

  /**
   * Value-threshold state machine, per rule:
   *
   *   ok --breach--> breached (breachedSince set)
   *   breached --held for sustainMs--> FIRING (emit 'firing')
   *   breached --condition drops--> ok (sustain clock resets)
   *   FIRING --clear condition--> ok (emit 'resolved')
   *   FIRING --in hysteresis deadband--> FIRING (no flap, no re-emit)
   *
   * With sustainMs = 0 the breached state fires on the first breaching
   * message. The clear condition defaults to "op no longer true"; with
   * clearValue set, '>'/'>=' rules resolve only at value <= clearValue and
   * '<'/'<=' rules only at value >= clearValue.
   */
  _evalValue(entry, msg, now) {
    const rule = entry.rule;
    const v = extractValue(msg.payload, entry.fieldParts);
    if (v === null) return; // non-numeric payload/field — not ours to judge
    const s = this._valueState(rule, msg.topic);
    s.lastValue = v;
    const limit = Number(rule.value);
    const sustainMs = Number(rule.sustainMs) > 0 ? Number(rule.sustainMs) : 0;
    const breached = OPS[rule.op](v, limit);
    const label = rule.field || 'value';

    if (breached) {
      if (!s.breachedSince) s.breachedSince = now;
      if (!s.firing && now - s.breachedSince >= sustainMs) {
        s.firing = true;
        s.since = now;
        this._emit(rule, 'firing', {
          topic: msg.topic,
          value: v,
          detail:
            `${label} = ${v} (${rule.op} ${limit}` +
            (sustainMs ? `, sustained ${Math.round(sustainMs / 1000)}s` : '') +
            `) on ${msg.topic}`
        });
      }
    } else {
      s.breachedSince = 0; // sustain clock only counts continuous breach
      if (s.firing && this._isCleared(rule, v)) {
        s.firing = false;
        this._emit(rule, 'resolved', {
          topic: msg.topic,
          value: v,
          detail: `${label} = ${v} back within limit on ${msg.topic}`
        });
      }
    }
  }

  /** Hysteresis clear check — see the _evalValue state machine notes. */
  _isCleared(rule, v) {
    if (rule.clearValue === null || rule.clearValue === undefined || rule.clearValue === '') return true;
    const clear = Number(rule.clearValue);
    if (!Number.isFinite(clear)) return true;
    if (rule.op === '>' || rule.op === '>=') return v <= clear;
    if (rule.op === '<' || rule.op === '<=') return v >= clear;
    return true; // ==/!= have no meaningful deadband
  }

  _emit(rule, status, extra = {}) {
    const evt = {
      ruleId: rule.id,
      ruleName: rule.name || rule.type,
      type: rule.type,
      brokerId: rule.brokerId,
      status, // 'firing' | 'resolved' | 'event'
      ts: Date.now(),
      ...extra
    };
    this.history.push(evt);
    if (this.history.length > HISTORY_MAX) this.history.splice(0, this.history.length - HISTORY_MAX);
    this.io?.emit('alert', evt);
    if (rule.webhookUrl && typeof this.fetchImpl === 'function') {
      const signal = typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(WEBHOOK_TIMEOUT_MS) : undefined;
      // Failures are recorded, not console-logged: this fires from an async
      // callback, and stray console writes from library code are noise in the
      // server log and poison in test-runner child processes.
      this.fetchImpl(rule.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(evt),
        signal
      }).catch((error) => {
        this.webhookFailures++;
        this.lastWebhookError = `rule ${rule.id}: ${error.message}`;
      });
    }
  }

  getEvents(limit = 200) {
    return this.history.slice(-limit).reverse();
  }
}

module.exports = { AlertEngine, RULE_TYPES, VALUE_OPS };

'use strict';

const fs = require('fs');
const readline = require('readline');

/**
 * Replayer — plays a Recorder file back onto a broker with original relative
 * timing (scaled by `speed`), optionally looping. One replay at a time: a
 * replay is a deliberate test action on a broker, and overlapping replays of
 * different recordings is almost always a mistake.
 *
 * Payloads publish exactly as recorded (objects re-serialize to JSON).
 */

const MAX_LINES = 200_000;

class Replayer {
  constructor({ mqttManager, recorder }) {
    this.manager = mqttManager;
    this.recorder = recorder;
    this.active = null; // { recordingId, brokerId, speed, loop, index, total, published, errors, startedAt }
    this.timer = null;
    this.messages = [];
  }

  async start({ recordingId, brokerId, speed = 1, loop = false, topicPrefix = '' }) {
    if (this.active) throw new Error('a replay is already running — stop it first');
    await this.recorder.sync?.(recordingId); // flush buffered writes first
    const file = this.recorder.filePath(recordingId);
    if (!fs.existsSync(file)) throw new Error('recording has no data file');
    this.manager.requireClient(brokerId); // throws unless connected

    const messages = [];
    const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line) continue;
      try {
        messages.push(JSON.parse(line));
      } catch {
        // skip corrupt line
      }
      if (messages.length >= MAX_LINES) break;
    }
    if (!messages.length) throw new Error('recording is empty');
    messages.sort((a, b) => a.t - b.t);

    this.messages = messages;
    this.active = {
      recordingId,
      brokerId,
      speed: Math.max(0.1, Math.min(100, Number(speed) || 1)),
      loop: Boolean(loop),
      topicPrefix: topicPrefix || '',
      index: 0,
      total: messages.length,
      published: 0,
      errors: 0,
      gapsClamped: 0, // gaps longer than 60s are shortened — counted, not hidden
      startedAt: Date.now()
    };
    this._scheduleNext();
    return this.getStatus();
  }

  _scheduleNext() {
    const a = this.active;
    if (!a) return;
    if (a.index >= this.messages.length) {
      if (a.loop) {
        a.index = 0;
      } else {
        this.stop('finished');
        return;
      }
    }
    const cur = this.messages[a.index];
    const prev = a.index > 0 ? this.messages[a.index - 1] : cur;
    const gap = Math.max(0, cur.t - prev.t) / a.speed;
    if (gap > 60_000) a.gapsClamped++;
    this.timer = setTimeout(() => this._publishCurrent(), Math.min(gap, 60_000));
    this.timer.unref?.();
  }

  _publishCurrent() {
    const a = this.active;
    if (!a) return;
    const m = this.messages[a.index];
    a.index++;
    this.manager
      .publish(a.brokerId, `${a.topicPrefix}${m.topic}`, m.v, { qos: m.q || 0 })
      .then(() => {
        a.published++;
      })
      .catch(() => {
        a.errors++;
      });
    this._scheduleNext();
  }

  stop(reason = 'stopped') {
    clearTimeout(this.timer);
    const last = this.active ? { ...this.active, state: reason } : null;
    this.active = null;
    this.messages = [];
    this.lastRun = last;
    return last;
  }

  getStatus() {
    if (this.active) return { running: true, ...this.active };
    return { running: false, lastRun: this.lastRun || null };
  }
}

module.exports = Replayer;

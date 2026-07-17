import { useCallback, useEffect, useRef, useState } from 'react';
import { Play, Pause, RotateCcw, Gauge, History } from 'lucide-react';

/**
 * Replays the recently buffered message traffic over the graph. Steps through
 * the buffer oldest-to-newest (time-compressed) and fires `graphRef.pulseNode`
 * for each, so you can watch a burst of activity play back on the topology.
 *
 * Framed so it explains itself: a header names it and shows the scope (how many
 * messages, over what span), the track runs oldest → now with a *relative*
 * readout ("-6.4s" → "now"), and a "Replaying" indicator marks that the graph
 * flashes are a replay, not live traffic. The track is a real seek control:
 * click/drag to scrub, arrow keys to nudge, speed cycles 0.5x/1x/2x.
 */
const SPEEDS = [0.5, 1, 2];

// How far behind "now" the playhead sits, phrased relatively so it reads as
// "replaying the recent past" rather than an unexplained wall-clock time.
function fmtBehind(ms) {
  if (!Number.isFinite(ms)) return '';
  if (ms < 150) return 'now';
  return `-${(ms / 1000).toFixed(1)}s`;
}

export default function ReplayScrubber({ messages, toNodeId, graphRef, durationMs = 6000 }) {
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [speed, setSpeed] = useState(1);
  const rafRef = useRef(0);
  const startTsRef = useRef(0); // rAF timestamp when the current play leg began
  const baseFracRef = useRef(0); // progress fraction at the start of this leg
  const idxRef = useRef(0);
  const progressRef = useRef(0);
  const speedRef = useRef(1);
  const trackRef = useRef(null);
  const draggingRef = useRef(false);

  progressRef.current = progress;
  speedRef.current = speed;

  // Chronological copy with resolved node ids (oldest first).
  const events = useRef([]);
  events.current = messages
    .map((m) => ({ t: new Date(m.timestamp).getTime(), nodeId: toNodeId(m) }))
    .filter((e) => e.nodeId && Number.isFinite(e.t))
    .sort((a, b) => a.t - b.t);

  const evs = events.current;
  const disabled = evs.length < 2;
  const t0 = disabled ? 0 : evs[0].t;
  const span = disabled ? 1 : Math.max(evs[evs.length - 1].t - t0, 1);

  const cancelRaf = () => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = 0;
  };

  useEffect(() => () => cancelRaf(), []);

  const step = useCallback(
    (ts) => {
      const list = events.current;
      if (!startTsRef.current) startTsRef.current = ts;
      const effective = durationMs / speedRef.current;
      const frac = Math.min(baseFracRef.current + (ts - startTsRef.current) / effective, 1);
      const virtualNow = list[0].t + frac * Math.max(list[list.length - 1].t - list[0].t, 1);

      while (idxRef.current < list.length && list[idxRef.current].t <= virtualNow) {
        graphRef.current?.pulseNode(list[idxRef.current].nodeId);
        idxRef.current++;
      }
      setProgress(frac);

      if (frac < 1) {
        rafRef.current = requestAnimationFrame(step);
      } else {
        rafRef.current = 0;
        setPlaying(false);
      }
    },
    [durationMs, graphRef]
  );

  // Jump to a fraction without pulsing the skipped events (scrub, not fast-forward).
  const seekTo = useCallback(
    (fracRaw) => {
      const list = events.current;
      if (list.length < 2) return;
      const frac = Math.max(0, Math.min(1, fracRaw));
      const virtual = list[0].t + frac * Math.max(list[list.length - 1].t - list[0].t, 1);
      let i = 0;
      while (i < list.length && list[i].t <= virtual) i++;
      idxRef.current = i;
      baseFracRef.current = frac;
      startTsRef.current = 0; // step re-baselines to the next frame
      setProgress(frac);
    },
    []
  );

  const play = () => {
    if (disabled) return;
    // Restart from the top if we're at (or past) the end.
    if (progressRef.current >= 1) seekTo(0);
    baseFracRef.current = progressRef.current;
    startTsRef.current = 0;
    setPlaying(true);
    cancelRaf();
    rafRef.current = requestAnimationFrame(step);
  };

  const pause = () => {
    cancelRaf();
    setPlaying(false);
  };

  const reset = () => {
    pause();
    seekTo(0);
  };

  const fracFromPointer = (clientX) => {
    const el = trackRef.current;
    if (!el) return 0;
    const r = el.getBoundingClientRect();
    return (clientX - r.left) / Math.max(r.width, 1);
  };

  const onTrackDown = (e) => {
    if (disabled) return;
    e.preventDefault();
    draggingRef.current = true;
    trackRef.current?.setPointerCapture?.(e.pointerId);
    seekTo(fracFromPointer(e.clientX));
  };
  const onTrackMove = (e) => {
    if (!draggingRef.current) return;
    seekTo(fracFromPointer(e.clientX));
  };
  const onTrackUp = (e) => {
    draggingRef.current = false;
    trackRef.current?.releasePointerCapture?.(e.pointerId);
  };
  const onTrackKey = (e) => {
    if (disabled) return;
    const nudge = 0.05;
    if (e.key === 'ArrowLeft') seekTo(progressRef.current - nudge);
    else if (e.key === 'ArrowRight') seekTo(progressRef.current + nudge);
    else if (e.key === 'Home') seekTo(0);
    else if (e.key === 'End') seekTo(1);
    else if (e.key === ' ' || e.key === 'Enter') playing ? pause() : play();
    else return;
    e.preventDefault();
  };

  const cycleSpeed = () => setSpeed((s) => SPEEDS[(SPEEDS.indexOf(s) + 1) % SPEEDS.length]);

  const count = evs.length;
  const spanSec = span / 1000;
  const behindMs = disabled ? NaN : (1 - progress) * span;

  // Not enough buffered traffic to replay — say so plainly instead of showing a
  // dead widget with no explanation.
  if (disabled) {
    return (
      <div className="pointer-events-auto flex items-center gap-2 rounded-xl border border-white/10 bg-surface-900/80 px-3 py-2 text-[11px] text-slate-500 backdrop-blur">
        <History size={13} />
        <span>Replay — waiting for buffered messages…</span>
      </div>
    );
  }

  return (
    <div className="pointer-events-auto w-[300px] rounded-xl border border-white/10 bg-surface-900/85 px-3 py-2 backdrop-blur">
      {/* Header: name the control, state its scope, and flag when it's actively
          driving the graph flashes (so replay reads distinct from live Flow). */}
      <div className="mb-1.5 flex items-center gap-2">
        <History size={13} className="text-accent-300" />
        <span className="text-[11px] font-semibold text-slate-200">Replay</span>
        <span className="text-[11px] text-slate-500">
          last {count} msgs · {spanSec < 1 ? '<1' : Math.round(spanSec)}s
        </span>
        {playing && (
          <span className="ml-auto flex items-center gap-1 text-[10px] font-medium text-accent-300">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent-400" />
            Replaying
          </span>
        )}
      </div>

      <div className="flex items-center gap-2.5">
        <button
          onClick={playing ? pause : play}
          title={playing ? 'Pause' : 'Replay the buffered traffic on the graph'}
          className="grid h-6 w-6 shrink-0 place-items-center rounded-lg bg-accent-500/20 text-accent-200 hover:bg-accent-500/30"
        >
          {playing ? <Pause size={13} /> : <Play size={13} />}
        </button>

        <div className="flex flex-1 flex-col gap-0.5">
          <div
            ref={trackRef}
            role="slider"
            tabIndex={0}
            aria-label="Replay position (oldest to now)"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(progress * 100)}
            aria-valuetext={fmtBehind(behindMs)}
            onPointerDown={onTrackDown}
            onPointerMove={onTrackMove}
            onPointerUp={onTrackUp}
            onKeyDown={onTrackKey}
            className={clsxTrack(false)}
          >
            <div className="pointer-events-none absolute inset-y-0 left-0 my-auto h-1.5 w-full rounded-full bg-white/10" />
            <div className="pointer-events-none absolute inset-y-0 left-0 my-auto h-1.5 rounded-full bg-accent-500" style={{ width: `${progress * 100}%` }} />
            <div
              className="pointer-events-none absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-accent-300 shadow ring-2 ring-surface-900"
              style={{ left: `${progress * 100}%` }}
            />
          </div>
          <div className="flex justify-between px-0.5 text-[9px] uppercase tracking-wide text-slate-600">
            <span>oldest</span>
            <span>now</span>
          </div>
        </div>

        <span
          className="w-[42px] shrink-0 text-right text-[11px] tabular-nums text-slate-400"
          title="Playhead position, relative to the newest buffered message"
        >
          {fmtBehind(behindMs)}
        </span>

        <button
          onClick={cycleSpeed}
          title="Playback speed"
          className="flex shrink-0 items-center gap-1 rounded-lg border border-white/10 px-1.5 py-1 text-[11px] font-medium text-slate-400 hover:text-slate-200"
        >
          <Gauge size={12} />
          {speed}×
        </button>

        <button onClick={reset} title="Reset to start" className="shrink-0 text-slate-400 hover:text-slate-200">
          <RotateCcw size={13} />
        </button>
      </div>
    </div>
  );
}

// The track is a focusable seek surface: relative box, generous height for the
// hit area, visible focus ring for keyboard users.
function clsxTrack(disabled) {
  return [
    'relative h-5 w-full rounded-full',
    disabled ? 'cursor-not-allowed opacity-40' : 'cursor-pointer',
    'focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/60'
  ].join(' ');
}

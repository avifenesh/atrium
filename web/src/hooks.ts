// shared atmosphere hooks — clock ticks, number tweens, system history buffers.
import { useEffect, useRef, useState } from 'react';
import type { Snapshot } from '../../shared/types';

// shared tickers: dozens of RelTime instances must flip in the same frame, not
// each on a private setInterval drifting out of phase
const tickers = new Map<number, { timer: ReturnType<typeof setInterval>; subs: Set<(t: number) => void> }>();

function subscribeTick(intervalMs: number, cb: (t: number) => void): () => void {
  let entry = tickers.get(intervalMs);
  if (!entry) {
    entry = { subs: new Set(), timer: setInterval(() => {
      const t = Date.now();
      for (const sub of tickers.get(intervalMs)?.subs ?? []) sub(t);
    }, intervalMs) };
    tickers.set(intervalMs, entry);
  }
  entry.subs.add(cb);
  return () => {
    entry.subs.delete(cb);
    if (entry.subs.size === 0) {
      clearInterval(entry.timer);
      tickers.delete(intervalMs);
    }
  };
}

/** epoch ms, re-renders on a shared interval (default 30s — RelTime granularity). */
export function useNow(intervalMs = 30000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => subscribeTick(intervalMs, setNow), [intervalMs]);
  return now;
}

/** rAF ease-out tween from the previously rendered value to target, rounded int.
 *  jumps instantly under prefers-reduced-motion. */
export function useTweenNumber(target: number, durationMs = 600): number {
  const [value, setValue] = useState(target);
  const renderedRef = useRef(value);
  renderedRef.current = value;
  useEffect(() => {
    const from = renderedRef.current;
    const reduced =
      typeof matchMedia === 'function' &&
      matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduced || from === target) {
      setValue(target);
      return;
    }
    let raf = 0;
    const start = performance.now();
    const step = (t: number) => {
      const p = Math.min(1, (t - start) / durationMs);
      const eased = 1 - Math.pow(1 - p, 3); // ease-out cubic
      setValue(from + (target - from) * eased);
      if (p < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target, durationMs]);
  return Math.round(value);
}

// ---- body scroll lock (refcounted: overlays stack and can unmount out of order;
// a plain save/restore pair can strand overflow:hidden when two overlays close in
// one commit — count locks instead, clear only at zero) ----

let scrollLocks = 0;

/** lock body scroll while the calling overlay is mounted. */
export function useScrollLock(): void {
  useEffect(() => {
    scrollLocks += 1;
    document.body.style.overflow = 'hidden';
    return () => {
      scrollLocks -= 1;
      if (scrollLocks === 0) document.body.style.overflow = '';
    };
  }, []);
}

// ---- system history ring buffers (module-level: survive re-mounts, not reloads) ----

const CAP = 180;
const buffers: Record<'cpu' | 'mem' | 'swap' | 'gpu', number[]> = {
  cpu: [],
  mem: [],
  swap: [],
  gpu: [],
};
let lastSampleAt: string | null = null;

function push(key: keyof typeof buffers, v: number) {
  const buf = buffers[key];
  buf.push(v);
  if (buf.length > CAP) buf.shift();
}

/** Adopt the system metric history. The server now persists this (survives reload
 *  + daemon restart), so when the snapshot carries it we mirror it wholesale —
 *  the graphs have depth on the first frame. Only when it's absent (older server)
 *  do we fall back to accumulating locally, deduped by system.updatedAt. */
export function recordSystemSample(s: Snapshot): void {
  const sys = s.system;
  const h = sys.history;
  if (h && Array.isArray(h.cpu)) {
    buffers.cpu = h.cpu;
    buffers.mem = h.mem;
    buffers.swap = h.swap;
    buffers.gpu = h.gpu ?? [];
    return;
  }
  if (!sys.updatedAt || sys.updatedAt === lastSampleAt) return;
  lastSampleAt = sys.updatedAt;
  push('cpu', sys.cpu.pct);
  push('mem', sys.mem.usedPct);
  push('swap', sys.swap.usedPct);
  if (sys.gpu) push('gpu', sys.gpu.utilPct);
}

/** oldest→newest. */
export function getSeries(key: 'cpu' | 'mem' | 'swap' | 'gpu'): number[] {
  return buffers[key];
}

/** one urgency scale for utilization percents — amber/coral must mean the same
 *  numbers in every panel. */
export function pctTone(pct: number | null): string {
  if (pct === null) return 'text-mist-faint';
  return pct > 90 ? 'text-coral' : pct > 75 ? 'text-amber' : 'text-mist-faint';
}

import type { ItchRunInfo } from '../../../../shared/types';

// ---------- display helpers ----------

export const COLLIDE_PREFIX_RE = /^\[collide\]\s*/;

/** display title only — ratings are title-keyed and must send the ORIGINAL string. */
export function displayTitle(t: string): string {
  return t.replace(COLLIDE_PREFIX_RE, '');
}

/** "20260608-170934" → "2026-06-08 17:09" */
export function fmtStem(stem: string): string {
  const m = stem.match(/^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}` : stem;
}

export const RATING_LABEL: Record<number, string> = {
  1: 'drop',
  2: 'cool',
  3: 'neutral',
  4: 'interested',
  5: 'pursuing',
};

/** "n/m" = ideas/rated — labels must stay short enough for the run picker.
 *  same-day runs swap the date for 'today' so a deep picker scans by time alone.
 *  collide runs get a domain hint from sampledDomains — first domain only,
 *  truncated, since labels render inside a native <option> (one short line). */
export function runLabel(r: ItchRunInfo): string {
  const now = new Date();
  const todayKey = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
  const m = r.stem.match(/^(\d{8})-(\d{2})(\d{2})/);
  const when = m && m[1] === todayKey ? `today ${m[2]}:${m[3]}` : fmtStem(r.stem);
  let s = `${when} · ${r.nIdeas}/${r.nRated}`;
  if (r.isCollide) s += ` · collide ${(r.collisionTemp ?? 0).toFixed(2)}`;
  if (r.isCollide && r.sampledDomains.length > 0) {
    const d = r.sampledDomains[0];
    s += ` · ${d.length > 12 ? `${d.slice(0, 12)}…` : d}`;
    if (r.sampledDomains.length > 1) s += ` +${r.sampledDomains.length - 1}`;
  }
  if (r.baselineFor) s += ' · baseline';
  return s;
}

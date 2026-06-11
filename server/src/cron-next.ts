// zero-dep 5-field cron parser — local time, returns null on anything unsupported (never throws)

function parseField(field: string, min: number, max: number): Set<number> | null {
  const out = new Set<number>();
  for (const part of field.split(',')) {
    const m = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part);
    if (!m) return null;
    const step = m[2] ? parseInt(m[2], 10) : 1;
    if (step < 1) return null;
    if (m[2] && m[1] !== '*' && !m[1].includes('-')) return null; // bare value + step: unsupported
    let lo = min;
    let hi = max;
    if (m[1] !== '*') {
      const [a, b] = m[1].split('-').map(Number);
      lo = a;
      hi = b ?? a;
    }
    if (lo < min || hi > max || lo > hi) return null;
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out.size ? out : null;
}

export function nextRun(expr: string, from: Date = new Date()): string | null {
  if (typeof expr !== 'string') return null;
  const f = expr.trim().split(/\s+/);
  if (f.length !== 5) return null;
  const minute = parseField(f[0], 0, 59);
  const hour = parseField(f[1], 0, 23);
  const dom = parseField(f[2], 1, 31);
  const month = parseField(f[3], 1, 12);
  const dow = parseField(f[4], 0, 7);
  if (!minute || !hour || !dom || !month || !dow) return null;
  if (dow.has(7)) dow.add(0);

  // vixie rule: day fields AND when either starts with '*' (star-with-step keeps
  // its restriction); OR only when both are restricted
  const domStar = f[2].startsWith('*');
  const dowStar = f[4].startsWith('*');
  const dayMatch = (d: Date): boolean => {
    const mDom = dom.has(d.getDate());
    const mDow = dow.has(d.getDay());
    return domStar || dowStar ? mDom && mDow : mDom || mDow;
  };

  const t = new Date(from.getTime());
  t.setSeconds(0, 0);
  t.setMinutes(t.getMinutes() + 1);
  const limit = from.getTime() + 5 * 366 * 24 * 3600 * 1000; // wide enough for leap-day schedules; impossible dates (e.g. feb 30) bail here
  while (t.getTime() <= limit) {
    if (!month.has(t.getMonth() + 1)) {
      t.setMonth(t.getMonth() + 1, 1);
      t.setHours(0, 0, 0, 0);
    } else if (!dayMatch(t)) {
      t.setDate(t.getDate() + 1);
      t.setHours(0, 0, 0, 0);
    } else if (!hour.has(t.getHours())) {
      t.setHours(t.getHours() + 1, 0, 0, 0);
    } else if (!minute.has(t.getMinutes())) {
      t.setMinutes(t.getMinutes() + 1);
    } else {
      return t.toISOString();
    }
  }
  return null;
}

// self-test: node src/cron-next.ts (or dist/.../cron-next.js)
if (process.argv[1]?.replace(/\.[jt]s$/, '').endsWith('cron-next')) {
  const from = new Date('2026-06-11T10:07:00'); // local thu
  const cases: Array<[string, string | null]> = [
    ['*/15 * * * *', iso(2026, 6, 11, 10, 15)],
    ['0 20 * * *', iso(2026, 6, 11, 20, 0)],
    ['40 7 * * *', iso(2026, 6, 12, 7, 40)],
    ['*/30 * * * *', iso(2026, 6, 11, 10, 30)],
    ['0 */6 * * *', iso(2026, 6, 11, 12, 0)],
    ['0 3 * * *', iso(2026, 6, 12, 3, 0)],
    ['5,35 9-17 * * *', iso(2026, 6, 11, 10, 35)],
    ['0 0 1 1 *', iso(2027, 1, 1, 0, 0)],
    ['0 12 * * 0', iso(2026, 6, 14, 12, 0)], // next sunday
    ['0 12 * * 7', iso(2026, 6, 14, 12, 0)], // 7 == sunday
    ['0 12 13 * 5', iso(2026, 6, 12, 12, 0)], // vixie OR: fri 12th before sat 13th
    ['0 12 13 * *', iso(2026, 6, 13, 12, 0)], // dom only
    ['0 0 */2 * *', iso(2026, 6, 13, 0, 0)], // star-with-step dom keeps restriction (odd days)
    ['0 0 13 7 */2', iso(2027, 7, 13, 0, 0)], // restricted dom AND star-step dow: jul 13 2026 is mon, skip to tue 2027
    ['0 0 29 2 *', iso(2028, 2, 29, 0, 0)], // leap day beyond 2y horizon
    ['0 0 30 2 *', null], // feb 30 never matches
    ['@daily', null],
    ['* * * *', null],
    ['61 * * * *', null],
    ['*/0 * * * *', null],
    ['MON * * * *', null],
    ['1,2-x * * * *', null],
  ];
  function iso(y: number, mo: number, d: number, h: number, mi: number): string {
    return new Date(y, mo - 1, d, h, mi).toISOString();
  }
  let fail = 0;
  for (const [expr, want] of cases) {
    const got = nextRun(expr, from);
    if (got !== want) {
      fail++;
      console.error(`FAIL ${expr}: got ${got}, want ${want}`);
    }
  }
  console.log(fail === 0 ? `ok (${cases.length} cases)` : `${fail} failures`);
  process.exitCode = fail === 0 ? 0 : 1;
}

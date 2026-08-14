import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { config } from '../config.js';
import { nextRun } from '../cron-next.js';
import { shTry, readJson, redactSecrets, iso } from '../util.js';
import { store } from '../state.js';
import type { Collector } from './registry.js';
import type { Flag, ScheduleEntry } from '../../../shared/types.js';

const WATCHER_SCRIPT = join(homedir(), '.local', 'bin', 'idle-proactive-watcher.py');

function shortCmd(cmd: string): string {
  // drop redirections, shorten $HOME, strip secrets — keep the readable core of the command
  const s = redactSecrets(cmd)
    .replace(/\s+\d?>>?\s*\S+/g, '')
    .replace(/\s+2>&1/g, '')
    .replace(new RegExp(homedir(), 'g'), '~')
    .replace(/\s+/g, ' ')
    .trim();
  return s.length > 80 ? `${s.slice(0, 77)}...` : s;
}

/** Stable content-derived crontab entry id — index-based ids shift persisted mutes when the crontab is edited. */
function cronId(cmd: string): string {
  const slug = cmd
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
    .slice(0, 60);
  let hash = 0;
  for (let i = 0; i < cmd.length; i++) hash = (hash * 31 + cmd.charCodeAt(i)) >>> 0;
  return `crontab:${slug}-${hash.toString(36)}`;
}

// pin first-raise time per flag id so the UI doesn't show flags perpetually "just raised"
// (same treatment as system.ts)
const raisedAtPin = new Map<string, string>();

function pinnedRaisedAt(id: string): string {
  const at = raisedAtPin.get(id) ?? iso();
  raisedAtPin.set(id, at);
  return at;
}

function collectCrontab(out: string, entries: ScheduleEntry[], flags: Flag[]): void {
  const seen = new Set<string>();
  let index = 0;
  for (const raw of out.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (/^[A-Za-z_][A-Za-z0-9_]*\s*=/.test(line)) continue; // env assignment, not a job

    let expr: string;
    let cmd: string;
    if (line.startsWith('@')) {
      const sp = line.indexOf(' ');
      if (sp < 0) continue;
      expr = line.slice(0, sp);
      cmd = line.slice(sp + 1).trim();
    } else {
      const tokens = line.split(/\s+/);
      if (tokens.length < 6) continue;
      expr = tokens.slice(0, 5).join(' ');
      cmd = tokens.slice(5).join(' ');
    }

    let id = cronId(cmd);
    if (seen.has(id)) id = `${id}-${index}`; // same command on two lines — keep ids unique
    seen.add(id);
    entries.push({
      id,
      source: 'crontab',
      name: shortCmd(cmd),
      expr,
      enabled: true,
      nextRun: nextRun(expr), // null for @-shortcuts and anything else the parser doesn't cover
      lastRun: null,
      lastStatus: null,
      detail: shortCmd(cmd), // never the raw line — cron commands commonly embed tokens
      // crontab lines have no pause mechanism, except the idle watcher
      // which honors a suppression file
      muteable: cmd.includes('idle-proactive-watcher'),
    });
    index++;

    // known machine bug: 'deliver' is not a hermes subcommand, the pipe fails every run
    if (cmd.includes('hermes deliver')) {
      flags.push({
        id: 'schedule:hermes-deliver-invalid',
        severity: 'crit',
        title: "nightly cron uses 'hermes deliver' (not a subcommand)",
        detail: `cron '${expr}' (20:00 daily) fails on every run — 'deliver' is not a hermes subcommand; fix: change to 'hermes send'`,
        source: 'schedule',
        raisedAt: pinnedRaisedAt('schedule:hermes-deliver-invalid'),
      });
    }
  }
}

async function collectHermes(entries: ScheduleEntry[]): Promise<void> {
  const data = await readJson<any>(config.paths.hermesCronJobs);
  const jobs = data?.jobs;
  if (!Array.isArray(jobs)) return;
  for (const job of jobs) {
    if (!job?.id) continue;
    entries.push({
      id: `hermes:${job.id}`,
      source: 'hermes',
      name: String(job.name ?? job.id),
      expr: String(job.schedule?.expr ?? job.schedule_display ?? ''),
      enabled: !!job.enabled && job.state !== 'paused',
      nextRun: job.next_run_at ?? null,
      lastRun: job.last_run_at ?? null,
      lastStatus: job.last_status === 'ok' ? 'ok' : job.last_error || job.last_status ? 'fail' : null,
      detail: job.last_error ?? null,
      muteable: true,
    });
  }
}

async function collectRevuto(entries: ScheduleEntry[]): Promise<void> {
  const cfg = await readJson<any>(join(config.paths.revutoVault, 'revuto.config.json'));
  const schedules = cfg?.schedules;
  if (!schedules || typeof schedules !== 'object') return;
  // the revuto collector already polls per-job history into its own section — read it
  // rather than re-fetching; empty until its first successful poll, which is fine
  const jobs = store.get().revuto.jobs;
  for (const [key, expr] of Object.entries(schedules)) {
    if (typeof expr !== 'string') continue;
    let lastRun: string | null = null;
    let lastStatus: 'ok' | 'fail' | null = null;
    for (const j of jobs) {
      if (j.job !== key) continue;
      const ts = Date.parse(j.timestamp);
      if (Number.isNaN(ts) || (lastRun !== null && ts <= Date.parse(lastRun))) continue;
      lastRun = iso(ts);
      lastStatus = j.status === 'ok' ? 'ok' : j.status === 'failed' ? 'fail' : null;
    }
    entries.push({
      id: `revuto:${key}`,
      source: 'revuto',
      name: `revuto ${key}`,
      expr,
      enabled: true,
      nextRun: nextRun(expr),
      lastRun,
      lastStatus,
      detail: null,
      muteable: false,
    });
  }
}

/** systemd JSON timestamps are microseconds since epoch; 0/null = none */
function usEpochToIso(v: unknown): string | null {
  return typeof v === 'number' && v > 0 ? iso(Math.floor(v / 1000)) : null;
}

export interface SystemdServiceStatus {
  result: string | null;
  exitStatus: number | null;
  exitTimestamp: string | null;
  activeState: string | null;
  subState: string | null;
}

/** Parse the stable key/value output from `systemctl show`. */
export function parseSystemdServiceStatus(out: string): SystemdServiceStatus {
  const values = new Map<string, string>();
  for (const line of out.split('\n')) {
    const eq = line.indexOf('=');
    if (eq > 0) values.set(line.slice(0, eq), line.slice(eq + 1));
  }
  const rawExitStatus = values.get('ExecMainStatus') ?? '';
  return {
    result: values.get('Result') || null,
    exitStatus: /^\d+$/.test(rawExitStatus) ? Number(rawExitStatus) : null,
    exitTimestamp: values.get('ExecMainExitTimestamp') || null,
    activeState: values.get('ActiveState') || null,
    subState: values.get('SubState') || null,
  };
}

/** Parse the repeated Id= blocks emitted when `systemctl show` gets many units. */
export function parseSystemdServiceStatuses(out: string): Map<string, SystemdServiceStatus> {
  const statuses = new Map<string, SystemdServiceStatus>();
  let id: string | null = null;
  let block: string[] = [];
  const flush = () => {
    if (id) statuses.set(id, parseSystemdServiceStatus(block.join('\n')));
  };
  for (const line of out.split('\n')) {
    if (line.startsWith('Id=')) {
      flush();
      id = line.slice('Id='.length);
      block = [];
    }
    if (id) block.push(line);
  }
  flush();
  return statuses;
}

function systemdLastStatus(status: SystemdServiceStatus | null): 'ok' | 'fail' | null {
  if (!status?.exitTimestamp || !status.result) return null;
  return status.result === 'success' ? 'ok' : 'fail';
}

function systemdDetail(activates: string | null, status: SystemdServiceStatus | null): string | null {
  if (!activates) return null;
  if (systemdLastStatus(status) !== 'fail') return `activates ${activates}`;
  const result = status?.result ?? 'unknown result';
  const exitStatus = status?.exitStatus === null || status?.exitStatus === undefined
    ? ''
    : `, status ${status.exitStatus}`;
  return `${activates} failed (${result}${exitStatus})`;
}

async function collectSystemdUser(entries: ScheduleEntry[]): Promise<void> {
  const out = await shTry('systemctl', ['--user', 'list-timers', '--all', '--output=json']);
  if (out === null) return;
  let timers: any;
  try {
    timers = JSON.parse(out);
  } catch {
    return; // skip source on unparseable output
  }
  if (!Array.isArray(timers)) return;
  const serviceStatuses = new Map<string, SystemdServiceStatus | null>();
  const services = [...new Set(
    timers
      .map((timer) => (typeof timer?.activates === 'string' ? timer.activates : ''))
      .filter(Boolean),
  )];
  if (services.length > 0) {
    const statusOut = await shTry('systemctl', [
      '--user',
      'show',
      ...services,
      '-p',
      'Id,Result,ExecMainStatus,ExecMainExitTimestamp,ActiveState,SubState',
    ]);
    if (statusOut !== null) {
      for (const [service, status] of parseSystemdServiceStatuses(statusOut)) {
        serviceStatuses.set(service, status);
      }
    }
  }
  for (const t of timers) {
    if (!t?.unit) continue;
    const activates = typeof t.activates === 'string' && t.activates ? t.activates : null;
    const serviceStatus = activates ? serviceStatuses.get(activates) ?? null : null;
    const nextRun = usEpochToIso(t.next);
    entries.push({
      id: `systemd-user:${t.unit}`,
      source: 'systemd-user',
      name: String(t.unit),
      expr: 'timer',
      enabled: nextRun !== null,
      nextRun,
      lastRun: usEpochToIso(t.last),
      lastStatus: systemdLastStatus(serviceStatus),
      detail: systemdDetail(activates, serviceStatus),
      muteable: false,
    });
  }
}

async function checkIdleWatcherBug(flags: Flag[]): Promise<void> {
  // known machine bug: script lost its exec bit, so the */15 cron fails
  // with Permission denied — only flag while the file exists and is still 0o6xx
  try {
    const st = await stat(WATCHER_SCRIPT);
    if ((st.mode & 0o111) === 0) {
      flags.push({
        id: 'schedule:idle-watcher-not-executable',
        severity: 'warn',
        title: 'idle-proactive-watcher.py is not executable',
        detail: `cron '*/15 * * * *' has been failing with Permission denied for weeks; fix: chmod +x ${WATCHER_SCRIPT}`,
        source: 'schedule',
        raisedAt: pinnedRaisedAt('schedule:idle-watcher-not-executable'),
      });
    }
  } catch {
    // script missing — nothing to flag
  }
}

const collector: Collector = {
  name: 'schedule',
  intervalMs: config.poll.scheduleMs,

  async run(): Promise<void> {
    const entries: ScheduleEntry[] = [];
    const flags: Flag[] = [];
    try {
      const cron = await shTry('crontab', ['-l']);
      if (cron !== null) collectCrontab(cron, entries, flags);
      await collectHermes(entries);
      await collectRevuto(entries);
      await collectSystemdUser(entries);
      await checkIdleWatcherBug(flags);
      store.setSection('schedule', { updatedAt: iso(), entries, error: null });
    } catch (err) {
      store.setSection('schedule', {
        updatedAt: iso(),
        entries,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    // prune pins for flags that cleared so a re-raise gets a fresh timestamp
    for (const id of raisedAtPin.keys()) {
      if (!flags.some((f) => f.id === id)) raisedAtPin.delete(id);
    }
    store.setFlags('schedule', flags);
  },
};

export default collector;

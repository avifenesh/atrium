import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.js';
import { store } from '../state.js';
import { iso } from '../util.js';
import type { Collector } from './registry.js';
import type { Flag } from '../../../shared/types.js';

// flags only — no snapshot section; freshness is the whole signal.
// scripts/install-backup.sh owns repo creation and the daily 03:30 timer.

const REPO = config.paths.resticRepo;
const PASS_FILE = config.paths.resticPasswordFile;

// daily timer + 15m jitter should keep age well under 26h; 72h = three missed days
const WARN_MS = 26 * 3_600_000;
const CRIT_MS = 72 * 3_600_000;

// keep first-raise time stable per flag id so the UI doesn't show "just raised" forever
const raisedAt = new Map<string, string>();

function flag(id: string, severity: Flag['severity'], title: string, detail: string): Flag {
  const at = raisedAt.get(id) ?? iso();
  raisedAt.set(id, at);
  return { id, severity, title, detail, source: 'backup', raisedAt: at };
}

function unconfigured(detail: string): Flag {
  return flag('backup:unconfigured', 'info', 'backups not configured', detail);
}

// password travels via RESTIC_PASSWORD_FILE, never argv — argv is ps-visible
function resticSnapshots(): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'restic',
      ['-r', REPO, 'snapshots', '--json', '--latest', '1', '--no-lock'],
      { timeout: 30_000, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, RESTIC_PASSWORD_FILE: PASS_FILE } },
      (err, stdout) => (err ? reject(err) : resolve(String(stdout))),
    );
  });
}

async function run(): Promise<void> {
  const flags: Flag[] = [];
  const hasPass = existsSync(PASS_FILE);
  const hasRepo = existsSync(join(REPO, 'config'));
  if (!hasPass && hasRepo) {
    // orphaned repo: snapshots present but the key is gone — re-running the installer would
    // mint a fresh password and dead-end; the only safe move is restoring the old one.
    flags.push(
      flag(
        'backup:orphaned',
        'crit',
        'backup password file missing',
        'restic repo exists but ~/.config/restic/password is gone — existing snapshots are unreadable; do NOT re-run install-backup.sh, restore the password file from a copy',
      ),
    );
  } else if (!hasRepo) {
    flags.push(
      hasPass
        ? unconfigured('restic repo not initialized — run scripts/install-backup.sh')
        : unconfigured('no restic repo — run scripts/install-backup.sh'),
    );
  } else {
    try {
      const list = JSON.parse(await resticSnapshots());
      // --latest 1 still returns one entry per host/path group — take the newest
      const times = (Array.isArray(list) ? list : [])
        .map((s: any) => Date.parse(s?.time ?? ''))
        .filter((t: number) => Number.isFinite(t));
      if (times.length === 0) {
        flags.push(flag('backup:none', 'warn', 'no backup snapshots yet', 'repo initialized but holds zero snapshots — first run pending'));
      } else {
        const ageMs = Date.now() - Math.max(...times);
        const ageH = Math.round(ageMs / 3_600_000);
        // one id for the warn/crit pair — notify escalation depends on a stable id
        if (ageMs > CRIT_MS) {
          flags.push(flag('backup:overdue', 'crit', 'backups overdue', `last snapshot ${ageH}h ago (limit 72h)`));
        } else if (ageMs > WARN_MS) {
          flags.push(flag('backup:overdue', 'warn', 'backups overdue', `last snapshot ${ageH}h ago (limit 26h)`));
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('ENOENT')) {
        // install-backup.sh exits early when restic is missing, so point at apt first
        flags.push(unconfigured('restic not installed — apt install restic, then run scripts/install-backup.sh'));
      } else {
        // repo present but unreadable: freshness is unverifiable, which is itself a warn.
        // distinct id from backup:overdue — muting one anomaly must not silence the other.
        flags.push(flag('backup:error', 'warn', 'backup freshness unknown', `restic snapshots failed: ${msg.slice(0, 200)}`));
      }
    }
  }
  for (const id of raisedAt.keys()) {
    if (!flags.some((f) => f.id === id)) raisedAt.delete(id);
  }
  store.setFlags('backup', flags);
}

const collector: Collector = { name: 'backup', intervalMs: config.poll.backupMs, run };
export default collector;

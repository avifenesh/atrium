import { execFile } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';

/** Run a command (argv form, no shell). Resolves stdout; rejects on non-zero exit. */
export function sh(
  cmd: string,
  args: string[],
  opts: { timeoutMs?: number; input?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(cmd, args, { timeout: opts.timeoutMs ?? 15_000, maxBuffer: 16 * 1024 * 1024, env: opts.env }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${cmd} ${args.join(' ')}: ${err.message}${stderr ? ` — ${String(stderr).slice(0, 400)}` : ''}`));
      else resolve(String(stdout));
    });
    if (opts.input !== undefined && child.stdin) {
      child.stdin.write(opts.input);
      child.stdin.end();
    }
  });
}

/** sh that swallows failure and returns null instead. */
export async function shTry(cmd: string, args: string[], opts: { timeoutMs?: number } = {}): Promise<string | null> {
  try {
    return await sh(cmd, args, opts);
  } catch {
    return null;
  }
}

export function userSystemdEnv(): NodeJS.ProcessEnv {
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  const runtimeDir = process.env.XDG_RUNTIME_DIR ?? (uid === null ? undefined : `/run/user/${uid}`);
  return {
    ...process.env,
    ...(runtimeDir ? { XDG_RUNTIME_DIR: runtimeDir } : {}),
    DBUS_SESSION_BUS_ADDRESS:
      process.env.DBUS_SESSION_BUS_ADDRESS ?? (runtimeDir ? `unix:path=${runtimeDir}/bus` : undefined),
    SYSTEMD_PAGER: '',
  };
}

export async function readJson<T = any>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch {
    return null;
  }
}

export async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

export async function mtime(path: string): Promise<Date | null> {
  try {
    return (await stat(path)).mtime;
  } catch {
    return null;
  }
}

export function ago(d: Date | string | number): string {
  const t = typeof d === 'object' ? d.getTime() : new Date(d).getTime();
  const s = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function iso(d: Date | number | string = new Date()): string {
  return new Date(d).toISOString();
}

const SECRET_FLAG_RE = /(--?(?:api-key|apikey|token|password|passwd|secret)(?:=|\s+))(\S+)/gi;
const SECRET_ENV_RE = /\b([A-Za-z][A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASS|key|token|secret|password|pass)[A-Za-z0-9_]*=)(\S+)/g;
const SECRET_BEARER_RE = /\b(Bearer|Basic)\s+\S+/gi;

/** Strip secret-bearing CLI flags, KEY=value env args, and Authorization-header
 *  values before a command line enters the snapshot. */
export function redactSecrets(cmd: string): string {
  return cmd
    .replace(SECRET_FLAG_RE, '$1[redacted]')
    .replace(SECRET_ENV_RE, '$1[redacted]')
    .replace(SECRET_BEARER_RE, '$1 [redacted]');
}

/** Read last N lines of a file without loading the whole thing (tail for jsonl logs). */
export async function tailLines(path: string, n: number, maxBytes = 256 * 1024): Promise<string[]> {
  try {
    const st = await stat(path);
    const start = Math.max(0, st.size - maxBytes);
    const fh = await import('node:fs/promises').then((m) => m.open(path, 'r'));
    try {
      const buf = Buffer.alloc(st.size - start);
      await fh.read(buf, 0, buf.length, start);
      const lines = buf.toString('utf8').split('\n').filter(Boolean);
      return lines.slice(-n);
    } finally {
      await fh.close();
    }
  } catch {
    return [];
  }
}

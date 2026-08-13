import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { config } from './config.js';
import { shTry } from './util.js';
import type { PortScope, SystemState } from '../../shared/types.js';

const ATRIUM_PORT = config.port;
const LABEL_MAX = 80;

export const SCOPE_RANK: Record<PortScope, number> = {
  loopback: 0,
  wg: 1,
  tailnet: 2,
  lan: 3,
};

/** Classify a bind address from `ss` local column (brackets/zone stripped). */
export function classifyBind(addr: string): PortScope {
  const a = addr.replace(/^\[|\]$/g, '').split('%')[0].toLowerCase();
  if (a === '*' || a === '::' || a === '0.0.0.0' || a === '') return 'lan';
  if (a === '::1' || a === 'localhost' || a.startsWith('127.')) return 'loopback';
  if (a.startsWith('100.') || a.startsWith('fd7a:115c:')) return 'tailnet';
  if (a.startsWith('10.203.')) return 'wg';
  return 'lan';
}

export function widerScope(a: PortScope, b: PortScope): PortScope {
  return SCOPE_RANK[a] >= SCOPE_RANK[b] ? a : b;
}

export function scopeDetail(scope: PortScope): string {
  if (scope === 'lan') return 'listening on the LAN (0.0.0.0 / every local interface)';
  if (scope === 'tailnet') return 'listening on the tailnet only — not your LAN';
  if (scope === 'wg') return 'listening on the wg-trace interface';
  return 'listening on loopback';
}

export function knownProcLabel(proc: string): string | null {
  if (!proc) return null;
  const p = proc.toLowerCase();
  for (const [pat, label] of Object.entries(config.knownPortProcs ?? {})) {
    if (pat && p.includes(pat.toLowerCase())) return label;
  }
  return null;
}

export async function collectPorts(): Promise<SystemState['ports']> {
  const out = await shTry('ss', ['-tlnpH'], { timeoutMs: 5_000 });
  if (!out) return [];
  const byPort = new Map<number, { proc: string; pid: number | null; scope: PortScope }>();
  for (const line of out.split('\n')) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 4 || fields[0] !== 'LISTEN') continue;
    const local = fields[3];
    const sep = local.lastIndexOf(':');
    if (sep < 0) continue;
    const port = Number(local.slice(sep + 1));
    if (!Number.isInteger(port)) continue;
    const addr = local.slice(0, sep);
    const proc = line.match(/users:\(\("([^"]+)"/)?.[1] ?? '';
    const pidRaw = line.match(/pid=(\d+)/)?.[1];
    const pid = pidRaw ? Number(pidRaw) : null;
    const scope = classifyBind(addr);
    const prev = byPort.get(port);
    byPort.set(port, {
      proc: prev?.proc || proc,
      pid: prev?.pid ?? (pid && Number.isInteger(pid) ? pid : null),
      scope: prev ? widerScope(prev.scope, scope) : scope,
    });
  }
  const ports: SystemState['ports'] = [];
  for (const [port, info] of byPort) {
    const procLabel = knownProcLabel(info.proc);
    const known = port in config.knownPorts || procLabel !== null;
    if (!known && info.scope === 'loopback') continue;
    ports.push({
      port,
      proc: info.proc,
      known,
      label: config.knownPorts[port] ?? procLabel,
      scope: info.scope,
      pid: info.pid,
    });
  }
  ports.sort((a, b) => a.port - b.port);
  return ports;
}

export function parsePortBody(body: unknown): { port: number; label: string | null } {
  if (!body || typeof body !== 'object') throw new Error('request body must be an object');
  const raw = body as Record<string, unknown>;
  const port = Number(raw.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('port must be an integer 1–65535');
  if (raw.label === undefined || raw.label === null || raw.label === '') return { port, label: null };
  if (typeof raw.label !== 'string') throw new Error('label must be a string');
  const label = raw.label.replace(/[\u0000-\u001f]/g, '').trim().slice(0, LABEL_MAX);
  if (!label) throw new Error('label must be non-empty');
  return { port, label };
}

export async function persistKnownPort(port: number, label: string): Promise<void> {
  config.knownPorts[port] = label;
  const path = join(config.configDir, 'config.json');
  let user: Record<string, unknown> = {};
  try {
    user = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    if (!user || typeof user !== 'object' || Array.isArray(user)) user = {};
  } catch {
    user = {};
  }
  const known = user.knownPorts && typeof user.knownPorts === 'object' && !Array.isArray(user.knownPorts)
    ? { ...(user.knownPorts as Record<string, string>) }
    : {};
  known[String(port)] = label;
  user.knownPorts = known;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, `${JSON.stringify(user, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await rename(tmp, path);
}

export async function teachPort(body: unknown): Promise<{ port: number; label: string }> {
  const { port, label: given } = parsePortBody(body);
  const ports = await collectPorts();
  const hit = ports.find((p) => p.port === port);
  const label = given ?? hit?.label ?? hit?.proc ?? `port ${port}`;
  await persistKnownPort(port, label);
  return { port, label };
}

export async function stopPort(body: unknown): Promise<{ port: number; pid: number }> {
  const { port } = parsePortBody(body);
  if (port === ATRIUM_PORT) throw new Error('refusing to stop atrium itself');
  const ports = await collectPorts();
  const hit = ports.find((p) => p.port === port);
  if (!hit) throw new Error('no listener on that port');
  if (hit.known) throw new Error('refusing to stop a taught / known port');
  if (!hit.pid) throw new Error('no pid for that listener');
  if (hit.pid === process.pid || hit.pid === process.ppid) throw new Error('refusing to stop atrium itself');
  try {
    process.kill(hit.pid, 'SIGTERM');
  } catch (err) {
    const code = err && typeof err === 'object' && 'code' in err ? String((err as { code: unknown }).code) : '';
    if (code !== 'ESRCH') throw err;
  }
  return { port, pid: hit.pid };
}

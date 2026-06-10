import { cpus } from 'node:os';
import { config } from '../config.js';
import { store } from '../state.js';
import { readText, redactSecrets, shTry, iso } from '../util.js';
import { getMetricHistory, recordMetrics } from '../metric-history.js';
import type { Collector } from './registry.js';
import type { SystemState, Flag } from '../../../shared/types.js';

const KB = 1024;

function pct1(x: number): number {
  return Math.round(x * 10) / 10;
}

function num(s: string | undefined): number {
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

// ---- cpu pct from /proc/stat deltas ----

let prevStat: { busy: number; total: number } | null = null;

function readStatSample(text: string): { busy: number; total: number } | null {
  const line = text.split('\n').find((l) => l.startsWith('cpu '));
  if (!line) return null;
  // user nice system idle iowait irq softirq steal
  const f = line.trim().split(/\s+/).slice(1, 9).map(Number);
  if (f.length < 8 || f.some((n) => !Number.isFinite(n))) return null;
  const idle = f[3] + f[4];
  const total = f.reduce((a, b) => a + b, 0);
  return { busy: total - idle, total };
}

async function collectCpu(): Promise<SystemState['cpu']> {
  const cpu: SystemState['cpu'] = { load1: 0, load5: 0, load15: 0, cores: cpus().length, pct: 0 };
  const loadavg = await readText('/proc/loadavg');
  if (loadavg) {
    const [l1, l5, l15] = loadavg.trim().split(/\s+/);
    cpu.load1 = num(l1);
    cpu.load5 = num(l5);
    cpu.load15 = num(l15);
  }
  const stat = await readText('/proc/stat');
  const sample = stat ? readStatSample(stat) : null;
  if (sample) {
    if (prevStat) {
      const dTotal = sample.total - prevStat.total;
      const dBusy = sample.busy - prevStat.busy;
      if (dTotal > 0) cpu.pct = pct1(Math.max(0, Math.min(100, (dBusy / dTotal) * 100)));
    }
    prevStat = sample;
  }
  return cpu;
}

// ---- mem / swap from /proc/meminfo ----

async function collectMem(): Promise<{ mem: SystemState['mem']; swap: SystemState['swap'] }> {
  const mem: SystemState['mem'] = { totalB: 0, availableB: 0, usedPct: 0 };
  const swap: SystemState['swap'] = { totalB: 0, freeB: 0, usedPct: 0 };
  const text = await readText('/proc/meminfo');
  if (!text) return { mem, swap };
  const kv = new Map<string, number>();
  for (const line of text.split('\n')) {
    const m = line.match(/^(\w+):\s+(\d+)\s*kB/);
    if (m) kv.set(m[1], Number(m[2]) * KB);
  }
  mem.totalB = kv.get('MemTotal') ?? 0;
  mem.availableB = kv.get('MemAvailable') ?? 0;
  if (mem.totalB > 0) mem.usedPct = pct1(((mem.totalB - mem.availableB) / mem.totalB) * 100);
  swap.totalB = kv.get('SwapTotal') ?? 0;
  swap.freeB = kv.get('SwapFree') ?? 0;
  if (swap.totalB > 0) swap.usedPct = pct1(((swap.totalB - swap.freeB) / swap.totalB) * 100);
  return { mem, swap };
}

// ---- gpu via nvidia-smi ----

async function collectGpu(): Promise<SystemState['gpu']> {
  const out = await shTry('nvidia-smi', [
    '--query-gpu=name,memory.used,memory.total,utilization.gpu,temperature.gpu,power.draw',
    '--format=csv,noheader,nounits',
  ], { timeoutMs: 5_000 });
  if (!out) return null;
  const line = out.split('\n').find((l) => l.trim());
  if (!line) return null;
  const parts = line.split(',').map((s) => s.trim());
  if (parts.length < 6) return null;
  const procs: NonNullable<SystemState['gpu']>['procs'] = [];
  const procOut = await shTry('nvidia-smi', [
    '--query-compute-apps=pid,process_name,used_memory',
    '--format=csv,noheader,nounits',
  ], { timeoutMs: 5_000 });
  if (procOut) {
    for (const pl of procOut.split('\n')) {
      const p = pl.split(',').map((s) => s.trim());
      if (p.length < 3 || !p[0]) continue;
      // process_name is a path and may itself contain commas; pid/mem are the ends
      procs.push({ pid: num(p[0]), name: p.slice(1, -1).join(','), memMiB: num(p[p.length - 1]) });
    }
  }
  return {
    name: parts[0],
    memUsedMiB: num(parts[1]),
    memTotalMiB: num(parts[2]),
    utilPct: num(parts[3]),
    tempC: num(parts[4]),
    powerW: num(parts[5]),
    procs,
  };
}

// ---- disks via df, per-mount so a missing /data doesn't kill the rest ----

async function collectDisks(): Promise<SystemState['disks']> {
  const disks: SystemState['disks'] = [];
  for (const mount of ['/', '/data']) {
    const out = await shTry('df', ['-B1', '--output=target,size,used', mount], { timeoutMs: 5_000 });
    if (!out) continue;
    const data = out.split('\n')[1]?.trim();
    if (!data) continue;
    const [target, size, used] = data.split(/\s+/);
    const sizeB = num(size);
    const usedB = num(used);
    if (!target || sizeB <= 0) continue;
    disks.push({ mount: target, sizeB, usedB, usedPct: pct1((usedB / sizeB) * 100) });
  }
  return disks;
}

// ---- listening ports via ss ----

function isLoopback(addr: string): boolean {
  const a = addr.replace(/^\[|\]$/g, '').split('%')[0];
  return a === '::1' || a.startsWith('127.') || a === 'localhost';
}

async function collectPorts(): Promise<SystemState['ports']> {
  const out = await shTry('ss', ['-tlnpH'], { timeoutMs: 5_000 });
  if (!out) return [];
  const byPort = new Map<number, { proc: string; nonLoopback: boolean }>();
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
    const prev = byPort.get(port);
    byPort.set(port, {
      proc: prev?.proc || proc,
      nonLoopback: (prev?.nonLoopback ?? false) || !isLoopback(addr),
    });
  }
  const ports: SystemState['ports'] = [];
  for (const [port, info] of byPort) {
    const known = port in config.knownPorts;
    // surface known infra ports wherever they bind, plus anything exposed beyond loopback
    if (!known && !info.nonLoopback) continue;
    ports.push({ port, proc: info.proc, known, label: config.knownPorts[port] ?? null });
  }
  ports.sort((a, b) => a.port - b.port);
  return ports;
}

// ---- noteworthy processes via ps ----

const PROC_KEEP = /claude|eigen|codex|llama-server|hermes_cli|surreal|session-manager-plugin|train|uvicorn|granian|any-mission|itch/;
const PROC_DROP = /grep|atrium/;

const PROC_LABELS: [RegExp, string][] = [
  [/llama-server/, 'llama server'],
  [/hermes_cli/, 'hermes gateway'],
  [/session-manager-plugin/, 'aws ssm session'],
  [/any-mission/, 'any-mission'],
  [/eigen/, 'eigen agent'],
  [/claude/, 'claude code'],
  [/codex/, 'codex'],
  [/surreal/, 'surrealdb'],
  [/uvicorn/, 'uvicorn service'],
  [/granian/, 'granian service'],
  [/itch/, 'itch'],
  [/train/, 'training run'],
];

async function collectProcesses(): Promise<SystemState['processes']> {
  const out = await shTry('ps', ['-eo', 'pid,pcpu,pmem,args', '--no-headers', '--sort=-pcpu'], { timeoutMs: 5_000 });
  if (!out) return [];
  const procs: SystemState['processes'] = [];
  for (const line of out.split('\n')) {
    if (procs.length >= 20) break;
    const m = line.match(/^\s*(\d+)\s+([\d.]+)\s+([\d.]+)\s+(.+)$/);
    if (!m) continue;
    const cmd = m[4];
    if (!PROC_KEEP.test(cmd) || PROC_DROP.test(cmd)) continue;
    const label = PROC_LABELS.find(([re]) => re.test(cmd))?.[1] ?? null;
    // argv goes into the snapshot read by every local client — strip --api-key/KEY=value style secrets
    procs.push({ pid: Number(m[1]), cmd: redactSecrets(cmd).slice(0, 200), cpuPct: num(m[2]), memPct: num(m[3]), label });
  }
  return procs;
}

// ---- watched systemd user units ----

async function collectServices(): Promise<SystemState['services']> {
  const results = await Promise.all(
    config.watchedUnits.map(async (unit) => {
      const out = await shTry('systemctl', ['--user', 'show', unit, '-p', 'ActiveState,SubState,Description'], { timeoutMs: 5_000 });
      if (!out) return null;
      const kv = new Map<string, string>();
      for (const line of out.split('\n')) {
        const eq = line.indexOf('=');
        if (eq > 0) kv.set(line.slice(0, eq), line.slice(eq + 1));
      }
      return {
        unit,
        active: kv.get('ActiveState') ?? 'unknown',
        sub: kv.get('SubState') ?? 'unknown',
        description: kv.get('Description') ?? '',
      };
    }),
  );
  return results.filter((s): s is NonNullable<typeof s> => s !== null);
}

// systemctl is the only spawn-per-unit step; refresh it every 6th cycle, reuse otherwise
let cycle = 0;
let servicesCache: SystemState['services'] = [];
// cpu.pct is 0 on the first poll (no /proc/stat delta yet) — don't log that sample
let cpuCold = true;

// keep first-raise time stable per flag id so the UI doesn't show "just raised" forever
const raisedAt = new Map<string, string>();

function flag(id: string, severity: Flag['severity'], title: string, detail: string): Flag {
  const at = raisedAt.get(id) ?? iso();
  raisedAt.set(id, at);
  return { id, severity, title, detail, source: 'system', raisedAt: at };
}

async function run(): Promise<void> {
  const state: SystemState = {
    updatedAt: iso(),
    cpu: { load1: 0, load5: 0, load15: 0, cores: 0, pct: 0 },
    mem: { totalB: 0, availableB: 0, usedPct: 0 },
    swap: { totalB: 0, freeB: 0, usedPct: 0 },
    gpu: null,
    disks: [],
    ports: [],
    processes: [],
    services: [],
    history: getMetricHistory(),
    error: null,
  };

  try {
    const refreshServices = cycle % 6 === 0;
    cycle++;
    const [cpu, memSwap, gpu, disks, ports, processes, services] = await Promise.all([
      collectCpu(),
      collectMem(),
      collectGpu(),
      collectDisks(),
      collectPorts(),
      collectProcesses(),
      refreshServices ? collectServices() : Promise.resolve(servicesCache),
    ]);
    state.cpu = cpu;
    state.mem = memSwap.mem;
    state.swap = memSwap.swap;
    state.gpu = gpu;
    state.disks = disks;
    state.ports = ports;
    state.processes = processes;
    servicesCache = services;
    state.services = services;
  } catch (err) {
    state.error = err instanceof Error ? err.message : String(err);
  }

  // record into the rolling history only on a clean, warm poll. skip on error
  // (zeroed metrics) and on the very first poll after boot (cpu.pct is always 0
  // until /proc/stat has two samples to diff) — both would punch false 0% dips.
  const cold = cpuCold;
  cpuCold = false;
  state.history = state.error || cold ? getMetricHistory() : recordMetrics(state);

  const flags: Flag[] = [];
  if (state.swap.usedPct > 90) {
    flags.push(flag('system:swap', 'crit', 'swap nearly full', `swap at ${state.swap.usedPct}% used`));
  } else if (state.swap.usedPct > 75) {
    flags.push(flag('system:swap', 'warn', 'swap pressure', `swap at ${state.swap.usedPct}% used`));
  }
  for (const p of state.ports) {
    if (!p.known) {
      flags.push(flag(`system:port:${p.port}`, 'warn', `unknown listening port ${p.port}`, `process "${p.proc || '?'}" is listening on port ${p.port} (non-loopback)`));
    }
  }
  for (const s of state.services) {
    if (s.active !== 'active') {
      flags.push(flag(`system:unit:${s.unit}`, 'warn', `${s.unit} not active`, `${s.unit} is ${s.active} (${s.sub})`));
    }
  }
  for (const d of state.disks) {
    if (d.usedPct > 85) {
      flags.push(flag(`system:disk:${d.mount}`, 'warn', `disk ${d.mount} filling up`, `${d.mount} at ${d.usedPct}% used`));
    }
  }
  for (const id of raisedAt.keys()) {
    if (!flags.some((f) => f.id === id)) raisedAt.delete(id);
  }

  store.setSection('system', state);
  store.setFlags('system', flags);
}

const collector: Collector = { name: 'system', intervalMs: config.poll.systemMs, run };
export default collector;

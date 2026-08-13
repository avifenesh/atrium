import { randomUUID } from 'node:crypto';
import { access, mkdir, realpath, rename, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import type {
  ReentryAgentStatus,
  ReentryBriefing,
  ReentryCapsule,
  ReentryContext,
  ReentryEnergy,
  ReentryGitState,
  ReentryResumeTarget,
} from '../../shared/types.js';
import { config } from './config.js';
import { store } from './state.js';
import { iso, readJson, sh, shTry, userSystemdEnv } from './util.js';

const STATE_FILE = resolve(config.configDir, 'reentry.json');
export const WORKER_STATE_FILE = resolve(config.configDir, 'reentry-worker.json');
export const FORCE_SCAN_FILE = resolve(config.reentry.runtimeDir, 'force-scan');
const GIT_TIMEOUT_MS = 5_000;
const MAX_TEXT = 800;

interface PersistedState {
  version: 1;
  contexts: ReentryContext[];
  briefing: ReentryBriefing | null;
}

export interface ReentryEvidence {
  version: 1;
  capturedAt: string;
  sources: Record<'github' | 'repos' | 'agents', {
    enabled: boolean;
    updatedAt: string | null;
    error: string | null;
  }>;
  constraints: {
    factsOnly: true;
    doNotInferAbandonment: true;
    prioritizePeopleWaiting: true;
  };
  contexts: Omit<ReentryContext, 'scanStatus' | 'scanError'>[];
  repos: {
    name: string;
    path: string;
    branch: string | null;
    dirty: number;
    ahead: number | null;
    behind: number | null;
    lastCommitAt: string | null;
  }[];
  agentSessions: {
    provider: string;
    id: string;
    title: string | null;
    dir: string | null;
    model: string | null;
    status: string | null;
    updatedAt: string;
    live: boolean;
  }[];
  peopleWaiting: {
    id: string;
    repo: string;
    title: string;
    kind: string;
    author: string;
    lane: string;
    updatedAt: string;
  }[];
  actNow: {
    id: string;
    repo: string;
    title: string;
    kind: string;
    updatedAt: string;
  }[];
}

let contexts: ReentryContext[] = [];
let briefing: ReentryBriefing | null = null;
let workerStatus: ReentryAgentStatus = emptyAgentStatus();
let lastError: string | null = null;
let writeChain: Promise<void> = Promise.resolve();

function emptyAgentStatus(): ReentryAgentStatus {
  return {
    status: 'idle',
    model: config.reentry.models[0] ?? '',
    lastCheckedAt: null,
    lastPreparedAt: null,
    lastError: null,
    nextRunAt: null,
  };
}

function cleanText(value: unknown, max = MAX_TEXT): string {
  return typeof value === 'string' ? value.replace(/\0/g, '').trim().slice(0, max) : '';
}

function cleanList(value: unknown, maxItems = 12, maxText = 300): string[] {
  return Array.isArray(value)
    ? value.map((item) => cleanText(item, maxText)).filter(Boolean).slice(0, maxItems)
    : [];
}

function isEnergy(value: unknown): value is ReentryEnergy {
  return value === 'light' || value === 'medium' || value === 'deep';
}

function normalizeCapsule(value: unknown): ReentryCapsule | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const goal = cleanText(raw.goal);
  const nextAction = cleanText(raw.nextAction);
  if (!goal || !nextAction) return null;
  return {
    goal,
    verifiedFacts: cleanList(raw.verifiedFacts).filter((fact) => !/scan\s*(?:status|error)/i.test(fact)),
    rejectedPaths: cleanList(raw.rejectedPaths, 8),
    blocker: cleanText(raw.blocker) || null,
    nextAction,
  };
}

function normalizeContext(value: unknown): ReentryContext | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Partial<ReentryContext>;
  const id = cleanText(raw.id, 80);
  const path = cleanText(raw.path, 4096);
  if (!id || !isAbsolute(path)) return null;
  const state = raw.state === 'active' || raw.state === 'done' ? raw.state : 'parked';
  const createdAt = typeof raw.createdAt === 'string' && !Number.isNaN(Date.parse(raw.createdAt)) ? raw.createdAt : iso();
  const parkedAt = typeof raw.parkedAt === 'string' && !Number.isNaN(Date.parse(raw.parkedAt)) ? raw.parkedAt : createdAt;
  const updatedAt = typeof raw.updatedAt === 'string' && !Number.isNaN(Date.parse(raw.updatedAt)) ? raw.updatedAt : parkedAt;
  const git = raw.git && typeof raw.git === 'object'
    ? {
        branch: typeof raw.git.branch === 'string' ? cleanText(raw.git.branch, 200) : null,
        dirty: Number.isFinite(raw.git.dirty) ? Math.max(0, Number(raw.git.dirty)) : 0,
        ahead: Number.isFinite(raw.git.ahead) ? Math.max(0, Number(raw.git.ahead)) : null,
        behind: Number.isFinite(raw.git.behind) ? Math.max(0, Number(raw.git.behind)) : null,
        lastCommitAt: typeof raw.git.lastCommitAt === 'string' ? raw.git.lastCommitAt : null,
        summary: cleanList(raw.git.summary, 28, 400),
      }
    : null;
  const targetRaw = raw.resumeTarget && typeof raw.resumeTarget === 'object' ? raw.resumeTarget : null;
  const targetKind = targetRaw?.kind === 'tmux' || targetRaw?.kind === 'codex' || targetRaw?.kind === 'claude'
    ? targetRaw.kind
    : 'shell';
  const targetId = typeof targetRaw?.id === 'string' && /^[A-Za-z0-9_.-]{1,200}$/.test(targetRaw.id)
    ? targetRaw.id
    : null;
  return {
    id,
    title: cleanText(raw.title) || basename(path),
    path,
    project: cleanText(raw.project, 200) || basename(path),
    note: cleanText(raw.note, 2_000),
    energy: isEnergy(raw.energy) ? raw.energy : 'medium',
    state,
    createdAt,
    parkedAt,
    updatedAt,
    resumedAt: typeof raw.resumedAt === 'string' && !Number.isNaN(Date.parse(raw.resumedAt)) ? raw.resumedAt : null,
    git,
    resumeTarget: {
      kind: targetId ? targetKind : 'shell',
      id: targetId,
      capturedAt: typeof targetRaw?.capturedAt === 'string' ? targetRaw.capturedAt : parkedAt,
    },
    capsule: normalizeCapsule(raw.capsule),
    scanStatus: raw.scanStatus === 'ready' || raw.scanStatus === 'error' ? raw.scanStatus : 'queued',
    scanError: cleanText(raw.scanError) || null,
  };
}

function normalizeBriefing(value: unknown): ReentryBriefing | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const headline = cleanText(raw.headline, 240);
  const summary = cleanText(raw.summary, 1_500);
  if (!headline || !summary) return null;
  const focus = Array.isArray(raw.focus)
    ? raw.focus.flatMap((item) => {
        if (!item || typeof item !== 'object') return [];
        const row = item as Record<string, unknown>;
        const title = cleanText(row.title, 240);
        const whyNow = cleanText(row.whyNow, 500);
        const nextAction = cleanText(row.nextAction, 500);
        if (!title || !whyNow || !nextAction) return [];
        const id = cleanText(row.contextId, 80);
        const path = cleanText(row.path, 4096);
        return [{ contextId: id || null, path: isAbsolute(path) ? path : null, title, whyNow, nextAction }];
      }).slice(0, 6)
    : [];
  const looseEnds = Array.isArray(raw.looseEnds)
    ? raw.looseEnds.flatMap((item) => {
        if (!item || typeof item !== 'object') return [];
        const row = item as Record<string, unknown>;
        const label = cleanText(row.label, 240);
        const detail = cleanText(row.detail, 500);
        if (!label || !detail) return [];
        const path = cleanText(row.path, 4096);
        return [{ label, detail, path: isAbsolute(path) ? path : null }];
      }).slice(0, 8)
    : [];
  return {
    generatedAt:
      typeof raw.generatedAt === 'string' && !Number.isNaN(Date.parse(raw.generatedAt)) ? raw.generatedAt : iso(),
    model: cleanText(raw.model, 200),
    headline,
    summary,
    focus,
    looseEnds,
  };
}

async function atomicWrite(path: string, data: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, data, { encoding: 'utf8', mode: 0o600 });
  await rename(tmp, path);
}

function persist(): Promise<void> {
  const payload: PersistedState = { version: 1, contexts, briefing };
  // A transient failed write must not poison every future mutation in the chain.
  writeChain = writeChain.catch(() => undefined).then(() => atomicWrite(STATE_FILE, `${JSON.stringify(payload, null, 2)}\n`));
  return writeChain;
}

function publish(): void {
  store.setSection('reentry', {
    updatedAt: iso(),
    contexts: [...contexts].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    briefing,
    agent: workerStatus,
    error: lastError,
  });
}

async function requireProjectPath(value: unknown): Promise<string> {
  const requested = cleanText(value, 4096);
  if (!requested || !isAbsolute(requested)) throw new Error('path must be an absolute project directory');
  const [root, path] = await Promise.all([realpath(config.paths.projectsDir), realpath(requested)]);
  const rel = relative(root, path);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`path must be inside ${root}`);
  }
  if (!(await stat(path)).isDirectory()) throw new Error('path must be a directory');
  return path;
}

function git(path: string, args: string[]): Promise<string | null> {
  return shTry('git', ['-C', path, ...args], { timeoutMs: GIT_TIMEOUT_MS });
}

async function captureGit(path: string): Promise<ReentryGitState | null> {
  const root = await git(path, ['rev-parse', '--show-toplevel']);
  if (!root) return null;
  const [status, head, counts, last, diff] = await Promise.all([
    git(path, ['status', '--porcelain']),
    git(path, ['rev-parse', '--abbrev-ref', 'HEAD']),
    git(path, ['rev-list', '--left-right', '--count', '@{upstream}...HEAD']),
    git(path, ['log', '-1', '--format=%cI']),
    git(path, ['diff', '--stat', 'HEAD']),
  ]);
  if (status === null) return null;
  const statusLines = status.split('\n').map((line) => line.trimEnd()).filter(Boolean);
  const diffLines = (diff ?? '').split('\n').map((line) => line.trim()).filter(Boolean);
  const countMatch = counts?.trim().match(/^(\d+)\s+(\d+)$/) ?? null;
  const branch = head?.trim() && head.trim() !== 'HEAD' ? head.trim() : null;
  return {
    branch,
    dirty: statusLines.length,
    ahead: countMatch ? Number(countMatch[2]) : null,
    behind: countMatch ? Number(countMatch[1]) : null,
    lastCommitAt: last?.trim() || null,
    summary: [...statusLines.slice(0, 20), ...diffLines.slice(-8)].slice(0, 28),
  };
}

async function matchingTmux(path: string): Promise<string | null> {
  const out = await shTry('tmux', ['list-panes', '-a', '-F', '#{session_name}\t#{pane_current_path}'], { timeoutMs: 3_000 });
  if (!out) return null;
  for (const line of out.split('\n')) {
    const [session, panePath] = line.split('\t');
    if (session && panePath === path) return session;
  }
  return null;
}

function matchingAgent(path: string): { kind: 'codex' | 'claude'; id: string } | null {
  const candidates = store.get().agents.agents
    .filter((agent) => agent.id === 'codex' || agent.id === 'claude')
    .flatMap((agent) => agent.sessions.map((session) => ({ kind: agent.id, session })))
    .filter(({ session }) => session.dir === path && /^[A-Za-z0-9_.-]{1,200}$/.test(session.id))
    .sort((a, b) => Number(b.session.live) - Number(a.session.live) || b.session.updatedAt.localeCompare(a.session.updatedAt));
  const match = candidates[0];
  return match ? { kind: match.kind as 'codex' | 'claude', id: match.session.id } : null;
}

async function captureResumeTarget(path: string): Promise<ReentryResumeTarget> {
  const capturedAt = iso();
  const tmux = await matchingTmux(path);
  if (tmux && /^[A-Za-z0-9_.-]{1,200}$/.test(tmux)) return { kind: 'tmux', id: tmux, capturedAt };
  const agent = matchingAgent(path);
  return agent ? { ...agent, capturedAt } : { kind: 'shell', id: null, capturedAt };
}

async function tmuxExists(session: string): Promise<boolean> {
  return (await shTry('tmux', ['has-session', '-t', session], { timeoutMs: 3_000 })) !== null;
}

async function terminalBinary(): Promise<string | null> {
  for (const candidate of ['/usr/bin/ptyxis', '/usr/bin/kgx', '/usr/bin/gnome-terminal']) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      /* try the next installed terminal */
    }
  }
  return null;
}

function launchDetached(command: string, args: string[]): void {
  const child = spawn(command, args, { detached: true, stdio: 'ignore', env: process.env });
  child.on('error', (err) => console.error('[reentry] terminal launch failed:', err.message));
  child.unref();
}

async function launchContext(context: ReentryContext): Promise<{ launched: boolean; via: string }> {
  const terminal = await terminalBinary();
  if (!terminal) return { launched: false, via: 'no supported terminal found' };

  const captured = context.resumeTarget;
  const capturedTmux = captured.kind === 'tmux' && captured.id && (await tmuxExists(captured.id)) ? captured.id : null;
  const tmuxSession = capturedTmux ?? (await matchingTmux(context.path));
  let command: string | null = null;
  let commandArgs: string[] = [];
  let via = 'shell';
  if (tmuxSession) {
    command = 'tmux';
    commandArgs = ['attach-session', '-t', tmuxSession];
    via = `tmux:${tmuxSession}`;
  } else {
    const current = matchingAgent(context.path);
    const target = captured.id && (captured.kind === 'codex' || captured.kind === 'claude')
      ? { kind: captured.kind, id: captured.id }
      : current;
    if (target) {
      command = target.kind;
      commandArgs = target.kind === 'codex' ? ['resume', target.id] : ['--resume', target.id];
      via = `${target.kind}:${target.id}`;
    }
  }

  const name = basename(terminal);
  if (name === 'ptyxis') {
    const args = ['--new-window', '--working-directory', context.path, '--title', context.title];
    if (command) args.push('--', command, ...commandArgs);
    launchDetached(terminal, args);
  } else if (name === 'kgx') {
    const args = ['--working-directory', context.path];
    if (command) args.push('--', command, ...commandArgs);
    launchDetached(terminal, args);
  } else {
    const args = ['--working-directory', context.path];
    if (command) args.push('--', command, ...commandArgs);
    launchDetached(terminal, args);
  }
  return { launched: true, via };
}

function contextProject(path: string): string {
  const rel = relative(config.paths.projectsDir, path);
  return rel.split('/')[0] || basename(path);
}

export const reentry = {
  async load(): Promise<void> {
    try {
      const saved = await readJson<PersistedState>(STATE_FILE);
      contexts = Array.isArray(saved?.contexts)
        ? saved.contexts.map(normalizeContext).filter((item): item is ReentryContext => item !== null)
        : [];
      briefing = normalizeBriefing(saved?.briefing);
      lastError = null;
    } catch (err) {
      contexts = [];
      briefing = null;
      lastError = err instanceof Error ? err.message : String(err);
    }
    publish();
  },

  async park(input: unknown): Promise<ReentryContext> {
    if (!input || typeof input !== 'object') throw new Error('request body must be an object');
    const raw = input as Record<string, unknown>;
    const path = await requireProjectPath(raw.path);
    const now = iso();
    const [git, resumeTarget] = await Promise.all([captureGit(path), captureResumeTarget(path)]);
    const energy = isEnergy(raw.energy) ? raw.energy : 'medium';
    const existing = contexts.find((item) => item.path === path && item.state !== 'done');
    const next: ReentryContext = {
      id: existing?.id ?? randomUUID(),
      title: cleanText(raw.title) || existing?.title || basename(path),
      path,
      project: contextProject(path),
      note: cleanText(raw.note, 2_000) || existing?.note || '',
      energy,
      state: 'parked',
      createdAt: existing?.createdAt ?? now,
      parkedAt: now,
      updatedAt: now,
      resumedAt: existing?.resumedAt ?? null,
      git,
      resumeTarget,
      capsule: existing?.capsule ?? null,
      scanStatus: 'queued',
      scanError: null,
    };
    contexts = [next, ...contexts.filter((item) => item.id !== next.id)];
    await persist();
    publish();
    return next;
  },

  async archive(idValue: unknown): Promise<ReentryContext> {
    const id = cleanText(idValue, 80);
    const context = contexts.find((item) => item.id === id);
    if (!context) throw new Error('unknown re-entry context');
    const next: ReentryContext = { ...context, state: 'done', updatedAt: iso() };
    contexts = contexts.map((item) => (item.id === id ? next : item));
    await persist();
    publish();
    return next;
  },

  async resume(idValue: unknown): Promise<{ context: ReentryContext; launched: boolean; via: string }> {
    const id = cleanText(idValue, 80);
    const context = contexts.find((item) => item.id === id && item.state !== 'done');
    if (!context) throw new Error('unknown active re-entry context');
    const now = iso();
    const next: ReentryContext = { ...context, state: 'active', resumedAt: now, updatedAt: now };
    contexts = contexts.map((item) => (item.id === id ? next : item));
    await persist();
    publish();
    return { context: next, ...(await launchContext(next)) };
  },

  async requestScan(): Promise<{ ok: boolean; scheduled: boolean; error?: string }> {
    contexts = contexts.map((item) =>
      item.state === 'done' ? item : { ...item, scanStatus: 'queued', scanError: null, updatedAt: iso() },
    );
    await persist();
    await atomicWrite(FORCE_SCAN_FILE, `${iso()}\n`);
    publish();
    try {
      await sh('systemctl', ['--user', 'start', '--no-block', 'atrium-reentry-agent.service'], {
        timeoutMs: 10_000,
        env: userSystemdEnv(),
      });
      return { ok: true, scheduled: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, scheduled: false, error: message.slice(0, 500) };
    }
  },

  buildEvidence(): ReentryEvidence {
    const snapshot = store.get();
    const liveContexts = contexts
      .filter((item) => item.state !== 'done')
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, config.reentry.maxContexts);
    const agentSessions = snapshot.agents.agents
      .flatMap((agent) => agent.sessions.map((session) => ({ provider: agent.id, ...session })))
      .filter((session) => session.dir?.startsWith(`${config.paths.projectsDir}/`))
      .sort((a, b) => Number(b.live) - Number(a.live) || b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, 60);
    return {
      version: 1,
      capturedAt: iso(),
      sources: {
        github: {
          enabled: snapshot.collectors.includes('github'),
          updatedAt: snapshot.github.updatedAt,
          error: snapshot.github.error,
        },
        repos: {
          enabled: snapshot.collectors.includes('repos'),
          updatedAt: snapshot.repos.updatedAt,
          error: snapshot.repos.error,
        },
        agents: {
          enabled: snapshot.collectors.includes('agents'),
          updatedAt: snapshot.agents.updatedAt,
          error: null,
        },
      },
      constraints: { factsOnly: true, doNotInferAbandonment: true, prioritizePeopleWaiting: true },
      contexts: liveContexts.map(({ scanStatus: _scanStatus, scanError: _scanError, ...context }) => ({
        ...context,
        capsule: context.capsule
          ? {
              ...context.capsule,
              verifiedFacts: context.capsule.verifiedFacts.filter((fact) => !/scan\s*(?:status|error)/i.test(fact)),
            }
          : null,
      })),
      repos: snapshot.repos.repos.slice(0, 80),
      agentSessions,
      peopleWaiting: snapshot.github.orgQueue.slice(0, 30).map((item) => ({
        id: item.id,
        repo: item.repo,
        title: item.title,
        kind: item.kind,
        author: item.author,
        lane: item.lane,
        updatedAt: item.updatedAt,
      })),
      actNow: snapshot.github.actNow.slice(0, 30).map((item) => ({
        id: item.id,
        repo: item.repo,
        title: item.title,
        kind: item.kind,
        updatedAt: item.updatedAt,
      })),
    };
  },

  async applyAgentResult(input: unknown): Promise<void> {
    if (!input || typeof input !== 'object') throw new Error('agent result must be an object');
    const raw = input as Record<string, unknown>;
    const model = cleanText(raw.model, 200);
    const prepared = normalizeBriefing({ ...raw, model, generatedAt: raw.generatedAt ?? iso() });
    if (!prepared) throw new Error('agent result is missing a valid headline or summary');
    const allowedContextIds = new Set(contexts.filter((item) => item.state !== 'done').map((item) => item.id));
    const allowedPaths = new Set([
      ...contexts.filter((item) => item.state !== 'done').map((item) => item.path),
      ...store.get().repos.repos.map((repo) => repo.path),
    ]);
    prepared.focus = prepared.focus
      .map((item) => ({
        ...item,
        contextId: item.contextId && allowedContextIds.has(item.contextId) ? item.contextId : null,
        path: item.path && allowedPaths.has(item.path) ? item.path : null,
      }))
      .filter((item) => item.contextId !== null || item.path !== null || item.title.length > 0);
    prepared.looseEnds = prepared.looseEnds.map((item) => ({
      ...item,
      path: item.path && allowedPaths.has(item.path) ? item.path : null,
    }));
    const updates = new Map<string, ReentryCapsule>();
    if (Array.isArray(raw.contexts)) {
      for (const value of raw.contexts.slice(0, config.reentry.maxContexts)) {
        if (!value || typeof value !== 'object') continue;
        const row = value as Record<string, unknown>;
        const id = cleanText(row.id, 80);
        const capsule = normalizeCapsule(row.capsule);
        if (id && capsule && contexts.some((item) => item.id === id && item.state !== 'done')) updates.set(id, capsule);
      }
    }
    const now = iso();
    contexts = contexts.map((item) => {
      if (item.state === 'done') return item;
      const capsule = updates.get(item.id) ?? item.capsule;
      return {
        ...item,
        capsule,
        scanStatus: capsule ? 'ready' : 'error',
        scanError: capsule ? null : 'The prepared status did not include this context.',
        updatedAt: updates.has(item.id) ? now : item.updatedAt,
      };
    });
    briefing = prepared;
    workerStatus = {
      ...workerStatus,
      status: 'idle',
      model,
      lastCheckedAt: now,
      lastPreparedAt: prepared.generatedAt,
      lastError: null,
    };
    lastError = null;
    await persist();
    publish();
  },

  async applyAgentError(value: unknown): Promise<void> {
    const raw = value && typeof value === 'object' ? (value as Record<string, unknown>).error : value;
    const error = cleanText(raw) || 'Re-entry status preparation failed';
    contexts = contexts.map((item) =>
      item.state === 'done' || item.scanStatus !== 'queued'
        ? item
        : { ...item, scanStatus: 'error', scanError: error },
    );
    workerStatus = { ...workerStatus, status: 'error', lastCheckedAt: iso(), lastError: error };
    lastError = error;
    await persist();
    publish();
  },

  async refreshWorkerStatus(nextRunAt: string | null = null, workerActive: boolean | null = null): Promise<void> {
    const raw = await readJson<Partial<ReentryAgentStatus>>(WORKER_STATE_FILE);
    if (raw) {
      workerStatus = {
        status: raw.status === 'running' || raw.status === 'error' || raw.status === 'disabled' ? raw.status : 'idle',
        model: cleanText(raw.model, 200) || config.reentry.models[0] || '',
        lastCheckedAt: typeof raw.lastCheckedAt === 'string' ? raw.lastCheckedAt : null,
        lastPreparedAt: typeof raw.lastPreparedAt === 'string' ? raw.lastPreparedAt : null,
        lastError: cleanText(raw.lastError) || null,
        nextRunAt,
      };
      if (workerStatus.status === 'running' && workerActive === false) {
        workerStatus = {
          ...workerStatus,
          status: 'error',
          lastError: 'Background worker stopped before preparing a status.',
        };
      }
    } else {
      workerStatus = { ...emptyAgentStatus(), nextRunAt };
    }
    publish();
  },
};

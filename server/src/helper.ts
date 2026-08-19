import { randomUUID } from 'node:crypto';
import { access, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type {
  HelperAgentStatus,
  HelperEvidenceRef,
  HelperExecutor,
  HelperFeedback,
  HelperOffer,
  HelperOfferSize,
  HelperPreference,
  HelperSettings,
  HelperSkill,
  HelperSourceStatus,
} from '../../shared/types.js';
import { config } from './config.js';
import { collectWeeklyAgentSessions, type HelperSessionEvidence } from './helper-sessions.js';
import {
  hasIndependentOfferEvidence,
  normalizeHelperInterval,
  offerFingerprint,
  systemdInterval,
} from './helper-worker-lib.js';
import { store } from './state.js';
import { iso, readJson, sh, tailLines, userSystemdEnv, launchTmuxSession } from './util.js';

const STATE_FILE = resolve(config.configDir, 'helper.json');
export const HELPER_WORKER_STATE_FILE = resolve(config.configDir, 'helper-worker.json');
export const HELPER_FORCE_SCAN_FILE = resolve(config.helper.runtimeDir, 'force-scan');
export const HELPER_SCOUT_PROMPT_FILE = resolve(config.helper.runtimeDir, 'scout-system.md');
const MAX_TEXT = 1_200;

interface PersistedState {
  version: 1;
  offers: HelperOffer[];
  preferences: HelperPreference[];
  skills: HelperSkill[];
  feedback: HelperFeedback[];
  sources: HelperSourceStatus[];
  settings: HelperSettings;
  scanSummary: string | null;
  fingerprints: Record<string, string>;
}

interface HelperWorkerFile {
  status: HelperAgentStatus['status'];
  model: string;
  lastCheckedAt: string | null;
  lastOfferedAt: string | null;
  lastError: string | null;
  lastEvidenceHash: string | null;
}

export interface HelperEvidence {
  version: 1;
  capturedAt: string;
  constraints: {
    readOnlyScout: true;
    noOfferQuota: true;
    exactExecutorPromptRequired: true;
  };
  sources: HelperSourceStatus[];
  offerHistory: {
    key: string;
    title: string;
    status: HelperOffer['status'];
    feedback: string | null;
    path: string | null;
    evidenceIds: string[];
    updatedAt: string;
  }[];
  preferences: Pick<HelperPreference, 'id' | 'kind' | 'statement'>[];
  skills: Pick<HelperSkill, 'id' | 'name' | 'description' | 'instructions'>[];
  pendingFeedback: HelperFeedback[];
  repositories: {
    name: string;
    path: string;
    branch: string | null;
    dirty: number;
    ahead: number | null;
    behind: number | null;
    lastCommitAt: string | null;
  }[];
  github: {
    repositories: unknown[];
    actNow: unknown[];
    peopleWaiting: unknown[];
    pullRequests: unknown[];
    mentions: unknown[];
    notifications: unknown[];
  };
  gmail: {
    from: string;
    subject: string;
    date: string;
    snippet: string;
    unread: boolean;
  }[];
  linkedin: {
    mail: { from: string; subject: string; date: string; snippet: string }[];
    exports: { file: string; updatedAt: string; excerpt: string[] }[];
  };
  sessions: HelperSessionEvidence[];
  reentry: {
    id: string;
    title: string;
    path: string;
    state: string;
    note: string;
    goal: string | null;
    nextAction: string | null;
    blocker: string | null;
  }[];
  recentNotes: { path: string; title: string; modifiedAt: string }[];
}

let offers: HelperOffer[] = [];
let preferences: HelperPreference[] = [];
let skills: HelperSkill[] = [];
let feedback: HelperFeedback[] = [];
let settings: HelperSettings = {
  intervalMs: config.helper.defaultIntervalMs,
  defaultExecutor: 'claude',
};
let scanSummary: string | null = null;
let fingerprints: Record<string, string> = {};
let sources: HelperSourceStatus[] = [];
let workerStatus: HelperAgentStatus = emptyWorkerStatus();
let lastError: string | null = null;
let writeChain: Promise<void> = Promise.resolve();

function emptyWorkerStatus(): HelperAgentStatus {
  return {
    status: 'idle',
    model: config.helper.model,
    lastCheckedAt: null,
    lastOfferedAt: null,
    lastError: null,
    nextRunAt: null,
  };
}

function cleanText(value: unknown, max = MAX_TEXT): string {
  return typeof value === 'string' ? value.replace(/\0/g, '').replace(/\s+/g, ' ').trim().slice(0, max) : '';
}

function cleanMultiline(value: unknown, max = 16_000): string {
  return typeof value === 'string' ? value.replace(/\0/g, '').trim().slice(0, max) : '';
}

function validIso(value: unknown): string | null {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? value : null;
}

function safeHref(value: unknown): string | null {
  const href = cleanText(value, 2_000);
  if (!href) return null;
  try {
    const url = new URL(href);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null;
  } catch {
    return null;
  }
}

function offerKey(value: unknown): string {
  return cleanText(value, 180)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);
}

function normalizeEvidence(value: unknown): HelperEvidenceRef[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const raw = item as Record<string, unknown>;
    const source = cleanText(raw.source, 80);
    const id = cleanText(raw.id, 240);
    const label = cleanText(raw.label, 240);
    const detail = cleanText(raw.detail, 600);
    if (!source || !id || !label || !detail) return [];
    return [{ source, id, label, detail, href: safeHref(raw.href) }];
  }).slice(0, 8);
}

function normalizeOffer(value: unknown, existing?: HelperOffer): HelperOffer | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const key = offerKey(raw.key);
  const title = cleanText(raw.title, 240);
  const summary = cleanText(raw.summary, 800);
  const whyNow = cleanText(raw.whyNow, 800);
  const outcome = cleanText(raw.outcome, 600);
  const prompt = cleanMultiline(raw.prompt);
  const evidence = normalizeEvidence(raw.evidence);
  if (
    !key
    || !title
    || !summary
    || !whyNow
    || !outcome
    || prompt.length < 120
    || evidence.length === 0
    || !hasIndependentOfferEvidence(evidence)
  ) return null;
  const size: HelperOfferSize = raw.size === 'small' || raw.size === 'large' ? raw.size : 'medium';
  const confidenceRaw = Number(raw.confidence);
  const confidence = Number.isFinite(confidenceRaw) ? Math.max(0, Math.min(1, confidenceRaw)) : 0.5;
  if (confidence < 0.5) return null;
  const pathValue = cleanText(raw.path, 4_096);
  const path = isAbsolute(pathValue) && (
    pathValue === config.paths.projectsDir || pathValue.startsWith(`${config.paths.projectsDir}/`)
  ) ? pathValue : null;
  const now = iso();
  return {
    id: existing?.id ?? randomUUID(),
    key,
    title,
    summary,
    whyNow,
    outcome,
    size,
    confidence,
    path,
    evidence,
    prompt,
    status: existing?.status === 'offered' ? 'offered' : 'offered',
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    snoozedUntil: null,
    feedback: existing?.feedback ?? null,
    launchedAt: existing?.launchedAt ?? null,
    launchedWith: existing?.launchedWith ?? null,
    launchedPrompt: existing?.launchedPrompt ?? null,
  };
}

function normalizePreference(value: unknown): HelperPreference | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const statement = cleanText(raw.statement, 600);
  if (!statement) return null;
  const kind = raw.kind === 'prefer' || raw.kind === 'constraint' ? raw.kind : 'avoid';
  const now = iso();
  return {
    id: cleanText(raw.id, 100) || randomUUID(),
    kind,
    statement,
    createdAt: validIso(raw.createdAt) ?? now,
    updatedAt: validIso(raw.updatedAt) ?? now,
    sourceOfferId: cleanText(raw.sourceOfferId, 100) || null,
  };
}

function skillSlug(name: string, id: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || `skill-${id.slice(0, 8)}`;
}

function normalizeSkill(value: unknown, existing?: HelperSkill): HelperSkill | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const name = cleanText(raw.name, 120);
  const description = cleanText(raw.description, 360);
  const instructions = cleanMultiline(raw.instructions, 8_000);
  if (!name || !description || instructions.length < 40) return null;
  const id = cleanText(raw.id, 100) || existing?.id || randomUUID();
  const now = iso();
  const slug = skillSlug(name, id);
  return {
    id,
    name,
    description,
    instructions,
    path: join(config.helper.skillsDir, slug, 'SKILL.md'),
    createdAt: existing?.createdAt ?? validIso(raw.createdAt) ?? now,
    updatedAt: now,
  };
}

function normalizeFeedback(value: unknown): HelperFeedback | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const id = cleanText(raw.id, 100);
  const offerId = cleanText(raw.offerId, 100);
  const reason = cleanText(raw.reason, 1_000);
  if (!id || !offerId || !reason) return null;
  return {
    id,
    offerId,
    reason,
    remember: Boolean(raw.remember),
    createdAt: validIso(raw.createdAt) ?? iso(),
    processedAt: validIso(raw.processedAt),
  };
}

function normalizeSource(value: unknown): HelperSourceStatus | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const id = cleanText(raw.id, 80);
  const label = cleanText(raw.label, 120);
  const detail = cleanText(raw.detail, 600);
  if (!id || !label || !detail) return null;
  const status: HelperSourceStatus['status'] =
    raw.status === 'pending'
    || raw.status === 'ready'
    || raw.status === 'limited'
    || raw.status === 'error'
      ? raw.status
      : 'unavailable';
  const count = Number(raw.itemCount);
  return {
    id,
    label,
    status,
    detail,
    itemCount: Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0,
    updatedAt: validIso(raw.updatedAt),
  };
}

function normalizeSavedOffer(value: unknown): HelperOffer | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const normalized = normalizeOffer(raw);
  if (!normalized) return null;
  const status = raw.status === 'accepted' || raw.status === 'declined' || raw.status === 'snoozed' || raw.status === 'stale'
    ? raw.status
    : 'offered';
  return {
    ...normalized,
    id: cleanText(raw.id, 100) || normalized.id,
    status,
    createdAt: validIso(raw.createdAt) ?? normalized.createdAt,
    updatedAt: validIso(raw.updatedAt) ?? normalized.updatedAt,
    snoozedUntil: validIso(raw.snoozedUntil),
    feedback: cleanText(raw.feedback, 1_000) || null,
    launchedAt: validIso(raw.launchedAt),
    launchedWith: raw.launchedWith === 'codex' ? 'codex' : raw.launchedWith === 'claude' ? 'claude' : null,
    launchedPrompt: cleanMultiline(raw.launchedPrompt) || null,
  };
}

async function atomicWrite(path: string, data: string, mode = 0o600): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, data, { encoding: 'utf8', mode });
  await rename(tmp, path);
}

function persist(): Promise<void> {
  const payload: PersistedState = {
    version: 1,
    offers,
    preferences,
    skills,
    feedback,
    sources,
    settings,
    scanSummary,
    fingerprints,
  };
  writeChain = writeChain.catch(() => undefined).then(() => atomicWrite(STATE_FILE, `${JSON.stringify(payload, null, 2)}\n`));
  return writeChain;
}

function offerRank(status: HelperOffer['status']): number {
  return status === 'offered' ? 0 : status === 'snoozed' ? 1 : 2;
}

function wakeExpiredSnoozes(): void {
  const now = Date.now();
  offers = offers.map((offer) =>
    offer.status === 'snoozed' && offer.snoozedUntil && Date.parse(offer.snoozedUntil) <= now
      ? { ...offer, status: 'offered', snoozedUntil: null, updatedAt: iso() }
      : offer,
  );
}

function publish(): void {
  wakeExpiredSnoozes();
  store.setSection('helper', {
    updatedAt: iso(),
    offers: [...offers].sort((a, b) => offerRank(a.status) - offerRank(b.status) || b.updatedAt.localeCompare(a.updatedAt)),
    preferences: [...preferences].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    skills: [...skills].sort((a, b) => a.name.localeCompare(b.name)),
    feedback: [...feedback].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 80),
    sources,
    settings,
    agent: workerStatus,
    scanSummary,
    error: lastError,
  });
}

async function materializeSkill(skill: HelperSkill): Promise<void> {
  const slug = skillSlug(skill.name, skill.id);
  const body = [
    '---',
    `name: ${slug}`,
    `description: ${JSON.stringify(skill.description)}`,
    'user-invocable: false',
    '---',
    '',
    `# ${skill.name}`,
    '',
    skill.instructions,
    '',
  ].join('\n');
  await atomicWrite(skill.path, body);
}

async function collectLinkedInExport(): Promise<{ file: string; updatedAt: string; excerpt: string[] }[]> {
  const root = config.helper.linkedinExportDir.trim();
  if (!root) return [];
  try {
    const entries = await readdir(root, { withFileTypes: true });
    const files = await Promise.all(entries
      .filter((entry) => entry.isFile() && /\.(?:csv|json|txt)$/i.test(entry.name))
      .slice(0, 30)
      .map(async (entry) => {
        const path = join(root, entry.name);
        const stamp = await stat(path);
        const lines = await tailLines(path, 18, 96 * 1024);
        return {
          file: entry.name,
          updatedAt: stamp.mtime.toISOString(),
          excerpt: lines.map((line) => cleanText(line, 500)).filter(Boolean).slice(-12),
        };
      }));
    return files.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 12);
  } catch {
    return [];
  }
}

function source(
  id: string,
  label: string,
  status: HelperSourceStatus['status'],
  detail: string,
  itemCount: number,
  updatedAt: string | null,
): HelperSourceStatus {
  return { id, label, status, detail, itemCount, updatedAt };
}

async function requireProjectPath(value: string | null): Promise<string> {
  const requested = value || config.paths.projectsDir;
  const [root, path] = await Promise.all([realpath(config.paths.projectsDir), realpath(requested)]);
  const rel = relative(root, path);
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error(`offer path must be inside ${root}`);
  if (!(await stat(path)).isDirectory()) throw new Error('offer path must be a directory');
  return path;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function buildHelperLaunchScript(
  executor: HelperExecutor,
  binary: string,
  path: string,
  promptPath: string,
): string {
  const command = executor === 'claude'
    ? `exec ${shellQuote(binary)} --model opus "$prompt"`
    : `exec ${shellQuote(binary)} --search -C ${shellQuote(path)} "$prompt"`;
  return [
    '#!/usr/bin/env bash',
    'set -u',
    `cd ${shellQuote(path)} || exit 1`,
    `prompt="$(cat ${shellQuote(promptPath)})"`,
    command,
    'status=$?',
    'printf "\\n%s exited %s; keeping the terminal open.\\n" ' + shellQuote(executor) + ' "$status"',
    'exec "${SHELL:-/bin/bash}"',
    '',
  ].join('\n');
}

async function availableBinary(primary: string, fallback: string): Promise<string> {
  if (primary.includes('/')) {
    try {
      await access(primary);
      return primary;
    } catch {
      /* fall through to PATH lookup */
    }
  }
  const found = await sh('which', [fallback], { timeoutMs: 2_000 }).catch(() => '');
  if (!found.trim()) throw new Error(`${fallback} is not installed`);
  return found.trim();
}

async function writeLaunchFiles(offer: HelperOffer, executor: HelperExecutor, prompt: string, path: string): Promise<string> {
  const root = join(config.configDir, 'helper-launches');
  await mkdir(root, { recursive: true, mode: 0o700 });
  const stamp = Date.now();
  const promptPath = join(root, `${offer.id}-${stamp}.prompt.md`);
  const scriptPath = join(root, `${offer.id}-${stamp}.sh`);
  await atomicWrite(promptPath, `${prompt}\n`);
  const binary = executor === 'claude'
    ? await availableBinary(config.paths.claudeBin, 'claude')
    : await availableBinary(config.paths.codexBin, 'codex');
  const body = buildHelperLaunchScript(executor, binary, path, promptPath);
  await atomicWrite(scriptPath, body, 0o700);
  return scriptPath;
}

async function launchHelperTmux(path: string, title: string, script: string, offerId: string): Promise<string> {
  return launchTmuxSession({
    name: 'atrium-h-' + offerId,
    cwd: path,
    command: script,
    title: 'Atrium · ' + title,
  });
}

function findOffer(idValue: unknown): HelperOffer {
  const id = cleanText(idValue, 100);
  const offer = offers.find((candidate) => candidate.id === id);
  if (!offer) throw new Error('unknown helper offer');
  return offer;
}

function applyPreferenceUpdates(value: unknown): void {
  if (!Array.isArray(value)) return;
  for (const item of value.slice(0, 12)) {
    if (!item || typeof item !== 'object') continue;
    const raw = item as Record<string, unknown>;
    if (raw.operation === 'remove') continue;
    const id = cleanText(raw.id, 100);
    const existing = id ? preferences.find((entry) => entry.id === id) : undefined;
    const normalized = normalizePreference({ ...raw, id: existing?.id || id || undefined });
    if (!normalized) continue;
    const duplicate = preferences.find((entry) => entry.statement.toLowerCase() === normalized.statement.toLowerCase());
    if (duplicate && duplicate.id !== normalized.id) continue;
    preferences = existing
      ? preferences.map((entry) => entry.id === existing.id ? { ...normalized, createdAt: existing.createdAt } : entry)
      : [normalized, ...preferences].slice(0, 100);
  }
}

async function applySkillUpdates(value: unknown): Promise<void> {
  if (!Array.isArray(value)) return;
  for (const item of value.slice(0, 8)) {
    if (!item || typeof item !== 'object') continue;
    const raw = item as Record<string, unknown>;
    if (raw.operation === 'remove') continue;
    const id = cleanText(raw.id, 100);
    const existing = id ? skills.find((entry) => entry.id === id) : undefined;
    const normalized = normalizeSkill(raw, existing);
    if (!normalized) continue;
    const duplicate = skills.find((entry) => entry.name.toLowerCase() === normalized.name.toLowerCase());
    if (duplicate && duplicate.id !== normalized.id) continue;
    skills = existing
      ? skills.map((entry) => entry.id === existing.id ? normalized : entry)
      : [normalized, ...skills].slice(0, 40);
    await materializeSkill(normalized);
  }
}

export const helper = {
  async load(): Promise<void> {
    try {
      const saved = await readJson<PersistedState>(STATE_FILE);
      offers = Array.isArray(saved?.offers)
        ? saved.offers.map(normalizeSavedOffer).filter((item): item is HelperOffer => item !== null)
        : [];
      preferences = Array.isArray(saved?.preferences)
        ? saved.preferences.map(normalizePreference).filter((item): item is HelperPreference => item !== null)
        : [];
      skills = Array.isArray(saved?.skills)
        ? saved.skills.map((item) => normalizeSkill(item)).filter((entry): entry is HelperSkill => entry !== null)
        : [];
      feedback = Array.isArray(saved?.feedback)
        ? saved.feedback.map(normalizeFeedback).filter((item): item is HelperFeedback => item !== null)
        : [];
      sources = Array.isArray(saved?.sources)
        ? saved.sources.map(normalizeSource).filter((item): item is HelperSourceStatus => item !== null)
        : [];
      settings = {
        intervalMs: normalizeHelperInterval(saved?.settings?.intervalMs ?? config.helper.defaultIntervalMs),
        defaultExecutor: saved?.settings?.defaultExecutor === 'codex' ? 'codex' : 'claude',
      };
      scanSummary = cleanText(saved?.scanSummary, 320) || null;
      fingerprints = saved?.fingerprints && typeof saved.fingerprints === 'object' ? saved.fingerprints : {};
      lastError = null;
      await Promise.all(skills.map(materializeSkill));
    } catch (err) {
      offers = [];
      preferences = [];
      skills = [];
      feedback = [];
      sources = [];
      scanSummary = null;
      fingerprints = {};
      lastError = err instanceof Error ? err.message : String(err);
    }
    publish();
  },

  async buildEvidence(): Promise<HelperEvidence> {
    const snapshot = store.get();
    const [sessionCollection, linkedinExports] = await Promise.all([
      collectWeeklyAgentSessions(),
      collectLinkedInExport(),
    ]);
    const sessions = sessionCollection.sessions;
    const sessionCounts = Object.entries(sessionCollection.providerCounts)
      .map(([provider, count]) => `${provider === 'opencode' ? 'OpenCode' : provider[0].toUpperCase() + provider.slice(1)} ${count}`)
      .join(' · ');
    const inbox = snapshot.comms.email.threads.slice(0, 30);
    const linkedinMail = inbox.filter((thread) =>
      /linkedin/i.test(`${thread.from} ${thread.subject} ${thread.snippet}`),
    ).slice(0, 15);
    const nextSources: HelperSourceStatus[] = [
      source(
        'workspace',
        'Workspace',
        snapshot.repos.error ? 'error' : snapshot.repos.updatedAt ? 'ready' : 'pending',
        snapshot.repos.error ?? (snapshot.repos.updatedAt ? `${snapshot.repos.repos.length} repositories indexed` : 'Repository index is still loading'),
        snapshot.repos.repos.length,
        snapshot.repos.updatedAt,
      ),
      source(
        'github',
        'GitHub',
        snapshot.github.error ? 'error' : snapshot.github.updatedAt ? 'ready' : 'pending',
        snapshot.github.error ?? (snapshot.github.updatedAt
          ? `${snapshot.github.repositoryInventory.length} remote repositories · ${snapshot.github.actNow.length + snapshot.github.orgQueue.length} actionable signals`
          : 'GitHub queue is still loading'),
        snapshot.github.repositoryInventory.length,
        snapshot.github.updatedAt,
      ),
      source(
        'gmail',
        'Gmail',
        !snapshot.comms.updatedAt
          ? 'pending'
          : snapshot.comms.email.status === 'ok'
            ? 'ready'
            : snapshot.comms.email.status === 'disabled'
              ? 'unavailable'
              : 'error',
        !snapshot.comms.updatedAt
          ? 'Gmail status is still loading'
          : snapshot.comms.email.status === 'ok'
          ? `${inbox.length} recent inbox threads`
          : snapshot.comms.email.error ?? snapshot.comms.google.hint ?? 'Not connected',
        inbox.length,
        snapshot.comms.updatedAt,
      ),
      source(
        'sessions',
        'Agent sessions',
        sessions.length ? 'ready' : 'unavailable',
        sessions.length ? `${sessions.length} sessions from the last 7 days · ${sessionCounts}` : 'No readable sessions from the last 7 days',
        sessions.length,
        sessions[0]?.updatedAt ?? null,
      ),
      source(
        'linkedin',
        'LinkedIn',
        linkedinExports.length ? 'ready' : linkedinMail.length ? 'limited' : 'unavailable',
        linkedinExports.length
          ? `${linkedinExports.length} export files`
          : linkedinMail.length
            ? 'Notification mail only; configure a local member export for richer evidence'
            : 'No local export configured',
        linkedinExports.length + linkedinMail.length,
        linkedinExports[0]?.updatedAt ?? linkedinMail[0]?.date ?? null,
      ),
    ];
    // A server restart briefly resets the live collectors. Keep the last
    // completed source health on the page while the worker still receives the
    // true pending state and waits for fresh evidence.
    sources = nextSources.map((next) => {
      if (next.status !== 'pending') return next;
      return sources.find((previous) => previous.id === next.id && previous.status !== 'pending') ?? next;
    });
    await persist();
    publish();
    return {
      version: 1,
      capturedAt: iso(),
      constraints: { readOnlyScout: true, noOfferQuota: true, exactExecutorPromptRequired: true },
      sources: nextSources,
      offerHistory: offers.slice(0, 300).map((offer) => ({
        key: offer.key,
        title: offer.title,
        status: offer.status,
        feedback: offer.feedback,
        path: offer.path,
        evidenceIds: offer.evidence.map((entry) => `${entry.source}:${entry.id}`),
        updatedAt: offer.updatedAt,
      })),
      preferences: preferences.map(({ id, kind, statement }) => ({ id, kind, statement })),
      skills: skills.map(({ id, name, description, instructions }) => ({ id, name, description, instructions })),
      pendingFeedback: feedback.filter((item) => !item.processedAt).slice(0, 30),
      repositories: snapshot.repos.repos.slice(0, 200),
      github: {
        repositories: snapshot.github.repositoryInventory.slice(0, 200),
        actNow: snapshot.github.actNow.slice(0, 30),
        peopleWaiting: snapshot.github.orgQueue.slice(0, 40),
        pullRequests: snapshot.github.myPRs.slice(0, 30),
        mentions: snapshot.github.mentions.slice(0, 30),
        notifications: snapshot.github.notifications.slice(0, 40),
      },
      gmail: inbox.map(({ from, subject, date, snippet, unread }) => ({ from, subject, date, snippet, unread })),
      linkedin: {
        mail: linkedinMail.map(({ from, subject, date, snippet }) => ({ from, subject, date, snippet })),
        exports: linkedinExports,
      },
      sessions,
      reentry: snapshot.reentry.contexts.filter((context) => context.state !== 'done').slice(0, 30).map((context) => ({
        id: context.id,
        title: context.title,
        path: context.path,
        state: context.state,
        note: context.note,
        goal: context.capsule?.goal ?? null,
        nextAction: context.capsule?.nextAction ?? null,
        blocker: context.capsule?.blocker ?? null,
      })),
      recentNotes: snapshot.notes.recent.slice(0, 30),
    };
  },

  async applyAgentResult(value: unknown): Promise<{ added: number; updated: number }> {
    if (!value || typeof value !== 'object') throw new Error('agent result must be an object');
    const raw = value as Record<string, unknown>;
    if (!Array.isArray(raw.offers)) throw new Error('agent result is missing offers');
    const existingByKey = new Map(offers.map((offer) => [offer.key, offer]));
    let added = 0;
    let updated = 0;
    for (const candidate of raw.offers.slice(0, config.helper.maxOffersPerScan)) {
      const candidateKey = offerKey((candidate as any)?.key);
      const existing = existingByKey.get(candidateKey);
      // History is a hard server-side guard. Only an offer still awaiting a
      // decision may be refreshed; accepted/declined/stale work never repeats.
      if (existing && existing.status !== 'offered') continue;
      const normalized = normalizeOffer(candidate, existing);
      if (!normalized) continue;
      const fingerprint = offerFingerprint(normalized);
      if (!existing && Object.values(fingerprints).includes(fingerprint)) continue;
      fingerprints[normalized.key] = fingerprint;
      if (existing) {
        offers = offers.map((offer) => offer.id === existing.id ? normalized : offer);
        updated += 1;
      } else {
        offers = [normalized, ...offers].slice(0, 500);
        existingByKey.set(normalized.key, normalized);
        added += 1;
      }
    }
    if (raw.offers.length > 0 && added === 0 && updated === 0) {
      const hadKnownKeys = raw.offers.some((item) => existingByKey.has(offerKey((item as any)?.key)));
      if (!hadKnownKeys) throw new Error('The scout returned offers that failed validation');
    }
    applyPreferenceUpdates(raw.preferenceUpdates);
    await applySkillUpdates(raw.skillUpdates);
    const processedAt = iso();
    feedback = feedback.map((item) => item.processedAt ? item : { ...item, processedAt });
    scanSummary = cleanText(raw.scanSummary, 320) || (added ? `${added} new offer${added === 1 ? '' : 's'}.` : 'Nothing worth interrupting you for.');
    lastError = null;
    await persist();
    publish();
    return { added, updated };
  },

  async applyAgentError(value: unknown): Promise<void> {
    const raw = value && typeof value === 'object' ? value as Record<string, unknown> : {};
    lastError = cleanText(raw.error, 800) || 'helper scan failed';
    publish();
  },

  async requestScan(): Promise<{ ok: boolean; scheduled: boolean; error?: string }> {
    await atomicWrite(HELPER_FORCE_SCAN_FILE, `${iso()}\n`);
    workerStatus = { ...workerStatus, status: 'running', lastError: null };
    lastError = null;
    publish();
    try {
      await sh('systemctl', ['--user', 'start', '--no-block', 'atrium-helper-agent.service'], {
        timeoutMs: 10_000,
        env: userSystemdEnv(),
      });
      return { ok: true, scheduled: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      workerStatus = { ...workerStatus, status: 'error', lastError: message.slice(0, 800) };
      publish();
      return { ok: false, scheduled: false, error: message.slice(0, 500) };
    }
  },

  async dismiss(idValue: unknown, input: unknown): Promise<HelperOffer> {
    const offer = findOffer(idValue);
    const raw = input && typeof input === 'object' ? input as Record<string, unknown> : {};
    const reason = cleanText(raw.reason, 1_000);
    if (!reason) throw new Error('tell the scout why this offer is not useful');
    const remember = raw.remember !== false;
    const now = iso();
    const next: HelperOffer = { ...offer, status: 'declined', feedback: reason, snoozedUntil: null, updatedAt: now };
    offers = offers.map((candidate) => candidate.id === offer.id ? next : candidate);
    feedback = [{
      id: randomUUID(),
      offerId: offer.id,
      reason,
      remember,
      createdAt: now,
      processedAt: null,
    }, ...feedback].slice(0, 300);
    if (remember && !preferences.some((entry) => entry.statement.toLowerCase() === reason.toLowerCase())) {
      const learned: HelperPreference = {
        id: randomUUID(),
        kind: 'avoid',
        statement: reason,
        createdAt: now,
        updatedAt: now,
        sourceOfferId: offer.id,
      };
      preferences = [learned, ...preferences].slice(0, 100);
    }
    await persist();
    publish();
    return next;
  },

  async snooze(idValue: unknown, input: unknown): Promise<HelperOffer> {
    const offer = findOffer(idValue);
    const raw = input && typeof input === 'object' ? input as Record<string, unknown> : {};
    const durationMs = Math.max(10 * 60_000, Math.min(30 * 24 * 60 * 60_000, Number(raw.durationMs) || 24 * 60 * 60_000));
    const next: HelperOffer = {
      ...offer,
      status: 'snoozed',
      snoozedUntil: new Date(Date.now() + durationMs).toISOString(),
      updatedAt: iso(),
    };
    offers = offers.map((candidate) => candidate.id === offer.id ? next : candidate);
    await persist();
    publish();
    return next;
  },

  async launch(idValue: unknown, input: unknown): Promise<{ offer: HelperOffer; launched: true; executor: HelperExecutor }> {
    const offer = findOffer(idValue);
    const raw = input && typeof input === 'object' ? input as Record<string, unknown> : {};
    const executor: HelperExecutor = raw.executor === 'codex' ? 'codex' : raw.executor === 'claude' ? 'claude' : settings.defaultExecutor;
    const prompt = cleanMultiline(raw.prompt);
    if (prompt.length < 80) throw new Error('the handoff prompt is too short');
    const path = await requireProjectPath(offer.path);
    const script = await writeLaunchFiles(offer, executor, prompt, path);
    await launchHelperTmux(path, offer.title, script, offer.id);
    const now = iso();
    const next: HelperOffer = {
      ...offer,
      status: 'accepted',
      updatedAt: now,
      launchedAt: now,
      launchedWith: executor,
      launchedPrompt: prompt,
      snoozedUntil: null,
    };
    offers = offers.map((candidate) => candidate.id === offer.id ? next : candidate);
    settings = { ...settings, defaultExecutor: executor };
    await persist();
    publish();
    return { offer: next, launched: true, executor };
  },

  async updateSettings(input: unknown): Promise<HelperSettings> {
    const raw = input && typeof input === 'object' ? input as Record<string, unknown> : {};
    const intervalMs = normalizeHelperInterval(raw.intervalMs ?? settings.intervalMs);
    const defaultExecutor: HelperExecutor = raw.defaultExecutor === 'codex'
      ? 'codex'
      : raw.defaultExecutor === 'claude'
        ? 'claude'
        : settings.defaultExecutor;
    const dropIn = join(
      dirname(resolve(process.env.HOME ?? '', '.config/systemd/user/atrium-helper-agent.timer')),
      'atrium-helper-agent.timer.d',
      'interval.conf',
    );
    const body = [
      '[Timer]',
      'OnUnitActiveSec=',
      `OnUnitActiveSec=${systemdInterval(intervalMs)}`,
      '',
    ].join('\n');
    await atomicWrite(dropIn, body);
    await sh('systemctl', ['--user', 'daemon-reload'], { timeoutMs: 10_000, env: userSystemdEnv() });
    await sh('systemctl', ['--user', 'restart', 'atrium-helper-agent.timer'], { timeoutMs: 10_000, env: userSystemdEnv() });
    settings = { intervalMs, defaultExecutor };
    await persist();
    publish();
    return settings;
  },

  async removePreference(idValue: unknown): Promise<void> {
    const id = cleanText(idValue, 100);
    if (!preferences.some((entry) => entry.id === id)) throw new Error('unknown working-agreement rule');
    preferences = preferences.filter((entry) => entry.id !== id);
    await persist();
    publish();
  },

  async removeSkill(idValue: unknown): Promise<void> {
    const id = cleanText(idValue, 100);
    const skill = skills.find((entry) => entry.id === id);
    if (!skill) throw new Error('unknown helper skill');
    skills = skills.filter((entry) => entry.id !== id);
    await rm(dirname(skill.path), { recursive: true, force: true });
    await persist();
    publish();
  },

  async refreshWorkerStatus(nextRunAt: string | null, active: boolean | null): Promise<void> {
    const file = await readJson<HelperWorkerFile>(HELPER_WORKER_STATE_FILE);
    workerStatus = {
      status: active ? 'running' : file?.status ?? 'idle',
      model: file?.model || config.helper.model,
      lastCheckedAt: file?.lastCheckedAt ?? null,
      lastOfferedAt: file?.lastOfferedAt ?? null,
      lastError: file?.lastError ?? null,
      nextRunAt,
    };
    publish();
  },
};

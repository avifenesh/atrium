import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';
import { redactSecrets, shTry } from './util.js';

export type HelperSessionProvider = 'claude' | 'codex' | 'grok' | 'opencode' | 'hermes';

export interface HelperSessionEvidence {
  provider: HelperSessionProvider;
  id: string;
  path: string | null;
  title: string;
  updatedAt: string;
  messageCount: number;
  contentHash: string;
  /** Task opening plus the latest conversational turns. Tool and reasoning payloads never enter this field. */
  excerpt: { role: 'user' | 'assistant'; text: string }[];
}

export interface HelperSessionCollection {
  windowStartedAt: string;
  sessions: HelperSessionEvidence[];
  providerCounts: Record<HelperSessionProvider, number>;
}

interface RecentFile {
  path: string;
  mtimeMs: number;
}

type SessionRole = 'user' | 'assistant';

const PROVIDERS: HelperSessionProvider[] = ['claude', 'codex', 'grok', 'opencode', 'hermes'];
const EXCERPT_MESSAGE_LIMIT = 1_600;
const EXCERPT_TAIL_SIZE = 4;
const CACHE_MS = 60_000;
const SECRET_TOKEN_RE = /\b(?:sk-[A-Za-z0-9_-]{12,}|ghp_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{12,}|AKIA[A-Z0-9]{16})\b/g;

let cached: { expiresAt: number; value: HelperSessionCollection } | null = null;

function cleanText(value: unknown, max = Number.POSITIVE_INFINITY): string {
  if (typeof value !== 'string') return '';
  return redactSecrets(value)
    .replace(SECRET_TOKEN_RE, '[redacted]')
    .replace(/\0/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, max);
}

function cleanAgentEnvelope(value: string): string {
  const explicitQuery = value.match(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/i);
  if (explicitQuery) return explicitQuery[1];
  if (/<command-name>|<local-command-stdout>/i.test(value)) return '';
  let cleaned = value
    .replace(/^# AGENTS\.md instructions\s*<INSTRUCTIONS>[\s\S]*?<\/INSTRUCTIONS>/i, '')
    .replace(/<local-command-caveat>[\s\S]*?<\/local-command-caveat>/gi, '')
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, '')
    .replace(/<user_info>[\s\S]*?<\/user_info>/gi, '')
    .replace(/<environment_context>[\s\S]*?<\/environment_context>/gi, '')
    .replace(/<heartbeat>[\s\S]*?<\/heartbeat>/gi, '');
  if (/^\[IMPORTANT:\s*You are running as a scheduled cron job\./i.test(cleaned)) {
    const boundary = cleaned.indexOf('\n\n');
    cleaned = boundary >= 0 ? cleaned.slice(boundary + 2) : '';
  }
  return cleaned;
}

function latestIso(current: string | null, value: unknown): string | null {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) return current;
  const next = new Date(value).toISOString();
  return !current || next > current ? next : current;
}

export function claudeSessionFileId(path: string, reportedId: string): string {
  const fileId = basename(path, '.jsonl');
  return path.includes('/subagents/')
    ? `${cleanText(reportedId, 180)}/subagent/${cleanText(fileId, 40)}`
    : cleanText(reportedId, 240);
}

export function codexSessionFileId(path: string): string {
  const name = basename(path, '.jsonl');
  return cleanText(name.match(/[0-9a-f]{8}-[0-9a-f-]{27,}/i)?.[0] ?? name, 240);
}

function meaningful(text: string): boolean {
  return Boolean(text && text !== '.' && !/^\/(?:compact|clear|exit)\b/i.test(text));
}

function projectPath(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const path = value.replace(/\/+$/, '');
  return path === config.paths.projectsDir || path.startsWith(`${config.paths.projectsDir}/`) ? path : null;
}

function textBlocks(content: unknown, allowed: Set<string>): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => block && typeof block === 'object' && allowed.has(String((block as any).type)))
    .map((block) => String((block as any).text ?? ''))
    .filter(Boolean)
    .join('\n');
}

class SessionAccumulator {
  readonly #hash = createHash('sha256');
  readonly #tail: { role: SessionRole; text: string }[] = [];
  #firstUser: { role: SessionRole; text: string } | null = null;
  #messageCount = 0;

  constructor(
    readonly provider: HelperSessionProvider,
    readonly id: string,
    readonly path: string | null,
    readonly updatedAt: string,
    readonly suppliedTitle = '',
  ) {}

  add(role: SessionRole, value: unknown, stripEnvelope = false): void {
    const raw = typeof value === 'string' && stripEnvelope ? cleanAgentEnvelope(value) : value;
    const text = cleanText(raw);
    if (!meaningful(text)) return;
    this.#hash.update(role).update('\0').update(text).update('\0');
    this.#messageCount++;
    const clipped = { role, text: text.slice(0, EXCERPT_MESSAGE_LIMIT) };
    if (role === 'user' && !this.#firstUser) this.#firstUser = clipped;
    this.#tail.push(clipped);
    if (this.#tail.length > EXCERPT_TAIL_SIZE) this.#tail.shift();
  }

  finish(): HelperSessionEvidence | null {
    if (!this.#messageCount) return null;
    const excerpt = this.#firstUser ? [this.#firstUser, ...this.#tail] : [...this.#tail];
    const seen = new Set<string>();
    const uniqueExcerpt = excerpt.filter((message) => {
      const key = `${message.role}\0${message.text}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    const title = cleanText(this.suppliedTitle, 180)
      || cleanText(this.#firstUser?.text, 180)
      || `${this.provider} session`;
    return {
      provider: this.provider,
      id: cleanText(this.id, 240),
      path: this.path,
      title,
      updatedAt: this.updatedAt,
      messageCount: this.#messageCount,
      contentHash: this.#hash.digest('hex'),
      excerpt: uniqueExcerpt,
    };
  }
}

async function recentFiles(root: string, name: string, cutoffMs: number): Promise<RecentFile[]> {
  const output = await shTry(
    'find',
    [root, '-type', 'f', '-name', name, '-printf', '%T@ %p\n'],
    { timeoutMs: 20_000 },
  );
  if (!output) return [];
  return output
    .split('\n')
    .flatMap((line) => {
      const split = line.indexOf(' ');
      if (split < 1) return [];
      const mtimeMs = Number(line.slice(0, split)) * 1_000;
      const path = line.slice(split + 1);
      return Number.isFinite(mtimeMs) && mtimeMs >= cutoffMs && path ? [{ path, mtimeMs }] : [];
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
}

async function eachLine(path: string, visit: (line: string) => void): Promise<void> {
  const input = createReadStream(path, { encoding: 'utf8' });
  const lines = createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    if (line) visit(line);
  }
}

async function mapPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const output = new Array<R>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      output[index] = await fn(items[index]);
    }
  }));
  return output;
}

function addClaudeLine(
  line: string,
  session: SessionAccumulator,
  metadata: { cwd: string | null; id: string; updatedAt?: string | null },
): void {
  try {
    const row = JSON.parse(line) as any;
    metadata.updatedAt = latestIso(metadata.updatedAt ?? null, row?.timestamp);
    if (typeof row?.cwd === 'string') metadata.cwd = projectPath(row.cwd);
    if (typeof row?.sessionId === 'string') metadata.id = row.sessionId;
    if (row?.type !== 'user' && row?.type !== 'assistant') return;
    const role = row.message?.role === 'user' ? 'user' : row.message?.role === 'assistant' ? 'assistant' : null;
    if (!role) return;
    session.add(role, textBlocks(row.message?.content, new Set(['text'])), role === 'user');
  } catch {
    // Ignore partial or pre-schema JSONL rows.
  }
}

function addCodexLine(
  line: string,
  session: SessionAccumulator,
  metadata: { cwd: string | null; id: string; updatedAt?: string | null },
): void {
  try {
    const row = JSON.parse(line) as any;
    metadata.updatedAt = latestIso(metadata.updatedAt ?? null, row?.timestamp);
    if (row?.type === 'session_meta') {
      if (typeof row.payload?.id === 'string') metadata.id = row.payload.id;
      if (typeof row.payload?.cwd === 'string') metadata.cwd = projectPath(row.payload.cwd);
      return;
    }
    if (row?.type !== 'response_item' || row.payload?.type !== 'message') return;
    const role = row.payload?.role === 'user' ? 'user' : row.payload?.role === 'assistant' ? 'assistant' : null;
    if (!role) return;
    session.add(role, textBlocks(row.payload?.content, new Set(['input_text', 'output_text'])), role === 'user');
  } catch {
    // Ignore partial or pre-schema JSONL rows.
  }
}

function addGrokLine(line: string, session: SessionAccumulator): void {
  try {
    const row = JSON.parse(line) as any;
    const role = row?.type === 'user' ? 'user' : row?.type === 'assistant' ? 'assistant' : null;
    if (!role) return;
    session.add(role, textBlocks(row.content, new Set(['text'])), role === 'user');
  } catch {
    // Ignore partial or pre-schema JSONL rows.
  }
}

export function parseClaudeSessionLines(
  lines: string[],
  fallbackId: string,
  updatedAt: string,
): HelperSessionEvidence | null {
  const metadata = { cwd: null as string | null, id: fallbackId, updatedAt: null as string | null };
  const session = new SessionAccumulator('claude', fallbackId, null, updatedAt);
  for (const line of lines) addClaudeLine(line, session, metadata);
  const value = session.finish();
  return value ? {
    ...value,
    id: cleanText(metadata.id, 240),
    path: metadata.cwd,
    updatedAt: metadata.updatedAt ?? value.updatedAt,
  } : null;
}

export function parseCodexSessionLines(
  lines: string[],
  fallbackId: string,
  updatedAt: string,
): HelperSessionEvidence | null {
  const metadata = { cwd: null as string | null, id: fallbackId, updatedAt: null as string | null };
  const session = new SessionAccumulator('codex', fallbackId, null, updatedAt);
  for (const line of lines) addCodexLine(line, session, metadata);
  const value = session.finish();
  return value ? {
    ...value,
    id: cleanText(metadata.id, 240),
    path: metadata.cwd,
    updatedAt: metadata.updatedAt ?? value.updatedAt,
  } : null;
}

export function parseGrokSessionLines(
  lines: string[],
  id: string,
  path: string | null,
  updatedAt: string,
  title = '',
): HelperSessionEvidence | null {
  const session = new SessionAccumulator('grok', id, projectPath(path), updatedAt, title);
  for (const line of lines) addGrokLine(line, session);
  return session.finish();
}

async function parseClaudeFile(file: RecentFile): Promise<HelperSessionEvidence | null> {
  const fileId = basename(file.path, '.jsonl');
  const metadata = { cwd: null as string | null, id: fileId, updatedAt: null as string | null };
  const session = new SessionAccumulator('claude', metadata.id, null, new Date(file.mtimeMs).toISOString());
  await eachLine(file.path, (line) => addClaudeLine(line, session, metadata));
  const value = session.finish();
  if (!value) return null;
  return {
    ...value,
    id: claudeSessionFileId(file.path, metadata.id),
    path: metadata.cwd,
    updatedAt: metadata.updatedAt ?? value.updatedAt,
  };
}

async function parseCodexFile(file: RecentFile): Promise<HelperSessionEvidence | null> {
  const fileId = codexSessionFileId(file.path);
  const metadata = {
    cwd: null as string | null,
    id: fileId,
    updatedAt: null as string | null,
  };
  const session = new SessionAccumulator('codex', metadata.id, null, new Date(file.mtimeMs).toISOString());
  await eachLine(file.path, (line) => addCodexLine(line, session, metadata));
  const value = session.finish();
  return value ? {
    ...value,
    id: cleanText(fileId, 240),
    path: metadata.cwd,
    updatedAt: metadata.updatedAt ?? value.updatedAt,
  } : null;
}

async function parseGrokFile(file: RecentFile): Promise<HelperSessionEvidence | null> {
  const sessionDir = dirname(file.path);
  const id = basename(sessionDir);
  let path: string | null = null;
  try {
    path = projectPath(decodeURIComponent(basename(dirname(sessionDir))));
  } catch {
    path = null;
  }
  let title = '';
  let updatedAt = new Date(file.mtimeMs).toISOString();
  try {
    const summary = JSON.parse(await readFile(join(sessionDir, 'summary.json'), 'utf8')) as any;
    title = String(summary?.generated_title ?? summary?.session_summary ?? '');
    if (typeof summary?.updated_at === 'string' && !Number.isNaN(Date.parse(summary.updated_at))) {
      updatedAt = new Date(summary.updated_at).toISOString();
    }
  } catch {
    // Live sessions may not have written a summary yet.
  }
  const session = new SessionAccumulator('grok', id, path, updatedAt, title);
  await eachLine(file.path, (line) => addGrokLine(line, session));
  return session.finish();
}

function collectOpenCode(cutoffMs: number): HelperSessionEvidence[] {
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(config.paths.opencodeDb, { readOnly: true });
    const rows = db.prepare(`
      SELECT s.id, s.directory, s.title, s.time_updated, m.data AS message_data, p.data AS part_data
      FROM session s
      JOIN message m ON m.session_id = s.id
      JOIN part p ON p.message_id = m.id
      WHERE s.time_updated >= ?
      ORDER BY s.time_updated DESC, m.time_created, p.time_created
    `).all(cutoffMs) as any[];
    const sessions = new Map<string, SessionAccumulator>();
    for (const row of rows) {
      let message: any;
      let part: any;
      try {
        message = JSON.parse(String(row.message_data ?? '{}'));
        part = JSON.parse(String(row.part_data ?? '{}'));
      } catch {
        continue;
      }
      const role = message?.role === 'user' ? 'user' : message?.role === 'assistant' ? 'assistant' : null;
      if (!role || part?.type !== 'text') continue;
      const id = String(row.id ?? '');
      if (!id) continue;
      let session = sessions.get(id);
      if (!session) {
        session = new SessionAccumulator(
          'opencode',
          id,
          projectPath(row.directory),
          new Date(Number(row.time_updated)).toISOString(),
          String(row.title ?? ''),
        );
        sessions.set(id, session);
      }
      session.add(role, part.text, role === 'user');
    }
    return [...sessions.values()].flatMap((session) => session.finish() ?? []);
  } catch {
    return [];
  } finally {
    db?.close();
  }
}

function collectHermes(cutoffMs: number): HelperSessionEvidence[] {
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(config.paths.hermesStateDb, { readOnly: true });
    const rows = db.prepare(`
      SELECT s.id, s.cwd, s.git_repo_root, s.title, s.last_activity_at,
             m.role, m.content, m.tool_name
      FROM sessions s
      JOIN messages m ON m.session_id = s.id
      WHERE s.last_activity_at >= ?
        AND m.role IN ('user', 'assistant')
      ORDER BY s.last_activity_at DESC, m.timestamp
    `).all(cutoffMs / 1_000) as any[];
    const sessions = new Map<string, SessionAccumulator>();
    for (const row of rows) {
      if (row.tool_name || typeof row.content !== 'string') continue;
      const role: SessionRole = row.role === 'user' ? 'user' : 'assistant';
      const id = String(row.id ?? '');
      if (!id) continue;
      let session = sessions.get(id);
      if (!session) {
        session = new SessionAccumulator(
          'hermes',
          id,
          projectPath(row.cwd) ?? projectPath(row.git_repo_root),
          new Date(Number(row.last_activity_at) * 1_000).toISOString(),
          String(row.title ?? ''),
        );
        sessions.set(id, session);
      }
      session.add(role, row.content, role === 'user');
    }
    return [...sessions.values()].flatMap((session) => session.finish() ?? []);
  } catch {
    return [];
  } finally {
    db?.close();
  }
}

function providerCounts(sessions: HelperSessionEvidence[]): Record<HelperSessionProvider, number> {
  const counts = Object.fromEntries(PROVIDERS.map((provider) => [provider, 0])) as Record<HelperSessionProvider, number>;
  for (const session of sessions) counts[session.provider]++;
  return counts;
}

export async function collectWeeklyAgentSessions(now = Date.now()): Promise<HelperSessionCollection> {
  if (cached && cached.expiresAt > now) return cached.value;
  const cutoffMs = now - config.helper.sessionWindowMs;
  const [claudeFiles, codexFiles, grokFiles] = await Promise.all([
    recentFiles(config.paths.claudeProjects, '*.jsonl', cutoffMs),
    recentFiles(join(config.paths.codexHome, 'sessions'), '*.jsonl', cutoffMs),
    recentFiles(config.paths.grokSessions, 'chat_history.jsonl', cutoffMs),
  ]);
  const [claude, codex, grok] = await Promise.all([
    mapPool(claudeFiles, 8, parseClaudeFile),
    mapPool(codexFiles, 8, parseCodexFile),
    mapPool(grokFiles, 8, parseGrokFile),
  ]);
  const sessions = [
    ...claude,
    ...codex,
    ...grok,
    ...collectOpenCode(cutoffMs),
    ...collectHermes(cutoffMs),
  ]
    .filter((session): session is HelperSessionEvidence => session !== null)
    .filter((session) => Date.parse(session.updatedAt) >= cutoffMs)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const value = {
    windowStartedAt: new Date(cutoffMs).toISOString(),
    sessions,
    providerCounts: providerCounts(sessions),
  };
  cached = { expiresAt: now + CACHE_MS, value };
  return value;
}

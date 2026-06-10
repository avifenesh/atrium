import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';

const HOME = homedir();

export const defaults = {
  port: 5599,
  host: '127.0.0.1',
  configDir: join(HOME, '.config', 'atrium'),

  github: {
    login: 'avifenesh',
    /** orgs excluded from authored-issue noise */
    noiseOrgs: ['zelos-social'],
    pollMs: 60_000,
    ownReposPollMs: 600_000,
  },

  paths: {
    hermesHome: join(HOME, '.hermes'),
    hermesGatewayState: join(HOME, '.hermes', 'gateway_state.json'),
    hermesCronJobs: join(HOME, '.hermes', 'cron', 'jobs.json'),
    hermesAuth: join(HOME, '.hermes', 'auth.json'),
    hermesKanbanDb: join(HOME, '.hermes', 'kanban.db'),
    googleToken: join(HOME, '.hermes', 'google_token.json'),
    eigenHome: join(HOME, '.eigen'),
    eigenSessions: join(HOME, '.eigen', 'sessions'),
    eigenSessionsIndex: join(HOME, '.eigen', 'sessions.json'),
    eigenObserve: join(HOME, '.eigen', 'observe', 'events.jsonl'),
    eigenDaemonSock: join(HOME, '.eigen', 'daemon.sock'),
    claudeProjects: join(HOME, '.claude', 'projects'),
    claudeCredentials: join(HOME, '.claude', '.credentials.json'),
    claudeStatsCache: join(HOME, '.claude', 'stats-cache.json'),
    codexHome: join(HOME, '.codex'),
    codexSessionIndex: join(HOME, '.codex', 'session_index.jsonl'),
    grokAuth: join(HOME, '.grok', 'auth.json'),
    cursorAgent: join(HOME, '.local', 'share', 'cursor-agent'),
    itchConfig: join(HOME, '.config', 'itch'),
    itchRuns: join(HOME, '.config', 'itch', 'runs'),
    anyMissionRuns: join(HOME, 'projects', 'any-mission', '.any-mission'),
    idleWatcherState: join(HOME, '.local', 'state', 'idle-watcher', 'state.json'),
    idleWatcherLog: join(HOME, '.local', 'state', 'idle-watcher', 'watcher.log'),
    obsidianRegistry: join(HOME, '.config', 'obsidian', 'obsidian.json'),
    revutoVault: join(HOME, 'revuto'),
    revutoCli: join(HOME, 'projects', 'revuto', 'dist', 'daemon', 'src', 'cli.js'),
    hermesCli: join(HOME, '.local', 'bin', 'hermes'),
  },

  revuto: {
    snapshotUrl: 'http://127.0.0.1:5180/api/snapshot',
  },

  surreal: {
    endpoint: 'http://127.0.0.1:8000',
    user: 'root',
    pass: 'root',
  },

  /** ports we expect; anything else listening gets flagged */
  knownPorts: {
    8000: 'surrealdb (revuto memory)',
    8181: 'bge embedder (revuto)',
    5180: 'revuto dashboard',
    8787: 'bedrock-codex-bridge',
    8888: 'searxng',
    6379: 'valkey',
    8001: 'llama-server qwen36-27b',
    8003: 'llama-server judge-9b',
    11434: 'ollama',
    42030: 'tailscaled',
    57575: 'tailscaled',
    3389: 'gnome-remote-desktop',
    3390: 'gnome-remote-desktop',
    631: 'cups',
    5599: 'atrium (this app)',
    5173: 'vite dev',
  } as Record<number, string>,

  /** systemd user units that constitute personal infra */
  watchedUnits: [
    'revuto.service',
    'revuto-dashboard.service',
    'revuto-surreal.service',
    'revuto-embedder.service',
    'revuto-guard.timer',
    'hermes-gateway.service',
    'bedrock-codex-bridge.service',
    'voiced.service',
    'readd.service',
  ],

  poll: {
    systemMs: 5_000,
    agentsMs: 10_000,
    scheduleMs: 60_000,
    commsMs: 120_000,
    subsMs: 300_000,
    notesMs: 60_000,
    surrealMs: 60_000,
  },
};

export type Config = typeof defaults;

export function loadConfig(): Config {
  const userPath = join(defaults.configDir, 'config.json');
  if (!existsSync(userPath)) return defaults;
  try {
    const user = JSON.parse(readFileSync(userPath, 'utf8'));
    return deepMerge(defaults, user) as Config;
  } catch {
    return defaults;
  }
}

function deepMerge(base: any, over: any): any {
  if (over === undefined) return base;
  if (typeof base !== 'object' || base === null || Array.isArray(base)) return over;
  const out: any = { ...base };
  for (const k of Object.keys(over)) out[k] = deepMerge(base[k], over[k]);
  return out;
}

export const config = loadConfig();

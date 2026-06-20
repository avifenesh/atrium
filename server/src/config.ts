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
    /** orgs whose repos count as "my repos" in the tasks view */
    ownOrgs: ['agent-sh'],
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
    grokBin: join(HOME, '.grok', 'bin', 'grok'),
    cursorAgent: join(HOME, '.local', 'share', 'cursor-agent'),
    itchConfig: join(HOME, '.config', 'itch'),
    itchRuns: join(HOME, '.config', 'itch', 'runs'),
    anyMissionRuns: join(HOME, 'projects', 'any-mission', '.any-mission'),
    idleWatcherState: join(HOME, '.local', 'state', 'idle-watcher', 'state.json'),
    idleWatcherLog: join(HOME, '.local', 'state', 'idle-watcher', 'watcher.log'),
    obsidianRegistry: join(HOME, '.config', 'obsidian', 'obsidian.json'),
    // defaults match scripts/install-backup.sh (REPO / PASS_FILE)
    resticRepo: join(HOME, 'backups', 'restic'),
    resticPasswordFile: join(HOME, '.config', 'restic', 'password'),
    revutoVault: join(HOME, 'revuto'),
    revutoRepo: join(HOME, 'projects', 'revuto'),
    revutoCli: join(HOME, '.local', 'bin', 'revuto'),
    hermesCli: join(HOME, '.local', 'bin', 'hermes'),
    projectsDir: join(HOME, 'projects'),
  },

  revuto: {
    snapshotUrl: 'http://127.0.0.1:5180/api/snapshot',
  },

  itch: {
    base: 'http://127.0.0.1:8799',
    repo: join(HOME, 'projects', 'itch'),
  },

  surreal: {
    endpoint: 'http://127.0.0.1:8000',
    // surrealdb's stock local-dev credentials for the loopback memory store —
    // real creds belong in ~/.config/atrium/config.json, never this repo
    user: 'root',
    pass: 'root',
  },

  /** ports we expect; anything else listening gets flagged */
  knownPorts: {
    8000: 'surrealdb (revuto memory)',
    8181: 'bge embedder (revuto)',
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
    'revuto-surreal.service',
    'revuto-embedder.service',
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
    revutoMs: 60_000,
    itchMs: 60_000,
    cloudMs: 300_000,
    backupMs: 3_600_000,
    reposMs: 120_000,
  },

  notify: {
    enabled: true,
    // 'crit' | 'warn' | 'info' — minimum severity that pings the phone
    minSeverity: 'crit' as 'info' | 'warn' | 'crit',
    throttleMs: 21_600_000, // one ping per flag id per 6h, even if it flaps
    notifyClear: false, // single-line notice when a pinged flag disappears
    target: 'telegram', // hermes send --to <target>
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

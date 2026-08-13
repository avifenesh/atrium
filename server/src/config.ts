import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';

const HOME = homedir();

export const defaults = {
  port: 5599,
  host: '127.0.0.1',
  configDir: join(HOME, '.config', 'atrium'),

  /** Which collectors run. `disabled` names are skipped at registration — a fork
   *  that doesn't use the author's bespoke tooling can switch off the plugin
   *  collectors (itch, revuto, surreal, and the bespoke agent sources) and get a
   *  clean core dashboard without touching code. Names match the collector `name`
   *  field; for agent sub-sources use `agents:<id>` (e.g. 'agents:itch'). */
  collectors: {
    disabled: [] as string[],
  },

  github: {
    /** your GitHub login. Empty = the github collector stays idle (set it in
     *  ~/.config/atrium/config.json to enable the tasks view). */
    login: '',
    /** orgs whose repos count as "my repos" in the tasks view */
    ownOrgs: [] as string[],
    /** orgs excluded from authored-issue noise */
    noiseOrgs: [] as string[],
    /** repos excluded from every GitHub attention lane, e.g. ['valkey-io/valkey-glide'] */
    noiseRepos: [] as string[],
    /** PR review bots collapsed into a digest in notifications; human activity on the same PR stays visible.
     *  e.g. ['gemini-code-assist', 'coderabbitai'] */
    reviewBotNoiseLogins: [] as string[],
    pollMs: 60_000,
    ownReposPollMs: 600_000,
    /** consecutive failed polls before the crit flag (and phone ping) raises.
     *  The dashboard error shows on the 1st failure; this only gates the page,
     *  so a transient GitHub 5xx that heals next cycle never reaches your phone.
     *  3 × pollMs = ~3 min of sustained failure before you're alerted. */
    failThreshold: 3,
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
    claudeSettings: join(HOME, '.claude', 'settings.json'),
    claudeStatsCache: join(HOME, '.claude', 'stats-cache.json'),
    codexHome: join(HOME, '.codex'),
    codexSessionIndex: join(HOME, '.codex', 'session_index.jsonl'),
    grokAuth: join(HOME, '.grok', 'auth.json'),
    grokBin: join(HOME, '.grok', 'bin', 'grok'),
    grokSessions: join(HOME, '.grok', 'sessions'),
    grokActiveSessions: join(HOME, '.grok', 'active_sessions.json'),
    claudeBin: join(HOME, '.local', 'bin', 'claude'),
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
    // sxc retriever override file. itch-intent mining reads this on every
    // get_context call and lets it WIN over an explicit retriever= arg, so the
    // atrium "fall back to bm25" toggle can route mining off a stale/rebuilding
    // ColBERT index without editing the skill. Mirrors sxc.serve.FORCE_CONFIG_PATH.
    sxcServeConfig: join(HOME, 'projects', 'colbert-2', 'config', 'serve.json'),
  },

  streampile: {
    base: 'http://127.0.0.1:8077',
  },

  wiki: {
    viewerPath: join(HOME, 'projects', 'llm-wiki', 'tools', 'viewer.html'),
  },

  reentry: {
    /** Grok CLI model order. Headless `grok -m` ids, not OpenCode provider routes. */
    models: ['grok-4.6'] as string[],
    runtimeDir: join(HOME, '.config', 'atrium', 'reentry-agent'),
    maxContexts: 32,
  },

  surreal: {
    endpoint: 'http://127.0.0.1:8000',
    // surrealdb's stock local-dev credentials for the loopback memory store —
    // real creds belong in ~/.config/atrium/config.json, never this repo
    user: 'root',
    pass: 'root',
  },

  subs: {
    /** auto-detected subscription ids to hide from the panel (e.g. ['cursor']).
     *  Also skips their poll, so a disabled service makes no external calls.
     *  Manual entries in ~/.config/atrium/subscriptions.json are unaffected. */
    disabled: [] as string[],
  },

  /** disk mounts shown in the system view. Defaults to the root filesystem; add
   *  more (e.g. '/data', '/home') in ~/.config/atrium/config.json for your box. */
  system: {
    diskMounts: ['/'] as string[],
  },

  /** Ports you expect to be listening, mapped to a label. A known port is always
   *  shown (labeled); an unknown port shows only when it binds beyond loopback.
   *  Add your own infra in ~/.config/atrium/config.json — see examples/config.personal.json.
   *  atrium's own port is added automatically below. */
  knownPorts: {
    5599: 'atrium (this app)',
    5173: 'vite dev',
    8077: 'streampile',
  } as Record<number, string>,

  /** Process names (case-insensitive substring → label) whose listeners are
   *  expected and must never raise a signal. Use this for apps whose port is
   *  ephemeral and so can't be pinned in knownPorts — Spotify Connect picks a
   *  random port every launch, so a port-number allowlist can never catch it.
   *  A matched listener is shown labeled in the system view but never flagged. */
  knownPortProcs: {} as Record<string, string>,

  /** systemd --user units to surface in the system view. Empty by default; list
   *  your own services in ~/.config/atrium/config.json. */
  watchedUnits: [] as string[],

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
    reentryMs: 15_000,
    reposMs: 120_000,
  },

  notify: {
    enabled: true,
    // 'crit' | 'warn' | 'info' — minimum severity that pings the phone
    minSeverity: 'crit' as 'info' | 'warn' | 'crit',
    throttleMs: 21_600_000, // one ping per flag id per 6h, even if it flaps
    notifyClear: true, // single-line notice when a pinged flag disappears (so a [crit] always gets a matching [clear] on recovery)
    // Push backend: an argv array; the alert message is appended as the final arg.
    // Empty = push disabled (the flag still shows in the dashboard). Examples:
    //   ['ntfy', 'publish', 'my-topic']
    //   ['curl', '-fsS', '-d', '@-', 'https://my-webhook']  (message as last arg)
    //   ['hermes', 'send', '--to', 'telegram']              (the author's setup)
    // See examples/notify/ for ready-to-copy scripts.
    sendCmd: [] as string[],
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

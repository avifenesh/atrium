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

  /** Exposure counters that expire upstream: GitHub keeps 14 days of traffic and the
   *  top ten referrers, Hugging Face gives one rolling 30-day download number and no
   *  history. The snapshot is written by an external command so there is one definition
   *  of the file format; this daemon only schedules it and shows the result.
   *
   *  { "exposure": { "command": ["node", "/path/to/snapshot.mjs"],
   *                  "snapshotDir": "/path/to/snapshots" } }
   *
   *  Empty = the collector renders "not configured" and runs nothing. */
  exposure: {
    command: [] as string[],
    snapshotDir: '',
  },

  /** tiyuvta inference console — the operator surface for the hosted product.
   *  The console is public-facing, so its admin PAGES were retired: the same API is
   *  driven from here instead, behind the loopback boundary. The bearer is read from
   *  the file that already owns it rather than copied into this config, so there is
   *  one copy of the secret on the machine.
   *  Empty tokenEnvPath / missing file = the collector renders "not set up". */
  tiyuvta: {
    baseUrl: 'https://inference.tiyuvta.ai',
    tokenEnvPath: '',
    tokenEnvVar: 'OWNER_ADMIN_TOKEN',
  },

  /** Web traffic — the two public sites' cookieless analytics dataset on Cloudflare
   *  Analytics Engine, read over the SQL API. READ-ONLY: the collector only queries.
   *  The credential is the SAME file the darklanes reporting scripts use
   *  (~/.config/tiyuvta/cloudflare.env — CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_API_TOKEN,
   *  token scope "Account Analytics: Read"); it is read in place, never copied here.
   *  Empty credsEnvPath = that default path. Missing file = "not set up" row. */
  webtraffic: {
    credsEnvPath: '',
    dataset: 'tiyuvta_web',
    /** trailing report window; deltas compare against the window before it */
    windowDays: 7,
  },

  /** Hugging Face demand radar. Watches ONLY the families listed here — models you
   *  serve or would consider serving — because a radar over every release on the Hub
   *  is a wall of things you cannot act on. Empty = the collector renders one "not
   *  configured" row and polls nothing.
   *
   *  {
   *    "radar": {
   *      "watch": [
   *        { "family": "Qwen3.8 27B", "org": "Qwen", "status": "supported",
   *          "baseModel": "Qwen/Qwen3.8-27B",
   *          "mirrors": ["unsloth/Qwen3.8-27B-NVFP4", "unsloth/Qwen3.8-27B-GGUF"] }
   *      ]
   *    }
   *  }
   *
   *  `mirrors` are the repos whose discussion tabs carry the demand — usually the
   *  popular mirror rather than the original, because that is where people ask. */
  radar: {
    watch: [] as Array<{
      family: string;
      org: string;
      baseModel?: string;
      /** name substring identifying the family inside a large org, e.g. 'gemma-4' */
      match?: string;
      mirrors?: string[];
      status?: string;
    }>,
    /** Title keywords that count as someone asking for a format you could ship. */
    demandKeywords: ['gguf', 'nvfp4', 'fp8', 'quant', 'mtp', 'speculative', 'draft', 'blackwell', '5090'] as string[],
    /** A checkpoint younger than this raises a flag; 6h or less pages the phone. */
    freshHours: 48,
    /** Reactions on a matching thread before it is worth interrupting for. */
    reactionAlert: 3,
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
    hermesStateDb: join(HOME, '.hermes', 'state.db'),
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
    opencodeDb: join(HOME, '.local', 'share', 'opencode', 'opencode.db'),
    claudeBin: join(HOME, '.local', 'bin', 'claude'),
    codexBin: 'codex',
    kittyBin: '/usr/bin/kitty',
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

  helper: {
    /** The scout is intentionally fixed to Claude Code + Opus 5. */
    model: 'claude:opus',
    runtimeDir: join(HOME, '.config', 'atrium', 'helper-agent'),
    skillsDir: join(HOME, '.config', 'atrium', 'helper-skills'),
    defaultIntervalMs: 3 * 60 * 60 * 1_000,
    minIntervalMs: 10 * 60 * 1_000,
    maxIntervalMs: 7 * 24 * 60 * 60 * 1_000,
    maxOffersPerScan: 5,
    sessionWindowMs: 7 * 24 * 60 * 60 * 1_000,
    nestedRepoRoots: [join(HOME, 'projects', 'agent-sh')],
    /** Optional directory from LinkedIn's member data export. */
    linkedinExportDir: '',
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
    helperMs: 15_000,
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

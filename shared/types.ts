// atrium shared contract — single source of truth for server, web, and mcp.
// Server collectors produce these shapes; web renders them; mcp queries them.

export type SectionName =
  | 'github'
  | 'agents'
  | 'system'
  | 'schedule'
  | 'comms'
  | 'subs'
  | 'notes'
  | 'surreal';

export interface Snapshot {
  generatedAt: string;
  github: GithubState;
  agents: AgentsState;
  system: SystemState;
  schedule: ScheduleState;
  comms: CommsState;
  subs: SubsState;
  notes: NotesState;
  surreal: SurrealState;
  mutes: Mute[];
  flags: Flag[];
}

// ---------- github ----------

export interface GithubItem {
  id: string; // "owner/repo#123"
  repo: string; // "owner/repo"
  number: number;
  title: string;
  url: string;
  updatedAt: string;
  kind: 'issue' | 'pr';
}

export interface GithubPR extends GithubItem {
  kind: 'pr';
  isDraft: boolean;
  reviewDecision: 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | null;
  ci: 'SUCCESS' | 'FAILURE' | 'PENDING' | 'ERROR' | 'EXPECTED' | null;
}

export interface GithubNotification {
  id: string;
  reason: string;
  repo: string;
  title: string;
  type: string; // PullRequest | Issue | ...
  url: string; // html url when resolvable, else api url
  updatedAt: string;
  unread: boolean;
}

export interface RepoCount {
  repo: string;
  isPrivate: boolean;
  openIssues: number;
  openPRs: number;
  pushedAt: string;
}

export interface GithubState {
  updatedAt: string | null;
  error: string | null;
  /** direct user-review-requested PRs + issues assigned to me — the act-now lane */
  actNow: GithubItem[];
  myPRs: GithubPR[];
  mentions: GithubItem[];
  /** team review-requested minus direct, minus bots — secondary lane */
  teamQueue: GithubPR[];
  notifications: GithubNotification[];
  ownRepos: RepoCount[];
  rateLimit: { remaining: number; limit: number; resetAt: string } | null;
}

// ---------- agents ----------

export type AgentId =
  | 'revuto'
  | 'hermes'
  | 'itch'
  | 'any-mission'
  | 'eigen'
  | 'claude'
  | 'codex'
  | 'training';

export type AgentStatus = 'running' | 'active' | 'idle' | 'off' | 'error' | 'unknown';
// running = daemon up; active = currently doing work; idle = daemon up, nothing happening

export interface AgentSession {
  id: string;
  title: string | null;
  dir: string | null;
  model: string | null;
  status: string | null;
  updatedAt: string;
  live: boolean; // process currently running for this session
}

export interface AgentControl {
  action: string; // 'pause' | 'resume' | 'stop' | 'start' | 'trigger' | 'kill'
  label: string;
  target?: string; // e.g. repo for revuto pause, job id for hermes
  destructive?: boolean;
}

export interface AgentInfo {
  id: AgentId;
  name: string;
  status: AgentStatus;
  detail: string; // one-line human summary, e.g. "3 sessions, last activity 2m ago"
  lastActivity: string | null; // ISO
  sessions: AgentSession[];
  /** sub-resources that can be individually muted/paused: revuto reviewers, hermes cron jobs */
  resources: { id: string; name: string; state: string; muteable: boolean }[];
  controls: AgentControl[];
  error: string | null;
}

export interface AgentsState {
  updatedAt: string | null;
  agents: AgentInfo[];
  /** rolling ticker from eigen observe/events.jsonl and friends */
  activity: { time: string; source: string; text: string; isError: boolean }[];
  /** tasks handed to eigen via /api/eigen/dispatch */
  dispatches: EigenDispatch[];
}

/** A task handed off to eigen ("send to eigen"). */
export interface EigenDispatch {
  id: string;
  title: string;
  prompt: string;
  dir: string;
  mode: 'daemon' | 'headless';
  status: 'running' | 'done' | 'error';
  startedAt: string;
  endedAt: string | null;
  logPath: string | null;
  /** source ref when dispatched from a github item, e.g. "owner/repo#123" */
  sourceId: string | null;
}

// ---------- system ----------

export interface SystemState {
  updatedAt: string | null;
  cpu: { load1: number; load5: number; load15: number; cores: number; pct: number };
  mem: { totalB: number; availableB: number; usedPct: number };
  swap: { totalB: number; freeB: number; usedPct: number };
  gpu: {
    name: string;
    memUsedMiB: number;
    memTotalMiB: number;
    utilPct: number;
    tempC: number;
    powerW: number;
    procs: { pid: number; name: string; memMiB: number }[];
  } | null;
  disks: { mount: string; sizeB: number; usedB: number; usedPct: number }[];
  ports: { port: number; proc: string; known: boolean; label: string | null }[];
  /** non-obvious user processes worth knowing about */
  processes: { pid: number; cmd: string; cpuPct: number; memPct: number; label: string | null }[];
  services: { unit: string; active: string; sub: string; description: string }[];
  error: string | null;
}

// ---------- schedule (unified cron view) ----------

export interface ScheduleEntry {
  id: string; // "<source>:<key>"
  source: 'crontab' | 'hermes' | 'revuto' | 'systemd-user' | 'systemd-system';
  name: string;
  expr: string; // cron expr or timer spec
  enabled: boolean;
  nextRun: string | null;
  lastRun: string | null;
  lastStatus: 'ok' | 'fail' | null;
  detail: string | null;
  muteable: boolean; // true when we can actually pause it (hermes jobs, revuto)
}

export interface ScheduleState {
  updatedAt: string | null;
  entries: ScheduleEntry[];
  error: string | null;
}

// ---------- comms ----------

export interface EmailThread {
  id: string;
  from: string;
  subject: string;
  date: string;
  snippet: string;
  unread: boolean;
}

export interface CalendarEvent {
  id: string;
  title: string;
  start: string; // ISO
  end: string;
  allDay: boolean;
  location: string | null;
  calendar: string;
}

export interface CommsState {
  updatedAt: string | null;
  /** google connection state — drives the in-app "connect google" flow */
  google: {
    connected: boolean;
    /** which token is in use: atrium's own, or the hermes fallback */
    source: 'atrium' | 'hermes' | null;
    /** human hint when not connected (what to click, what failed) */
    hint: string | null;
  };
  email: {
    status: 'ok' | 'auth-error' | 'disabled' | 'error';
    unreadCount: number;
    threads: EmailThread[]; // recent inbox, newest first
    error: string | null;
  };
  calendar: {
    status: 'ok' | 'auth-error' | 'disabled' | 'error';
    today: CalendarEvent[];
    upcoming: CalendarEvent[]; // next 7 days excluding today
    error: string | null;
  };
}

// ---------- subscriptions / quota ----------

export interface SubService {
  id: string; // 'claude' | 'codex' | 'grok' | 'zai' | 'copilot' | 'cursor' | 'spotify' | ...
  name: string;
  status: 'active' | 'off' | 'not-connected' | 'unknown';
  plan: string | null; // e.g. 'max', 'chatgpt', tier names
  detail: string | null;
  /** usage bars where a real API exists (claude oauth usage), else null */
  usage: { label: string; usedPct: number; resetAt: string | null }[] | null;
  source: string; // where we learned this, e.g. '~/.claude/.credentials.json'
}

export interface SubsState {
  updatedAt: string | null;
  services: SubService[];
  error: string | null;
}

// ---------- notes (obsidian) ----------

export interface NotesState {
  updatedAt: string | null;
  vaultPath: string | null;
  recent: { path: string; title: string; modifiedAt: string }[];
  error: string | null;
}

// ---------- surreal ----------

export interface SurrealState {
  updatedAt: string | null;
  up: boolean;
  endpoint: string;
  version: string | null;
  namespaces: { name: string; databases: string[] }[];
  error: string | null;
}

// ---------- mutes ----------

export type MuteKind =
  | 'github-repo' // target: "owner/repo"
  | 'github-org' // target: "org"
  | 'github-reason' // target: notification reason
  | 'agent' // target: AgentId
  | 'agent-resource' // target: "<agentId>:<resourceId>" e.g. "revuto:owner/repo", "hermes:<jobId>"
  | 'schedule' // target: ScheduleEntry.id
  | 'service' // target: systemd unit
  | 'flag'; // target: Flag.id

export interface Mute {
  id: string;
  kind: MuteKind;
  target: string;
  until: string | null; // null = forever
  /** 'ui' = hidden/dimmed only; 'enforced' = source actually paused (revuto pause, hermes cron pause, ...) */
  mode: 'ui' | 'enforced';
  enforcedBy: string | null; // what command/file made it real
  createdAt: string;
}

export interface MuteRequest {
  kind: MuteKind;
  target: string;
  until?: string | null; // ISO or null/omitted = forever
  enforce?: boolean; // attempt real enforcement when available
}

// ---------- flags (anomalies) ----------

export interface Flag {
  id: string; // stable per anomaly so mutes stick
  severity: 'info' | 'warn' | 'crit';
  title: string;
  detail: string;
  source: string; // collector that raised it
  raisedAt: string;
}

// ---------- api ----------
// GET  /api/health             -> { ok: true }
// GET  /api/snapshot           -> Snapshot
// GET  /api/stream             -> SSE: event "snapshot" (full, on connect) then "section" events {section, data}
// POST /api/mutes              -> body MuteRequest, returns Mute
// DELETE /api/mutes/:id        -> { ok: true }
// POST /api/agents/:id/:action -> body { target? }, returns { ok, output? }
// POST /api/refresh/:section   -> force collector run, returns { ok }
// POST /api/eigen/dispatch     -> body { title, prompt?, url?, repo?, sourceId?, dry? } -> EigenDispatch (dry: returns plan, runs nothing)
// POST /api/notifications/read -> body { id } (thread id) or { all: true } -> { ok }
// GET  /api/google/status      -> CommsState['google']
// GET  /api/google/auth-url    -> { url } (open in browser; consent lands on /api/google/callback)
// GET  /api/google/callback    -> completes oauth, stores atrium-owned token, returns html

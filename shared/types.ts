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
  | 'surreal'
  | 'revuto'
  | 'itch'
  | 'cloud'
  | 'repos';

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
  revuto: RevutoState;
  itch: ItchState;
  cloud: CloudState;
  repos: ReposState;
  /** Plugin collectors (anything not in the typed core above) write here via
   *  store.setExtra(). The web UI renders each entry in a generic panel keyed by
   *  its name. Core collectors never use this lane. */
  extra: Record<string, ExtraSection>;
  /** names of the collectors actually registered this run (config.collectors.disabled
   *  removed the rest). The web UI hides the nav view for any collector not listed,
   *  so disabling a collector drops its data AND its tab. */
  collectors: string[];
  mutes: Mute[];
  flags: Flag[];
}

/** A plugin collector's contribution to the snapshot. `title` and `rows` drive the
 *  generic panel; `data` carries the raw payload for any custom MCP/consumer use. */
export interface ExtraSection {
  /** human label for the generic panel header; defaults to the section key */
  title?: string;
  updatedAt: string | null;
  up?: boolean;
  error?: string | null;
  /** simple label/value rows the generic panel renders; optional href makes a row a link */
  rows?: ExtraRow[];
  /** arbitrary structured payload, untouched by the UI */
  data?: unknown;
}

export interface ExtraRow {
  label: string;
  value: string;
  href?: string;
  /** tints the value: ok=jade, warn=amber, err=coral, else dim */
  tone?: 'ok' | 'warn' | 'err';
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
  itemId: string | null; // "owner/repo#123" when the subject is an issue/PR
  latestActivity: {
    kind: 'comment' | 'review' | 'review_comment' | 'subject';
    actor: string;
    actorType: string | null;
    state: string | null;
    updatedAt: string;
  } | null;
  noise: {
    kind: 'review-bot';
    groupKey: string;
    label: string;
    detail: string;
  } | null;
}

export interface RepoCount {
  repo: string;
  isPrivate: boolean;
  openIssues: number;
  openPRs: number;
  pushedAt: string;
}

/** An open issue/PR on a repo I own or admin, authored by someone else — they are
 *  waiting on me. Ranked above my own PRs: a person blocked on me beats a status update. */
export interface OrgItem {
  id: string; // "owner/repo#123"
  repo: string;
  number: number;
  title: string;
  url: string;
  updatedAt: string;
  createdAt: string;
  kind: 'issue' | 'pr';
  author: string;
  /** 'org' = one of my watched orgs, 'own' = my personal repo */
  scope: 'org' | 'own';
  /** pr-only */
  isDraft: boolean;
  reviewDecision: 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | null;
  ci: 'SUCCESS' | 'FAILURE' | 'PENDING' | 'ERROR' | 'EXPECTED' | null;
  /** computed lane: 'review' = external PR waiting on my review (top), 'triage' = external issue */
  lane: 'review' | 'triage';
}

export interface GithubState {
  updatedAt: string | null;
  error: string | null;
  /** direct user-review-requested PRs + issues assigned to me — the act-now lane */
  actNow: GithubItem[];
  /** external PRs/issues on my repos — people waiting on me, ranked above my own work */
  orgQueue: OrgItem[];
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
  /** rolling utilization history (percent samples, oldest→newest) for the sparklines;
   *  server-persisted so the graphs have depth the moment the app opens */
  history: SystemHistory;
  error: string | null;
}

export interface SystemHistory {
  cpu: number[];
  mem: number[];
  swap: number[];
  gpu: number[];
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

// ---------- cloud (ec2 visibility — informational only, never flags) ----------

export interface CloudInstance {
  id: string;
  name: string | null;
  type: string;
  state: string;
  launchedAt: string | null;
  publicIp: string | null;
  az: string | null;
  monthlyUsd: number | null;
}

export interface CloudState {
  updatedAt: string | null;
  instances: CloudInstance[];
  totalMonthlyUsd: number | null;
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

// ---------- revuto (PR-reviewer watch — standalone daemon + local vault/dashboard) ----------

export interface RevutoScheduler {
  active: boolean; // revuto.service is active
  tasks: number; // expected active cron tasks for unpaused reviewers
  repos: number; // reviewers loaded from the vault, including paused reviewers
  plan: { repo: string; schedules: { review: string; learn: string; decay: string } }[];
}

export interface RevutoDependency {
  id: string; // external helper unit, e.g. "revuto-surreal.service"
  label: string;
  activeState: string; // systemd ActiveState, e.g. "active"
  subState: string; // systemd SubState, e.g. "running"
  since: string | null; // systemd human timestamp string, NOT ISO — display raw
}

export interface RevutoModel {
  role: 'review' | 'curator' | 'distill' | 'embedder';
  enabled: boolean;
  name: string; // provider, e.g. "bedrock-mantle"
  model: string; // model id, e.g. "codex:gpt-5.5" | "claude:sonnet" | "grok:grok-4.5"
  probe: {
    state: 'ok' | 'failed' | 'disabled' | 'unknown';
    kind?: 'chat' | 'embedding' | 'none';
    ms: number | null;
    checkedAt: string | null; // ISO
    error: string | null;
    sharedRoles?: string[];
    responseModel?: string | null;
    responseId?: string | null;
  };
}

export interface RevutoReviewer {
  repo: string; // "owner/repo"
  paused: boolean;
  autoActivate: boolean;
  reviewSchedule: string; // cron expr of the review job for this repo
}

export interface RevutoJob {
  timestamp: string; // ISO with offset, parseable by Date
  job: 'review' | 'learn' | 'decay';
  repo: string;
  status: 'ok' | 'failed' | 'unknown';
  durationMs: number | null;
  summary: string; // "reviewed=1 / skipped=0" or failure text
}

export interface RevutoLog {
  timestamp: string | null; // ISO with offset
  level: 'info' | 'warn' | 'error';
  message: string;
}

export interface RevutoState {
  updatedAt: string | null;
  /** Atrium collected the standalone Revuto service/dashboard successfully this poll. */
  up: boolean;
  scheduler: RevutoScheduler | null;
  counts: {
    schedulerTasks: number;
    dependenciesReady: number;
    dependenciesTotal: number;
    reviewers: number;
    pausedReviewers: number;
    recentJobs: number;
    recentFailures: number;
    reviewed: number;
    skipped: number;
  } | null;
  schedules: { review: string; learn: string; decay: string } | null;
  limits: { maxSteps: number; dailyReviews: number; dailyLearn: number; dailyTokens: number } | null;
  store: { backend: string; url: string | null; namespace: string | null } | null;
  dependencies: RevutoDependency[];
  models: RevutoModel[];
  reviewers: RevutoReviewer[];
  /** newest first, capped at 60 */
  jobs: RevutoJob[];
  /** newest first, capped at 80 */
  logs: RevutoLog[];
  error: string | null;
}

// ---------- itch (idea scout — core data loaded in Atrium; long AI calls still proxied) ----------

export interface ItchRunInfo {
  stem: string; // "YYYYMMDD-HHMMSS", lexicographic == chronological
  nIdeas: number;
  nRated: number;
  isCollide: boolean;
  collisionTemp: number | null;
  /** collide domain sample, empty when not collide */
  sampledDomains: string[];
  baselineFor: string | null;
}

export interface ItchResearch {
  running: boolean;
  started: string | null;
  savedStem: string | null;
  killedReason: string | null;
  resumable: boolean;
}

export type SxcGroundingFeedback = 'up' | 'down';

export interface SxcGroundingReviewItem {
  id: string;
  status: 'review';
  seed: string;
  chunkId: string;
  retriever: string;
  source: string;
  project: string | null;
  sessionId: string;
  ts: number | null;
  score: number;
  /** raw retriever score used for the confidence gate (higher is better) */
  confidence: number;
  threshold: number;
  quote: string;
  feedback: SxcGroundingFeedback | null;
  updatedAt: string;
}

export interface SxcGroundingState {
  updatedAt: string | null;
  /** retriever that produced the latest observed low-confidence grounding batch */
  retriever: string | null;
  /** score threshold below which ColBERT/hybrid hits are tagged for review; 0 disables gating */
  threshold: number;
  pending: SxcGroundingReviewItem[];
  reviewedTotal: number;
  error: string | null;
}

export interface ItchState {
  updatedAt: string | null;
  /** live research API reachable this poll; run journal/decisions are loaded directly */
  up: boolean;
  runs: ItchRunInfo[]; // newest first
  research: ItchResearch;
  /** decisions ledger size (rated ideas across all runs), null when unknown */
  ratedTotal: number | null;
  /** low-confidence sxc grounding hits awaiting explicit relevance feedback */
  sxcGrounding: SxcGroundingState;
  error: string | null;
}

// ---------- repos (local working trees under ~/projects) ----------

export interface RepoInfo {
  name: string;
  path: string;
  branch: string | null;
  detached: boolean;
  dirty: number;
  ahead: number | null;
  behind: number | null;
  lastCommitAt: string | null;
}

export interface ReposState {
  updatedAt: string | null;
  repos: RepoInfo[];
  error: string | null;
}

// ---------- github item detail (in-app reader) ----------

export interface GithubComment {
  id: string;
  author: string;
  body: string; // markdown
  createdAt: string;
  association: string | null; // MEMBER / CONTRIBUTOR / ...
  kind: 'comment' | 'review';
  reviewState: string | null; // APPROVED / CHANGES_REQUESTED / COMMENTED when kind=review
}

export interface GithubItemDetail {
  kind: 'issue' | 'pr';
  repo: string;
  number: number;
  title: string;
  state: string; // open / closed / merged
  author: string;
  body: string; // markdown
  url: string;
  labels: string[];
  createdAt: string;
  updatedAt: string;
  comments: GithubComment[]; // chronological; PR reviews folded in
  pr: {
    isDraft: boolean;
    merged: boolean;
    reviewDecision: string | null;
    ci: string | null;
    additions: number;
    deletions: number;
    changedFiles: number;
    headRef: string;
    baseRef: string;
  } | null;
}

// ---------- mutes ----------

export type MuteKind =
  | 'github-item' // target: "owner/repo#123" — one issue/PR, not the repo
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
  /** github-item only: auto-unmute when the item's updatedAt moves past createdAt
   *  ("reviewed, waiting for reaction" — a new comment brings it back) */
  untilActivity?: boolean;
}

export interface MuteRequest {
  kind: MuteKind;
  target: string;
  until?: string | null; // ISO or null/omitted = forever
  enforce?: boolean; // attempt real enforcement when available
  untilActivity?: boolean; // github-item only: resurface on new activity
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
// GET  /api/github/item?repo=owner/repo&number=N -> GithubItemDetail
// POST /api/github/comment     -> body { repo, number, body } -> { ok, comment: GithubComment }
// POST /api/github/review      -> body { repo, number, event: 'APPROVE'|'REQUEST_CHANGES', body? } -> { ok, review: GithubComment }
// POST /api/notes/write        -> body { path, content, baseModifiedAt? } -> { ok, modifiedAt } (409 when file changed since baseModifiedAt)
// GET  /api/google/status      -> CommsState['google']
// GET  /api/google/auth-url    -> { url } (open in browser; consent lands on /api/google/callback)
// GET  /api/google/callback    -> completes oauth, stores atrium-owned token, returns html

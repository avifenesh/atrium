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
  | 'reentry'
  | 'helper'
  | 'repos'
  | 'signals';

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
  reentry: ReentryState;
  helper: HelperState;
  repos: ReposState;
  signals: SignalsState;
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
  /** author login when the lane fetches it (myPRs doesn't — always you) */
  author?: string | null;
  /** bot-authored or bot-titled (dependabot & friends) — the UI demotes these
   *  out of the attention hero into a collapsed lane */
  bot?: boolean;
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
  /** Complete non-archived inventory for the configured owner and organizations. */
  repositoryInventory: RepoCount[];
  /** Inventory subset with open issues or pull requests, rendered in Tasks. */
  ownRepos: RepoCount[];
  rateLimit: { remaining: number; limit: number; resetAt: string } | null;
  /** attention items untouched for this many days drop out of the hero into the
   *  aging shelf (config github.agingDays — server-owned so every surface agrees) */
  agingDays: number;
}

// ---------- agents ----------

export type AgentId =
  | 'revuto'
  | 'hermes'
  | 'itch'
  | 'any-mission'
  | 'eigen'
  | 'claude'
  | 'grok'
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
  /** tasks opened in grok via /api/eigen/dispatch (legacy path) */
  dispatches: EigenDispatch[];
}

/** A task opened in grok ("open in grok"). */
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
  ports: {
    port: number;
    proc: string;
    known: boolean;
    label: string | null;
    /** Widest bind of this port: loopback < wg-trace < tailnet < lan. */
    scope: PortScope;
    pid: number | null;
  }[];
  /** non-obvious user processes worth knowing about */
  processes: { pid: number; cmd: string; cpuPct: number; memPct: number; label: string | null }[];
  services: { unit: string; active: string; sub: string; description: string }[];
  /** rolling utilization history (percent samples, oldest→newest) for the sparklines;
   *  server-persisted so the graphs have depth the moment the app opens */
  history: SystemHistory;
  error: string | null;
}

export type PortScope = 'loopback' | 'tailnet' | 'wg' | 'lan';

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
  status: 'active' | 'off' | 'not-connected' | 'upcoming' | 'unknown';
  plan: string | null; // e.g. 'max', 'chatgpt', tier names
  detail: string | null;
  /** manual subs only: a future start date renders the card as upcoming */
  startsAt?: string | null;
  /** manual subs only: a planned cancellation date (countdown while active; nags once past) */
  endsAt?: string | null;
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

export interface NoteEntry {
  /** root id + path form the stable note address for /api/notes/read|write */
  root: string;
  path: string;
  title: string;
  modifiedAt: string;
}

export interface NotesRoot {
  id: string; // 'vault' for the obsidian vault, else the configured label
  path: string; // absolute
  label: string;
  count: number; // notes found under this root
  truncated: boolean; // walk hit the file cap — the list is incomplete
}

export interface NotesState {
  updatedAt: string | null;
  vaultPath: string | null;
  roots: NotesRoot[];
  /** every walkable note across all roots, newest first (bounded by the per-root cap) */
  notes: NoteEntry[];
  /** legacy 15-newest slice — kept so an older web bundle stays functional */
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
  model: string; // model id, e.g. "codex:gpt-5.6-sol" | "claude:opus" | "claude:fable" | "grok:grok-4.5"
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
  /** origin remote as "owner/name" when parseable, else null */
  origin: string | null;
  /** agent-lane working copy (wt-* dir or lane/* branch) — folded in the UI so
   *  a fleet of lanes can't drown the real repos */
  isLane: boolean;
}

export interface ReposState {
  updatedAt: string | null;
  repos: RepoInfo[];
  error: string | null;
}

// ---------- signals (external attention on the business — leads, demand, counters) ----------

export type SignalKind = 'mention' | 'release' | 'demand-thread' | 'prospect-thread' | 'counter';

/** Lead lifecycle on a signal: mentions and demand threads are places to go comment
 *  and win a user — 'engaged' = commented/answered, 'dismissed' = not worth it. */
export type SignalLeadStatus = 'engaged' | 'dismissed';

export interface SignalLead {
  status: SignalLeadStatus;
  note: string | null;
  updatedAt: string;
}

export interface SignalItem {
  /** stable per observation so seen-tracking sticks: "<source>:<key>" */
  id: string;
  /** feed that produced it: 'hn' | 'gh-issue' | 'gh-code' | 'devto' | 'web' | 'reddit' |
   *  'youtube' | 'blogs' | 'hf-hub' | 'gh-traffic' | 'crates' | ... */
  source: string;
  kind: SignalKind;
  /** what of mine it is about — a watch term, model family, repo, or crate */
  entity: string;
  title: string;
  detail: string | null;
  url: string | null;
  /** magnitude when the signal is a number (reactions, downloads, views, stars) */
  count: number | null;
  /** counter delta vs the previous observation window, when known */
  delta: number | null;
  /** counters only: recent per-day values, oldest→newest, for the trend spark */
  spark?: number[];
  /** when the thing happened upstream (hit date, release createdAt, snapshot day) */
  occurredAt: string | null;
  /** when atrium first saw it — drives the "new since review" filter */
  firstSeenAt: string;
  /** lead state when the owner acted on it; absent = untouched (a fresh lead) */
  lead?: SignalLead;
}

export interface SignalsWatch {
  /** mention-radar terms (project names) */
  terms: string[];
  /** HF demand-radar watch list */
  radarWatch: Array<{
    family: string;
    org: string;
    baseModel?: string;
    match?: string;
    mirrors?: string[];
    status?: string;
  }>;
  /** thread-title keywords that count as shippable demand */
  demandKeywords: string[];
  /** thread-title keywords that mark a BUYER in pain (hosting/serving trouble) —
   *  these become prospect-thread signals, ranked above artifact demand */
  prospectKeywords: string[];
  /** exposure counters portfolio — snapshotted daily because the upstream windows expire */
  repos: string[];
  hfModels: string[];
  crates: string[];
}

export interface SignalsSourceStatus {
  id: string;
  updatedAt: string | null;
  error: string | null;
}

export interface SignalsState {
  updatedAt: string | null;
  items: SignalItem[];
  watch: SignalsWatch;
  /** everything firstSeen after this is "new" — set by the mark-reviewed action */
  lastReviewedAt: string | null;
  sources: SignalsSourceStatus[];
  error: string | null;
}

// ---------- crm (the business pipeline: leads and accounts through stages) ----------

/** One funnel for both kinds: a lead (thread/mention worth winning) walks
 *  new → contacted → replied and becomes an account (signed-up → active → paying);
 *  'lost' is terminal for either. Order matters — it is the board's column order.
 *  This file stays types-only (its .js compiles CJS under the root package but
 *  loads inside the server's ESM scope), so the runtime array lives in
 *  server/src/crm.ts and web/src/crm/stages.ts, each type-checked against this. */
export type CrmStage = 'new' | 'contacted' | 'replied' | 'signed-up' | 'active' | 'paying' | 'lost';

export interface CrmNote {
  at: string;
  text: string;
}

/** One touch in the contact log — where and what, so the next touch has context. */
export interface CrmContact {
  at: string;
  /** free text: 'email', 'gh-comment', 'hf-thread', 'reddit', ... */
  channel: string;
  summary: string;
}

/** Owner-written CRM state for one pipeline item, keyed by the item id
 *  (signal id for leads, `tenant:<id>` for console accounts). Everything
 *  derivable from live sources stays OUT of here. */
export interface CrmEntry {
  id: string;
  /** manual stage override; null = derived from the live sources */
  stage: CrmStage | null;
  notes: CrmNote[];
  contacts: CrmContact[];
  followUpAt: string | null;
  updatedAt: string;
}

/** Assembled pipeline item: live source merged with the owner's CRM state. */
export interface CrmItem {
  id: string;
  kind: 'lead' | 'account' | 'direction';
  title: string;
  subtitle: string | null;
  /** where the item came from: signal source for leads ('hf-hub', 'hn', 'reddit',
   *  'gh-issue', ...), 'console' for accounts, 'seller' for directions */
  source: string | null;
  /** longer free text: thread stats for leads, why + first action for directions */
  detail: string | null;
  url: string | null;
  stage: CrmStage;
  /** what the sources say on their own — shown when a manual override diverges */
  derivedStage: CrmStage;
  overridden: boolean;
  followUpAt: string | null;
  followUpDue: boolean;
  notes: CrmNote[];
  contacts: CrmContact[];
  /** accounts only */
  metrics: { requests: number; spentMicro: number; paid: boolean } | null;
  /** newest activity timestamp the sources know for sorting */
  activityAt: string | null;
}

export interface CrmPipeline {
  updatedAt: string;
  stages: readonly CrmStage[];
  items: CrmItem[];
  /** ids with CRM state whose live source has vanished — still shown, flagged stale */
  orphaned: string[];
}

/** The business overview the CRM page shows above the pipeline — every number
 *  the collectors already hold, aggregated once server-side so the public CRM
 *  host needs exactly one extra GET and no access to the raw snapshot. */
export interface CrmOverview {
  updatedAt: string;
  /** micro-dollars, from the console dashboard */
  money: {
    purchasedMicro: number;
    grantedMicro: number;
    spentMicro: number;
    outstandingMicro: number;
    purchases: number;
  } | null;
  accounts: {
    total: number;
    withPurchase: number;
    suspended: number;
    internal: number;
    newWeek: number;
  } | null;
  /** last-7-day rows, oldest→newest; internal (owner/bench) traffic separate */
  usageDays: CrmUsageDay[];
  internalDays: CrmUsageDay[];
  visitors: {
    totals: Array<{ site: string; views: number }>;
    daily: Array<{ day: string; site: string; views: number }>;
    topPaths: Array<{ site: string; path: string; views: number }>;
    /** external referrer hosts; kind 'ai' rows are the assistant citations */
    referrers: Array<{ kind: string; host: string; views: number }>;
    /** acquisition channels with delta vs the prior window */
    channels: Array<{ channel: string; views: number; delta: number }>;
  } | null;
  endpoint: {
    models: Array<{
      model: string;
      ok: boolean;
      ttftMs: number | null;
      p50TtftMs: number | null;
      uptimePct: number;
      checkedAt: string;
    }>;
  } | null;
  expenses: {
    burnPerHour: number;
    creditUsd: number | null;
    instances: Array<{
      label: string | null;
      gpuName: string | null;
      numGpus: number | null;
      dphTotal: number | null;
      status: string | null;
    }>;
  } | null;
  /** the business number: usage revenue minus GPU burn, per day. Burn comes
   *  from the vast collector's sampled history, so days before it existed are
   *  omitted rather than shown as revenue-only lies. */
  pnl: Array<{ day: string; revenueUsd: number; burnUsd: number; netUsd: number }>;
  /** outbound funnel: how the seller's drafts are converting, per lead source */
  outbound: {
    drafted: number;
    contacted: number;
    replied: number;
    bySource: Array<{ source: string; drafted: number; contacted: number; replied: number }>;
  };
  /** what real customers experienced through the router, last 24h (probes excluded) */
  realUsage: Array<{ model: string; requests24h: number; errorPct: number; avgMs: number | null }> | null;
  /** OpenRouter provider landscape per served model — the outreach-timing watch */
  competitors: Array<{
    model: string;
    providers: number;
    cheapestInUsd: number | null;
    cheapestOutUsd: number | null;
    minUptimePct: number | null;
    oursInUsd: number | null;
    oursOutUsd: number | null;
  }> | null;
  /** signups by the ?ref= they carried in — which channel actually converts */
  signupSources: Array<{ source: string; count: number }>;
  /** Google Ads spend joined with the signup funnel per ref (30d spend window,
   *  funnel all-time). costUsd converted at read by the collector; the kill
   *  gate ($150/payer, ads cell) renders from these numbers. */
  ads: {
    updatedAt: number | null;
    rows: Array<{
      ref: string;
      costUsd: number | null;
      clicks: number;
      signups: number;
      activated: number;
      paid: number;
    }>;
  } | null;
  /** project reach, from the newest daily exposure snapshot: GitHub repo
   *  traffic, HF model downloads, crates installs — the top of the funnel */
  exposure: {
    date: string;
    repos: Array<{
      repo: string;
      stars: number;
      views14d: number;
      uniques14d: number;
      clones14d: number;
    }>;
    referrers: Array<{ referrer: string; count: number }>;
    huggingface: Array<{ id: string; downloads30d: number; likes: number }>;
    crates: Array<{ name: string; recentDownloads: number; version: string }>;
  } | null;
  models: string[];
}

export interface CrmUsageDay {
  day: string;
  requests: number;
  promptTokens: number;
  /** prompt tokens served from prefix cache — hit rate = cached / prompt */
  cachedPromptTokens: number;
  completionTokens: number;
  debitedMicro: number;
}

/** One direction file under ~/.config/atrium/directions/ — written by the hermes
 *  seller profile's scheduled hunt, read into the pipeline as kind 'direction'.
 *  A direction is a NEW way to sell (channel, segment, integration, partnership,
 *  content surface), never another comment on an existing thread. */
export interface CrmDirection {
  slug: string;
  title: string;
  /** evidence: why this is worth an hour */
  why: string;
  /** the single concrete first move */
  firstAction: string;
  segment: string | null;
  urls: string[];
  createdAt: string;
}

// ---------- re-entry (durable context parking + background status brief) ----------

export type ReentryEnergy = 'light' | 'medium' | 'deep';
export type ReentryContextState = 'parked' | 'active' | 'done';
export type ReentryScanStatus = 'queued' | 'ready' | 'error';

export interface ReentryCapsule {
  goal: string;
  verifiedFacts: string[];
  rejectedPaths: string[];
  blocker: string | null;
  nextAction: string;
}

export interface ReentryGitState {
  branch: string | null;
  dirty: number;
  ahead: number | null;
  behind: number | null;
  lastCommitAt: string | null;
  /** Bounded porcelain/status and diff-stat lines captured when the context was parked. */
  summary: string[];
}

export interface ReentryResumeTarget {
  kind: 'tmux' | 'codex' | 'claude' | 'shell';
  /** tmux session name or durable agent session id; null for a plain shell. */
  id: string | null;
  capturedAt: string;
}

export interface ReentryContext {
  id: string;
  title: string;
  path: string;
  project: string;
  note: string;
  energy: ReentryEnergy;
  state: ReentryContextState;
  createdAt: string;
  parkedAt: string;
  updatedAt: string;
  resumedAt: string | null;
  git: ReentryGitState | null;
  resumeTarget: ReentryResumeTarget;
  capsule: ReentryCapsule | null;
  scanStatus: ReentryScanStatus;
  scanError: string | null;
}

export interface ReentryBriefing {
  generatedAt: string;
  model: string;
  headline: string;
  summary: string;
  focus: {
    contextId: string | null;
    path: string | null;
    title: string;
    whyNow: string;
    nextAction: string;
  }[];
  looseEnds: { label: string; detail: string; path: string | null }[];
}

export interface ReentryAgentStatus {
  status: 'idle' | 'running' | 'error' | 'disabled';
  model: string;
  lastCheckedAt: string | null;
  lastPreparedAt: string | null;
  lastError: string | null;
  nextRunAt: string | null;
}

export interface ReentryLastLaunch {
  contextId: string;
  via: string;
  launchedAt: string;
}

export interface ReentryState {
  updatedAt: string | null;
  contexts: ReentryContext[];
  briefing: ReentryBriefing | null;
  agent: ReentryAgentStatus;
  /** Most recently launched Resume — Continue re-attaches that Claude session. */
  lastLaunch: ReentryLastLaunch | null;
  error: string | null;
}

// ---------- proactive helper (evidence-backed offers + learned working agreement) ----------

export type HelperOfferStatus = 'offered' | 'accepted' | 'declined' | 'snoozed' | 'stale';
export type HelperOfferSize = 'small' | 'medium' | 'large';
export type HelperExecutor = 'claude' | 'codex';

export interface HelperEvidenceRef {
  source: string;
  /** Stable source-local identity, such as owner/repo#123 or a session id. */
  id: string;
  label: string;
  detail: string;
  href: string | null;
}

export interface HelperOffer {
  id: string;
  /** Stable semantic identity chosen by the scout and enforced by Atrium. */
  key: string;
  title: string;
  summary: string;
  whyNow: string;
  outcome: string;
  size: HelperOfferSize;
  confidence: number;
  path: string | null;
  evidence: HelperEvidenceRef[];
  /** Exact handoff prompt generated by the scout. The launch composer may edit it. */
  prompt: string;
  status: HelperOfferStatus;
  createdAt: string;
  updatedAt: string;
  snoozedUntil: string | null;
  feedback: string | null;
  launchedAt: string | null;
  launchedWith: HelperExecutor | null;
  launchedPrompt: string | null;
}

export interface HelperPreference {
  id: string;
  kind: 'avoid' | 'prefer' | 'constraint';
  statement: string;
  createdAt: string;
  updatedAt: string;
  sourceOfferId: string | null;
}

export interface HelperSkill {
  id: string;
  name: string;
  description: string;
  instructions: string;
  path: string;
  createdAt: string;
  updatedAt: string;
}

export interface HelperFeedback {
  id: string;
  offerId: string;
  reason: string;
  remember: boolean;
  createdAt: string;
  processedAt: string | null;
}

export interface HelperSourceStatus {
  id: string;
  label: string;
  status: 'pending' | 'ready' | 'limited' | 'unavailable' | 'error';
  detail: string;
  itemCount: number;
  updatedAt: string | null;
}

export interface HelperAgentStatus {
  status: 'idle' | 'running' | 'error' | 'disabled';
  model: string;
  lastCheckedAt: string | null;
  lastOfferedAt: string | null;
  lastError: string | null;
  nextRunAt: string | null;
}

export interface HelperSettings {
  intervalMs: number;
  defaultExecutor: HelperExecutor;
}

export interface HelperState {
  updatedAt: string | null;
  offers: HelperOffer[];
  preferences: HelperPreference[];
  skills: HelperSkill[];
  feedback: HelperFeedback[];
  sources: HelperSourceStatus[];
  settings: HelperSettings;
  agent: HelperAgentStatus;
  scanSummary: string | null;
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
  | 'github-author' // target: author login — one rule instead of muting each bot PR by hand
  | 'github-title' // target: substring, or /regex/ when slash-wrapped — matches item titles
  | 'agent' // target: AgentId
  | 'agent-resource' // target: "<agentId>:<resourceId>" e.g. "revuto:owner/repo", "hermes:<jobId>"
  | 'schedule' // target: ScheduleEntry.id
  | 'service' // target: systemd unit
  | 'flag' // target: Flag.id
  | 'flag-source'; // target: a flag source name (e.g. "system") — mutes every flag from that source

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
  /** flag only: auto-unmute once the flag stops being raised — quiet the current
   *  failure without deafening the channel to the next one */
  untilClear?: boolean;
  /** github-item only: last poll that still returned this item. Mutes whose item
   *  vanished (closed/merged) are retired automatically after a grace window. */
  lastSeenAt?: string;
}

export interface MuteRequest {
  kind: MuteKind;
  target: string;
  until?: string | null; // ISO or null/omitted = forever
  enforce?: boolean; // attempt real enforcement when available
  untilActivity?: boolean; // github-item only: resurface on new activity
  untilClear?: boolean; // flag only: auto-unmute when the flag clears
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
// POST /api/system/ports/teach -> body { port, label? } -> { ok, port, label }
// POST /api/system/ports/stop  -> body { port } -> { ok, port, pid }  (unknown listeners only)
// POST /api/refresh/:section   -> force collector run, returns { ok }
// POST /api/eigen/dispatch     -> body { title, prompt?, url?, repo?, sourceId?, dry? } -> EigenDispatch (opens grok; dry: returns plan, runs nothing)
// POST /api/grok/dispatch      -> same handler as /api/eigen/dispatch
// POST /api/notifications/read -> body { id } (thread id) or { all: true } -> { ok }
// GET  /api/github/item?repo=owner/repo&number=N -> GithubItemDetail
// POST /api/github/comment     -> body { repo, number, body } -> { ok, comment: GithubComment }
// POST /api/github/review      -> body { repo, number, event: 'APPROVE'|'REQUEST_CHANGES', body? } -> { ok, review: GithubComment }
// POST /api/notes/write        -> body { path, content, baseModifiedAt? } -> { ok, modifiedAt } (409 when file changed since baseModifiedAt)
// GET  /api/google/status      -> CommsState['google']
// GET  /api/google/auth-url    -> { url } (open in browser; consent lands on /api/google/callback)
// GET  /api/google/callback    -> completes oauth, stores atrium-owned token, returns html

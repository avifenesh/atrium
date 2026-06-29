#!/usr/bin/env node
// atrium MCP server — stdio bridge to the atrium daemon's REST API.
// stdout is the MCP protocol channel: never console.log here, only console.error.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import type {
  AgentInfo,
  GithubItem,
  GithubNotification,
  GithubPR,
  Mute,
  OrgItem,
  ScheduleEntry,
  Snapshot,
} from '../../shared/types.js';

const BASE = (process.env.ATRIUM_URL ?? 'http://127.0.0.1:5599').replace(/\/+$/, '');
const DOWN =
  'atrium daemon not running — start with: systemctl --user start atrium (or node server/dist/server/src/index.js)';

class HttpError extends Error {
  constructor(public status: number, body: string) {
    super(body || `HTTP ${status}`);
  }
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { ...init, signal: AbortSignal.timeout(5_000) });
  const body = await res.text();
  if (!res.ok) throw new HttpError(res.status, body.slice(0, 400));
  return (body ? JSON.parse(body) : {}) as T;
}

const snapshot = (): Promise<Snapshot> => api<Snapshot>('/api/snapshot');

type ToolResult = { content: { type: 'text'; text: string }[] };
const text = (t: string): ToolResult => ({ content: [{ type: 'text', text: t }] });

async function guarded(fn: () => Promise<string>): Promise<ToolResult> {
  try {
    return text(await fn());
  } catch (err) {
    if (err instanceof HttpError) return text(`atrium error (${err.status}): ${err.message}`);
    // network refusal / 5s timeout — daemon is down
    return text(DOWN);
  }
}

// ---------- formatting ----------

function ago(d: string): string {
  const s = Math.max(0, Math.floor((Date.now() - new Date(d).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function inOrAgo(d: string): string {
  const s = Math.floor((new Date(d).getTime() - Date.now()) / 1000);
  if (s <= 0) return ago(d);
  if (s < 60) return `in ${s}s`;
  if (s < 3600) return `in ${Math.floor(s / 60)}m`;
  if (s < 86400) return `in ${Math.floor(s / 3600)}h`;
  return `in ${Math.floor(s / 86400)}d`;
}

const gb = (b: number): string => (b / 2 ** 30).toFixed(1);
const pct = (n: number): string => `${Math.round(n)}%`;
const hhmm = (iso: string): string => {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

function fmtItem(it: GithubItem): string {
  return `${it.repo}#${it.number} ${it.title} (updated ${ago(it.updatedAt)}) ${it.url}`;
}

function fmtPR(pr: GithubPR): string {
  const bits: string[] = [];
  if (pr.isDraft) bits.push('draft');
  if (pr.reviewDecision) bits.push(pr.reviewDecision.toLowerCase());
  if (pr.ci && pr.ci !== 'SUCCESS') bits.push(`ci:${pr.ci.toLowerCase()}`);
  return fmtItem(pr) + (bits.length ? ` [${bits.join(', ')}]` : '');
}

function fmtOrg(it: OrgItem): string {
  const bits: string[] = [it.lane, `by ${it.author}`];
  if (it.kind === 'pr') {
    if (it.isDraft) bits.push('draft');
    if (it.reviewDecision) bits.push(it.reviewDecision.toLowerCase());
    if (it.ci && it.ci !== 'SUCCESS') bits.push(`ci:${it.ci.toLowerCase()}`);
  }
  return `${fmtItem(it)} [${bits.join(', ')}]`;
}

function fmtNotification(n: GithubNotification): string {
  const bits = [n.reason];
  if (n.latestActivity) {
    bits.push(`${n.latestActivity.kind} by ${n.latestActivity.actor}`);
  }
  return `${n.unread ? '* ' : '- '}${n.repo} ${n.title} (${bits.join(', ')}, updated ${ago(n.updatedAt)}) ${n.url}`;
}

function activeMutes(mutes: Mute[]): Mute[] {
  const now = Date.now();
  return mutes.filter((m) => m.until === null || new Date(m.until).getTime() > now);
}

/** Flags minus the ones muted with kind=flag — atrium_flags tells callers to mute by flag id, so honor it. */
function unmutedFlags(s: Snapshot): Snapshot['flags'] {
  const act = activeMutes(s.mutes);
  return s.flags.filter((f) => !act.some((m) => m.kind === 'flag' && m.target === f.id));
}

function fmtAgent(a: AgentInfo): string {
  const out: string[] = [`${a.name} (${a.id}) — ${a.status} — ${a.detail}`];
  if (a.lastActivity) out.push(`  last activity: ${ago(a.lastActivity)}`);
  if (a.error) out.push(`  error: ${a.error}`);
  if (a.sessions.length) {
    out.push(`  sessions (${a.sessions.length}):`);
    for (const s of a.sessions.slice(0, 8)) {
      const parts = [s.live ? '[live]' : '      ', s.title ?? s.id];
      if (s.model) parts.push(s.model);
      if (s.status) parts.push(s.status);
      parts.push(ago(s.updatedAt));
      if (s.dir) parts.push(s.dir);
      out.push(`    ${parts.join(' — ')}`);
    }
    if (a.sessions.length > 8) out.push(`    … ${a.sessions.length - 8} more`);
  }
  if (a.resources.length) {
    out.push(`  resources (${a.resources.length}):`);
    for (const r of a.resources)
      out.push(`    ${r.name} [${r.state}]${r.muteable ? ' (muteable)' : ''} id=${r.id}`);
  }
  if (a.controls.length)
    out.push(
      `  controls: ${a.controls
        .map((c) => `${c.action}${c.target ? `(${c.target})` : ''}${c.destructive ? '!' : ''}`)
        .join(', ')}`,
    );
  return out.join('\n');
}

// ---------- server ----------

const server = new McpServer({ name: 'atrium', version: '0.1.0' });
const RO = { readOnlyHint: true } as const;
const RW = { readOnlyHint: false } as const;

server.registerTool(
  'atrium_overview',
  {
    description:
      "One-screen summary of the user's life dashboard: act-now tasks, email, calendar, agents, flags, mutes. Call this first for 'what needs my attention'.",
    inputSchema: {},
    annotations: RO,
  },
  () =>
    guarded(async () => {
      const s = await snapshot();
      const lines: string[] = [];
      // orgQueue outranks actNow (people blocked on him); dedupe so items show once
      // ?? [] — a pre-rollout daemon snapshot may lack orgQueue
      const oq = s.github.orgQueue ?? [];
      lines.push(
        `waiting on you: ${oq.length}${oq.length ? ' — ' + oq.slice(0, 5).map((i) => i.title).join(' | ') : ''}`,
      );
      const orgIds = new Set(oq.map((i) => i.id));
      const act = s.github.actNow.filter((i) => !orgIds.has(i.id));
      lines.push(
        `act now: ${act.length}${act.length ? ' — ' + act.slice(0, 5).map((i) => i.title).join(' | ') : ''}`,
      );
      if (s.github.error) lines.push(`github error: ${s.github.error}`);
      lines.push(
        `email: ${s.comms.email.unreadCount} unread${s.comms.email.status !== 'ok' ? ` (${s.comms.email.status})` : ''}`,
      );
      lines.push(
        `calendar today: ${s.comms.calendar.today.length} events${s.comms.calendar.status !== 'ok' ? ` (${s.comms.calendar.status})` : ''}`,
      );
      lines.push('agents:');
      for (const a of s.agents.agents) lines.push(`  ${a.name}: ${a.status} — ${a.detail}`);
      const flags = unmutedFlags(s);
      if (flags.length) {
        lines.push(`flags (${flags.length}):`);
        for (const f of flags.slice(0, 5)) lines.push(`  [${f.severity}] ${f.title}`);
      } else lines.push('flags: none');
      const muted = activeMutes(s.mutes).length;
      lines.push(`mutes active: ${muted}${muted ? ' (atrium_mutes lists ids)' : ''}`);
      return lines.join('\n');
    }),
);

server.registerTool(
  'atrium_tasks',
  {
    description:
      'GitHub task lanes. orgQueue = external PRs/issues on repos I own (people waiting on me — outranks everything); actNow = direct review requests + issues assigned to me; myPRs = my open PRs; mentions; teamQueue = team review requests; notifications.',
    inputSchema: {
      lane: z
        .enum(['orgQueue', 'actNow', 'myPRs', 'mentions', 'teamQueue', 'notifications'])
        .optional()
        .describe('default actNow'),
    },
    annotations: RO,
  },
  ({ lane }) =>
    guarded(async () => {
      const s = await snapshot();
      const gh = s.github;
      const which = lane ?? 'actNow';
      const lines: string[] = [];
      if (gh.error) lines.push(`github error: ${gh.error}`);
      if (which === 'notifications') {
        const reviewBot = gh.notifications.filter((n) => n.noise?.kind === 'review-bot');
        for (const n of gh.notifications.filter((n) => n.noise?.kind !== 'review-bot').slice(0, 30)) {
          lines.push(fmtNotification(n));
        }
        if (reviewBot.length) {
          const repos = [...new Set(reviewBot.map((n) => n.repo))].slice(0, 5).join(', ');
          lines.push(`review-bot digest: ${reviewBot.length} collapsed (${repos})`);
          for (const n of reviewBot.slice(0, 5)) lines.push(`  ${fmtNotification(n)}`);
        }
      } else if (which === 'orgQueue') {
        // server pre-ranks: review (non-draft first) above triage, oldest-waiting first
        // ?? [] — a pre-rollout daemon snapshot may lack orgQueue
        for (const it of (gh.orgQueue ?? []).slice(0, 30)) lines.push(fmtOrg(it));
      } else if (which === 'myPRs' || which === 'teamQueue') {
        for (const pr of gh[which].slice(0, 30)) lines.push(fmtPR(pr));
      } else {
        for (const it of gh[which].slice(0, 30)) lines.push(fmtItem(it));
      }
      return lines.length ? `${which}:\n${lines.join('\n')}` : `${which}: empty`;
    }),
);

server.registerTool(
  'atrium_agents',
  {
    description:
      'Local agent fleet detail (revuto, hermes, itch, any-mission, eigen, claude, codex, training): status, sessions, muteable resources, available controls.',
    inputSchema: { id: z.string().optional().describe('single agent id; omit for all') },
    annotations: RO,
  },
  ({ id }) =>
    guarded(async () => {
      const s = await snapshot();
      const agents = id ? s.agents.agents.filter((a) => a.id === id) : s.agents.agents;
      if (!agents.length)
        return id
          ? `no agent '${id}' — known: ${s.agents.agents.map((a) => a.id).join(', ')}`
          : 'no agents collected yet';
      return agents.map(fmtAgent).join('\n\n');
    }),
);

server.registerTool(
  'atrium_system',
  {
    description: 'System health: cpu, mem, swap, gpu, disks, listening ports, services, notable processes.',
    inputSchema: {},
    annotations: RO,
  },
  () =>
    guarded(async () => {
      const sys = (await snapshot()).system;
      const lines: string[] = [];
      if (sys.error) lines.push(`error: ${sys.error}`);
      lines.push(
        `cpu: ${pct(sys.cpu.pct)} (load ${sys.cpu.load1}/${sys.cpu.load5}/${sys.cpu.load15}, ${sys.cpu.cores} cores)`,
      );
      lines.push(
        `mem: ${pct(sys.mem.usedPct)} used (${gb(sys.mem.totalB - sys.mem.availableB)}/${gb(sys.mem.totalB)} GB)`,
      );
      lines.push(`swap: ${pct(sys.swap.usedPct)} used of ${gb(sys.swap.totalB)} GB`);
      if (sys.gpu) {
        const g = sys.gpu;
        lines.push(
          `gpu: ${g.name} — ${g.memUsedMiB}/${g.memTotalMiB} MiB, ${pct(g.utilPct)} util, ${g.tempC}C, ${g.powerW}W`,
        );
        for (const p of g.procs.slice(0, 6)) lines.push(`  ${p.name} (pid ${p.pid}) ${p.memMiB} MiB`);
      }
      lines.push('disks:');
      for (const d of sys.disks) lines.push(`  ${d.mount} ${pct(d.usedPct)} (${gb(d.usedB)}/${gb(d.sizeB)} GB)`);
      lines.push('ports:');
      for (const p of sys.ports)
        lines.push(`  ${p.port} ${p.proc}${p.label ? ` — ${p.label}` : ''}${p.known ? '' : ' [unexpected]'}`);
      lines.push('services:');
      for (const u of sys.services) lines.push(`  ${u.unit} ${u.active}/${u.sub} — ${u.description}`);
      if (sys.processes.length) {
        lines.push('processes:');
        for (const p of sys.processes.slice(0, 12))
          lines.push(
            `  pid ${p.pid} cpu ${pct(p.cpuPct)} mem ${pct(p.memPct)} ${p.label ?? p.cmd.slice(0, 80)}`,
          );
      }
      return lines.join('\n');
    }),
);

server.registerTool(
  'atrium_schedule',
  {
    description: 'Unified cron view (crontab, hermes jobs, revuto, systemd timers), sorted by next run.',
    inputSchema: {},
    annotations: RO,
  },
  () =>
    guarded(async () => {
      const sch = (await snapshot()).schedule;
      const lines: string[] = [];
      if (sch.error) lines.push(`error: ${sch.error}`);
      const sorted = [...sch.entries].sort((a: ScheduleEntry, b: ScheduleEntry) => {
        if (a.nextRun === null) return b.nextRun === null ? 0 : 1;
        if (b.nextRun === null) return -1;
        return new Date(a.nextRun).getTime() - new Date(b.nextRun).getTime();
      });
      for (const e of sorted)
        lines.push(
          `${e.nextRun ? inOrAgo(e.nextRun) : 'no next run'} — ${e.name} [${e.source}] ${e.expr}` +
            `${e.enabled ? '' : ' (disabled)'}${e.lastStatus ? ` last:${e.lastStatus}` : ''}` +
            `${e.muteable ? ` muteable id=${e.id}` : ''}`,
        );
      return lines.length ? lines.join('\n') : 'no schedule entries';
    }),
);

server.registerTool(
  'atrium_comms',
  {
    description: 'Email unread count + recent thread subjects, calendar today + upcoming 7 days.',
    inputSchema: {},
    annotations: RO,
  },
  () =>
    guarded(async () => {
      const c = (await snapshot()).comms;
      const lines: string[] = [`email (${c.email.status}): ${c.email.unreadCount} unread`];
      if (c.email.error) lines.push(`  error: ${c.email.error}`);
      for (const t of c.email.threads.slice(0, 10))
        lines.push(`  ${t.unread ? '*' : '-'} ${t.subject} — ${t.from} (${ago(t.date)})`);
      lines.push(`calendar (${c.calendar.status}):`);
      if (c.calendar.error) lines.push(`  error: ${c.calendar.error}`);
      lines.push(`  today (${c.calendar.today.length}):`);
      for (const e of c.calendar.today)
        lines.push(
          `    ${e.allDay ? 'all-day' : `${hhmm(e.start)}–${hhmm(e.end)}`} ${e.title}${e.location ? ` @ ${e.location}` : ''}`,
        );
      lines.push(`  upcoming (${c.calendar.upcoming.length}):`);
      for (const e of c.calendar.upcoming.slice(0, 10))
        lines.push(`    ${e.start.slice(0, 10)} ${e.allDay ? 'all-day' : hhmm(e.start)} ${e.title}`);
      return lines.join('\n');
    }),
);

server.registerTool(
  'atrium_subs',
  {
    description: 'Subscription / AI-service status: plan names and usage bars (no secrets).',
    inputSchema: {},
    annotations: RO,
  },
  () =>
    guarded(async () => {
      const subs = (await snapshot()).subs;
      const lines: string[] = [];
      if (subs.error) lines.push(`error: ${subs.error}`);
      for (const sv of subs.services) {
        lines.push(
          `${sv.name}: ${sv.status}${sv.plan ? ` (${sv.plan})` : ''}${sv.detail ? ` — ${sv.detail}` : ''}`,
        );
        for (const u of sv.usage ?? [])
          lines.push(`  ${u.label}: ${pct(u.usedPct)}${u.resetAt ? ` resets ${inOrAgo(u.resetAt)}` : ''}`);
      }
      return lines.length ? lines.join('\n') : 'no services collected yet';
    }),
);

server.registerTool(
  'atrium_revuto',
  {
    description:
      'Revuto PR-reviewer watch: standalone scheduler, external dependencies, per-repo reviewers, model probes, recent jobs, counts, schedules/limits.',
    inputSchema: {},
    annotations: RO,
  },
  () =>
    guarded(async () => {
      const r = (await snapshot()).revuto;
      const lines: string[] = [];
      if (!r.up)
        lines.push(
          r.updatedAt
            ? `revuto status unavailable — showing last known state (${ago(r.updatedAt)})`
            : 'revuto status unavailable — nothing collected yet',
        );
      if (r.error) lines.push(`error: ${r.error}`);
      if (!r.up && !r.updatedAt) return lines.join('\n');
      if (r.scheduler) {
        lines.push(
          `scheduler: ${r.scheduler.active ? 'active' : 'inactive'}, ${r.scheduler.tasks} cron tasks, ${r.scheduler.repos} reviewers`,
        );
      }
      if (r.dependencies.length) {
        lines.push('dependencies:');
        for (const dep of r.dependencies)
          lines.push(`  ${dep.id} ${dep.activeState}/${dep.subState}${dep.since ? ` since ${dep.since}` : ''}`);
      }
      if (r.reviewers.length) {
        lines.push(`reviewers (${r.reviewers.length}):`);
        for (const rv of r.reviewers.slice(0, 10))
          lines.push(
            `  ${rv.repo}${rv.paused ? ' [paused]' : ''}${rv.autoActivate ? ' (auto-activate)' : ''} — ${rv.reviewSchedule}`,
          );
        if (r.reviewers.length > 10) lines.push(`  … ${r.reviewers.length - 10} more`);
      }
      if (r.models.length) {
        lines.push('models:');
        for (const m of r.models)
          lines.push(
            `  ${m.role}: ${m.name}/${m.model}${m.enabled ? '' : ' (disabled)'} — probe ${m.probe.state}` +
              `${m.probe.ms !== null ? ` ${m.probe.ms}ms` : ''}${m.probe.checkedAt ? ` ${ago(m.probe.checkedAt)}` : ''}` +
              `${m.probe.error ? ` — ${m.probe.error}` : ''}`,
          );
      }
      if (r.jobs.length) {
        lines.push(`jobs (${r.jobs.length} recent):`);
        for (const j of r.jobs.slice(0, 8))
          lines.push(
            `  ${ago(j.timestamp)} ${j.job} ${j.repo} ${j.status}` +
              `${j.durationMs !== null ? ` ${Math.round(j.durationMs / 1000)}s` : ''} — ${j.summary}`,
          );
        if (r.jobs.length > 8) lines.push(`  … ${r.jobs.length - 8} more`);
      }
      if (r.counts) {
        const c = r.counts;
        lines.push(
          `counts: scheduler ${c.schedulerTasks} tasks, deps ${c.dependenciesReady}/${c.dependenciesTotal} ready, reviewers ${c.reviewers} (${c.pausedReviewers} paused), ` +
            `jobs ${c.recentJobs} recent / ${c.recentFailures} failed, reviewed ${c.reviewed} / skipped ${c.skipped}`,
        );
      }
      if (r.schedules)
        lines.push(`schedules: review ${r.schedules.review} | learn ${r.schedules.learn} | decay ${r.schedules.decay}`);
      if (r.limits)
        lines.push(
          `limits: maxSteps ${r.limits.maxSteps}, daily reviews ${r.limits.dailyReviews} / learn ${r.limits.dailyLearn} / tokens ${r.limits.dailyTokens}`,
        );
      return lines.length ? lines.join('\n') : 'no revuto data collected yet';
    }),
);

server.registerTool(
  'atrium_itch',
  {
    description:
      'Itch idea-scout watch: research state, rated-ideas total, recent runs (ratings, collide temp, sampled domains, baselines). Last-good data is kept when the itch UI is down.',
    inputSchema: {},
    annotations: RO,
  },
  () =>
    guarded(async () => {
      const it = (await snapshot()).itch;
      const lines: string[] = [];
      if (!it.up)
        lines.push(
          it.updatedAt
            ? `itch ui unreachable — showing last known state (${ago(it.updatedAt)})`
            : 'itch ui unreachable — nothing collected yet',
        );
      if (it.error) lines.push(`error: ${it.error}`);
      if (!it.up && !it.updatedAt) return lines.join('\n');
      const res = it.research;
      const bits = [res.running ? 'running' : 'idle'];
      if (res.started) bits.push(`started ${ago(res.started)}`);
      if (res.savedStem) bits.push(`saved ${res.savedStem}`);
      if (res.killedReason) bits.push(`killed: ${res.killedReason}`);
      lines.push(`research: ${bits.join(', ')}`);
      lines.push(`rated total: ${it.ratedTotal ?? 'unknown'}`);
      if (it.runs.length) {
        lines.push(`runs (${it.runs.length}, newest first):`);
        for (const run of it.runs.slice(0, 12)) {
          const parts = [`${run.nRated}/${run.nIdeas} rated`];
          if (run.isCollide) parts.push(`collide temp=${run.collisionTemp ?? '?'}`);
          if (run.sampledDomains.length)
            parts.push(
              `domains: ${run.sampledDomains.slice(0, 3).join(', ')}` +
                `${run.sampledDomains.length > 3 ? ` +${run.sampledDomains.length - 3} more` : ''}`,
            );
          if (run.baselineFor) parts.push(`baseline for ${run.baselineFor}`);
          lines.push(`  ${run.stem} — ${parts.join(' — ')}`);
        }
        if (it.runs.length > 12) lines.push(`  … ${it.runs.length - 12} more`);
      } else lines.push('runs: none');
      return lines.join('\n');
    }),
);

server.registerTool(
  'atrium_flags',
  {
    description: 'Current anomaly flags (crit/warn/info), with ids usable for atrium_mute kind=flag.',
    inputSchema: {},
    annotations: RO,
  },
  () =>
    guarded(async () => {
      const flags = unmutedFlags(await snapshot());
      if (!flags.length) return 'no flags';
      return flags
        .map((f) => `[${f.severity}] ${f.title} — ${f.detail} (${f.source}, ${ago(f.raisedAt)}) id=${f.id}`)
        .join('\n');
    }),
);

server.registerTool(
  'atrium_mutes',
  {
    description: 'Active mutes with ids usable for atrium_unmute: kind:target, mode, expiry.',
    inputSchema: {},
    annotations: RO,
  },
  () =>
    guarded(async () => {
      const mutes = activeMutes((await snapshot()).mutes);
      if (!mutes.length) return 'no active mutes';
      return mutes
        .map(
          (m) =>
            `${m.kind}:${m.target} — mode=${m.mode}, until=${m.until ? inOrAgo(m.until) : 'forever'}` +
            `${m.untilActivity ? ', until-activity' : ''} id=${m.id}`,
        )
        .join('\n');
    }),
);

server.registerTool(
  'atrium_mute',
  {
    description:
      'Mute a noise source. Default mode hides/dims in the dashboard only; enforce=true actually pauses the source (revuto repo reviewers, hermes cron jobs, systemd units) when supported.',
    inputSchema: {
      kind: z.enum([
        'github-item',
        'github-repo',
        'github-org',
        'github-reason',
        'agent',
        'agent-resource',
        'schedule',
        'service',
        'flag',
      ]),
      target: z
        .string()
        .describe(
          'per kind: "owner/repo#123" (one issue/PR), "owner/repo", org, notification reason, agent id, "<agentId>:<resourceId>", schedule entry id, systemd unit, flag id',
        ),
      until: z.string().optional().describe('ISO timestamp; omit = forever'),
      enforce: z.boolean().optional().describe('attempt real enforcement at the source'),
    },
    annotations: RW,
  },
  ({ kind, target, until, enforce }) =>
    guarded(async () => {
      const m = await api<Mute>('/api/mutes', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind, target, until: until ?? null, enforce: enforce ?? false }),
      });
      return `muted ${m.kind}:${m.target} — mode=${m.mode}${m.enforcedBy ? ` (enforced by ${m.enforcedBy})` : ''}, until=${m.until ?? 'forever'}, id=${m.id}`;
    }),
);

server.registerTool(
  'atrium_unmute',
  {
    description: 'Remove a mute by id (list ids with atrium_mutes).',
    inputSchema: { id: z.string() },
    annotations: RW,
  },
  ({ id }) =>
    guarded(async () => {
      await api(`/api/mutes/${encodeURIComponent(id)}`, { method: 'DELETE' });
      return `unmuted ${id}`;
    }),
);

server.registerTool(
  'atrium_agent_action',
  {
    description:
      'Run a control action on an agent (pause/resume/stop/start/restart/trigger/review/learn/decay/doctor/kill). Check atrium_agents controls first; target picks a sub-resource (repo for revuto, owner/repo#PR for revuto review, job id for hermes).',
    inputSchema: {
      agent: z.enum(['revuto', 'hermes', 'itch', 'any-mission', 'eigen', 'claude', 'codex', 'training']),
      action: z.string().describe("one of the agent's controls, e.g. pause, resume, stop, start, restart, trigger, review, learn, decay, doctor, kill"),
      target: z.string().optional().describe('sub-resource, e.g. repo, owner/repo#PR, or job id'),
    },
    annotations: { readOnlyHint: false, destructiveHint: true },
  },
  ({ agent, action, target }) =>
    guarded(async () => {
      const r = await api<{ ok: boolean; output?: string }>(
        `/api/agents/${encodeURIComponent(agent)}/${encodeURIComponent(action)}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(target ? { target } : {}),
        },
      );
      return `${agent} ${action}${target ? ` ${target}` : ''}: ${r.ok ? 'ok' : 'failed'}${r.output ? `\n${r.output.slice(0, 800)}` : ''}`;
    }),
);

const transport = new StdioServerTransport();
await server.connect(transport);

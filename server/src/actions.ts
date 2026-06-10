import { stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from './config.js';
import { iso, sh } from './util.js';

const REPO_RE = /^[\w.-]+\/[\w.-]+$/;
const JOB_RE = /^[\w-]+$/;
const RUN_RE = /^run-[\w-]+$/;
const TIMEOUT = { timeoutMs: 15_000 };

interface ActionResult {
  ok: boolean;
  output?: string;
  error?: string;
}

function ok(stdout: string): ActionResult {
  const output = stdout.trim().slice(0, 2000);
  return output ? { ok: true, output } : { ok: true };
}

function fail(error: string): ActionResult {
  return { ok: false, error };
}

export async function runAgentAction(agentId: string, action: string, target?: string): Promise<ActionResult> {
  try {
    switch (agentId) {
      case 'revuto':
        return await revutoAction(action, target);
      case 'hermes':
        return await hermesAction(action, target);
      case 'any-mission':
        return await anyMissionAction(action, target);
      case 'itch':
      case 'claude':
      case 'codex':
      case 'eigen':
      case 'training':
        return fail('not controllable');
      default:
        return fail('unknown action');
    }
  } catch (err) {
    return fail((err instanceof Error ? err.message : String(err)).slice(0, 2000));
  }
}

async function revutoAction(action: string, target?: string): Promise<ActionResult> {
  switch (action) {
    case 'pause':
    case 'resume':
    case 'trigger': {
      if (!target || !REPO_RE.test(target)) return fail('target must be owner/repo');
      return ok(await sh('node', [config.paths.revutoCli, action, target], TIMEOUT));
    }
    case 'stop': {
      // ORDER MATTERS: the guard timer restarts dead units within 5 min — stop it first
      await sh('systemctl', ['--user', 'stop', 'revuto-guard.timer'], TIMEOUT);
      return ok(await sh('systemctl', ['--user', 'stop', 'revuto.service'], TIMEOUT));
    }
    case 'start': {
      await sh('systemctl', ['--user', 'start', 'revuto-guard.timer'], TIMEOUT);
      return ok(await sh('systemctl', ['--user', 'start', 'revuto.service'], TIMEOUT));
    }
    default:
      return fail('unknown action');
  }
}

const HERMES_CRON_VERBS: Record<string, string | undefined> = {
  'cron-pause': 'pause',
  'cron-resume': 'resume',
  'cron-run': 'run',
  // aliases matching the advertised collector controls (hermes.ts) and the MCP tool description
  pause: 'pause',
  resume: 'resume',
  run: 'run',
};

async function hermesAction(action: string, target?: string): Promise<ActionResult> {
  if (action === 'restart' || action === 'stop' || action === 'start') {
    return ok(await sh('systemctl', ['--user', action, 'hermes-gateway.service'], TIMEOUT));
  }
  const verb = HERMES_CRON_VERBS[action];
  if (verb) {
    if (!target || !JOB_RE.test(target)) return fail('target must be a job id');
    return ok(await sh(config.paths.hermesCli, ['cron', verb, target], TIMEOUT));
  }
  return fail('unknown action');
}

async function anyMissionAction(action: string, target?: string): Promise<ActionResult> {
  if (action !== 'kill') return fail('unknown action');
  // pattern check before any path join — runId becomes a filesystem path component
  if (!target || !RUN_RE.test(target)) return fail('target must be a run id (run-...)');
  const runDir = join(config.paths.anyMissionRuns, target);
  try {
    if (!(await stat(runDir)).isDirectory()) return fail('run directory not found');
  } catch {
    return fail('run directory not found');
  }
  await writeFile(join(runDir, 'control.json'), JSON.stringify({ command: 'kill', updatedAt: iso() }), 'utf8');
  return { ok: true, output: `kill requested for ${target}` };
}

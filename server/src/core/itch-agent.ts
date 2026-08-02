import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const ITCH_MODELS = [
  // Automation preference: GPT-5.6 Sol first (stronger + cheaper than Opus 5).
  { id: 'codex:gpt-5.6-sol', label: 'GPT 5.6 Sol (Codex CLI)' },
  { id: 'codex:gpt-5.6-terra', label: 'GPT 5.6 Terra (Codex CLI)' },
  { id: 'codex:gpt-5.5', label: 'GPT 5.5 (Codex CLI, legacy)' },
  { id: 'claude:opus', label: 'Claude Opus 5 (Claude Code) — automation fallback' },
  { id: 'claude:fable', label: 'Claude Fable 5 (Claude Code) — hard work only' },
  { id: 'claude:sonnet', label: 'Claude Sonnet 5 (Claude Code)' },
  { id: 'claude:haiku', label: 'Claude Haiku (Claude Code)' },
  { id: 'glm:glm-5.2[1m]', label: 'GLM 5.2 1M (Claude Code - Z.ai)' },
  { id: 'grok:grok-4.5', label: 'Grok 4.5 (Grok Build CLI)' },
  { id: 'grok:grok-build-0.1', label: 'Grok Build 0.1 (Grok Build CLI)' },
];

/** Itch is automation: Sol primary. Opus is fallback; Fable is not the default. */
export const DEFAULT_ITCH_MODEL = 'codex:gpt-5.6-sol';

type ItchModelBackend = 'codex' | 'claude' | 'glm' | 'grok';

export interface ItchAgentCommand {
  backend: ItchModelBackend;
  bin: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdout: 'codex-json' | 'claude-stream-json' | 'grok-streaming-json';
  /** True when the CLI normally emits progress while the model is still running. */
  streamsProgress: boolean;
}

export function normalizeItchModel(model: string): string {
  const m = model.trim();
  if (!m) return DEFAULT_ITCH_MODEL;

  // Legacy Atrium/Eigen-era ids. Keep prefs and old UI clients from wedging
  // while Eigen is out of the loop.
  if (m === 'openai.gpt-5.6-sol' || m === 'gpt-5.6-sol' || m === 'sol') return 'codex:gpt-5.6-sol';
  if (m === 'openai.gpt-5.6-terra' || m === 'gpt-5.6-terra') return 'codex:gpt-5.6-terra';
  if (m === 'openai.gpt-5.5') return 'codex:gpt-5.5';
  if (m === 'eigen:glm/glm-5.2') return 'glm:glm-5.2[1m]';
  if (/^(us|global|eu|ap)\.anthropic\.claude-sonnet-/i.test(m)) return 'claude:sonnet';
  if (/^(us|global|eu|ap)\.anthropic\.claude-opus-/i.test(m)) return 'claude:opus';
  if (/^(us|global|eu|ap)\.anthropic\.claude-fable-/i.test(m)) return 'claude:fable';
  if (/^(us|global|eu|ap)\.anthropic\.claude-haiku-/i.test(m)) return 'claude:haiku';

  if (/^gpt-/i.test(m)) return `codex:${m}`;
  if (/^claude-/i.test(m) || ['sonnet', 'opus', 'fable', 'haiku'].includes(m)) return `claude:${m}`;
  if (/^glm-/i.test(m)) return `glm:${m}`;
  // Grok Build CLI — freestanding ids and short aliases.
  if (m === 'grok-build' || m === 'build') return 'grok:grok-build-0.1';
  if (m === 'grok-4.5' || m === 'grok4.5') return 'grok:grok-4.5';
  if (/^grok-build/i.test(m) || /^grok-/i.test(m)) return `grok:${m}`;
  return m;
}

export function isSupportedItchModel(model: string): boolean {
  const m = normalizeItchModel(model);
  return ITCH_MODELS.some((spec) => spec.id === m) || /^codex:[^:]+$/.test(m) || /^claude:[^:]+$/.test(m) || /^glm:[^:]+$/.test(m) || /^grok:[^:]+$/.test(m);
}

function splitItchModel(model: string): { backend: ItchModelBackend; model: string } {
  const m = normalizeItchModel(model);
  const idx = m.indexOf(':');
  const backend = idx > 0 ? m.slice(0, idx) : '';
  const rawModel = idx > 0 ? m.slice(idx + 1) : m;
  if (backend === 'codex' || backend === 'claude' || backend === 'glm' || backend === 'grok') return { backend, model: rawModel };
  throw new Error(`unsupported itch model: ${model}`);
}

function hermesEnvVar(name: string): string | null {
  try {
    const text = readFileSync(join(homedir(), '.hermes', '.env'), 'utf8');
    const m = text.match(new RegExp(`^${name}=(.*)$`, 'm'));
    const v = m?.[1]?.trim().replace(/^["']|["']$/g, '') ?? '';
    return v || null;
  } catch {
    return null;
  }
}

function glmEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...base,
    ANTHROPIC_BASE_URL: base.ITCH_GLM_ANTHROPIC_BASE_URL || base.ZAI_ANTHROPIC_BASE_URL || 'https://api.z.ai/api/anthropic',
    API_TIMEOUT_MS: base.API_TIMEOUT_MS || '3000000',
  };
  const token = base.ITCH_GLM_ANTHROPIC_AUTH_TOKEN || base.ZAI_API_KEY || base.Z_AI_API_KEY || base.GLM_API_KEY || hermesEnvVar('GLM_API_KEY') || base.BIGMODEL_API_KEY || base.ANTHROPIC_AUTH_TOKEN;
  if (token) env.ANTHROPIC_AUTH_TOKEN = token;
  return env;
}

function claudeModelName(model: string): string {
  if (model === 'sonnet') return 'claude-sonnet-5';
  if (model === 'opus') return 'claude-opus-5';
  if (model === 'fable') return 'claude-fable-5';
  if (model === 'haiku') return 'claude-haiku-4-5';
  return model;
}

export function buildItchAgentCommand(model: string, cwd: string): ItchAgentCommand {
  const parsed = splitItchModel(model);
  if (parsed.backend === 'codex') {
    return {
      backend: 'codex',
      bin: process.env.ITCH_CODEX || 'codex',
      args: [
        '--search',
        '--model', parsed.model,
        '--dangerously-bypass-approvals-and-sandbox',
        '--cd', cwd,
        'exec',
        '--ephemeral',
        '--skip-git-repo-check',
        '--json',
        '-',
      ],
      cwd,
      env: process.env,
      stdout: 'codex-json',
      streamsProgress: true,
    };
  }
  if (parsed.backend === 'glm') {
    const env = glmEnv(process.env);
    if (parsed.model.includes('[1m]')) env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = env.CLAUDE_CODE_AUTO_COMPACT_WINDOW || '1000000';
    return {
      backend: 'glm',
      bin: process.env.ITCH_CLAUDE || 'claude',
      args: [
        '--safe-mode',
        '-p',
        '--model', parsed.model,
        '--effort', process.env.ITCH_GLM_EFFORT || 'max',
        '--permission-mode', 'bypassPermissions',
        '--no-session-persistence',
        '--output-format', 'stream-json',
        '--verbose',
        '--include-partial-messages',
      ],
      cwd,
      env,
      stdout: 'claude-stream-json',
      streamsProgress: true,
    };
  }
  if (parsed.backend === 'grok') {
    // Grok Build CLI (`grok`). Prompt is injected at spawn via --prompt-file
    // (see runItchAgentOnce) so long itch research prompts don't hit ARG_MAX.
    return {
      backend: 'grok',
      bin: process.env.ITCH_GROK || 'grok',
      args: [
        '--no-auto-update',
        '--always-approve',
        '--cwd', cwd,
        '--model', parsed.model,
        '--output-format', 'streaming-json',
        '--prompt-file', 'prompt.md',
      ],
      cwd,
      env: process.env,
      stdout: 'grok-streaming-json',
      streamsProgress: true,
    };
  }
  return {
    backend: 'claude',
    bin: process.env.ITCH_CLAUDE || 'claude',
    args: [
      '--safe-mode',
      '-p',
      '--model', claudeModelName(parsed.model),
      '--permission-mode', 'bypassPermissions',
      '--no-session-persistence',
      '--output-format', 'stream-json',
      '--verbose',
      '--include-partial-messages',
    ],
    cwd,
    env: process.env,
    stdout: 'claude-stream-json',
    streamsProgress: true,
  };
}

export function formatItchAgentCommand(cmd: ItchAgentCommand): string {
  const args = cmd.args.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ');
  return `${cmd.bin} ${args}`;
}

function killProcessGroup(proc: ChildProcess): void {
  if (!proc.pid) return;
  try { process.kill(-proc.pid, 'SIGTERM'); }
  catch { try { proc.kill('SIGTERM'); } catch { /* ignore */ } }
}

export function parseItchAgentStdoutLine(command: ItchAgentCommand, line: string): { delta?: string; final?: string } {
  let obj: any;
  try {
    obj = JSON.parse(line);
  } catch {
    return {};
  }
  if (command.stdout === 'codex-json') {
    const item = obj?.item;
    if (obj?.type === 'item.completed' && item?.type === 'agent_message' && typeof item.text === 'string') {
      return { final: item.text };
    }
    return {};
  }
  if (command.stdout === 'claude-stream-json') {
    const event = obj?.event;
    const delta = event?.type === 'content_block_delta' ? event.delta : null;
    if (delta?.type === 'text_delta' && typeof delta.text === 'string') return { delta: delta.text };
    if (obj?.type === 'result' && typeof obj.result === 'string') return { final: obj.result };
    return {};
  }
  if (command.stdout === 'grok-streaming-json') {
    // NDJSON: {type:"text"|"thought", data:"..."} then {type:"end", ...}
    // Also accept the one-shot json envelope {text:"..."} if a line looks like it.
    if (obj?.type === 'text' && typeof obj.data === 'string') return { delta: obj.data };
    if (typeof obj?.text === 'string' && (obj.stopReason || obj.sessionId)) return { final: obj.text };
    return {};
  }
  return {};
}

export async function runItchAgentOnce(prompt: string, model: string, cwd: string, timeoutMs: number): Promise<string> {
  const command = buildItchAgentCommand(model, cwd);
  try {
    if (command.backend === 'grok') {
      const { writeFileSync, mkdirSync } = await import('node:fs');
      mkdirSync(cwd, { recursive: true });
      writeFileSync(join(cwd, 'prompt.md'), prompt, 'utf8');
    }
    const { stdout } = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(command.bin, command.args, {
        env: command.env,
        cwd: command.cwd,
        detached: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const rawStdoutChunks: string[] = [];
      const deltaChunks: string[] = [];
      const stderrChunks: string[] = [];
      let finalText = '';
      let stdoutBuf = '';
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        killProcessGroup(child);
        reject(new Error(`${formatItchAgentCommand(command)} timed out after ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs);
      timer.unref?.();

      child.stdout?.setEncoding('utf8');
      child.stderr?.setEncoding('utf8');
      child.stdout?.on('data', (d: string) => {
        rawStdoutChunks.push(d);
        stdoutBuf += d;
        let nl: number;
        while ((nl = stdoutBuf.indexOf('\n')) >= 0) {
          const line = stdoutBuf.slice(0, nl).trim();
          stdoutBuf = stdoutBuf.slice(nl + 1);
          if (!line) continue;
          const parsed = parseItchAgentStdoutLine(command, line);
          if (parsed.delta) deltaChunks.push(parsed.delta);
          if (parsed.final) finalText = parsed.final;
        }
      });
      child.stderr?.on('data', (d: string) => stderrChunks.push(d));
      child.on('error', (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      });
      child.on('close', (code, signal) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (stdoutBuf.trim()) {
          const parsed = parseItchAgentStdoutLine(command, stdoutBuf.trim());
          if (parsed.delta) deltaChunks.push(parsed.delta);
          if (parsed.final) finalText = parsed.final;
        }
        const stdout = deltaChunks.length ? deltaChunks.join('') : finalText || rawStdoutChunks.join('');
        const stderr = stderrChunks.join('');
        if (code === 0) resolve({ stdout, stderr });
        else reject(new Error(`${formatItchAgentCommand(command)} exited ${code ?? signal ?? 1}${stderr ? ` — ${stderr.slice(0, 1200)}` : ''}`));
      });
      child.stdin?.end(prompt);
    });
    return stdout.trim();
  } finally {
    await rm(cwd, { recursive: true, force: true }).catch(() => {});
  }
}

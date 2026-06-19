import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from '../config.js';
import {
  loadItchModels,
  loadItchResource,
  loadItchRunDetail,
  saveItchFilters,
  saveItchScope,
} from './itch.js';

const TIMEOUT_MS = 660_000;
let busy = false;

type AiResult = { status: number; body: Record<string, unknown> };

function providerModel(model: string): { provider?: string; model: string } {
  if (model.startsWith('eigen:')) {
    const rest = model.slice('eigen:'.length);
    const idx = rest.indexOf('/');
    return idx >= 0 ? { provider: rest.slice(0, idx), model: rest.slice(idx + 1) } : { model: rest };
  }
  if (model.startsWith('pi:')) {
    const rest = model.slice('pi:'.length);
    const idx = rest.indexOf('/');
    return { provider: 'llama', model: idx >= 0 ? rest.slice(idx + 1) : rest };
  }
  if (/^(us|global|eu|ap)\.anthropic\./.test(model)) return { provider: 'converse', model };
  return { model };
}

async function selectedModel(body: any): Promise<string> {
  if (typeof body?.model === 'string' && body.model.trim()) return body.model.trim();
  return (await loadItchModels(config.paths)).selected;
}

async function eigen(prompt: string, model: string): Promise<string> {
  // Sandbox: run eigen with cwd = a throwaway temp dir. In 'auto' posture eigen
  // confines write/edit/bash to the session root, so a one-shot whose prompt
  // embeds model-authored web text (a prompt-injection carrier) can never write
  // into a real repo — it lands harmlessly in this temp dir, which we delete.
  // Web tools (websearch/fetch) still work, matching the Python read-only-FS
  // posture's intent (grounding allowed, no escape).
  const dir = await mkdtemp(join(tmpdir(), 'atrium-itch-ai-'));
  const promptFile = join(dir, 'prompt.md');
  await writeFile(promptFile, prompt, 'utf8');
  const pm = providerModel(model);
  const args = ['-p', '-perm', 'auto', '-prompt-file', promptFile];
  if (pm.provider) args.push('-provider', pm.provider);
  if (pm.model) args.push('-model', pm.model);
  try {
    const { stdout } = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      execFile('eigen', args, { timeout: TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024, cwd: dir, env: process.env }, (err, stdout, stderr) => {
        if (err) reject(new Error(`${err.message}${stderr ? ` — ${String(stderr).slice(0, 800)}` : ''}`));
        else resolve({ stdout: String(stdout), stderr: String(stderr) });
      });
    });
    return stdout.trim();
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

function ideaPrompt(kind: string, title: string, body: string, extra = ''): string {
  return `You are Atrium's itch idea-scout assistant. Answer in concise markdown.\n\nIdea: ${title}\n\nIdea body:\n${body || '[none]'}\n\nTask: ${kind}\n${extra}`;
}

function extractJson(text: string): any {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const raw = fenced ?? text;
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('model did not return JSON');
  return JSON.parse(raw.slice(start, end + 1));
}

async function withBusy(fn: () => Promise<AiResult>): Promise<AiResult> {
  if (busy) return { status: 409, body: { error: 'another AI action is already running' } };
  busy = true;
  try {
    return await fn();
  } catch (err) {
    return { status: 500, body: { error: err instanceof Error ? err.message : String(err) } };
  } finally {
    busy = false;
  }
}

export async function handleItchAi(rest: string, body: any): Promise<AiResult | null> {
  return withBusy(async () => {
    const model = await selectedModel(body);
    if (rest === 'ask') {
      const title = String(body?.title ?? '').trim();
      const question = String(body?.question ?? '').trim();
      if (!title || !question) return { status: 400, body: { error: 'missing title/question' } };
      const answer = await eigen(ideaPrompt(`Answer this question: ${question}`, title, String(body?.body ?? '')), model);
      return { status: 200, body: { answer } };
    }
    if (rest === 'roadmap') {
      const title = String(body?.title ?? '').trim();
      if (!title) return { status: 400, body: { error: 'missing title' } };
      const roadmap = await eigen(ideaPrompt('Write a practical build roadmap with milestones, risks, and first-week steps.', title, String(body?.body ?? '')), model);
      return { status: 200, body: { roadmap } };
    }
    if (rest === 'validate') {
      const title = String(body?.title ?? '').trim();
      if (!title) return { status: 400, body: { error: 'missing title' } };
      const markdown = await eigen(`Validate this project idea for fit, demand, risk, and first proof.\n\nTitle: ${title}\n\nDescription:\n${String(body?.description ?? '')}`, model);
      return { status: 200, body: { markdown } };
    }
    if (rest === 'contrib') {
      const interests = String(body?.interests ?? '') || await loadItchResource(config.paths, 'interests');
      const markdown = await eigen(`Find open-source contribution targets matching these interests. Return concise ranked markdown with repo/search rationale.\n\nInterests:\n${interests}`, model);
      return { status: 200, body: { markdown } };
    }
    if (rest === 'agent') {
      const instruction = String(body?.instruction ?? '').trim();
      if (!instruction) return { status: 400, body: { error: 'missing instruction' } };
      const text = await eigen(`Turn this feed-filter instruction into JSON only with keys: interpretation, hide_titles, hide_terms, boost_terms, rule_text, explanation.\nInstruction: ${instruction}`, model);
      const plan = extractJson(text);
      const out = { ...plan, instruction, model, ts: new Date().toISOString() };
      await saveItchFilters(config.paths, out);
      return { status: 200, body: out };
    }
    const howto = rest.match(/^run\/([^/]+)\/howto$/);
    if (howto) {
      const idx = Number(body?.idx);
      const run = await loadItchRunDetail(config.paths, decodeURIComponent(howto[1]));
      const idea = run?.ideas?.[idx];
      if (!idea) return { status: 404, body: { error: 'idea not found' } };
      const spec = await eigen(ideaPrompt('Write an implementation spec / how-to for building iteration 1.', idea.title, idea.body), model);
      return { status: 200, body: { spec, title: idea.title } };
    }
    const scope = rest.match(/^run\/([^/]+)\/scope$/);
    if (scope) {
      const title = String(body?.title ?? '').trim();
      const stem = decodeURIComponent(scope[1]);
      const run = await loadItchRunDetail(config.paths, stem);
      const idea = run?.ideas?.find((it: any) => String(it.title).toLowerCase() === title.toLowerCase());
      if (!idea) return { status: 404, body: { error: 'idea not found' } };
      const scopeMd = await eigen(ideaPrompt('Scope iteration 1: MVP cut, first milestone, repo skeleton, risks, definition of done.', idea.title, idea.body), model);
      const saved = await saveItchScope(config.paths, stem, idea.title, `# ${idea.title}\n\n${scopeMd}`);
      return { status: 200, body: { scope: scopeMd, saved } };
    }
    return null as any;
  });
}

import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from '../config.js';
import { normalizeItchModel, runItchAgentOnce } from './itch-agent.js';
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

async function selectedModel(body: any): Promise<string> {
  if (typeof body?.model === 'string' && body.model.trim()) return normalizeItchModel(body.model);
  return (await loadItchModels(config.paths)).selected;
}

async function runModel(prompt: string, model: string): Promise<string> {
  // Run the coding-agent CLI from a throwaway root so any tool use lands outside
  // real repos. The selected wrapper owns CLI-specific permission and streaming
  // flags.
  const dir = await mkdtemp(join(tmpdir(), 'atrium-itch-ai-'));
  return runItchAgentOnce(prompt, model, dir, TIMEOUT_MS);
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
      const answer = await runModel(ideaPrompt(`Answer this question: ${question}`, title, String(body?.body ?? '')), model);
      return { status: 200, body: { answer } };
    }
    if (rest === 'roadmap') {
      const title = String(body?.title ?? '').trim();
      if (!title) return { status: 400, body: { error: 'missing title' } };
      const roadmap = await runModel(ideaPrompt('Write a practical build roadmap with milestones, risks, and first-week steps.', title, String(body?.body ?? '')), model);
      return { status: 200, body: { roadmap } };
    }
    if (rest === 'validate') {
      const title = String(body?.title ?? '').trim();
      if (!title) return { status: 400, body: { error: 'missing title' } };
      const markdown = await runModel(`Validate this project idea for fit, demand, risk, and first proof.\n\nTitle: ${title}\n\nDescription:\n${String(body?.description ?? '')}`, model);
      return { status: 200, body: { markdown } };
    }
    if (rest === 'contrib') {
      const interests = String(body?.interests ?? '') || await loadItchResource(config.paths, 'interests');
      const markdown = await runModel(`Find open-source contribution targets matching these interests. Return concise ranked markdown with repo/search rationale.\n\nInterests:\n${interests}`, model);
      return { status: 200, body: { markdown } };
    }
    if (rest === 'agent') {
      const instruction = String(body?.instruction ?? '').trim();
      if (!instruction) return { status: 400, body: { error: 'missing instruction' } };
      const text = await runModel(`Turn this feed-filter instruction into JSON only with keys: interpretation, hide_titles, hide_terms, boost_terms, rule_text, explanation.\nInstruction: ${instruction}`, model);
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
      const spec = await runModel(ideaPrompt('Write an implementation spec / how-to for building iteration 1.', idea.title, idea.body), model);
      return { status: 200, body: { spec, title: idea.title } };
    }
    const scope = rest.match(/^run\/([^/]+)\/scope$/);
    if (scope) {
      const title = String(body?.title ?? '').trim();
      const stem = decodeURIComponent(scope[1]);
      const run = await loadItchRunDetail(config.paths, stem);
      const idea = run?.ideas?.find((it: any) => String(it.title).toLowerCase() === title.toLowerCase());
      if (!idea) return { status: 404, body: { error: 'idea not found' } };
      const scopeMd = await runModel(ideaPrompt('Scope iteration 1: MVP cut, first milestone, repo skeleton, risks, definition of done.', idea.title, idea.body), model);
      const saved = await saveItchScope(config.paths, stem, idea.title, `# ${idea.title}\n\n${scopeMd}`);
      return { status: 200, body: { scope: scopeMd, saved } };
    }
    return null as any;
  });
}

/**
 * In-process bridge to the vendored revuto engine (@atrium/revuto-engine).
 * Atrium calls the engine functions directly — no `revuto` CLI / daemon spawn.
 * The engine's review/learn/decay run inside the Atrium process.
 */
import { loadConfig } from '@atrium/revuto-engine/config';
import {
  decayRepo,
  learnRepo,
  reviewOnePr,
  reviewRepo,
} from '@atrium/revuto-engine/jobs';
import { readReviewer } from '@atrium/revuto-engine/reviewers';
import { runDoctor } from '@atrium/revuto-engine/doctor';

export interface RevutoRepoAction {
  ok: boolean;
  output?: string;
  error?: string;
}

function summarize(obj: unknown): string {
  if (obj && typeof obj === 'object') {
    try { return JSON.stringify(obj); } catch { /* ignore */ }
  }
  return String(obj ?? '');
}


/** reviewRepo/learnRepo/decayRepo in-process. */
export async function runRevutoRepoJob(job: 'review' | 'learn' | 'decay', repo: string): Promise<RevutoRepoAction> {
  try {
    const cfg = loadConfig();
    if (job === 'review') {
      const settings = readReviewer(cfg, repo) ?? { repo };
      const out = await reviewRepo(cfg, settings as any, { force: false });
      return { ok: true, output: summarize(out) };
    }
    if (job === 'learn') {
      const settings = readReviewer(cfg, repo) ?? { repo };
      const out = await learnRepo(cfg, settings as any);
      return { ok: true, output: summarize(out) };
    }
    const out = await decayRepo(cfg, repo);
    return { ok: true, output: summarize(out) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Review a single PR in-process (revuto review <repo> <pr>). */
export async function runRevutoReviewPr(repo: string, pr: number): Promise<RevutoRepoAction> {
  try {
    const cfg = loadConfig();
    const out = await reviewOnePr(cfg, repo, pr);
    return { ok: true, output: summarize(out) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function runRevutoDoctor(): Promise<RevutoRepoAction> {
  try {
    const report = await runDoctor(loadConfig());
    return { ok: true, output: summarize(report) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}





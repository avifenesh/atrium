import { createHash } from 'node:crypto';
import type { ReentryEvidence } from './reentry.js';

/** Hash only observed inputs. Capsules and scan bookkeeping are outputs from the
 *  previous run and must not make an unchanged workspace look newly changed. */
export function evidenceHash(evidence: ReentryEvidence): string {
  const stable = {
    ...evidence,
    capturedAt: undefined,
    sources: Object.fromEntries(
      Object.entries(evidence.sources).map(([name, source]) => [name, { ...source, updatedAt: undefined }]),
    ),
    contexts: evidence.contexts.map(({ capsule: _capsule, updatedAt: _updated, ...rest }) => rest),
    agentSessions: evidence.agentSessions.map(({ updatedAt: _updated, ...session }) => session),
  };
  return createHash('sha256').update(canonicalJson(stable)).digest('hex');
}

export function pendingEvidenceSources(evidence: ReentryEvidence): string[] {
  return Object.entries(evidence.sources)
    .filter(([, source]) => source.enabled && !source.updatedAt && !source.error)
    .map(([name]) => name);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .filter((key) => object[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function providerOf(model: string): string {
  return model.split('/')[0] || model;
}

export function isRateLimitError(message: string): boolean {
  return /too many requests|\b429\b|rate.?limit/i.test(message);
}

function stringifyError(value: unknown): string | null {
  if (typeof value === 'string') {
    const text = value.replace(/[\r\n]+/g, ' ').trim();
    return text ? text.slice(0, 400) : null;
  }
  if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    for (const key of ['message', 'error', 'data']) {
      const inner = stringifyError(object[key]);
      if (inner) return inner;
    }
  }
  return null;
}

export function parseGrokOutput(output: string): { text: string; sessionIds: string[]; error: string | null } {
  const trimmed = output.trim();
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      const object = JSON.parse(trimmed.slice(start, end + 1)) as Record<string, unknown>;
      const sessionId = typeof object.sessionId === 'string' ? object.sessionId : null;
      const error = stringifyError(object.error);
      if (object.structuredOutput && typeof object.structuredOutput === 'object') {
        return {
          text: JSON.stringify(object.structuredOutput),
          sessionIds: sessionId ? [sessionId] : [],
          error,
        };
      }
      if (typeof object.text === 'string') {
        return { text: object.text.trim(), sessionIds: sessionId ? [sessionId] : [], error };
      }
      if (typeof object.headline === 'string') {
        return { text: JSON.stringify(object), sessionIds: sessionId ? [sessionId] : [], error };
      }
      if (error) return { text: '', sessionIds: sessionId ? [sessionId] : [], error };
    } catch {
      /* fall through to raw text */
    }
  }
  if (isRateLimitError(trimmed) || /unauthorized|forbidden|AI_APICallError/i.test(trimmed)) {
    return { text: '', sessionIds: [], error: trimmed.replace(/[\r\n]+/g, ' ').slice(0, 400) };
  }
  return { text: trimmed, sessionIds: [], error: null };
}

export function parseAgentJson(text: string): Record<string, unknown> {
  const unfenced = text.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
  const start = unfenced.indexOf('{');
  const end = unfenced.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('model returned no JSON object');
  const parsed = JSON.parse(unfenced.slice(start, end + 1)) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('model result must be a JSON object');
  const object = parsed as Record<string, unknown>;
  if (typeof object.headline !== 'string' || !object.headline.trim()) throw new Error('model result has no headline');
  if (typeof object.summary !== 'string' || !object.summary.trim()) throw new Error('model result has no summary');
  if (!Array.isArray(object.focus) || !Array.isArray(object.looseEnds) || !Array.isArray(object.contexts)) {
    throw new Error('model result is missing required arrays');
  }
  return object;
}

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

function contradictsEvidenceCounts(text: string, evidence: ReentryEvidence): boolean {
  return (
    (evidence.actNow.length > 0 && /\b(?:no|zero)\s+act[\s-]*now(?:\s+items?)?\b/i.test(text))
    || (evidence.peopleWaiting.length > 0 && /\b(?:no|zero)\s+(?:people|persons?|humans?)(?:\s+(?:are|is))?\s+waiting\b/i.test(text))
    || (evidence.contexts.length > 0 && /\b(?:no|zero)\s+(?:(?:open|parked|active)\s+)?contexts?\b/i.test(text))
  );
}

/** Keep model-written prioritization, but make queue counts deterministic and
 *  remove any sentence that directly contradicts a non-empty evidence array. */
export function groundAgentResult(
  result: Record<string, unknown>,
  evidence: ReentryEvidence,
): Record<string, unknown> {
  const github = evidence.sources.github;
  const githubSummary = github.updatedAt
    ? [
        plural(evidence.peopleWaiting.length, 'person explicitly waiting', 'people explicitly waiting'),
        plural(evidence.actNow.length, 'act-now item'),
      ].join('; ')
    : github.enabled
      ? 'GitHub attention source unavailable'
      : 'GitHub attention source disabled';
  const countSummary = `${plural(evidence.contexts.length, 'open Re-entry context')}; ${githubSummary}`;
  const modelSummary = String(result.summary ?? '')
    .split(/(?<=[.!?])\s+/)
    .filter((sentence) => sentence && !contradictsEvidenceCounts(sentence, evidence))
    .join(' ');
  const modelHeadline = String(result.headline ?? '').trim();
  return {
    ...result,
    headline: contradictsEvidenceCounts(modelHeadline, evidence)
      ? `${plural(evidence.contexts.length, 'Re-entry context')} · ${plural(evidence.actNow.length, 'act-now item')}`
      : modelHeadline,
    summary: modelSummary ? `${countSummary}. ${modelSummary}` : `${countSummary}.`,
  };
}

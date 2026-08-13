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

export function parseOpenCodeOutput(output: string): { text: string; sessionIds: string[] } {
  const parts: string[] = [];
  const sessions = new Set<string>();
  for (const line of output.split('\n')) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as Record<string, unknown>;
      const sessionId = typeof event.sessionID === 'string' ? event.sessionID : null;
      if (sessionId) sessions.add(sessionId);
      const part = event.part && typeof event.part === 'object' ? (event.part as Record<string, unknown>) : null;
      if (part && typeof part.sessionID === 'string') sessions.add(part.sessionID);
      if (event.type === 'text' && part?.type === 'text' && typeof part.text === 'string') parts.push(part.text);
    } catch {
      // OpenCode may print a one-line diagnostic around the JSON event stream.
    }
  }
  return { text: parts.join('').trim(), sessionIds: [...sessions] };
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

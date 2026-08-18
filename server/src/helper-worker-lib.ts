import { createHash } from 'node:crypto';
import { config } from './config.js';
import type { HelperEvidence } from './helper.js';

export function canonicalJson(value: unknown): string {
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

export function helperEvidenceHash(evidence: HelperEvidence): string {
  const stable = {
    ...evidence,
    capturedAt: undefined,
    sources: evidence.sources.map((source) => ({ ...source, updatedAt: undefined })),
    sessions: evidence.sessions.map((session) => ({ ...session, updatedAt: undefined })),
  };
  return createHash('sha256').update(canonicalJson(stable)).digest('hex');
}

export function offerFingerprint(value: {
  key: string;
  path: string | null;
  evidence: { source: string; id: string; detail: string }[];
}): string {
  const stable = {
    key: value.key.trim().toLowerCase(),
    path: value.path,
    evidence: value.evidence
      .map(({ source, id, detail }) => ({ source, id, detail }))
      .sort((a, b) => `${a.source}:${a.id}`.localeCompare(`${b.source}:${b.id}`)),
  };
  return createHash('sha256').update(canonicalJson(stable)).digest('hex');
}

export function hasIndependentOfferEvidence(evidence: { source: string }[]): boolean {
  return evidence.some((item) => item.source.trim().toLowerCase() !== 'workspace');
}

function parseJsonObject(text: string): Record<string, unknown> {
  const unfenced = text.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
  const start = unfenced.indexOf('{');
  const end = unfenced.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('Opus returned no JSON object');
  const value = JSON.parse(unfenced.slice(start, end + 1)) as unknown;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Opus result must be a JSON object');
  }
  return value as Record<string, unknown>;
}

/** Claude Code --output-format json wraps structured output differently across
 *  releases. Accept both current spellings plus a plain object for fixtures. */
export function parseClaudeStructuredOutput(stdout: string): Record<string, unknown> {
  const outer = parseJsonObject(stdout);
  const structured = outer.structured_output ?? outer.structuredOutput;
  if (structured && typeof structured === 'object' && !Array.isArray(structured)) {
    return structured as Record<string, unknown>;
  }
  if (typeof outer.result === 'string') return parseJsonObject(outer.result);
  return outer;
}

export function parseHelperAgentOutput(stdout: string): Record<string, unknown> {
  const outer = parseClaudeStructuredOutput(stdout);
  if (Array.isArray(outer.offers)) return outer;
  throw new Error('Opus result did not contain structured offers');
}

export function normalizeHelperInterval(value: unknown): number {
  const interval = Number(value);
  if (!Number.isFinite(interval)) throw new Error('intervalMs must be a number');
  const rounded = Math.round(interval / 1_000) * 1_000;
  if (rounded < config.helper.minIntervalMs || rounded > config.helper.maxIntervalMs) {
    throw new Error('scan interval must be between 10 minutes and 1 week');
  }
  return rounded;
}

export function systemdInterval(intervalMs: number): string {
  const seconds = Math.round(normalizeHelperInterval(intervalMs) / 1_000);
  return `${seconds}s`;
}

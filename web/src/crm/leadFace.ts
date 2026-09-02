// How a lead reads on the desk: who, what they sell, whether they fit.
// Tweet text is evidence, not the headline.

import type { CrmItem } from '../../../shared/types';

const CODING =
  /\b(?:claude ?code|claudecode|cursor|copilot|cline|aider|opencode|codex|openhands|coderabbit|coding(?: agent)?|codebase|pair program|for coding)\b/i;
const PRODUCT_JOB =
  /\b(?:legal|lawyer|attorneys?|contract review|document intake|call notes?|transcript|summar(?:y|ies|ize|isation)|ticket(?:s|ing)?|classif(?:y|ication)|extract(?:ion)?|kyc|onboarding packet|claims? processing|sdr|hosted sdr)\b/i;
const SELLS =
  /\b(?:our (?:product|app|platform|customers|clients) (?:use|uses|using|run|pay)|we sell|our users (?:pay|buy|run))\b/i;

function blob(item: CrmItem): string {
  return [item.title, item.subtitle, item.detail, ...(item.relevance?.labels ?? [])].filter(Boolean).join(' ');
}

/** Vendor of a non-SOTA API product. Coding-agent spend is never this. */
export function isOpportunity(item: CrmItem): boolean {
  const text = blob(item);
  if (CODING.test(text)) return false;
  if (PRODUCT_JOB.test(text) || SELLS.test(text)) return true;
  const productName = item.title.match(/\b([A-Z][A-Za-z0-9]*(?:[A-Z][A-Za-z0-9]+)+)\b/);
  return Boolean(productName && /\b(?:workflow|operations|users|customers|clients|product)\b/i.test(text));
}

export function leadHandle(item: CrmItem): string | null {
  const x = item.url?.match(/x\.com\/([^/]+)\/status/i);
  if (x && x[1] && x[1].toLowerCase() !== 'i') return `@${x[1]}`;
  const at = item.title.match(/(?<![A-Za-z0-9_])@([A-Za-z0-9_]{2,})/);
  return at ? `@${at[1]}` : null;
}

export function leadCompany(item: CrmItem): string | null {
  const fromAction = item.action?.label.match(/\(([^)]+)\)/);
  if (fromAction?.[1] && !/draft|email|thread/i.test(fromAction[1])) return fromAction[1].trim();
  const camel = item.title.match(/\b([A-Z][A-Za-z0-9]*(?:[A-Z][A-Za-z0-9]+)+)\b/);
  if (camel) return camel[1];
  if (item.subtitle && item.subtitle !== 'production' && !item.subtitle.startsWith('own card') && !item.subtitle.startsWith('buyer hunt')) {
    return item.subtitle;
  }
  return null;
}

export function leadJob(item: CrmItem): string | null {
  const text = blob(item);
  const hit = text.match(PRODUCT_JOB);
  if (hit) return hit[0];
  if (SELLS.test(text)) return 'hosted API product';
  return null;
}

export function leadFit(item: CrmItem): string {
  if (isOpportunity(item)) return 'Fits: they sell a product that calls a hosted API. Not a coding seat.';
  return 'Comment the link. Not a product-vendor conversion.';
}

/** Who · company · job. Falls back to a short title if we cannot name them. */
export function leadHeadline(item: CrmItem): string {
  const parts = [leadHandle(item), leadCompany(item), leadJob(item)].filter(Boolean);
  return parts.length ? parts.join(' · ') : item.title.replace(/\s+/g, ' ').slice(0, 88);
}

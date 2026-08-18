// distribution — where tiyuvta is (and is not) listed.
//
// The thesis: inference users come from pickers — OpenRouter's model page, LiteLLM's
// provider table, Artificial Analysis charts, coding-tool provider dropdowns — not from
// comment threads. This collector makes that pipeline a first-class panel instead of a
// set of facts living in one person's head.
//
// Live facts are probed (GitHub PR state, AA listing). Facts only a human knows —
// the OpenRouter application status, which coding tool is next — live in
// ~/.config/atrium/distribution.json and are merged in, so updating the board is a
// one-line file edit, not a code change.

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { store } from '../state.js';
import { iso } from '../util.js';
import type { ExtraRow, Flag } from '../../../shared/types.js';
import type { Collector } from './registry.js';

interface ManualChannel {
  label: string;
  status: string; // free text: 'applied 2026-08-18', 'blocked: stepfun bringup', ...
  tone?: 'ok' | 'warn' | 'err';
  href?: string;
}
interface ManualState {
  channels?: ManualChannel[];
}

const MANUAL_PATH = join(homedir(), '.config', 'atrium', 'distribution.json');

// PRs that put tiyuvta into a picker. Closed-unmerged is an error tone on purpose:
// a dead PR is a lost channel until someone reopens it.
const TRACKED_PRS = [
  { repo: 'BerriAI/litellm', number: 37160, label: 'LiteLLM provider PR' },
];

async function prState(repo: string, number: number): Promise<{ state: string; merged: boolean } | null> {
  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/pulls/${number}`, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'atrium-distribution' },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { state: string; merged: boolean };
    return { state: body.state, merged: body.merged };
  } catch {
    return null;
  }
}

// Listed on Artificial Analysis = the provider name appears on their Qwen3.8-27B
// providers page. Rendered client-side these days, so absence of the marker in HTML is
// reported as unknown rather than a confident 'not listed'.
async function aaListed(): Promise<'listed' | 'not-listed' | 'unknown'> {
  try {
    const res = await fetch('https://artificialanalysis.ai/models/qwen3-8-27b/providers', {
      headers: { 'user-agent': 'atrium-distribution' },
      redirect: 'follow',
    });
    if (!res.ok) return 'unknown';
    const html = await res.text();
    if (/tiyuvta/i.test(html)) return 'listed';
    // page exists and names other providers but not us — that is a real 'no'
    if (/openrouter|chutes|akash/i.test(html)) return 'not-listed';
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

const collector: Collector = {
  name: 'distribution',
  intervalMs: 30 * 60_000,

  async run() {
    const rows: ExtraRow[] = [];
    const flags: Flag[] = [];
    const now = iso();

    // live: tracked PRs
    for (const pr of TRACKED_PRS) {
      const s = await prState(pr.repo, pr.number);
      const value =
        s === null ? 'unreadable' : s.merged ? 'merged' : s.state === 'open' ? 'open' : 'closed unmerged';
      rows.push({
        label: pr.label,
        value: `${pr.repo}#${pr.number} · ${value}`,
        href: `https://github.com/${pr.repo}/pull/${pr.number}`,
        tone: s?.merged ? 'ok' : s?.state === 'open' ? undefined : s === null ? 'warn' : 'err',
      });
      if (s && !s.merged && s.state !== 'open') {
        flags.push({
          id: `distribution:pr-closed:${pr.repo}#${pr.number}`,
          severity: 'warn',
          title: `${pr.label} closed without merging`,
          detail: 'a picker listing died. Reopen or rework it — this is a distribution channel, not a nice-to-have.',
          source: 'distribution',
          raisedAt: now,
        });
      }
    }

    // live: AA listing
    const aa = await aaListed();
    rows.push({
      label: 'Artificial Analysis',
      value: aa === 'listed' ? 'listed on Qwen3.8-27B' : aa === 'not-listed' ? 'not listed — bench email sent 2026-08-18' : 'page unreadable from here',
      href: 'https://artificialanalysis.ai/models',
      tone: aa === 'listed' ? 'ok' : aa === 'not-listed' ? 'warn' : undefined,
    });

    // manual: channels only a human can update
    try {
      const manual = JSON.parse(await readFile(MANUAL_PATH, 'utf8')) as ManualState;
      for (const ch of manual.channels ?? []) {
        rows.push({ label: ch.label, value: ch.status, tone: ch.tone, href: ch.href });
      }
    } catch {
      rows.push({ label: 'manual channels', value: `none — create ${MANUAL_PATH}`, tone: 'warn' });
    }

    store.setExtra('distribution', {
      title: 'distribution',
      updatedAt: now,
      up: true,
      rows,
      error: null,
      data: null,
    });
    store.setFlags('distribution', flags);
  },
};

export default collector;

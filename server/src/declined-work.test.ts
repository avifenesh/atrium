import test from 'node:test';
import assert from 'node:assert/strict';
import type { GithubItem, HelperOffer, HelperPreference } from '../../shared/types.js';
import { reentry } from './reentry.js';
import { emptySnapshot, store } from './state.js';

const STAMP = '2026-08-18T00:00:00.000Z';

function issue(id: string, title: string): GithubItem {
  const [repo, number] = id.split('#');
  return {
    id,
    repo,
    number: Number(number),
    title,
    url: `https://github.com/${repo}/issues/${number}`,
    updatedAt: STAMP,
    kind: 'issue',
    author: null,
    bot: false,
  };
}

function declinedOffer(
  id: string,
  key: string,
  title: string,
  evidenceIds: string[],
  feedback: string,
): HelperOffer {
  return {
    id,
    key,
    title,
    summary: 'Summary of the refused work.',
    whyNow: 'It was one of the few actionable GitHub signals.',
    outcome: 'A verified result.',
    size: 'small',
    confidence: 0.55,
    path: null,
    evidence: evidenceIds.map((evidenceId) => ({
      source: 'github',
      id: evidenceId,
      label: 'Act-now item',
      detail: 'Listed in GitHub actNow.',
      href: `https://github.com/${evidenceId.split('#')[0]}/issues/${evidenceId.split('#')[1]}`,
    })),
    prompt: 'x'.repeat(200),
    status: 'declined',
    createdAt: STAMP,
    updatedAt: STAMP,
    snoozedUntil: null,
    feedback,
    launchedAt: null,
    launchedWith: null,
    launchedPrompt: null,
  };
}

function avoidPreference(statement: string): HelperPreference {
  return { id: 'pref-1', kind: 'avoid', statement, createdAt: STAMP, updatedAt: STAMP, sourceOfferId: null };
}

test('status evidence withholds declined and avoided GitHub work, keeps everything else', () => {
  const empty = emptySnapshot();
  store.setSection('github', {
    ...empty.github,
    updatedAt: STAMP,
    actNow: [
      issue('avifenesh/trace-ml#31', 'build(deps): bump Swatinem/rust-cache from 2.9.1 to 2.9.2'),
      issue('valkey-io/valkey#2767', '[NEW] Full Sync from Replica'),
      issue('valkey-io/valkey#3724', 'Full sync from replica'),
      issue('valkey-io/valkey#15', 'Unrelated valkey issue that shares a number'),
      issue('valkey-io/valkey-skills#15', 'Add a skill'),
      issue('valkey-io/valkey-doc#147', 'Replace code example in cluster-tutorial'),
    ],
  });
  store.setSection('helper', {
    ...empty.helper,
    updatedAt: STAMP,
    offers: [
      declinedOffer(
        'offer-doc-147',
        'valkey-doc-147-cluster-tutorial-example-replacement',
        'Replace the broken cluster-tutorial code example',
        ['valkey-io/valkey-doc#147'],
        'didnt get any answer from maintainer, not relevant',
      ),
      // declined offer about #3724 that cited #2767 only as the linked feature issue
      declinedOffer(
        'offer-pr-3724',
        'valkey-pr3724-review-packet',
        'Prepare review packet for valkey PR #3724',
        ['valkey-io/valkey#3724', 'valkey-io/valkey#2767'],
        'already took care',
      ),
    ],
    preferences: [
      avoidPreference('Do not offer review packets or triage for valkey-io/valkey PR #3724 (sync-from-replica); already handled by the owner.'),
      avoidPreference('Do not offer follow-up work on upstream PRs where maintainers have gone quiet (valkey-io/valkey-skills #15/#16/#17).'),
    ],
  });

  const ids = reentry.buildEvidence().actNow.map((item) => item.id);

  // the declined offer's own evidence identity, plus the two items avoid rules name
  assert.ok(!ids.includes('valkey-io/valkey-doc#147'));
  assert.ok(!ids.includes('valkey-io/valkey#3724'));
  assert.ok(!ids.includes('valkey-io/valkey-skills#15'));
  // #2767 was cited as supporting evidence by the declined #3724 offer, never refused
  // itself; a rule naming one item in a repository must not silence the rest of it; and a
  // repository whose name only starts with an avoided one is a different repository
  assert.deepEqual(ids, ['avifenesh/trace-ml#31', 'valkey-io/valkey#2767', 'valkey-io/valkey#15']);
});

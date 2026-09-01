import test from 'node:test';
import assert from 'node:assert/strict';
import { foldMailbox, foldMailboxIn, isPublicProvider, mailboxDomain } from '../../shared/mailbox.js';

// The fold decides which accounts the CRM treats as one person. It has to match
// the console's own signup fence, and it has to be wrong in the safe direction:
// merging two unrelated people into a fake farm cluster is worse than missing
// one, so dots fold ONLY on the providers that ignore them.

test('a plus tag is not a separate mailbox', () => {
  assert.equal(foldMailbox('danimsibads+tv2178825970787205822@gmail.com'), 'danimsibads@gmail.com');
  assert.equal(foldMailbox('danimsibads+tiy178825@gmail.com'), 'danimsibads@gmail.com');
  assert.equal(foldMailbox('ops+billing@acme.io'), 'ops@acme.io', 'plus tags fold on every domain');
});

test('gmail dots fold, and googlemail is the same mailbox rule', () => {
  assert.equal(foldMailbox('dani.msib.ads@gmail.com'), 'danimsibads@gmail.com');
  assert.equal(foldMailbox('dani.msib.ads+x@googlemail.com'), 'danimsibads@googlemail.com');
});

test('dots are significant everywhere else', () => {
  assert.equal(foldMailbox('first.last@acme.io'), 'first.last@acme.io');
  assert.notEqual(
    foldMailbox('a.b@nivision.co.il'),
    foldMailbox('ab@nivision.co.il'),
    'folding dots off a private domain would invent a shared mailbox',
  );
});

test('case and whitespace are not identity', () => {
  assert.equal(foldMailbox('  DaniMsibAds+X@GMail.com '), 'danimsibads@gmail.com');
});

test('malformed input folds to null instead of a garbage cluster label', () => {
  for (const bad of ['', '   ', 'not-an-email', 'a@@b.com', '@gmail.com', 'x@', 'root@localhost', 'a b@c.com', 'a@b.com.']) {
    assert.equal(foldMailbox(bad), null, `${JSON.stringify(bad)} is not a mailbox`);
  }
  assert.equal(foldMailbox('+tag@gmail.com'), null, 'an address with no local part left is not a mailbox');
});

test('the domain half comes back only for a real address', () => {
  assert.equal(mailboxDomain('a+b@Asashi.My.Id'), 'asashi.my.id');
  assert.equal(mailboxDomain('nonsense'), null);
});

test('public providers are named so a domain cluster on them is not a finding', () => {
  assert.equal(isPublicProvider('gmail.com'), true);
  assert.equal(isPublicProvider('GMAIL.COM'), true);
  assert.equal(isPublicProvider('asashi.my.id'), false);
});

test('the fold finds the address inside a feed title', () => {
  // The three real title shapes the differ writes, from the live ledger.
  assert.equal(foldMailboxIn('signup: danimsibads+tiy178825@gmail.com'), 'danimsibads@gmail.com');
  assert.equal(
    foldMailboxIn('danimsibads+tiy178825@gmail.com: signed-up → active'),
    'danimsibads@gmail.com',
    'the colon after the address must not become part of the domain',
  );
  assert.equal(foldMailboxIn('danimsibads+tv217@gmail.com: +2 req'), 'danimsibads@gmail.com');
  assert.equal(foldMailboxIn('Checkout abandoned, no money owed. Verified against Paddle'), null);
});

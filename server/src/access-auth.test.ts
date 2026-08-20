import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import { verifyAccessJwt, _setKeyCacheForTest, type AccessConfig } from './access-auth.js';

// This verifier is the daemon-side half of the CRM's defense in depth: if it
// accepts what it shouldn't, a tunnel misconfiguration exposes the CRM (and the
// path allowlist is all that separates that from the rest of atrium). Each test
// is one forged-token shape the edge alone would not save us from.

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const { privateKey: strangerKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });

const TEAM = 'https://team.cloudflareaccess.com';
const AUD = 'aud-tag-1';

const cfg: AccessConfig = { teamDomain: TEAM, aud: AUD, allowEmails: [] };

function mint(claims: Record<string, unknown>, opts: { kid?: string; key?: typeof privateKey } = {}): string {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: opts.kid ?? 'k1' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const signature = cryptoSign('RSA-SHA256', Buffer.from(`${header}.${payload}`), opts.key ?? privateKey).toString('base64url');
  return `${header}.${payload}.${signature}`;
}

function goodClaims(over: Record<string, unknown> = {}): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000);
  return { aud: [AUD], iss: TEAM, exp: now + 300, nbf: now - 60, sub: 'user-1', email: 'owner@example.com', ...over };
}

test.beforeEach(() => {
  _setKeyCacheForTest(new Map([['k1', publicKey]]));
});

test('accepts a valid token and returns the identity', async () => {
  const id = await verifyAccessJwt(mint(goodClaims()), cfg);
  assert.equal(id.email, 'owner@example.com');
  assert.equal(id.sub, 'user-1');
});

test('rejects a token signed by a key the team never published', async () => {
  await assert.rejects(() => verifyAccessJwt(mint(goodClaims(), { key: strangerKey }), cfg), /bad signature/);
});

test('rejects an unknown kid rather than trying every key', async () => {
  await assert.rejects(() => verifyAccessJwt(mint(goodClaims(), { kid: 'k9' }), cfg), /unknown kid/);
});

test('rejects expiry, wrong audience, and wrong issuer', async () => {
  await assert.rejects(() => verifyAccessJwt(mint(goodClaims({ exp: 1 })), cfg), /expired/);
  await assert.rejects(() => verifyAccessJwt(mint(goodClaims({ aud: ['other-app'] })), cfg), /wrong audience/);
  await assert.rejects(() => verifyAccessJwt(mint(goodClaims({ iss: 'https://evil.example' })), cfg), /wrong issuer/);
});

test('email allowlist narrows past the Access policy', async () => {
  const strict: AccessConfig = { ...cfg, allowEmails: ['Owner@Example.com'] };
  assert.equal((await verifyAccessJwt(mint(goodClaims()), strict)).email, 'owner@example.com');
  await assert.rejects(() => verifyAccessJwt(mint(goodClaims({ email: 'stranger@example.com' })), strict), /not allowed/);
  await assert.rejects(() => verifyAccessJwt(mint(goodClaims({ email: undefined })), strict), /not allowed/);
});

test('rejects the alg-swap classic and structural garbage', async () => {
  const header = Buffer.from(JSON.stringify({ alg: 'none', kid: 'k1' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify(goodClaims())).toString('base64url');
  await assert.rejects(() => verifyAccessJwt(`${header}.${payload}.`, cfg), /unexpected alg/);
  await assert.rejects(() => verifyAccessJwt('', cfg), /malformed/);
  await assert.rejects(() => verifyAccessJwt('a.b', cfg), /malformed/);
});

test('refuses to run unconfigured instead of failing open', async () => {
  await assert.rejects(
    () => verifyAccessJwt(mint(goodClaims()), { teamDomain: '', aud: '', allowEmails: [] }),
    /not configured/,
  );
});

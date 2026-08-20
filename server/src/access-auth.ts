// Cloudflare Access JWT verification, for the ONE public surface (the CRM host).
//
// Atrium has no auth layer of its own — loopback is the boundary. Exposing the
// CRM through a Cloudflare tunnel punches through that boundary, so the daemon
// cannot trust the tunnel's word: cloudflared connects FROM 127.0.0.1, a
// misconfigured ingress rule or a second local process could too. Every request
// claiming to be the CRM host must therefore carry the Access JWT
// (Cf-Access-Jwt-Assertion), and this module verifies it against the team's
// published signing keys — signature, issuer, audience, expiry, and optionally
// the identity's email. Defense in depth: Access enforces at the edge AND the
// daemon re-checks, so neither misconfiguration alone opens the door.
//
// No dependencies on purpose (this server has none): RS256 over the JWS signing
// input with node:crypto, JWKs imported directly (createPublicKey supports JWK).

import { createPublicKey, verify as cryptoVerify, type KeyObject } from 'node:crypto';

export interface AccessConfig {
  /** e.g. 'https://myteam.cloudflareaccess.com' — no trailing slash */
  teamDomain: string;
  /** the Access application's audience tag */
  aud: string;
  /** empty = any identity the Access policy admitted */
  allowEmails: string[];
}

interface Jwk {
  kid?: string;
  kty?: string;
  [key: string]: unknown;
}

interface CachedKeys {
  byKid: Map<string, KeyObject>;
  fetchedAt: number;
}

const KEY_TTL_MS = 3_600_000;
let cache: CachedKeys | null = null;

async function signingKeys(teamDomain: string): Promise<Map<string, KeyObject>> {
  if (cache && Date.now() - cache.fetchedAt < KEY_TTL_MS) return cache.byKid;
  const response = await fetch(`${teamDomain}/cdn-cgi/access/certs`, {
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`certs fetch ${response.status}`);
  const body = (await response.json()) as { keys?: Jwk[] };
  const byKid = new Map<string, KeyObject>();
  for (const jwk of body.keys ?? []) {
    if (!jwk.kid || jwk.kty !== 'RSA') continue;
    try {
      byKid.set(jwk.kid, createPublicKey({ key: jwk as never, format: 'jwk' }));
    } catch {
      /* skip a malformed key; the kid lookup below decides if that matters */
    }
  }
  if (byKid.size === 0) throw new Error('no usable signing keys');
  cache = { byKid, fetchedAt: Date.now() };
  return byKid;
}

function b64urlJson(part: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Record<string, unknown>;
}

export interface AccessIdentity {
  email: string | null;
  sub: string;
}

/** Verify the token; returns the identity or throws with the reason (the caller
 *  logs it — the client only ever sees a uniform 403). */
export async function verifyAccessJwt(token: string, cfg: AccessConfig): Promise<AccessIdentity> {
  if (!cfg.teamDomain || !cfg.aud) throw new Error('access auth not configured');
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('malformed token');

  const header = b64urlJson(parts[0]);
  if (header.alg !== 'RS256') throw new Error(`unexpected alg ${String(header.alg)}`);
  const kid = typeof header.kid === 'string' ? header.kid : '';

  const keys = await signingKeys(cfg.teamDomain);
  const key = keys.get(kid);
  if (!key) throw new Error(`unknown kid ${kid}`);

  const ok = cryptoVerify(
    'RSA-SHA256',
    Buffer.from(`${parts[0]}.${parts[1]}`),
    key,
    Buffer.from(parts[2], 'base64url'),
  );
  if (!ok) throw new Error('bad signature');

  const claims = b64urlJson(parts[1]);
  const now = Math.floor(Date.now() / 1000);
  if (typeof claims.exp !== 'number' || claims.exp <= now) throw new Error('expired');
  if (typeof claims.nbf === 'number' && claims.nbf > now + 60) throw new Error('not yet valid');
  if (claims.iss !== cfg.teamDomain) throw new Error(`wrong issuer ${String(claims.iss)}`);
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(cfg.aud)) throw new Error('wrong audience');

  const email = typeof claims.email === 'string' ? claims.email.toLowerCase() : null;
  if (cfg.allowEmails.length > 0 && (!email || !cfg.allowEmails.map((e) => e.toLowerCase()).includes(email))) {
    throw new Error(`identity ${email ?? '(no email)'} not allowed`);
  }
  return { email, sub: typeof claims.sub === 'string' ? claims.sub : '' };
}

/** test hook */
export function _setKeyCacheForTest(byKid: Map<string, KeyObject>): void {
  cache = { byKid, fetchedAt: Date.now() };
}

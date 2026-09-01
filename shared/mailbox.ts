// Email fingerprinting, shared by the CRM feed and the security page.
//
// The console already folds a signup address this way before it checks its
// one-account-per-mailbox fence: strip a `+tag`, strip dots on the providers
// that ignore them, lowercase. This module is atrium's copy of that fold, so
// the CRM groups accounts the same way the fence does. It is deliberately a
// pure string function with no console call behind it: the fold has to work on
// a pipeline row that carries nothing but an address.
//
// Runtime module, not types: shared/types.ts is types-only, and both workspaces
// already compile ../shared, so importing this from server and web is free.

/** Providers that treat `a.b@` and `ab@` as one mailbox. Every other domain is
 *  left alone: dots are significant almost everywhere else, and folding them
 *  would merge two unrelated people into one fake cluster. */
const DOT_BLIND = new Set(['gmail.com', 'googlemail.com']);

/**
 * Public mailbox providers. A domain cluster on one of these means nothing (the
 * whole internet has a gmail address), so the domain view drops them and lets
 * the mailbox fold carry the gmail cases instead.
 */
const PUBLIC_PROVIDERS = new Set([
  'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'msn.com',
  'yahoo.com', 'yahoo.co.uk', 'ymail.com', 'icloud.com', 'me.com', 'mac.com',
  'proton.me', 'protonmail.com', 'pm.me', 'aol.com', 'gmx.com', 'gmx.de',
  'mail.com', 'mail.ru', 'yandex.com', 'yandex.ru', 'zoho.com', 'qq.com',
  '163.com', '126.com', 'naver.com', 'web.de', 'fastmail.com', 'hey.com',
]);

/** Split an address into a local part and a domain, or null when it is not one. */
function parts(address: string): { local: string; domain: string } | null {
  const clean = address.trim().toLowerCase();
  const at = clean.indexOf('@');
  if (at <= 0 || at !== clean.lastIndexOf('@')) return null;
  const local = clean.slice(0, at);
  const domain = clean.slice(at + 1);
  // A domain with no dot is not a mailbox we can reason about, and treating it
  // as one would make "root@localhost" a cluster label.
  if (!domain.includes('.') || domain.startsWith('.') || domain.endsWith('.')) return null;
  if (/[\s,;:<>"()[\]\\]/u.test(clean)) return null;
  return { local, domain };
}

/**
 * The mailbox an address really lands in, or null when the input is not an
 * address. `danimsibads+tv217@gmail.com` and `dani.msibads@gmail.com` both fold
 * to `danimsibads@gmail.com`; `first.last@acme.io` keeps its dot.
 */
export function foldMailbox(address: string): string | null {
  const split = parts(address);
  if (!split) return null;
  let local = split.local.split('+')[0];
  if (DOT_BLIND.has(split.domain)) local = local.replaceAll('.', '');
  if (!local) return null;
  return `${local}@${split.domain}`;
}

/** The domain half, or null for a non-address. */
export function mailboxDomain(address: string): string | null {
  return parts(address)?.domain ?? null;
}

/** Is this domain one the whole world uses, so a cluster on it means nothing? */
export function isPublicProvider(domain: string): boolean {
  return PUBLIC_PROVIDERS.has(domain.trim().toLowerCase());
}

/** The first address inside free text, as written. CRM event titles carry the
 *  address inside a sentence (`signup: a@b.com`, `a@b.com: signed-up -> lost`),
 *  so the feed reads what it can find rather than a structured field the
 *  append-only ledger never wrote. */
export function addressIn(text: string): string | null {
  // The trailing-punctuation trim matters: the stage-change title reads
  // `a@b.com: signed-up -> lost`, and a domain of `b.com:` folds to nothing.
  const hit = text.match(/[^\s,;:<>"()[\]\\]+@[^\s,;:<>"()[\]\\]+/u);
  if (!hit) return null;
  const trimmed = hit[0].replace(/[.>-]+$/u, '');
  return parts(trimmed) ? trimmed.trim().toLowerCase() : null;
}

/** The first address inside free text, folded to its mailbox. */
export function foldMailboxIn(text: string): string | null {
  const found = addressIn(text);
  return found ? foldMailbox(found) : null;
}

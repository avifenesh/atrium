// Self-serve x.ai Management API key paste (no oauth — a single long-lived key, like
// spotify's client id). The grok CLI's local token (~/.grok/auth.json .key) is a
// short-lived oidc access JWT that the management API does NOT accept; reading prepaid
// credits / postpaid spend needs a separate Management API key the owner creates at
// console.x.ai -> Settings -> Management Keys and pastes once into the subs panel.
//
// Files:
//   ~/.config/atrium/xai_mgmt.json — { key } (set via POST /api/xai/key), 0600 atomic
//
// Secrets never leave this module: not in returned values, not in errors, not in logs.

import { mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from './config.js';
import { readJson } from './util.js';

const MGMT_KEY_PATH = join(config.configDir, 'xai_mgmt.json');

// ---------- file shape ----------

interface MgmtKeyFile {
  key?: string;
}

// ---------- setup (one-time management key paste from the subs panel) ----------

/**
 * Validate and persist an x.ai Management API key. Mirrors spotifySetClient: shape-only
 * validation (no network), atomic 0600 write. The `xai-` prefix is the common form but
 * not guaranteed, so it's accepted-but-not-required — we only insist on a non-empty key
 * of plausible length so a stray paste (a word, a url) is rejected before it reaches disk.
 */
export async function xaiSetKey(key: unknown): Promise<void> {
  const k = typeof key === 'string' ? key.trim() : '';
  if (k.length < 16 || k.length > 512 || /\s/.test(k)) {
    throw new Error(
      'that does not look like an x.ai Management API key — create one at console.x.ai -> Settings -> Management Keys and paste the whole key',
    );
  }
  await mkdir(config.configDir, { recursive: true });
  // unique tmp so concurrent paste/retry calls don't race on a shared tmp path
  const tmp = `${MGMT_KEY_PATH}.${process.pid}-${Date.now()}.tmp`;
  await writeFile(tmp, `${JSON.stringify({ key: k }, null, 2)}\n`, { mode: 0o600 });
  try {
    await rename(tmp, MGMT_KEY_PATH);
  } catch (err) {
    await unlink(tmp).catch(() => {}); // never leave a key-bearing tmp behind
    throw err;
  }
}

/** Read the pasted management key, if any. Used by xai-usage (never returned to clients). */
export async function loadXaiMgmtKey(): Promise<string | null> {
  const j = await readJson<MgmtKeyFile>(MGMT_KEY_PATH);
  const k = typeof j?.key === 'string' ? j.key.trim() : '';
  return k.length >= 16 ? k : null;
}

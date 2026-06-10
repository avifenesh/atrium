import { config } from '../config.js';
import { store } from '../state.js';
import { iso } from '../util.js';
import type { Collector } from './registry.js';
import type { SurrealState, Flag } from '../../../shared/types.js';

// auth header is built per-request from config and never written to the snapshot
function authHeader(): string {
  return 'Basic ' + Buffer.from(`${config.surreal.user}:${config.surreal.pass}`).toString('base64');
}

/** POST a statement to /sql; returns the first OK result payload, or null on any failure. */
async function sql(query: string, ns?: string): Promise<any> {
  try {
    const headers: Record<string, string> = {
      Authorization: authHeader(),
      Accept: 'application/json',
    };
    if (ns) headers['surreal-ns'] = ns;
    const res = await fetch(`${config.surreal.endpoint}/sql`, {
      method: 'POST',
      headers,
      body: query,
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return null;
    const body = await res.json();
    if (!Array.isArray(body)) return null;
    return body.find((r: any) => r?.status === 'OK')?.result ?? null;
  } catch {
    return null;
  }
}

let downSince: string | null = null;

async function run(): Promise<void> {
  const state: SurrealState = {
    updatedAt: iso(),
    up: false,
    endpoint: config.surreal.endpoint,
    version: null,
    namespaces: [],
    error: null,
  };

  try {
    const health = await fetch(`${config.surreal.endpoint}/health`, { signal: AbortSignal.timeout(2_000) });
    state.up = health.ok;
    if (!health.ok) state.error = `health returned ${health.status}`;
  } catch (err) {
    state.error = err instanceof Error ? err.message : String(err);
  }

  if (state.up) {
    try {
      const res = await fetch(`${config.surreal.endpoint}/version`, { signal: AbortSignal.timeout(2_000) });
      if (res.ok) state.version = (await res.text()).trim();
    } catch {
      /* version is cosmetic; health already proved liveness */
    }

    const root = await sql('INFO FOR ROOT;');
    const nsNames = Object.keys(root?.namespaces ?? {}).slice(0, 5);
    for (const name of nsNames) {
      const nsInfo = await sql('INFO FOR NS;', name);
      state.namespaces.push({ name, databases: Object.keys(nsInfo?.databases ?? {}) });
    }
  }

  const flags: Flag[] = [];
  if (!state.up) {
    downSince ??= iso();
    flags.push({
      id: 'surreal:down',
      severity: 'warn',
      title: 'surrealdb down',
      detail: `no healthy response from ${config.surreal.endpoint} — revuto memory store offline${state.error ? ` (${state.error})` : ''}`,
      source: 'surreal',
      raisedAt: downSince,
    });
  } else {
    downSince = null;
  }

  store.setSection('surreal', state);
  store.setFlags('surreal', flags);
}

const collector: Collector = { name: 'surreal', intervalMs: config.poll.surrealMs, run };
export default collector;

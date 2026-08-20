// Vast.ai spend — a plugin collector.
//
// The serving boxes (DE/NJ) and every research pod are vast.ai containers, so
// vast IS the expense side of the business: burn rate is the sum of running
// instances' $/hr, and the prepaid credit is the runway. AWS instances ride in
// the separate cloud collector; this one reads vast's own API with the CLI's
// key file, so it works headless (no CLI, no interactive login).
//
// Read-only by design: this collector must never start/stop/modify an instance
// — the accelerator lanes belong to the owner (see the lane law in CLAUDE.md).

import { readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { config } from '../config.js';
import { store } from '../state.js';
import { iso, readJson } from '../util.js';
import type { Collector } from './registry.js';

const KEY_FILE = join(homedir(), '.config', 'vastai', 'vast_api_key');
const API = 'https://console.vast.ai/api';
const BURN_FILE = join(config.configDir, 'vast-burn.json');

/** $/hr samples averaged per UTC day — the P&L needs burn HISTORY, and vast
 *  only tells you the current rate. 10-minute samples, mean per day, 60 days. */
let burnDays: Record<string, { sum: number; n: number }> = {};
let burnLoaded = false;

async function recordBurn(perHour: number): Promise<void> {
  if (!burnLoaded) {
    burnLoaded = true;
    const saved = await readJson<Record<string, { sum: number; n: number }>>(BURN_FILE);
    if (saved && typeof saved === 'object') burnDays = saved;
  }
  const day = iso().slice(0, 10);
  const entry = burnDays[day] ?? { sum: 0, n: 0 };
  burnDays[day] = { sum: entry.sum + perHour, n: entry.n + 1 };
  const cutoff = new Date(Date.now() - 60 * 24 * 3_600_000).toISOString().slice(0, 10);
  for (const d of Object.keys(burnDays)) if (d < cutoff) delete burnDays[d];
  try {
    const tmp = `${BURN_FILE}.tmp-${process.pid}`;
    await writeFile(tmp, JSON.stringify(burnDays), 'utf8');
    await rename(tmp, BURN_FILE);
  } catch (err) {
    console.error('[vast] burn persist failed:', err instanceof Error ? err.message : err);
  }
}

/** day → mean $/hr, for the overview's P&L rows */
export function burnPerDay(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [day, { sum, n }] of Object.entries(burnDays)) out[day] = n > 0 ? sum / n : 0;
  return out;
}

export interface VastInstance {
  id: number;
  label: string | null;
  gpuName: string | null;
  numGpus: number | null;
  dphTotal: number | null;
  status: string | null;
  startedAt: string | null;
}

export interface VastState {
  instances: VastInstance[];
  /** running instances' combined $/hr */
  burnPerHour: number;
  creditUsd: number | null;
  error: string | null;
}

async function getJson<T>(path: string, key: string): Promise<T> {
  const response = await fetch(`${API}${path}`, {
    headers: { accept: 'application/json', authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`${response.status} vast ${path}`);
  return (await response.json()) as T;
}

interface RawInstance {
  id: number;
  label?: string | null;
  gpu_name?: string | null;
  num_gpus?: number | null;
  dph_total?: number | null;
  actual_status?: string | null;
  start_date?: number | null;
}

const collector: Collector = {
  name: 'vast',
  intervalMs: 10 * 60_000,

  async run() {
    let key: string;
    try {
      key = (await readFile(KEY_FILE, 'utf8')).trim();
    } catch {
      // no key file = vast not in use on this machine; publish nothing rather
      // than a permanent error banner
      store.setExtra('vast', { updatedAt: iso(), data: { instances: [], burnPerHour: 0, creditUsd: null, error: 'no vast_api_key file' } });
      return;
    }

    const state: VastState = { instances: [], burnPerHour: 0, creditUsd: null, error: null };
    try {
      // instances moved to v1 (v0 answers deprecated_endpoint); users/current has not
      const payload = await getJson<{ instances?: RawInstance[] }>('/v1/instances/?owner=me', key);
      for (const raw of payload.instances ?? []) {
        const instance: VastInstance = {
          id: raw.id,
          label: raw.label ?? null,
          gpuName: raw.gpu_name ?? null,
          numGpus: raw.num_gpus ?? null,
          dphTotal: raw.dph_total ?? null,
          status: raw.actual_status ?? null,
          startedAt: raw.start_date ? new Date(raw.start_date * 1000).toISOString() : null,
        };
        state.instances.push(instance);
        if (instance.status === 'running' && instance.dphTotal) state.burnPerHour += instance.dphTotal;
      }
      state.instances.sort((a, b) => (b.dphTotal ?? 0) - (a.dphTotal ?? 0));
    } catch (error) {
      state.error = error instanceof Error ? error.message : String(error);
    }
    try {
      const user = await getJson<{ credit?: number }>('/v0/users/current/', key);
      state.creditUsd = typeof user.credit === 'number' ? user.credit : null;
    } catch (error) {
      state.error = state.error ?? (error instanceof Error ? error.message : String(error));
    }

    if (state.error == null) await recordBurn(state.burnPerHour);

    store.setExtra('vast', {
      title: 'vast.ai',
      updatedAt: iso(),
      up: state.error == null,
      error: state.error,
      rows: [
        { label: 'burn', value: `$${state.burnPerHour.toFixed(2)}/hr · ${state.instances.filter((i) => i.status === 'running').length} running` },
        { label: 'credit', value: state.creditUsd == null ? '?' : `$${state.creditUsd.toFixed(2)}` },
      ],
      data: state as unknown as Record<string, unknown>,
    });
  },
};

export default collector;

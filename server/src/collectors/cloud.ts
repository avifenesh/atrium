import { config } from '../config.js';
import { store } from '../state.js';
import { iso, sh } from '../util.js';
import type { Collector } from './registry.js';
import type { CloudInstance, CloudState } from '../../../shared/types.js';

// INFORMATIONAL ONLY — running fleets are the owner's normal work state.
// No flags, no thresholds, no alerts ever from this collector.

const TIMEOUT_MS = 20_000;
const HOURS_PER_MONTH = 730;

// rough us-east-2 on-demand estimate, $/hr; unknown types show null instead of a guess
const HOURLY_USD: Record<string, number> = {
  't3.micro': 0.0104,
  't4g.large': 0.0672,
  't4g.2xlarge': 0.2688,
  'm7g.large': 0.0816,
  'm7g.xlarge': 0.1632,
  'm7g.2xlarge': 0.3264,
  'm7i.large': 0.1008,
  'm7i.xlarge': 0.2016,
  'm7i.2xlarge': 0.4032,
  'c7g.large': 0.0725,
  'c7g.xlarge': 0.145,
  'c7g.2xlarge': 0.29,
};

function monthlyUsd(type: string): number | null {
  const h = HOURLY_USD[type];
  return h === undefined ? null : Math.round(h * HOURS_PER_MONTH * 100) / 100;
}

function parseInstances(raw: string): CloudInstance[] {
  const body = JSON.parse(raw);
  const out: CloudInstance[] = [];
  const reservations: any[] = Array.isArray(body?.Reservations) ? body.Reservations : [];
  for (const r of reservations) {
    const instances: any[] = Array.isArray(r?.Instances) ? r.Instances : [];
    for (const i of instances) {
      if (!i || typeof i.InstanceId !== 'string') continue;
      const tags: any[] = Array.isArray(i.Tags) ? i.Tags : [];
      const name = tags.find((t) => t?.Key === 'Name')?.Value;
      const type = typeof i.InstanceType === 'string' ? i.InstanceType : 'unknown';
      out.push({
        id: i.InstanceId,
        name: typeof name === 'string' && name !== '' ? name : null,
        type,
        state: typeof i.State?.Name === 'string' ? i.State.Name : 'unknown',
        launchedAt: typeof i.LaunchTime === 'string' ? i.LaunchTime : null,
        publicIp: typeof i.PublicIpAddress === 'string' ? i.PublicIpAddress : null,
        az: typeof i.Placement?.AvailabilityZone === 'string' ? i.Placement.AvailabilityZone : null,
        monthlyUsd: monthlyUsd(type),
      });
    }
  }
  out.sort((a, b) => (b.launchedAt ?? '').localeCompare(a.launchedAt ?? '')); // newest first
  return out;
}

// last-good: a transient aws/network failure keeps the previous list with its real
// updatedAt (header staleness stays honest); updatedAt stays null until the first
// success so never-collected can't read as fresh data
let lastGood: CloudState | null = null;

const cloud: Collector = {
  name: 'cloud',
  intervalMs: config.poll.cloudMs,
  async run() {
    let state: CloudState;
    try {
      const raw = await sh(
        'aws',
        ['ec2', 'describe-instances', '--filters', 'Name=instance-state-name,Values=running', '--output', 'json'],
        { timeoutMs: TIMEOUT_MS },
      );
      const instances = parseInstances(raw);
      const known = instances.map((i) => i.monthlyUsd).filter((n): n is number => n !== null);
      state = {
        updatedAt: iso(),
        instances,
        totalMonthlyUsd: known.length > 0 ? Math.round(known.reduce((a, b) => a + b, 0) * 100) / 100 : null,
        error: null,
      };
      lastGood = state;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const friendly = msg.includes('ENOENT') ? 'aws cli not installed' : msg;
      state = lastGood
        ? { ...lastGood, error: friendly }
        : { updatedAt: null, instances: [], totalMonthlyUsd: null, error: friendly };
    }
    store.setSection('cloud', state);
  },
};

export default cloud;

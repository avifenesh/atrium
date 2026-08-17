import type { Collector } from './registry.js';
import { config } from '../config.js';
import { helper } from '../helper.js';
import { sh, userSystemdEnv } from '../util.js';

async function systemdState(): Promise<{ nextRunAt: string | null; workerActive: boolean | null }> {
  try {
    const [timer, service] = await Promise.all([
      sh(
        'systemctl',
        ['--user', 'list-timers', 'atrium-helper-agent.timer', '--all', '--no-pager', '--output=json'],
        { timeoutMs: 5_000, env: userSystemdEnv() },
      ),
      sh(
        'systemctl',
        ['--user', 'show', 'atrium-helper-agent.service', '--property=ActiveState', '--value'],
        { timeoutMs: 5_000, env: userSystemdEnv() },
      ),
    ]);
    const timers = JSON.parse(timer) as Array<{ next?: number | string }>;
    const nextUsec = Number(timers[0]?.next);
    const activeState = service.trim();
    return {
      nextRunAt: Number.isFinite(nextUsec) && nextUsec > 0
        ? new Date(Math.floor(nextUsec / 1_000)).toISOString()
        : null,
      workerActive: activeState === 'activating' || activeState === 'active',
    };
  } catch {
    return { nextRunAt: null, workerActive: null };
  }
}

const collector: Collector = {
  name: 'helper',
  core: true,
  intervalMs: config.poll.helperMs,
  async run() {
    const status = await systemdState();
    await helper.refreshWorkerStatus(status.nextRunAt, status.workerActive);
  },
};

export default collector;


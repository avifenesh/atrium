import type { AgentInfo } from '../../../../shared/types.js';
import { config } from '../../config.js';
import { readJson } from '../../util.js';
import { baseAgent, flag, pidAlive, tsToIso, type SourceResult } from './common.js';

export async function collectHermes(): Promise<SourceResult> {
  const agent = baseAgent('hermes', 'Hermes');
  const flags: SourceResult['flags'] = [];

  agent.controls = [
    { action: 'restart', label: 'restart gateway' },
    { action: 'stop', label: 'stop gateway', destructive: true },
    { action: 'pause', label: 'pause job', target: '<jobId>' },
    { action: 'resume', label: 'resume job', target: '<jobId>' },
  ];
  agent.resources = await readCronJobs();

  const st = await readJson<any>(config.paths.hermesGatewayState);
  if (!st) {
    agent.status = 'off';
    agent.detail = 'no gateway state file';
    return { agent, flags };
  }

  const alive = pidAlive(st.pid);
  const gatewayState = String(st.gateway_state ?? 'unknown');
  const activeAgents = typeof st.active_agents === 'number' ? st.active_agents : 0;
  agent.lastActivity = tsToIso(st.updated_at);

  if (!alive && gatewayState === 'running') {
    flags.push(
      flag(
        'agents:hermes-gateway-pid-dead',
        'warn',
        'hermes gateway pid dead',
        `gateway_state says running but pid ${st.pid} is not alive`,
      ),
    );
  }

  agent.status = !alive ? 'off' : activeAgents > 0 ? 'active' : gatewayState === 'running' ? 'running' : 'idle';

  const parts = [`gateway ${gatewayState}`, `${activeAgents} active agents`];
  const tg = st.platforms?.telegram;
  if (tg?.state) parts.push(`telegram ${tg.state}`);
  agent.detail = parts.join(', ');
  return { agent, flags };
}

async function readCronJobs(): Promise<AgentInfo['resources']> {
  const raw = await readJson<any>(config.paths.hermesCronJobs);
  const jobs: any[] = Array.isArray(raw) ? raw : Array.isArray(raw?.jobs) ? raw.jobs : [];
  return jobs
    .filter((j) => j?.id)
    .map((j) => ({
      id: String(j.id),
      name: String(j.name ?? j.id),
      state: j.enabled ? 'enabled' : 'paused',
      muteable: true,
    }));
}

import type { AgentInfo, EigenDispatch } from '../../shared/types';

/**
 * Real work only — not a daemon that is merely up.
 * Collector vocab: `running` = process/daemon alive; `active` = currently doing work.
 * Also treat live sessions and running eigen dispatches as work.
 */
export function isAgentWorking(a: AgentInfo, dispatches: EigenDispatch[] = []): boolean {
  if (a.status === 'active') return true;
  if (a.sessions.some((s) => s.live)) return true;
  if (a.id === 'eigen' && dispatches.some((d) => d.status === 'running')) return true;
  return false;
}

export function workingAgents(agents: AgentInfo[], dispatches: EigenDispatch[] = []): AgentInfo[] {
  return agents.filter((a) => isAgentWorking(a, dispatches));
}

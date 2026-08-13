import type { AgentInfo, EigenDispatch } from '../../shared/types';

/**
 * Real work only — not a daemon that is merely up.
 * Collector vocab: `running` = process/daemon alive; `active` = currently doing work.
 * Also treat live sessions as work. Grok dispatches are not an eigen session.
 */
export function isAgentWorking(a: AgentInfo, dispatches: EigenDispatch[] = []): boolean {
  if (a.status === 'active') return true;
  if (a.sessions.some((s) => s.live)) return true;
  if (a.id === 'grok' && dispatches.some((d) => d.status === 'running')) return true;
  return false;
}

export function workingAgents(agents: AgentInfo[], dispatches: EigenDispatch[] = []): AgentInfo[] {
  return agents.filter((a) => isAgentWorking(a, dispatches));
}

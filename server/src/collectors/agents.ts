import type { AgentId, AgentsState, Flag } from '../../../shared/types.js';
import { config } from '../config.js';
import { getDispatches } from '../eigen-dispatch.js';
import { store } from '../state.js';
import { iso, tailLines } from '../util.js';
import { baseAgent, pruneFlagPins, type SourceResult } from './agents/common.js';
import type { Collector } from './registry.js';

import { collectAnyMission } from './agents/any-mission.js';
import { collectClaude } from './agents/claude.js';
import { collectCodex } from './agents/codex.js';
import { collectEigen } from './agents/eigen.js';
import { collectHermes } from './agents/hermes.js';
import { collectItch } from './agents/itch.js';
import { collectRevuto } from './agents/revuto.js';
import { collectTraining } from './agents/training.js';

/** Stable order — the UI relies on it. */
const SOURCES: [AgentId, string, () => Promise<SourceResult>][] = [
  ['revuto', 'Revuto', collectRevuto],
  ['hermes', 'Hermes', collectHermes],
  ['itch', 'Itch', collectItch],
  ['any-mission', 'Any-Mission', collectAnyMission],
  ['eigen', 'Eigen', collectEigen],
  ['claude', 'Claude Code', collectClaude],
  ['codex', 'Codex', collectCodex],
  ['training', 'Training', collectTraining],
];

async function guarded(id: AgentId, name: string, fn: () => Promise<SourceResult>): Promise<SourceResult> {
  try {
    return await fn();
  } catch (err) {
    const agent = baseAgent(id, name);
    agent.status = 'unknown';
    agent.detail = 'collector failed';
    agent.error = err instanceof Error ? err.message : String(err);
    return { agent, flags: [] };
  }
}

async function readActivity(): Promise<AgentsState['activity']> {
  const lines = await tailLines(config.paths.eigenObserve, 60);
  const out: AgentsState['activity'] = [];
  for (const line of lines) {
    try {
      const j = JSON.parse(line);
      if (!j?.time || !j?.kind) continue;
      out.push({
        time: String(j.time),
        source: 'eigen',
        text: j.kind === 'tool_start' && j.tool ? `tool ${j.tool}` : String(j.kind),
        isError: Boolean(j.is_error),
      });
    } catch {
      /* skip bad jsonl line */
    }
  }
  return out.slice(-40); // newest last
}

const collector: Collector = {
  name: 'agents',
  intervalMs: config.poll.agentsMs,
  async run() {
    const [results, activity] = await Promise.all([
      Promise.all(SOURCES.map(([id, name, fn]) => guarded(id, name, fn))),
      readActivity().catch(() => [] as AgentsState['activity']),
    ]);

    const flags: Flag[] = results.flatMap((r) => r.flags);
    pruneFlagPins(new Set(flags.map((f) => f.id)));
    const state: AgentsState = {
      updatedAt: iso(),
      agents: results.map((r) => r.agent),
      activity,
      dispatches: getDispatches(),
    };
    store.setSection('agents', state);
    store.setFlags('agents', flags);
  },
};

export default collector;

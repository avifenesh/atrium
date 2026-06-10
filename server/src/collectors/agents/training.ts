import { iso, shTry } from '../../util.js';
import { baseAgent, type SourceResult } from './common.js';

const DESKTOP_PROC = /gnome|xwayland|xorg|mutter|kwin|plasma|compositor|portal|electron|chrome|firefox/i;
// inference servers live on GPU around the clock on this rig — they are not training runs
const INFERENCE_PROC = /llama-server|ollama|vllm|tabby|llama\.cpp/i;

export async function collectTraining(): Promise<SourceResult> {
  const agent = baseAgent('training', 'Training');

  const [pgrepOut, smiOut] = await Promise.all([
    shTry('pgrep', ['-fa', 'train|torch|accelerate'], { timeoutMs: 3000 }),
    shTry('nvidia-smi', ['--query-compute-apps=pid,process_name,used_memory', '--format=csv,noheader'], {
      timeoutMs: 5000,
    }),
  ]);

  const trainProcs = (pgrepOut ?? '')
    .split('\n')
    .filter(Boolean)
    .filter((l) => {
      if (Number(l.split(' ')[0]) === process.pid) return false;
      if (/\b(pgrep|grep)\b/.test(l)) return false;
      // agent-harness wrapper shells quote arbitrary text ('train', 'python3') in their eval strings
      if (l.includes('shell-snapshots') || /\b(zsh|bash|sh) -c\b/.test(l)) return false;
      // pgrep pattern is broad ('torch' matches editors opening torch files etc) —
      // require an actual python/launcher runner or a train script
      return /(^|\s|\/)(python[\d.]*|torchrun|accelerate|deepspeed)\b/.test(l) || /train[^\s/]*\.(py|sh)\b/.test(l);
    });

  // csv lines: "pid, process_name, used_memory MiB"
  const gpuProcs = (smiOut ?? '')
    .split('\n')
    .filter(Boolean)
    .map((l) => l.split(',').map((p) => p.trim()))
    .filter((p) => p.length >= 2 && !DESKTOP_PROC.test(p[1] ?? '') && !INFERENCE_PROC.test(p[1] ?? ''));

  if (trainProcs.length > 0 || gpuProcs.length > 0) {
    agent.status = 'active';
    const bits: string[] = [];
    if (trainProcs.length) bits.push(`${trainProcs.length} training proc${trainProcs.length > 1 ? 's' : ''}`);
    if (gpuProcs.length) {
      const names = gpuProcs.slice(0, 3).map((p) => `${shortName(p[1] ?? '?')} (${p[2] ?? '?'})`);
      bits.push(`GPU: ${names.join(', ')}${gpuProcs.length > 3 ? ` +${gpuProcs.length - 3}` : ''}`);
    }
    agent.detail = bits.join('; ');
    agent.lastActivity = iso();
  } else {
    agent.status = 'off';
    agent.detail = 'no training running';
  }
  return { agent, flags: [] };
}

function shortName(p: string): string {
  const parts = p.split('/');
  return parts[parts.length - 1] || p;
}

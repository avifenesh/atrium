import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { config } from './config.js';

// Grok Build has no separate billing REST API — the live "/usage" numbers live
// behind the grok CLI's own authenticated channel. But the binary exposes that
// channel as plain JSON-RPC over stdio (`grok agent stdio`, the ACP server it
// runs for editors). We speak it directly: initialize → authenticate with the
// cached token → call the private `_x.ai/billing` method. No token is read or
// emitted by us; the CLI uses its own ~/.grok/auth.json.

export interface GrokBilling {
  /** fraction 0..1 of the included monthly allowance consumed */
  creditUsagePercent: number;
  periodStart: string | null;
  periodEnd: string | null;
  onDemandCap: number | null;
  onDemandUsed: number | null;
  subscriptionTier: string | null;
}

interface Rpc {
  jsonrpc: '2.0';
  id?: number;
  method?: string;
  result?: any;
  error?: { code: number; message: string };
}

/** Spawn the grok ACP agent, run the handshake, return live billing — or null on any failure. */
export function getGrokBilling(timeoutMs = 25_000): Promise<GrokBilling | null> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      // a neutral cwd: don't let the agent try to index whatever dir the daemon
      // was launched from (systemd leaves it at /). --no-leader avoids attaching
      // to a running grok leader socket (different lifecycle, can race the kill).
      child = spawn(config.paths.grokBin, ['agent', '--no-leader', 'stdio'], {
        stdio: ['pipe', 'pipe', 'ignore'],
        cwd: tmpdir(),
      });
    } catch {
      resolve(null);
      return;
    }

    let settled = false;
    let buf = '';
    const finish = (val: GrokBilling | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.kill();
      } catch {
        /* already gone */
      }
      resolve(val);
    };

    const timer = setTimeout(() => finish(null), timeoutMs);
    const send = (obj: Rpc) => {
      try {
        child.stdin!.write(JSON.stringify(obj) + '\n');
      } catch {
        finish(null);
      }
    };

    child.on('error', () => finish(null));
    child.on('exit', () => finish(settled ? null : null));

    child.stdout!.on('data', (d: Buffer) => {
      buf += d.toString();
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        let msg: Rpc;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.method) continue; // agent-side notification, ignore
        if (msg.id === 1) {
          // initialized → authenticate with the token the CLI already cached
          send({ jsonrpc: '2.0', id: 2, method: 'authenticate', params: { methodId: 'cached_token' } } as Rpc);
        } else if (msg.id === 2) {
          if (msg.error) {
            finish(null);
            return;
          }
          send({ jsonrpc: '2.0', id: 3, method: '_x.ai/billing', params: {} } as Rpc);
        } else if (msg.id === 3) {
          finish(msg.error ? null : parseBilling(msg.result));
          return;
        }
      }
    });

    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: 1, clientCapabilities: {} },
    } as Rpc);
  });
}

function parseBilling(result: any): GrokBilling | null {
  const c = result?.config;
  if (!c || typeof c.creditUsagePercent !== 'number') return null;
  return {
    creditUsagePercent: c.creditUsagePercent,
    periodStart: c.billingPeriodStart ?? c.currentPeriod?.start ?? null,
    periodEnd: c.billingPeriodEnd ?? c.currentPeriod?.end ?? null,
    onDemandCap: typeof c.onDemandCap?.val === 'number' ? c.onDemandCap.val : null,
    onDemandUsed: typeof c.onDemandUsed?.val === 'number' ? c.onDemandUsed.val : null,
    subscriptionTier: typeof result.subscription_tier === 'string' ? result.subscription_tier : null,
  };
}

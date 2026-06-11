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

export interface GrokBillingFailure {
  ok: false;
  // spawn = binary missing/unstartable; exit = died mid-handshake; rpc = agent answered with an error
  kind: 'spawn' | 'timeout' | 'exit' | 'rpc' | 'parse';
  message: string | null;
  /** last stderr bytes, whitespace-collapsed, capped, jwt-scrubbed — safe for card detail */
  stderr: string | null;
}

export type GrokBillingResult = { ok: true; billing: GrokBilling } | GrokBillingFailure;

const STDERR_CAP = 200;

// stderr ends up in card detail/snapshot: scrub anything jwt-shaped before it leaves
function stderrSnippet(raw: string): string | null {
  const s = raw
    .replace(/eyJ[\w-]{8,}\.[\w-]+\.[\w-]+/g, '<jwt>')
    .replace(/\s+/g, ' ')
    .trim();
  if (!s) return null;
  return s.length > STDERR_CAP ? `…${s.slice(-STDERR_CAP)}` : s;
}

interface Rpc {
  jsonrpc: '2.0';
  id?: number;
  method?: string;
  result?: any;
  error?: { code: number; message: string };
}

/** Spawn the grok ACP agent, run the handshake, return live billing — or a typed failure. */
export function getGrokBillingDetailed(timeoutMs = 25_000): Promise<GrokBillingResult> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    let errBuf = '';
    try {
      // a neutral cwd: don't let the agent try to index whatever dir the daemon
      // was launched from (systemd leaves it at /). --no-leader avoids attaching
      // to a running grok leader socket (different lifecycle, can race the kill).
      child = spawn(config.paths.grokBin, ['agent', '--no-leader', 'stdio'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: tmpdir(),
      });
    } catch (err) {
      resolve({ ok: false, kind: 'spawn', message: err instanceof Error ? err.message : String(err), stderr: null });
      return;
    }

    let settled = false;
    let buf = '';
    const finish = (val: GrokBillingResult) => {
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
    const fail = (kind: GrokBillingFailure['kind'], message: string | null) =>
      finish({ ok: false, kind, message, stderr: stderrSnippet(errBuf) });

    const timer = setTimeout(() => fail('timeout', `no billing reply in ${timeoutMs}ms`), timeoutMs);
    const send = (obj: Rpc) => {
      try {
        child.stdin!.write(JSON.stringify(obj) + '\n');
      } catch {
        fail('exit', 'stdin write failed');
      }
    };

    child.stderr!.on('data', (d: Buffer) => {
      errBuf = (errBuf + d.toString()).slice(-2048); // tail only, unbounded child noise must not grow
    });
    child.on('error', (err) => fail('spawn', err.message));
    child.on('exit', (code) => fail('exit', code == null ? 'killed by signal' : `exit code ${code}`));

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
          if (msg.error) {
            fail('rpc', `initialize: ${msg.error.message}`);
            return;
          }
          // initialized → authenticate with the token the CLI already cached
          send({ jsonrpc: '2.0', id: 2, method: 'authenticate', params: { methodId: 'cached_token' } } as Rpc);
        } else if (msg.id === 2) {
          if (msg.error) {
            fail('rpc', `authenticate: ${msg.error.message}`);
            return;
          }
          send({ jsonrpc: '2.0', id: 3, method: '_x.ai/billing', params: {} } as Rpc);
        } else if (msg.id === 3) {
          if (msg.error) {
            fail('rpc', `_x.ai/billing: ${msg.error.message}`);
            return;
          }
          const billing = parseBilling(msg.result);
          if (billing) finish({ ok: true, billing });
          else fail('parse', 'unexpected billing response shape');
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

/** Back-compat shape: live billing or null on any failure. */
export function getGrokBilling(timeoutMs = 25_000): Promise<GrokBilling | null> {
  return getGrokBillingDetailed(timeoutMs).then((r) => (r.ok ? r.billing : null));
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

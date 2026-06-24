import { defineConfig, loadEnv, type Plugin, type ViteDevServer } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Dev-only CCTP bridge endpoint.
 *
 * Circle's Bridge Kit is built for server-side use: it signs with a raw key and
 * talks to Circle + chain RPCs with a custom `x-user-agent` header that browser
 * CORS forbids. So the bridge runs here, in the Vite dev server (Node), and the
 * browser calls it same-origin. In production an integrator runs the same
 * `bridgeUsdc` from a backend or a relayer, never from the page.
 *
 * It signs with a funded demo key, so it is hardened even though it is dev-only:
 * allowlisted chains, a hard amount cap, same-origin only, a body-size limit, and
 * generic error responses. Never expose this server with `--host`.
 */

const BRIDGE_CHAIN_IDS = new Set([
  'Arc_Testnet',
  'Ethereum_Sepolia',
  'Base_Sepolia',
  'Arbitrum_Sepolia',
  'Optimism_Sepolia',
  'Avalanche_Fuji',
  'Polygon_Amoy_Testnet',
  'Unichain_Sepolia',
  'Linea_Sepolia',
  'Sonic_Testnet',
  'World_Chain_Sepolia',
]);
const MAX_BRIDGE_AMOUNT = 5; // USDC, testnet demo ceiling
const MAX_BODY_BYTES = 4 * 1024;

/** Reject cross-site requests: the demo browser calls this same-origin only. */
function isSameOrigin(req: { headers: Record<string, string | string[] | undefined> }): boolean {
  const site = req.headers['sec-fetch-site'];
  if (typeof site === 'string' && site !== 'same-origin' && site !== 'none') return false;
  const origin = req.headers.origin;
  if (typeof origin === 'string') {
    try {
      const host = new URL(origin).hostname;
      if (host !== 'localhost' && host !== '127.0.0.1') return false;
    } catch {
      return false;
    }
  }
  return true;
}

function bridgeApi(env: Record<string, string>): Plugin {
  return {
    name: 'ctrl-arcz-bridge-api',
    configureServer(server: ViteDevServer) {
      server.middlewares.use('/api/bridge', async (req, res) => {
        const send = (status: number, body: unknown) => {
          res.statusCode = status;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify(body, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
        };
        if (req.method !== 'POST') return send(405, { error: 'method not allowed' });
        if (!isSameOrigin(req as never)) return send(403, { error: 'forbidden' });
        try {
          const chunks: Buffer[] = [];
          let size = 0;
          for await (const c of req) {
            size += (c as Buffer).length;
            if (size > MAX_BODY_BYTES) return send(413, { error: 'payload too large' });
            chunks.push(c as Buffer);
          }

          let parsed: { from?: unknown; to?: unknown; amount?: unknown };
          try {
            parsed = JSON.parse(Buffer.concat(chunks).toString() || '{}');
          } catch {
            return send(400, { error: 'invalid json' });
          }
          const { from, to, amount } = parsed;

          if (typeof from !== 'string' || !BRIDGE_CHAIN_IDS.has(from))
            return send(400, { error: 'invalid source chain' });
          if (typeof to !== 'string' || !BRIDGE_CHAIN_IDS.has(to))
            return send(400, { error: 'invalid destination chain' });
          if (from === to) return send(400, { error: 'source and destination must differ' });
          const amt =
            typeof amount === 'string' || typeof amount === 'number' ? Number(amount) : NaN;
          if (!Number.isFinite(amt) || amt <= 0 || amt > MAX_BRIDGE_AMOUNT)
            return send(400, { error: 'invalid amount' });

          const privateKey = env.VITE_DEMO_PK;
          if (!privateKey) return send(400, { error: 'no demo key configured' });
          const mod = (await server.ssrLoadModule('@ctrl-arcz/demo-kit/cctp')) as {
            bridgeUsdc: (p: unknown) => Promise<unknown>;
          };
          const result = await mod.bridgeUsdc({ privateKey, from, to, amount: String(amount) });
          return send(200, result);
        } catch (e) {
          // Log the detail server-side; return a generic message (no RPC/stack leak).
          server.config.logger.error(`/api/bridge failed: ${e instanceof Error ? e.message : e}`);
          return send(502, { error: 'bridge failed' });
        }
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  return {
    plugins: [react(), bridgeApi(env)],
    server: { port: 5173, strictPort: true },
  };
});

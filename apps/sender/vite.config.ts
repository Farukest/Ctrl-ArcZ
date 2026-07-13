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
const SECRET_ENV = ['VITE_DEMO_PK', 'VITE_RELAYER_PK', 'VITE_CLIENT_KEY'];

/**
 * Vite inlines every VITE_-prefixed value into the client bundle at build time, so
 * a signing key set at build is public. The demo runs on the dev server (that is
 * where /api/bridge lives), not a prod build, so a production build should not ship
 * keys. Refuse to build with any secret key present unless the operator explicitly
 * acknowledges it with VITE_ALLOW_DEMO_KEYS=1 (throwaway testnet keys only, rotated,
 * never real-value). Turns "never in production" from a comment into enforcement.
 */
function assertNoLeakedSecrets(env: Record<string, string>, command: string): void {
  if (command !== 'build' || env.VITE_ALLOW_DEMO_KEYS === '1') return;
  const present = SECRET_ENV.filter((k) => env[k]);
  if (present.length > 0) {
    throw new Error(
      `Refusing to build: ${present.join(', ')} would be inlined into the client bundle. ` +
        `Set VITE_ALLOW_DEMO_KEYS=1 to acknowledge (throwaway testnet keys only), ` +
        `or unset them and sign server-side.`,
    );
  }
}

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
const GATEWAY_CHAIN_IDS = new Set([
  'Arc_Testnet',
  'Ethereum_Sepolia',
  'Base_Sepolia',
  'Avalanche_Fuji',
  'Sonic_Testnet',
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

/**
 * Shared handler for the two cross-chain endpoints. Both validate identically
 * (allowlisted chains, amount cap, same-origin, body cap) and only differ in the
 * server module they run: CCTP (bridgeUsdc) or Gateway (gatewayTransfer).
 */
function crossChainApi(
  env: Record<string, string>,
  route: string,
  moduleId: string,
  fn: string,
  label: string,
  allowedChains: Set<string>,
): Plugin {
  return {
    name: `ctrl-arcz-api-${label}`,
    configureServer(server: ViteDevServer) {
      server.middlewares.use(route, async (req, res) => {
        const send = (status: number, body: unknown) => {
          res.statusCode = status;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify(body, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
        };
        if (req.method !== 'POST') return send(405, { error: 'method not allowed' });
        if (!isSameOrigin(req as never)) return send(403, { error: 'forbidden' });
        try {
          const chunks: Uint8Array[] = [];
          let size = 0;
          for await (const c of req) {
            const chunk = c as Uint8Array;
            size += chunk.length;
            if (size > MAX_BODY_BYTES) return send(413, { error: 'payload too large' });
            chunks.push(chunk);
          }

          let parsed: { from?: unknown; to?: unknown; amount?: unknown };
          try {
            parsed = JSON.parse(Buffer.concat(chunks).toString() || '{}');
          } catch {
            return send(400, { error: 'invalid json' });
          }
          const { from, to, amount } = parsed;

          if (typeof from !== 'string' || !allowedChains.has(from))
            return send(400, { error: 'invalid source chain' });
          if (typeof to !== 'string' || !allowedChains.has(to))
            return send(400, { error: 'invalid destination chain' });
          if (from === to) return send(400, { error: 'source and destination must differ' });
          const amt =
            typeof amount === 'string' || typeof amount === 'number' ? Number(amount) : NaN;
          if (!Number.isFinite(amt) || amt <= 0 || amt > MAX_BRIDGE_AMOUNT)
            return send(400, { error: 'invalid amount' });

          const privateKey = env.VITE_DEMO_PK;
          if (!privateKey) return send(400, { error: 'no demo key configured' });
          const mod = (await server.ssrLoadModule(moduleId)) as Record<
            string,
            (p: unknown) => Promise<unknown>
          >;
          const result = await mod[fn]!({ privateKey, from, to, amount: String(amount) });
          return send(200, result);
        } catch (e) {
          server.config.logger.error(`${route} failed: ${e instanceof Error ? e.message : e}`);
          return send(502, { error: `${label} failed` });
        }
      });
    },
  };
}

export default defineConfig(({ command, mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  assertNoLeakedSecrets(env, command);
  return {
    plugins: [
      react(),
      crossChainApi(
        env,
        '/api/bridge',
        '@ctrl-arcz/demo-kit/cctp',
        'bridgeUsdc',
        'bridge',
        BRIDGE_CHAIN_IDS,
      ),
      crossChainApi(
        env,
        '/api/gateway',
        '@ctrl-arcz/demo-kit/gateway',
        'gatewayTransfer',
        'gateway',
        GATEWAY_CHAIN_IDS,
      ),
    ],
    server: { port: 5173, strictPort: true },
  };
});

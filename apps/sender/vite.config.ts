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
 * where /api/cosign lives), not a prod build, so a production build should not ship
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

const MAX_BODY_BYTES = 4 * 1024;

/** Reject cross-site requests: the demo browser calls this same-origin only. In
 *  production the site runs on PUBLIC_HOST (e.g. ctrlarcz.xyz), so allow that too. */
function isSameOrigin(req: { headers: Record<string, string | string[] | undefined> }): boolean {
  const site = req.headers['sec-fetch-site'];
  if (typeof site === 'string' && site !== 'same-origin' && site !== 'none') return false;
  const origin = req.headers.origin;
  if (typeof origin === 'string') {
    try {
      const host = new URL(origin).hostname;
      const allowed = new Set(['localhost', '127.0.0.1']);
      const pub = process.env.PUBLIC_HOST;
      if (pub) {
        allowed.add(pub);
        allowed.add(`www.${pub}`);
      }
      if (!allowed.has(host)) return false;
    } catch {
      return false;
    }
  }
  return true;
}

/**
 * The co-signer ("The Machine") endpoint. Holds the enclave key server-side and,
 * on each spend request, validates it against the account's on-chain policy and
 * the poisoning firewall, then returns the second signature or a veto. GET returns
 * the co-signer's public address so the browser can lock it into new accounts.
 */
function cosignApi(env: Record<string, string>): Plugin {
  return {
    name: 'ctrl-arcz-api-cosign',
    configureServer(server: ViteDevServer) {
      server.middlewares.use('/api/cosign', async (req, res) => {
        const send = (status: number, body: unknown) => {
          res.statusCode = status;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify(body, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
        };
        if (!isSameOrigin(req as never)) return send(403, { error: 'forbidden' });
        const privateKey = env.COSIGNER_PK;
        if (!privateKey) return send(400, { error: 'no co-signer key configured' });
        try {
          const mod = (await server.ssrLoadModule('@ctrl-arcz/demo-kit/cosign')) as {
            cosign: (p: { privateKey: string; body: unknown }) => Promise<unknown>;
            cosignerAddress: (pk: string) => string;
          };
          if (req.method === 'GET') return send(200, { address: mod.cosignerAddress(privateKey) });
          if (req.method !== 'POST') return send(405, { error: 'method not allowed' });

          const chunks: Uint8Array[] = [];
          let size = 0;
          for await (const c of req) {
            const chunk = c as Uint8Array;
            size += chunk.length;
            if (size > MAX_BODY_BYTES) return send(413, { error: 'payload too large' });
            chunks.push(chunk);
          }
          let body: unknown;
          try {
            body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
          } catch {
            return send(400, { error: 'invalid json' });
          }
          const result = await mod.cosign({ privateKey, body });
          return send(200, result);
        } catch (e) {
          server.config.logger.error(`/api/cosign failed: ${e instanceof Error ? e.message : e}`);
          return send(502, { error: 'co-signer failed' });
        }
      });
    },
  };
}

export default defineConfig(({ command, mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  assertNoLeakedSecrets(env, command);
  return {
    plugins: [react(), cosignApi(env)],
    server: {
      port: Number(process.env.PORT) || 5173,
      strictPort: true,
      // In production the app runs behind an nginx reverse proxy on PUBLIC_HOST.
      ...(process.env.HOST ? { host: process.env.HOST } : {}),
      ...(process.env.PUBLIC_HOST
        ? { allowedHosts: [process.env.PUBLIC_HOST, `www.${process.env.PUBLIC_HOST}`] }
        : {}),
      // Disable HMR in production so no websocket needs proxying through nginx.
      ...(process.env.NO_HMR ? { hmr: false as const } : {}),
      // The dev server answers a couple of /api routes from plugins above, and
      // nothing else -- so subscriptions, private pay, the stealth relay and the
      // gasless claim all 404 here while looking perfectly healthy in the UI. The
      // 404 surfaces as a generic failure toast, which is a long way from "the
      // dev server has no backend". Forward the rest to the real API, exactly as
      // preview and nginx do, so `pnpm dev:sender` exercises the same paths
      // production does.
      proxy: {
        '/api': {
          target: `http://127.0.0.1:${process.env.API_PORT || 8787}`,
          changeOrigin: false,
        },
      },
    },
    // Production serves a static build via `vite preview` behind the same nginx
    // proxy, so it needs the same host allow-list as the dev server above (preview
    // uses its own config block, not `server`). Without this, preview answers the
    // proxied Host with a 403 "host not allowed".
    preview: {
      port: Number(process.env.PORT) || 5173,
      strictPort: true,
      ...(process.env.HOST ? { host: process.env.HOST } : {}),
      ...(process.env.PUBLIC_HOST
        ? { allowedHosts: [process.env.PUBLIC_HOST, `www.${process.env.PUBLIC_HOST}`] }
        : {}),
      // Preview does not run the dev server's /api middleware, so a local preview
      // has no backend at all and every relayer-funded flow 404s. Forward /api to
      // the real API service, which is exactly what nginx does in production. Inert
      // when deployed: nginx answers /api before a request can reach preview.
      proxy: {
        '/api': {
          target: `http://127.0.0.1:${process.env.API_PORT || 8787}`,
          changeOrigin: false,
        },
      },
    },
  };
});

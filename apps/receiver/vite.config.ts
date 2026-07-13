import { defineConfig, loadEnv, type Plugin, type ViteDevServer } from 'vite';
import react from '@vitejs/plugin-react';

const SECRET_ENV = ['VITE_DEMO_PK', 'VITE_RELAYER_PK', 'VITE_CLIENT_KEY'];

/**
 * Vite inlines every VITE_-prefixed value into the client bundle at build time,
 * so a signing key set at build is public. The demo runs on the dev server, not a
 * prod build, so a production build should not ship keys. Refuse to build with any
 * secret key present unless the operator explicitly acknowledges it with
 * VITE_ALLOW_DEMO_KEYS=1 (throwaway testnet keys only, rotated, never real-value).
 * Turns "never in production" from a comment into an enforced, opt-in decision.
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
 * Dev-only gasless-claim endpoint. Circle Gas Station sponsors the recipient's gas
 * via a smart account owned by a relayer key. That key and the Circle client key
 * are secrets, so the claim is signed HERE, in the Vite dev server (Node), and the
 * browser only posts { transferId, code, salt }. The keys never reach the client
 * bundle. In production an integrator runs the same helper from a real backend.
 */
function gaslessApi(env: Record<string, string>): Plugin {
  return {
    name: 'ctrl-arcz-gasless-api',
    configureServer(server: ViteDevServer) {
      server.middlewares.use('/api/gasless-claim', async (req, res) => {
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

          let parsed: { transferId?: unknown; code?: unknown; salt?: unknown };
          try {
            parsed = JSON.parse(Buffer.concat(chunks).toString() || '{}');
          } catch {
            return send(400, { error: 'invalid json' });
          }
          const { transferId, code, salt } = parsed;
          if (typeof transferId !== 'string' || !/^\d{1,78}$/.test(transferId))
            return send(400, { error: 'invalid transferId' });
          if (typeof code !== 'string' || !/^\d{6}$/.test(code))
            return send(400, { error: 'invalid code' });
          if (typeof salt !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(salt))
            return send(400, { error: 'invalid salt' });

          const cfg = {
            clientKey: env.VITE_CLIENT_KEY,
            clientUrl: env.VITE_CLIENT_URL,
            ownerKey: env.VITE_RELAYER_PK as `0x${string}` | undefined,
          };
          if (!cfg.ownerKey) return send(400, { error: 'gasless not configured' });

          const mod = (await server.ssrLoadModule('@ctrl-arcz/demo-kit/gasless')) as {
            gaslessClaimToResult: (
              c: unknown,
              t: bigint,
              code: string,
              salt: string,
            ) => Promise<unknown>;
          };
          const result = await mod.gaslessClaimToResult(cfg, BigInt(transferId), code, salt);
          return send(200, result);
        } catch (e) {
          server.config.logger.error(
            `/api/gasless-claim failed: ${e instanceof Error ? e.message : e}`,
          );
          return send(502, {
            ok: false,
            error: { kind: 'unknown', message: 'gasless claim failed' },
          });
        }
      });
    },
  };
}

export default defineConfig(({ command, mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  assertNoLeakedSecrets(env, command);
  return {
    plugins: [react(), gaslessApi(env)],
    server: { port: 5174, strictPort: true },
  };
});

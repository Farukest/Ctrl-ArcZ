import { serve, json } from './http.js';
import { cosignGet, cosignPost, bridgePost, gatewayPost, gaslessPost } from './handlers.js';
import { registerHandler } from './notifications.js';
import { startWatcher } from './watcher.js';

/**
 * The Ctrl+ArcZ backend. One service for the web and mobile apps: the enclave
 * co-signer, the cross-chain bridge and gasless claim (server-held keys), device
 * push registration, and the Arc event watcher that delivers notifications.
 */
serve({
  'GET /api/health': (_req, res) => json(res, 200, { ok: true }),

  // The Machine
  'GET /api/cosign': cosignGet,
  'POST /api/cosign': cosignPost,

  // Cross-chain (server-held relayer key)
  'POST /api/bridge': bridgePost,
  'POST /api/gateway': gatewayPost,
  'POST /api/gasless-claim': gaslessPost,

  // Notifications
  'POST /api/notifications/register': registerHandler,
});

startWatcher();

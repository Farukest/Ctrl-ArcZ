import { serve, json } from './http.js';
import {
  cosignGet,
  cosignPost,
  bridgePost,
  gatewayPost,
  gaslessPost,
  relayCreatePost,
  relayAnnouncePost,
  relayGasPost,
} from './handlers.js';
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

  // Stealth relay: the box's deploy and announcement go out as the relayer, so
  // neither names the payer. Funding still comes from the payer's own wallet.
  'POST /api/relay/create': relayCreatePost,
  'POST /api/relay/announce': relayAnnouncePost,
  'POST /api/relay/gas': relayGasPost,

  // Notifications
  'POST /api/notifications/register': registerHandler,
});

startWatcher();

import { serve } from './http.js';
import {
  cosignGet,
  cosignPost,
  bridgePost,
  gatewayPost,
  gaslessPost,
  relayCreatePost,
  relayAnnouncePost,
  relayGasPost,
  investigatePost,
  bridgeJobGet,
  healthGet,
  verifiedRecipientsGet,
  announcementsGet,
} from './handlers.js';
import { registerHandler } from './notifications.js';
import { startWatcher } from './watcher.js';

/**
 * The Ctrl+ArcZ backend. One service for the web and mobile apps: the enclave
 * co-signer, the cross-chain bridge and gasless claim (server-held keys), device
 * push registration, and the Arc event watcher that delivers notifications.
 */
serve({
  'GET /api/health': healthGet,

  // The Machine
  'GET /api/cosign': cosignGet,
  'GET /api/verified-recipients': verifiedRecipientsGet,
  'GET /api/announcements': announcementsGet,
  'POST /api/cosign': cosignPost,

  // Cross-chain (server-held relayer key)
  'POST /api/bridge': bridgePost,
  'POST /api/gateway': gatewayPost,
  // The state of one transfer, for a client that left and came back. Serves both
  // engines: a Gateway transfer is a bridge as far as anyone using this is concerned.
  'GET /api/bridge/:jobId': bridgeJobGet,
  'POST /api/gasless-claim': gaslessPost,

  // Stealth relay: the box's deploy and announcement go out as the relayer, so
  // neither names the payer. Funding still comes from the payer's own wallet.
  'POST /api/relay/create': relayCreatePost,
  'POST /api/relay/announce': relayAnnouncePost,
  'POST /api/relay/gas': relayGasPost,

  // Advisory only, and it can only ever tighten a verdict — never weaken one.
  'POST /api/investigate': investigatePost,

  // Notifications
  'POST /api/notifications/register': registerHandler,
});

startWatcher();

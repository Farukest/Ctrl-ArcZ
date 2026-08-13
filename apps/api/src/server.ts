import { serve } from './http.js';
import {
  cosignGet,
  cosignPost,
  gaslessPost,
  relayCreatePost,
  relayAnnouncePost,
  relayGasPost,
  investigatePost,
  healthGet,
  verifiedRecipientsGet,
  announcementsGet,
} from './handlers.js';
/**
 * The Ctrl+ArcZ backend. One service for every client: the enclave co-signer, the
 * gasless claim (server-held keys), the stealth relay, and the two undirected
 * indexes discovery reads from.
 *
 * Nothing here bridges. Both clients moved cross-chain transfers to the wallet
 * that owns the money: the web app signs the CCTP burn and the Gateway spend in
 * the browser, and the Android client does the same on the device. The routes that
 * used to do it from the relayer's own balance are gone with them, and with them a
 * way to spend the key the relay and the gasless claim depend on.
 *
 * There is deliberately no push notification path here. It existed for the Expo
 * app, which the native Android client replaced; that client watches the chain
 * itself, so a server holding device tokens would be a registry of who is being
 * paid, kept for nobody.
 */
serve({
  'GET /api/health': healthGet,

  // The Machine
  'GET /api/cosign': cosignGet,
  'GET /api/verified-recipients': verifiedRecipientsGet,
  'GET /api/announcements': announcementsGet,
  'POST /api/cosign': cosignPost,

  'POST /api/gasless-claim': gaslessPost,

  // Stealth relay: the box's deploy and announcement go out as the relayer, so
  // neither names the payer. Neither does the funding any more: both clients pay
  // the box from the payer's Circle Gateway balance, so what Arc records is a mint
  // from Circle's minter rather than a transfer out of the payer's wallet.
  'POST /api/relay/create': relayCreatePost,
  'POST /api/relay/announce': relayAnnouncePost,
  'POST /api/relay/gas': relayGasPost,

  // Advisory only, and it can only ever tighten a verdict — never weaken one.
  'POST /api/investigate': investigatePost,
});

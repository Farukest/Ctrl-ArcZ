import { setDefaultResultOrder } from 'node:dns';
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
  chainDataPost,
  nanoSessionPost,
  nanoStateGet,
  nanoMessagesPost,
  nanoWithdrawPost,
} from './handlers.js';

// IPv4 first. The server has both families, and BlockRun (the pay-per-request
// Claude service, behind Google's front end) answers its IPv6 address with 403
// while taking IPv4. Node tried IPv6 first, so every paid request failed there
// and nowhere else.
setDefaultResultOrder('ipv4first');
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

  'POST /api/chain-data': chainDataPost,

  // Pay-per-request Claude: each request is paid from the caller's agent wallet
  // with a Circle Gateway nanopayment, at the moment it is made.
  'POST /api/nano/session': nanoSessionPost,
  'GET /api/nano/state': nanoStateGet,
  'POST /api/nano/v1/messages': nanoMessagesPost,
  'POST /api/nano/withdraw': nanoWithdrawPost,
});

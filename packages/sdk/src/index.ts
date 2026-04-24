/**
 * Ctrl+ArcZ SDK — protected USDC transfers on Arc.
 *
 * Three layers, in the order that matters:
 *   1. risk/     — the pre-send firewall. The actual poisoning protection: a
 *                  victim sends to a lookalike address *on purpose*, so locking
 *                  the funds afterwards does not save them. Only refusing does.
 *   2. transfer/ — code-gated claim, sender cancel, automatic refund. This is
 *                  what replaces the "send $1 first and wait" ritual.
 *   3. history/  — a spam-free history, so the fake address is never sitting
 *                  there waiting to be copied.
 */

export * from './chains/arcTestnet.js';
export { ctrlArcZAbi, codeClaimVerifierAbi, memoAbi } from './abi/ctrlArcZ.js';
export { getLogsChunked, type ChunkedEventsParams } from './events.js';

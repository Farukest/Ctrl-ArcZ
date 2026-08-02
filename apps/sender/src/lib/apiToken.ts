import type { Session } from '@ctrl-arcz/demo-kit';
import { signedPost } from './signedPost.js';

/**
 * One wallet signature per session, reused by the read-only API routes.
 *
 * `signedPost` asks the wallet to sign every single call, which is right for the
 * routes that move money and wrong for the investigator: the firewall consults it
 * about every address the user types, so a per-check MetaMask prompt is both
 * constant and meaningless. A user who is asked to sign fifteen times while
 * filling in one form stops reading the prompts, and the next one they wave
 * through is a real transaction.
 *
 * So the wallet proves itself once and the token carries that proof. It is held
 * in memory only, never written to storage, and dropped when the wallet changes.
 */

interface Token {
  address: string;
  token: string;
  expiresAt: number;
}

let current: Token | null = null;
let inflight: Promise<string | null> | null = null;

/** A token good for at least another minute, or null if one cannot be obtained. */
export async function apiToken(session: Session): Promise<string | null> {
  const address = session.address.toLowerCase();
  if (current && current.address === address && Date.now() < current.expiresAt - 60_000) {
    return current.token;
  }
  // Concurrent callers must not each trigger their own signature prompt.
  if (inflight) return inflight;

  inflight = signedPost<{ token: string; expiresAt: number }>(session, '/api/session', {})
    .then((res) => {
      current = { address, token: res.token, expiresAt: res.expiresAt };
      return res.token;
    })
    .catch(() => null)
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/** Forget the token — on wallet change or disconnect. */
export function clearApiToken(): void {
  current = null;
}

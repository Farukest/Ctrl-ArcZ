import { deriveStealthKeys, STEALTH_KEY_MESSAGE, type StealthKeys } from '@ctrl-arcz/sdk';
import type { Session } from '@ctrl-arcz/demo-kit';

/**
 * The connected wallet's stealth keys, derived once from a single signature over a
 * fixed message and cached for the session. The signature is deterministic (RFC
 * 6979), so the same wallet always yields the same keys: nothing is stored, the
 * private keys never leave the browser, and re-connecting rederives them.
 *
 * Used to create subscriptions whose on-chain owner/vault is a fresh stealth address
 * (no `keccak(yourAddress)` tag) and to rediscover those boxes by scanning the
 * announcer with the viewing key.
 */
const cache = new Map<string, Promise<StealthKeys>>();

/**
 * Wallets whose owner refused the signature.
 *
 * A refusal used only to drop the cache, so the very next caller prompted again.
 * That is harmless when one caller asks once, and one caller does not: after a box
 * is created, discovery retries five times two seconds apart, so a single "no"
 * became five more wallet dialogs. A refusal is an answer. It is remembered,
 * callers are rejected without a dialog, and asking again takes a deliberate click.
 */
const declined = new Set<string>();

export class StealthKeysDeclinedError extends Error {
  constructor() {
    super('The wallet declined to derive stealth keys.');
    this.name = 'StealthKeysDeclinedError';
  }
}

/** EIP-1193 user rejection. Anything else is a real failure, and worth retrying. */
function isUserRejection(e: unknown): boolean {
  const err = e as { code?: number; cause?: { code?: number } };
  return err?.code === 4001 || err?.cause?.code === 4001;
}

export function stealthKeysDeclined(address: string | undefined): boolean {
  return address ? declined.has(address.toLowerCase()) : false;
}

/** Forget a refusal, so the next `getStealthKeys` may prompt again. */
export function allowStealthPrompt(address: string | undefined): void {
  if (address) declined.delete(address.toLowerCase());
}

export function getStealthKeys(session: Session): Promise<StealthKeys> {
  const id = session.address.toLowerCase();
  if (declined.has(id)) return Promise.reject(new StealthKeysDeclinedError());

  let pending = cache.get(id);
  if (!pending) {
    pending = (async () => {
      const wallet = session.clients.walletClient;
      const account = wallet.account;
      if (!account) throw new Error('No wallet account to derive stealth keys from');
      const signature = await wallet.signMessage({ account, message: STEALTH_KEY_MESSAGE });
      return deriveStealthKeys(signature);
    })();
    // Drop a failed derivation so a transient error can be retried; remember a
    // refusal so the retry is the user's to ask for.
    pending.catch((e) => {
      cache.delete(id);
      if (isUserRejection(e)) declined.add(id);
    });
    cache.set(id, pending);
  }
  return pending;
}

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

export function getStealthKeys(session: Session): Promise<StealthKeys> {
  const id = session.address.toLowerCase();
  let pending = cache.get(id);
  if (!pending) {
    pending = (async () => {
      const wallet = session.clients.walletClient;
      const account = wallet.account;
      if (!account) throw new Error('No wallet account to derive stealth keys from');
      const signature = await wallet.signMessage({ account, message: STEALTH_KEY_MESSAGE });
      return deriveStealthKeys(signature);
    })();
    // Drop a rejected derivation (e.g. the user declined the signature) so the next
    // call can prompt again instead of resurfacing the same error.
    pending.catch(() => cache.delete(id));
    cache.set(id, pending);
  }
  return pending;
}

import { keccak256, toBytes, type Hex } from 'viem';
import type { Session } from '@ctrl-arcz/demo-kit';

/**
 * POST to an API route that spends the operator's funds (the bridge, the gateway,
 * the gasless relayer).
 *
 * Those routes refuse an anonymous caller: they want a signature over path,
 * timestamp and body hash. That identifies who is asking so each caller can be
 * quota-limited, and makes a captured request single-use, which is what keeps a
 * funded endpoint safe to expose. The cost is one wallet signature, not a
 * transaction.
 *
 * Every such call goes through here. Three separate hand-rolled fetches is how the
 * bridge ended up posting anonymously and failing with a 401 while gasless worked.
 */
export async function signedPost<T>(
  session: Session,
  path: string,
  payload: unknown,
): Promise<T> {
  const body = JSON.stringify(payload);
  const ts = String(Date.now());
  const message = `Ctrl+ArcZ API request\npath: ${path}\nts: ${ts}\nbody: ${keccak256(toBytes(body))}`;
  const account = session.clients.walletClient.account;
  if (!account) throw new Error('wallet has no account');
  const signature = await session.clients.walletClient.signMessage({ account, message });

  const res = await fetch(path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-ctrl-address': session.address,
      'x-ctrl-timestamp': ts,
      'x-ctrl-signature': signature as Hex,
    },
    body,
  });
  const data = (await res.json()) as T & { error?: unknown };
  if (!res.ok || (data && typeof data === 'object' && 'error' in data && data.error)) {
    const e = (data as { error?: unknown }).error;
    throw new Error(typeof e === 'string' ? e : `request failed (${res.status})`);
  }
  return data as T;
}

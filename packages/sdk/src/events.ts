import type { Abi, Address, Hex, PublicClient } from 'viem';
import { CTRL_ARCZ_DEPLOY_BLOCK, MAX_LOG_RANGE } from './chains/arcTestnet.js';

export interface ChunkedEventsParams {
  address: Address;
  abi: Abi;
  eventName: string;
  args?: Record<string, unknown>;
  /** Defaults to the CtrlArcZ deploy block. */
  fromBlock?: bigint;
  /** Defaults to the latest block. Lets an incremental indexer poll a bounded
   *  window instead of always scanning to head. */
  toBlock?: bigint;
}

export interface DecodedLog<TArgs> {
  args: TArgs;
  blockNumber: bigint | null;
  transactionHash: Hex | null;
}

/**
 * How many windows are in flight at once.
 *
 * The walk used to be strictly sequential, one `await` per window, which is the
 * right shape for correctness and the wrong one for a span of any size. Measured
 * on Arc: the stealth announcer's history is 2.19 million blocks, which is 219
 * windows at roughly 208ms each, so opening the subscriptions tab spent about 45
 * seconds fetching before it could say "you have none" -- and Arc produces about
 * two blocks a second, roughly 168,000 a day, so that wait grew by a few seconds
 * every day and never shrank.
 *
 * Eight is deliberately modest. The reason this file exists at all is Arc's
 * 10,000-block limit, and the reason the risk engine caches is that overlapping
 * scans once turned one slow response into RPC rate limiting app-wide. Eight
 * windows is a sixth of the wall-clock at a fraction of the burst a naive
 * `Promise.all` over 217 requests would produce.
 */
const CONCURRENCY = 8;

/**
 * Reads contract events across an arbitrary block span, respecting Arc's 10,000-
 * block `eth_getLogs` limit by walking the range in windows. Querying from block 0
 * (viem's default) fails on Arc with a -32614 range error, so both the risk engine
 * and the receiver demo go through here.
 *
 * Windows are fetched a few at a time but the result is assembled in block order,
 * because callers depend on it: discovery order is the only honest ordering a
 * stealth box has, and the first matching mint is the one a bridge recovers from.
 *
 * @typeParam TArgs shape of the decoded event args, so callers stay type-safe.
 */
export async function getLogsChunked<TArgs = Record<string, unknown>>(
  client: PublicClient,
  params: ChunkedEventsParams,
): Promise<Array<DecodedLog<TArgs>>> {
  const end = params.toBlock ?? (await client.getBlockNumber());
  const start = params.fromBlock ?? CTRL_ARCZ_DEPLOY_BLOCK;

  const windows: Array<{ from: bigint; to: bigint }> = [];
  for (let from = start; from <= end; from += MAX_LOG_RANGE) {
    const to = from + MAX_LOG_RANGE - 1n < end ? from + MAX_LOG_RANGE - 1n : end;
    windows.push({ from, to });
  }

  // Indexed by window, so the flatten below restores block order regardless of
  // which request finished first.
  const results: Array<Array<DecodedLog<TArgs>>> = new Array(windows.length);
  let next = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const i = next++;
      const w = windows[i];
      if (!w) return;
      const logs = await client.getContractEvents({
        address: params.address,
        abi: params.abi,
        eventName: params.eventName,
        ...(params.args ? { args: params.args } : {}),
        fromBlock: w.from,
        toBlock: w.to,
      });
      results[i] = logs as unknown as Array<DecodedLog<TArgs>>;
    }
  }

  // One rejection fails the whole read, exactly as the sequential loop did: a
  // partial log scan is what the firewall must never mistake for a complete one.
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, windows.length) }, () => worker()),
  );

  return results.flat();
}

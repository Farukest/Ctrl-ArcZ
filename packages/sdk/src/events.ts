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
 * Reads contract events across an arbitrary block span, respecting Arc's 10,000-
 * block `eth_getLogs` limit by walking the range in windows. Querying from block 0
 * (viem's default) fails on Arc with a -32614 range error, so both the risk engine
 * and the receiver demo go through here.
 *
 * @typeParam TArgs shape of the decoded event args, so callers stay type-safe.
 */
export async function getLogsChunked<TArgs = Record<string, unknown>>(
  client: PublicClient,
  params: ChunkedEventsParams,
): Promise<Array<DecodedLog<TArgs>>> {
  const end = params.toBlock ?? (await client.getBlockNumber());
  const start = params.fromBlock ?? CTRL_ARCZ_DEPLOY_BLOCK;

  const all: Array<DecodedLog<TArgs>> = [];
  for (let from = start; from <= end; from += MAX_LOG_RANGE) {
    const to = from + MAX_LOG_RANGE - 1n < end ? from + MAX_LOG_RANGE - 1n : end;
    const logs = await client.getContractEvents({
      address: params.address,
      abi: params.abi,
      eventName: params.eventName,
      ...(params.args ? { args: params.args } : {}),
      fromBlock: from,
      toBlock: to,
    });
    all.push(...(logs as unknown as Array<DecodedLog<TArgs>>));
  }
  return all;
}

import {
  AlchemyDataProvider,
  BlockscoutDataProvider,
  alchemyRpcUrl,
  historySourceFor,
  readRpcUrls,
  type IDataProvider,
} from '@ctrl-arcz/sdk';

/**
 * A chain's history source, as a server reads it. Server-only: the Alchemy branch
 * puts the key in the URL, which must never reach a browser bundle.
 *
 * Throws where the chain has no source, or where its source needs a key this
 * server was not given. Both are refusals the firewall turns into "cannot judge",
 * which is the fail-closed outcome; neither falls back to another chain's data.
 */
export function serverDataProvider(
  chainId: number,
  alchemyApiKey: string | undefined = process.env.ALCHEMY_API_KEY,
): IDataProvider {
  const source = historySourceFor(chainId);
  if (!source) throw new Error(`no transaction history source for chain ${chainId}`);
  if (source.kind === 'blockscout') return new BlockscoutDataProvider({ apiUrl: source.apiUrl });
  if (!alchemyApiKey)
    throw new Error(`chain ${chainId} reads history from Alchemy and no key is set`);
  return new AlchemyDataProvider({ rpcUrl: alchemyRpcUrl(source.network, alchemyApiKey) });
}

/**
 * The endpoints a server reads a chain through, best first. Server-only.
 *
 * Alchemy leads where this server has a key for the chain: the public endpoints
 * rate-limit a busy server into partial scans, and a partial scan is a firewall
 * that cannot say "safe" (measured: the recipient index and the lookalike rule both
 * came back incomplete under load). The public list stays behind it as fallback.
 */
export function serverReadRpcUrls(
  chainId: number,
  alchemyApiKey: string | undefined = process.env.ALCHEMY_API_KEY,
): string[] {
  const alchemy = serverAlchemyUrl(chainId, alchemyApiKey);
  const rest = [...readRpcUrls(chainId)];
  return alchemy ? [alchemy, ...rest] : rest;
}

/** Alchemy's URL for a chain that reads from it, or undefined. Server-only. */
export function serverAlchemyUrl(
  chainId: number,
  alchemyApiKey: string | undefined = process.env.ALCHEMY_API_KEY,
): string | undefined {
  const source = historySourceFor(chainId);
  if (source?.kind !== 'alchemy' || !alchemyApiKey) return undefined;
  return alchemyRpcUrl(source.network, alchemyApiKey);
}

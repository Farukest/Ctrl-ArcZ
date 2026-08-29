import { erc20Abi, type Address } from 'viem';
import {
  ARC_TESTNET_CHAIN_ID,
  CCTP_CHAINS,
  cctpChainByChainId,
  readRpcUrls,
  type CctpChainName,
} from '@ctrl-arcz/sdk';
import { bridgeClients, getPublicClient } from './session.js';

/**
 * USDC a wallet holds on a chain, when it can be read from here at all.
 *
 * What decides that is whether this app can reach the chain on its own, not where
 * the wallet happens to be standing. A balance is a fact about an address on a
 * chain; it does not become unknowable because the wallet is pointed elsewhere.
 *
 * This used to refuse every non-Arc chain unless the wallet was already on it,
 * and the reasoning it carried had gone stale: reads for other chains did once go
 * through the wallet's provider, which answers only for its current network, so
 * asking it about Base Sepolia from Arc ran the call against Arc and returned
 * something that was not a balance. `bridgeClients` has since routed reads to
 * each chain's own published endpoints, and the refusal outlived the reason for
 * it. The cost was not theoretical: the deposit box showed no wallet balance for
 * Ethereum Sepolia or Arbitrum Sepolia, both of which have endpoints this app
 * dials perfectly well.
 *
 * Every one of the eleven Gateway chains has endpoints this app can dial, so in
 * practice the refusal below is now reserved for chains outside that set. It is
 * kept rather than dropped because the list is data: a chain can be added to the
 * app before anyone has found a public endpoint for it, and then the wallet's own
 * provider really is the only way in.
 *
 * Null means "cannot be read from where we are standing", and every caller renders
 * that as a held placeholder. Zero would be a claim about someone's money.
 */
export async function readUsdcOn(
  chain: CctpChainName,
  connectedChainId: number | undefined,
  address: Address,
): Promise<bigint | null> {
  const entry = CCTP_CHAINS[chain];
  const isArc = entry.chainId === ARC_TESTNET_CHAIN_ID;
  // Endpoints of its own mean the read does not need the wallet to be there.
  const reachable = readRpcUrls(entry.chainId).length > 0;
  if (!reachable && connectedChainId !== entry.chainId) return null;
  try {
    const client = isArc ? getPublicClient() : bridgeClients(entry.chainId, address).publicClient;
    return (await client.readContract({
      address: entry.usdc as Address,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [address],
    })) as bigint;
  } catch {
    return null;
  }
}

/**
 * What the wallet holds in the chain's own coin, which is what pays for gas there.
 *
 * A Gateway deposit is a real transaction on the chosen chain, so it needs that
 * chain's gas, and having USDC there says nothing about having any. Somebody who
 * bridged USDC onto Sonic and never touched Sonic before holds exactly zero S,
 * which is the ordinary case rather than the odd one: nothing about receiving USDC
 * gives you the coin the network charges in.
 *
 * Without this the app offered the deposit anyway and the first thing to notice was
 * MetaMask, which puts the amount, the contract and a red fee on screen and asks
 * the user to work out which part is wrong. The app knows before any of that.
 *
 * Arc is the exception and needs no caller to remember it: it bills gas in the USDC
 * being moved, so `gasToken` is set there and this is not asked.
 *
 * Null means the read could not be made, never zero. Zero is a claim.
 */
export async function readGasBalanceOn(
  chain: CctpChainName,
  address: Address,
): Promise<bigint | null> {
  const entry = CCTP_CHAINS[chain];
  if (readRpcUrls(entry.chainId).length === 0) return null;
  try {
    const client =
      entry.chainId === ARC_TESTNET_CHAIN_ID
        ? getPublicClient()
        : bridgeClients(entry.chainId, address).publicClient;
    return await client.getBalance({ address });
  } catch {
    return null;
  }
}

/**
 * What the connected wallet holds on the network it is actually on.
 *
 * The header used to answer this with Arc's balance no matter where the wallet
 * was, because the read named Arc's USDC and used Arc's RPC. On Ethereum Sepolia
 * it printed an Arc figure in the largest type on the page, under a header chip
 * that correctly said Ethereum Sepolia.
 *
 * `chain` is undefined on a network we have no USDC address for. That is not a
 * failure to read, it is having nothing to read, and the bar shows it as a figure
 * that is not coming rather than as one still loading.
 */
export async function readWalletUsdc(
  walletChainId: number | undefined,
  address: Address,
): Promise<{ chain: CctpChainName | undefined; balance: bigint | null }> {
  const chain = cctpChainByChainId(walletChainId);
  if (!chain) return { chain: undefined, balance: null };
  return { chain, balance: await readUsdcOn(chain, walletChainId, address) };
}

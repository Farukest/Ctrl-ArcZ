import { erc20Abi, type Address } from 'viem';
import { ARC_TESTNET_CHAIN_ID, CCTP_CHAINS, cctpChainByChainId, type CctpChainName } from '@ctrl-arcz/sdk';
import { bridgeClients, getPublicClient } from './session.js';

/**
 * USDC a wallet holds on a chain, when it can be read from here at all.
 *
 * Arc has its own RPC list in this app, so it can be read from anywhere. Every
 * other chain is reachable only through the wallet's own provider, which answers
 * for the network the wallet is currently on: asking it about Base Sepolia while
 * the wallet sits on Arc runs the call against Arc, where that address is not a
 * token, and comes back with something that is not a balance.
 *
 * That last part is the bug this file exists to have exactly one copy of. Two
 * screens had grown their own version, and one of them read the connected chain's
 * USDC address against Arc's RPC whenever the wallet was off Arc -- a number
 * rendered under the right chain's name that belonged to no chain at all.
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
  if (!isArc && connectedChainId !== entry.chainId) return null;
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

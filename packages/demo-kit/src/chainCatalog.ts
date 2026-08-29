import {
  ARC_TESTNET_CHAIN_ID,
  CCTP_CHAINS,
  DEPOSIT_CONFIRMATION_SECONDS,
  GATEWAY_CHAIN_NAMES,
  cctpChainByChainId,
  chainLabel,
  deployedChainIds,
  type CctpChainName,
  type GatewayChain,
} from '@ctrl-arcz/sdk';
import { supportsChain, type ChainFeature } from './chainSupport.js';

/**
 * Which networks a given job can be done on, and whether choosing one moves the
 * wallet.
 *
 * Every screen used to answer this for itself. The bridge wrote
 * `engine === 'gateway' ? GATEWAY_CHAIN_NAMES : Object.keys(CCTP_CHAINS)` inline,
 * the subscription form wrote `GATEWAY_CHAIN_NAMES`, the header offered all twenty
 * CCTP testnets whether or not anything worked there, and each of them built its
 * own `{ value, label, icon }` array with its own idea of what a chain is called.
 * Four lists, four filters, four label rules, and a user who picked the wrong one
 * found out afterwards.
 *
 * This is not a new source of truth. `CCTP_CHAINS`, `GATEWAY_CHAIN_NAMES` and the
 * deployment registry still answer what they always answered; this is the one place
 * that says which of them a given job should ask.
 *
 * @see chainSupport.ts for the contract-level features, which this composes rather
 * than duplicates.
 */

/**
 * A job that needs a network chosen for it.
 *
 * Deliberately named for the job and not for the screen. Two screens funding a
 * Gateway balance are the same purpose and must offer the same networks; the same
 * screen's source and destination are different purposes and must not.
 */
export type ChainPurpose =
  | ChainFeature
  /** Burning the wallet's own USDC. Any CCTP testnet, ours or not. */
  | 'cctpSource'
  /** Where a CCTP transfer mints. Nothing is signed there. */
  | 'cctpDestination'
  /** Moving wallet USDC into the Gateway balance. A real transaction. */
  | 'gatewayDeposit'
  /** A chain a Gateway spend draws from. A signature, not a transaction. */
  | 'gatewaySource'
  /** Where a Gateway spend mints. Circle's side. */
  | 'gatewayDestination';

const CCTP_NAMES = Object.keys(CCTP_CHAINS) as CctpChainName[];

/**
 * Arc first, then the rest in registry order.
 *
 * Not alphabetical and not by fee: it is the chain this project is built on and
 * the one most lists are going to be used with, so it is where a reader's eye
 * should land. Everything after it keeps a stable order so a list does not
 * reshuffle between renders.
 */
function arcFirst(names: readonly CctpChainName[]): readonly CctpChainName[] {
  const arc = names.filter((n) => CCTP_CHAINS[n].chainId === ARC_TESTNET_CHAIN_ID);
  return arc.length > 0 ? [...arc, ...names.filter((n) => !arc.includes(n))] : names;
}

/** The chains our own contracts are deployed on, as names. */
function deployedNames(): readonly CctpChainName[] {
  return deployedChainIds()
    .map((id) => cctpChainByChainId(id))
    .filter((n): n is CctpChainName => n !== undefined);
}

/**
 * The networks this purpose can actually be carried out on.
 *
 * Never includes one it cannot. A network that would fail is not shown greyed out
 * with a reason, and not shown with a "switch to Arc Testnet" screen waiting
 * behind it: it is absent, because a choice that cannot be taken is not a choice.
 * The reason a chain is missing is always the same reason, and it is structural.
 */
export function chainsFor(purpose: ChainPurpose): readonly CctpChainName[] {
  switch (purpose) {
    /*
     * CCTP is Circle's, not ours. It works between any two testnets Circle serves,
     * with no contract of ours involved, so the deployment registry has no say
     * here -- filtering by it would refuse fifteen chains that bridge perfectly
     * well.
     */
    case 'cctpSource':
    case 'cctpDestination':
      return arcFirst(CCTP_NAMES);
    case 'gatewayDeposit':
    case 'gatewaySource':
    case 'gatewayDestination':
      return arcFirst(GATEWAY_CHAIN_NAMES);
    /*
     * The rest are ours, so they need a deployment and whatever else the feature
     * needs on top of it. `supportsChain` already owns that question and is pinned
     * to the registry by its own tests.
     */
    default:
      return arcFirst(deployedNames().filter((n) => supportsChain(CCTP_CHAINS[n].chainId, purpose)));
  }
}

/**
 * Does choosing a network for this purpose mean moving the wallet to it?
 *
 * The binding between a picker and the wallet is two-way where an action is going
 * to be signed on the chosen chain, and one-way where it is not. Getting this
 * wrong in the permissive direction is the expensive mistake: a Gateway spend is a
 * signature over an intent and needs no source-chain transaction at all, so
 * prompting MetaMask when somebody picks a source network is a wallet popup that
 * buys nothing and interrupts a form.
 *
 * The three that do need it are the three that send a transaction: a CCTP burn, a
 * Gateway deposit, and anything that goes through our own contracts (whose client
 * is pinned to the connected chain).
 */
export function needsWalletOn(purpose: ChainPurpose): boolean {
  switch (purpose) {
    case 'cctpDestination':
    case 'gatewaySource':
    case 'gatewayDestination':
      return false;
    default:
      return true;
  }
}

/**
 * What a network is called, in the one place that decides.
 *
 * There were two rules and they could disagree. `bridgeChainLabel` looked a name
 * up in a hand-written table and fell back to `chainLabel`, and two callers wrote
 * the same three-term fallback expression to work around the table using ids that
 * did not exist (`Optimism_Sepolia` for `OP_Sepolia`, `Polygon_Amoy_Testnet` for
 * `Polygon_Amoy`), while two other callers skipped the table entirely. Checked
 * name by name, every entry in that table produced exactly what `chainLabel`
 * produces, so it was a second rule that had never once differed -- only a second
 * place to differ from. It is gone.
 */
export function labelOf(chain: CctpChainName | string): string {
  return chainLabel(chain as CctpChainName);
}

/**
 * How long a Gateway deposit on this chain takes to count, as a duration.
 *
 * Seconds under a minute and whole minutes above it, which is the whole rule; the
 * point of it living here is that it was written out twice, identically, in the two
 * screens that fund a Gateway balance, and both of them also feed it to a toast. A
 * third copy was one screen away.
 *
 * The number itself is Circle's, from `DEPOSIT_CONFIRMATION_SECONDS`, and it is not
 * averaged: depositing on Arc counts in a second and on Base in nineteen minutes.
 */
export function depositWaitLabel(chain: GatewayChain | undefined): string {
  if (!chain) return '';
  const secs = DEPOSIT_CONFIRMATION_SECONDS[chain];
  return secs < 60 ? `${secs}s` : `${Math.round(secs / 60)}m`;
}

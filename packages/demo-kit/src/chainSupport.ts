import { ARC_TESTNET_CHAIN_ID } from '@ctrl-arcz/sdk';

/**
 * Which chain a screen can do its work on.
 *
 * Every one of these needs a contract that exists on exactly one chain today, so
 * every answer is currently "Arc". That is not a reason to write `chainId === Arc`
 * in four components: the moment a second deployment exists, each of those becomes
 * a place to forget. The question is asked here, once, and the screens ask this.
 *
 * When per-chain deployments land, the body becomes a lookup in the deployment
 * registry (does this chain have a CtrlArcZ / a SpendPolicyFactory / a Gateway
 * route for box funding) and nothing above it changes.
 */
export type ChainFeature =
  /** `CtrlArcZ.sendProtected`. */
  | 'protectedSend'
  /** Claiming and cancelling, same contract. */
  | 'receive'
  /** `SpendPolicyFactory` plus the co-signer, whose EIP-712 domain names one chain. */
  | 'privatePay'
  /** Boxes, which additionally need a Gateway route to be funded. */
  | 'subscriptions';

/** The chain a feature needs. One entry per feature so adding a deployment is a
 *  data change here rather than a search through the components. */
const SUPPORTED: Record<ChainFeature, readonly number[]> = {
  protectedSend: [ARC_TESTNET_CHAIN_ID],
  receive: [ARC_TESTNET_CHAIN_ID],
  privatePay: [ARC_TESTNET_CHAIN_ID],
  subscriptions: [ARC_TESTNET_CHAIN_ID],
};

/**
 * Can this feature run on this chain?
 *
 * An unknown chain is a no, not an unknown: the wallet is somewhere we have no
 * deployment for, and the honest answer to "can I pay from here" is no.
 */
export function supportsChain(chainId: number | undefined, feature: ChainFeature): boolean {
  return chainId !== undefined && SUPPORTED[feature].includes(chainId);
}

/** The chain to offer as the fix. The first supported one, which is Arc today. */
export function preferredChainFor(feature: ChainFeature): number {
  return SUPPORTED[feature][0] as number;
}

import { ARC_TESTNET_CHAIN_ID, deployedChainIds, deploymentFor } from '@ctrl-arcz/sdk';

/**
 * Which chain a screen can do its work on.
 *
 * This used to be a list of chain ids that all read "Arc", written here rather than
 * as `chainId === Arc` in four components so that a second deployment would be one
 * change instead of four places to forget. The second deployment has now landed, and
 * the body is what that comment said it would become: a lookup in the deployment
 * registry, with nothing above it changed and no component touched.
 *
 * The screens have not moved either. They ask this question and render `NeedsChain`
 * when the answer is no, which is the same code that ran when the answer was always
 * Arc.
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

/**
 * What each feature needs, beyond a deployment being there at all.
 *
 * The contracts are the easy half and the registry answers for them. This is the
 * other half: two features additionally need something only Arc has, and the
 * distinction has to be written down or a new chain entry silently switches on a
 * screen that cannot work there.
 *
 * `null` means the deployment is the whole requirement.
 */
const ALSO_NEEDS: Record<ChainFeature, ((chainId: number) => boolean) | null> = {
  protectedSend: null,
  receive: null,
  /**
   * One-transaction Private Pay funds the box inside the same call that creates and
   * pays from it, and that needs a way to move the payer's tokens from inside a
   * batch. Arc has one in its `CallFrom` precompile, reached through
   * `Multicall3From`. Every other chain needs the `PrivatePayRouter`, which does the
   * same job through Permit2.
   *
   * Standard Multicall3 is not a substitute anywhere and must not be treated as one:
   * it does not preserve `msg.sender`, so a `transfer` batched inside it moves
   * Multicall3's own tokens rather than the payer's.
   *
   * So the question is not "is this Arc", it is "does this chain have a route", and
   * a chain deployed without a router correctly answers no.
   */
  privatePay: (chainId) =>
    chainId === ARC_TESTNET_CHAIN_ID || deploymentFor(chainId)?.privatePayRouter !== undefined,
  /** Boxes are funded by a Circle Gateway mint, so the box's chain must be one
   *  Gateway can mint on. That is true of Arc and of the chains we deploy to, but
   *  it is a second condition and is checked as one. */
  subscriptions: null,
};

/**
 * Can this feature run on this chain?
 *
 * Two questions, both of which have to be yes: is Ctrl+ArcZ deployed here, and does
 * this feature need anything else that this chain does not have.
 *
 * An unknown chain is a no, not an unknown: the wallet is somewhere we have no
 * deployment for, and the honest answer to "can I pay from here" is no.
 */
export function supportsChain(chainId: number | undefined, feature: ChainFeature): boolean {
  if (chainId === undefined || !deploymentFor(chainId)) return false;
  const extra = ALSO_NEEDS[feature];
  return extra === null || extra(chainId);
}

/**
 * The chain to offer as the fix.
 *
 * Arc when Arc can do it, which is every feature today and the reason the button
 * says "Switch to Arc". Falls through to the first chain that can, so a feature
 * that one day works somewhere else but not on Arc still offers a way forward
 * rather than sending the user to a network that would refuse them too.
 */
export function preferredChainFor(feature: ChainFeature): number {
  if (supportsChain(ARC_TESTNET_CHAIN_ID, feature)) return ARC_TESTNET_CHAIN_ID;
  const other = deployedChainIds().find((id) => supportsChain(id, feature));
  return other ?? ARC_TESTNET_CHAIN_ID;
}

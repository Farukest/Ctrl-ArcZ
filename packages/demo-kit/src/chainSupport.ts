import {
  ARC_TESTNET_CHAIN_ID,
  CCTP_CHAINS,
  deployedChainIds,
  deploymentFor,
} from '@ctrl-arcz/sdk';

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
/**
 * Chains the relayer has been run against end to end, with a box deployed and the
 * co-signer's signature verified for it there.
 *
 * Written as what was observed rather than derived from the registry, because that
 * is what it is: a record of what has been tried. `testnet.services.test.ts` is the
 * thing that moves a chain onto this list.
 */
const RELAYER_PROVEN: readonly number[] = [
  ARC_TESTNET_CHAIN_ID,
  CCTP_CHAINS.Ethereum_Sepolia.chainId,
  CCTP_CHAINS.Arbitrum_Sepolia.chainId,
];

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
  /**
   * A subscription box is deployed and announced by the relayer, so this needs a
   * chain the relayer has actually been shown to work on -- not merely one with a
   * factory address.
   *
   * That distinction is not theoretical. The relayer path was exercised live on
   * all four new chains and passed on two: Ethereum Sepolia and Arbitrum Sepolia.
   * On Avalanche Fuji the deploy is refused with `exceeds block gas limit`, from
   * the chain's habit of estimating gas from the sender's balance; clamping the
   * prepared gas fixed a plain transfer there and did not fix the contract call.
   * On Base Sepolia the deploy lands and the policy read straight after it comes
   * back empty (`cosigner returned no data`), which survives a ten-attempt wait
   * for the code to appear, so it is not simply the load balancer being behind.
   *
   * Neither is understood yet, and an unexplained failure is not a reason to let
   * the screen offer the feature. The list shrinks back to what has been seen to
   * work, and grows again per chain as each one is proven.
   */
  subscriptions: (chainId) => RELAYER_PROVEN.includes(chainId),
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

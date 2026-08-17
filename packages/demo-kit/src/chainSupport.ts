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
/**
 * Whether the recipient firewall can work here.
 *
 * It judges an address by its transaction history, which it reads from a
 * Blockscout instance. Where there is none the rules fail closed and every payment
 * is vetoed -- correctly, because a co-signer cannot vouch for a recipient it
 * cannot look up. Better to say so before the form is filled in.
 *
 * Avalanche Fuji is the case: Snowtrace, Avascan and Snowscan all serve it and
 * none of them is Blockscout, and Blockscout's own chain directory lists no
 * instance for it. Wiring an Etherscan-shaped API would be a second provider, not
 * a config line, and is not worth it for a demo chain.
 */
const hasFirewall = (chainId: number) => deploymentFor(chainId)?.explorerApi !== undefined;

const ALSO_NEEDS: Record<ChainFeature, ((chainId: number) => boolean) | null> = {
  /** Every send goes through the recipient firewall before it is signed. */
  protectedSend: hasFirewall,
  /** Claiming judges nobody: the money is already sent and the claimant is the
   *  one being paid. No history needed, so this works wherever the contract is. */
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
    hasFirewall(chainId) &&
    (chainId === ARC_TESTNET_CHAIN_ID || deploymentFor(chainId)?.privatePayRouter !== undefined),
  /**
   * A subscription box is deployed and announced by the relayer, which needs
   * nothing this registry does not already answer: a factory, an announcer, and
   * endpoints the server can reach the chain on.
   *
   * It briefly did need more. Two of the four chains refused a relayed deploy, and
   * both turned out to be faults in this repo rather than facts about the chains --
   * see `awaitCode` in `shield.ts` and `withSaneGas` in `session.ts`. They are
   * fixed, and `testnet.services.test.ts` deploys a real box and co-signs for it on
   * every chain here, so there is nothing left to gate on.
   */
  subscriptions: hasFirewall,
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

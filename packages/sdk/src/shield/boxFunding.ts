import { erc20Abi, type Address, type PublicClient, type WalletClient } from 'viem';
import { assertDeployedPolicy, type EphemeralPolicy } from './shield.js';
import { spendFromGateway, type GatewayChain, type GatewayStep } from '../bridge/gateway.js';

/**
 * Funding a policy box out of the payer's Gateway balance.
 *
 * The wallet used to pay the box directly, and that transfer was the one thing on
 * chain that undid the stealth address the box had been given. Both ends of an
 * ERC-20 transfer are indexed, so anyone could take a wallet's outgoing transfers,
 * intersect them with the announcer's metadata, and recover its boxes with no
 * viewing key at all. Measured on a real wallet: eight boxes out of eight, no false
 * positives. Circle mints into the box instead and the payer never appears.
 *
 * There is no second route. A fallback to the wallet transfer would be a second way
 * to leave that line on chain, and the one that gets taken is the one taken when
 * something else has already gone wrong.
 */

/** Circle's mint is seconds on a fast source chain and minutes on a slow one. */
const DEFAULT_WAIT_MS = 180_000;
const POLL_MS = 3_000;

/**
 * Refuse to fund a box that is not there, or not the one that was asked for.
 *
 * Two failures, both of which end with money nobody can move. A transfer to an
 * address with no code succeeds, and so does a Gateway mint: the tokens land at a
 * counterfactual address only the factory can bring to life, and if that salt is
 * never used they stay there. And a box that exists with a different policy is
 * somebody else's box, or the same box with a cap and an expiry the payer did not
 * agree to.
 *
 * Called before the signature rather than inside the payment. On the wallet route a
 * failed check meant the transfer was simply never sent; a Gateway intent cannot be
 * recalled once Circle has accepted it, so by the time a payment could fail the
 * money is already committed.
 */
export async function assertBoxFundable(
  publicClient: PublicClient,
  account: Address,
  policy: EphemeralPolicy,
): Promise<void> {
  const code = await publicClient.getCode({ address: account });
  if (!code || code === '0x') {
    throw new Error(`Box ${account} is not deployed yet; refusing to fund it.`);
  }
  await assertDeployedPolicy(publicClient, account, policy);
}

export interface FundBoxParams {
  /** The box, already deployed and already checked by {@link assertBoxFundable}. */
  account: Address;
  amount: bigint;
  /**
   * Which chain's Gateway balance pays.
   *
   * Not "the balance": Circle reads one figure but spends it per chain, and an
   * intent carries a single source domain. A box funded from a chain the payer has
   * nothing on is an intent Circle refuses after it has been signed.
   */
  from: GatewayChain;
  /** Persist this the instant it arrives; see {@link spendFromGateway}. */
  onTransferId?: (transferId: string) => void;
  onStep?: (step: GatewayStep, txHash?: string) => void;
  timeoutMs?: number;
}

/**
 * Ask Circle to mint into the box from the payer's Gateway balance on `from`.
 *
 * The destination is Arc, because that is where a policy box lives, and the
 * recipient is the box itself. What appears on Arc is a mint from Circle's minter to
 * the box; the payer's address is not in it.
 */
export async function fundBoxFromGateway(
  clients: { walletClient: WalletClient },
  params: FundBoxParams,
): Promise<{ transferId?: string }> {
  if (params.amount <= 0n) throw new Error('Funding amount must be positive.');
  let transferId: string | undefined;
  await spendFromGateway(clients, {
    from: params.from,
    to: 'Arc_Testnet',
    amount: params.amount,
    recipient: params.account,
    ...(params.timeoutMs != null ? { timeoutMs: params.timeoutMs } : {}),
    onTransferId: (id) => {
      transferId = id;
      params.onTransferId?.(id);
    },
    ...(params.onStep ? { onStep: params.onStep } : {}),
  });
  return transferId != null ? { transferId } : {};
}

/**
 * Wait for the box to actually hold `amount`.
 *
 * The balance, not a flag and not the signature. A box is funded when the money is
 * in it, and on this route those are minutes apart: treating the signature as the
 * arrival is how a screen reports a working subscription over an empty box.
 *
 * False means "not yet", never "failed". Circle's transfer id was handed back the
 * moment the intent was accepted, so a wait that runs out leaves something that can
 * still be asked about rather than a payment nobody is following.
 */
export async function awaitBoxFunded(
  publicClient: PublicClient,
  account: Address,
  amount: bigint,
  usdc: Address,
  opts: { timeoutMs?: number; pollMs?: number; now?: () => number } = {},
): Promise<boolean> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_WAIT_MS;
  const pollMs = opts.pollMs ?? POLL_MS;
  const now = opts.now ?? (() => Date.now());
  const deadline = now() + timeoutMs;

  const held = async (): Promise<bigint> => {
    try {
      return (await publicClient.readContract({
        address: usdc,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [account],
      })) as bigint;
    } catch {
      // A dropped read is not an empty box. Say nothing and let the next tick ask.
      return 0n;
    }
  };

  for (;;) {
    if ((await held()) >= amount) return true;
    if (now() >= deadline) break;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  // One last look, so a mint that landed during the final sleep is not reported as
  // a timeout.
  return (await held()) >= amount;
}

/**
 * Whether a transfer is money going into one of this wallet's boxes.
 *
 * Told from the recipient rather than from a flag written when the record was made.
 * The box address is already on the record and the set of boxes is already known, so
 * there is nothing to store, nothing to migrate, and no way for a flag to disagree
 * with the transfer it describes. It also classifies records made before any of this
 * existed.
 *
 * `boxes` must be lowercased, which is how discovery keeps them.
 */
export function isBoxFunding(recipient: string | undefined, boxes: ReadonlySet<string>): boolean {
  if (!recipient || boxes.size === 0) return false;
  return boxes.has(recipient.trim().toLowerCase());
}

/**
 * Live proof that a subscription box is funded on the chain the box is on, with
 * real money, on Base Sepolia.
 *
 * Everything after the box deploy used to name Arc: the policy's token, the
 * fundable check, the Gateway destination and the wait for the money. None of it
 * failed loudly. On Base the fundable check simply could not see a box that was
 * really there, because it was looking at Arc, and the run stopped one step before
 * the money moved. That is the only reason this was a broken feature rather than a
 * lost payment, and it is not a property anyone designed.
 *
 * So the questions this answers are the ones worth real USDC: does the mint arrive
 * at the box on Base, does it stay off Arc, is the box credited the amount rather
 * than the amount minus Circle's fee, and does a wait that is cut short lose
 * anything.
 *
 * Spends a few cents of testnet USDC out of the Gateway balance. Gated on
 * INTEGRATION=1 and the env keys.
 * Run: INTEGRATION=1 pnpm --filter @ctrl-arcz/demo-kit exec vitest run test/integration/testnet.boxfunding.test.ts
 */
import { describe, expect, it } from 'vitest';
import { erc20Abi, getAddress, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  ADDRESSES,
  ARC_TESTNET_CHAIN_ID,
  CCTP_CHAINS,
  MODE_PULL,
  assertBoxFundable,
  awaitBoxFunded,
  createEphemeral,
  deploymentFor,
  findGatewayMint,
  fundBoxFromGateway,
  gatewayBalance,
  predictEphemeral,
  quoteGatewaySpend,
  type EphemeralPolicy,
} from '@ctrl-arcz/sdk';
import { signerFor } from '../../src/session.js';

const RUN = process.env.INTEGRATION === '1';
const PAYER_PK = process.env.SENDER_PRIVATE_KEY as Hex | undefined;
const COSIGNER_PK = process.env.COSIGNER_PK as Hex | undefined;
const MERCHANT = process.env.RECEIVER_ADDRESS as Address | undefined;

/** Small enough to run repeatedly, large enough to be unambiguous on a balance. */
const AMOUNT = 50_000n;

const BASE = deploymentFor(CCTP_CHAINS.Base_Sepolia.chainId);
const ARC_USDC = getAddress(ADDRESSES.USDC);
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
/** The browser-facing side of the same Blockscout instance the firewall reads. */
const EXPLORER = BASE?.explorerApi?.replace(/\/api\/v2$/, '') ?? '';

interface TokenTransfer {
  from?: { hash?: string };
  to?: { hash?: string };
  total?: { value?: string };
  transaction_hash?: string;
}

/**
 * The box's token transfers, waited for rather than asked once.
 *
 * The indexer trails the block it is indexing, and this runs seconds after the
 * mint. An immediate empty answer would fail a test about where the money went
 * on a question about how fast Blockscout is.
 */
async function pollTokenTransfers(who: Address, timeoutMs: number): Promise<TokenTransfer[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(`${BASE!.explorerApi}/addresses/${who}/token-transfers`);
      if (res.ok) {
        const body = (await res.json()) as { items?: TokenTransfer[] };
        if (body.items?.length) return body.items;
      }
    } catch {
      // A dropped read is not an empty history; ask again.
    }
    if (Date.now() >= deadline) return [];
    await new Promise((r) => setTimeout(r, 5_000));
  }
}

const usdcAt = async (
  client: { readContract: (a: never) => Promise<unknown> },
  token: Address,
  who: Address,
): Promise<bigint> =>
  (await client.readContract({
    address: token,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [who],
  } as never)) as bigint;

describe.runIf(RUN && PAYER_PK && COSIGNER_PK && MERCHANT && BASE)(
  'a box is funded where the box is',
  () => {
    const payer = () => privateKeyToAccount(PAYER_PK!);
    const cosigner = () => privateKeyToAccount(COSIGNER_PK!);
    const base = () => signerFor(BASE!.chainId, PAYER_PK!);
    const arc = () => signerFor(ARC_TESTNET_CHAIN_ID, PAYER_PK!);

    /** A subscription-shaped policy, in this chain's own USDC. */
    const policyFor = (): EphemeralPolicy => ({
      token: getAddress(BASE!.usdc),
      owner: payer().address,
      cosigner: cosigner().address,
      vault: payer().address,
      target: getAddress(MERCHANT!),
      maxAmount: AMOUNT,
      perPullMax: AMOUNT / 2n,
      expiry: Math.floor(Date.now() / 1000) + 3600,
      interval: 60,
      mode: MODE_PULL,
    });

    const freshSalt = (tag: number): Hex =>
      `0x${(BigInt(Date.now()) * 1000n + BigInt(tag)).toString(16).padStart(64, '0')}` as Hex;

    it('refuses to fund an address the factory has not brought to life', async () => {
      // The failure this prevents costs everything: a Gateway mint to a
      // counterfactual address succeeds, and the tokens sit at an address only that
      // exact salt can ever deploy. Nothing is recoverable by asking Circle.
      const salt = freshSalt(1);
      const policy = policyFor();
      const predicted = await predictEphemeral(
        base().publicClient,
        getAddress(BASE!.spendPolicyFactory),
        salt,
        policy,
      );
      await expect(assertBoxFundable(base().publicClient, predicted, policy)).rejects.toThrow(
        /not deployed/i,
      );
    }, 120_000);

    it('refuses a deployed box whose policy is not the one that was agreed', async () => {
      // Same address, different terms. A box that exists with a target or a cap the
      // payer never approved is somebody else's box.
      const salt = freshSalt(2);
      const policy = policyFor();
      const { account } = await createEphemeral(
        base() as never,
        getAddress(BASE!.spendPolicyFactory),
        salt,
        policy,
      );
      await expect(
        assertBoxFundable(base().publicClient, account, { ...policy, maxAmount: AMOUNT * 2n }),
      ).rejects.toThrow();
      // The one it was actually deployed with passes, so the check is reading the
      // box rather than refusing everything.
      await expect(assertBoxFundable(base().publicClient, account, policy)).resolves.toBeUndefined();
    }, 180_000);

    it('refuses before signing when the Gateway balance cannot cover it', async () => {
      // No signature, no intent, nothing for Circle to accept. The refusal has to
      // happen here: an accepted intent cannot be recalled.
      const salt = freshSalt(3);
      const policy = policyFor();
      const { account } = await createEphemeral(
        base() as never,
        getAddress(BASE!.spendPolicyFactory),
        salt,
        policy,
      );
      let sawTransferId = false;
      await expect(
        fundBoxFromGateway(base() as never, {
          account,
          amount: 10_000_000_000n,
          from: 'Base_Sepolia',
          to: 'Base_Sepolia',
          onTransferId: () => {
            sawTransferId = true;
          },
        }),
      ).rejects.toThrow();
      expect(sawTransferId).toBe(false);
    }, 180_000);

    it('mints into the box on Base, credits the full amount, and leaves Arc alone', async () => {
      const salt = freshSalt(4);
      const policy = policyFor();
      const baseClients = base();
      const arcClients = arc();

      const { account } = await createEphemeral(
        baseClients as never,
        getAddress(BASE!.spendPolicyFactory),
        salt,
        policy,
      );
      await assertBoxFundable(baseClients.publicClient, account, policy);

      // A brand-new box on both chains. The Arc reading is the one that matters:
      // the address is derived from a factory that exists on both, so "empty on
      // Arc" only stays true if the intent was actually aimed at Base.
      expect(await usdcAt(baseClients.publicClient as never, getAddress(BASE!.usdc), account)).toBe(
        0n,
      );
      expect(await usdcAt(arcClients.publicClient as never, ARC_USDC, account)).toBe(0n);

      const quote = await quoteGatewaySpend({
        from: 'Base_Sepolia',
        to: 'Base_Sepolia',
        amount: AMOUNT,
        depositor: payer().address,
      });
      const balanceBefore = (await gatewayBalance({ depositor: payer().address })).byChain
        .Base_Sepolia!;

      // Deliberately cut the wait short, which is what a closed tab does. The id has
      // to be in hand by then or an interrupted funding is a payment nobody can
      // follow.
      let transferId: string | undefined;
      await fundBoxFromGateway(baseClients as never, {
        account,
        amount: AMOUNT,
        from: 'Base_Sepolia',
        to: 'Base_Sepolia',
        timeoutMs: 4_000,
        onTransferId: (id) => {
          transferId = id;
        },
      });
      expect(transferId, 'Circle accepted the intent without handing back an id').toBeTruthy();

      // And the money still arrives, with nothing held open on this side.
      const landed = await awaitBoxFunded(
        baseClients.publicClient,
        account,
        AMOUNT,
        getAddress(BASE!.usdc),
        { timeoutMs: 240_000 },
      );
      expect(landed, 'the mint did not land on Base within four minutes').toBe(true);

      // Credited the amount, not the amount minus the fee: Circle takes its fee out
      // of the Gateway balance, and a box short by the fee cannot pay its last pull.
      expect(await usdcAt(baseClients.publicClient as never, getAddress(BASE!.usdc), account)).toBe(
        AMOUNT,
      );

      // The whole point. Same address, other chain, still empty.
      expect(
        await usdcAt(arcClients.publicClient as never, ARC_USDC, account),
        'money reached the box address on Arc, which is where it used to be sent',
      ).toBe(0n);

      // The transfer is followable by its id alone, with no wallet and no
      // signature. Measured here: it answered "pending" while the money was
      // already in the box on Base, so Circle's status trails its own mint. That
      // is the reason funding is judged on the balance and never on this, and it
      // is asserted rather than assumed because a status running AHEAD of the
      // balance would be the dangerous direction.
      const status = await findGatewayMint({ transferId: transferId! });
      expect(['pending', 'done']).toContain(status.state);

      // What the chain actually records, read back from the explorer the firewall
      // uses. This is the privacy claim stated as a test rather than a comment: the
      // box's only incoming transfer is a mint from Circle's minter, and the payer
      // who paid for it is not one of its two ends.
      const transfers = await pollTokenTransfers(account, 120_000);
      const incoming = transfers.filter(
        (t) => t.to?.hash?.toLowerCase() === account.toLowerCase(),
      );
      expect(incoming, 'the explorer never showed the mint').toHaveLength(1);
      expect(incoming[0]!.total?.value).toBe(String(AMOUNT));
      // From the zero address: what the chain records is a mint, not a transfer,
      // so the funding line has only one end and it is the box. This was written
      // expecting Circle's minter to be the sender and measured otherwise, which
      // is the stronger result. The wallet transfer this route replaced had two
      // indexed ends, and intersecting them with the announcer recovered eight
      // boxes out of eight.
      expect(incoming[0]!.from?.hash).toBe(ZERO_ADDRESS);
      expect(
        [incoming[0]!.from?.hash, incoming[0]!.to?.hash].map((h) => h?.toLowerCase()),
        'the payer appears on the line that funds the box',
      ).not.toContain(payer().address.toLowerCase());

      console.log(
        [
          `box            ${account}`,
          `on             ${EXPLORER}/address/${account}`,
          `gateway id     ${transferId}`,
          `funded by      ${incoming[0]!.from?.hash} (a mint, not a transfer)`,
          `mint tx        ${EXPLORER}/tx/${incoming[0]!.transaction_hash}`,
          `payer          ${payer().address} (absent from the transfer above)`,
        ].join('\n'),
      );

      // The fee came out of the balance, and it was no worse than the ceiling that
      // was signed.
      const balanceAfter = (await gatewayBalance({ depositor: payer().address })).byChain
        .Base_Sepolia!;
      const spent = balanceBefore - balanceAfter;
      expect(spent).toBeGreaterThanOrEqual(AMOUNT);
      expect(spent).toBeLessThanOrEqual(AMOUNT + quote.maxFee);
    }, 600_000);
  },
);

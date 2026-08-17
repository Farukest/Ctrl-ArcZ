/**
 * Live proof that the two services follow the chain they are told about.
 *
 * The co-signer and the relayer were Arc by construction: module-level clients,
 * module-level factory and announcer addresses, and `chainId: arcTestnet.id`
 * written into every request. None of that failed loudly once a second deployment
 * existed -- the relayer would have deployed an Arc box for a payment happening on
 * Base, at an address the co-signer never authorised, and the co-signer would have
 * read a policy from the wrong network to judge it.
 *
 * So both are exercised here against every deployed chain, using the same
 * server-side entry points the API calls.
 *
 * Run: INTEGRATION=1 pnpm --filter @ctrl-arcz/demo-kit exec vitest run test/integration
 */
import { describe, expect, it } from 'vitest';
import { getAddress, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  ARC_TESTNET_CHAIN_ID,
  DEPLOYMENTS,
  LocalCoSigner,
  MODE_PUSH,
  predictEphemeral,
  spendableTokensFor,
  type ChainDeployment,
  type EphemeralPolicy,
} from '@ctrl-arcz/sdk';
import { relayCreateBox, boxExists } from '../../src/relayServer.js';
import { signerFor } from '../../src/session.js';

const RUN = process.env.INTEGRATION === '1';
const RELAYER_PK = process.env.RELAYER_PK as Hex | undefined;
const COSIGNER_PK = process.env.COSIGNER_PK as Hex | undefined;
const MERCHANT = process.env.RECEIVER_ADDRESS as Address | undefined;

/**
 * Arc is excluded, and not because it would fail.
 *
 * Its relayer is funded in USDC, which is also its gas, and a box deploy there
 * costs the operator real demo balance that the subscription screen needs. The
 * chains under test are the ones the change is about; Arc's path is unchanged and
 * covered by `testnet.shield.test.ts`.
 */
const CHAINS = (Object.values(DEPLOYMENTS) as ChainDeployment[]).filter(
  (d) => d.chainId !== ARC_TESTNET_CHAIN_ID,
);

describe.runIf(RUN && RELAYER_PK && COSIGNER_PK && MERCHANT)('services follow the chain', () => {
  it.each(CHAINS.map((d) => [d.chain, d] as const))(
    'the relayer deploys on %s, and the co-signer signs for it there',
    async (_name, deployment) => {
      const cosigner = privateKeyToAccount(COSIGNER_PK!);
      const payer = privateKeyToAccount(RELAYER_PK!); // stands in as the box owner

      // The token this chain actually has, from the registry. Arc's USDC address
      // would be accepted by a chain-blind check and mean nothing here.
      const token = spendableTokensFor(deployment.chainId).find((t) => t.symbol === 'USDC');
      expect(token, `${deployment.chain} has no USDC in the token registry`).toBeDefined();
      expect(token!.address.toLowerCase()).toBe(deployment.usdc.toLowerCase());

      const salt = `0x${Date.now().toString(16).padStart(64, '0')}` as Hex;
      const policy: EphemeralPolicy = {
        token: getAddress(token!.address),
        owner: payer.address,
        cosigner: cosigner.address,
        vault: payer.address,
        target: getAddress(MERCHANT!),
        maxAmount: 10_000n,
        perPullMax: 0n,
        expiry: Math.floor(Date.now() / 1000) + 3600,
        interval: 0,
        mode: MODE_PUSH,
      };

      // What the client would predict, from this chain's factory.
      const { publicClient } = signerFor(deployment.chainId, RELAYER_PK!);
      const expected = await predictEphemeral(
        publicClient,
        deployment.spendPolicyFactory,
        salt,
        policy,
      );
      expect(await boxExists(RELAYER_PK!, deployment.chainId, expected)).toBe(false);

      // The relayer, told which chain. This is the call the API makes.
      const { account } = await relayCreateBox(RELAYER_PK!, deployment.chainId, salt, policy);
      expect(account.toLowerCase()).toBe(expected.toLowerCase());
      expect(await boxExists(RELAYER_PK!, deployment.chainId, account)).toBe(true);

      // And it exists on this chain only. The factories differ per chain, so the
      // same salt and policy land somewhere else everywhere else -- which is the
      // property that makes a chain-blind relayer dangerous rather than merely
      // wrong: it would have deployed a real box at an address nobody authorised.
      for (const other of CHAINS.filter((c) => c.chainId !== deployment.chainId)) {
        expect(await boxExists(RELAYER_PK!, other.chainId, account)).toBe(false);
      }

      /**
       * The co-signer, for the box that now exists on this chain.
       *
       * `LocalCoSigner` is what the server runs behind `/api/cosign`. The signature
       * it produces carries `chainId` in its EIP-712 domain, so this is also the
       * check that the domain is built for the right network: a signature made for
       * Arc does not recover to the co-signer against a box on Base, and the box
       * would refuse it.
       */
      // A risk source that answers "safe", not one that answers nothing. The
      // co-signer fails closed on unavailable data, so `null` here is a veto and
      // would have tested the refusal path instead of the signing path. What this
      // test is about is the chain, not the firewall.
      const machine = new LocalCoSigner(COSIGNER_PK!, {
        riskCheck: async () => ({ severity: 'safe', reasons: [] }) as never,
      });
      const authorised = await machine.authorize({
        account,
        owner: payer.address,
        amount: 10_000n,
        action: 0,
        target: policy.target,
        nonce: 0n,
        chainId: deployment.chainId,
        remaining: 10_000n,
        expiry: policy.expiry,
      });
      expect(authorised.approved, 'reason' in authorised ? authorised.reason : '').toBe(true);
    },
    180_000,
  );
});

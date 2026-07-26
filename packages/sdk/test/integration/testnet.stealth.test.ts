/**
 * Live Arc Testnet proof for stealth-address box discovery, against the deployed
 * SpendPolicyFactory and StealthAnnouncer. Creates a PULL box owned+vaulted by a
 * fresh stealth address, announces it, and shows that ONLY the payer's viewing key
 * rediscovers it while a stranger's does not.
 *
 * Spends a few cents of testnet USDC (two txs: create + announce). Gated on
 * INTEGRATION=1 and SENDER_PRIVATE_KEY.
 * Run: INTEGRATION=1 vitest run test/integration/testnet.stealth.test.ts
 */
import { describe, expect, it } from 'vitest';
import { createPublicClient, createWalletClient, http, fallback, getAddress, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  arcTestnet,
  RPC_URLS,
  ADDRESSES,
  SPEND_POLICY_FACTORY_ADDRESS,
  STEALTH_ANNOUNCER_ADDRESS,
} from '../../src/chains/arcTestnet.js';
import { createEphemeral, MODE_PULL } from '../../src/shield/shield.js';
import { deriveStealthKeys, STEALTH_KEY_MESSAGE } from '../../src/shield/stealth.js';
import {
  newStealthOwner,
  announceArgsFor,
  announceStealthBox,
  discoverStealthBoxes,
} from '../../src/shield/stealthBox.js';

const RUN = process.env.INTEGRATION === '1';
const PK = process.env.SENDER_PRIVATE_KEY as Hex | undefined;
const RECEIVER_PK = process.env.RECEIVER_PRIVATE_KEY as Hex | undefined;
const COSIGNER_PK = process.env.COSIGNER_PK as Hex | undefined;

const transport = fallback(RPC_URLS.map((u) => http(u, { retryCount: 4, retryDelay: 1500, timeout: 30_000 })));

describe.runIf(RUN && PK)('stealth box discovery on Arc Testnet (deployed)', () => {
  it('creates + announces a stealth box; only the payer rediscovers it', async () => {
    const payer = privateKeyToAccount(PK!);
    const merchant = RECEIVER_PK ? privateKeyToAccount(RECEIVER_PK).address : payer.address;
    const cosigner = COSIGNER_PK ? privateKeyToAccount(COSIGNER_PK).address : payer.address;

    const publicClient = createPublicClient({ chain: arcTestnet, transport, pollingInterval: 5000 });
    const walletClient = createWalletClient({ account: payer, chain: arcTestnet, transport });
    const clients = { publicClient, walletClient };

    // 1. One-time: derive stealth keys from a single signature (no gas).
    const sig = await walletClient.signMessage({ account: payer, message: STEALTH_KEY_MESSAGE });
    const keys = deriveStealthKeys(sig);

    // 2. A fresh stealth owner for this box.
    const stealth = newStealthOwner(keys);
    // The box is owned AND vaulted by the stealth address, so ownerHash/vaultHash
    // are keccak(stealth) — no link to the payer's real wallet.

    // 3. Create the PULL box.
    const fromBlock = await publicClient.getBlockNumber();
    const salt = ('0x' + Date.now().toString(16).padStart(64, '0')) as Hex;
    const { account: box } = await createEphemeral(clients, SPEND_POLICY_FACTORY_ADDRESS, salt, {
      token: getAddress(ADDRESSES.USDC),
      owner: stealth.stealthAddress,
      cosigner,
      vault: stealth.stealthAddress,
      target: getAddress(merchant),
      maxAmount: 50_000n,
      perPullMax: 10_000n,
      expiry: Math.floor(Date.now() / 1000) + 3600,
      interval: 60,
      mode: MODE_PULL,
    });

    // 4. Announce it (any submitter; here the payer).
    await announceStealthBox(clients, STEALTH_ANNOUNCER_ADDRESS, announceArgsFor(stealth, box));

    // 5. The payer scans with their viewing key and finds exactly this box.
    const scanFrom = fromBlock > 100n ? fromBlock - 100n : 0n;
    const mine = await discoverStealthBoxes(publicClient, STEALTH_ANNOUNCER_ADDRESS, keys, { fromBlock: scanFrom });
    const found = mine.find((b) => b.box.toLowerCase() === box.toLowerCase());
    expect(found, 'payer should rediscover their own stealth box').toBeTruthy();
    expect(found!.stealthAddress).toBe(stealth.stealthAddress);

    // 6. A stranger's viewing key cannot: the box is invisible to them.
    const stranger = deriveStealthKeys(('0x' + 'ab'.repeat(65)) as Hex);
    const theirs = await discoverStealthBoxes(publicClient, STEALTH_ANNOUNCER_ADDRESS, stranger, {
      fromBlock: scanFrom,
    });
    expect(theirs.find((b) => b.box.toLowerCase() === box.toLowerCase())).toBeFalsy();
  }, 180_000);
});

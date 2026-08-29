import { beforeEach, describe, expect, it } from 'vitest';
import { resetStorage } from './setup.js';
import { bridgeEntries } from '../src/lib/activityEntries.js';
import { toActivityItem } from '../src/lib/activityView.js';
import type { StoredBridge } from '../src/store.js';

/**
 * The explorer link on a step, on every screen that draws one.
 *
 * The link used to be computed once and written onto the stored step, so a row
 * could never be told anything new. The transfer that exposed it went from
 * Ethereum Sepolia to Sonic Testnet: the mint is on Sonic, the row linked it to
 * the source chain's explorer, and when the registry gained a Sonic entry the row
 * already on screen kept its hash and no link. Fixing the writer fixed transfers
 * made afterwards and did nothing for the one the reader was looking at.
 *
 * So the row below is written the way the old code left it -- no `explorerUrl` at
 * all -- and every screen has to produce the right link from it anyway. There were
 * four places drawing these, which is why this asserts on more than one.
 */

const MINT = '0xb9118aad3abcdff21b17fc034f2baccf05f87bff026866b45d78951c2f680697';

/** Exactly what the old writer stored for the reported transfer. */
const legacyRow: StoredBridge = {
  id: 'legacy-sonic',
  engine: 'gateway',
  from: 'Ethereum_Sepolia',
  to: 'Sonic_Testnet',
  fromLabel: 'Ethereum Sepolia',
  toLabel: 'Sonic Testnet',
  amount: '2',
  state: 'success',
  steps: [{ name: 'sign' }, { name: 'attestation' }, { name: 'mint', txHash: MINT }],
  createdAt: Date.now(),
};

const t = ((k: string) => k) as never;

beforeEach(resetStorage);

describe('a stored row with no link still gets one', () => {
  it('links the mint on the Activity screen', () => {
    const [entry] = bridgeEntries([legacyRow], t);
    const mint = entry?.steps?.find((s) => s.label.endsWith('mint'));
    expect(mint?.txHash).toBe(MINT);
    expect(mint?.href).toBe(`https://testnet.sonicscan.org/tx/${MINT}`);
  });

  it('links the mint on the activity block under the form', () => {
    const item = toActivityItem(legacyRow, t);
    const mint = item.steps?.find((s) => s.label.endsWith('mint'));
    expect(mint?.explorerUrl).toBe(`https://testnet.sonicscan.org/tx/${MINT}`);
  });

  it('does not offer a link for a step with no transaction', () => {
    const [entry] = bridgeEntries([legacyRow], t);
    for (const name of ['sign', 'attestation']) {
      const step = entry?.steps?.find((s) => s.label.endsWith(name));
      expect(step?.href).toBeUndefined();
    }
  });

  it('never points a step at the chain the transfer left', () => {
    // The defect in one line: the mint is at the far end, and the source chain's
    // explorer has never heard of it.
    const [entry] = bridgeEntries([legacyRow], t);
    for (const step of entry?.steps ?? []) {
      expect(step.href ?? '').not.toContain('etherscan');
    }
  });
});

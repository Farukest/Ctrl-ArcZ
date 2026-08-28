import { beforeEach, describe, expect, it } from 'vitest';
import { resetStorage } from './setup.js';
import { loadActivity, startRun } from '../src/lib/activity.js';
import { saveBridge } from '../src/store.js';

/**
 * The record a transfer writes about itself while it is happening.
 *
 * The case behind these: pressing Bridge on the Gateway engine, signing, and
 * watching the Recent list stay empty until the transfer had finished. The row was
 * written in `onTransferId`, which is after the wallet prompt and after Circle has
 * accepted the intent, so for the whole of the part a person is actually waiting
 * through there was nothing on screen saying a transfer existed. CCTP had fixed
 * exactly this for itself, with a comment saying so; the Gateway path never got the
 * same treatment.
 *
 * The row now opens before the signature is asked for, under an id invented on the
 * spot, and takes Circle's transferId when Circle answers -- because that is the id
 * the mint is looked up by afterwards. `rekey` is what makes those the same row
 * rather than two, and that is what is pinned here.
 */

beforeEach(resetStorage);

describe('a run is on the list before the wallet is asked', () => {
  it('writes the row the moment it opens', () => {
    const run = startRun({ engine: 'gateway', from: 'Arc_Testnet', to: 'Base_Sepolia', amount: '4' });
    run.begin('sign');

    const rows = loadActivity();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(run.id);
    // `running`, and with the step it is actually on, so the list can draw a
    // spinner rather than a finished thing.
    expect(rows[0]?.state).toBe('running');
    expect(rows[0]?.steps.find((s) => s.name === 'sign')?.state).toBe('active');
  });

  it('keeps a declined signature on the list instead of losing it', () => {
    /*
     * Before there was a row to fail, a decline left nothing at all behind: a
     * toast that scrolls away and a Recent list with no trace of what had just
     * been attempted.
     */
    const run = startRun({ engine: 'gateway', from: 'Arc_Testnet', to: 'Base_Sepolia', amount: '4' });
    run.begin('sign');
    run.fail('sign', new Error('User rejected the request'));

    const row = loadActivity()[0];
    expect(row?.state).toBe('error');
    expect(row?.steps.find((s) => s.name === 'sign')?.state).toBe('error');
  });
});

describe('rekey', () => {
  it('moves the row to the identity the transfer turned out to have', () => {
    const run = startRun({ engine: 'gateway', from: 'Arc_Testnet', to: 'Base_Sepolia', amount: '4' });
    run.begin('sign');
    run.done('sign', '0xsig');
    const invented = run.id;

    run.rekey('0xcircle-transfer-id');

    const rows = loadActivity();
    // One row, not two: the same transfer the user has been watching.
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe('0xcircle-transfer-id');
    expect(rows[0]?.id).not.toBe(invented);
    // And it kept what it had already collected.
    expect(rows[0]?.steps.find((s) => s.name === 'sign')?.txHash).toBe('0xsig');
    expect(rows[0]?.amount).toBe('4');
  });

  it('leaves the handle pointing at the row rather than at where it used to be', () => {
    // `record.id` is read after the rekey to spotlight the row, and the caller
    // holds the handle across it. A snapshot id would point at a deleted key.
    const run = startRun({ engine: 'gateway', from: 'Arc_Testnet', to: 'Base_Sepolia', amount: '4' });
    run.rekey('0xtransfer');
    expect(run.id).toBe('0xtransfer');

    // And writes after the move land on the moved row.
    run.waiting();
    expect(loadActivity()).toHaveLength(1);
    expect(loadActivity()[0]?.state).toBe('pending');
  });

  it('does nothing when the name has not changed', () => {
    const run = startRun({ engine: 'gateway', from: 'Arc_Testnet', to: 'Base_Sepolia', amount: '4' });
    run.rekey(run.id);
    run.rekey('');
    expect(loadActivity()).toHaveLength(1);
  });

  it('does not leave a second copy when the transfer is written again at the end', () => {
    /*
     * The completion handler writes the finished row under the transferId, which
     * is the same key `rekey` moved it to. It has to overwrite rather than append,
     * or the list carries the transfer twice with one copy stuck on pending.
     */
    const run = startRun({ engine: 'gateway', from: 'Arc_Testnet', to: 'Base_Sepolia', amount: '4' });
    run.rekey('0xtransfer');
    const row = loadActivity()[0]!;
    saveBridge({ ...row, state: 'success' });

    const rows = loadActivity();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.state).toBe('success');
  });
});

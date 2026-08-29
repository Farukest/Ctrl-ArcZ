import { describe, expect, it } from 'vitest';
import {
  chainForStep,
  stepExplorerUrl,
  deriveStepStatuses,
  jobForEngine,
  ownedBy,
  stepIndexFor,
  stepsForEngine,
  stepsForRun,
  type LiveRun,
  type ReportedStep,
} from '../src/bridgeProgress.js';
import { BRIDGE_STEPS, GATEWAY_STEPS, type BridgeEngine } from '../src/bridgeChains.js';

/**
 * The two bridge engines, kept out of each other's screens.
 *
 * These are the cases the bridge tab got wrong in the browser, written down. The one
 * that started it: run a CCTP transfer, then switch to the Gateway tab, and "Minting
 * on the destination chain" is a green tick. Nothing on Gateway had run. Both engines
 * happen to end on a step named `mint`, the tab took its step names from the engine
 * and their progress from whichever transfer ran last, and the collision did the
 * rest -- a screen reporting a mint that this engine never performed.
 *
 * The rule underneath is that progress belongs to an engine and a screen shows only
 * its own, so most of what follows is the same question asked from both directions.
 */

const CCTP: BridgeEngine = 'cctp';
const GW: BridgeEngine = 'gateway';

function run(engine: BridgeEngine, state: string, steps: ReportedStep[]): LiveRun {
  return { engine, kind: 'transfer', id: 1, state, steps };
}

/** A finished CCTP transfer: approved, burned, attested, minted. */
const finishedCctp = run(CCTP, 'success', [
  { name: 'approve' },
  { name: 'burn' },
  { name: 'fetchAttestation' },
  { name: 'mint' },
]);

describe('ownedBy', () => {
  it('hands back progress that belongs to the engine on screen', () => {
    expect(ownedBy(CCTP, finishedCctp)).toBe(finishedCctp);
  });

  it('hides a CCTP transfer from the Gateway tab', () => {
    expect(ownedBy(GW, finishedCctp)).toBeNull();
  });

  it('hides a Gateway transfer from the CCTP tab', () => {
    expect(ownedBy(CCTP, run(GW, 'success', [{ name: 'mint' }]))).toBeNull();
  });

  it('has nothing to say about nothing', () => {
    expect(ownedBy(CCTP, null)).toBeNull();
    expect(ownedBy(CCTP, undefined)).toBeNull();
  });
});

describe('deriveStepStatuses, across engines', () => {
  it('does not light the Gateway mint from a finished CCTP transfer', () => {
    // The reported bug, at the point where it happened. Passing the other engine's
    // progress in at all is the mistake; the guarantee here is that the shared step
    // name is not enough to make it look like progress.
    const asShown = deriveStepStatuses(GATEWAY_STEPS, ownedBy(GW, finishedCctp));
    expect(asShown).toEqual(['pending', 'pending', 'pending', 'pending']);
  });

  it('does not spin the Gateway mint from a running CCTP transfer', () => {
    const running = run(CCTP, 'running', [{ name: 'burn' }, { name: 'mint' }]);
    expect(deriveStepStatuses(GATEWAY_STEPS, ownedBy(GW, running))).toEqual([
      'pending',
      'pending',
      'pending',
      'pending',
    ]);
  });

  it('does not light the CCTP mint from a finished Gateway transfer', () => {
    const gw = run(GW, 'success', [
      { name: 'deposit' },
      { name: 'sign' },
      { name: 'attestation' },
      { name: 'mint' },
    ]);
    expect(deriveStepStatuses(BRIDGE_STEPS, ownedBy(CCTP, gw))).toEqual([
      'pending',
      'pending',
      'pending',
      'pending',
    ]);
  });

  it('does not drive the CCTP stepper from a Gateway deposit', () => {
    // A deposit is a Gateway thing with a step name CCTP has never heard of. It used
    // to leave the CCTP tab showing a stepper with nothing active in it.
    const deposit: LiveRun = {
      engine: GW,
      kind: 'deposit',
      id: 7,
      state: 'running',
      steps: [{ name: 'deposit' }],
    };
    expect(ownedBy(CCTP, deposit)).toBeNull();
    expect(deriveStepStatuses(BRIDGE_STEPS, ownedBy(CCTP, deposit))).toEqual([
      'pending',
      'pending',
      'pending',
      'pending',
    ]);
  });

  it('shows the run on the tab it belongs to', () => {
    expect(deriveStepStatuses(BRIDGE_STEPS, ownedBy(CCTP, finishedCctp))).toEqual([
      'done',
      'done',
      'done',
      'done',
    ]);
  });
});

describe('deriveStepStatuses, one engine', () => {
  it('is all pending before anything has run', () => {
    expect(deriveStepStatuses(GATEWAY_STEPS, null)).toEqual([
      'pending',
      'pending',
      'pending',
      'pending',
    ]);
  });

  it('marks the newest report active and everything before it done', () => {
    const r = run(CCTP, 'running', [{ name: 'approve' }, { name: 'burn' }]);
    expect(deriveStepStatuses(BRIDGE_STEPS, r)).toEqual(['done', 'active', 'pending', 'pending']);
  });

  it('keeps moving while a burn waits on Circle', () => {
    // `pending` is burned and not yet minted. It is not a finished transfer, and the
    // indicator that treats it as one puts a tick on a mint that has not happened.
    const r = run(CCTP, 'pending', [
      { name: 'approve' },
      { name: 'burn' },
      { name: 'fetchAttestation' },
    ]);
    expect(deriveStepStatuses(BRIDGE_STEPS, r)).toEqual(['done', 'done', 'active', 'pending']);
  });

  it('shows a step the runner decided to skip as skipped, not as done', () => {
    // The deposit box's complaint: with the balance already funded the runner reports
    // `noop`, which used to render as an unstarted step and then flip to a green tick
    // the moment the transfer finished. The one row that never ran looked the most
    // convincing of the four.
    const r = run(GW, 'success', [
      { name: 'deposit', state: 'noop' },
      { name: 'sign' },
      { name: 'attestation' },
      { name: 'mint' },
    ]);
    expect(deriveStepStatuses(GATEWAY_STEPS, r)).toEqual(['skipped', 'done', 'done', 'done']);
  });

  it('shows a step that was never needed as skipped once the transfer succeeds', () => {
    // No approve step at all: the allowance already covered the burn.
    const r = run(CCTP, 'success', [
      { name: 'burn' },
      { name: 'fetchAttestation' },
      { name: 'mint' },
    ]);
    expect(deriveStepStatuses(BRIDGE_STEPS, r)).toEqual(['skipped', 'done', 'done', 'done']);
  });

  it('shows steps after a failure as pending, not as skipped', () => {
    // Nothing skipped the mint. The transfer died at the burn and never reached it,
    // and calling that "skipped" would say the transfer chose to leave it out.
    const r = run(CCTP, 'failed', [{ name: 'approve' }, { name: 'burn', state: 'error' }]);
    expect(deriveStepStatuses(BRIDGE_STEPS, r)).toEqual(['done', 'error', 'pending', 'pending']);
  });

  it('reports a failed run whose steps carry no error state', () => {
    const r = run(GW, 'failed', [{ name: 'deposit' }, { name: 'sign' }]);
    expect(deriveStepStatuses(GATEWAY_STEPS, r)).toEqual(['done', 'done', 'pending', 'pending']);
  });

  it('treats a step reported out of order by its own state, not its position', () => {
    // The runner replaces a step in place, so the last entry is not always the last
    // step. An error anywhere in the list is an error.
    const r = run(GW, 'running', [{ name: 'deposit', state: 'error' }, { name: 'sign' }]);
    expect(deriveStepStatuses(GATEWAY_STEPS, r)[0]).toBe('error');
  });

  it('says nothing about a step name the engine does not have', () => {
    const r = run(GW, 'success', [{ name: 'burn' }, { name: 'somethingElse' }]);
    expect(deriveStepStatuses(GATEWAY_STEPS, r)).toEqual([
      'skipped',
      'skipped',
      'skipped',
      'skipped',
    ]);
  });
});

describe('jobForEngine', () => {
  const jobs = [
    { engine: CCTP, state: 'success', id: 'c1' },
    { engine: GW, state: 'running', id: 'g1' },
    { engine: CCTP, state: 'running', id: 'c2' },
  ];

  it('picks the running job of the engine on screen', () => {
    expect(jobForEngine(CCTP, jobs)?.id).toBe('c2');
    expect(jobForEngine(GW, jobs)?.id).toBe('g1');
  });

  it('falls back to the newest job of this engine, never the other one', () => {
    // The fallback used to be "the newest job" with no filter, which put a Gateway
    // job on the CCTP stepper the moment the CCTP one finished.
    const settled = [
      { engine: CCTP, state: 'success', id: 'c1' },
      { engine: GW, state: 'success', id: 'g1' },
    ];
    expect(jobForEngine(CCTP, settled)?.id).toBe('c1');
  });

  it('has no job when this engine has never run one', () => {
    expect(jobForEngine(GW, [{ engine: CCTP, state: 'running', id: 'c1' }])).toBeNull();
    expect(jobForEngine(CCTP, [])).toBeNull();
  });
});

describe('stepIndexFor', () => {
  it('finds a step by its own name', () => {
    expect(stepIndexFor('burn', BRIDGE_STEPS)).toBe(1);
    expect(stepIndexFor('deposit', GATEWAY_STEPS)).toBe(0);
  });

  it('matches the two spellings of the attestation step', () => {
    expect(stepIndexFor('fetchAttestation', GATEWAY_STEPS)).toBe(2);
    expect(stepIndexFor('attestation', BRIDGE_STEPS)).toBe(2);
  });

  it('refuses a name from the other engine rather than guessing', () => {
    // This fed a `?? 'mint'` fallback, so a CCTP burn shown on a Gateway screen was
    // labelled "Minting on the destination chain".
    expect(stepIndexFor('burn', GATEWAY_STEPS)).toBe(-1);
    expect(stepIndexFor('approve', GATEWAY_STEPS)).toBe(-1);
    expect(stepIndexFor('sign', BRIDGE_STEPS)).toBe(-1);
  });

  it('prefers an exact name to one that merely contains it', () => {
    expect(stepIndexFor('mint', GATEWAY_STEPS)).toBe(3);
    expect(stepIndexFor('mint', BRIDGE_STEPS)).toBe(3);
  });
});

describe('stepsForRun', () => {
  it('gives a deposit its own rows, not the ones a transfer has', () => {
    const deposit = { engine: GW, kind: 'deposit', id: 1, state: 'running', steps: [] };
    expect(stepsForRun(GW, deposit)).toEqual(['approve', 'deposit', 'counted']);
    // What that used to look like: a deposit with a pending sign, attestation and
    // mint underneath it, none of which a deposit performs.
    expect(deriveStepStatuses(stepsForRun(GW, deposit), deposit)).toEqual([
      'pending',
      'pending',
      'pending',
    ]);
  });

  it('waits on Circle after the deposit is mined, rather than declaring it over', () => {
    // The transaction is done and the balance has not moved. Neither a tick nor a
    // blank screen is true here; the run is still going and it is the last row's.
    const mined = {
      engine: GW,
      kind: 'deposit',
      id: 1,
      state: 'running',
      steps: [
        { name: 'approve', state: 'noop' },
        { name: 'deposit', txHash: '0xdead' },
      ],
    };
    expect(deriveStepStatuses(stepsForRun(GW, mined), mined)).toEqual([
      'skipped',
      'active',
      'pending',
    ]);

    const counted = { ...mined, state: 'success', steps: [...mined.steps, { name: 'counted' }] };
    expect(deriveStepStatuses(stepsForRun(GW, counted), counted)).toEqual([
      'skipped',
      'done',
      'done',
    ]);
  });

  it('gives a subscription its four rows on either engine', () => {
    const sub = { engine: GW, kind: 'subscription', id: 1, state: 'running', steps: [] };
    expect(stepsForRun(GW, sub)).toEqual(['machine', 'create', 'listing', 'fundGw']);
    expect(stepsForRun(CCTP, sub)).toEqual(['machine', 'create', 'listing', 'fundGw']);
  });

  it('puts the spinner on the step a runner says has begun, not on the last one reported', () => {
    // A record written as it goes says `active` outright. Without that, the moment
    // `deposit` was reported as finished the spinner would sit on it, when what is
    // actually happening is the wait after it.
    const run = {
      engine: GW,
      kind: 'deposit',
      id: 1,
      state: 'running',
      steps: [
        { name: 'approve', state: 'noop' },
        { name: 'deposit', txHash: '0xdead' },
        { name: 'counted', state: 'active' },
      ],
    };
    expect(deriveStepStatuses(stepsForRun(GW, run), run)).toEqual(['skipped', 'done', 'active']);
  });

  it('does not leave a step spinning on a run that has stopped', () => {
    // What a tab closed mid-deposit leaves behind. The screen decides that such a
    // run is over; the step it was on must not still claim to be in progress.
    const abandoned = {
      engine: GW,
      kind: 'deposit',
      id: 1,
      state: 'failed',
      steps: [
        { name: 'approve', txHash: '0xaaa' },
        { name: 'deposit', state: 'active' },
      ],
    };
    expect(deriveStepStatuses(stepsForRun(GW, abandoned), abandoned)).toEqual([
      'done',
      'pending',
      'pending',
    ]);
  });

  it('gives a transfer the rows of its engine', () => {
    expect(stepsForRun(GW, { kind: 'transfer' })).toEqual(GATEWAY_STEPS);
    expect(stepsForRun(CCTP, { kind: 'transfer' })).toEqual(BRIDGE_STEPS);
    expect(stepsForRun(CCTP, null)).toEqual(BRIDGE_STEPS);
  });
});

describe('stepsForEngine', () => {
  it('gives each engine its own steps', () => {
    expect(stepsForEngine(CCTP)).toEqual(BRIDGE_STEPS);
    expect(stepsForEngine(GW)).toEqual(GATEWAY_STEPS);
  });

  it('shares exactly one step name between the engines, which is why this is here', () => {
    const shared = BRIDGE_STEPS.filter((s) => (GATEWAY_STEPS as readonly string[]).includes(s));
    expect(shared).toEqual(['mint']);
  });
});

describe('chainForStep', () => {
  /**
   * Which chain a step's transaction is on, which is the question every caller
   * used to answer with "the source" regardless of the step.
   *
   * Measured on a real transfer: Ethereum Sepolia to Sonic Testnet over Gateway,
   * mint 0xb9118aad...80697, which is on Sonic. The row offered it on
   * sepolia.etherscan.io, and when the finished row was later rewritten against
   * the destination the link vanished instead of moving, because Sonic had no
   * explorer in the registry at all. Two defects reading as one symptom.
   */
  const gw = { from: 'Ethereum_Sepolia', to: 'Sonic_Testnet' };
  const cctp = { from: 'Arc_Testnet', to: 'Base_Sepolia' };

  it('puts the mint at the far end, which is the whole point of a bridge', () => {
    expect(chainForStep('mint', gw)).toBe('Sonic_Testnet');
    expect(chainForStep('mint', cctp)).toBe('Base_Sepolia');
  });

  it('keeps the source chain’s own transactions on the source', () => {
    expect(chainForStep('approve', cctp)).toBe('Arc_Testnet');
    expect(chainForStep('burn', cctp)).toBe('Arc_Testnet');
    expect(chainForStep('deposit', gw)).toBe('Ethereum_Sepolia');
  });

  it('gives no chain to a step that is not a transaction', () => {
    /*
     * `sign` is an EIP-712 signature whose domain names no chain, and the
     * attestation is Circle answering an HTTP call. A chain here would put an
     * explorer link on a row with nothing to look up.
     */
    expect(chainForStep('sign', gw)).toBeUndefined();
    expect(chainForStep('attestation', gw)).toBeUndefined();
    expect(chainForStep('fetchAttestation', cctp)).toBeUndefined();
    expect(chainForStep('counted', gw)).toBeUndefined();
  });

  it('keeps a deposit on its one chain, whatever the step is called', () => {
    // A deposit and a subscription happen entirely on one chain and record
    // from === to, so no step of theirs can be sent to the wrong end.
    const dep = { from: 'Base_Sepolia', to: 'Base_Sepolia', kind: 'deposit' };
    for (const step of ['approve', 'deposit', 'counted', 'mint']) {
      expect(chainForStep(step, dep)).toBe('Base_Sepolia');
    }
  });

  it('never sends a step to a chain the route does not name', () => {
    for (const step of ['approve', 'burn', 'deposit', 'sign', 'attestation', 'mint', 'anything']) {
      for (const route of [gw, cctp]) {
        const answer = chainForStep(step, route);
        expect(answer === undefined || answer === route.from || answer === route.to).toBe(true);
      }
    }
  });
});

describe('stepExplorerUrl', () => {
  /**
   * A link has to be derived, not remembered.
   *
   * The URL used to be computed once and written onto the step, so a row could
   * never be told anything new. The transfer that exposed it went to Sonic Testnet
   * while the registry had no Sonic explorer: its mint kept a hash and no link,
   * and adding the explorer afterwards fixed every transfer made later and did
   * nothing for the one already on screen.
   */
  const sonic = { from: 'Ethereum_Sepolia' as const, to: 'Sonic_Testnet' as const };
  const hash = '0xb9118aad3abcdff21b17fc034f2baccf05f87bff026866b45d78951c2f680697';

  it('sends the mint to the destination chain’s explorer', () => {
    expect(stepExplorerUrl({ name: 'mint', txHash: hash }, sonic)).toBe(
      `https://testnet.sonicscan.org/tx/${hash}`,
    );
  });

  it('sends the source chain’s transactions to the source chain’s explorer', () => {
    const r = { from: 'Arc_Testnet' as const, to: 'Base_Sepolia' as const };
    expect(stepExplorerUrl({ name: 'burn', txHash: hash }, r)).toContain('testnet.arcscan.app');
    expect(stepExplorerUrl({ name: 'mint', txHash: hash }, r)).toContain('sepolia.basescan.org');
  });

  it('offers nothing for a step that has no transaction', () => {
    expect(stepExplorerUrl({ name: 'sign' }, sonic)).toBeUndefined();
    expect(stepExplorerUrl({ name: 'attestation', txHash: hash }, sonic)).toBeUndefined();
  });

  it('offers nothing rather than a link that will not resolve', () => {
    // Morph Hoodi has no explorer anyone could confirm, so the row keeps the hash
    // and offers to copy it instead of pointing somewhere that 404s.
    expect(
      stepExplorerUrl({ name: 'mint', txHash: hash }, { from: 'Arc_Testnet', to: 'Morph_Hoodi' }),
    ).toBeUndefined();
  });
});

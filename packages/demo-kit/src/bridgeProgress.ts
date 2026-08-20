/**
 * What the bridge step indicator says, and which transfer it is allowed to say it
 * about.
 *
 * This lived inside BridgeTab as two lines of `findIndex`, and those two lines had
 * a hole in them: the tab picks its step names from the engine, but the progress it
 * matched them against came from whichever transfer ran last, whichever engine that
 * was. CCTP ends on `mint` and Gateway ends on `mint`, and that single shared name
 * was enough for a finished CCTP transfer to light the last row of the Gateway
 * stepper green -- a screen claiming a mint that this engine never performed.
 *
 * Untangling it needs one idea: progress belongs to an engine, and a screen only
 * renders progress that belongs to the engine it is showing. That is a rule about
 * data, not about React, so it lives here where it can be tested without a DOM.
 */
import { BRIDGE_STEPS, GATEWAY_STEPS, type BridgeEngine } from './bridgeChains.js';

/**
 * `skipped` and `error` are the two the stepper used to be unable to express, and
 * both were rendered as `pending`: a step that was deliberately not needed and a
 * step that failed both looked like a step that had not started yet.
 */
export type StepStatus = 'pending' | 'active' | 'done' | 'skipped' | 'error';

/** One step as a runner reports it. `state` is absent while it is simply happening. */
export interface ReportedStep {
  name: string;
  state?: string;
  txHash?: string;
  explorerUrl?: string;
}

/**
 * A transfer this page is following, tagged with the engine that is performing it.
 *
 * `kind` separates the two things a Gateway screen can be doing at once: funding the
 * unified balance and spending from it. They share one slot on screen, and without
 * an identity the slower one's completion handler would clear the faster one's
 * progress. `id` is what makes a stale finisher recognisable as stale.
 */
export interface LiveRun {
  engine: BridgeEngine;
  kind: 'transfer' | 'deposit';
  id: number;
  state: string;
  steps: ReportedStep[];
}

/** Anything carrying an engine tag: a live run, a server job, a finished outcome. */
interface EngineTagged {
  engine: BridgeEngine;
}

export function stepsForEngine(engine: BridgeEngine): readonly string[] {
  return engine === 'gateway' ? GATEWAY_STEPS : BRIDGE_STEPS;
}

/**
 * What a deposit is made of, from the side of the person doing it.
 *
 * This was one row, on the grounds that funding the balance is a single
 * transaction. Two of the three things that happen are not that transaction. An
 * allowance has to exist before the deposit can be called, which is a second
 * signature and a second wallet prompt. And the money is not spendable when the
 * deposit is mined: Circle credits it only once the source chain reaches the
 * confirmations it asks for, which was measured at over twenty minutes on Base.
 *
 * One row covered the middle of those three and went quiet for the other two, so
 * the screen said nothing during the two waits a person actually asks about --
 * the prompt they were not expecting, and the balance that has not moved yet.
 *
 * `approve` is reported without a hash when the allowance already covered the
 * amount. That is a step which did not need to happen rather than one that did,
 * and the caller says so with `skip`, which draws a dash instead of a tick.
 */
export const DEPOSIT_STEPS = ['approve', 'deposit', 'counted'] as const;

/**
 * The rows to draw for whatever is currently happening.
 *
 * A deposit is not a transfer. Drawn against the transfer's four rows it came out
 * as a deposit with a pending sign, a pending attestation and a pending mint under
 * it, none of which a deposit ever performs, and all three of which stayed on the
 * screen looking like work still to come.
 */
export function stepsForRun(
  engine: BridgeEngine,
  run: { kind?: string } | null | undefined,
): readonly string[] {
  return run?.kind === 'deposit' ? DEPOSIT_STEPS : stepsForEngine(engine);
}

/**
 * The value, but only if it describes the engine being shown.
 *
 * The whole fix in one function. Every piece of transfer state on the screen goes
 * through it, so there is one answer to "does this belong here" rather than one per
 * render site, and a piece of state added later is either passed through it or is
 * visibly not.
 */
export function ownedBy<T extends EngineTagged>(engine: BridgeEngine, value: T | null | undefined) {
  return value && value.engine === engine ? value : null;
}

/**
 * Which server job the stepper describes: the newest still running on this engine,
 * else the newest on this engine.
 *
 * Jobs have always carried their engine; the picker simply ignored it, so a Gateway
 * job could drive the CCTP indicator and the other way round. Both halves of the
 * choice are filtered, not just the first, because falling back to "the newest job"
 * across engines reintroduces exactly the bleed this is here to stop.
 */
export function jobForEngine<T extends EngineTagged & { state: string }>(
  engine: BridgeEngine,
  jobs: readonly T[],
): T | null {
  const mine = jobs.filter((j) => j.engine === engine);
  return mine.find((j) => j.state === 'running') ?? mine[mine.length - 1] ?? null;
}

/** Still moving. `pending` is burned-but-not-yet-minted, which is in flight, not over. */
function inFlight(state: string): boolean {
  return state === 'running' || state === 'pending' || state === 'returning';
}

/**
 * Every step of an engine, with what is true of it right now.
 *
 * Absent from the report is two different things and they are told apart by whether
 * anything failed. A run that succeeded without approving did not need to approve,
 * and that step is `skipped`. A run that died at the burn never reached the mint,
 * and that step is `pending`: nothing skipped it, it simply never came up.
 */
export function deriveStepStatuses(
  active: readonly string[],
  run: { state: string; steps: readonly ReportedStep[] } | null | undefined,
): StepStatus[] {
  if (!run) return active.map(() => 'pending');
  const moving = inFlight(run.state);
  const broke = run.state === 'failed' || run.steps.some((s) => isError(s.state));
  const last = run.steps.length - 1;

  return active.map((name) => {
    const at = run.steps.findIndex((s) => s.name === name);
    if (at < 0) {
      if (moving || broke) return 'pending';
      return 'skipped';
    }
    const st = run.steps[at]?.state;
    if (isError(st)) return 'error';
    // `noop` is the runner's word for a step it decided was unnecessary -- a deposit
    // when the balance already covers the spend. It used to arrive here and be shown
    // as unstarted, then flip to a green tick the moment the transfer finished, so
    // the one row that never ran was also the one that looked most convincing.
    if (st === 'noop' || st === 'skipped') return 'skipped';
    if (moving && at === last) return 'active';
    return 'done';
  });
}

function isError(state: string | undefined): boolean {
  return state === 'error' || state === 'failed';
}

/**
 * Where a reported step sits in an engine's list, or -1 when it is not one of them.
 *
 * The fuzzy match is for `fetchAttestation` against `attestation`, which are the same
 * step under two spellings. It is deliberately not symmetric across engines: callers
 * pass the list of the engine they are showing, and a name from the other engine is
 * meant to come back as -1 rather than as a plausible-looking row.
 */
export function stepIndexFor(name: string, list: readonly string[]): number {
  const n = name.toLowerCase();
  const exact = list.findIndex((s) => s.toLowerCase() === n);
  if (exact >= 0) return exact;
  const partial = list.findIndex((s) => n.includes(s.toLowerCase()));
  if (partial >= 0) return partial;
  if (n.includes('attest')) return list.findIndex((s) => s.toLowerCase().includes('attest'));
  return -1;
}

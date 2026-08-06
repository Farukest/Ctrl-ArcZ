import { BridgeKit } from '@circle-fin/bridge-kit';
import { circleAdapter } from './circleAdapter.js';
import {
  BRIDGE_STEPS,
  type BridgeChainName,
  type BridgeOutcome,
  type BridgeStepName,
} from './bridgeChains.js';

export * from './bridgeChains.js';

/**
 * Server-only. Moves USDC across chains with Circle CCTP via Bridge Kit: burn on
 * the source, Circle-signed attestation, mint on the destination. `useForwarder`
 * lets Circle submit the destination mint, so the user needs no gas on the
 * destination chain.
 *
 * `onStep` fires as each CCTP step completes, carrying that step's transaction hash
 * when it has one. The hash matters more than the progress does: a burn whose hash
 * nobody wrote down is USDC destroyed on the source chain with no cheap way to find
 * the attestation that would mint it on the destination. Circle's own guidance is to
 * "save the bridge transfer state for recovery scenarios", and this is the only
 * moment that state exists before the call returns.
 * Imports Bridge Kit, so it must never be loaded in the browser (see bridgeChains.ts).
 */
export async function bridgeUsdc(params: {
  privateKey: `0x${string}`;
  from: BridgeChainName;
  to: BridgeChainName;
  amount: string;
  onStep?: (step: { name: BridgeStepName; txHash?: string }) => void;
}): Promise<BridgeOutcome> {
  const kit = new BridgeKit();
  const adapter = circleAdapter(params.privateKey);

  if (params.onStep) {
    // The emitter hands back `{ method, values }`, and `values.txHash` is what makes
    // an interrupted transfer recoverable. Subscribing per step name rather than to
    // '*' keeps anything the kit adds later out of our reported steps until we have
    // decided what it means.
    const on = kit.on.bind(kit) as (
      event: string,
      cb: (payload: { values?: { txHash?: string } }) => void,
    ) => void;
    for (const step of BRIDGE_STEPS) {
      on(step, (payload) => {
        const txHash = payload?.values?.txHash;
        params.onStep?.({ name: step, ...(txHash ? { txHash } : {}) });
      });
    }
  }

  const result = (await kit.bridge({
    from: { adapter, chain: params.from },
    to: { adapter, chain: params.to, useForwarder: true },
    amount: params.amount,
  })) as {
    amount: string;
    state: string;
    steps: {
      name: string;
      state: string;
      txHash?: string;
      explorerUrl?: string;
      error?: unknown;
    }[];
  };

  // Pick only serializable primitives. Bridge Kit's raw steps carry `data`/`error`
  // objects (viem receipts, gas as BigInt) that JSON.stringify cannot handle, so
  // this helper never leaks them across the SDK/HTTP boundary. The error is
  // flattened to one line rather than dropped: a failed bridge with no reason is
  // undebuggable from the outside and unactionable from the inside.
  return {
    state: result.state,
    amount: result.amount,
    steps: result.steps.map((s) => ({
      name: s.name,
      state: s.state,
      ...(s.txHash ? { txHash: s.txHash } : {}),
      ...(s.explorerUrl ? { explorerUrl: s.explorerUrl } : {}),
      ...(s.error ? { error: shortError(s.error) } : {}),
    })),
  };
}

/** A one-line, serializable reason from whatever the kit threw. */
function shortError(e: unknown): string {
  if (typeof e === 'string') return e.slice(0, 300);
  const o = e as { shortMessage?: string; details?: string; message?: string };
  return (o?.shortMessage ?? o?.details ?? o?.message ?? String(e)).slice(0, 300);
}

import { UnifiedBalanceKit } from '@circle-fin/unified-balance-kit';
import { createViemAdapterFromPrivateKey } from '@circle-fin/adapter-viem-v2';
import { privateKeyToAccount } from 'viem/accounts';
import type { BridgeChainName, BridgeOutcome, GatewayChainName } from './bridgeChains.js';

export * from './bridgeChains.js';

/**
 * Server-only. Moves USDC across chains with Circle Gateway: deposit into a
 * unified USDC balance on the source chain, then spend instantly on the
 * destination (Arc finality is ~0.5s). `useForwarder` lets Circle's Orbit relayer
 * submit the destination mint, so no destination gas is needed. Imports the
 * Node-first Unified Balance Kit, so this must never load in the browser.
 *
 * Gateway reserves a generous max-fee on the burn intent (a multiple of the
 * amount), so the unified balance must hold well more than amount + the actual
 * fee to be allowed to spend. We fund to a comfortable target on the first
 * transfer; after that the balance covers the spend and repeat transfers are a
 * pure instant spend (no deposit).
 */
// Minimum the balance must hold to spend `amount` (covers the max-fee reservation).
const minSpendable = (amount: number) => amount * 3 + 0.2;
// How much to fund the balance up to when a top-up is needed (headroom for repeats).
const fundTarget = (amount: number) => Math.max(minSpendable(amount), 1);

export async function gatewayTransfer(params: {
  privateKey: `0x${string}`;
  from: BridgeChainName;
  to: BridgeChainName;
  amount: string;
}): Promise<BridgeOutcome> {
  const kit = new UnifiedBalanceKit();
  const adapter = createViemAdapterFromPrivateKey({ privateKey: params.privateKey });
  const owner = privateKeyToAccount(params.privateKey).address;
  const amount = Number(params.amount);

  type Step = { name: string; state: string; txHash?: string; explorerUrl?: string };
  const steps: Step[] = [];

  const readConfirmed = async (): Promise<number> => {
    const bal = (await kit.getBalances({
      sources: [{ adapter }],
      networkType: 'testnet',
      includePending: true,
    })) as { totalConfirmedBalance?: string };
    return Number(bal.totalConfirmedBalance ?? 0);
  };

  // 1) Fund the unified balance from the source chain only if it can't cover the
  //    transfer plus the fee reservation. Otherwise the transfer is an instant spend.
  const min = minSpendable(amount);
  const confirmed = await readConfirmed();
  if (confirmed < min) {
    const topUp = (fundTarget(amount) - confirmed).toFixed(6);
    const dep = (await kit.deposit({
      from: { adapter, chain: params.from as GatewayChainName },
      amount: topUp,
      token: 'USDC',
    })) as { txHash?: string; explorerUrl?: string };
    steps.push({
      name: 'deposit',
      state: 'success',
      ...(dep.txHash ? { txHash: dep.txHash } : {}),
      ...(dep.explorerUrl ? { explorerUrl: dep.explorerUrl } : {}),
    });
    // Wait until the deposit is reflected as confirmed and covers the spend.
    for (let i = 0; i < 60; i++) {
      if ((await readConfirmed()) >= min) break;
      await new Promise((r) => setTimeout(r, 2000));
    }
  } else {
    steps.push({ name: 'deposit', state: 'noop' });
  }

  // 2) Spend instantly to the destination via the forwarder (no destination gas).
  const spend = (await kit.spend({
    amount: params.amount,
    token: 'USDC',
    from: { adapter },
    to: { chain: params.to as GatewayChainName, recipientAddress: owner, useForwarder: true },
  })) as {
    txHash?: string;
    steps?: Step[];
  };

  const sub = (n: string) => spend.steps?.find((s) => s.name === n);
  const mint = sub('mint');
  steps.push({ name: 'sign', state: sub('signBurnIntents')?.state ?? 'success' });
  steps.push({ name: 'attestation', state: sub('fetchAttestation')?.state ?? 'success' });
  steps.push({
    name: 'mint',
    state: mint?.state ?? 'success',
    ...(mint?.txHash ? { txHash: mint.txHash } : {}),
    ...(mint?.explorerUrl ? { explorerUrl: mint.explorerUrl } : {}),
  });

  const ok = mint?.state === 'success' || Boolean(spend.txHash);
  return {
    state: ok ? 'success' : 'error',
    amount: params.amount,
    steps,
  };
}

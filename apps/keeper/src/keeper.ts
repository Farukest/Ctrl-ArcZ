import {
  createPublicClient,
  createWalletClient,
  erc20Abi,
  fallback,
  formatUnits,
  http,
  type Address,
  type PublicClient,
  type WalletClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { ADDRESSES, CTRL_ARCZ_ADDRESS, RPC_URLS, arcTestnet, reclaimExpired } from '@ctrl-arcz/sdk';
import { env } from './env.js';
import { decide } from './decide.js';
import { OpenLedger, confirm } from './scan.js';
import { drawSalary } from './salary.js';

const USDC = ADDRESSES.USDC as Address;
const CONTRACT = CTRL_ARCZ_ADDRESS as Address;

/**
 * The keeper loop.
 *
 * One tick: bring the ledger of open transfers up to the chain head, confirm the
 * expired ones against chain state, decide what is worth doing, do it, then top
 * up its own tank if it is running low.
 *
 * Every reclaim returns money to the address that sent it — the contract, not
 * this process, decides where it goes — so the worst a broken keeper can do is
 * waste its own budget. That is what makes it safe to run unattended.
 */

const account = privateKeyToAccount(env.keeperPk);

const transport = () => fallback(RPC_URLS.map((u) => http(u, { retryCount: 2 })));
const publicClient: PublicClient = createPublicClient({ chain: arcTestnet, transport: transport() });
const walletClient: WalletClient = createWalletClient({
  account,
  chain: arcTestnet,
  transport: transport(),
});

const ledger = new OpenLedger(CONTRACT);

export const keeperAddress = account.address;

const usdc = (v: bigint) => `${formatUnits(v, 6)} USDC`;

async function balance(): Promise<bigint> {
  return (await publicClient.readContract({
    address: USDC,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [account.address],
  })) as bigint;
}

/** The co-signer's address, read once. Only needed for the salary pull. */
let cosignerAddress: Address | null = null;
async function resolveCosigner(): Promise<Address | null> {
  if (cosignerAddress) return cosignerAddress;
  try {
    const res = await fetch(env.cosignUrl);
    if (!res.ok) return null;
    const body = (await res.json()) as { address?: Address };
    cosignerAddress = body.address ?? null;
    return cosignerAddress;
  } catch {
    return null;
  }
}

export interface TickReport {
  head: bigint;
  open: number;
  reclaimed: { transferId: bigint; amount: bigint; sender: Address; txHash: string }[];
  skipped: Record<string, number>;
  salary?: string;
  balance: bigint;
}

export async function tick(): Promise<TickReport> {
  const head = await publicClient.getBlockNumber();
  await ledger.sync(publicClient, head, {
    backfillBlocks: env.backfillBlocks,
    spanBlocks: env.scanSpanBlocks,
  });

  const now = Math.floor(Date.now() / 1000);
  const candidates = await confirm(publicClient, CONTRACT, ledger.expired(now, env.maxReads));
  const bal = await balance();

  const plan = decide(candidates, {
    balance: bal,
    gasPerAction: env.gasPerAction,
    reserve: env.reserve,
    maxActions: env.maxActions,
  }, now);

  const skipped: Record<string, number> = {};
  for (const s of plan.skip) {
    skipped[s.reason] = (skipped[s.reason] ?? 0) + 1;
    // Anything the contract would reject forever is dropped from the ledger; a
    // transfer that is merely unaffordable or not yet due stays for a later tick.
    if (s.reason === 'not-reclaimable') ledger.forget(s.candidate.transferId);
  }

  const reclaimed: TickReport['reclaimed'] = [];
  for (const c of plan.act) {
    if (env.dryRun) {
      console.log(`[dry-run] would reclaim #${c.transferId} (${usdc(c.amount)} -> ${c.sender})`);
      continue;
    }
    try {
      const txHash = await reclaimExpired({ publicClient, walletClient }, c.transferId);
      ledger.forget(c.transferId);
      reclaimed.push({ transferId: c.transferId, amount: c.amount, sender: c.sender, txHash });
      console.log(`reclaimed #${c.transferId}: ${usdc(c.amount)} returned to ${c.sender} (${txHash})`);
    } catch (e) {
      // Someone else may have cancelled or claimed it between our read and our
      // send. That is a normal race, not a fault — re-read it next tick.
      console.warn(`reclaim #${c.transferId} failed: ${e instanceof Error ? e.message : e}`);
    }
  }

  const report: TickReport = {
    head,
    open: ledger.size,
    reclaimed,
    skipped,
    balance: await balance(),
  };

  const salary = await maybeDrawSalary(report.balance);
  if (salary) report.salary = salary;

  return report;
}

async function maybeDrawSalary(bal: bigint): Promise<string | undefined> {
  if (!env.salaryBox || env.dryRun || bal >= env.lowWater) return undefined;
  const cosigner = await resolveCosigner();
  if (!cosigner) return 'co-signer unreachable; cannot draw salary';

  try {
    const outcome = await drawSalary({
      publicClient,
      walletClient,
      keeper: account.address,
      box: env.salaryBox,
      cosignUrl: env.cosignUrl,
      cosignerAddress: cosigner,
      balance: bal,
      lowWater: env.lowWater,
      targetBalance: env.targetBalance,
      signMessage: (message) => walletClient.signMessage({ account, message }),
    });
    return outcome.pulled
      ? `drew ${usdc(outcome.amount!)} salary (${outcome.txHash})`
      : `no salary drawn: ${outcome.reason}`;
  } catch (e) {
    return `salary pull failed: ${e instanceof Error ? e.message : e}`;
  }
}

export async function run(): Promise<void> {
  console.log(`keeper ${account.address} watching ${CONTRACT}`);
  console.log(
    `budget: gas/action ${usdc(env.gasPerAction)}, reserve ${usdc(env.reserve)}, ` +
      `max ${env.maxActions}/tick${env.dryRun ? ' (DRY RUN)' : ''}`,
  );
  if (env.salaryBox) console.log(`salary box: ${env.salaryBox}`);
  else console.log('no salary box configured; the keeper will stop at its reserve');

  for (;;) {
    try {
      const r = await tick();
      const skips = Object.entries(r.skipped)
        .map(([k, v]) => `${k}=${v}`)
        .join(' ');
      console.log(
        `tick @${r.head}: open=${r.open} reclaimed=${r.reclaimed.length} ` +
          `balance=${usdc(r.balance)}${skips ? ` | ${skips}` : ''}${r.salary ? ` | ${r.salary}` : ''}`,
      );
    } catch (e) {
      console.error(`tick failed: ${e instanceof Error ? e.message : e}`);
    }
    await new Promise((r) => setTimeout(r, env.pollMs));
  }
}

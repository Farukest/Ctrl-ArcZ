/**
 * A harness for the source picker, reachable at `?lab=sources`.
 *
 * The real Bridge screen reads live Gateway balances, so most of the cases that
 * matter here (a dust chain, an Ethereum-only path, a total that falls short)
 * cannot be produced on demand. This drives the same component from scripted
 * balances instead, so every branch is one click away and stays that way.
 */
import { useState } from 'react';
import {
  Button,
  Card,
  ChainLogo,
  CostBlock,
  GatewaySources,
  gatewayFeeLines,
  gatewayPlan,
  type GatewaySource,
} from '@ctrl-arcz/demo-kit/ui';
import { chainLabel, usdc, type GatewayChain, type SourceBalance } from '@ctrl-arcz/sdk';

const u = (n: string): bigint => {
  const [w = '0', f = ''] = n.split('.');
  return BigInt(w) * 1_000_000n + BigInt((f + '000000').slice(0, 6));
};
const on = (chain: GatewayChain, amount: string): SourceBalance => ({ chain, balance: u(amount) });

/** Forwarding into Arc, measured at about 0.016 USDC. */
const FORWARDING = 16_000n;

interface Scenario {
  id: string;
  title: string;
  amount: bigint;
  balances: SourceBalance[];
  expect: string;
}

const SCENARIOS: Scenario[] = [
  {
    id: 'plenty',
    title: '1. Tek zincir bol',
    amount: u('5'),
    balances: [on('Arc_Testnet', '17.2'), on('Base_Sepolia', '12.89')],
    expect: 'tek bacak, Arc',
  },
  {
    id: 'fee-short',
    title: '2. Tutar tutuyor, ücret tutmuyor',
    amount: u('17.2'),
    balances: [on('Arc_Testnet', '17.20257'), on('Base_Sepolia', '12.89')],
    expect: 'ikinci zincirden tamamlanır',
  },
  {
    id: 'no-split',
    title: '3. Tek zincir yetiyor, bölme',
    amount: u('10'),
    balances: [on('Arc_Testnet', '3'), on('Base_Sepolia', '13')],
    expect: 'tek bacak, Base',
  },
  {
    id: 'two-legs',
    title: '4. İki bacak şart',
    amount: u('12'),
    balances: [on('Arc_Testnet', '6'), on('Base_Sepolia', '7')],
    expect: 'Base önce (kalan payı büyük)',
  },
  {
    id: 'short',
    title: '5. Toplam yetmiyor',
    amount: u('10'),
    balances: [on('Arc_Testnet', '2'), on('Base_Sepolia', '3')],
    expect: 'eksik tutar + yatır',
  },
  {
    id: 'dust',
    title: '6. Toz zincir',
    amount: u('9.9'),
    balances: [on('Arc_Testnet', '9.99'), on('Sei_Testnet', '0.0004')],
    expect: 'Sei listede ama yetersiz',
  },
  {
    id: 'ethereum',
    title: '7. Sadece Ethereum ile olur',
    amount: u('100'),
    balances: [on('Arc_Testnet', '1'), on('Ethereum_Sepolia', '500')],
    expect: 'otomatikte eksik, elle seçilebilir',
  },
  {
    id: 'two-alone',
    title: '8. İkisi de tek başına yeter',
    amount: u('5'),
    balances: [on('Base_Sepolia', '50'), on('Unichain_Sepolia', '50')],
    expect: 'ucuz olan (Unichain) önerilir',
  },
  {
    id: 'three-legs',
    title: '9. Üç bacak',
    amount: u('11'),
    balances: [on('Arc_Testnet', '4'), on('Base_Sepolia', '4'), on('OP_Sepolia', '4')],
    expect: 'üç bacak, en dolusu önce',
  },
  {
    id: 'empty',
    title: '10. Hiç bakiye yok',
    amount: u('5'),
    balances: [],
    expect: 'tamamı eksik',
  },
  {
    /*
     * The case that drove the ranking, in the words it was reported in: adding a
     * network costs a base fee, so the cheapest chain is not always the right one.
     * Base charges 0.01 a leg and OP 0.0015, but Base holds too little to finish
     * the payment and OP does, so OP is the answer and per-leg price is not what
     * decides it. The list has to say so before the choice is made.
     */
    id: 'ranking',
    title: '11. Ucuz ağ yetmiyor',
    amount: u('7'),
    balances: [on('Arc_Testnet', '6'), on('Base_Sepolia', '0.5'), on('OP_Sepolia', '1.1')],
    expect: 'OP önce (tamamlıyor), Base eksik kalıyor',
  },
];

export function SourceLab() {
  const [scenario, setScenario] = useState<Scenario>(SCENARIOS[0]!);
  const [amount, setAmount] = useState(usdc(SCENARIOS[0]!.amount));
  const [sources, setSources] = useState<GatewaySource[]>([
    { chain: 'Arc_Testnet', amount: '' },
  ]);
  const [deposited, setDeposited] = useState<string | null>(null);

  // The same call the real screen makes, so the harness cannot pass on something
  // the Bridge tab would fail.
  const n = Number(amount);
  const wanted = Number.isFinite(n) && n > 0 ? BigInt(Math.round(n * 1e6)) : 0n;
  const plan = gatewayPlan({
    amount: wanted,
    sources,
    balances: scenario.balances,
    forwarding: FORWARDING,
  });

  const pick = (s: Scenario) => {
    setScenario(s);
    // One network on the first chain that holds anything, with the scenario's
    // amount in the field: the same start the real screen gets.
    const first = s.balances[0]?.chain ?? 'Arc_Testnet';
    setSources([{ chain: first, amount: '' }]);
    setAmount(usdc(s.amount));
    setDeposited(null);
  };

  return (
    <div className="lab">
      <Card title="Kaynak seçimi denemesi" subtitle="Her senaryo tek tıkla">
        <div className="lab__scenarios">
          {SCENARIOS.map((s) => (
            <Button
              key={s.id}
              size="sm"
              variant={s.id === scenario.id ? 'primary' : 'ghost'}
              onClick={() => pick(s)}
              data-testid={`lab-${s.id}`}
            >
              {s.title}
            </Button>
          ))}
        </div>

        <div className="rule" />

        <div className="lab__state">
          <div>
            <strong>{scenario.title}</strong>
            <div className="lab__muted">beklenen: {scenario.expect}</div>
          </div>
          <div className="lab__muted" data-testid="lab-balances">
            {scenario.balances.length === 0
              ? 'bakiye yok'
              : scenario.balances.map((b) => `${b.chain} ${usdc(b.balance)}`).join('  ·  ')}
          </div>
        </div>

        <GatewaySources
          amount={amount}
          onAmount={setAmount}
          sources={sources}
          onSources={setSources}
          balances={scenario.balances}
          forwarding={FORWARDING}
          loaded
          onDeposit={(need: bigint) => setDeposited(usdc(need))}
        />

        {plan.allocation && plan.allocation.legs.length > 0 && (
          <CostBlock
            testId="lab-cost"
            lines={[
              {
                label: 'Circle fee',
                value: `${usdc(plan.allocation.fee)} USDC`,
                testId: 'lab-fee',
                breakdown: gatewayFeeLines(plan.allocation, FORWARDING).map((part) => ({
                  label: part.chain ? (
                    <>
                      <ChainLogo id={part.chain} size={16} />
                      <span>{chainLabel(part.chain)}</span>
                    </>
                  ) : (
                    <span>Forwarding to Arc Testnet</span>
                  ),
                  value: `${usdc(part.fee)} USDC`,
                  testId: part.chain ? `lab-fee-${part.chain}` : 'lab-fee-forwarding',
                })),
              },
            ]}
            total={{
              label: 'You pay',
              value: `${usdc(plan.amount + plan.allocation.fee)} USDC`,
              testId: 'lab-youpay',
            }}
          />
        )}

        {/* What the split actually came out as, so a screenshot of this harness
            answers the question it was opened to answer. */}
        <div className="lab__muted" data-testid="lab-legs">
          {plan.allocation && plan.allocation.legs.length > 0
            ? plan.allocation.legs.map((l) => `${l.chain} ${usdc(l.value)}`).join('  +  ')
            : `bacak yok, eksik ${usdc(plan.allocation?.shortfall ?? wanted)}`}
        </div>

        {deposited && (
          <div className="lab__muted" data-testid="lab-deposit">
            yatırma alanı {deposited} ile açıldı
          </div>
        )}
      </Card>
    </div>
  );
}

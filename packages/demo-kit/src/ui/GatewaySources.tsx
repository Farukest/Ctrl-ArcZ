/**
 * Where a Gateway payment comes from: one From block, however many networks it takes.
 *
 * A Gateway balance is one figure spread over several chains, and a spend can draw
 * on any number of them under a single signature. The mistake this replaces was to
 * read that as "several From cards": the amount field, the balance line, the
 * percentage chips and the token pill were all duplicated per chain, so a payment
 * split three ways drew three identical cards each labelled From, and the screen
 * looked like a rendering bug rather than a split.
 *
 * It also asked the wrong thing of the user. Three cards with three amounts means
 * doing the division by hand, against fees that differ per chain, to hit a total
 * that is never shown. So the amount moved back to where it belongs -- one figure,
 * typed once, the thing actually being sent -- and the chains below it are how it
 * gets carried. The allocator divides it; a row typed into overrules the allocator
 * for that chain and the rest re-divides around it.
 *
 * Everything here is the app's existing furniture: `swapcard` for the block,
 * `AmountField` for the amount and its balance, `Select` for each chain.
 */
import { useCallback, useMemo } from 'react';
import {
  chainLabel,
  usdc,
  COSTLY_BASE_FEE,
  GATEWAY_BASE_FEE,
  maxDeliverable,
  type Allocation,
  type GatewayChain,
  type SourceBalance,
} from '@ctrl-arcz/sdk';
import {
  capacityOf,
  formatSubunits,
  residualAfterAll,
  planFor,
  rankCandidates,
  typedSubunits,
  type GatewaySource,
} from './sourceCards.js';
import { AmountField } from './AmountField.js';
import { ChainLogo } from './ChainLogo.js';
import { ChainSelect } from './ChainSelect.js';
import { Notice } from './Notice.js';
import { useT } from '../i18n/context.js';

export interface GatewaySourcesProps {
  /** What the recipient should receive, as typed. One figure for the whole spend. */
  amount: string;
  onAmount: (next: string) => void;
  /** The chains carrying it. An empty `amount` on a row means the allocator decides. */
  sources: GatewaySource[];
  onSources: (next: GatewaySource[]) => void;
  /** Confirmed Gateway balances. A deposit still confirming is not spendable. */
  balances: readonly SourceBalance[];
  /** The destination's forwarding fee, from a recent estimate. */
  forwarding: bigint;
  /** True once the balances have been read, so an unread one shimmers. */
  loaded: boolean;
  /** Opens the funding box with the figure already in it. */
  onDeposit?: (amount: bigint) => void;
}

const feeOf = (c: GatewayChain): bigint => GATEWAY_BASE_FEE[c] ?? 10_000n;

export function GatewaySources({
  amount,
  onAmount,
  sources,
  onSources,
  balances,
  forwarding,
  loaded,
  onDeposit,
}: GatewaySourcesProps) {
  const t = useT();

  const balanceOf = (c: GatewayChain): bigint =>
    balances.find((b) => b.chain === c)?.balance ?? 0n;

  const want = typedSubunits(amount);
  const listed = useMemo(() => new Set(sources.map((s) => s.chain)), [sources]);

  /**
   * The split, asked of the allocator rather than worked out again here.
   *
   * The rows, the shortfall, the offer and the send button all read this one
   * answer. A second copy of the fee arithmetic living in a component is a second
   * copy that drifts, and this screen has already been caught arguing with its own
   * send button once.
   */
  const alloc: Allocation | null = useMemo(
    () => (want > 0n ? planFor({ amount: want, sources, balances, forwarding }) : null),
    [want, sources, balances, forwarding],
  );

  const short = alloc?.shortfall ?? 0n;
  const over = alloc?.overfill ?? 0n;

  /** What the listed networks can actually deliver, which is what Max means here. */
  const reach = useMemo(
    () => maxDeliverable({ balances, forwarding, allow: (c) => listed.has(c) }),
    [balances, forwarding, listed],
  );

  /** Everything the balance holds, listed or not, for the line above the rows. */
  const held = useMemo(() => balances.reduce((sum, b) => sum + b.balance, 0n), [balances]);

  /** Chains not already on a row. */
  const spare = useMemo(
    () => balances.filter((b) => !listed.has(b.chain)),
    [balances, listed],
  );

  /**
   * What the networks already listed could still give, above what was typed into
   * them.
   *
   * Pinning Arc to 2 in a 12 USDC payment leaves 4 sitting unused on Arc, and the
   * split then falls short. The honest fix is to let Arc carry more; without this
   * the screen offered a deposit instead, asking somebody to send money to a chain
   * that already had it. A row that could close the gap says so, and the offer
   * below only speaks for what is missing after that.
   */
  const slackOn = (s: GatewaySource): bigint => {
    const pin = typedSubunits(s.amount);
    if (pin <= 0n) return 0n;
    const room = capacityOf({ chain: s.chain, balance: balanceOf(s.chain) }, forwarding);
    return room > pin ? room - pin : 0n;
  };

  /**
   * What would still be missing once every network has been used, which is the
   * only figure worth putting on a button that asks somebody to deposit.
   *
   * Zero means there is nothing to deposit for: the money is already there, it is
   * just on chains this payment has not been pointed at yet, and the list below is
   * where that gets fixed.
   */
  const residual = useMemo(
    () => residualAfterAll({ amount: want, sources, balances, forwarding }),
    [want, sources, balances, forwarding],
  );

  /**
   * The networks that could be added, priced by what adding them would do.
   *
   * Every candidate is run through the allocator as though it had been added, so
   * the figure beside it is the whole plan's fee rather than its own base fee.
   * That is the only ranking that answers the question people have: a chain that
   * is cheap per leg but too small forces a third leg and ends up dearer than one
   * that costs more and finishes the job.
   *
   * Recomputed with the amount and the rows, which is exactly when the answer
   * changes. Ten pure `allocate` calls with no I/O.
   */
  const ranked = useMemo(
    () => rankCandidates({ amount: want, sources, balances, forwarding }),
    [want, sources, balances, forwarding],
  );
  const rankOf = useMemo(() => new Map(ranked.map((r) => [r.chain, r])), [ranked]);
  const order = useMemo(() => new Map(ranked.map((r, i) => [r.chain, i])), [ranked]);
  const compareCandidates = useCallback(
    (a: GatewayChain, b: GatewayChain) =>
      (order.get(a) ?? Number.MAX_SAFE_INTEGER) - (order.get(b) ?? Number.MAX_SAFE_INTEGER),
    [order],
  );

  /**
   * What each candidate row says: what it holds, and what picking it would cost.
   *
   * Coloured by rank rather than by an absolute fee, because base fees span a
   * factor of a thousand and any number chosen as "expensive" would be wrong on
   * most balance sheets. Green is the cheapest way to finish the payment; amber is
   * one that finishes it at several times that; a network that cannot finish it
   * says what would still be missing instead of a price.
   */
  const candidateMeta = useCallback(
    (chain: GatewayChain) => {
      const r = rankOf.get(chain);
      if (!r) return null;
      return (
        <>
          <span className="chainrow__have">
            {t('bridge.src.hasAmount', { amount: usdc(r.balance) })}
          </span>
          <span className={`chainrow__tone chainrow__tone--${r.tone}`}>
            {r.room <= 0n
              ? t('bridge.src.tooSmall')
              : r.completes
                ? t('bridge.src.totalFee', { fee: usdc(r.fee) })
                : t('bridge.src.stillShort', { amount: usdc(r.stillShort) })}
          </span>
        </>
      );
    },
    [rankOf, t],
  );

  /**
   * What a row's picker shows beside each network: what is there, and what a leg
   * on it costs.
   *
   * This is the difference between a list of names and a list you can decide from.
   * The names alone ask somebody to remember which chain their money is on and
   * what each one charges, against fees that run from a thousandth of a cent to a
   * whole USDC.
   */
  const rowMeta = (chain: GatewayChain) => {
    const held = balanceOf(chain);
    return (
      <>
        {/* What is there, and what a leg on it costs. Both name their unit and
            they are separated, because side by side and unlabelled they read as
            one number followed by another number: "3.068709 fee 0.0035" is two
            answers to two different questions wearing the same clothes.

            The fee is USDC on every chain, not the chain's own gas token: Circle
            takes it out of the amount being sent, which is why a Gateway spend
            needs no gas anywhere. Saying "USDC" is therefore a fact and not a
            guess -- and the one worth stating, since a per-chain fee is exactly
            where a reader would expect to see ETH. */}
        <span className="chainrow__have">
          {loaded ? t('bridge.src.hasAmount', { amount: usdc(held) }) : ''}
        </span>
        <span
          className={[
            'chainrow__fee',
            feeOf(chain) >= COSTLY_BASE_FEE && 'chainrow__fee--costly',
          ]
            .filter(Boolean)
            .join(' ')}
        >
          {t('bridge.src.legFee', { fee: usdc(feeOf(chain)) })}
        </span>
      </>
    );
  };

  /*
   * Shown and not choosable rather than hidden: someone looking for the four
   * hundredths they hold on Sei deserves to be told it cannot cover its own fee,
   * not left wondering whether the app knows about Sei. That is the one case where
   * a row stays in a list it cannot be picked from, and it is not the same as an
   * unsupported network -- this chain does the job, it just has nothing on it.
   */
  const dust = (chain: GatewayChain) =>
    capacityOf({ chain, balance: balanceOf(chain) }, forwarding) <= 0n;

  const setChain = (i: number, chain: GatewayChain) =>
    onSources(sources.map((s, j) => (j === i ? { ...s, chain } : s)));

  const setLeg = (i: number, value: string) =>
    onSources(sources.map((s, j) => (j === i ? { ...s, amount: value } : s)));

  const drop = (i: number) => onSources(sources.filter((_, j) => j !== i));

  /**
   * Opening the funding box with the missing figure already in it.
   *
   * The only thing left for this control to do. Adding a network was the other
   * half and it has moved to the list, where the user can see what each one holds
   * instead of being handed the app's guess -- which is what they asked for, and
   * also the only way to tell the difference between "there is nothing else" and
   * "there is something else and it is too small to help".
   */
  const topUp = () => {
    if (residual > 0n) onDeposit?.(residual);
  };

  /** What a row carries: what was typed into it, or what the allocator gave it. */
  const legOf = (s: GatewaySource): bigint => {
    const pinned = typedSubunits(s.amount);
    if (pinned > 0n) return pinned;
    return alloc?.legs.find((l) => l.chain === s.chain)?.value ?? 0n;
  };

  return (
    <div className="swapcard gwfrom" data-testid="bridge-from-card">
      <div className="swapcard__head">
        <span className="swapcard__label">{t('bridge.from')}</span>
        <span className="gwfrom__count" data-testid="gwsrc-count">
          {sources.length === 1
            ? chainLabel(sources[0]!.chain)
            : t('bridge.src.count', { n: String(sources.length) })}
        </span>
      </div>

      {/*
        One amount, because there is one payment.

        The figure beside it is what the networks below can actually deliver, not
        what they hold: every leg pays its own base fee and the transfer pays one
        forwarding fee, so a Max filled from the raw balance is the one figure the
        next check refuses. It is labelled "spendable" for the same reason -- called
        "Gateway balance" it sat two lines above the actual Gateway balance, a
        larger number, with nothing to say why they differed.
      */}
      <AmountField
        value={amount}
        onChange={onAmount}
        balance={loaded ? reach : null}
        balanceLabel={t('bridge.src.spendable')}
        onMax={(f) => onAmount(usdc((reach * BigInt(Math.round(f * 10_000))) / 10_000n))}
        percents={[0.25, 0.5]}
        /*
         * The pill names the asset and where it is coming from, the way it does on
         * CCTP. It was plain text here, alone in the app, because the field is
         * given no single `chain` -- and it is given none for a good reason, since
         * a Gateway payment can come off four chains at once and picking one of
         * them to draw would be a lie. That is an argument for not naming ONE
         * chain, not for naming none: with a single source there is nothing
         * ambiguous about it, and with several the honest picture is all of them.
         *
         * Which also empties the block's head, where these logos used to sit. They
         * say the same thing in both places, and beside the amount is where the
         * question "where is this coming from" is actually being asked.
         */
        tokenSlot={
          <span className="usdcpill">
            {sources.length === 1 ? (
              <ChainLogo id={sources[0]!.chain} size={20} />
            ) : (
              <span className="gwfrom__stack" aria-hidden>
                {sources.map((s, i) => (
                  <span className="gwfrom__chip" key={`${s.chain}-${i}`}>
                    <ChainLogo id={s.chain} size={18} />
                  </span>
                ))}
              </span>
            )}
            USDC
          </span>
        }
        data-testid="bridge-amount"
      />

      <div className="gwlegs">
        <div className="gwlegs__head">
          <span className="gwlegs__title">{t('bridge.src.title')}</span>
          <span className="gwlegs__held" data-testid="gwsrc-held">
            {loaded ? t('bridge.src.heldOn', { amount: usdc(held) }) : ''}
          </span>
        </div>

        {sources.map((s, i) => {
          const room = capacityOf({ chain: s.chain, balance: balanceOf(s.chain) }, forwarding);
          const pinned = typedSubunits(s.amount) > 0n;
          const carries = legOf(s);
          /*
           * A row is allowed to hold more than its chain can pay: people type the
           * figure they have in mind, and rewriting it under them is worse than
           * letting it stand. What is not allowed is saying nothing about it.
           *
           * Only while something is actually missing, though. `capacityOf` prices a
           * chain as though it were the leading leg, which is the strict reading and
           * the right one alone; in a split only one leg carries the forwarding fee,
           * so the others have more room than this says. Left unguarded it put "Arc
           * can send 3.623786" on a row holding 3.627024 in a split the allocator had
           * already accepted, which is the screen arguing with its own send button.
           */
          const overCap = loaded && short > 0n && pinned && typedSubunits(s.amount) > room;
          return (
            <div
              className={['gwleg', pinned && 'gwleg--pinned', overCap && 'gwleg--over']
                .filter(Boolean)
                .join(' ')}
              key={`${s.chain}-${i}`}
              data-testid={`gwsrc-${s.chain}`}
            >
              <div className="gwleg__pick">
                <ChainSelect<GatewayChain>
                  purpose="gatewaySource"
                  value={s.chain}
                  onChange={(v) => setChain(i, v)}
                  // The chains the other rows already name. Usable, just not twice.
                  exclude={sources.filter((_, j) => j !== i).map((o) => o.chain)}
                  meta={rowMeta}
                  disabledFor={(c) => c !== s.chain && dust(c)}
                  ariaLabel={t('bridge.from')}
                />
              </div>

              {/*
                The allocator's figure is the placeholder, so an automatic row shows
                what it is carrying without pretending the user put it there, and
                typing over it is the same gesture as editing any other field. There
                is no mode to switch, and clearing the field hands the row back.
              */}
              <input
                className="gwleg__input"
                value={s.amount}
                onChange={(e) => setLeg(i, sanitize(e.target.value))}
                placeholder={loaded ? usdc(carries) : '0'}
                inputMode="decimal"
                aria-label={t('bridge.src.legAria', { chain: chainLabel(s.chain) })}
                data-testid={`gwsrc-amount-${s.chain}`}
              />

              {/* Only ever offered when there is more than one, so the block cannot
                  be emptied into a payment that comes from nowhere. */}
              {sources.length > 1 && (
                <button
                  type="button"
                  className="gwleg__drop"
                  onClick={() => drop(i)}
                  aria-label={t('bridge.src.remove', { chain: chainLabel(s.chain) })}
                  data-testid={`gwsrc-drop-${s.chain}`}
                >
                  &times;
                </button>
              )}

              <div className="gwleg__meta">
                {/* A pinned row holding this payment back, with the money to fix it
                    sitting on its own chain. Pressing it raises the pin by exactly
                    what is missing, or to the ceiling, whichever comes first. */}
                {loaded && short > 0n && !overCap && slackOn(s) > 0n ? (
                  <button
                    type="button"
                    className="gwleg__cap"
                    onClick={() => {
                      const grown = typedSubunits(s.amount) + short;
                      setLeg(i, formatSubunits(grown < room ? grown : room));
                    }}
                    data-testid={`gwsrc-raise-${s.chain}`}
                  >
                    {t('bridge.src.raise', {
                      chain: chainLabel(s.chain),
                      amount: usdc(slackOn(s) < short ? slackOn(s) : short),
                    })}
                  </button>
                ) : overCap ? (
                  room > 0n ? (
                    <button
                      type="button"
                      className="gwleg__cap"
                      onClick={() => setLeg(i, formatSubunits(room))}
                      data-testid={`gwsrc-cap-${s.chain}`}
                    >
                      {t('bridge.src.overCapacity', {
                        chain: chainLabel(s.chain),
                        amount: usdc(room),
                      })}
                    </button>
                  ) : (
                    // "can send 0 of this" is arithmetic pretending to be a sentence,
                    // and the button under it sets the field to zero, which helps
                    // nobody. A chain with nothing to spare offers nothing.
                    <span className="gwleg__cap gwleg__cap--none" data-testid={`gwsrc-none-${s.chain}`}>
                      {t('bridge.src.nothingHere', { chain: chainLabel(s.chain) })}
                    </span>
                  )
                ) : (
                  <span className="gwleg__have" data-testid={`gwsrc-have-${s.chain}`}>
                    {loaded
                      ? t('bridge.src.ready', { amount: usdc(balanceOf(s.chain)) })
                      : t('bridge.gwBalanceLoading')}
                  </span>
                )}
                {/* The per-network fee, on the network it is charged for. The same
                    figures total up in the cost block below; here they are next to
                    the choice that causes them, which is where a chain that costs a
                    hundred times its neighbour has to be visible. */}
                <span
                  className={['gwleg__fee', feeOf(s.chain) >= COSTLY_BASE_FEE && 'gwleg__fee--costly']
                    .filter(Boolean)
                    .join(' ')}
                  data-testid={`gwsrc-fee-${s.chain}`}
                >
                  {pinned ? t('bridge.src.pinned') : t('bridge.src.auto')}
                  <span className="gwleg__dot" aria-hidden />
                  {t('bridge.src.legFee', { fee: usdc(feeOf(s.chain)) })}
                </span>
              </div>
            </div>
          );
        })}

        {/*
          The offer, in the gap where the next row would go. Deliberately not a
          warning: nothing here is a mistake, it is a payment that has outgrown its
          networks and a button that gives it another. Red text under an amount
          field reads as blame, and there is nobody to blame.
        */}
        {spare.length > 0 && (
          <ChainSelect<GatewayChain>
            purpose="gatewaySource"
            variant="ghost"
            value=""
            placeholder={t('bridge.src.add')}
            wanted={short > 0n}
            exclude={sources.map((s) => s.chain)}
            // Where the money actually is. A network holding nothing is not a
            // place to draw from and not a question anyone is asking; one holding
            // too little to cover its own fee is both, so it stays, greyed.
            only={ranked.map((r) => r.chain)}
            compare={compareCandidates}
            meta={candidateMeta}
            // Dust is shown and refused rather than hidden: a chain holding four
            // hundredths is a real place the user's money is, and "we cannot use
            // this" answers the question that leaving it out would raise.
            disabledFor={(c) => (rankOf.get(c)?.room ?? 0n) <= 0n}
            searchText={(c) => usdc(balanceOf(c))}
            onChange={(chain) => onSources([...sources, { chain, amount: '' }])}
            ariaLabel={t('bridge.src.add')}
            data-testid="gwsrc-more"
          />
        )}
      </div>

      {/*
        What is wrong with the split, if anything, said once and at the bottom of
        the block that owns it. Per-row notes say which chain; these say what the
        payment as a whole is missing, and only one of them can be true at a time.
      */}
      {/*
        One voice for a shortfall, and which voice depends on what would fix it.

        A gap another network can close is not a warning: it is a pill in the list
        saying "take the other 6.06 from Base", and pressing it is the whole story.
        A gap no network can close needs money that is not there yet, so it says
        so and carries the deposit.

        They used to be two voices at once, disagreeing. The pill said "Top up
        5.123" while the sentence under it said "still 8.055 short" -- both true
        (one nets out what Base could add, the other does not) and together
        unreadable, because nothing on screen said which number was which.
      */}
      {loaded && residual > 0n && (
        <Notice
          tone="warn"
          testId="gwsrc-shortfall"
          action={
            onDeposit
              ? {
                  label: t('bridge.src.topUp', { amount: usdc(residual) }),
                  onClick: topUp,
                  testId: 'gwsrc-topup',
                }
              : null
          }
        >
          {t('bridge.src.short', { amount: usdc(residual) })}
        </Notice>
      )}
      {/* Only once the split otherwise works. A set of rows can be both impossible
          and over-subscribed at the same time -- pin 50 on a chain holding 6 while
          sending 12 -- and printing "44.055 short" above "38 more than you are
          sending" asks the reader to reconcile two facts that only make sense
          together to whoever wrote the allocator. The shortfall is the one that
          stops the transfer, so it speaks alone. */}
      {over > 0n && short === 0n && (
        <Notice tone="warn" testId="gwsrc-overfill">
          {t('bridge.src.overfill', { amount: usdc(over) })}
        </Notice>
      )}
      {alloc?.costly && (
        <Notice tone="info" testId="gwsrc-costly">
          {t('bridge.src.costlyNote')}
        </Notice>
      )}
    </div>
  );
}

/** Digits and one dot, six decimals, the same filter every amount field uses. */
function sanitize(raw: string): string {
  const cleaned = raw.replace(/[^\d.]/g, '');
  const [whole = '', ...rest] = cleaned.split('.');
  const frac = rest.join('').slice(0, 6);
  return rest.length > 0 ? `${whole}.${frac}` : whole;
}

/**
 * The split behind a set of rows, for the screen around them.
 *
 * Exported beside the component so a caller does not reach into it: the cost block
 * needs the fee, the destination card needs what arrives and the spend itself needs
 * the legs, and all three have to be the same answer the rows were drawn from.
 */
export function gatewayPlan(opts: {
  amount: bigint;
  sources: readonly GatewaySource[];
  balances: readonly SourceBalance[];
  forwarding: bigint;
}): { amount: bigint; allocation: Allocation | null } {
  if (opts.amount <= 0n) return { amount: opts.amount, allocation: null };
  return { amount: opts.amount, allocation: planFor(opts) };
}

/**
 * The per-network breakdown of what Circle charges, for the cost block.
 *
 * `fee` is the sum of every leg's base fee plus one forwarding fee, and that sum is
 * the only place those numbers were visible: a split across Ethereum and Unichain
 * charged 1.017 and the screen said "Circle fee 1.017", with nothing to say that a
 * thousandth of it was Unichain. So the same arithmetic is handed back in pieces,
 * derived from the allocation rather than recomputed beside it.
 */
export function gatewayFeeLines(
  alloc: Allocation | null,
  forwarding: bigint,
): { chain: GatewayChain | null; fee: bigint }[] {
  if (!alloc || alloc.legs.length === 0) return [];
  return [
    ...alloc.legs.map((l) => ({ chain: l.chain, fee: feeOf(l.chain) })),
    { chain: null, fee: forwarding },
  ];
}

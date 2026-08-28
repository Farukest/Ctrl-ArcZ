import { useMemo, type ReactNode } from 'react';
import type { CctpChainName } from '@ctrl-arcz/sdk';
import { chainsFor, labelOf, type ChainPurpose } from '../chainCatalog.js';
import { ChainLogo } from './ChainLogo.js';
import { Select, type SelectOption } from './components.js';
import { useT } from '../i18n/context.js';

/**
 * Choosing a network, once, for every screen that asks.
 *
 * There were five copies of this: the bridge's source and destination, the
 * subscription funding box, the Gateway source rows and the header chip each built
 * their own `{ value, label, text, icon }` array from their own idea of which
 * chains belonged and what they were called. Two of them used one label rule and
 * two used another, so the same network could read differently on two screens; one
 * of them offered twenty networks of which fifteen led to a dead end.
 *
 * What a caller says now is what job it is for. The list, the order, the label and
 * the logo follow from that, and a network that cannot do the job is not in the
 * list at all -- see `chainCatalog.ts` for why that is a structural answer rather
 * than a greyed-out row.
 */
export interface ChainSelectProps<T extends string = CctpChainName> {
  /** What the chosen network is going to be used for. Decides the list. */
  purpose: ChainPurpose;
  /** The chosen chain, by name. */
  value: string;
  onChange: (chain: T) => void;
  /**
   * Networks to leave out because they are spoken for elsewhere on this form.
   *
   * Not the same as unsupported: the Gateway source rows exclude the chains the
   * other rows already name, and those chains are perfectly usable, just not
   * twice.
   */
  exclude?: readonly string[];
  /**
   * Narrow the catalog's list to these, keeping the catalog as the outer bound.
   *
   * For a picker whose relevant set is smaller than its possible one: the list of
   * networks to add a payment to is the networks holding something, not the eleven
   * Circle runs Gateway on. Nine rows reading only a name, greyed out, are nine
   * rows of nothing -- and they crowd out the two that matter.
   */
  only?: readonly string[] | undefined;
  /**
   * The right-hand side of each row: a balance, a fee, a reason it is greyed out.
   *
   * This is what makes the picker worth opening. A list of names asks somebody to
   * remember where their money is; a list of names with the figures beside them
   * answers it.
   */
  meta?: ((chain: T) => ReactNode) | undefined;
  /** Present, not choosable. Say why in {@link meta}. */
  disabledFor?: ((chain: T) => boolean) | undefined;
  /** Extra searchable text per chain, appended to the name. */
  searchText?: ((chain: T) => string) | undefined;
  /**
   * How the rows are ordered, when the catalog's order is not the useful one.
   *
   * The catalog puts Arc first and then keeps the registry's order, which is right
   * for choosing where to work. It is not right for choosing which network to add
   * to a payment, where the useful order is which one leaves the payment cheapest
   * and closest to done -- an answer only the caller can compute.
   */
  compare?: ((a: T, b: T) => number) | undefined;
  /** What the trigger says when nothing is selected. Required for `ghost`. */
  placeholder?: string | undefined;
  /** Turns a `ghost` trigger into the obvious next thing to press. */
  wanted?: boolean;
  ariaLabel?: string | undefined;
  variant?: 'field' | 'chip' | 'ghost';
  align?: 'start' | 'center' | 'end';
  full?: boolean;
  disabled?: boolean;
  /** Logo size. 20 in a form, 18 in the header chip. */
  size?: number;
  'data-testid'?: string;
}

/*
 * Generic over the chain name so a caller working in a narrower set gets its own
 * type back. `purpose` and `T` are two statements of the same fact -- a
 * `gatewaySource` picker only ever yields a `GatewayChain` -- and the cast below is
 * where they are joined. Encoding the pairing in the type system would be a
 * conditional type for every purpose, read by nobody, to save one line here.
 */
export function ChainSelect<T extends string = CctpChainName>({
  purpose,
  value,
  onChange,
  exclude,
  only,
  meta,
  disabledFor,
  searchText,
  compare,
  placeholder,
  wanted,
  ariaLabel,
  variant = 'field',
  align = 'start',
  full,
  disabled,
  size = 20,
  'data-testid': testId,
}: ChainSelectProps<T>) {
  const t = useT();
  const excluded = useMemo(() => new Set(exclude ?? []), [exclude]);

  const options = useMemo<SelectOption[]>(() => {
    const allowed = only ? new Set(only) : undefined;
    const listed = chainsFor(purpose).filter(
      (c) => c === value || (!excluded.has(c) && (!allowed || allowed.has(c))),
    );
    const ordered = compare
      ? [...listed].sort((a, b) => compare(a as unknown as T, b as unknown as T))
      : listed;
    const rows = ordered.map<SelectOption>((chain) => {
        const name = labelOf(chain);
        const side = meta?.(chain as unknown as T);
        return {
          value: chain,
          label: side ? (
            <span className="chainrow">
              <span className="chainrow__name">{name}</span>
              <span className="chainrow__meta">{side}</span>
            </span>
          ) : (
            name
          ),
          // The trigger is a title, not a row: the balance beside a chain name in
          // a card header reads as the card's own figure.
          triggerLabel: name,
          text: searchText ? `${name} ${searchText(chain as unknown as T)}` : name,
          icon: <ChainLogo id={chain} size={size} />,
          disabled: disabledFor?.(chain as unknown as T) ?? false,
        };
      });

    /*
     * A selected network the list does not contain still has to show its name.
     *
     * `Select` renders whatever `value` matches and falls back to the placeholder,
     * which no chain picker sets, so a miss is a blank control. It happens for
     * real: the bridge's engine switch narrows twenty chains to eleven while the
     * chain binding re-derives in an effect, so for one commit the picker holds a
     * value its own options no longer offer. The header hits it whenever the
     * wallet is on a network we have no entry for.
     *
     * Two components had each worked this out and patched it locally. Now nobody
     * has to.
     */
    if (value && !rows.some((o) => o.value === value)) {
      rows.unshift({
        value,
        label: labelOf(value),
        triggerLabel: labelOf(value),
        text: labelOf(value),
        icon: <ChainLogo id={value} size={size} />,
        // Choosable, because it is already chosen. Disabling it would make the
        // control refuse the state it is currently in.
      });
    }
    return rows;
  }, [purpose, value, excluded, only, meta, disabledFor, searchText, compare, size]);

  return (
    <Select
      value={value}
      options={options}
      onChange={(v) => onChange(v as T)}
      ariaLabel={ariaLabel ?? t('common.network')}
      variant={variant}
      className={wanted ? 'is-wanted' : undefined}
      align={align}
      {...(placeholder !== undefined ? { placeholder } : {})}
      {...(full !== undefined ? { full } : {})}
      {...(disabled !== undefined ? { disabled } : {})}
      // Twenty networks is past the point where scanning beats typing, and the
      // short lists cost nothing: the field is one row and it is already focused.
      searchable
      searchPlaceholder={t('common.networkSearch')}
      noResultsText={t('common.networkNone')}
      {...(testId !== undefined ? { 'data-testid': testId } : {})}
    />
  );
}

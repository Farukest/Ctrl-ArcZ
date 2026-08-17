import { useMemo } from 'react';
import { formatUnits } from 'viem';
import { ARC_TOKENS, type TokenInfo } from '@ctrl-arcz/sdk';
import { useT } from '../i18n/context.js';
import { Select } from './components.js';

/**
 * Which token an amount is in, on one screen.
 *
 * Built on the same `Select` as every other menu in the app, so it inherits the
 * popover on desktop, the bottom sheet on mobile, the search box and its clear
 * button. There is no second dropdown implementation here.
 *
 * Search matches the symbol, the words people actually type ("euro", "dollar")
 * and the contract address, because the one thing someone checks before sending
 * to a token they are unsure about is its address.
 *
 * No icon. We do not have the projects' own marks, and the lettered badge that
 * stands in for a missing chain logo reads as "US" beside the word "USDC" -- the
 * first two letters of the thing it is sitting next to. A symbol is already the
 * token's name; a badge repeating it is decoration that costs a scan.
 *
 * What it will not do is turn a pasted address into a spendable token. The list
 * is the registry and nothing else: an address that is not in it returns "not
 * found", not "add this". A token contract that imitates another is the whole
 * shape of the attack this app exists to refuse, and a picker that accepts any
 * address is a picker that will eventually be handed a lookalike.
 */
export function TokenPicker({
  value,
  onChange,
  disabled,
  tokens = ARC_TOKENS,
  balances,
  'data-testid': testId,
}: {
  value: TokenInfo;
  onChange: (token: TokenInfo) => void;
  disabled?: boolean;
  /** Defaults to every token on Arc. Narrow it where a surface supports fewer. */
  tokens?: readonly TokenInfo[];
  /** Optional, in base units, keyed by symbol. Absent means "not read yet". */
  balances?: Partial<Record<string, bigint>>;
  'data-testid'?: string;
}) {
  const t = useT();

  const options = useMemo(
    () =>
      tokens.map((token) => {
        const held = balances?.[token.symbol];
        return {
          value: token.symbol,
          // The balance rides along in the row, because "which token" and "have I
          // got any" are the same question at the moment of asking. It is left off
          // when it has not been read: a zero we have not verified is a lie about
          // someone's money, and the trigger shows the symbol alone anyway.
          label:
            held === undefined ? (
              token.symbol
            ) : (
              <span className="tokenrow">
                <span className="tokenrow__sym">{token.symbol}</span>
                <span className="tokenrow__bal">{formatUnits(held, token.decimals)}</span>
              </span>
            ),
          triggerLabel: token.symbol,
          // Everything the search should match, in one string: the symbol, our own
          // words for it, and the address.
          text: [token.symbol, ...token.searchNames, token.address].join(' '),
        };
      }),
    [tokens, balances],
  );

  return (
    <Select
      value={value.symbol}
      options={options}
      onChange={(symbol) => {
        const next = tokens.find((x) => x.symbol === symbol);
        if (next && next.symbol !== value.symbol) onChange(next);
      }}
      disabled={disabled ?? false}
      // Always, not only once the list is long. Two rows do not need filtering,
      // but the box is also the only place a contract address can be checked
      // against what is on screen, and that is worth a row of chrome on a screen
      // about sending money to a token you may not have sent before.
      searchable
      searchPlaceholder={t('token.search')}
      noResultsText={t('token.none')}
      ariaLabel={t('token.label')}
      align="end"
      data-testid={testId ?? 'token-picker'}
    />
  );
}


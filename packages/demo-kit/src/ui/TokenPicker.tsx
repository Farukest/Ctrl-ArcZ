import { useMemo } from 'react';
import { formatUnits } from 'viem';
import { spendableTokensFor, tokensFor, type TokenInfo } from '@ctrl-arcz/sdk';
import { useT } from '../i18n/context.js';
import { Select } from './components.js';
import { TokenLogo } from './TokenLogo.js';

/**
 * Which token an amount is in, on one screen.
 *
 * Built on the same `Select` as every other menu in the app, so it inherits the
 * popover on desktop, the bottom sheet on mobile, the search box and its clear
 * button. There is no second dropdown implementation here.
 *
 * The list comes from the chain, not from a constant: the same symbol is a
 * different contract on every network, so a picker that does not take a chain is
 * a picker that will eventually offer the wrong address. On a chain we have
 * verified nothing for, it offers nothing, which is the honest answer.
 *
 * Search matches the symbol, the name, the words people type ("euro", "bitcoin")
 * and the contract address, because the one thing someone checks before sending
 * a token they are unsure about is its address.
 *
 * What it will not do is turn a pasted address into a spendable token. The list
 * is the registry and nothing else. ArcScan's search for "cirBTC" returns eight
 * contracts answering to that symbol, three of them named Mock or Demo; a picker
 * that accepts any address is a picker that will be handed one of those.
 */
/** Below this many tokens the list is short enough to read without filtering. */
const SEARCH_FROM = 3;

export function TokenPicker({
  value,
  onChange,
  chainId,
  disabled,
  balances,
  'data-testid': testId,
}: {
  value: TokenInfo;
  onChange: (token: TokenInfo) => void;
  /** The wallet's chain. Decides which contracts these symbols mean. */
  chainId: number | undefined;
  disabled?: boolean;
  /** In each token's own base units, keyed by symbol. Absent means "not read". */
  balances?: Partial<Record<string, bigint>>;
  'data-testid'?: string;
}) {
  const t = useT();
  const tokens = tokensFor(chainId);

  /**
   * Reasons are spelled out rather than turned into a key at run time. Building
   * `token.restricted.${reason}` type-checks against nothing, so a new reason
   * would ship as a missing string that only shows up on screen; written this way
   * the compiler asks for the translation when the reason is added.
   */
  const restrictedText = (reason: string) =>
    reason === 'allowlist' ? t('token.restricted.allowlist') : reason;

  const options = useMemo(
    () =>
      tokens.map((token) => {
        const held = balances?.[token.symbol];
        return {
          value: token.symbol,
          label: (
            <span className="tokenrow">
              <span className="tokenrow__id">
                <span className="tokenrow__sym">{token.symbol}</span>
                <span className="tokenrow__name">{token.name}</span>
              </span>
              <span className="tokenrow__right">
                {token.restricted
                  ? restrictedText(token.restricted.reason)
                  : // The number only. The row has already said which token this
                    // is, twice, in the symbol and the name; a third time on the
                    // right is width spent on nothing.
                    //
                    // Blank rather than zeroed while unread: a zero is a claim
                    // about someone's money and an unread balance is not one.
                    held === undefined
                    ? ''
                    : formatUnits(held, token.decimals)}
              </span>
            </span>
          ),
          // The trigger is a chip beside an amount field; the row's second line
          // and its balance would read as part of the number.
          triggerLabel: token.symbol,
          text: [token.symbol, token.name, ...token.searchNames, token.address].join(' '),
          icon: <TokenLogo token={token} size={24} />,
          disabled: Boolean(token.restricted),
        };
      }),
    [tokens, balances, t],
  );

  return (
    <Select
      value={value.symbol}
      options={options}
      onChange={(symbol) => {
        const next = spendableTokensFor(chainId).find((x) => x.symbol === symbol);
        if (next && next.symbol !== value.symbol) onChange(next);
      }}
      disabled={disabled ?? false}
      /*
       * Only once there is a list worth searching.
       *
       * The box earns its row when it saves scrolling or lets somebody check a
       * contract address against what is on screen. Above a chain with one token
       * it did neither: a search field, a placeholder reading "Search by name or
       * address", and one row underneath it, which is a control that exists to
       * filter a list of one. Four is where a list starts being a list.
       */
      searchable={tokens.length > SEARCH_FROM}
      searchPlaceholder={t('token.search')}
      noResultsText={t('token.none')}
      ariaLabel={t('token.label')}
      align="end"
      data-testid={testId ?? 'token-picker'}
    />
  );
}

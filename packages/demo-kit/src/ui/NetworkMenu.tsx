import { useMemo, useState } from 'react';
import { ARC_TESTNET_CHAIN_ID, CCTP_CHAINS, chainLabel, type CctpChainName } from '@ctrl-arcz/sdk';
import { bridgeChainLabel } from '../bridgeChains.js';
import { useT } from '../i18n/context.js';
import { ChainLogo } from './ChainLogo.js';
import { Select } from './components.js';
import type { SessionState } from '../useSession.js';

/**
 * The wallet's network, in the header.
 *
 * This is the wallet's chain and nothing else. The bridge's own from/to selectors
 * pick a route and are a different question; this one answers "where is my wallet
 * right now", which until now the app only said in a warning banner that appeared
 * after the fact. A chip that is always present says it before the user does
 * anything, and gives them somewhere to fix it.
 *
 * It never invents a network. Switching goes through the wallet, and a chain the
 * wallet does not know is reported as missing rather than added behind the user's
 * back -- adding one means naming an RPC endpoint they would then trust with every
 * request. Arc is the single exception, and only because we operate its endpoints
 * (see `ensureArcChain`).
 *
 * A chain we have no entry for still renders, as its number. The chip's whole job
 * is to state where the wallet is; a chip that goes blank on an unknown network
 * would be silent exactly when the user is somewhere unexpected.
 */
export function NetworkMenu({ state }: { state: SessionState }) {
  const t = useT();
  const [switching, setSwitching] = useState(false);
  const { session, switchTo } = state;

  const options = useMemo(() => {
    const names = Object.keys(CCTP_CHAINS) as CctpChainName[];
    // Arc first: it is where every contract lives, so it is the answer to "put me
    // back". The rest keep the registry's order, which is Circle's domain order.
    const ordered = [
      ...names.filter((n) => CCTP_CHAINS[n].chainId === ARC_TESTNET_CHAIN_ID),
      ...names.filter((n) => CCTP_CHAINS[n].chainId !== ARC_TESTNET_CHAIN_ID),
    ];
    return ordered.map((name) => {
      const label = bridgeChainLabel(name) === name ? chainLabel(name) : bridgeChainLabel(name);
      return {
        value: String(CCTP_CHAINS[name].chainId),
        label,
        text: label,
        icon: <ChainLogo id={name} size={18} />,
      };
    });
  }, []);

  if (!session) return null;

  const current = options.find((o) => o.value === String(session.chainId));

  return (
    <Select
      variant="chip"
      align="end"
      value={String(session.chainId)}
      options={
        // An unknown chain is a real state (any network in the user's wallet), and
        // the trigger renders whatever `value` matches. Adding the row keeps the
        // chip truthful instead of falling back to the placeholder.
        current
          ? options
          : [
              {
                value: String(session.chainId),
                label: t('common.chainNumber', { chainId: session.chainId }),
                text: String(session.chainId),
                // No icon. ChainLogo's fallback is a two-letter brand mark taken
                // from the name, and for a network we have no entry for that
                // invents a badge reading "UN" beside the number -- a mark for a
                // brand that does not exist. The number is the honest answer.
              },
              ...options,
            ]
      }
      onChange={(value) => {
        const chainId = Number(value);
        if (chainId === session.chainId || switching) return;
        setSwitching(true);
        void switchTo(chainId).finally(() => setSwitching(false));
      }}
      disabled={switching}
      searchable
      searchPlaceholder={t('common.networkSearch')}
      noResultsText={t('common.networkNone')}
      // The current network, not just "Network". Under 480px the label is hidden
      // and the logo is aria-hidden, so without this the only thing announced is
      // the word "Network" -- the control names itself and withholds its answer.
      ariaLabel={`${t('common.network')}: ${
        current?.label ?? t('common.chainNumber', { chainId: session.chainId })
      }`}
      data-testid="network-menu"
    />
  );
}

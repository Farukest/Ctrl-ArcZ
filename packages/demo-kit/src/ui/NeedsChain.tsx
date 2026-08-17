import { useState } from 'react';
import { cctpChainByChainId, chainLabel } from '@ctrl-arcz/sdk';
import { preferredChainFor, type ChainFeature } from '../chainSupport.js';
import { useT } from '../i18n/context.js';
import { Button } from './components.js';
import { IconAlert } from './icons.js';

/**
 * What a screen shows when the wallet is on a chain this screen cannot work on.
 *
 * One line and the button that fixes it, in place of the form. Not a disabled
 * form: a form you can fill in and then cannot submit spends the user's attention
 * before telling them, and the reason lands at the bottom of the screen, next to
 * the button, rather than where they started.
 *
 * The switch keeps them here. Sending them to a landing screen to change networks
 * and back again is how a two-second correction becomes a re-typed form.
 */
/** A chain's name for a sentence, or its number where we have no entry for it. */
function labelOf(chainId: number | undefined, fallback: string): string {
  if (chainId === undefined) return fallback;
  const name = cctpChainByChainId(chainId);
  return name ? chainLabel(name) : `chain ${chainId}`;
}

export function NeedsChain({
  feature,
  onSwitch,
  chainId: walletChainId,
}: {
  feature: ChainFeature;
  /** `switchTo` from the session. Kept as a prop so this stays presentational. */
  onSwitch: (chainId: number) => Promise<void>;
  /** The chain the wallet is on, so the line can name it. */
  chainId?: number;
}) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const chainId = preferredChainFor(feature);
  const target = labelOf(chainId, 'Arc Testnet');

  return (
    <div className="needschain" data-testid="needs-chain" data-feature={feature}>
      <IconAlert width={18} height={18} />
      {/* Names the network the user is actually on. Saying a feature "happens on
          Arc" was true when Arc was the only deployment and became false the day it
          was not: it gives a user on an unsupported chain a reason that is not the
          reason, and points at one of several chains as if it were the only one. */}
      <span className="needschain__text">
        {t(`chain.needs.${feature}`, { chain: labelOf(walletChainId, 'this network') })}
      </span>
      <Button
        size="sm"
        loading={busy}
        onClick={() => {
          setBusy(true);
          void onSwitch(chainId).finally(() => setBusy(false));
        }}
        data-testid="needs-chain-switch"
      >
        {t('common.switchTo', { chain: target })}
      </Button>
    </div>
  );
}

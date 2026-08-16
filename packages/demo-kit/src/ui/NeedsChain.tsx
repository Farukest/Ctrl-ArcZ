import { useState } from 'react';
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
export function NeedsChain({
  feature,
  onSwitch,
}: {
  feature: ChainFeature;
  /** `switchTo` from the session. Kept as a prop so this stays presentational. */
  onSwitch: (chainId: number) => Promise<void>;
}) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const chainId = preferredChainFor(feature);

  return (
    <div className="needschain" data-testid="needs-chain" data-feature={feature}>
      <IconAlert width={18} height={18} />
      <span className="needschain__text">{t(`chain.needs.${feature}`)}</span>
      <Button
        size="sm"
        loading={busy}
        onClick={() => {
          setBusy(true);
          void onSwitch(chainId).finally(() => setBusy(false));
        }}
        data-testid="needs-chain-switch"
      >
        {t('common.switchToArc')}
      </Button>
    </div>
  );
}

import { useState } from 'react';
import { Card, InfoBody, SegmentedTabs, useT } from '@ctrl-arcz/demo-kit/ui';
import { type Session } from '@ctrl-arcz/demo-kit';
import { SendTab } from './SendTab.js';
import { PrivatePayTab } from './PrivatePayTab.js';

type PayMode = 'standard' | 'private';

/**
 * One "Pay" destination. Sending to someone is a single intent; the two ways to do
 * it (a claim-code protected transfer vs. a private single-use address) are delivery
 * modes, not separate places, so they live behind one segmented control instead of
 * two peer tabs.
 */
export function PayTab({
  session,
  balance,
  balanceMissing,
  onSent,
  onSwitchChain,
}: {
  session: Session;
  /** Spendable USDC on Arc, in subunits. Passed down rather than read again: two
   *  reads of one balance is two answers, and the header already has it. */
  balance: bigint | null;
  /** Why the balance is missing, when it is. Passed down so an unreadable
   *  balance holds still instead of shimmering for a number that is not coming. */
  balanceMissing: 'loading' | 'unavailable';
  onSent: () => void;
  onSwitchChain: (chainId: number) => Promise<void>;
}) {
  const t = useT();
  const [pay, setPay] = useState<PayMode>('standard');

  return (
    <div className="paytab">
      <Card data-testid="pay-tab">
        <div className="paytab__seg">
        <SegmentedTabs
          tabs={[
            {
              id: 'standard',
              label: t('pay.seg.standard'),
              infoAria: t('pay.pick.aria'),
              info: (
                <InfoBody
                  lead={t('pay.pick.protected.lead')}
                  points={[
                    t('pay.pick.protected.b1'),
                    t('pay.pick.protected.b2'),
                    t('pay.pick.protected.b3'),
                  ]}
                />
              ),
            },
            {
              id: 'private',
              label: t('pay.seg.private'),
              infoAria: t('pay.pick.aria'),
              info: (
                <InfoBody
                  lead={t('ppay.summary')}
                  points={[t('ppay.point1'), t('ppay.point2'), t('ppay.point3')]}
                />
              ),
            },
          ]}
          value={pay}
          onChange={setPay}
        />
        </div>
        {pay === 'standard' ? (
          <SendTab
            bare
            balanceMissing={balanceMissing}
            session={session}
            balance={balance}
            onSent={onSent}
            onSwitchChain={onSwitchChain}
          />
        ) : (
          <PrivatePayTab bare session={session} balance={balance} onSwitchChain={onSwitchChain} />
        )}
      </Card>
    </div>
  );
}

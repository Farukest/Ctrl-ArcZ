import { useState } from 'react';
import { SegmentedTabs, useT } from '@ctrl-arcz/demo-kit/ui';
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
export function PayTab({ session, onSent }: { session: Session; onSent: () => void }) {
  const t = useT();
  const [pay, setPay] = useState<PayMode>('standard');

  return (
    <div className="paytab">
      <div className="paytab__seg">
        <SegmentedTabs
          tabs={[
            { id: 'standard', label: t('pay.seg.standard') },
            { id: 'private', label: t('pay.seg.private') },
          ]}
          value={pay}
          onChange={setPay}
        />
      </div>
      {pay === 'standard' ? (
        <SendTab session={session} onSent={onSent} />
      ) : (
        <PrivatePayTab session={session} />
      )}
    </div>
  );
}

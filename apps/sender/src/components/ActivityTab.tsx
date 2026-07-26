import { useState } from 'react';
import { SegmentedTabs, useT } from '@ctrl-arcz/demo-kit/ui';
import { type Session } from '@ctrl-arcz/demo-kit';
import { TransfersTab } from './TransfersTab.js';
import { HistoryTab } from './HistoryTab.js';

type View = 'active' | 'history';

/**
 * One "Activity" destination. A transfer is a single object seen at two points in its
 * life: still claimable (Active) or done (History). Merging them behind a segmented
 * control keeps the primary nav to a handful of real destinations.
 */
export function ActivityTab({ session, onChange }: { session: Session; onChange: () => void }) {
  const t = useT();
  const [view, setView] = useState<View>('active');

  return (
    <div className="activitytab">
      <div className="activitytab__seg">
        <SegmentedTabs
          tabs={[
            { id: 'active', label: t('nav.active') },
            { id: 'history', label: t('nav.history') },
          ]}
          value={view}
          onChange={setView}
        />
      </div>
      {view === 'active' ? (
        <TransfersTab session={session} onChange={onChange} />
      ) : (
        <HistoryTab session={session} />
      )}
    </div>
  );
}

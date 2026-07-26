import React, { useState } from 'react';
import { View } from 'react-native';
import { Screen, H1, Segmented } from '../ui';
import { SendScreen } from './SendScreen';
import { PrivatePayScreen } from './PrivatePayScreen';
import { theme } from '../lib/theme';

type PayMode = 'standard' | 'private';

/**
 * One "Pay" tab. Sending is a single intent; the two ways to do it (a claim-code
 * protected transfer vs. a private single-use address) are delivery modes behind a
 * segmented control, not two peer tabs. Mirrors the web app's Pay destination so the
 * two platforms share one mental model.
 */
export function PayScreen() {
  const [mode, setMode] = useState<PayMode>('standard');
  return (
    <Screen>
      <H1>Pay</H1>
      <Segmented
        value={mode}
        onChange={setMode}
        options={[
          { id: 'standard', label: 'Standard' },
          { id: 'private', label: 'Private' },
        ]}
      />
      <View style={{ flex: 1, marginTop: theme.sp(1) }}>
        {mode === 'standard' ? <SendScreen embedded /> : <PrivatePayScreen embedded />}
      </View>
    </Screen>
  );
}

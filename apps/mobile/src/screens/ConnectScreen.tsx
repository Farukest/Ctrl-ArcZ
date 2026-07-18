import React, { useState } from 'react';
import { View } from 'react-native';
import { Screen, H1, Muted, Card, PrimaryButton } from '../ui';
import { useWallet } from '../lib/wallet';

export function ConnectScreen() {
  const { connect } = useWallet();
  const [busy, setBusy] = useState(false);

  const onConnect = async () => {
    setBusy(true);
    try {
      await connect();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen>
      <View style={{ flex: 1, justifyContent: 'center', gap: 16 }}>
        <H1>Ctrl+ArcZ</H1>
        <Muted>
          Protected USDC transfers and payer-side privacy on Arc. Scan a recipient before you
          send, pay from a disposable address, and claim with a code.
        </Muted>
        <Card>
          <Muted>
            This build uses a testnet key stored in your device Keychain so you can try every
            flow. Embedded and WalletConnect sign-in are next.
          </Muted>
          <PrimaryButton label="Start on Arc testnet" onPress={onConnect} loading={busy} />
        </Card>
      </View>
    </Screen>
  );
}

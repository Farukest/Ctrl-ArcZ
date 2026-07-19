import React from 'react';
import { View } from 'react-native';
import { Screen, H1, Muted, Card, PrimaryButton } from '../ui';
import { useWallet } from '../lib/wallet';

export function ConnectScreen() {
  const { connect } = useWallet();

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
            Connect your own wallet (MetaMask, Rabby, Trust, and more). Your keys stay in your
            wallet app, which approves every transaction.
          </Muted>
          <PrimaryButton label="Connect wallet" onPress={connect} />
        </Card>
      </View>
    </Screen>
  );
}

import React, { type ReactNode } from 'react';
import { View } from 'react-native';
import { Screen, H1, Muted, Card } from '../ui';

function Placeholder({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Screen>
      <H1>{title}</H1>
      <Card>
        <Muted>{children}</Muted>
      </Card>
    </Screen>
  );
}

export function SendScreen() {
  return (
    <Placeholder title="Send">
      Protected transfer: the firewall checks the recipient, then an escrowed transfer the
      recipient claims with a short code. Coming in the transfer phase.
    </Placeholder>
  );
}

export function ReceiveScreen() {
  return (
    <Placeholder title="Receive">
      Claim a protected transfer by scanning or entering its code. Coming in the transfer phase.
    </Placeholder>
  );
}

export function PrivatePayScreen() {
  return (
    <Placeholder title="Private Pay">
      Pay a merchant from a disposable address, authorized by the enclave co-signer that vetoes
      bad spends. Needs the co-signer backend; coming next.
    </Placeholder>
  );
}

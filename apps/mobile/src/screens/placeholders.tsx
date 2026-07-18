import React, { type ReactNode } from 'react';
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

export function PrivatePayScreen() {
  return (
    <Placeholder title="Private Pay">
      Pay a merchant from a disposable address, authorized by the enclave co-signer that vetoes
      bad spends. This needs the co-signer backend; coming next.
    </Placeholder>
  );
}

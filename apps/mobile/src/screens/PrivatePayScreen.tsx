import React, { useState } from 'react';
import { ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { erc20Abi, isAddress, parseUnits, type Address, type Hex } from 'viem';
import {
  ADDRESSES,
  arcTestnet,
  SPEND_POLICY_FACTORY_ADDRESS,
  predictEphemeral,
  createEphemeral,
  readAccount,
  submitPay,
  RemoteCoSigner,
  MODE_PUSH,
  ACTION_PAY,
} from '@ctrl-arcz/sdk';
import { Screen, H1, Muted, Mono, Card, PrimaryButton, GhostButton } from '../ui';
import { useWallet } from '../lib/wallet';
import { API_BASE } from '../lib/config';
import { confirmBiometric } from '../lib/biometrics';
import { theme } from '../lib/theme';

type Phase = 'form' | 'machine' | 'creating' | 'funding' | 'paying' | 'done' | 'vetoed';

function randomSalt(): Hex {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return ('0x' + Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')) as Hex;
}

export function PrivatePayScreen() {
  const { session } = useWallet();
  const [merchant, setMerchant] = useState('');
  const [amount, setAmount] = useState('0.02');
  const [phase, setPhase] = useState<Phase>('form');
  const [ephemeral, setEphemeral] = useState<Address | null>(null);
  const [veto, setVeto] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const valid = isAddress(merchant) && Number(amount) > 0;
  const busy = phase === 'machine' || phase === 'creating' || phase === 'funding' || phase === 'paying';

  const run = async () => {
    if (!session || !valid) return;
    if (!(await confirmBiometric('Confirm this private payment'))) return;
    const owner = session.address;
    const to = merchant as Address;
    const amt = parseUnits(amount, 6);
    const clients = { publicClient: session.publicClient, walletClient: session.walletClient };
    setError(null);
    setVeto(null);
    try {
      const cosignerAddress = (await fetch(`${API_BASE}/api/cosign`).then((r) => r.json())).address as Address;
      const cosigner = new RemoteCoSigner(`${API_BASE}/api/cosign`, cosignerAddress);
      const salt = randomSalt();
      const expiry = Math.floor(Date.now() / 1000) + 900;
      const chainId = await session.publicClient.getChainId();

      setPhase('machine');
      const pre = await cosigner.precheck({ owner, target: to, amount: amt });
      if (!pre.approved) {
        setVeto(pre.reason);
        setPhase('vetoed');
        return;
      }

      setPhase('creating');
      const account = await predictEphemeral(session.publicClient, SPEND_POLICY_FACTORY_ADDRESS, owner, salt);
      await createEphemeral(clients, SPEND_POLICY_FACTORY_ADDRESS, salt, {
        token: ADDRESSES.USDC as Address,
        owner,
        cosigner: cosignerAddress,
        vault: owner,
        target: to,
        maxAmount: amt,
        expiry,
        interval: 0,
        mode: MODE_PUSH,
      });

      const state = await readAccount(session.publicClient, account);
      const auth = await cosigner.authorize({
        account,
        owner,
        amount: amt,
        action: ACTION_PAY,
        target: state.target,
        nonce: state.nonce,
        chainId,
        remaining: state.remaining,
        expiry: state.expiry,
      });
      if (!auth.approved) {
        setVeto(auth.reason);
        setPhase('vetoed');
        return;
      }

      setPhase('funding');
      const fundHash = await session.walletClient.writeContract({
        address: ADDRESSES.USDC as Address,
        abi: erc20Abi,
        functionName: 'transfer',
        args: [account, amt],
        account: session.account,
        chain: arcTestnet,
      });
      await session.publicClient.waitForTransactionReceipt({ hash: fundHash });

      setPhase('paying');
      await submitPay(clients, account, amt, auth.signature);
      setEphemeral(account);
      setPhase('done');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase('form');
    }
  };

  const reset = () => {
    setPhase('form');
    setEphemeral(null);
    setVeto(null);
    setError(null);
  };

  if (!session) return null;

  const stepText: Record<string, string> = {
    machine: 'The Machine is checking the merchant',
    creating: 'Creating a disposable address',
    funding: 'Funding it',
    paying: 'Paying',
  };

  return (
    <Screen>
      <ScrollView contentContainerStyle={{ gap: theme.sp(4) }} keyboardShouldPersistTaps="handled">
        <H1>Private Pay</H1>

        {phase === 'form' && (
          <>
            <Muted>
              Pay a merchant from a fresh, single-use address that carries none of your identity
              on-chain. The Machine vetoes a drainer or lookalike before anything is created.
            </Muted>
            <Card>
              <Muted>Merchant address</Muted>
              <TextInput
                value={merchant}
                onChangeText={setMerchant}
                placeholder="0x..."
                placeholderTextColor={theme.muted}
                autoCapitalize="none"
                autoCorrect={false}
                style={styles.input}
              />
              <Muted>Amount (USDC)</Muted>
              <TextInput
                value={amount}
                onChangeText={setAmount}
                keyboardType="decimal-pad"
                placeholderTextColor={theme.muted}
                style={styles.input}
              />
              <PrimaryButton label="Pay privately" onPress={run} disabled={!valid} />
              {error && <Text style={styles.err}>{error}</Text>}
            </Card>
          </>
        )}

        {busy && (
          <Card>
            <Muted>{stepText[phase] ?? 'Working'}…</Muted>
          </Card>
        )}

        {phase === 'vetoed' && (
          <Card style={{ borderColor: theme.block }}>
            <Text style={[styles.big, { color: theme.block }]}>Vetoed by The Machine</Text>
            <Muted>The co-signer withheld its signature, so the payment was impossible. No funds moved.</Muted>
            {veto && <Muted>{veto}</Muted>}
            <GhostButton label="Back" onPress={reset} />
          </Card>
        )}

        {phase === 'done' && ephemeral && (
          <>
            <Card style={{ borderColor: theme.safe }}>
              <Text style={[styles.big, { color: theme.safe }]}>Paid privately</Text>
              <Muted>{amount} USDC reached the merchant from a clean, single-use address.</Muted>
              <Muted>The merchant sees a zero-history address that stores no link to you on-chain.</Muted>
              <Muted>Disposable address</Muted>
              <Mono>{`${ephemeral.slice(0, 10)}…${ephemeral.slice(-6)}`}</Mono>
            </Card>
            <GhostButton label="New payment" onPress={reset} />
          </>
        )}
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  input: {
    color: theme.text,
    borderColor: theme.cardBorder,
    borderWidth: 1,
    borderRadius: theme.radius,
    padding: theme.sp(3),
    fontFamily: 'Courier',
  },
  err: { color: theme.block, fontSize: 14 },
  big: { fontSize: 20, fontWeight: '800' },
});

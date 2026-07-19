import React, { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import * as ScreenCapture from 'expo-screen-capture';
import QRCode from 'react-native-qrcode-svg';
import { isAddress, parseUnits, type Address } from 'viem';
import { check, approveUsdc, sendProtected, generateClaimCode, CTRL_ARCZ_ADDRESS } from '@ctrl-arcz/sdk';
import { Screen, H1, Muted, Mono, Card, PrimaryButton, GhostButton } from '../ui';
import { useWallet } from '../lib/wallet';
import { getConfigId, encodeClaim } from '../lib/claim';
import { confirmBiometric } from '../lib/biometrics';
import { theme } from '../lib/theme';

type Phase = 'form' | 'busy' | 'blocked' | 'done';

interface Done {
  code: string;
  qr: string;
  to: Address;
  amount: string;
}

export function SendScreen() {
  const { session } = useWallet();
  const [to, setTo] = useState('');
  const [amount, setAmount] = useState('1');
  const [phase, setPhase] = useState<Phase>('form');
  const [step, setStep] = useState('');
  const [blockReasons, setBlockReasons] = useState<string[]>([]);
  const [done, setDone] = useState<Done | null>(null);
  const [error, setError] = useState<string | null>(null);

  const valid = isAddress(to) && Number(amount) > 0;

  // Block screenshots / app-switcher snapshots while the claim QR + code are shown.
  useEffect(() => {
    if (phase !== 'done') return;
    void ScreenCapture.preventScreenCaptureAsync();
    return () => {
      void ScreenCapture.allowScreenCaptureAsync();
    };
  }, [phase]);

  const send = async () => {
    if (!session || !valid) return;
    if (!(await confirmBiometric('Confirm this transfer'))) return;
    const recipient = to as Address;
    const value = parseUnits(amount, 6);
    const clients = { publicClient: session.publicClient, walletClient: session.walletClient };
    setPhase('busy');
    setError(null);
    try {
      setStep('Checking the recipient with the firewall');
      const report = await check(session.address, recipient, {
        client: session.publicClient,
        contractAddress: CTRL_ARCZ_ADDRESS,
      });
      if (report.level === 'block') {
        setBlockReasons(report.reasons.map((r) => r.message));
        setPhase('blocked');
        return;
      }

      setStep('Registering the transfer config');
      const configId = await getConfigId(session);

      setStep('Approving USDC');
      await approveUsdc(clients, value);

      const secret = generateClaimCode();
      setStep('Sending the protected transfer');
      const res = await sendProtected(clients, {
        configId,
        to: recipient,
        amount: value,
        claimHash: secret.claimHash,
      });

      setDone({
        code: secret.code,
        qr: encodeClaim({ transferId: res.transferId, salt: secret.salt }),
        to: recipient,
        amount,
      });
      setPhase('done');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase('form');
    }
  };

  const reset = () => {
    setPhase('form');
    setDone(null);
    setBlockReasons([]);
    setError(null);
    setTo('');
    setAmount('1');
  };

  if (!session) return null;

  return (
    <Screen>
      <ScrollView contentContainerStyle={{ gap: theme.sp(4) }} keyboardShouldPersistTaps="handled">
        <H1>Send</H1>

        {phase === 'form' && (
          <>
            <Muted>
              A protected transfer: the firewall checks the recipient first, then the funds are
              escrowed until the recipient claims with a code. No more sending a dollar first.
            </Muted>
            <Card>
              <Muted>Recipient</Muted>
              <TextInput
                value={to}
                onChangeText={setTo}
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
              <PrimaryButton label="Send protected" onPress={send} disabled={!valid} />
              {error && <Text style={styles.err}>{error}</Text>}
            </Card>
          </>
        )}

        {phase === 'busy' && (
          <Card>
            <Muted>{step}…</Muted>
          </Card>
        )}

        {phase === 'blocked' && (
          <Card style={{ borderColor: theme.block }}>
            <Text style={[styles.big, { color: theme.block }]}>Blocked by the firewall</Text>
            <Muted>This recipient looks like a poisoning attempt. The transfer was not sent.</Muted>
            {blockReasons.map((r, i) => (
              <Muted key={i}>• {r}</Muted>
            ))}
            <GhostButton label="Back" onPress={reset} />
          </Card>
        )}

        {phase === 'done' && done && (
          <>
            <Card style={{ borderColor: theme.safe }}>
              <Text style={[styles.big, { color: theme.safe }]}>Sent, escrowed</Text>
              <Muted>The recipient scans this QR, then enters the code below.</Muted>
              <View style={styles.qrWrap}>
                <QRCode value={done.qr} size={200} backgroundColor="#ffffff" />
              </View>
              <Muted>Claim code (share this separately, not with the QR)</Muted>
              <Text style={styles.code}>{done.code}</Text>
            </Card>
            <Card>
              <Muted>Amount</Muted>
              <Mono>{done.amount} USDC</Mono>
              <Muted>To</Muted>
              <Mono>{`${done.to.slice(0, 6)}…${done.to.slice(-4)}`}</Mono>
            </Card>
            <GhostButton label="New transfer" onPress={reset} />
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
  qrWrap: { alignSelf: 'center', backgroundColor: '#fff', padding: 12, borderRadius: 12 },
  code: { color: theme.text, fontSize: 34, fontWeight: '800', letterSpacing: 6, textAlign: 'center' },
});

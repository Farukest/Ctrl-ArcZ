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

type Phase = 'form' | 'busy' | 'warn' | 'blocked' | 'done';

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
  const [warnReasons, setWarnReasons] = useState<string[]>([]);
  const [done, setDone] = useState<Done | null>(null);
  const [revealCode, setRevealCode] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const valid = isAddress(to) && Number(amount) > 0;

  // Block screenshots / app-switcher snapshots around the secret screen. Engage
  // during 'busy' too, so capture is already blocked BEFORE the 'done' frame (with
  // the QR) ever paints — the guard is async, so turning it on only at 'done' would
  // leave the first frame capturable.
  useEffect(() => {
    if (phase !== 'done' && phase !== 'busy') return;
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
      // Do NOT silently proceed on a soft-risk ('warning') or an incomplete scan.
      // Surface the reasons and require an explicit confirmation before moving money.
      if (report.level === 'warning' || !report.complete) {
        const reasons = report.reasons
          .filter((r) => r.severity !== 'safe')
          .map((r) => r.message);
        if (!report.complete) {
          reasons.push('The risk check could not fully complete, so the recipient is not confirmed safe.');
        }
        setWarnReasons(reasons);
        setPhase('warn');
        return;
      }
      await execute(recipient, value);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase('form');
    }
  };

  // The fund-moving leg, run only after the firewall passed (or the user explicitly
  // confirmed a warning). Kept separate so 'Send anyway' cannot skip the firewall —
  // it can only reach here after `send` already classified the recipient.
  const execute = async (recipient: Address, value: bigint) => {
    if (!session) return;
    const clients = { publicClient: session.publicClient, walletClient: session.walletClient };
    setPhase('busy');
    setError(null);
    try {
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
      setRevealCode(false);
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
    setWarnReasons([]);
    setRevealCode(false);
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

        {phase === 'warn' && (
          <Card style={{ borderColor: theme.warning }}>
            <Text style={[styles.big, { color: theme.warning }]}>Check this recipient</Text>
            <Muted>
              The firewall did not clear this address. Confirm you trust it before sending. This
              cannot be undone.
            </Muted>
            {warnReasons.map((r, i) => (
              <Muted key={i}>• {r}</Muted>
            ))}
            <PrimaryButton
              label="Send anyway"
              onPress={() => void execute(to as Address, parseUnits(amount, 6))}
            />
            <GhostButton label="Cancel" onPress={reset} />
          </Card>
        )}

        {phase === 'done' && done && (
          <>
            <Card style={{ borderColor: theme.safe }}>
              <Text style={[styles.big, { color: theme.safe }]}>Sent, escrowed</Text>
              <Muted>The recipient scans this QR, then enters the code you share separately.</Muted>
              <View style={styles.qrWrap}>
                <QRCode value={done.qr} size={200} backgroundColor="#ffffff" />
              </View>
              <Muted>Claim code (share this separately, never with the QR)</Muted>
              {revealCode ? (
                <Text style={styles.code}>{done.code}</Text>
              ) : (
                <GhostButton label="Reveal claim code" onPress={() => setRevealCode(true)} />
              )}
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

import React, { useState } from 'react';
import { ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { CameraView, useCameraPermissions, type BarcodeScanningResult } from 'expo-camera';
import { formatUnits } from 'viem';
import { claim, getTransfer } from '@ctrl-arcz/sdk';
import { Screen, H1, Muted, Mono, Card, PrimaryButton, GhostButton } from '../ui';
import { useWallet } from '../lib/wallet';
import { decodeClaim, type ClaimPayload } from '../lib/claim';
import { theme } from '../lib/theme';

type Phase = 'scan' | 'confirm' | 'claiming' | 'done';

export function ReceiveScreen() {
  const { session } = useWallet();
  const [permission, requestPermission] = useCameraPermissions();
  const [phase, setPhase] = useState<Phase>('scan');
  const [payload, setPayload] = useState<ClaimPayload | null>(null);
  const [amount, setAmount] = useState<string | null>(null);
  const [manual, setManual] = useState('');
  const [txHash, setTxHash] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const accept = async (p: ClaimPayload) => {
    setPayload(p);
    setPhase('confirm');
    setError(null);
    // best-effort: show the amount before claiming
    if (session) {
      try {
        const t = await getTransfer({ publicClient: session.publicClient }, p.transferId);
        setAmount(formatUnits(t.amount, 6));
      } catch {
        setAmount(null);
      }
    }
  };

  const onScan = (res: BarcodeScanningResult) => {
    if (phase !== 'scan') return;
    const p = decodeClaim(res.data);
    if (p) accept(p);
  };

  const onManual = () => {
    const p = decodeClaim(manual.trim());
    if (p) accept(p);
    else setError('That is not a valid claim payload');
  };

  const doClaim = async () => {
    if (!session || !payload) return;
    setPhase('claiming');
    setError(null);
    try {
      const hash = await claim(
        { publicClient: session.publicClient, walletClient: session.walletClient },
        payload.transferId,
        payload.code,
        payload.salt,
      );
      setTxHash(hash);
      setPhase('done');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase('confirm');
    }
  };

  const reset = () => {
    setPhase('scan');
    setPayload(null);
    setAmount(null);
    setManual('');
    setTxHash(null);
    setError(null);
  };

  if (!session) return null;

  return (
    <Screen>
      <H1>Receive</H1>
      <Muted>Scan the sender's claim QR, or paste it, to claim an escrowed transfer.</Muted>

      {phase === 'scan' && (
        <ScrollView contentContainerStyle={{ gap: theme.sp(4) }}>
          <Card style={{ padding: 0, overflow: 'hidden' }}>
            {permission?.granted ? (
              <CameraView
                style={styles.camera}
                facing="back"
                barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
                onBarcodeScanned={onScan}
              />
            ) : (
              <View style={[styles.camera, styles.cameraOff]}>
                <Muted>Camera access is needed to scan the claim QR.</Muted>
                <PrimaryButton label="Allow camera" onPress={requestPermission} />
              </View>
            )}
          </Card>
          <Card>
            <Muted>Or paste the claim payload</Muted>
            <TextInput
              value={manual}
              onChangeText={setManual}
              placeholder='{"v":1,"t":"...","c":"...","s":"0x..."}'
              placeholderTextColor={theme.muted}
              autoCapitalize="none"
              autoCorrect={false}
              multiline
              style={styles.input}
            />
            <PrimaryButton label="Load claim" onPress={onManual} disabled={manual.length < 10} />
            {error && <Text style={styles.err}>{error}</Text>}
          </Card>
        </ScrollView>
      )}

      {phase === 'confirm' && payload && (
        <Card>
          <Muted>Claiming transfer</Muted>
          <Text style={styles.amount}>{amount ? `${amount} USDC` : `#${payload.transferId.toString()}`}</Text>
          <Muted>Code {payload.code}</Muted>
          <PrimaryButton label="Claim to my wallet" onPress={doClaim} />
          <GhostButton label="Cancel" onPress={reset} />
          {error && <Text style={styles.err}>{error}</Text>}
        </Card>
      )}

      {phase === 'claiming' && (
        <Card>
          <Muted>Claiming…</Muted>
        </Card>
      )}

      {phase === 'done' && (
        <Card style={{ borderColor: theme.safe }}>
          <Text style={[styles.amount, { color: theme.safe }]}>Claimed</Text>
          {amount && <Muted>{amount} USDC is now in your wallet.</Muted>}
          {txHash && <Mono>{`${txHash.slice(0, 10)}…`}</Mono>}
          <GhostButton label="Claim another" onPress={reset} />
        </Card>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  camera: { height: 280, alignItems: 'center', justifyContent: 'center', gap: 12, padding: 16 },
  cameraOff: { backgroundColor: theme.card },
  input: {
    color: theme.text,
    borderColor: theme.cardBorder,
    borderWidth: 1,
    borderRadius: theme.radius,
    padding: theme.sp(3),
    fontFamily: 'Courier',
    minHeight: 64,
  },
  err: { color: theme.block, fontSize: 14 },
  amount: { color: theme.text, fontSize: 26, fontWeight: '800' },
});

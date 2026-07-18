import React, { useState } from 'react';
import { ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { CameraView, useCameraPermissions, type BarcodeScanningResult } from 'expo-camera';
import { isAddress, type Address } from 'viem';
import { check, CTRL_ARCZ_ADDRESS, type RiskReport, type RiskLevel } from '@ctrl-arcz/sdk';
import { Screen, H1, Muted, Mono, Card, PrimaryButton, GhostButton } from '../ui';
import { useWallet } from '../lib/wallet';
import { theme } from '../lib/theme';

type Phase = 'scan' | 'checking' | 'result';

const LEVEL_COLOR: Record<RiskLevel, string> = {
  safe: theme.safe,
  warning: theme.warning,
  block: theme.block,
};
const LEVEL_LABEL: Record<RiskLevel, string> = {
  safe: 'Safe to send',
  warning: 'Be careful',
  block: 'Do not send',
};

/** Pull a 0x address out of a raw QR payload or an EIP-681 ethereum: URI. */
function parseAddress(data: string): Address | null {
  const m = data.match(/0x[a-fA-F0-9]{40}/);
  return m && isAddress(m[0]) ? (m[0] as Address) : null;
}

export function ScanScreen() {
  const { session } = useWallet();
  const [permission, requestPermission] = useCameraPermissions();
  const [phase, setPhase] = useState<Phase>('scan');
  const [manual, setManual] = useState('');
  const [target, setTarget] = useState<Address | null>(null);
  const [report, setReport] = useState<RiskReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async (addr: Address) => {
    if (!session) return;
    setTarget(addr);
    setPhase('checking');
    setError(null);
    try {
      const r = await check(session.address, addr, {
        client: session.publicClient,
        contractAddress: CTRL_ARCZ_ADDRESS,
      });
      setReport(r);
      setPhase('result');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase('result');
    }
  };

  const onScan = (res: BarcodeScanningResult) => {
    if (phase !== 'scan') return;
    const addr = parseAddress(res.data);
    if (addr) run(addr);
  };

  const onManual = () => {
    const addr = parseAddress(manual.trim());
    if (addr) run(addr);
    else setError('Not a valid address');
  };

  const reset = () => {
    setPhase('scan');
    setReport(null);
    setTarget(null);
    setError(null);
    setManual('');
  };

  if (!session) return null;

  return (
    <Screen>
      <H1>Scan a recipient</H1>
      <Muted>The firewall checks an address for poisoning before you ever send to it.</Muted>

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
                <Muted>Camera access is needed to scan a QR code.</Muted>
                <PrimaryButton label="Allow camera" onPress={requestPermission} />
              </View>
            )}
          </Card>

          <Card>
            <Muted>Or paste an address</Muted>
            <TextInput
              value={manual}
              onChangeText={setManual}
              placeholder="0x..."
              placeholderTextColor={theme.muted}
              autoCapitalize="none"
              autoCorrect={false}
              style={styles.input}
            />
            <PrimaryButton label="Check address" onPress={onManual} disabled={manual.length < 42} />
            {error && <Text style={styles.err}>{error}</Text>}
          </Card>
        </ScrollView>
      )}

      {phase === 'checking' && (
        <Card>
          <Muted>Checking {target ? `${target.slice(0, 6)}…${target.slice(-4)}` : ''} against the firewall…</Muted>
          <Muted>Scanning on-chain history; this can take a moment on the public RPC.</Muted>
        </Card>
      )}

      {phase === 'result' && (
        <ScrollView contentContainerStyle={{ gap: theme.sp(4) }}>
          {report && (
            <Card style={{ borderColor: LEVEL_COLOR[report.level] }}>
              <Text style={[styles.verdict, { color: LEVEL_COLOR[report.level] }]}>
                {LEVEL_LABEL[report.level]}
              </Text>
              <Mono>{target}</Mono>
              {!report.complete && (
                <Text style={styles.warn}>Partial check: some data was unavailable, so this is not a clean bill.</Text>
              )}
              {report.reasons.length === 0 ? (
                <Muted>No poisoning signals found.</Muted>
              ) : (
                report.reasons.map((r, i) => (
                  <View key={i} style={styles.reason}>
                    <Text style={[styles.reasonDot, { color: LEVEL_COLOR[r.severity] }]}>•</Text>
                    <Muted>{r.message}</Muted>
                  </View>
                ))
              )}
            </Card>
          )}
          {error && (
            <Card style={{ borderColor: theme.block }}>
              <Text style={[styles.verdict, { color: theme.block }]}>Check failed</Text>
              <Muted>{error}</Muted>
            </Card>
          )}
          <GhostButton label="Check another" onPress={reset} />
        </ScrollView>
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
  },
  err: { color: theme.block, fontSize: 14 },
  verdict: { fontSize: 22, fontWeight: '800' },
  warn: { color: theme.warning, fontSize: 14 },
  reason: { flexDirection: 'row', gap: 8, alignItems: 'flex-start' },
  reasonDot: { fontSize: 18, lineHeight: 20 },
});

import React, { useCallback, useEffect, useState } from 'react';
import { RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { erc20Abi, formatUnits, type Address } from 'viem';
import { ADDRESSES } from '@ctrl-arcz/sdk';
import { Screen, H1, Muted, Mono, Card, GhostButton } from '../ui';
import { useWallet } from '../lib/wallet';
import { theme } from '../lib/theme';

export function HomeScreen() {
  const { session, disconnect, wipe } = useWallet();
  const [balance, setBalance] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    if (!session) return;
    try {
      const bal = (await session.publicClient.readContract({
        address: ADDRESSES.USDC as Address,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [session.address],
      })) as bigint;
      setBalance(formatUnits(bal, 6));
    } catch {
      setBalance(null);
    }
  }, [session]);

  useEffect(() => {
    load();
  }, [load]);

  const onRefresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  if (!session) return null;
  const short = `${session.address.slice(0, 6)}…${session.address.slice(-4)}`;

  return (
    <Screen>
      <ScrollView
        contentContainerStyle={{ gap: theme.sp(4) }}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={theme.primary} />
        }
      >
        <H1>Wallet</H1>
        <Card>
          <Muted>Balance</Muted>
          <View style={styles.balanceRow}>
            <Text style={styles.balance}>{balance ?? '—'}</Text>
            <Text style={styles.unit}>USDC</Text>
          </View>
        </Card>
        <Card>
          <Muted>Address (Arc testnet)</Muted>
          <Mono>{short}</Mono>
        </Card>
        <GhostButton label="Disconnect" onPress={disconnect} />
        <GhostButton label="Remove wallet from this device" onPress={wipe} />
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  balanceRow: { flexDirection: 'row', alignItems: 'flex-end', gap: 8 },
  balance: { color: theme.text, fontSize: 40, fontWeight: '800' },
  unit: { color: theme.muted, fontSize: 18, fontWeight: '600', marginBottom: 6 },
});

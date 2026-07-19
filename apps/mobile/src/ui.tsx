import React, { type ReactNode } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
  type ViewStyle,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { theme } from './lib/theme';

export function Screen({ children }: { children: ReactNode }) {
  return (
    <SafeAreaView style={styles.screen} edges={['top', 'left', 'right']}>
      <View style={styles.screenInner}>{children}</View>
    </SafeAreaView>
  );
}

export function H1({ children }: { children: ReactNode }) {
  return <Text style={styles.h1}>{children}</Text>;
}

export function Muted({ children }: { children: ReactNode }) {
  return <Text style={styles.muted}>{children}</Text>;
}

export function Mono({ children }: { children: ReactNode }) {
  return <Text style={styles.mono}>{children}</Text>;
}

export function Card({ children, style }: { children: ReactNode; style?: ViewStyle }) {
  return <View style={[styles.card, style]}>{children}</View>;
}

export function PrimaryButton({
  label,
  onPress,
  loading,
  disabled,
}: {
  label: string;
  onPress: () => void;
  loading?: boolean;
  disabled?: boolean;
}) {
  const off = disabled || loading;
  return (
    <Pressable
      onPress={onPress}
      disabled={off}
      style={({ pressed }) => [styles.btn, off && styles.btnOff, pressed && !off && styles.btnPressed]}
    >
      {loading ? (
        <ActivityIndicator color={theme.primaryText} />
      ) : (
        <Text style={styles.btnText}>{label}</Text>
      )}
    </Pressable>
  );
}

export function GhostButton({
  label,
  onPress,
  disabled,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [styles.ghost, pressed && styles.btnPressed, disabled && { opacity: 0.5 }]}
    >
      <Text style={styles.ghostText}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.bg },
  screenInner: { flex: 1, padding: theme.sp(5), gap: theme.sp(4) },
  h1: { color: theme.text, fontSize: 26, fontWeight: '700' },
  muted: { color: theme.muted, fontSize: 15, lineHeight: 21 },
  mono: { color: theme.text, fontFamily: 'Courier', fontSize: 14 },
  card: {
    backgroundColor: theme.card,
    borderColor: theme.cardBorder,
    borderWidth: 1,
    borderRadius: theme.radius,
    padding: theme.sp(4),
    gap: theme.sp(3),
  },
  btn: {
    backgroundColor: theme.primary,
    borderRadius: theme.radius,
    paddingVertical: theme.sp(3.5),
    alignItems: 'center',
    justifyContent: 'center',
  },
  btnOff: { opacity: 0.5 },
  btnPressed: { opacity: 0.85 },
  btnText: { color: theme.primaryText, fontSize: 16, fontWeight: '700' },
  ghost: {
    borderColor: theme.cardBorder,
    borderWidth: 1,
    borderRadius: theme.radius,
    paddingVertical: theme.sp(3.5),
    alignItems: 'center',
  },
  ghostText: { color: theme.text, fontSize: 16, fontWeight: '600' },
});

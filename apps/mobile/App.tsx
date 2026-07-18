import React, { useEffect } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import * as Notifications from 'expo-notifications';
import {
  NavigationContainer,
  DarkTheme,
  type Theme as NavTheme,
  type LinkingOptions,
} from '@react-navigation/native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { WalletProvider, useWallet } from './src/lib/wallet';
import { Tabs, navigationRef } from './src/navigation';
import { ConnectScreen } from './src/screens/ConnectScreen';
import { registerPushToken } from './src/lib/notifications';
import { theme } from './src/lib/theme';

function Root() {
  const { session, loading } = useWallet();

  // Register for push once connected; tapping a notification opens the tab it names.
  useEffect(() => {
    if (session) void registerPushToken(session.address);
  }, [session]);

  useEffect(() => {
    const sub = Notifications.addNotificationResponseReceivedListener((resp) => {
      const screen = resp.notification.request.content.data?.screen as string | undefined;
      if (screen && navigationRef.isReady()) navigationRef.navigate(screen as never);
    });
    return () => sub.remove();
  }, []);

  if (loading) {
    return (
      <View style={{ flex: 1, backgroundColor: theme.bg, justifyContent: 'center' }}>
        <ActivityIndicator color={theme.primary} />
      </View>
    );
  }
  return session ? <Tabs /> : <ConnectScreen />;
}

const navTheme: NavTheme = {
  ...DarkTheme,
  colors: {
    ...DarkTheme.colors,
    background: theme.bg,
    card: theme.card,
    border: theme.cardBorder,
    primary: theme.primary,
    text: theme.text,
  },
};

// Deep links: ctrlarcz://claim (or https://ctrlarcz.xyz/claim) opens the Receive
// tab; the other tabs are addressable too.
const linking: LinkingOptions<Record<string, undefined>> = {
  prefixes: ['ctrlarcz://', 'https://ctrlarcz.xyz'],
  config: {
    screens: {
      Home: '',
      Send: 'send',
      Scan: 'scan',
      Receive: 'claim',
      'Private Pay': 'pay',
    },
  },
};

export default function App() {
  return (
    <SafeAreaProvider>
      <WalletProvider>
        <NavigationContainer ref={navigationRef} theme={navTheme} linking={linking}>
          <StatusBar style="light" />
          <Root />
        </NavigationContainer>
      </WalletProvider>
    </SafeAreaProvider>
  );
}

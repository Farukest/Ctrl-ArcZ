import React from 'react';
import { ActivityIndicator, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { NavigationContainer, DarkTheme, type Theme as NavTheme } from '@react-navigation/native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { WalletProvider, useWallet } from './src/lib/wallet';
import { Tabs } from './src/navigation';
import { ConnectScreen } from './src/screens/ConnectScreen';
import { theme } from './src/lib/theme';

function Root() {
  const { session, loading } = useWallet();
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

export default function App() {
  return (
    <SafeAreaProvider>
      <WalletProvider>
        <NavigationContainer theme={navTheme}>
          <StatusBar style="light" />
          <Root />
        </NavigationContainer>
      </WalletProvider>
    </SafeAreaProvider>
  );
}

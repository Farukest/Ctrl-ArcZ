import React from 'react';
import { createNavigationContainerRef } from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { Ionicons } from '@expo/vector-icons';

/** Ref so a notification tap can navigate to the right tab from outside React. */
export const navigationRef = createNavigationContainerRef();
import { HomeScreen } from './screens/HomeScreen';
import { ScanScreen } from './screens/ScanScreen';
import { SendScreen } from './screens/SendScreen';
import { ReceiveScreen } from './screens/ReceiveScreen';
import { PrivatePayScreen } from './screens/PrivatePayScreen';
import { theme } from './lib/theme';

const Tab = createBottomTabNavigator();

type IoniconName = keyof typeof Ionicons.glyphMap;

const ICONS: Record<string, IoniconName> = {
  Home: 'wallet-outline',
  Send: 'arrow-up-circle-outline',
  Scan: 'scan-outline',
  Receive: 'arrow-down-circle-outline',
  'Private Pay': 'shield-checkmark-outline',
};

export function Tabs() {
  return (
    <Tab.Navigator
      screenOptions={({ route }) => ({
        headerShown: false,
        tabBarActiveTintColor: theme.primary,
        tabBarInactiveTintColor: theme.muted,
        tabBarStyle: { backgroundColor: theme.card, borderTopColor: theme.cardBorder },
        tabBarIcon: ({ color, size }) => (
          <Ionicons name={ICONS[route.name] ?? 'ellipse-outline'} color={color} size={size} />
        ),
      })}
    >
      <Tab.Screen name="Home" component={HomeScreen} />
      <Tab.Screen name="Send" component={SendScreen} />
      <Tab.Screen name="Scan" component={ScanScreen} />
      <Tab.Screen name="Receive" component={ReceiveScreen} />
      <Tab.Screen name="Private Pay" component={PrivatePayScreen} />
    </Tab.Navigator>
  );
}

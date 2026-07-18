import * as Notifications from 'expo-notifications';
import * as Device from 'expo-device';
import Constants from 'expo-constants';
import { API_BASE } from './config';
import type { WalletSession } from './wallet';

// Show a banner even when the app is foregrounded.
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
    shouldShowBanner: true,
    shouldShowList: true,
  }),
});

/**
 * Request permission, get this device's Expo push token, and register it with the
 * backend for the connected address. Best-effort and safe to call on every
 * connect: it no-ops on a simulator, without permission, or before an EAS project
 * id exists (the token needs one). The backend then pushes on the Arc events that
 * matter to this address.
 */
export async function registerPushToken(session: WalletSession): Promise<void> {
  try {
    if (!Device.isDevice) return; // remote push needs a physical device
    let status = (await Notifications.getPermissionsAsync()).status;
    if (status !== 'granted') status = (await Notifications.requestPermissionsAsync()).status;
    if (status !== 'granted') return;

    const projectId =
      Constants.expoConfig?.extra?.eas?.projectId ??
      (Constants as unknown as { easConfig?: { projectId?: string } }).easConfig?.projectId;
    if (!projectId) return; // set after `eas init`

    const token = (await Notifications.getExpoPushTokenAsync({ projectId })).data;
    // Prove control of the address so the backend only subscribes our own device.
    // Must match the server's registrationMessage byte-for-byte.
    const message = `Ctrl+ArcZ push registration\naddress: ${session.address.toLowerCase()}\ntoken: ${token}`;
    const signature = await session.account.signMessage({ message });
    await fetch(`${API_BASE}/api/notifications/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ address: session.address, token, signature }),
    });
  } catch {
    // Push registration is best-effort; a failure never blocks the app.
  }
}

import * as LocalAuthentication from 'expo-local-authentication';

/**
 * Ask for Face ID / fingerprint before an outbound action (a send, a claim, a
 * pay). Returns true when confirmed. If the device has no biometrics enrolled it
 * returns true rather than locking the user out, and it never hard-blocks on an
 * error. Wire this in front of anything that moves funds.
 */
export async function confirmBiometric(reason: string): Promise<boolean> {
  try {
    const hasHardware = await LocalAuthentication.hasHardwareAsync();
    // Only a genuinely incapable device (no biometric hardware at all) is allowed
    // through without a prompt. Everything else must authenticate.
    if (!hasHardware) return true;
    // With no enrolled biometric, this falls back to the device passcode (we do NOT
    // disableDeviceFallback), so a lost/unlocked phone still cannot spend silently.
    const result = await LocalAuthentication.authenticateAsync({ promptMessage: reason });
    return result.success === true;
  } catch {
    return false; // fail closed: an auth error must not authorize a spend
  }
}

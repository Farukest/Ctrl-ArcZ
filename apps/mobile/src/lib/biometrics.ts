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
    const enrolled = await LocalAuthentication.isEnrolledAsync();
    if (!hasHardware || !enrolled) return true;
    const result = await LocalAuthentication.authenticateAsync({ promptMessage: reason });
    return result.success;
  } catch {
    return true;
  }
}

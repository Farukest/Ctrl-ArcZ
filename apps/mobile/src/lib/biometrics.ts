import * as LocalAuthentication from 'expo-local-authentication';

/**
 * Ask for Face ID / fingerprint (or the device passcode) before an outbound action
 * (a send, a claim, a pay). Returns true only on a successful authentication. This
 * is the gate in front of anything that moves funds, so it FAILS CLOSED:
 *
 *   - No biometric hardware, or none enrolled? Fall back to the device passcode
 *     (`authenticateAsync` with the device-credential fallback left enabled). We do
 *     NOT wave the action through just because the sensor is missing — a phone with
 *     no fingerprint reader is exactly where a handed/unlocked device drains.
 *   - Neither biometrics nor a device passcode set, or any error? Return false.
 *
 * On the rare device with no security at all, funds-moving actions are blocked
 * rather than silently authorized; that is the correct trade-off for a wallet.
 */
export async function confirmBiometric(reason: string): Promise<boolean> {
  try {
    const enrolled = await LocalAuthentication.isEnrolledAsync();
    const securityLevel = await LocalAuthentication.getEnrolledLevelAsync();
    const hasDeviceSecurity =
      enrolled || securityLevel !== LocalAuthentication.SecurityLevel.NONE;
    // Nothing to authenticate against (no biometrics AND no passcode): fail closed.
    if (!hasDeviceSecurity) return false;
    // Prompt. Leaving disableDeviceFallback unset means that if biometrics are
    // absent or fail, the OS falls back to the device passcode — so an unlocked
    // phone with no fingerprint still cannot spend without the passcode.
    const result = await LocalAuthentication.authenticateAsync({
      promptMessage: reason,
      // Do NOT disable device-credential fallback: passcode is a valid gate.
    });
    return result.success === true;
  } catch {
    return false; // fail closed: an auth error must not authorize a spend
  }
}

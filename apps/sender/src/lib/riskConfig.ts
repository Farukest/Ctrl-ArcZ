import { defineConfig } from '@ctrl-arcz/sdk';

/**
 * One firewall policy for the whole app.
 *
 * It lived inside the send screen, which was fine while sending was the only way
 * money left. It is not fine now: a second path with its own copy of the policy is
 * how a strict front door ends up next to a lenient side door.
 */
export const config = defineConfig({
  recallWindow: 3600,
  onWarning: 'warn',
  minProtectedAmount: 50_000n,
});

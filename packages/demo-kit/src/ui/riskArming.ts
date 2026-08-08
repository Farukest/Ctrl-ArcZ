/**
 * When a send button may arm, given what the firewall knows so far.
 *
 * One expression, because four screens had four versions of it and one of them
 * was wrong. The bridge armed on "not blocked" alone, so the button was live
 * while the rule scan was still running and again before the investigator had
 * answered: the rules said safe, the transfer left, and the escalation arrived
 * for money that was already gone.
 *
 * The SDK runs its own guard inside `sendProtected` and that one is
 * authoritative. This is the front door: it decides what a person is allowed to
 * press, not what the chain is allowed to accept.
 */
export interface ArmingState {
  /** Nothing to judge: the field is empty or holds something that is not an
   *  address. The screen's own validation covers that. */
  idle: boolean;
  /** The rule engine is still running. */
  checking: boolean;
  /** The investigator is still running. It may only tighten the verdict, which
   *  protects nobody if the send can be signed before it lands. */
  investigating: boolean;
  /** The verdict, clamped by the investigator, says this must not be paid. */
  blocked: boolean;
}

export function isArmed(state: ArmingState): boolean {
  if (state.idle) return true;
  return !state.checking && !state.investigating && !state.blocked;
}

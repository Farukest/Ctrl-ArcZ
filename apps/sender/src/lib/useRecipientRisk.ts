import { useCallback, useEffect, useRef, useState } from 'react';
import { isAddress, type Address } from 'viem';
import { check, shouldBlockSend, type RiskReport } from '@ctrl-arcz/sdk';
import { getPublicClient, type Session } from '@ctrl-arcz/demo-kit';
import { isArmed } from '@ctrl-arcz/demo-kit/ui';
import { riskProvider, clearRiskCache } from './riskProvider.js';
import { verifiedRecipients, clearVerifiedRecipients } from './verifiedRecipients.js';
import { investigate, effectiveLevel, advisoryOf, type Advisory, type Investigation } from './investigate.js';
import { config } from './riskConfig.js';

/**
 * The firewall, in one place, for every screen that sends to an address someone
 * typed.
 *
 * It started as one screen's logic and stayed there while a second way to send
 * grew next to it. Two copies of a risk check is how you end up with a strict
 * front door and a lenient side door, and the side door is the one an attacker
 * uses. It is also exactly the shape of bug this project already hit once, when
 * the SDK and the Android client rendered addresses differently because each had
 * written its own version.
 *
 * The verdict is deliberately two-part. Rules give an immediate answer from what
 * is on chain; the investigator arrives later and may only make the answer
 * stricter, never softer. `effectiveLevel` is the max of the two, so a block
 * cannot be talked down and a caution cannot become a green light.
 */
/**
 * How far back to scan for RecipientVerified when the index is unavailable.
 *
 * Arc produces roughly two blocks a second, so this is a bit over a day. Not as
 * good as the server's backfill from the deploy block, and far better than the
 * nothing that a suppressed scan leaves behind.
 */
const VERIFIED_FALLBACK_BLOCKS = 200_000;

/**
 * Which sender's history has already been fetched, so the warm-up runs once per
 * wallet rather than once per screen that mounts.
 */
let warmedFor: string | null = null;

/**
 * Fetch what the firewall needs before anyone types, and drop the previous
 * wallet's copy of it.
 *
 * This used to live in the send screen's mount effect, which quietly made the
 * verdict depend on where the user had been. The rules that matter most both need
 * data this fetches: the lookalike rule compares against everyone this sender has
 * paid, and protected transfers pay the contract rather than the recipient, so
 * those recipients exist only in the verified index. A screen reached without
 * passing through Send ran the same rules against a thinner set and returned a
 * softer verdict for the same address -- measured: `block` on Send, `warning` on
 * Private Pay, for one address, in one session.
 *
 * The slow half is walking the indexer, ten pages at several seconds each, which
 * is why it is started here rather than lazily under a spinner.
 */
function warmFor(session: Session): void {
  const sender = session.address as Address;
  if (warmedFor === sender.toLowerCase()) return;
  warmedFor = sender.toLowerCase();
  clearRiskCache();
  clearVerifiedRecipients();
  void riskProvider()
    .getOutgoingCounterparties(sender)
    .catch(() => {
      // A failure must not be remembered as "warm": the next check has to try
      // again, and `check` fails closed while it cannot.
      if (warmedFor === sender.toLowerCase()) warmedFor = null;
    });
  void verifiedRecipients(sender);
}

export interface RecipientRisk {
  /** The rule verdict for the address currently in the box, or null. */
  report: RiskReport | null;
  /** The investigator's opinion, once it lands. Additive only. */
  advisory: Advisory | null;
  /**
   * What the investigator actually did: found something, found nothing, or could
   * not be reached. All three are shown, because a check that ends by disappearing
   * is one the user has no reason to believe ran.
   */
  investigation: Investigation | null;
  /** Rules are running. */
  checking: boolean;
  /** The investigator is running. */
  investigating: boolean;
  /** Rule verdict clamped by the advisory. */
  level: RiskReport['level'] | null;
  /** True when this address must not be paid. */
  blocked: boolean;
  /**
   * Nothing here to judge: the box is empty or holds something that is not an
   * address. The screen's own validation covers that case, and the firewall has
   * no opinion to offer, so it must not hold the button shut either. A bridge to
   * your own address has no recipient at all and still has to be sendable.
   */
  idle: boolean;
  /**
   * May the send button arm?
   *
   * Blocked is the obvious half. The other half is that a verdict which is still
   * forming is not a verdict: the rules can say safe, the button can arm, and the
   * investigator's escalation can arrive for a payment that has already left. The
   * send screen has always waited for both; the bridge armed on `blocked` alone
   * and had exactly that hole. One flag, computed once, so the next screen cannot
   * reintroduce it.
   */
  armed: boolean;
}

export function useRecipientRisk(session: Session, to: string): RecipientRisk {
  // Before anything is typed, and once per wallet however many screens ask.
  useEffect(() => warmFor(session), [session]);

  const [report, setReport] = useState<RiskReport | null>(null);
  const [investigation, setInvestigation] = useState<Investigation | null>(null);
  const advisory = advisoryOf(investigation);
  const [checking, setChecking] = useState(false);
  const [investigating, setInvestigating] = useState(false);
  const debounce = useRef<ReturnType<typeof setTimeout>>();
  /** Only the newest request may write state, so a slow answer for an old
   *  address never lands on a new one. */
  const reqId = useRef(0);

  const runCheck = useCallback(
    (target: string) => {
      const id = ++reqId.current;
      if (!isAddress(target)) {
        setReport(null);
        setInvestigation(null);
        setChecking(false);
        return;
      }
      setChecking(true);
      setInvestigation(null);
      setInvestigating(false);
      // The verified set comes from the server's index, which has no block
      // window. Passing it in means `check` does no log scanning at all.
      verifiedRecipients(session.address as Address)
        .then(({ recipients, complete }) =>
          check(session.address as Address, target as Address, {
            client: getPublicClient(),
            provider: riskProvider(),
            /**
             * Only hand over the index when it is actually complete.
             *
             * `check` skips its own RecipientVerified scan entirely whenever this
             * option is present, so passing the empty array a failed request
             * returns tells it there are no verified recipients rather than that
             * it could not find out. Protected transfers pay the contract, not the
             * recipient, so that list is the only place those addresses appear:
             * suppressing the fallback silently disarms the lookalike rule for
             * everyone the user has paid through this app. Leaving it undefined
             * costs a bounded log scan and keeps the protection.
             */
            ...(complete
              ? { verifiedRecipients: recipients }
              : { verifiedRecipientsLookbackBlocks: VERIFIED_FALLBACK_BLOCKS }),
          }),
        )
        .then((r) => {
          if (id !== reqId.current) return;
          setReport(r);
          // Asked on `safe` too, and that case is the reason it exists: a
          // contract you have genuinely paid before rates safe, while a plain
          // USDC transfer to it is gone. No rule can see that; the dossier can.
          setInvestigating(true);
          void investigate(session, target as Address)
            .then((outcome) => {
              if (id === reqId.current) setInvestigation(outcome);
            })
            .finally(() => {
              if (id === reqId.current) setInvestigating(false);
            });
        })
        .catch(() => {
          if (id === reqId.current) setReport(null);
        })
        .finally(() => {
          if (id === reqId.current) setChecking(false);
        });
    },
    [session],
  );

  useEffect(() => {
    clearTimeout(debounce.current);
    // Acknowledge a valid address immediately, before the debounce. The typing
    // pause is 400ms and the first render after it took another 140, so for over
    // half a second a complete address produced nothing at all on screen and the
    // firewall looked like it had not noticed. Setting it here also holds the
    // button shut through that window, which it should already have been.
    if (isAddress(to)) setChecking(true);
    debounce.current = setTimeout(() => runCheck(to), 400);
    return () => clearTimeout(debounce.current);
  }, [to, runCheck]);

  // Only trust a verdict that belongs to the address currently in the box.
  const active =
    report && isAddress(to) && report.target.toLowerCase() === to.toLowerCase() ? report : null;
  const level = active ? effectiveLevel(active.level, advisory) : null;

  const idle = !isAddress(to);
  const blocked = level ? shouldBlockSend(config, level) : false;

  return {
    report: active,
    advisory,
    investigation,
    checking,
    investigating,
    level,
    blocked,
    idle,
    armed: isArmed({ idle, checking, investigating, blocked }),
  };
}

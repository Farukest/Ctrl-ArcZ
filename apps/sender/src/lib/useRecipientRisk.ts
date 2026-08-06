import { useCallback, useEffect, useRef, useState } from 'react';
import { isAddress, type Address } from 'viem';
import { check, shouldBlockSend, type RiskReport } from '@ctrl-arcz/sdk';
import { getPublicClient, type Session } from '@ctrl-arcz/demo-kit';
import { riskProvider } from './riskProvider.js';
import { verifiedRecipients } from './verifiedRecipients.js';
import { investigate, effectiveLevel, type Advisory } from './investigate.js';
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
export interface RecipientRisk {
  /** The rule verdict for the address currently in the box, or null. */
  report: RiskReport | null;
  /** The investigator's opinion, once it lands. Additive only. */
  advisory: Advisory | null;
  /** Rules are running. */
  checking: boolean;
  /** The investigator is running. Never gates the button. */
  investigating: boolean;
  /** Rule verdict clamped by the advisory. */
  level: RiskReport['level'] | null;
  /** True when this address must not be paid. */
  blocked: boolean;
}

export function useRecipientRisk(session: Session, to: string): RecipientRisk {
  const [report, setReport] = useState<RiskReport | null>(null);
  const [advisory, setAdvisory] = useState<Advisory | null>(null);
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
        setAdvisory(null);
        setChecking(false);
        return;
      }
      setChecking(true);
      setAdvisory(null);
      setInvestigating(false);
      // The verified set comes from the server's index, which has no block
      // window. Passing it in means `check` does no log scanning at all.
      verifiedRecipients(session.address as Address)
        .then(({ recipients }) =>
          check(session.address as Address, target as Address, {
            client: getPublicClient(),
            provider: riskProvider(),
            verifiedRecipients: recipients,
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
            .then((a) => {
              if (id === reqId.current) setAdvisory(a);
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
    debounce.current = setTimeout(() => runCheck(to), 400);
    return () => clearTimeout(debounce.current);
  }, [to, runCheck]);

  // Only trust a verdict that belongs to the address currently in the box.
  const active =
    report && isAddress(to) && report.target.toLowerCase() === to.toLowerCase() ? report : null;
  const level = active ? effectiveLevel(active.level, advisory) : null;

  return {
    report: active,
    advisory,
    checking,
    investigating,
    level,
    blocked: level ? shouldBlockSend(config, level) : false,
  };
}

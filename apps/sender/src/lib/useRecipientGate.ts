import { useCallback, useEffect, useState } from 'react';
import type { RiskAcknowledgement, RiskReport } from '@ctrl-arcz/sdk';
import type { Session } from '@ctrl-arcz/demo-kit';
import { useRecipientRisk, type RecipientRisk } from './useRecipientRisk.js';

/**
 * The firewall as one thing a screen can hold.
 *
 * `useRecipientRisk` answers what the verdict is. This adds the rest of what
 * every screen was writing for itself: whether the button may arm, whether the
 * cards are expanded, and somewhere for a verdict the SDK threw to live.
 *
 * The reason to bundle them is not tidiness. Each screen deciding for itself
 * when to arm is how the bridge ended up arming while the scan was still
 * running, which is the same hole the send screen had a paragraph of comment
 * explaining it had closed. A screen should be able to ask one question and get
 * one answer.
 */
export interface RecipientGate extends RecipientRisk {
  /** The verdict on display: whatever the SDK threw, else what the hook found. */
  activeReport: RiskReport | null;
  /** There is something to show, so a screen can place its own expand control. */
  hasVerdict: boolean;
  ruleOpen: boolean;
  setRuleOpen: (open: boolean) => void;
  advisoryOpen: boolean;
  setAdvisoryOpen: (open: boolean) => void;
  /** Both cards are open. Drives an expand-all control's icon direction. */
  allOpen: boolean;
  toggleAll: () => void;
  /**
   * The verdict the user looked at and chose to proceed past, or null.
   *
   * Held here rather than in each screen because it has to travel two places at
   * once: it re-arms the button, and it goes to `sendProtected` as
   * `acknowledgedReport`, which is the only thing the SDK's own guard will accept
   * in place of a clean verdict. Cleared whenever the address changes, so a
   * decision about one recipient can never carry to the next.
   */
  acknowledged: RiskAcknowledgement | null;
  acknowledge: (report: RiskReport) => void;
  clearAcknowledgement: () => void;
  /** The verdict is a block and the user has not (yet) overridden it. */
  refused: boolean;
  /**
   * Record the report the SDK refused with.
   *
   * `sendProtected` runs the firewall again and throws the full report rather
   * than a message, so the screen can show the same card for a refusal it did
   * not see coming as for one it did. Cleared whenever the address changes.
   */
  setThrownReport: (report: RiskReport | null) => void;
}

export function useRecipientGate(session: Session, to: string): RecipientGate {
  const risk = useRecipientRisk(session, to);
  const [ruleOpen, setRuleOpen] = useState(true);
  const [advisoryOpen, setAdvisoryOpen] = useState(true);
  const [thrownReport, setThrownReport] = useState<RiskReport | null>(null);
  const [acknowledged, setAcknowledged] = useState<RiskAcknowledgement | null>(null);

  // A refusal and a decision both belong to the address they were about. Typing a
  // new one clears them, or the next address inherits the last one's verdict and
  // the last one's permission.
  useEffect(() => {
    setThrownReport(null);
    setAcknowledged(null);
  }, [to]);

  const activeReport = thrownReport ?? risk.report;
  const allOpen = ruleOpen && advisoryOpen;
  const toggleAll = useCallback(() => {
    const open = !allOpen;
    setRuleOpen(open);
    setAdvisoryOpen(open);
  }, [allOpen]);

  // An override re-arms the button, but only the button. The SDK runs its own
  // guard and will refuse again unless `acknowledged` is handed to it, which is
  // the point: the UI cannot grant permission the SDK has not agreed to.
  const armed = risk.armed || (acknowledged !== null && !risk.checking && !risk.investigating);

  return {
    ...risk,
    armed,
    acknowledged,
    // Stamped with the moment of the decision, which is the clock the SDK
    // measures against. The scan behind it is always older by the time a send
    // reaches the guard.
    acknowledge: (report: RiskReport) => setAcknowledged({ report, at: Date.now() }),
    clearAcknowledgement: () => setAcknowledged(null),
    refused: risk.blocked && acknowledged === null,
    activeReport,
    hasVerdict: activeReport !== null,
    ruleOpen,
    setRuleOpen,
    advisoryOpen,
    setAdvisoryOpen,
    allOpen,
    toggleAll,
    setThrownReport,
  };
}

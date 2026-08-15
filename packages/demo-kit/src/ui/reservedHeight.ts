import { useEffect, useRef, type RefObject } from 'react';

/**
 * How tall a list was last time, so its placeholder can be exactly that tall.
 *
 * A row-count model gets a placeholder close to the right size, but never right:
 * reserve a full page and a wallet with three transfers watches the card shrink by
 * 370px; reserve less and a full page grows. Neither is knowable before the read,
 * because the number of rows IS the thing being read.
 *
 * What is knowable is what happened last time. Nearly every visit to a screen is a
 * repeat visit, and between two visits a list rarely changes length, so the height
 * it settled at last time is the best available prediction of the height it is
 * about to settle at. First ever visit falls back to the row model and is the only
 * one that moves.
 *
 * Stored per wallet-independent screen id in localStorage, capped so a corrupt or
 * hostile value cannot push a screen to an absurd height.
 */

const KEY = 'ctrl-arcz:reserve:';
const MAX = 4000;

export function readReserved(id: string): number | null {
  try {
    const raw = localStorage.getItem(KEY + id);
    if (!raw) return null;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 && n <= MAX ? Math.round(n) : null;
  } catch {
    // Private mode, disabled storage, quota. A missing prediction is not an error.
    return null;
  }
}

function writeReserved(id: string, px: number): void {
  try {
    if (px > 0 && px <= MAX) localStorage.setItem(KEY + id, String(Math.round(px)));
  } catch {
    /* see above */
  }
}

/**
 * Attach to the loaded list so it records the height it settled at.
 *
 * Deliberately records the *settled* height and not every intermediate one: a list
 * mid-render, or one being filtered down to a single row by a search box, would
 * otherwise teach the placeholder a height the next visit does not want.
 */
export function useRecordHeight(id: string | undefined): RefObject<HTMLElement | null> {
  const el = useRef<HTMLElement | null>(null);

  // No dependency array on purpose: a list re-renders on every poll, and each render
  // is a chance the height changed. The timer waits for renders to stop arriving, so
  // only a settled height is ever written.
  //
  // Deliberately not a ResizeObserver started from a ref callback. Under StrictMode
  // React attaches the ref, simulates an unmount, and re-attaches; a cleanup scoped
  // to mount then tore down the observer and cancelled the pending write, and nothing
  // was ever recorded. An effect is torn down and re-run by that same simulation, so
  // it comes back from it.
  useEffect(() => {
    if (!id) return;
    const timer = setTimeout(() => {
      const h = el.current?.getBoundingClientRect().height;
      if (h) writeReserved(id, h);
    }, 700);
    return () => clearTimeout(timer);
  });

  return el;
}

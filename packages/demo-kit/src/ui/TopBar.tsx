import type { ReactNode } from 'react';
import { LogoWordmark } from './Logo.js';
import { LangMenu, ThemeToggle } from './components.js';

/**
 * App header: the animated wordmark on the left, controls on the right.
 *
 * `actions` goes ahead of language and theme, which is where a network control
 * belongs: it is about the session, not about how the page is displayed. Passed in
 * rather than rendered here so this component stays free of wallet state, and so
 * the receiver (which never leaves Arc) does not grow a switcher it has no use for.
 */
export function TopBar({ actions }: { actions?: ReactNode }) {
  return (
    <header className="topbar">
      <LogoWordmark />
      <div className="topbar__actions">
        {actions}
        <LangMenu />
        <ThemeToggle />
      </div>
    </header>
  );
}

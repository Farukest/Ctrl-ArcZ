import { LogoWordmark } from './Logo.js';
import { LangMenu, ThemeToggle } from './components.js';

/** App header: the animated wordmark on the left, language + theme on the right. */
export function TopBar() {
  return (
    <header className="topbar">
      <LogoWordmark />
      <div className="topbar__actions">
        <LangMenu />
        <ThemeToggle />
      </div>
    </header>
  );
}

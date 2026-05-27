import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';

export type Theme = 'dark' | 'light';
const STORAGE_KEY = 'ctrl-arcz:theme';

function initialTheme(): Theme {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'dark' || stored === 'light') return stored;
  } catch {
    /* ignore */
  }
  if (typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: light)').matches) {
    return 'light';
  }
  return 'dark';
}

let clearTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * Swap `data-theme` with a smooth, freeze-free tween. We deliberately do NOT use
 * the View Transitions API: it aborts in headless/automation (leaking unhandled
 * rejections) and its full-page snapshot is heavier than we need. Instead a short
 * scoped CSS transition on the themed surfaces (`.theme-anim` in tokens.css) does
 * a color cross-fade — never a global `* { transition: all }`, so no reflow jank.
 */
function apply(theme: Theme) {
  const root = document.documentElement;
  const reduced =
    typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  if (reduced) {
    root.setAttribute('data-theme', theme);
    return;
  }
  root.classList.add('theme-anim');
  root.setAttribute('data-theme', theme);
  clearTimeout(clearTimer);
  clearTimer = setTimeout(() => root.classList.remove('theme-anim'), 260);
}

interface ThemeValue {
  theme: Theme;
  toggle: () => void;
  setTheme: (t: Theme) => void;
}
const ThemeContext = createContext<ThemeValue | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>('dark');

  // Resolve real theme after mount (storage/media) and reflect it on <html>.
  useEffect(() => {
    const t = initialTheme();
    setThemeState(t);
    document.documentElement.setAttribute('data-theme', t);
  }, []);

  const persist = (t: Theme) => {
    try {
      localStorage.setItem(STORAGE_KEY, t);
    } catch {
      /* ignore */
    }
  };

  const setTheme = useCallback((t: Theme) => {
    setThemeState(t);
    apply(t);
    persist(t);
  }, []);

  const toggle = useCallback(() => {
    setThemeState((prev) => {
      const next: Theme = prev === 'dark' ? 'light' : 'dark';
      apply(next);
      persist(next);
      return next;
    });
  }, []);

  return (
    <ThemeContext.Provider value={{ theme, toggle, setTheme }}>{children}</ThemeContext.Provider>
  );
}

export function useTheme(): ThemeValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used within ThemeProvider');
  return ctx;
}

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { en, type TranslationKey } from './en.js';
import { tr } from './tr.js';

/**
 * Dependency-free i18n. English is the base; every locale is a full dictionary
 * checked against the English keys. To add a language: create a `xx.ts` mirroring
 * `tr.ts`, then add one entry to LOCALES below. No other code changes.
 *
 * Switching is a React state change (no page reload, no freeze). The choice is
 * persisted and `<html lang>` is kept in sync.
 */
export interface Locale {
  code: string;
  /** Language name in its own language (never a flag emoji). */
  endonym: string;
  dict: Record<TranslationKey, string>;
}

export const LOCALES: Locale[] = [
  { code: 'en', endonym: 'English', dict: en },
  { code: 'tr', endonym: 'Türkçe', dict: tr },
];

const DEFAULT = 'en';
const STORAGE_KEY = 'ctrl-arcz:lang';

export type Translate = (key: TranslationKey, params?: Record<string, string | number>) => string;

interface I18nValue {
  lang: string;
  setLang: (code: string) => void;
  locales: Locale[];
  t: Translate;
}

const I18nContext = createContext<I18nValue | null>(null);

function interpolate(template: string, params?: Record<string, string | number>): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (_, k) => String(params[k] ?? `{${k}}`));
}

function initialLang(): string {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored && LOCALES.some((l) => l.code === stored)) return stored;
  } catch {
    /* ignore */
  }
  const nav = typeof navigator !== 'undefined' ? navigator.language.slice(0, 2) : DEFAULT;
  return LOCALES.some((l) => l.code === nav) ? nav : DEFAULT;
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<string>(DEFAULT);

  // Resolve the real initial language after mount (localStorage/navigator).
  useEffect(() => setLangState(initialLang()), []);

  useEffect(() => {
    if (typeof document !== 'undefined') document.documentElement.lang = lang;
  }, [lang]);

  const setLang = useCallback((code: string) => {
    setLangState(code);
    try {
      localStorage.setItem(STORAGE_KEY, code);
    } catch {
      /* ignore */
    }
  }, []);

  const dict = useMemo(() => LOCALES.find((l) => l.code === lang)?.dict ?? en, [lang]);

  const t = useCallback<Translate>(
    (key, params) => interpolate(dict[key] ?? en[key] ?? key, params),
    [dict],
  );

  const value = useMemo<I18nValue>(
    () => ({ lang, setLang, locales: LOCALES, t }),
    [lang, setLang, t],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error('useI18n must be used within I18nProvider');
  return ctx;
}

/** Shorthand: `const t = useT()` then `t('send.button')`. */
export function useT(): Translate {
  return useI18n().t;
}

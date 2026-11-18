/**
 * The app's languages. The user picks one on the first screen or in
 * Settings; by default it follows the browser. Missing strings fall back to
 * English.
 */
export type Lang = 'es' | 'en' | 'pt' | 'fr' | 'de' | 'it';

export const LANGS: { id: Lang; name: string; locale: string }[] = [
  { id: 'es', name: 'Español', locale: 'es-ES' },
  { id: 'en', name: 'English', locale: 'en-GB' },
  { id: 'pt', name: 'Português', locale: 'pt-PT' },
  { id: 'fr', name: 'Français', locale: 'fr-FR' },
  { id: 'de', name: 'Deutsch', locale: 'de-DE' },
  { id: 'it', name: 'Italiano', locale: 'it-IT' },
];

export function detectLang(): Lang {
  try {
    const saved = localStorage.getItem('kyros.lang') as Lang | null;
    if (saved && LANGS.some((l) => l.id === saved)) return saved;
  } catch {
    /* no storage */
  }
  const nav = (navigator.language || 'en').slice(0, 2) as Lang;
  return LANGS.some((l) => l.id === nav) ? nav : 'en';
}

export function saveLang(l: Lang): void {
  try {
    localStorage.setItem('kyros.lang', l);
  } catch {
    /* no storage */
  }
}

export const localeOf = (l: Lang) => LANGS.find((x) => x.id === l)!.locale;

/** The keys of every string (src/i18n-strings.ts). A type only: the strings themselves load per language. */
export type Key = keyof typeof import('./i18n-strings').D;

/** One language's strings, built from src/i18n-strings.ts (see vite.config.ts). */
const LOADERS: Record<Lang, () => Promise<{ default: Record<string, string> }>> = {
  es: () => import('virtual:kyros-i18n/es'),
  en: () => import('virtual:kyros-i18n/en'),
  pt: () => import('virtual:kyros-i18n/pt'),
  fr: () => import('virtual:kyros-i18n/fr'),
  de: () => import('virtual:kyros-i18n/de'),
  it: () => import('virtual:kyros-i18n/it'),
};

let current: Lang = detectLang();
let strings: Record<string, string> = {};

/** Loads a language's strings. The app waits for it before its first screen, and before switching language. */
export async function loadStrings(l: Lang = current): Promise<void> {
  strings = (await LOADERS[l]()).default;
}

/** The language in use. Logic modules read it too, for their progress steps and errors. */
export const getLang = () => current;
export async function setLang(l: Lang): Promise<void> {
  await loadStrings(l);
  current = l;
  saveLang(l);
  document.documentElement.lang = l;
}
document.documentElement.lang = current;

export function t(key: Key, vars: Record<string, string | number> = {}): string {
  let s = strings[key] ?? key;
  for (const [k, v] of Object.entries(vars)) s = s.split(`{${k}}`).join(String(v));
  return s;
}

/** The legal pages exist in Spanish and English; every other language gets English. */
export const legalUrl = (doc: 'privacy' | 'terms' | 'notice') =>
  `${import.meta.env.BASE_URL}legal/${current === 'es' ? 'es' : 'en'}/${doc}.html`;
export const SECURITY_URL = 'https://github.com/arturete58-sys/kyros2.0/blob/main/SECURITY.md';

/** The locale for numbers and dates in the language in use. */
export const locale = () => localeOf(current);

// A value that rounds to zero is shown as 0, never "-0,00".
export const fmtNumber = (n: number, o?: Intl.NumberFormatOptions) =>
  (Math.abs(n) < 0.5 * 10 ** -(o?.maximumFractionDigits ?? 3) ? 0 : n).toLocaleString(locale(), o);
export const fmtDate = (d: Date) => d.toLocaleDateString(locale(), { day: 'numeric', month: 'long', year: 'numeric' });
export const fmtDateTime = (d: Date) => d.toLocaleString(locale(), { dateStyle: 'medium', timeStyle: 'short' });
export const fmtTime = (d: Date) => d.toLocaleTimeString(locale(), { timeStyle: 'short' });

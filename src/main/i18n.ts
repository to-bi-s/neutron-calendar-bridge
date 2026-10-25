import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The app's own texts in six languages (0.32, WP7a): window, menu-bar menu, notifications, status
 * messages, the reasons Calendar.app is shown. English is the source text and the key; the other
 * languages are catalogs in locales/<code>.json (key → translation; `{name}` placeholders kept;
 * plurals as "one|other"). A missing translation falls back to English, so a half-translated
 * catalog is never broken. scripts/extract-strings.mjs collects the keys and checks the catalogs.
 *
 * The renderer has the same logic in src/renderer/i18n.js (plain JS; it gets the catalog over IPC).
 */
export interface AppLanguage {
    code: string;
    /** The language's own name. */
    name: string;
}

export const APP_LANGUAGES: AppLanguage[] = [
    { code: 'en', name: 'English' },
    { code: 'de', name: 'Deutsch' },
    { code: 'nl', name: 'Nederlands' },
    { code: 'fr', name: 'Français' },
    { code: 'es', name: 'Español' },
    { code: 'it', name: 'Italiano' }
];

/** 'system' (macOS's language when it is one of ours, else English) or a code. */
export type AppLanguageChoice = 'system' | string;

export type Catalog = Record<string, string>;
export type Params = Record<string, string | number>;

let current = 'en';
let catalog: Catalog = {};
const loaded = new Map<string, Catalog>();
let localesDir = join(__dirname, '..', 'locales');

/** Where the catalogs are (dist/locales in the app; tests point it elsewhere). */
export const setLocalesDir = (dir: string) => {
    localesDir = dir;
    loaded.clear();
};

export const isAppLanguage = (code: unknown): code is string => typeof code === 'string' && APP_LANGUAGES.some((language) => language.code === code);

/** macOS's language (app.getLocale(): "de-DE", "nl", "en-US") → one of ours, else English. */
export const languageForLocale = (locale: string | null | undefined): string => {
    const language = String(locale || '')
        .split(/[-_]/)[0]
        .toLowerCase();
    return isAppLanguage(language) ? language : 'en';
};

/** The language a choice means right now. */
export const resolveLanguage = (choice: AppLanguageChoice | null | undefined, systemLocale: string | null | undefined): string =>
    !choice || choice === 'system' ? languageForLocale(systemLocale) : isAppLanguage(choice) ? choice : 'en';

export const loadCatalog = (code: string): Catalog => {
    if (code === 'en') {
        return {};
    }
    const cached = loaded.get(code);
    if (cached) {
        return cached;
    }
    const file = join(localesDir, `${code}.json`);
    let data: Catalog = {};
    if (existsSync(file)) {
        try {
            const parsed = JSON.parse(readFileSync(file, 'utf8'));
            if (parsed && typeof parsed === 'object') {
                data = parsed;
            }
        } catch (error) {
            console.warn(`[i18n] ${file} could not be read: ${error instanceof Error ? error.message : String(error)}`);
        }
    } else {
        console.warn(`[i18n] no catalog for ${code} at ${file}`);
    }
    loaded.set(code, data);
    return data;
};

/** Switches the language of everything produced from now on. */
export const setLanguage = (code: string) => {
    current = isAppLanguage(code) ? code : 'en';
    catalog = loadCatalog(current);
};

export const currentLanguage = () => current;

/** The catalog of a language, for the renderer. */
export const catalogFor = (code: string): Catalog => loadCatalog(isAppLanguage(code) ? code : 'en');

export const interpolate = (text: string, params?: Params) =>
    params ? text.replace(/\{(\w+)\}/g, (match, name: string) => (name in params ? String(params[name]) : match)) : text;

const lookup = (key: string): string | undefined => (Object.hasOwn(catalog, key) ? catalog[key] : undefined);

/** The text in the current language; `{name}` filled from params. */
export const t = (text: string, params?: Params): string => interpolate(lookup(text) || text, params);

/**
 * A count: `tn('{count} calendar', '{count} calendars', count)`. The catalog key is "one|other";
 * the translation too (languages with one plural form repeat it; {count} filled in both).
 */
export const tn = (one: string, other: string, count: number, params?: Params): string => {
    const key = `${one}|${other}`;
    const translated = lookup(key);
    const forms = translated ? translated.split('|') : [one, other];
    const form = pluralForm(current, count, forms.length);
    return interpolate(forms[Math.min(form, forms.length - 1)] ?? other, { count, ...(params || {}) });
};

/** Which form of the catalog entry a count takes (Intl.PluralRules: one/other for our six languages). */
export const pluralForm = (language: string, count: number, forms: number): number => {
    if (forms <= 1) {
        return 0;
    }
    try {
        const category = new Intl.PluralRules(language).select(count);
        return category === 'one' ? 0 : forms - 1;
    } catch {
        return count === 1 ? 0 : forms - 1;
    }
};

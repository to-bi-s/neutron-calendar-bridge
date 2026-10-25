/**
 * Invitation emails in Proton's languages (0.31). The email texts come from Proton's vendored code
 * (ttag strings) and the dates from date-fns; this module puts both into the chosen language for
 * the moment an email is built, the way Proton's relocalizeText does, and restores English after.
 *
 * The translations are Proton's own (src/invitation-locales.generated.ts, extracted from the
 * WebClients commit the vendored code comes from). `proton` means: the account's "Invitation
 * language" in Proton Calendar's settings (CalendarUserSettings.InviteLocale), and when that is
 * unset, the account's language (UserSettings.Locale); English when neither is known.
 */
import { addLocale, useLocale } from 'ttag';
import type { Locale } from 'date-fns';

import { DATE_FNS_LOCALE_LOADERS, INVITATION_LANGUAGES, INVITATION_TRANSLATIONS } from './invitation-locales.generated';
import type { InvitationLanguage } from './invitation-locales.generated';

export type { InvitationLanguage };
export { INVITATION_LANGUAGES };

/** 'proton' (Proton Calendar's setting) or one of INVITATION_LANGUAGES' codes. */
export type InvitationLanguageChoice = 'proton' | string;

export const DEFAULT_INVITATION_LANGUAGE = 'en_US';

/** A language ready to build an email in: the ttag locale registered, the date-fns locale loaded. */
export interface PreparedInvitationLanguage {
    code: string;
    dateFnsLocale: Locale | null;
}

const byCode = new Map(INVITATION_LANGUAGES.map((language) => [language.code, language]));
const registered = new Set<string>();
const dateFnsLocales = new Map<string, Locale>();

/**
 * The language offered for a code Proton or the caller gives: exact (de_DE), or the first of
 * that language (de → de_DE, es_MX → es_ES); null when there is none (then English).
 */
export const matchInvitationLanguage = (code: string | null | undefined): InvitationLanguage | null => {
    if (!code) {
        return null;
    }
    const normalized = code.replace('-', '_');
    const exact = byCode.get(normalized);
    if (exact) {
        return exact;
    }
    const language = normalized.split('_')[0].toLowerCase();
    return INVITATION_LANGUAGES.find((candidate) => candidate.code.split('_')[0].toLowerCase() === language) ?? null;
};

/**
 * The date and time format of the emails (0.49.6), the way Proton Calendar's web app sets it:
 * `region` is the browser's locale there (here: the Mac's region, e.g. en-GB, nl-NL, en-NL), whose
 * long date and time formats are used with the language's words (Proton's
 * getDateFnsLocaleWithLongFormat); `timeFormat` is the account's "Time format" setting (12 or
 * 24; null: the region's own). Without either, the language's own formats, as before.
 */
export interface InvitationDateFormat {
    region?: string | null;
    timeFormat?: 12 | 24 | null;
}

/** date-fns' locale names, for the region: en-NL has none, so English with another region is British English. */
const DATE_FNS_REGION_LOCALES = new Set([
    'af', 'ar', 'ar-DZ', 'ar-EG', 'ar-MA', 'ar-SA', 'ar-TN', 'az', 'be', 'bg', 'bn', 'bs', 'ca', 'cs', 'cy', 'da', 'de', 'de-AT', 'el',
    'en-AU', 'en-CA', 'en-GB', 'en-IE', 'en-IN', 'en-NZ', 'en-US', 'en-ZA', 'eo', 'es', 'et', 'eu', 'fa-IR', 'fi', 'fr', 'fr-CA', 'fr-CH',
    'fy', 'gd', 'gl', 'gu', 'he', 'hi', 'hr', 'ht', 'hu', 'hy', 'id', 'is', 'it', 'it-CH', 'ja', 'ka', 'kk', 'km', 'kn', 'ko', 'lb', 'lt',
    'lv', 'mk', 'mn', 'ms', 'mt', 'nb', 'nl', 'nl-BE', 'nn', 'oc', 'pl', 'pt', 'pt-BR', 'ro', 'ru', 'sk', 'sl', 'sq', 'sr', 'sr-Latn', 'sv',
    'ta', 'te', 'th', 'tr', 'ug', 'uk', 'uz', 'vi', 'zh-CN', 'zh-HK', 'zh-TW'
]);

/** The date-fns locale name for a region code (en-GB → en-GB, nl-NL → nl, en-NL → en-GB, xx → null). */
export const dateFnsLocaleForRegion = (region: string | null | undefined): string | null => {
    if (!region) {
        return null;
    }
    const [language = '', area = ''] = region.replace('_', '-').split('-');
    const lang = language.toLowerCase();
    const exact = `${lang}-${area.toUpperCase()}`;
    if (area && DATE_FNS_REGION_LOCALES.has(exact)) {
        return exact;
    }
    if (DATE_FNS_REGION_LOCALES.has(lang)) {
        return lang;
    }
    if (lang === 'en') {
        return area.toUpperCase() === 'US' || !area ? 'en-US' : 'en-GB';
    }
    return [...DATE_FNS_REGION_LOCALES].find((name) => name.startsWith(`${lang}-`)) ?? null;
};

const loadDateFnsLocale = async (name: string): Promise<Locale | null> => {
    const cached = dateFnsLocales.get(name);
    if (cached) {
        return cached;
    }
    try {
        const loader = DATE_FNS_LOCALE_LOADERS[name];
        const loaded: Locale = loader ? await loader() : ((await import(`date-fns/locale/${name}/index.js`)) as any).default;
        dateFnsLocales.set(name, loaded);
        return loaded;
    } catch (error) {
        console.warn(`[proton-calendar-client] date-fns locale ${name} not available: ${error instanceof Error ? error.message : String(error)}`);
        return null;
    }
};

/** Proton's getDateFnsLocaleWithTimeFormat: the long time formats in 12 or 24 hours. */
const withTimeFormat = (locale: Locale, timeFormat: 12 | 24): Locale => {
    const formats =
        timeFormat === 12
            ? { full: 'h:mm:ss a zzzz', long: 'h:mm:ss a z', medium: 'h:mm:ss a', short: 'h:mm a' }
            : { full: 'HH:mm:ss zzzz', long: 'HH:mm:ss z', medium: 'HH:mm:ss', short: 'HH:mm' };
    const time = (options?: { width?: string }) => formats[(options?.width as keyof typeof formats) || 'full'];
    return { ...locale, formatLong: { ...locale.formatLong!, time: time as any } };
};

/** The format's locale: the language's words, the region's long formats, the account's hours. */
const withDateFormat = async (language: Locale | null, languageName: string | undefined, format: InvitationDateFormat | undefined): Promise<Locale | null> => {
    const regionName = dateFnsLocaleForRegion(format?.region);
    const wantsRegion = regionName !== null && regionName !== languageName;
    if (!wantsRegion && !format?.timeFormat) {
        return language;
    }
    let locale = language ?? (languageName ? await loadDateFnsLocale(languageName) : null);
    if (!locale) {
        return null;
    }
    if (wantsRegion) {
        const region = await loadDateFnsLocale(regionName);
        if (region?.formatLong) {
            locale = { ...locale, formatLong: region.formatLong };
        }
    }
    return format?.timeFormat ? withTimeFormat(locale, format.timeFormat) : locale;
};

/** Loads what building an email in that language needs; English (or an unknown code) needs nothing. */
export const prepareInvitationLanguage = async (code: string | null | undefined, format?: InvitationDateFormat): Promise<PreparedInvitationLanguage> => {
    const language = matchInvitationLanguage(code);
    if (!language || language.code === DEFAULT_INVITATION_LANGUAGE) {
        return { code: DEFAULT_INVITATION_LANGUAGE, dateFnsLocale: await withDateFormat(null, 'en-US', format) };
    }
    if (!registered.has(language.code)) {
        const data = INVITATION_TRANSLATIONS[language.code];
        if (data) {
            addLocale(language.code, data as any);
        }
        registered.add(language.code);
    }
    const own = language.dateFns ? await loadDateFnsLocale(language.dateFns) : null;
    return { code: language.code, dateFnsLocale: await withDateFormat(own, language.dateFns ?? undefined, format) };
};

/**
 * Builds something (an email's subject and body) in the language: ttag answers in it meanwhile,
 * then English again. Synchronous on purpose — ttag's locale is global, nothing else may run.
 */
export const inInvitationLanguage = <T>(language: PreparedInvitationLanguage | null, build: () => T): T => {
    if (!language || language.code === DEFAULT_INVITATION_LANGUAGE) {
        return build();
    }
    useLocale(language.code);
    try {
        return build();
    } finally {
        useLocale(DEFAULT_INVITATION_LANGUAGE);
    }
};

/** The date options for the vendored email builders (their default is the English date locale). */
export const dateOptionsFor = (language: PreparedInvitationLanguage | null): { locale: Locale } | undefined =>
    language?.dateFnsLocale ? { locale: language.dateFnsLocale } : undefined;

/** The same for both vendored builders: generateEmailSubject reads `dateFormatOptions`, generateEmailBody `options`. */
export const dateParamsFor = (language: PreparedInvitationLanguage | null): { dateFormatOptions?: { locale: Locale }; options?: { locale: Locale } } => {
    const options = dateOptionsFor(language);
    return options ? { dateFormatOptions: options, options } : {};
};

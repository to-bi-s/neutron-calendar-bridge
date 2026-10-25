import type { DateFnsLocaleMap } from '../interfaces/Locale';

/*
 * proton-calendar-client: trimmed. Proton's generated file lazily imports every date-fns locale
 * (a webpack chunk each). Invitation emails are written in English (the default, like ttag's
 * untranslated strings), so only the statically imported locales of dateFnLocales.ts are offered;
 * any other falls back to en-US.
 */
export const dateFnsLocaleMap: DateFnsLocaleMap = {};

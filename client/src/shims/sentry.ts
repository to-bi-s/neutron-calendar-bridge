/**
 * Replaces @proton/shared/lib/helpers/sentry at build time.
 *
 * Proton's helper reports diagnostics to Sentry and reads `window.location` to decide whether
 * to do so. In Node there is no `window`, so any code path that merely *tries* to log (for
 * example the legacy-signature fallback in calendar/crypto/decrypt.ts) threw and aborted the
 * decryption of that event. This stub keeps the same exports and sends nothing anywhere.
 */
export const setUID = (_uid?: string) => undefined;
export const setSentryEnabled = (_enabled: boolean) => undefined;
export const getContentTypeHeaders = (_input: unknown): Record<string, string> => ({});
export const isProduction = (_host: string) => false;
export const setSentryTags = (_tags: Record<string, unknown>) => undefined;
export const traceError = (..._args: unknown[]) => undefined;
export const captureMessage = (..._args: unknown[]) => undefined;

export enum SentryMailInitiatives {
    DRAWER_SECURITY_CENTER = 'drawer-security-center',
    DRAWER_VPN = 'drawer-vpn',
    COMPOSER = 'composer',
    ASSISTANT = 'assistant',
    MAIL_ONBOARDING = 'mail-onboarding',
    LIST_ACTIONS_TELEMETRY = 'list-actions-telemetry',
    REMOVE_EMAIL_TRACKERS = 'remove-email-trackers',
    UPSELL_MODALS = 'upsell-modals'
}

export enum SentryCommonInitiatives {
    POST_SUBSCRIPTION = 'post-subscription',
    ENCRYPTED_SEARCH = 'encrypted-search'
}

export enum SentryCalendarInitiatives {
    RSVP_NOTE = 'rsvp-note'
}

export type SentryInitiative =
    | `${SentryMailInitiatives}`
    | `${SentryCommonInitiatives}`
    | `${SentryCalendarInitiatives}`;

export const traceInitiativeError = (_initiative: SentryInitiative, _error: unknown) => undefined;
export const captureInitiativeMessage = (_initiative: SentryInitiative, _message: string) => undefined;

const main = (..._args: unknown[]) => undefined;
export default main;

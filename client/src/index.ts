import './polyfill';
export * from './proton-calendar-api.ts';
export type { AccountChanges, CalendarChanges, ChangedEventStub } from './change-feed.ts';
export { INVITATION_LANGUAGES, matchInvitationLanguage, DEFAULT_INVITATION_LANGUAGE } from './invitation-language';
export type { InvitationLanguage, InvitationLanguageChoice } from './invitation-language';
export { INVITATION_LOCALE_SOURCE } from './invitation-locales.generated';
export { alarmBlocksOf, decideReminders, normalizeAlarms, sameNotifications } from './reminders';
export { busyPeriodsOf, mergeBusyPeriods, seriesLastEndOf } from './busy';
export { withDtendFromDuration } from './duration';
export { supportedTzid, withSupportedZones } from './zones';
export {
    VIDEO_PROVIDER_PROTON_MEET,
    VIDEO_PROVIDER_ZOOM,
    conferenceLines,
    conferenceOf,
    conferenceOfIcs,
    conferenceRemovalLines,
    descriptionWithConference,
    descriptionWithoutConference,
    parseProtonMeetUrl,
    videoProviderOfLocation,
    withConference
} from './video-links';
export type { VideoConference, VideoConferenceProvider } from './video-links';
export type { BusyPeriod } from './busy';
export type { ApiNotification, EventReminders, ReminderDecision } from './reminders';

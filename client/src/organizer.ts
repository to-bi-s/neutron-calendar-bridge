/**
 * Meetings you organize (invitations, stage 3a: single, non-recurring events) — a port of what
 * Proton Calendar's web app does when you save or delete an event with guests: guests get an
 * invitation, an update or a cancellation by email, and Proton stores the guest list (Proton
 * guests also get the event's key, so it appears in their calendar right away).
 *
 * Sources (Proton WebClients, commit 464c1b060), applications/calendar/src/app/...:
 * - containers/calendar/eventActions/getSaveEventActions.ts          (the event to save, SEQUENCE)
 * - containers/calendar/eventActions/getSaveSingleEventActions.ts    (order of the steps)
 * - containers/calendar/eventActions/getSaveEventActionsHelpers.ts   (createIntermediateEvent)
 * - containers/calendar/eventActions/inviteActions.ts                (what changed; the emails)
 * - containers/calendar/eventActions/sequence.ts, dtstamp.ts         (SEQUENCE and DTSTAMP)
 * - containers/calendar/eventActions/getDeleteEventActions.ts        (cancelling)
 * - containers/calendar/getSyncMultipleEventsPayload.ts              (what is sent to Proton)
 * - containers/calendar/InteractiveCalendarView.tsx                  (handleSendIcs, handleSendPrefsErrors)
 * - helpers/invite.ts (extractInviteEmails), helpers/sendPreferences.ts (getCleanSendDataFromSendPref)
 * - components/eventModal/inputs/ParticipantsInput.tsx, rows/RowParticipants.tsx, helpers.ts
 *                                                                    (who may be invited; the organizer)
 * - packages/components/hooks/useGetCanonicalEmailsMap.ts, useSendIcs.ts
 *
 * Where Proton asks the user in a dialog, this code decides without one:
 * - a NEW guest Proton cannot email (e.g. a Proton address that does not exist) refuses the whole
 *   change, so a typo is not silently dropped; existing or removed guests with such an address
 *   are kept or removed without an email, as after Proton's "Send anyway".
 * - two addresses of the same person refuse the change (Proton asks to remove one).
 * - an organizer address that cannot send deletes without telling the guests, with a warning
 *   (Proton asks first).
 *
 * Every email goes through the email policy (test / dry-run / live) before anything changes in
 * Proton. Recurring meetings (stage 3b) are in organizer-series.ts, built on the helpers here.
 */
import './polyfill';
import { dateParamsFor, inInvitationLanguage } from './invitation-language';
import type { PreparedInvitationLanguage } from './invitation-language';
import { resolveInvitationLanguage } from './invitations';
import { serverTime } from '@protontech/crypto';
import { getCanonicalAddresses } from '@proton/shared/lib/api/addresses';
import { queryCalendars, syncMultipleEvents } from '@proton/shared/lib/api/calendars';
import { getMailSettings } from '@proton/shared/lib/api/mailSettings';
import { getAttendeeEmail, getEquivalentAttendees, withPmAttendees } from '@proton/shared/lib/calendar/attendees';
import {
    DEFAULT_ATTENDEE_PERMISSIONS,
    ICAL_ATTENDEE_ROLE,
    ICAL_ATTENDEE_RSVP,
    ICAL_ATTENDEE_STATUS,
    ICAL_EVENT_STATUS,
    ICAL_METHOD,
    MAX_ATTENDEES,
    RECURRING_TYPES,
} from '@proton/shared/lib/calendar/constants';
import { getBase64SharedSessionKey, getCreationKeys } from '@proton/shared/lib/calendar/crypto/keys/helpers';
import { generateProtonCalendarUID } from '@proton/shared/lib/calendar/helper';
import {
    createInviteIcs,
    generateEmailBody,
    generateEmailSubject,
    generateVtimezonesComponents,
    getHasUpdatedInviteData,
    getIcsMessageWithPreferences,
    getInviteVeventWithUpdatedParstats,
} from '@proton/shared/lib/calendar/mailIntegration/invite';
import { getIsRruleSubset } from '@proton/shared/lib/calendar/recurrence/rruleSubset';
import { createCalendarEvent } from '@proton/shared/lib/calendar/serialize';
import { withDtendFromDuration } from './duration';
import { buildVcalOrganizer, getHasModifiedDateTimes } from '@proton/shared/lib/calendar/vcalConverter';
import {
    getAttendeePartstat,
    getAttendeeRole,
    getHasAttendees,
    getHasRecurrenceId,
    getIsPropertyAllDay,
} from '@proton/shared/lib/calendar/vcalHelper';
import { withDtstamp, withoutRedundantDtEnd } from '@proton/shared/lib/calendar/veventHelper';
import { getIsAddressActive } from '@proton/shared/lib/helpers/address';
import {
    buildMailTo,
    canonicalizeEmail,
    canonicalizeEmailByGuess,
    canonicalizeInternalEmail,
    validateEmailAddress,
} from '@proton/shared/lib/helpers/email';
import { omit } from '@proton/shared/lib/helpers/object';
import type { Address } from '@proton/shared/lib/interfaces';
import type { CalendarEvent, VcalAttendeeProperty, VcalVeventComponent } from '@proton/shared/lib/interfaces/calendar';
import getSendPreferences from '@proton/shared/lib/mail/send/getSendPreferences';
import chunk from '@proton/utils/chunk';

import {
    InvitationActionError,
    RefusedGuestsError,
    SENT_REPLY_MEMORY_MS,
    deleteEvents,
    deliveryOf,
    enforcePolicy,
    errorText,
    eventTitleOf,
    fetchEvent,
    recurrenceIdOf,
    getEncryptionPreferences,
    getVtimezonesMap,
    isAllowedByPolicy,
    readInvitation,
    sendPrepared,
    isSendRefused,
    leftBehindBySlowDown,
    rateLimitedAction,
    rateLimitedUntil,
    withRetries,
} from './invitations';
import type {
    InvitationActionResult,
    InvitationContext,
    InvitationEmailKind,
    InvitationEmailRecord,
    PreparedEmail,
    ReadInvitation,
    RefusedGuest,
    SendPreferences,
} from './invitations';

// ---------------------------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------------------------

export interface SaveOrganizedEventInput {
    calendarID: string;
    /** The Proton event to change; omit to create a new one. */
    eventID?: string;
    /**
     * The event as the calendar app wants it, in Proton's VcalVeventComponent shape (e.g. from
     * parseIcsToVevents). Taken from it: DTSTART, DTEND, SUMMARY, DESCRIPTION, LOCATION and the
     * guests (ATTENDEE; your own addresses are ignored, guests' answers come from Proton). The
     * ORGANIZER, if given, must be one of your addresses. Everything else Proton stores (video
     * conference, colour, your reminders, ...) is kept. A new event gets a Proton UID.
     */
    vevent: VcalVeventComponent;
    /**
     * The version the calendar app edited (as it was served to it), for an existing event. If
     * Proton's guests or times differ from it, someone changed the meeting in the meantime and the
     * save is refused ('stale') instead of undoing that change and emailing the guests about it.
     */
    basedOn?: VcalVeventComponent;
    /**
     * Leave out new guests who cannot be invited (test mode, or Proton cannot email them) and
     * save without them instead of refusing the whole save; they are listed in droppedGuests.
     */
    withoutRefusedGuests?: boolean;
}

export interface CancelOrganizedEventInput {
    calendarID: string;
    eventID: string;
    /** false: delete without emailing the guests (CalDAV Schedule-Reply: F). */
    notifyAttendees: boolean;
}

export interface OrganizerActionResult extends InvitationActionResult {
    /** The Proton event (new or changed). */
    eventId: string;
    /** Its UID in Proton (a new event gets a Proton UID, not the one the calendar app sent). */
    protonUid: string;
    /** With withoutRefusedGuests: new guests left out because they could not be invited. */
    droppedGuests?: RefusedGuest[];
}

// ---------------------------------------------------------------------------------------------
// Proton's helpers from the calendar app (not in packages/, so ported here)
// ---------------------------------------------------------------------------------------------

const { REQUEST, CANCEL } = ICAL_METHOD;
const { NEEDS_ACTION } = ICAL_ATTENDEE_STATUS;
const { REQUIRED, OPTIONAL } = ICAL_ATTENDEE_ROLE;

export type AugmentedSendPreferences = SendPreferences & { isInternal: boolean };
export type SendPreferencesMap = Record<string, AugmentedSendPreferences>;

/** INVITE_ACTION_TYPES, as far as an organizer's save goes. */
export type InviteType = 'NONE' | 'SEND_INVITATION' | 'SEND_UPDATE';

export interface InviteActions {
    type: InviteType;
    addedAttendees?: VcalAttendeeProperty[];
    removedAttendees?: VcalAttendeeProperty[];
    hasRemovedAllAttendees?: boolean;
    hasModifiedRole?: boolean;
    /** RECURRING_TYPES.ALL for changes to a whole series (Proton's email text says so). */
    recurringType?: RECURRING_TYPES;
}

/** sequence.ts */
export const withIncrementedSequence = (vevent: VcalVeventComponent): VcalVeventComponent => {
    const sequenceValue = vevent.sequence?.value;
    if (sequenceValue === undefined) {
        return { ...vevent, sequence: { value: 0 } };
    }
    return { ...vevent, sequence: { value: Math.max(0, sequenceValue) + 1 } };
};

/** sequence.ts: SEQUENCE grows when the dates (or the recurrence, beyond a subset) change. */
export const withVeventSequence = (vevent: VcalVeventComponent, oldVevent: VcalVeventComponent): VcalVeventComponent => {
    if (oldVevent.sequence?.value === undefined) {
        return { ...vevent, sequence: { value: 0 } };
    }
    const { dtstart, sequence: newSequence } = vevent;
    const { dtstart: oldDtstart, sequence: oldSequence } = oldVevent;
    const [isAllDay, oldIsAllDay] = [dtstart, oldDtstart].map((property) => getIsPropertyAllDay(property as any));
    const isAllDayPreserved = isAllDay === oldIsAllDay;
    const areDateTimesPreserved = !getHasModifiedDateTimes(vevent, oldVevent);
    const isRrulePreservedOrSubset =
        isAllDayPreserved && areDateTimesPreserved ? getIsRruleSubset(vevent, oldVevent) : false;
    const oldSequenceValue = Math.max(0, oldSequence.value);
    if (isAllDayPreserved && areDateTimesPreserved && isRrulePreservedOrSubset) {
        return newSequence ? { ...vevent } : { ...vevent, sequence: { value: oldSequenceValue } };
    }
    return { ...vevent, sequence: { value: oldSequenceValue + 1 } };
};

/** dtstamp.ts: DTSTAMP works as a "last modified" for what guests see. */
export const withUpdatedDtstamp = (newVevent: VcalVeventComponent, oldVevent: VcalVeventComponent, timestamp: number) => {
    if (!getHasUpdatedInviteData({ newVevent, oldVevent })) {
        return { ...newVevent };
    }
    return withDtstamp(omit(newVevent, ['dtstamp']) as any, timestamp) as VcalVeventComponent;
};

/** inviteActions.ts getRoleDiff */
const getRoleDiff = (newVevent: VcalVeventComponent, oldVevent?: VcalVeventComponent) => {
    const newAttendees = newVevent.attendee;
    const oldAttendees = oldVevent?.attendee;
    if (!newAttendees?.length || !oldAttendees?.length) {
        return false;
    }
    const oldRoles = new Map<string, string>();
    for (const attendee of oldAttendees) {
        oldRoles.set(canonicalizeEmailByGuess(getAttendeeEmail(attendee)), getAttendeeRole(attendee));
    }
    return newAttendees.some((attendee) => {
        const oldRole = oldRoles.get(canonicalizeEmailByGuess(getAttendeeEmail(attendee)));
        return !!oldRole && getAttendeeRole(attendee) !== oldRole;
    });
};

/** inviteActions.ts getAttendeesDiff */
export const getAttendeesDiff = (newVevent: VcalVeventComponent, oldVevent?: VcalVeventComponent) => {
    const normalizedNew = (newVevent.attendee || []).map((attendee) => canonicalizeEmailByGuess(getAttendeeEmail(attendee)));
    const normalizedOld = (oldVevent?.attendee || []).map((attendee) => canonicalizeEmailByGuess(getAttendeeEmail(attendee)));
    const addedAttendees = newVevent.attendee?.filter(
        (attendee) => !normalizedOld.includes(canonicalizeEmailByGuess(getAttendeeEmail(attendee)))
    );
    const removedAttendees = oldVevent?.attendee?.filter(
        (attendee) => !normalizedNew.includes(canonicalizeEmailByGuess(getAttendeeEmail(attendee)))
    );
    return { addedAttendees, removedAttendees, hasModifiedRole: getRoleDiff(newVevent, oldVevent) };
};

/**
 * inviteActions.ts getCorrectedSaveInviteActions, starting from SEND_INVITATION (what Proton's
 * event form uses for an organizer's save).
 */
export const getCorrectedSaveInviteActions = (newVevent: VcalVeventComponent, oldVevent?: VcalVeventComponent): InviteActions => {
    const hasNewAttendees = getHasAttendees(newVevent);
    const hasOldAttendees = oldVevent ? getHasAttendees(oldVevent) : false;
    if (!oldVevent) {
        return { type: hasNewAttendees ? 'SEND_INVITATION' : 'NONE' };
    }
    if (!hasNewAttendees && !hasOldAttendees) {
        return { type: 'NONE' };
    }
    const hasInviteDataModification = getHasUpdatedInviteData({ newVevent, oldVevent });
    const { addedAttendees, removedAttendees, hasModifiedRole } = getAttendeesDiff(newVevent, oldVevent);
    const hasAddedAttendees = !!addedAttendees?.length;
    const hasRemovedAttendees = !!removedAttendees?.length;
    const hasRemovedAllAttendees = hasRemovedAttendees && removedAttendees?.length === oldVevent.attendee?.length;
    if (hasInviteDataModification) {
        return {
            type: hasOldAttendees ? 'SEND_UPDATE' : 'SEND_INVITATION',
            addedAttendees,
            removedAttendees,
            hasRemovedAllAttendees,
            hasModifiedRole,
        };
    }
    if (!hasAddedAttendees && !hasRemovedAttendees) {
        return { type: 'NONE' };
    }
    return { type: 'SEND_INVITATION', addedAttendees, removedAttendees, hasRemovedAllAttendees };
};

/** inviteActions.ts getEquivalentAttendeesSend */
export const getEquivalentAttendeesSend = (vevent: VcalVeventComponent, { type, addedAttendees, removedAttendees }: InviteActions) => {
    if (type === 'SEND_INVITATION') {
        if (!addedAttendees?.length && !removedAttendees?.length) {
            return getEquivalentAttendees(vevent.attendee);
        }
        if (addedAttendees?.length) {
            return getEquivalentAttendees(addedAttendees);
        }
    }
    if (type === 'SEND_UPDATE') {
        return getEquivalentAttendees(vevent.attendee);
    }
    return undefined;
};

/** helpers/invite.ts extractInviteEmails: everyone who may get an email. */
export const extractInviteEmails = (
    { type, addedAttendees, removedAttendees }: InviteActions,
    vevent?: VcalVeventComponent,
    cancelVevent?: VcalVeventComponent
) => {
    const emailsOf = (attendees?: VcalAttendeeProperty[]) => (attendees || []).map((attendee) => getAttendeeEmail(attendee));
    const emails: string[] = [];
    if (type === 'SEND_INVITATION') {
        if (!addedAttendees?.length && !removedAttendees?.length) {
            emails.push(...emailsOf(vevent?.attendee));
        } else {
            emails.push(...emailsOf(addedAttendees), ...emailsOf(removedAttendees));
        }
    } else if (type === 'SEND_UPDATE') {
        emails.push(...emailsOf(vevent?.attendee), ...emailsOf(removedAttendees));
    } else if (cancelVevent) {
        emails.push(...emailsOf(cancelVevent.attendee));
    }
    return [...new Set(emails)];
};

/** inviteActions.ts extractNewInvitedAttendeeEmails */
const extractNewInvitedAttendeeEmails = (vevent: VcalVeventComponent, { type, addedAttendees, removedAttendees }: InviteActions) => {
    if (type === 'SEND_INVITATION') {
        if (addedAttendees?.length) {
            return addedAttendees.map((attendee) => getAttendeeEmail(attendee));
        }
        if (removedAttendees?.length) {
            return [];
        }
        return (vevent.attendee || []).map((attendee) => getAttendeeEmail(attendee));
    }
    if (type === 'SEND_UPDATE' && addedAttendees?.length) {
        return addedAttendees.map((attendee) => getAttendeeEmail(attendee));
    }
    return [];
};

/**
 * inviteActions.ts getAddedAttendeesPublicKeysMap: new Proton guests get the event's session key
 * encrypted to their key (AddedProtonAttendees), so the event shows up in their calendar.
 */
export const getAddedAttendeesPublicKeysMap = async (
    ctx: InvitationContext,
    mailSettings: any,
    vevent: VcalVeventComponent,
    inviteActions: InviteActions,
    sendPreferencesMap: SendPreferencesMap
) => {
    const map: Record<string, any> = {};
    for (const email of extractNewInvitedAttendeeEmails(vevent, inviteActions)) {
        const sendPreferences = sendPreferencesMap[email];
        if (!sendPreferences) {
            continue;
        }
        if (sendPreferences.isInternal) {
            // A Proton guest with E2EE for mail: the key to email them with is the one to add the event with.
            if (sendPreferences.error) {
                throw sendPreferences.error;
            }
            if (!sendPreferences.publicKeys?.length) {
                throw new Error(`No public key for Proton guest ${email}`);
            }
            map[email] = sendPreferences.publicKeys[0];
            continue;
        }
        if (sendPreferences.encryptionDisabled) {
            // A Proton guest whose account has E2EE for mail switched off looks external to the mail
            // send preferences (no keys). Their internal address key, fetched as such, still adds the
            // event to their calendar (Proton's apps do this since 2026).
            const { isInternal, sendKey } = await getEncryptionPreferences(ctx, email, mailSettings, { intendedForEmail: false });
            if (isInternal && sendKey) {
                map[email] = sendKey;
            }
        }
        // Anyone else is an outside guest: emailed, not auto-added.
    }
    return map;
};

/** inviteActions.ts getSafeSendTo: guests that can be emailed. */
const getSafeSendTo = (attendees: VcalAttendeeProperty[], map: SendPreferencesMap) =>
    attendees
        .map((attendee) => ({ Address: getAttendeeEmail(attendee), Name: attendee.parameters?.cn || getAttendeeEmail(attendee) }))
        .filter(({ Address }) => !map[Address]?.error);

// ---------------------------------------------------------------------------------------------
// Reading the calendar and the event
// ---------------------------------------------------------------------------------------------

/** Your member of the calendar, and whether you own it (Proton's getIsOwnedCalendar). */
export const getMembership = async (ctx: InvitationContext, calendarID: string) => {
    const { Calendars = [] } = await ctx.api<{ Calendars: any[] }>(queryCalendars() as any);
    const calendar = Calendars.find(({ ID }) => ID === calendarID);
    const member = calendar?.Members?.[0];
    if (!calendar || !member) {
        throw new InvitationActionError('Proton did not return this calendar', 'failed');
    }
    const OWNER_PERMISSIONS = 127; // MEMBER_PERMISSIONS.OWNS
    return {
        addressID: member.AddressID as string,
        owned: calendar.Owner?.Email
            ? calendar.Owner.Email === member.Email
            : (member.Permissions & OWNER_PERMISSIONS) === OWNER_PERMISSIONS,
    };
};

/** useGetCanonicalEmailsMap (without the cache): guests' tokens are derived from these. */
const getCanonicalEmailsMap = (ctx: InvitationContext) => async (emails: string[]) => {
    const map: Record<string, string | undefined> = {};
    for (const batch of chunk(emails, 100)) {
        const { Responses = [] } = await ctx.api<{ Responses: any[] }>(
            getCanonicalAddresses(batch.map((email) => encodeURIComponent(email))) as any
        );
        for (const { Email, Response } of Responses) {
            if (Response?.CanonicalEmail) {
                map[Email] = Response.CanonicalEmail;
            }
        }
    }
    return map;
};

export const isRecurring = (vevent?: VcalVeventComponent) => !!vevent && (!!vevent.rrule || !!vevent['recurrence-id']);

/** For callers that still pass a series to the single-event functions (use saveOrganizedSeries). */
const RECURRING_REFUSAL = 'This is a recurring event; it is saved as a series.';

export const NOT_YOUR_MEETING = 'You were invited to this event, so only its organizer can change it.';

export const checkOrganized = (read: ReadInvitation) => {
    const hasOthers = getHasAttendees(read.vevent) || !!read.vevent.organizer;
    if (hasOthers && !read.isOrganizer) {
        throw new InvitationActionError(NOT_YOUR_MEETING, 'unsupported');
    }
    return read;
};

export const readOrganizedEvent = async (
    ctx: InvitationContext,
    calendarID: string,
    eventID: string,
    { allowRecurring = false }: { allowRecurring?: boolean } = {}
) => {
    const event = await fetchEvent(ctx.api, calendarID, eventID);
    const read = checkOrganized(await readInvitation(ctx, event));
    if (!allowRecurring && isRecurring(read.vevent)) {
        throw new InvitationActionError(RECURRING_REFUSAL, 'unsupported');
    }
    return read;
};

export const STALE_REFUSAL =
    'This meeting changed in Proton since your calendar app last read it (guests or time); nothing was sent. ' +
    'Make your change again once it shows the current version.';

/** Guests other than you, as canonical addresses. */
export const guestSetOf = (ctx: InvitationContext, vevent: VcalVeventComponent) => {
    const own = new Set(ctx.addresses.map(({ Email }) => canonicalizeInternalEmail(Email)));
    return new Set(
        (vevent.attendee || [])
            .map((attendee) => getAttendeeEmail(attendee))
            .filter((email) => !own.has(canonicalizeInternalEmail(email)))
            .map((email) => canonicalizeEmailByGuess(email))
    );
};

/** True when Proton's guests or times are not those of the version the calendar app edited. */
const hasChangedSince = (ctx: InvitationContext, basedOn: VcalVeventComponent, current: VcalVeventComponent) => {
    const before = guestSetOf(ctx, basedOn);
    const now = guestSetOf(ctx, current);
    if (before.size !== now.size || [...before].some((email) => !now.has(email))) {
        return true;
    }
    if (!basedOn.dtstart) {
        return false;
    }
    return getHasModifiedDateTimes({ ...basedOn, dtend: getDtend(basedOn) } as VcalVeventComponent, current);
};

// ---------------------------------------------------------------------------------------------
// The event as it should be saved (getSaveEventActions + the event form's model)
// ---------------------------------------------------------------------------------------------

export const normalizeRole = (role?: unknown) => {
    const value = String(role || '').trim().toUpperCase();
    return value === REQUIRED || value === OPTIONAL ? (value as ICAL_ATTENDEE_ROLE) : undefined;
};

/** The guests the calendar app asks for, in Proton's form (cn = email, like Proton's event form). */
export const buildAttendees = (ctx: InvitationContext, requested: VcalAttendeeProperty[], old?: VcalVeventComponent) => {
    const own = new Set(ctx.addresses.map(({ Email }) => canonicalizeInternalEmail(Email)));
    const oldAttendees = old?.attendee || [];
    const seen = new Set<string>();
    const attendees: VcalAttendeeProperty[] = [];
    for (const attendee of requested) {
        const email = getAttendeeEmail(attendee).trim();
        // Yourself: calendar apps list the organizer among the guests; Proton never invites you.
        if (own.has(canonicalizeInternalEmail(email))) {
            continue;
        }
        if (!validateEmailAddress(email)) {
            throw new InvitationActionError(`"${email}" is not a valid email address, so it cannot be invited.`, 'unsupported');
        }
        const key = canonicalizeEmail(email);
        if (seen.has(key)) {
            continue;
        }
        seen.add(key);
        const previous = oldAttendees.find(
            (candidate) => canonicalizeEmailByGuess(getAttendeeEmail(candidate)) === canonicalizeEmailByGuess(email)
        );
        const role = normalizeRole(attendee.parameters?.role) ?? (previous ? normalizeRole(getAttendeeRole(previous)) : undefined) ?? REQUIRED;
        if (previous) {
            // Proton keeps a guest's token and answer; the calendar app's copy of the answer may be outdated.
            const previousEmail = getAttendeeEmail(previous);
            attendees.push({
                value: buildMailTo(previousEmail),
                parameters: {
                    cn: previousEmail,
                    role,
                    rsvp: previous.parameters?.rsvp || ICAL_ATTENDEE_RSVP.TRUE,
                    partstat: previous.parameters?.partstat ? getAttendeePartstat(previous) : NEEDS_ACTION,
                    ...(previous.parameters?.['x-pm-token'] ? { 'x-pm-token': previous.parameters['x-pm-token'] } : {}),
                },
            } as VcalAttendeeProperty);
        } else {
            attendees.push({
                value: buildMailTo(email),
                parameters: { cn: email, role, rsvp: ICAL_ATTENDEE_RSVP.TRUE, partstat: NEEDS_ACTION },
            } as VcalAttendeeProperty);
        }
    }
    return attendees;
};

/** DTEND as Proton wants it (RFC 5545: no DTEND = one day for dates, zero length otherwise). */
export const getDtend = (vevent: VcalVeventComponent) => {
    if (vevent.dtend) {
        return vevent.dtend;
    }
    if ((vevent as any).duration) {
        // 0.40 (bridge): DURATION is turned into DTEND (parseIcsToVevents does it already; this covers callers that build VEVENTs).
        return withDtendFromDuration(vevent).dtend!;
    }
    const dtend: any = JSON.parse(JSON.stringify(vevent.dtstart));
    if (dtend.parameters?.type === 'date') {
        const next = new Date(Date.UTC(dtend.value.year, dtend.value.month - 1, dtend.value.day + 1));
        dtend.value = { year: next.getUTCFullYear(), month: next.getUTCMonth() + 1, day: next.getUTCDate() };
    }
    return dtend;
};

/** Properties of the old event the calendar app cannot change, or that are rebuilt here. */
const REBUILT_PROPERTIES = [
    'attendee',
    'organizer',
    'comment',
    'summary',
    'description',
    'location',
    'dtstart',
    'dtend',
    'duration',
    'sequence',
    'x-pm-session-key',
    'x-pm-shared-event-id',
    'x-pm-proton-reply',
] as const;

/**
 * `old`: the stored event (or, for a changed occurrence, the occurrence as the series has it).
 * With `recurrenceFromInput` (a single event or a series' main event), RRULE and EXDATE come from
 * the input; otherwise (an occurrence) the old event's RECURRENCE-ID is kept and the input's
 * recurrence properties are ignored.
 */
export const buildVevent = async (
    ctx: InvitationContext,
    input: VcalVeventComponent,
    old: Pick<ReadInvitation, 'vevent' | 'isOrganizer'> | undefined,
    selfAddress: Address,
    timestamp: number,
    { recurrenceFromInput = true }: { recurrenceFromInput?: boolean } = {}
) => {
    if (!input?.dtstart) {
        throw new InvitationActionError('The event has no start date', 'unsupported');
    }
    const attendees = buildAttendees(ctx, input.attendee || [], old?.vevent);
    // RowParticipants: an existing meeting keeps its organizer; otherwise you (the calendar's
    // address) become the organizer when there are guests.
    const organizer =
        old?.isOrganizer && old.vevent.organizer
            ? old.vevent.organizer
            : attendees.length
              ? buildVcalOrganizer(selfAddress.Email, selfAddress.DisplayName || selfAddress.Email)
              : undefined;
    const rebuilt: string[] = [...REBUILT_PROPERTIES, ...(recurrenceFromInput ? ['rrule', 'exdate', 'recurrence-id'] : ['rrule', 'exdate'])];
    const base: any = old
        ? omit(old.vevent, rebuilt as any)
        : {
              component: 'vevent',
              uid: { value: generateProtonCalendarUID() },
              status: { value: ICAL_EVENT_STATUS.CONFIRMED },
          };
    const text = (property?: { value: string }) => (property?.value?.trim() ? { value: property.value } : undefined);
    const vevent: any = {
        ...base,
        dtstart: input.dtstart,
        dtend: getDtend(input),
    };
    if (recurrenceFromInput) {
        if (input.rrule) {
            vevent.rrule = input.rrule;
        }
        if (input.exdate?.length) {
            vevent.exdate = input.exdate;
        }
    }
    for (const key of ['summary', 'description', 'location'] as const) {
        const value = text(input[key] as any);
        if (value) {
            vevent[key] = value;
        }
    }
    // 0.34.1: a conference the calendar app's copy carries (made by the bridge, or served and sent
    // back) replaces the stored one; a copy without any keeps what Proton has; empty values (0.34.2,
    // the bridge's "link removed") take it away.
    const inputConferenceId = (input as any)['x-pm-conference-id'];
    if (inputConferenceId !== undefined) {
        if (inputConferenceId?.value && (input as any)['x-pm-conference-url']?.value) {
            vevent['x-pm-conference-id'] = inputConferenceId;
            vevent['x-pm-conference-url'] = (input as any)['x-pm-conference-url'];
        } else if (!String(inputConferenceId?.value ?? '').trim()) {
            delete vevent['x-pm-conference-id'];
            delete vevent['x-pm-conference-url'];
        }
    }
    // 0.49.12: Proton's API stores CONFIRMED or CANCELLED only (it refuses TENTATIVE: "Unknown EventStatus"); a
    // cancellation is not made this way (deleting the meeting cancels it), so the status is confirmed.
    if (String((input as any).status?.value ?? '').toUpperCase() !== 'CANCELLED') {
        vevent.status = { value: 'CONFIRMED' };
    }
    // 0.49.7: "Show time as free" goes along (Proton's "Show as: Free"); busy is the default and not stored.
    if (String((input as any).transp?.value ?? '').toUpperCase() === 'TRANSPARENT') {
        (vevent as any).transp = { value: 'TRANSPARENT' };
    } else {
        delete (vevent as any).transp;
    }
    if (organizer) {
        vevent.organizer = organizer;
    }
    if (attendees.length) {
        vevent.attendee = attendees;
    }
    try {
        // A new event is stamped now; an existing one keeps its DTSTAMP until guests see a change.
        return (await withPmAttendees(withDtstamp(vevent, timestamp), getCanonicalEmailsMap(ctx))) as VcalVeventComponent;
    } catch (error: any) {
        throw new InvitationActionError(`Could not look up the guests' addresses in Proton: ${errorText(error)}`, 'failed');
    }
};

// ---------------------------------------------------------------------------------------------
// Send preferences (handleSendPrefsErrors / getCleanSendDataFromSendPref)
// ---------------------------------------------------------------------------------------------

/**
 * Proton's own lookup turns known address problems (no such address, ...) into a send-preferences
 * error; anything else (network, server) is thrown, so the change fails before anything is sent
 * instead of quietly leaving a guest out.
 */
export const getSendPreferencesMap = async (ctx: InvitationContext, emails: string[], mailSettings: any) => {
    const map: SendPreferencesMap = {};
    for (const email of emails) {
        const encryptionPreferences = await getEncryptionPreferences(ctx, email, mailSettings);
        const sendPreferences = getSendPreferences(encryptionPreferences, getIcsMessageWithPreferences(mailSettings?.Sign) as any);
        map[email] = { ...sendPreferences, isInternal: !!encryptionPreferences.isInternal };
    }
    return map;
};

export const errorsAmong = (emails: string[], map: SendPreferencesMap) =>
    emails.filter((email) => map[email]?.error).map((email) => `${email} (${map[email].error!.message})`);

/**
 * New guests who cannot be invited, checked before anything changes: Proton cannot email them
 * (handleSendPrefsErrors: e.g. a Proton address that does not exist), or test mode does not allow
 * them. Throws RefusedGuestsError (nothing changed); test-mode refusals are reported as blocked
 * invitations, like enforcePolicy does.
 */
export const refuseNewGuests = (
    ctx: InvitationContext,
    newGuests: string[],
    map: SendPreferencesMap,
    about: { from: string; eventTitle: string; eventUid: string; doing: string }
) => {
    const unreachable: RefusedGuest[] = newGuests
        .filter((email) => map[email]?.error)
        .map((email) => ({ email, reason: map[email].error!.message }));
    const blocked: RefusedGuest[] =
        ctx.policy.mode === 'test'
            ? newGuests
                  .filter((email) => !map[email]?.error && !isAllowedByPolicy(ctx.policy, email))
                  .map((email) => ({ email, reason: 'not on the test-mode allowlist' }))
            : [];
    if (!unreachable.length && !blocked.length) {
        return;
    }
    const records: InvitationEmailRecord[] = [];
    const parts: string[] = [];
    if (unreachable.length) {
        parts.push(`Cannot invite ${unreachable.map(({ email, reason }) => `${email} (${reason})`).join(', ')}.`);
    }
    if (blocked.length) {
        const list = blocked.map(({ email }) => email).join(', ');
        const record: InvitationEmailRecord = {
            at: new Date().toISOString(),
            method: 'REQUEST',
            kind: 'invitation',
            from: about.from,
            to: blocked.map(({ email }) => ({ email, name: email })),
            subject: '',
            eventTitle: about.eventTitle,
            eventUid: about.eventUid,
            outcome: 'blocked',
            detail: `Test mode: ${list} ${blocked.length === 1 ? 'is' : 'are'} not on the allowlist.`,
        };
        ctx.onEmail?.(record);
        records.push(record);
        parts.push(`Test mode: ${about.doing} would email ${list}, which ${blocked.length === 1 ? 'is' : 'are'} not on the allowlist.`);
    }
    throw new RefusedGuestsError(`${parts.join(' ')} Nothing was changed.`, blocked.length ? 'blocked' : 'unsupported', [...unreachable, ...blocked], records);
};

/** The event without these guests; without any guest left, without its organizer too (a plain event). */
export const withoutGuests = (ctx: InvitationContext, vevent: VcalVeventComponent, emails: string[]): VcalVeventComponent => {
    const dropped = new Set(emails.map((email) => canonicalizeEmail(email.trim())));
    const own = new Set(ctx.addresses.map(({ Email }) => canonicalizeInternalEmail(Email)));
    const attendee = (vevent.attendee || []).filter((entry) => !dropped.has(canonicalizeEmail(getAttendeeEmail(entry).trim())));
    const guestsLeft = attendee.some((entry) => !own.has(canonicalizeInternalEmail(getAttendeeEmail(entry))));
    const result: any = { ...vevent, attendee };
    if (!guestsLeft) {
        delete result.attendee;
        delete result.organizer;
    }
    return result as VcalVeventComponent;
};

/** A note for the result: who was left out and why. */
export const droppedGuestsWarning = (refused: RefusedGuest[]) =>
    `Not invited: ${refused.map(({ email, reason }) => `${email} (${reason})`).join(', ')}. The meeting was saved without ${refused.length === 1 ? 'that guest' : 'them'}.`;

// ---------------------------------------------------------------------------------------------
// The emails (getSendIcsAction's organizer branches + createIcsInvites)
// ---------------------------------------------------------------------------------------------

const PURPOSE: Record<InvitationEmailKind, string> = {
    answer: 'your answer',
    invitation: 'the invitation',
    update: 'the update',
    cancellation: 'the cancellation',
};

export interface EmailContext {
    ctx: InvitationContext;
    selfAddress: Address;
    sendPreferencesMap: SendPreferencesMap;
    mailSettings: any;
    timestamp: number;
    /** The language of this action's emails (0.31). */
    language: PreparedInvitationLanguage;
}

const prepareEmail = (
    { ctx, selfAddress, sendPreferencesMap, mailSettings, timestamp, language }: EmailContext,
    {
        method,
        kind,
        ics,
        attendees,
        params,
        vevent,
    }: {
        method: ICAL_METHOD;
        kind: InvitationEmailKind;
        ics: string;
        attendees: VcalAttendeeProperty[];
        params: Parameters<typeof generateEmailSubject>[0] & Parameters<typeof generateEmailBody>[0];
        vevent: VcalVeventComponent;
    }
): PreparedEmail | undefined => {
    const to = getSafeSendTo(attendees, sendPreferencesMap);
    if (!to.length) {
        return undefined;
    }
    const localizedParams = { ...params, ...dateParamsFor(language) };
    const { subject, body } = inInvitationLanguage(language, () => ({ subject: generateEmailSubject(localizedParams), body: generateEmailBody(localizedParams) }));
    const from = { Address: selfAddress.Email, Name: selfAddress.DisplayName || selfAddress.Email };
    const record: InvitationEmailRecord = {
        at: new Date(timestamp).toISOString(),
        method: method as InvitationEmailRecord['method'],
        kind,
        from: selfAddress.Email,
        to: to.map(({ Address, Name }) => ({
            email: Address,
            name: Name,
            delivery: deliveryOf(sendPreferencesMap[Address], sendPreferencesMap[Address].isInternal),
        })),
        subject,
        eventTitle: eventTitleOf(vevent),
        eventUid: vevent.uid.value,
        // An occurrence of a series (its own update, invitation or cancellation): which one.
        recurrenceId: recurrenceIdOf(vevent),
        outcome: 'sent',
    };
    return {
        method,
        purpose: PURPOSE[kind],
        record,
        addressID: selfAddress.ID,
        ics,
        subject,
        body,
        from,
        to,
        sendPreferencesMap,
        mailSettings,
        timestamp,
    };
};

/** Invitation / update emails for a save (SEND_INVITATION, SEND_UPDATE). */
export const prepareSaveEmails = async (
    emailContext: EmailContext,
    {
        inviteActions,
        vevent,
        cancelVevent,
        sharedEventID,
        sharedSessionKey,
    }: {
        inviteActions: InviteActions;
        vevent: VcalVeventComponent;
        cancelVevent?: VcalVeventComponent;
        sharedEventID: string;
        sharedSessionKey: string;
    }
) => {
    const { ctx, timestamp } = emailContext;
    const { type, addedAttendees = [], removedAttendees = [] } = inviteActions;
    if (type === 'NONE') {
        return [];
    }
    // handleSendIcs: fresh DTSTAMPs for the ICS.
    const pmFields = {
        'x-pm-shared-event-id': { value: sharedEventID },
        'x-pm-session-key': { value: sharedSessionKey },
    };
    const eventWithDtstamp = withDtstamp(omit(vevent, ['dtstamp']) as any, timestamp) as VcalVeventComponent;
    const cancelWithDtstamp = cancelVevent
        ? (withDtstamp(omit(cancelVevent, ['dtstamp']) as any, timestamp) as VcalVeventComponent)
        : undefined;
    const getVTimezonesMap = getVtimezonesMap(ctx) as any;
    const attendees = vevent.attendee || [];

    // createIcsInvites
    let pmVevent: VcalVeventComponent | undefined;
    let requestIcs: string | undefined;
    if ([...attendees, ...addedAttendees].length) {
        pmVevent = { ...eventWithDtstamp, ...pmFields } as VcalVeventComponent;
        requestIcs = createInviteIcs({
            method: REQUEST,
            prodId: ctx.prodId,
            vevent: pmVevent,
            vtimezones: await generateVtimezonesComponents(eventWithDtstamp, getVTimezonesMap),
            keepDtstamp: true,
        });
    }
    let pmCancelVevent: VcalVeventComponent | undefined;
    let cancelIcs: string | undefined;
    if (removedAttendees.length) {
        if (!cancelWithDtstamp) {
            throw new InvitationActionError('Cannot generate the cancellation for removed guests', 'failed');
        }
        pmCancelVevent = { ...cancelWithDtstamp, ...pmFields } as VcalVeventComponent;
        cancelIcs = createInviteIcs({
            method: CANCEL,
            prodId: ctx.prodId,
            vevent: pmCancelVevent,
            vtimezones: await generateVtimezonesComponents(cancelWithDtstamp, getVTimezonesMap),
            attendeesTo: removedAttendees,
            keepDtstamp: true,
        });
    }

    const emails: (PreparedEmail | undefined)[] = [];
    const { recurringType } = inviteActions;
    const request = (to: VcalAttendeeProperty[], isCreateEvent: boolean) =>
        prepareEmail(emailContext, {
            method: REQUEST,
            // Proton's text: a new occurrence of a series is an update too ("Update for an event…").
            kind: isCreateEvent && !getHasRecurrenceId(pmVevent!) ? 'invitation' : 'update',
            ics: requestIcs!,
            attendees: to,
            vevent: pmVevent!,
            params: { method: REQUEST, vevent: pmVevent!, oldVevent: cancelWithDtstamp, isCreateEvent, recurringType } as any,
        });
    const cancel = () =>
        prepareEmail(emailContext, {
            method: CANCEL,
            kind: 'cancellation',
            ics: cancelIcs!,
            attendees: removedAttendees,
            vevent: pmCancelVevent!,
            params: { method: CANCEL, vevent: pmCancelVevent! } as any,
        });

    if (type === 'SEND_INVITATION') {
        if (!addedAttendees.length && !removedAttendees.length && attendees.length && requestIcs) {
            // A new invitation.
            emails.push(request(attendees, true));
        } else {
            // An existing event: only guests added or removed.
            if (addedAttendees.length && requestIcs) {
                emails.push(request(addedAttendees, true));
            }
            if (cancelIcs) {
                emails.push(cancel());
            }
        }
    } else if (type === 'SEND_UPDATE') {
        const addedEmails = addedAttendees.map((attendee) => getAttendeeEmail(attendee));
        const remaining = attendees.filter((attendee) => !addedEmails.includes(getAttendeeEmail(attendee)));
        if (remaining.length && requestIcs) {
            emails.push(request(remaining, false));
        }
        if (addedAttendees.length && requestIcs) {
            emails.push(request(addedAttendees, true));
        }
        if (cancelIcs) {
            emails.push(cancel());
        }
    }
    return emails.filter((email): email is PreparedEmail => !!email);
};

/** The cancellation for deleting a meeting (getSendIcsAction's CANCEL_INVITATION branch). */
export const prepareCancelEmail = async (
    emailContext: EmailContext,
    { cancelVevent, sharedEventID }: { cancelVevent: VcalVeventComponent; sharedEventID: string }
) => {
    const { ctx, timestamp } = emailContext;
    const attendees = cancelVevent.attendee || [];
    const cancelWithDtstamp = withDtstamp(omit(cancelVevent, ['dtstamp']) as any, timestamp) as VcalVeventComponent;
    // RFC 5546: the sequence must be incremented for a cancellation.
    const pmCancelVevent = withIncrementedSequence({
        ...cancelWithDtstamp,
        'x-pm-shared-event-id': { value: sharedEventID },
    } as VcalVeventComponent);
    const ics = createInviteIcs({
        method: CANCEL,
        prodId: ctx.prodId,
        vevent: pmCancelVevent,
        attendeesTo: attendees,
        vtimezones: await generateVtimezonesComponents(cancelWithDtstamp, getVtimezonesMap(ctx) as any),
        keepDtstamp: true,
    });
    return prepareEmail(emailContext, {
        method: CANCEL,
        kind: 'cancellation',
        ics,
        attendees,
        vevent: pmCancelVevent,
        params: { method: CANCEL, vevent: pmCancelVevent } as any,
    });
};

// ---------------------------------------------------------------------------------------------
// Retries: emails already sent for a change Proton did not take
// ---------------------------------------------------------------------------------------------

export const pendingKey = (calendarID: string, uid: string) => `${calendarID}/${uid}`;

/** What the retry memory compares: the ModifyTime of each Proton event involved. */
export const stampOf = (events: CalendarEvent[]) =>
    JSON.stringify(
        events
            .map((event) => [event.ID, (event as any).ModifyTime ?? null])
            .sort(([a], [b]) => String(a).localeCompare(String(b)))
    );

/** What identifies an email for a retry: method, recipients and the ICS without its DTSTAMP. */
const fingerprintOf = (email: PreparedEmail) => {
    const lines = email.ics
        .replace(/\r?\n[ \t]/g, '')
        .split(/\r?\n/)
        .filter((line) => line && !/^DTSTAMP[:;]/i.test(line))
        .sort();
    const recipients = email.to.map(({ Address }) => canonicalizeEmail(Address)).sort();
    return JSON.stringify([email.method, recipients, lines]);
};

/**
 * Emails sent for a change Proton then did not take. Only valid while the Proton event (or series)
 * is still as it was then (`stamp`: its ModifyTime(s)): once it changed some other way, guests may
 * have been told something else in between, and emails go out again.
 */
const getPendingFingerprints = (ctx: InvitationContext, key: string, stamp: string) => {
    const pending = ctx.pendingOrganizerEmails.get(key);
    if (!pending || Date.now() - pending.at >= SENT_REPLY_MEMORY_MS || pending.stamp !== stamp) {
        ctx.pendingOrganizerEmails.delete(key);
        return new Set<string>();
    }
    return new Set(pending.fingerprints);
};

export const rememberPending = (ctx: InvitationContext, key: string, emails: PreparedEmail[], stamp: string) => {
    for (const [entry, pending] of ctx.pendingOrganizerEmails) {
        if (Date.now() - pending.at >= SENT_REPLY_MEMORY_MS) {
            ctx.pendingOrganizerEmails.delete(entry);
        }
    }
    const previous = getPendingFingerprints(ctx, key, stamp);
    ctx.pendingOrganizerEmails.set(key, {
        fingerprints: [...new Set([...previous, ...emails.map(fingerprintOf)])],
        at: Date.now(),
        stamp,
    });
};

/** True while emails of an interrupted change of this event are remembered (a retry sends none of them again). */
export const hasPendingEmails = (ctx: InvitationContext, key: string, stamp: string) => getPendingFingerprints(ctx, key, stamp).size > 0;

/** Emails to send now, without those already sent for the same change (retry after 'incomplete'). */
export const withoutAlreadySent = (
    ctx: InvitationContext,
    key: string,
    emails: PreparedEmail[],
    result: InvitationActionResult,
    stamp: string
) => {
    const pending = getPendingFingerprints(ctx, key, stamp);
    const toSend = emails.filter((email) => !pending.has(fingerprintOf(email)));
    const skipped = emails.length - toSend.length;
    if (skipped) {
        result.warnings.push(
            `${skipped === 1 ? 'One email was' : `${skipped} emails were`} already sent for this change a few minutes ago and not sent again.`
        );
    }
    return toSend;
};

/** True when Proton answered the send with a refusal, so nothing went out. */

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/**
 * Sends the emails one after another and returns those that went out, or may have: a request that
 * failed without Proton refusing it (e.g. the connection dropped) is counted as sent, so a retry
 * does not email the guests twice. If Proton refuses the first email, nothing went out and the
 * error is thrown. Later problems are reported (warning + failed record) and the change goes ahead,
 * so Proton matches what the guests were most likely told.
 */
export const sendAll = async (ctx: InvitationContext, emails: PreparedEmail[], result: InvitationActionResult) => {
    const sent: PreparedEmail[] = [];
    for (const email of emails) {
        try {
            result.emails.push(await sendPrepared(ctx, email));
            sent.push(email);
        } catch (error: any) {
            const refused = isSendRefused(error);
            const until = refused ? rateLimitedUntil(error) : undefined;
            // 0.41 (bridge): a slow-down after the first email went out: this one waits and goes out after the pause.
            const deferred = Boolean(until && sent.length && ctx.deferredEmails);
            const detail = deferred
                ? 'Proton asked to slow down: sent once the pause is over'
                : refused
                  ? errorText(error)
                  : `${errorText(error)} (it may have been sent anyway)`;
            const failed = { ...email.record, outcome: 'failed' as const, detail, ...(deferred ? { deferred: true, retryAt: until } : {}) };
            if (deferred) {
                ctx.deferredEmails!.push({ email, retryAt: until!, since: Date.now() });
                result.emails.push(failed);
                result.warnings.push(`${capitalize(PURPOSE[email.record.kind])} to ${email.to.map(({ Address }) => Address).join(', ')} waits: Proton asked to slow down`);
                ctx.onEmail?.(failed);
                continue;
            }
            ctx.onEmail?.(failed);
            if (refused && !sent.length) {
                if (rateLimitedUntil(error)) {
                    // A slow-down is temporary: the caller can keep the change and try again then.
                    throw rateLimitedAction('Proton asked to slow down: no email was sent and nothing was changed yet.', error, failed);
                }
                throw new InvitationActionError(
                    `Proton did not send the email to your guests (${errorText(error)}). Nothing was changed.`,
                    error instanceof InvitationActionError ? error.reason : 'unsupported',
                    failed
                );
            }
            if (!refused) {
                sent.push(email);
            }
            result.emails.push(failed);
            result.warnings.push(
                `${capitalize(PURPOSE[email.record.kind])} to ${email.to.map(({ Address }) => Address).join(', ')} ` +
                    `${refused ? 'could not be sent' : 'may not have been sent'}: ${errorText(error)}`
            );
        }
    }
    return sent;
};

// ---------------------------------------------------------------------------------------------
// Proton writes (getSyncMultipleEventsPayload)
// ---------------------------------------------------------------------------------------------

/**
 * One events/sync request with several operations (Proton applies all or none). Returns the
 * event of each operation (undefined for deletions); throws if any is refused.
 */
export const syncMany = async (ctx: InvitationContext, calendarID: string, operations: any[]): Promise<(CalendarEvent | undefined)[]> => {
    const MemberID = await ctx.getMemberID(calendarID);
    const response: any = await ctx.api({
        ...syncMultipleEvents(calendarID, { MemberID, Events: operations } as any),
        silence: true,
    } as any);
    // Like Proton's calendar app (InteractiveCalendarView, upsertSyncMultiActionsResponses): answers
    // are matched by their Index, any answer with an error fails the request, and deletions are not
    // answered at all (no answer for a deletion = done).
    const entries: any[] = response?.Responses || [];
    const failed = entries.find((entry) => !entry?.Response || 'Error' in entry.Response || entry.Response.Code !== 1000)?.Response;
    if (entries.length && failed !== undefined) {
        const error: any = new Error(failed?.Error || `Proton refused the change (code ${failed?.Code ?? 'unknown'})`);
        error.data = failed;
        throw error;
    }
    const byIndex = new Map(entries.map((entry, position) => [typeof entry?.Index === 'number' ? entry.Index : position, entry]));
    // A created or changed event comes back in its answer; one that did not is not confirmed.
    const unconfirmed = operations.findIndex((operation, index) => operation.DeletionReason === undefined && !byIndex.get(index));
    if (unconfirmed >= 0) {
        throw new Error(`Proton did not confirm the change (no answer for operation ${unconfirmed + 1} of ${operations.length})`);
    }
    return operations.map((_, index) => byIndex.get(index)?.Response?.Event as CalendarEvent | undefined);
};

const syncOne = async (ctx: InvitationContext, calendarID: string, operation: any): Promise<CalendarEvent> => {
    const [event] = await syncMany(ctx, calendarID, [operation]);
    return event as CalendarEvent;
};

/** getSyncMultipleEventsPayload, create branch. */
export const buildCreateOperation = async (
    ctx: InvitationContext,
    {
        calendarID,
        addressID,
        vevent,
        hasDefaultNotifications = true,
        addedAttendeesPublicKeysMap,
        isPersonalSingleEdit = false,
    }: {
        calendarID: string;
        addressID: string;
        vevent: VcalVeventComponent;
        hasDefaultNotifications?: boolean;
        addedAttendeesPublicKeysMap?: Record<string, any>;
        isPersonalSingleEdit?: boolean;
    }
) => {
    const creationKeys = await getCreationKeys({
        newAddressKeys: ctx.getAddressKeys(addressID) as any,
        newCalendarKeys: await ctx.getCalendarKeys(calendarID),
    });
    const data: any = await createCalendarEvent({
        eventComponent: withoutRedundantDtEnd(vevent),
        isCreateEvent: true,
        isSwitchCalendar: false,
        hasDefaultNotifications,
        addedAttendeesPublicKeysMap,
        ...creationKeys,
    } as any);
    if (!data.SharedKeyPacket || !data.SharedEventContent) {
        throw new Error('Missing shared data');
    }
    return { Overwrite: 0, Event: { Permissions: DEFAULT_ATTENDEE_PERMISSIONS, IsPersonalSingleEdit: isPersonalSingleEdit, ...data } };
};

/**
 * getSyncMultipleEventsPayload, update branch. `keepComments`: guests' notes on their answers stay
 * (Proton keeps them on recurring meetings unless the change resets answers); the shared session
 * key does not change on an update, so the stored notes stay readable as they are.
 */
export const buildUpdateOperation = async (
    ctx: InvitationContext,
    {
        calendarID,
        addressID,
        calendarEvent,
        vevent,
        hasDefaultNotifications,
        removedAttendeesEmails,
        addedAttendeesPublicKeysMap,
        isBreakingChange = false,
        isPersonalSingleEdit,
        cancelledOccurrenceVevent,
        keepComments = false,
    }: {
        calendarID: string;
        addressID: string;
        calendarEvent: CalendarEvent;
        vevent: VcalVeventComponent;
        hasDefaultNotifications: boolean;
        removedAttendeesEmails?: string[];
        addedAttendeesPublicKeysMap?: Record<string, any>;
        isBreakingChange?: boolean;
        isPersonalSingleEdit?: boolean;
        cancelledOccurrenceVevent?: VcalVeventComponent;
        keepComments?: boolean;
    }
) => {
    const event: any = calendarEvent;
    const creationKeys = await getCreationKeys({
        calendarEvent,
        newAddressKeys: ctx.getAddressKeys(addressID) as any,
        oldAddressKeys: event.AddressID ? (ctx.getAddressKeys(event.AddressID) as any) : undefined,
        newCalendarKeys: await ctx.getCalendarKeys(calendarID),
    });
    const comments: Record<string, any> = {};
    if (keepComments) {
        for (const attendee of event.AttendeesInfo?.Attendees || []) {
            if (attendee?.Token && attendee?.Comment) {
                comments[attendee.Token] = attendee.Comment;
            }
        }
    }
    const data: any = await createCalendarEvent({
        eventComponent: withoutRedundantDtEnd(vevent),
        cancelledOccurrenceVevent: cancelledOccurrenceVevent ? withoutRedundantDtEnd(cancelledOccurrenceVevent) : undefined,
        removedAttendeesEmails,
        addedAttendeesPublicKeysMap,
        isCreateEvent: false,
        isSwitchCalendar: false,
        hasDefaultNotifications,
        isAttendee: false,
        getAttendeesCommentsMap: keepComments ? async () => comments : undefined,
        ...creationKeys,
    } as any);
    if (!data.SharedEventContent) {
        throw new Error('Missing shared event content');
    }
    return {
        ID: calendarEvent.ID,
        Event: {
            Permissions: DEFAULT_ATTENDEE_PERMISSIONS,
            IsOrganizer: 1,
            IsBreakingChange: isBreakingChange ? 1 : 0,
            IsPersonalSingleEdit: isPersonalSingleEdit ?? event.IsPersonalSingleEdit ?? false,
            ...data,
        },
    };
};

export const buildDeleteOperation = (event: CalendarEvent) => ({ ID: event.ID, DeletionReason: 0 /* DELETION_REASON.NORMAL */ });

export const createInProton = async (
    ctx: InvitationContext,
    input: { calendarID: string; addressID: string; vevent: VcalVeventComponent; addedAttendeesPublicKeysMap?: Record<string, any> }
) => syncOne(ctx, input.calendarID, await buildCreateOperation(ctx, input));

export const updateInProton = async (
    ctx: InvitationContext,
    input: Parameters<typeof buildUpdateOperation>[1]
) => syncOne(ctx, input.calendarID, await buildUpdateOperation(ctx, input));

// ---------------------------------------------------------------------------------------------
// Saving a meeting you organize
// ---------------------------------------------------------------------------------------------

/** Placeholders for the dry run / policy check of a new meeting: Proton assigns these on save. */
export const NOT_YET_ASSIGNED = 'assigned-by-proton-when-saved';

/**
 * Saves a meeting you organize (see saveOrganizedEventOnce). With `withoutRefusedGuests`, new
 * guests who cannot be invited (test mode, or Proton cannot email them) are left out and the
 * meeting is saved without them, like Proton's "continue without"; `droppedGuests` lists them.
 */
export const saveOrganizedEvent = async (ctx: InvitationContext, input: SaveOrganizedEventInput): Promise<OrganizerActionResult> => {
    try {
        return await saveOrganizedEventOnce(ctx, input);
    } catch (error: any) {
        if (!input.withoutRefusedGuests || !(error instanceof RefusedGuestsError)) {
            throw error;
        }
        const refused = error.refusedGuests;
        const result = await saveOrganizedEventOnce(ctx, { ...input, vevent: withoutGuests(ctx, input.vevent, refused.map(({ email }) => email)) });
        return { ...result, emails: [...error.emails, ...result.emails], droppedGuests: refused, warnings: [...result.warnings, droppedGuestsWarning(refused)] };
    }
};

const saveOrganizedEventOnce = async (
    ctx: InvitationContext,
    { calendarID, eventID, vevent: input, basedOn }: SaveOrganizedEventInput
): Promise<OrganizerActionResult> => {
    // A single event (which may become recurring, like in Proton's event form); a stored series
    // and changed occurrences go through saveOrganizedSeries.
    if (input['recurrence-id']) {
        throw new InvitationActionError(RECURRING_REFUSAL, 'unsupported');
    }
    const timestamp = +serverTime();
    const membership = await getMembership(ctx, calendarID);
    const old = eventID ? await readOrganizedEvent(ctx, calendarID, eventID) : undefined;
    if (old && basedOn && hasChangedSince(ctx, basedOn, old.vevent)) {
        throw new InvitationActionError(STALE_REFUSAL, 'stale');
    }
    const memberAddress = ctx.addresses.find(({ ID }) => ID === membership.addressID);
    // The address you organize from: an existing meeting's, otherwise the calendar's.
    const selfAddress = (old?.isOrganizer && old.selfAddress) || memberAddress;
    if (!selfAddress || !memberAddress) {
        throw new InvitationActionError('None of your addresses is linked to this calendar', 'failed');
    }
    if (input.organizer) {
        const organizerEmail = canonicalizeInternalEmail(getAttendeeEmail(input.organizer as any));
        if (!ctx.addresses.some(({ Email }) => canonicalizeInternalEmail(Email) === organizerEmail)) {
            throw new InvitationActionError(
                `The organizer ${getAttendeeEmail(input.organizer as any)} is not one of your addresses, so this event cannot be saved with guests.`,
                'unsupported'
            );
        }
    }

    let vevent = await buildVevent(ctx, input, old, selfAddress, timestamp);
    const { MailSettings: mailSettings } = await ctx.api<{ MailSettings: any }>(getMailSettings());
    const guestCount = vevent.attendee?.length || 0;
    // eventModal/helpers.ts getParticipantsError
    if (guestCount && !membership.owned) {
        throw new InvitationActionError('Creating invites in a shared calendar is not allowed.', 'unsupported');
    }
    const maxAttendees = mailSettings?.RecipientLimit || MAX_ATTENDEES;
    if (guestCount > maxAttendees) {
        throw new InvitationActionError(`At most ${maxAttendees} participants are allowed per invitation.`, 'unsupported');
    }

    // SEQUENCE (getSaveEventActions), then what to send (getCorrectedSaveInviteActions).
    vevent = old ? withVeventSequence(vevent, old.vevent) : { ...vevent, sequence: { value: 0 } };
    const inviteActions = getCorrectedSaveInviteActions(vevent, old?.vevent);
    const isSendType = inviteActions.type !== 'NONE';
    if (old) {
        vevent = withUpdatedDtstamp(vevent, old.vevent, timestamp);
        vevent = getInviteVeventWithUpdatedParstats(vevent, old.vevent, isSendType ? REQUEST : undefined);
    }

    const equivalent = getEquivalentAttendeesSend(vevent, inviteActions);
    if (equivalent?.length) {
        const groups = equivalent.map((group) => group.join(' = ')).join('; ');
        throw new InvitationActionError(
            `Some guests are the same person under different addresses (${groups}). Keep one address each.`,
            'unsupported'
        );
    }

    const uid = vevent.uid.value;
    const key = pendingKey(calendarID, uid);
    const result: OrganizerActionResult = {
        emails: [],
        changedEventIds: [],
        deletedEventIds: [],
        warnings: [],
        eventId: old?.event.ID || '',
        protonUid: uid,
    };
    const removedAttendeesEmails = inviteActions.removedAttendees?.map((attendee) => getAttendeeEmail(attendee));

    // ---- Nothing to email: a plain save ----
    if (!isSendType) {
        if (ctx.policy.mode === 'dry-run') {
            throw new InvitationActionError('Dry run: would save the change (no email needed); nothing was changed.', 'dry-run');
        }
        const saved = old
            ? await updateInProton(ctx, {
                  calendarID,
                  addressID: memberAddress.ID,
                  calendarEvent: old.event,
                  vevent,
                  hasDefaultNotifications: old.hasDefaultNotifications,
                  removedAttendeesEmails,
              })
            : await createInProton(ctx, { calendarID, addressID: memberAddress.ID, vevent });
        ctx.pendingOrganizerEmails.delete(key);
        result.eventId = saved.ID;
        result.changedEventIds.push(saved.ID);
        return result;
    }

    // ---- Who can be emailed (handleSendPrefsErrors) ----
    if (!getIsAddressActive(selfAddress)) {
        throw new InvitationActionError(
            `Your address ${selfAddress.Email} cannot send emails, so guests cannot be invited or updated from it.`,
            'unsupported'
        );
    }
    const sendPreferencesMap = await getSendPreferencesMap(
        ctx,
        extractInviteEmails(inviteActions, vevent, old?.vevent),
        mailSettings
    );
    const isNewInvitation =
        inviteActions.type === 'SEND_INVITATION' && !inviteActions.addedAttendees?.length && !inviteActions.removedAttendees?.length;
    const newGuests = isNewInvitation
        ? (vevent.attendee || []).map((attendee) => getAttendeeEmail(attendee))
        : (inviteActions.addedAttendees || []).map((attendee) => getAttendeeEmail(attendee));
    refuseNewGuests(ctx, newGuests, sendPreferencesMap, {
        from: selfAddress.Email,
        eventTitle: eventTitleOf(vevent),
        eventUid: vevent.uid.value,
        doing: old ? 'this change' : 'inviting these guests',
    });
    const otherErrors = errorsAmong(
        Object.keys(sendPreferencesMap).filter((email) => !newGuests.includes(email)),
        sendPreferencesMap
    );
    if (otherErrors.length) {
        result.warnings.push(`Not emailed (Proton cannot send to them): ${otherErrors.join(', ')}`);
    }
    let addedAttendeesPublicKeysMap: Record<string, any>;
    try {
        addedAttendeesPublicKeysMap = await getAddedAttendeesPublicKeysMap(ctx, mailSettings, vevent, inviteActions, sendPreferencesMap);
    } catch (error: any) {
        throw new InvitationActionError(`Cannot invite a Proton guest: ${errorText(error)}`, 'failed');
    }
    const emailContext: EmailContext = { ctx, selfAddress, sendPreferencesMap, mailSettings, timestamp, language: await resolveInvitationLanguage(ctx) };
    const doing = old ? 'this change' : 'inviting these guests';

    // ---- A new meeting: intermediate event, invitations, then the guest list (createIntermediateEvent) ----
    if (!old) {
        // Policy first, with the same emails as they will be (Proton assigns the shared event ID on save).
        const planned = await prepareSaveEmails(emailContext, {
            inviteActions,
            vevent,
            sharedEventID: NOT_YET_ASSIGNED,
            sharedSessionKey: NOT_YET_ASSIGNED,
        });
        await enforcePolicy(ctx, planned, doing);

        const intermediate = await createInProton(ctx, {
            calendarID,
            addressID: memberAddress.ID,
            vevent: omit(vevent, ['attendee']) as VcalVeventComponent,
        });
        result.eventId = intermediate.ID;
        const stamp = stampOf([intermediate]);
        let sent: PreparedEmail[];
        try {
            const sharedSessionKey = await getBase64SharedSessionKey({
                calendarEvent: intermediate,
                calendarKeys: await ctx.getCalendarKeys(calendarID),
            });
            if (!sharedSessionKey || !intermediate.SharedEventID) {
                throw new InvitationActionError('Proton did not return the new event in a usable form', 'failed');
            }
            const emails = await prepareSaveEmails(emailContext, {
                inviteActions,
                vevent,
                sharedEventID: intermediate.SharedEventID,
                sharedSessionKey,
            });
            sent = await sendAll(ctx, emails, result);
        } catch (error: any) {
            if (rateLimitedUntil(error)) {
                throw leftBehindBySlowDown(error, { calendarID, eventID: intermediate.ID });
            }
            // Nothing went out: the event without guests goes again.
            try {
                await deleteEvents(ctx, calendarID, [intermediate.ID]);
            } catch (rollbackError: any) {
                throw new InvitationActionError(
                    `${errorText(error)} The event was created in Proton without guests and could not be removed again (${errorText(rollbackError)}).`,
                    error instanceof InvitationActionError && error.reason !== 'rate-limited' ? error.reason : 'failed',
                    error?.email,
                    error?.emails,
                    { eventID: intermediate.ID, uid }
                );
            }
            throw error;
        }
        try {
            await withRetries(() =>
                updateInProton(ctx, {
                    calendarID,
                    addressID: memberAddress.ID,
                    calendarEvent: intermediate,
                    vevent,
                    hasDefaultNotifications: true,
                    addedAttendeesPublicKeysMap,
                })
            );
        } catch (error: any) {
            rememberPending(ctx, key, sent, stamp);
            throw new InvitationActionError(
                `Your guests were invited, but Proton did not save the guest list (${errorText(error)}). ` +
                    'Save the event again in a few minutes (no second invitation), or add the guests in Proton Calendar.',
                'incomplete',
                result.emails[0],
                result.emails,
                { eventID: intermediate.ID, uid }
            );
        }
        ctx.pendingOrganizerEmails.delete(key);
        result.changedEventIds.push(intermediate.ID);
        return result;
    }

    // ---- An existing event: emails first, then the change (getSaveSingleEventActions) ----
    const sharedSessionKey = await getBase64SharedSessionKey({
        calendarEvent: old.event,
        calendarKeys: await ctx.getCalendarKeys(calendarID),
    });
    const sharedEventID = (old.event as any).SharedEventID;
    if (!sharedSessionKey || !sharedEventID) {
        throw new InvitationActionError('Could not read the shared key of this event', 'failed');
    }
    const prepared = await prepareSaveEmails(emailContext, {
        inviteActions,
        vevent,
        cancelVevent: old.vevent,
        sharedEventID,
        sharedSessionKey,
    });
    const stamp = stampOf([old.event]);
    const emails = withoutAlreadySent(ctx, key, prepared, result, stamp);
    if (!emails.length && ctx.policy.mode === 'dry-run') {
        throw new InvitationActionError('Dry run: would save the change already emailed; nothing was changed.', 'dry-run');
    }
    await enforcePolicy(ctx, emails, doing);
    const sent = await sendAll(ctx, emails, result);
    try {
        await withRetries(
            () =>
                updateInProton(ctx, {
                    calendarID,
                    addressID: memberAddress.ID,
                    calendarEvent: old.event,
                    vevent,
                    hasDefaultNotifications: old.hasDefaultNotifications,
                    removedAttendeesEmails,
                    addedAttendeesPublicKeysMap,
                }),
            sent.length || prepared.length > emails.length ? 3 : 1
        );
    } catch (error: any) {
        if (sent.length) {
            rememberPending(ctx, key, sent, stamp);
        }
        if (sent.length || prepared.length > emails.length) {
            throw new InvitationActionError(
                `Your guests were emailed, but Proton did not save the change (${errorText(error)}). ` +
                    'Save it again in a few minutes (no second email), or make the change in Proton Calendar.',
                'incomplete',
                result.emails[0],
                result.emails,
                { eventID: old.event.ID, uid }
            );
        }
        throw error;
    }
    ctx.pendingOrganizerEmails.delete(key);
    result.changedEventIds.push(old.event.ID);
    return result;
};

// ---------------------------------------------------------------------------------------------
// Deleting a meeting you organize (getDeleteEventActions, CANCEL_INVITATION)
// ---------------------------------------------------------------------------------------------

export const cancelOrganizedEvent = async (
    ctx: InvitationContext,
    { calendarID, eventID, notifyAttendees }: CancelOrganizedEventInput
): Promise<OrganizerActionResult> => {
    const old = await readOrganizedEvent(ctx, calendarID, eventID);
    const uid = old.vevent.uid.value;
    const key = pendingKey(calendarID, uid);
    const result: OrganizerActionResult = {
        emails: [],
        changedEventIds: [],
        deletedEventIds: [],
        warnings: [],
        eventId: old.event.ID,
        protonUid: uid,
    };
    const attendees = old.vevent.attendee || [];
    const selfAddress = old.selfAddress;
    const canSend = !!selfAddress && getIsAddressActive(selfAddress);
    const notify = notifyAttendees && attendees.length > 0 && canSend;
    if (notifyAttendees && attendees.length && !canSend) {
        result.warnings.push(
            `Your guests were not told: your address ${selfAddress?.Email || ''} cannot send emails.`.replace('  ', ' ')
        );
    }

    let email: PreparedEmail | undefined;
    let alreadySent = false;
    if (notify) {
        const { MailSettings: mailSettings } = await ctx.api<{ MailSettings: any }>(getMailSettings());
        const sendPreferencesMap = await getSendPreferencesMap(
            ctx,
            attendees.map((attendee) => getAttendeeEmail(attendee)),
            mailSettings
        );
        const errors = errorsAmong(Object.keys(sendPreferencesMap), sendPreferencesMap);
        if (errors.length) {
            result.warnings.push(`Not emailed (Proton cannot send to them): ${errors.join(', ')}`);
        }
        const sharedEventID = (old.event as any).SharedEventID;
        if (!sharedEventID) {
            throw new InvitationActionError('Could not read the shared event ID of this event', 'failed');
        }
        const prepared = await prepareCancelEmail(
            { ctx, selfAddress: selfAddress!, sendPreferencesMap, mailSettings, timestamp: +serverTime(), language: await resolveInvitationLanguage(ctx) },
            { cancelVevent: old.vevent, sharedEventID }
        );
        const [toSend] = prepared ? withoutAlreadySent(ctx, key, [prepared], result, stampOf([old.event])) : [];
        alreadySent = !!prepared && !toSend;
        email = toSend;
    }
    if (email) {
        await enforcePolicy(ctx, [email], 'cancelling this event');
    } else if (ctx.policy.mode === 'dry-run') {
        throw new InvitationActionError('Dry run: would delete the event without emailing the guests; nothing was changed.', 'dry-run');
    }

    if (email) {
        await sendAll(ctx, [email], result);
    }
    const ids = [old.event.ID];
    try {
        await withRetries(() => deleteEvents(ctx, calendarID, ids), email || alreadySent ? 3 : 1);
    } catch (error: any) {
        if (email) {
            rememberPending(ctx, key, [email], stampOf([old.event]));
        }
        if (email || alreadySent) {
            throw new InvitationActionError(
                `Your guests were told the event is cancelled, but Proton did not delete it (${errorText(error)}). ` +
                    'Delete it again in a few minutes (no second email), or delete it in Proton Calendar.',
                'incomplete',
                result.emails[0],
                result.emails,
                { eventID: old.event.ID, uid }
            );
        }
        throw error;
    }
    ctx.pendingOrganizerEmails.delete(key);
    result.deletedEventIds.push(...ids);
    return result;
};

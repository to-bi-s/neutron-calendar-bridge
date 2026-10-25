/**
 * Recurring meetings you organize (invitations, stage 3b) — a port of what Proton Calendar's web
 * app does when an organizer saves or deletes a recurring event with guests.
 *
 * Proton's app is told by the user what was meant ("this occurrence" / "all occurrences"); a
 * calendar app over CalDAV just sends its new version of the whole series. So the change is read
 * from the difference between Proton's series and that version, and then carried out the way
 * Proton's app carries out the same change:
 * - the main event changed (time, repeat rule, title, place, notes, guests) → "all occurrences"
 *   (getSaveRecurringEventActions, RECURRING_TYPES.ALL);
 * - an occurrence changed or added → "this occurrence" (RECURRING_TYPES.SINGLE: a new single edit
 *   via an intermediate event, or an update of the existing one);
 * - an occurrence excluded (EXDATE) → deleting "this occurrence" (getDeleteRecurringEventActions,
 *   SINGLE: cancellation for it, EXDATE on the series);
 * - the whole series deleted → deleting "all occurrences" (cancellations, everything deleted).
 *
 * Sources (Proton WebClients, commit 464c1b060), applications/calendar/src/app/containers/calendar/:
 * - eventActions/getSaveEventActions.ts, getSaveRecurringEventActions.ts, getSaveEventActionsHelpers.ts
 *   (getUpdateSingleEditMergeVevent, getHasMergeUpdate, getUpdateInviteOperationWithIntermediateEvent)
 * - eventActions/getDeleteRecurringEventActions.ts, getRecurringUpdateAllPossibilities.ts, recurringHelper.ts
 * - recurrence/createSingleRecurrence.ts, createSingleCancelledRecurrence.ts, deleteSingleRecurrence.ts,
 *   updateSingleRecurrence.ts
 * - event/getSingleEditRecurringData.ts; eventActions/inviteActions.ts (getHasProtonAttendees)
 *
 * Refused (nothing sent): guests changed for one occurrence only (Proton: guests change for the whole
 * series), an excluded occurrence brought back, a changed occurrence reverted, more than one
 * occurrence changed in one save, a change to the series combined with excluding occurrences.
 *
 * Differences from Proton's app: when the series' time or repeat rule changes, the EXDATEs the
 * calendar app sends are kept (Proton's form drops them, bringing excluded occurrences back);
 * guests' notes on their answers are not carried into a newly changed occurrence.
 */
import './polyfill';
import { resolveInvitationLanguage } from './invitations';
import { serverTime } from '@protontech/crypto';
import { getMailSettings } from '@proton/shared/lib/api/mailSettings';
import { getAttendeeEmail } from '@proton/shared/lib/calendar/attendees';
import { ICAL_EVENT_STATUS, ICAL_METHOD, MAX_ATTENDEES, RECURRING_TYPES } from '@proton/shared/lib/calendar/constants';
import { getBase64SharedSessionKey } from '@proton/shared/lib/calendar/crypto/keys/helpers';
import { toExdate } from '@proton/shared/lib/calendar/exdate';
import { getSupportedStringValue } from '@proton/shared/lib/calendar/icsSurgery/vcal';
import { getHasUpdatedInviteData, getInviteVeventWithUpdatedParstats } from '@proton/shared/lib/calendar/mailIntegration/invite';
import { getOccurrencesBetween } from '@proton/shared/lib/calendar/recurrence/recurring';
import { getIsRruleEqual } from '@proton/shared/lib/calendar/recurrence/rruleEqual';
import {
    getDtendProperty,
    getHasModifiedDateTimes,
    getIsEquivalentOrganizer,
    propertyToUTCDate,
} from '@proton/shared/lib/calendar/vcalConverter';
import { getAttendeeRole, getIsPropertyAllDay, getPropertyTzid } from '@proton/shared/lib/calendar/vcalHelper';
import { getIsAllDay } from '@proton/shared/lib/calendar/veventHelper';
import { fromUTCDate } from '@proton/shared/lib/date/timezone';
import { getIsAddressActive } from '@proton/shared/lib/helpers/address';
import { canonicalizeEmailByGuess } from '@proton/shared/lib/helpers/email';
import { omit } from '@proton/shared/lib/helpers/object';
import type { Address } from '@proton/shared/lib/interfaces';
import type { CalendarEvent, VcalVeventComponent } from '@proton/shared/lib/interfaces/calendar';

import {
    InvitationActionError,
    leftBehindBySlowDown,
    rateLimitedUntil,
    RefusedGuestsError,
    deleteEvents,
    enforcePolicy,
    errorText,
    eventTitleOf,
    fetchEvent,
    fetchEventsByUID,
    readInvitation,
    withRetries,
} from './invitations';
import type { InvitationContext, PreparedEmail, ReadInvitation } from './invitations';
import {
    NOT_YET_ASSIGNED,
    STALE_REFUSAL,
    buildDeleteOperation,
    buildUpdateOperation,
    buildVevent,
    checkOrganized,
    createInProton,
    droppedGuestsWarning,
    errorsAmong,
    extractInviteEmails,
    getAddedAttendeesPublicKeysMap,
    getAttendeesDiff,
    getCorrectedSaveInviteActions,
    getDtend,
    getEquivalentAttendeesSend,
    getMembership,
    getSendPreferencesMap,
    guestSetOf,
    hasPendingEmails,
    pendingKey,
    prepareCancelEmail,
    prepareSaveEmails,
    refuseNewGuests,
    rememberPending,
    saveOrganizedEvent,
    sendAll,
    stampOf,
    syncMany,
    withIncrementedSequence,
    withUpdatedDtstamp,
    withVeventSequence,
    withoutAlreadySent,
    withoutGuests,
} from './organizer';
import type { EmailContext, InviteActions, OrganizerActionResult, SendPreferencesMap } from './organizer';

const { REQUEST } = ICAL_METHOD;

// ---------------------------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------------------------

export interface SaveOrganizedSeriesInput {
    calendarID: string;
    /** The Proton event of the series' main event (or of a single event); omit to create. */
    eventID?: string;
    /** Every VEVENT of the calendar app's version: the main event and its changed occurrences. */
    vevents: VcalVeventComponent[];
    /**
     * The version the calendar app edited (as it was served to it). If Proton's guests, times,
     * repeat rule or excluded occurrences differ from it, the save is refused ('stale').
     */
    basedOn?: VcalVeventComponent[];
    /** Leave out new guests who cannot be invited and save without them (see saveOrganizedEvent). */
    withoutRefusedGuests?: boolean;
}

// ---------------------------------------------------------------------------------------------
// Proton's recurrence helpers from the calendar app (ported)
// ---------------------------------------------------------------------------------------------

/** An occurrence as getOccurrencesBetween returns it. */
interface Occurrence {
    localStart: Date;
    localEnd: Date;
    utcStart: Date;
}

/** The instant of a RECURRENCE-ID or EXDATE, as a key. */
const keyOf = (property: any) => String(+propertyToUTCDate(property));

const isCancelledVevent = (vevent?: VcalVeventComponent) =>
    String(vevent?.status?.value || '').toUpperCase() === ICAL_EVENT_STATUS.CANCELLED;

/** recurringHelper.ts getCurrentVevent: the series as it is on one occurrence. */
const getCurrentVevent = (original: VcalVeventComponent, { localStart, localEnd }: Pick<Occurrence, 'localStart' | 'localEnd'>) => {
    const isAllDay = getIsAllDay(original);
    const correctedLocalEnd = isAllDay ? new Date(+localEnd + 24 * 3600 * 1000) : localEnd;
    return {
        ...omit(original, ['rrule', 'exdate', 'recurrence-id']),
        dtstart: toExdate(fromUTCDate(localStart), isAllDay, getPropertyTzid(original.dtstart)),
        dtend: toExdate(fromUTCDate(correctedLocalEnd), isAllDay, getPropertyTzid(getDtendProperty(original))),
    } as VcalVeventComponent;
};

/** createSingleRecurrence.ts */
const createSingleRecurrence = (component: VcalVeventComponent, original: VcalVeventComponent, localStart: Date) =>
    omit(
        {
            ...component,
            'recurrence-id': toExdate(fromUTCDate(localStart), getIsAllDay(original), getPropertyTzid(original.dtstart)),
        },
        ['rrule', 'exdate']
    ) as VcalVeventComponent;

/** createSingleCancelledRecurrence.ts */
const createSingleCancelledRecurrence = (component: VcalVeventComponent) =>
    withIncrementedSequence({
        ...component,
        'recurrence-id': { ...component.dtstart },
        status: { value: ICAL_EVENT_STATUS.CANCELLED },
    } as VcalVeventComponent);

/** deleteSingleRecurrence.ts: the series with one more EXDATE (undefined if it has it already). */
const deleteSingleRecurrence = (component: VcalVeventComponent, localStart: Date) => {
    const { dtstart, exdate: oldExdate = [] } = component;
    const singleExdate = toExdate(fromUTCDate(localStart), getIsAllDay(component), getPropertyTzid(dtstart));
    if (oldExdate.some((existing) => keyOf(existing) === keyOf(singleExdate))) {
        return undefined;
    }
    const exdate = [...oldExdate, singleExdate].sort((a, b) => +propertyToUTCDate(a) - +propertyToUTCDate(b));
    return { ...component, exdate } as VcalVeventComponent;
};

/** The occurrence of a series starting at a RECURRENCE-ID (ignoring that instant's EXDATE). */
const findOccurrence = (master: VcalVeventComponent, recurrenceId: any): Occurrence | undefined => {
    const time = +propertyToUTCDate(recurrenceId);
    const withoutThatExdate = {
        ...master,
        exdate: master.exdate?.filter((exdate) => +propertyToUTCDate(exdate) !== time),
    };
    // Occurrences overlapping that instant: with long events also the one before, so match the start.
    return getOccurrencesBetween(withoutThatExdate as any, time, time).find((occurrence) => +occurrence.utcStart === time);
};

/**
 * getSaveEventActions keeps the stored WKST when the rule is otherwise the same (calendar apps
 * often drop it), so a re-spelled rule is not a change.
 */
const withStoredRrule = (vevent: VcalVeventComponent, original: VcalVeventComponent) =>
    vevent.rrule && original.rrule && getIsRruleEqual(original.rrule, vevent.rrule, true)
        ? ({ ...vevent, rrule: original.rrule } as VcalVeventComponent)
        : vevent;

/** A date-time without time zone ("floating"): Proton writes its RECURRENCE-IDs / EXDATEs in UTC. */
const isFloating = (vevent: VcalVeventComponent) =>
    !getIsPropertyAllDay(vevent.dtstart) && !getPropertyTzid(vevent.dtstart);

const FLOATING_REFUSAL =
    'This series has no time zone (floating time), so single occurrences cannot be changed or deleted from here. ' +
    'Change the whole series, or use Proton Calendar.';

/** A changed occurrence saved without its guests (an interrupted save): it still has to get them. */
const isUnfinishedEdit = (state: SeriesState, edit: ReadInvitation) =>
    !(edit.vevent.attendee || []).length && (state.master.vevent.attendee || []).length > 0;

/** getSaveEventActionsHelpers.ts getUpdateSingleEditMergeVevent: what an "all" change carries into single edits. */
const getUpdateSingleEditMergeVevent = (newVevent: VcalVeventComponent, oldVevent: VcalVeventComponent) => {
    const result: Partial<VcalVeventComponent> = {};
    if (newVevent.organizer && oldVevent.organizer && !getIsEquivalentOrganizer(newVevent.organizer, oldVevent.organizer)) {
        throw new InvitationActionError('The organizer of this series cannot change.', 'unsupported');
    }
    const { addedAttendees, removedAttendees, hasModifiedRole } = getAttendeesDiff(newVevent, oldVevent);
    for (const key of ['summary', 'location', 'description'] as const) {
        if (getSupportedStringValue(newVevent[key] as any) !== getSupportedStringValue(oldVevent[key] as any)) {
            (result as any)[key] = newVevent[key] || { value: '' };
        }
    }
    if (newVevent.organizer && !oldVevent.organizer) {
        result.organizer = newVevent.organizer;
    }
    if (addedAttendees?.length || removedAttendees?.length || hasModifiedRole) {
        result.attendee = newVevent.attendee || [];
    }
    if (getSupportedStringValue(newVevent.color as any) !== getSupportedStringValue(oldVevent.color as any)) {
        result.color = newVevent.color || ({ value: '' } as any);
    }
    if (getPropertyTzid(newVevent.dtstart) !== getPropertyTzid(oldVevent.dtstart)) {
        result.dtstart = newVevent.dtstart;
    }
    if (newVevent.dtend && oldVevent.dtend && getPropertyTzid(newVevent.dtend) !== getPropertyTzid(oldVevent.dtend)) {
        result.dtend = newVevent.dtend;
    }
    for (const key of ['x-pm-conference-id', 'x-pm-conference-url'] as const) {
        if (getSupportedStringValue((newVevent as any)[key]) !== getSupportedStringValue((oldVevent as any)[key])) {
            (result as any)[key] = (newVevent as any)[key];
        }
    }
    return result;
};

/** getSaveEventActionsHelpers.ts getHasMergeUpdate (notifications are not written from here). */
const getHasMergeUpdate = (vevent: VcalVeventComponent, merge: Partial<VcalVeventComponent>) => {
    for (const key of ['summary', 'location', 'description'] as const) {
        if (merge[key] && getSupportedStringValue(vevent[key] as any) !== getSupportedStringValue(merge[key] as any)) {
            return true;
        }
    }
    if (merge.attendee) {
        const { addedAttendees, removedAttendees, hasModifiedRole } = getAttendeesDiff(vevent, merge as VcalVeventComponent);
        if (addedAttendees?.length || removedAttendees?.length || hasModifiedRole) {
            return true;
        }
    }
    if (merge.organizer && (!vevent.organizer || !getIsEquivalentOrganizer(merge.organizer, vevent.organizer))) {
        return true;
    }
    for (const key of ['x-pm-conference-id', 'x-pm-conference-url'] as const) {
        // By value, and only when the merge names the conference (Proton compares references, which it
        // only ever has when the form changed the conference).
        if (key in merge && getSupportedStringValue((vevent as any)[key]) !== getSupportedStringValue((merge as any)[key])) {
            return true;
        }
    }
    if (merge.color && getSupportedStringValue(vevent.color as any) !== getSupportedStringValue(merge.color as any)) {
        return true;
    }
    if (merge.dtstart && getPropertyTzid(vevent.dtstart) !== getPropertyTzid(merge.dtstart)) {
        return true;
    }
    if (vevent.dtend && merge.dtend && getPropertyTzid(vevent.dtend) !== getPropertyTzid(merge.dtend)) {
        return true;
    }
    return false;
};

/** getSaveEventActionsHelpers.ts handleConferenceDataInMergedVeventIfNeeded */
const withoutEmptyConference = (vevent: VcalVeventComponent) => {
    const result: any = { ...vevent };
    if (!result['x-pm-conference-id']) {
        delete result['x-pm-conference-id'];
    }
    if (!result['x-pm-conference-url']) {
        delete result['x-pm-conference-url'];
    }
    return result as VcalVeventComponent;
};

/** inviteActions.ts getHasProtonAttendees */
const getHasProtonAttendees = (vevent: VcalVeventComponent, map: SendPreferencesMap) =>
    (vevent.attendee || []).some((attendee) => {
        const preferences: any = map[getAttendeeEmail(attendee)];
        return !!preferences && (preferences.isInternal || preferences.encryptionDisabled);
    });

/** Guests and their roles, for "same guests?" checks. */
const guestRolesOf = (ctx: InvitationContext, vevent: VcalVeventComponent) => {
    const guests = guestSetOf(ctx, vevent);
    const roles = new Map<string, string>();
    for (const attendee of vevent.attendee || []) {
        const key = canonicalizeEmailByGuess(getAttendeeEmail(attendee));
        if (guests.has(key)) {
            roles.set(key, String(getAttendeeRole(attendee)));
        }
    }
    return roles;
};

const sameGuests = (ctx: InvitationContext, a: VcalVeventComponent, b: VcalVeventComponent) => {
    const left = guestRolesOf(ctx, a);
    const right = guestRolesOf(ctx, b);
    return left.size === right.size && [...left].every(([email, role]) => right.get(email) === role);
};

const sameGuestSet = (ctx: InvitationContext, a: VcalVeventComponent, b: VcalVeventComponent) => {
    const left = guestSetOf(ctx, a);
    const right = guestSetOf(ctx, b);
    return left.size === right.size && [...left].every((email) => right.has(email));
};

/** A change guests are told about (Proton's getHasUpdatedInviteData) or a change of guests. */
const hasGuestRelevantChange = (ctx: InvitationContext, newVevent: VcalVeventComponent, oldVevent: VcalVeventComponent) =>
    getHasUpdatedInviteData({ newVevent, oldVevent }) || !sameGuests(ctx, newVevent, oldVevent);

const exdateKeys = (vevent?: VcalVeventComponent) => new Set((vevent?.exdate || []).map(keyOf));

const describeOccurrence = (property: any) => {
    const value = property?.value || {};
    const pad = (n: number) => String(n).padStart(2, '0');
    const date = `${value.year}-${pad(value.month)}-${pad(value.day)}`;
    return value.hours === undefined ? date : `${date} ${pad(value.hours)}:${pad(value.minutes)}`;
};

// ---------------------------------------------------------------------------------------------
// Reading the series
// ---------------------------------------------------------------------------------------------

interface SeriesState {
    master: ReadInvitation;
    /** Single edits (changed occurrences) by the instant of their RECURRENCE-ID. */
    singleEdits: Map<string, ReadInvitation>;
    events: CalendarEvent[];
}

const readSeries = async (ctx: InvitationContext, calendarID: string, eventID: string): Promise<SeriesState> => {
    const first = await fetchEvent(ctx.api, calendarID, eventID);
    const fetched = await fetchEventsByUID(ctx.api, calendarID, first.UID);
    const events = fetched.some(({ ID }) => ID === first.ID) ? fetched : [first, ...fetched];
    const reads = await Promise.all(events.map((event) => readInvitation(ctx, event)));
    const master = reads.find((read) => !read.vevent['recurrence-id']);
    if (!master) {
        throw new InvitationActionError(
            'Proton has only changed occurrences of this series, without the series itself; change it in Proton Calendar.',
            'unsupported'
        );
    }
    checkOrganized(master);
    const singleEdits = new Map<string, ReadInvitation>();
    for (const read of reads) {
        if (read.vevent['recurrence-id']) {
            singleEdits.set(keyOf(read.vevent['recurrence-id']), read);
        }
    }
    return { master, singleEdits, events };
};

/** True when Proton's series is not the one the calendar app's copy was based on. */
const seriesChangedSince = (ctx: InvitationContext, basedOn: VcalVeventComponent[], state: SeriesState) => {
    const baseMaster = basedOn.find((vevent) => !vevent['recurrence-id']);
    const master = state.master.vevent;
    if (baseMaster) {
        if (!sameGuestSet(ctx, baseMaster, master)) {
            return true;
        }
        if (getHasModifiedDateTimes({ ...baseMaster, dtend: getDtend(baseMaster) } as VcalVeventComponent, master)) {
            return true;
        }
        if (!getIsRruleEqual(baseMaster.rrule, master.rrule, true)) {
            return true;
        }
        const before = exdateKeys(baseMaster);
        const now = exdateKeys(master);
        if (before.size !== now.size || [...before].some((key) => !now.has(key))) {
            return true;
        }
    }
    for (const exception of basedOn.filter((vevent) => vevent['recurrence-id'])) {
        const current = state.singleEdits.get(keyOf(exception['recurrence-id']));
        if (!current) {
            return true;
        }
        if (!sameGuestSet(ctx, exception, current.vevent)) {
            return true;
        }
        if (getHasModifiedDateTimes({ ...exception, dtend: getDtend(exception) } as VcalVeventComponent, current.vevent)) {
            return true;
        }
    }
    return false;
};

// ---------------------------------------------------------------------------------------------
// The operations
// ---------------------------------------------------------------------------------------------

interface SeriesContext {
    ctx: InvitationContext;
    calendarID: string;
    state: SeriesState;
    /** The calendar's address (keys for Proton's writes). */
    memberAddress: Address;
    /** The address the series is organized from (emails). */
    selfAddress: Address;
    mailSettings: any;
    /** Your own calendar (invitations can only be sent from those, like in Proton Calendar). */
    owned: boolean;
    timestamp: number;
    result: OrganizerActionResult;
}

const newResult = (state: SeriesState): OrganizerActionResult => ({
    emails: [],
    changedEventIds: [],
    deletedEventIds: [],
    warnings: [],
    eventId: state.master.event.ID,
    protonUid: state.master.vevent.uid.value,
});

const requireActiveAddress = (selfAddress: Address) => {
    if (!getIsAddressActive(selfAddress)) {
        throw new InvitationActionError(
            `Your address ${selfAddress.Email} cannot send emails, so guests cannot be updated from it.`,
            'unsupported'
        );
    }
};

/**
 * Send preferences for everyone emailed; new guests who cannot be invited (Proton cannot email
 * them, or test mode) refuse the change (RefusedGuestsError, nothing changed).
 */
const getCheckedSendPreferences = async (
    sc: SeriesContext,
    emails: string[],
    newGuests: string[] = [],
    about?: { vevent: VcalVeventComponent; doing: string }
): Promise<SendPreferencesMap> => {
    const map = await getSendPreferencesMap(sc.ctx, [...new Set(emails)], sc.mailSettings);
    refuseNewGuests(sc.ctx, newGuests, map, {
        from: sc.selfAddress.Email,
        eventTitle: about ? eventTitleOf(about.vevent) : '',
        eventUid: about?.vevent.uid?.value || '',
        doing: about?.doing || 'this change',
    });
    const otherErrors = errorsAmong(
        Object.keys(map).filter((email) => !newGuests.includes(email)),
        map
    );
    if (otherErrors.length) {
        sc.result.warnings.push(`Not emailed (Proton cannot send to them): ${otherErrors.join(', ')}`);
    }
    return map;
};

const sharedKeyOf = async (sc: SeriesContext, event: CalendarEvent) => {
    const sharedSessionKey = await getBase64SharedSessionKey({
        calendarEvent: event,
        calendarKeys: await sc.ctx.getCalendarKeys(sc.calendarID),
    });
    const sharedEventID = (event as any).SharedEventID;
    if (!sharedSessionKey || !sharedEventID) {
        throw new InvitationActionError('Could not read the shared key of this event', 'failed');
    }
    return { sharedSessionKey, sharedEventID };
};

/**
 * Emails first (checked against the policy before anything changes), then one events/sync request.
 * Proton refusing the write after emails went out → retried, then 'incomplete' (a retry of the same
 * change within a few minutes does not email again).
 */
const sendThenSync = async (
    sc: SeriesContext,
    emails: PreparedEmail[],
    operations: any[],
    { doing, deleting = false }: { doing: string; deleting?: boolean }
) => {
    const { ctx, calendarID, state, result } = sc;
    const key = pendingKey(calendarID, state.master.vevent.uid.value);
    const stamp = stampOf(state.events);
    const toSend = withoutAlreadySent(ctx, key, emails, result, stamp);
    if (ctx.policy.mode === 'dry-run' && !toSend.length) {
        throw new InvitationActionError(
            `Dry run: would ${deleting ? 'delete it' : 'save the change'} without emailing anyone; nothing was changed.`,
            'dry-run'
        );
    }
    await enforcePolicy(ctx, toSend, doing);
    const sent = await sendAll(ctx, toSend, result);
    const emailed = sent.length > 0 || emails.length > toSend.length;
    let saved: (CalendarEvent | undefined)[];
    try {
        saved = await withRetries(() => syncMany(ctx, calendarID, operations), emailed ? 3 : 1);
    } catch (error: any) {
        if (sent.length) {
            rememberPending(ctx, key, sent, stamp);
        }
        if (emailed) {
            throw new InvitationActionError(
                deleting
                    ? `Your guests were told it is cancelled, but Proton did not delete it (${errorText(error)}). ` +
                          'Delete it again in a few minutes (no second email), or delete it in Proton Calendar.'
                    : `Your guests were emailed, but Proton did not save the change (${errorText(error)}). ` +
                          'Save it again in a few minutes (no second email), or make the change in Proton Calendar.',
                'incomplete',
                result.emails[0],
                result.emails,
                { eventID: state.master.event.ID, uid: state.master.vevent.uid.value }
            );
        }
        throw error;
    }
    ctx.pendingOrganizerEmails.delete(key);
    operations.forEach((operation, index) => {
        if (operation.DeletionReason !== undefined) {
            result.deletedEventIds.push(operation.ID);
        } else if (saved[index]?.ID) {
            result.changedEventIds.push(saved[index]!.ID);
        }
    });
};

/**
 * updateAllRecurrence KEEP_SINGLE_MODIFICATIONS (the time and rule did not change): the series keeps
 * its start and end as stored and its excluded occurrences. Same instants, but a calendar app may
 * write them in another time zone, and getUpdateSingleEditMergeVevent would then copy its start and
 * end into every changed occurrence.
 */
const keepSingleModifications = (vevent: VcalVeventComponent, original: VcalVeventComponent) => {
    const kept = { ...vevent, dtstart: original.dtstart, ...(original.dtend ? { dtend: original.dtend } : {}) } as VcalVeventComponent;
    return original.exdate?.length ? ({ ...kept, exdate: original.exdate } as VcalVeventComponent) : (omit(kept, ['exdate']) as VcalVeventComponent);
};

/**
 * A moved series keeps the EXDATEs the calendar app moved along, written like Proton writes them
 * (the series' time zone; Proton matches them by local time) — ones that match no occurrence are dropped.
 */
const withMatchingExdates = (vevent: VcalVeventComponent) => {
    if (!vevent.exdate?.length || isFloating(vevent)) {
        return vevent;
    }
    const isAllDay = getIsAllDay(vevent);
    const tzid = getPropertyTzid(vevent.dtstart);
    const byKey = new Map<string, any>();
    for (const exdate of vevent.exdate) {
        const occurrence = findOccurrence(vevent, exdate);
        if (occurrence) {
            const normalized = toExdate(fromUTCDate(occurrence.localStart), isAllDay, tzid);
            byKey.set(keyOf(normalized), normalized);
        }
    }
    const exdate = [...byKey.values()].sort((a, b) => +propertyToUTCDate(a) - +propertyToUTCDate(b));
    return exdate.length ? ({ ...vevent, exdate } as VcalVeventComponent) : (omit(vevent, ['exdate']) as VcalVeventComponent);
};

/** "All occurrences" (RECURRING_TYPES.ALL): the series' main event changed. */
const updateAll = async (sc: SeriesContext, input: VcalVeventComponent) => {
    const { ctx, calendarID, state, memberAddress, selfAddress, timestamp } = sc;
    const original = state.master.vevent;
    let vevent = withStoredRrule(await buildVevent(ctx, input, state.master, selfAddress, timestamp), original);
    // getRecurringUpdateAllPossibilities: a new time or repeat rule is a breaking change.
    const isBreakingChange = getHasModifiedDateTimes(vevent, original) || !getIsRruleEqual(original.rrule, vevent.rrule, true);
    if (!isBreakingChange) {
        vevent = keepSingleModifications(vevent, original);
    } else {
        vevent = withMatchingExdates(vevent);
    }
    vevent = withVeventSequence(withUpdatedDtstamp(vevent, original, timestamp), original);
    const corrected = getCorrectedSaveInviteActions(vevent, original);
    const inviteActions: InviteActions = { ...corrected, recurringType: RECURRING_TYPES.ALL };
    const isSendType = inviteActions.type !== 'NONE';
    vevent = getInviteVeventWithUpdatedParstats(vevent, original, isSendType ? REQUEST : undefined);
    const equivalent = getEquivalentAttendeesSend(vevent, inviteActions);
    if (equivalent?.length) {
        throw new InvitationActionError(
            `Some guests are the same person under different addresses (${equivalent.map((group) => group.join(' = ')).join('; ')}). Keep one address each.`,
            'unsupported'
        );
    }

    const singleEdits = [...state.singleEdits.values()];
    const emails: PreparedEmail[] = [];
    const operations: any[] = [];
    const updateSingleEditOperations: any[] = [];
    let addedAttendeesPublicKeysMap: Record<string, any> | undefined;
    const removedAttendeesEmails = inviteActions.removedAttendees?.map((attendee) => getAttendeeEmail(attendee));

    if (isSendType) {
        requireActiveAddress(selfAddress);
        const isNewInvitation =
            inviteActions.type === 'SEND_INVITATION' && !inviteActions.addedAttendees?.length && !inviteActions.removedAttendees?.length;
        const newGuests = isNewInvitation
            ? (vevent.attendee || []).map((attendee) => getAttendeeEmail(attendee))
            : (inviteActions.addedAttendees || []).map((attendee) => getAttendeeEmail(attendee));
        const singleEditGuests = singleEdits.flatMap(({ vevent: edit }) => (edit.attendee || []).map((attendee) => getAttendeeEmail(attendee)));
        const map = await getCheckedSendPreferences(sc, [...extractInviteEmails(inviteActions, vevent, original), ...singleEditGuests], newGuests, {
            vevent,
            doing: 'this change',
        });
        try {
            addedAttendeesPublicKeysMap = await getAddedAttendeesPublicKeysMap(sc.ctx, sc.mailSettings, vevent, inviteActions, map);
        } catch (error: any) {
            throw new InvitationActionError(`Cannot invite a Proton guest: ${errorText(error)}`, 'failed');
        }
        const emailContext: EmailContext = { ctx, selfAddress, sendPreferencesMap: map, mailSettings: sc.mailSettings, timestamp, language: await resolveInvitationLanguage(ctx) };
        emails.push(
            ...(await prepareSaveEmails(emailContext, {
                inviteActions,
                vevent,
                cancelVevent: original,
                ...(await sharedKeyOf(sc, state.master.event)),
            }))
        );
        if (isBreakingChange) {
            // Changed occurrences are cancelled for their guests, then deleted.
            for (const edit of singleEdits.filter(({ event }) => !event.IsPersonalSingleEdit)) {
                const cancel = await prepareCancelEmail(emailContext, {
                    cancelVevent: edit.vevent,
                    sharedEventID: (edit.event as any).SharedEventID,
                });
                if (cancel) {
                    emails.push(cancel);
                }
            }
        } else {
            // "Smart rules": the change is carried into changed occurrences, with an email each.
            const merge = omit(getUpdateSingleEditMergeVevent(vevent, original), ['components']);
            for (const edit of singleEdits) {
                if (!getHasMergeUpdate(edit.vevent, merge)) {
                    continue;
                }
                const updated = withoutEmptyConference({ ...edit.vevent, ...merge } as VcalVeventComponent);
                let editKeys: Record<string, any> | undefined;
                if (!edit.event.IsPersonalSingleEdit) {
                    emails.push(
                        ...(await prepareSaveEmails(emailContext, {
                            inviteActions,
                            vevent: updated,
                            cancelVevent: edit.vevent,
                            ...(await sharedKeyOf(sc, edit.event)),
                        }))
                    );
                    editKeys = await getAddedAttendeesPublicKeysMap(sc.ctx, sc.mailSettings, updated, inviteActions, map);
                }
                updateSingleEditOperations.push(
                    await buildUpdateOperation(ctx, {
                        calendarID,
                        addressID: memberAddress.ID,
                        calendarEvent: edit.event,
                        vevent: updated,
                        hasDefaultNotifications: edit.hasDefaultNotifications,
                        isPersonalSingleEdit: !!edit.event.IsPersonalSingleEdit,
                        addedAttendeesPublicKeysMap: editKeys,
                        removedAttendeesEmails,
                        keepComments: true,
                    })
                );
            }
        }
    } else if (!isBreakingChange) {
        // No email needed (e.g. only a guest's role): changed occurrences still follow the series.
        const merge = omit(getUpdateSingleEditMergeVevent(vevent, original), ['components']);
        for (const edit of singleEdits) {
            if (!getHasMergeUpdate(edit.vevent, merge)) {
                continue;
            }
            updateSingleEditOperations.push(
                await buildUpdateOperation(ctx, {
                    calendarID,
                    addressID: memberAddress.ID,
                    calendarEvent: edit.event,
                    vevent: withoutEmptyConference({ ...edit.vevent, ...merge } as VcalVeventComponent),
                    hasDefaultNotifications: edit.hasDefaultNotifications,
                    isPersonalSingleEdit: !!edit.event.IsPersonalSingleEdit,
                    keepComments: true,
                })
            );
        }
    }

    if (isBreakingChange) {
        operations.push(...singleEdits.map(({ event }) => buildDeleteOperation(event)));
    }
    operations.push(
        await buildUpdateOperation(ctx, {
            calendarID,
            addressID: memberAddress.ID,
            calendarEvent: state.master.event,
            vevent,
            hasDefaultNotifications: state.master.hasDefaultNotifications,
            isBreakingChange,
            removedAttendeesEmails,
            addedAttendeesPublicKeysMap,
            keepComments: !isBreakingChange,
        }),
        ...updateSingleEditOperations
    );
    await sendThenSync(sc, emails, operations, { doing: 'this change' });
};

/** Deleting "this occurrence" (EXDATE added): a cancellation for it, the EXDATE on the series. */
const cancelOccurrence = async (sc: SeriesContext, recurrenceId: any) => {
    const { ctx, calendarID, state, memberAddress, selfAddress, timestamp } = sc;
    const original = state.master.vevent;
    const key = keyOf(recurrenceId);
    const occurrence = findOccurrence(original, recurrenceId);
    if (!occurrence) {
        throw new InvitationActionError(`${describeOccurrence(recurrenceId)} is not an occurrence of this series.`, 'unsupported');
    }
    const edit = state.singleEdits.get(key);
    const isNonPersonalSingleEdit = !!edit && !edit.event.IsPersonalSingleEdit;
    const cancelledOccurrenceVevent = edit ? edit.vevent : createSingleCancelledRecurrence(getCurrentVevent(original, occurrence));
    const emails: PreparedEmail[] = [];
    let hasProtonAttendees = false;
    if ((cancelledOccurrenceVevent.attendee || []).length) {
        if (getIsAddressActive(selfAddress)) {
            const map = await getCheckedSendPreferences(
                sc,
                (cancelledOccurrenceVevent.attendee || []).map((attendee) => getAttendeeEmail(attendee))
            );
            const cancel = await prepareCancelEmail(
                { ctx, selfAddress, sendPreferencesMap: map, mailSettings: sc.mailSettings, timestamp, language: await resolveInvitationLanguage(ctx) },
                { cancelVevent: cancelledOccurrenceVevent, sharedEventID: ((edit ?? state.master).event as any).SharedEventID }
            );
            if (cancel) {
                emails.push(cancel);
            }
            hasProtonAttendees = !isNonPersonalSingleEdit && getHasProtonAttendees(cancelledOccurrenceVevent, map);
        } else {
            sc.result.warnings.push(`Your guests were not told: your address ${selfAddress.Email} cannot send emails.`);
        }
    }
    const operations: any[] = [];
    if (edit) {
        operations.push(buildDeleteOperation(edit.event));
    }
    const withExdate = deleteSingleRecurrence(original, occurrence.localStart);
    if (withExdate) {
        operations.push(
            await buildUpdateOperation(ctx, {
                calendarID,
                addressID: memberAddress.ID,
                calendarEvent: state.master.event,
                vevent: withExdate,
                hasDefaultNotifications: state.master.hasDefaultNotifications,
                cancelledOccurrenceVevent: hasProtonAttendees ? cancelledOccurrenceVevent : undefined,
                keepComments: true,
            })
        );
    }
    await sendThenSync(sc, emails, operations, { doing: 'cancelling this occurrence' });
};

/** Guests of an occurrence must be those of the series (Proton changes guests for all occurrences only). */
const ONE_OCCURRENCE_GUESTS =
    'Guests can only be changed for the whole series (like in Proton Calendar). Change the guests for all events, ' +
    'or change this occurrence in Proton Calendar.';

/** Changing "this occurrence" when it has no single edit yet (createSingleRecurrence + intermediate event). */
const createSingleEdit = async (sc: SeriesContext, input: VcalVeventComponent, occurrence: Occurrence) => {
    const { ctx, calendarID, state, memberAddress, selfAddress, timestamp, result } = sc;
    const original = state.master.vevent;
    const originalWithSequence = { ...original, sequence: { value: original.sequence ? original.sequence.value : 0 } } as VcalVeventComponent;
    const oldOccurrence = getCurrentVevent(originalWithSequence, occurrence);
    let vevent = await buildVevent(ctx, input, { vevent: oldOccurrence, isOrganizer: true }, selfAddress, timestamp, {
        recurrenceFromInput: false,
    });
    if (!sameGuests(ctx, vevent, oldOccurrence)) {
        throw new InvitationActionError(ONE_OCCURRENCE_GUESTS, 'unsupported');
    }
    vevent = createSingleRecurrence(vevent, original, occurrence.localStart);
    vevent = withVeventSequence(withUpdatedDtstamp(vevent, oldOccurrence, timestamp), oldOccurrence);
    const corrected = getCorrectedSaveInviteActions(vevent, oldOccurrence);
    if (corrected.type === 'NONE') {
        // Nothing guests would see (Proton would keep it as your personal change only).
        return false;
    }
    // getCorrectedSendInviteData, isCreatingSingleEdit: like a new invitation for that occurrence.
    const inviteActions: InviteActions = { ...corrected, type: 'SEND_INVITATION' };
    vevent = getInviteVeventWithUpdatedParstats(vevent, oldOccurrence, REQUEST);
    requireActiveAddress(selfAddress);
    const map = await getCheckedSendPreferences(
        sc,
        extractInviteEmails(inviteActions, vevent, oldOccurrence),
        []
    );
    const emailContext: EmailContext = { ctx, selfAddress, sendPreferencesMap: map, mailSettings: sc.mailSettings, timestamp, language: await resolveInvitationLanguage(ctx) };
    let addedAttendeesPublicKeysMap: Record<string, any>;
    try {
        addedAttendeesPublicKeysMap = await getAddedAttendeesPublicKeysMap(sc.ctx, sc.mailSettings, vevent, inviteActions, map);
    } catch (error: any) {
        throw new InvitationActionError(`Cannot invite a Proton guest: ${errorText(error)}`, 'failed');
    }
    // Policy first, with the emails as they will be (Proton assigns the shared event ID on save).
    const planned = await prepareSaveEmails(emailContext, {
        inviteActions,
        vevent,
        cancelVevent: oldOccurrence,
        sharedEventID: NOT_YET_ASSIGNED,
        sharedSessionKey: NOT_YET_ASSIGNED,
    });
    if (ctx.policy.mode === 'dry-run' && !planned.length) {
        throw new InvitationActionError('Dry run: would save the change without emailing anyone; nothing was changed.', 'dry-run');
    }
    await enforcePolicy(ctx, planned, 'changing this occurrence');

    const parentOperations = original.sequence
        ? []
        : [
              await buildUpdateOperation(ctx, {
                  calendarID,
                  addressID: memberAddress.ID,
                  calendarEvent: state.master.event,
                  vevent: originalWithSequence,
                  hasDefaultNotifications: state.master.hasDefaultNotifications,
                  keepComments: true,
              }),
          ];
    const intermediate = await createInProton(ctx, {
        calendarID,
        addressID: memberAddress.ID,
        vevent: omit(vevent, ['attendee']) as VcalVeventComponent,
    });
    const stamp = stampOf([...state.events, intermediate]);
    let sent: PreparedEmail[];
    try {
        const emails = await prepareSaveEmails(emailContext, {
            inviteActions,
            vevent,
            cancelVevent: oldOccurrence,
            ...(await sharedKeyOf(sc, intermediate)),
        });
        sent = await sendAll(ctx, emails, result);
    } catch (error: any) {
        if (rateLimitedUntil(error)) {
            throw leftBehindBySlowDown(error, { calendarID, eventID: intermediate.ID });
        }
        try {
            await deleteEvents(ctx, calendarID, [intermediate.ID]);
        } catch (rollbackError: any) {
            throw new InvitationActionError(
                `${errorText(error)} The changed occurrence was created in Proton without guests and could not be removed again (${errorText(rollbackError)}).`,
                error instanceof InvitationActionError && error.reason !== 'rate-limited' ? error.reason : 'failed',
                error?.email,
                error?.emails,
                { eventID: state.master.event.ID, uid: original.uid.value }
            );
        }
        throw error;
    }
    const key = pendingKey(calendarID, original.uid.value);
    try {
        const operations = [
            ...parentOperations,
            await buildUpdateOperation(ctx, {
                calendarID,
                addressID: memberAddress.ID,
                calendarEvent: intermediate,
                vevent,
                hasDefaultNotifications: true,
                addedAttendeesPublicKeysMap,
            }),
        ];
        await withRetries(() => syncMany(ctx, calendarID, operations));
    } catch (error: any) {
        rememberPending(ctx, key, sent, stamp);
        throw new InvitationActionError(
            `Your guests were told about the change to ${describeOccurrence(vevent['recurrence-id'])}, but Proton did not save it ` +
                `(${errorText(error)}). Save it again in a few minutes (no second email), or change it in Proton Calendar.`,
            'incomplete',
            result.emails[0],
            result.emails,
            { eventID: state.master.event.ID, uid: original.uid.value }
        );
    }
    ctx.pendingOrganizerEmails.delete(key);
    result.changedEventIds.push(intermediate.ID);
    return true;
};

/**
 * Finishing a changed occurrence an interrupted save left without guests (created, guests emailed,
 * guest list not saved): the same computation as createSingleEdit — against the series as it is on
 * that occurrence, so answers are kept and a retry of the same change is recognised (no second
 * email) — then the guests are saved on the existing event. Calendar.app's copy of it has no
 * guests (as served since) or the series' guests (as first saved); both mean "the series' guests".
 */
const finishSingleEdit = async (sc: SeriesContext, input: VcalVeventComponent, edit: ReadInvitation) => {
    const { ctx, calendarID, state, memberAddress, selfAddress, timestamp } = sc;
    const original = state.master.vevent;
    const occurrence = findOccurrence(original, edit.vevent['recurrence-id']);
    if (!occurrence) {
        throw new InvitationActionError(
            `${describeOccurrence(edit.vevent['recurrence-id'])} is no longer an occurrence of this series; change it in Proton Calendar.`,
            'unsupported'
        );
    }
    const originalWithSequence = { ...original, sequence: { value: original.sequence ? original.sequence.value : 0 } } as VcalVeventComponent;
    const oldOccurrence = getCurrentVevent(originalWithSequence, occurrence);
    const withGuests = guestSetOf(ctx, input).size ? input : ({ ...input, attendee: original.attendee } as VcalVeventComponent);
    let vevent = await buildVevent(ctx, withGuests, { vevent: oldOccurrence, isOrganizer: true }, selfAddress, timestamp, {
        recurrenceFromInput: false,
    });
    if (!sameGuests(ctx, vevent, oldOccurrence)) {
        throw new InvitationActionError(ONE_OCCURRENCE_GUESTS, 'unsupported');
    }
    vevent = createSingleRecurrence(vevent, original, occurrence.localStart);
    vevent = withVeventSequence(withUpdatedDtstamp(vevent, oldOccurrence, timestamp), oldOccurrence);
    const corrected = getCorrectedSaveInviteActions(vevent, oldOccurrence);
    const inviteActions: InviteActions = { ...corrected, type: 'SEND_INVITATION' };
    vevent = getInviteVeventWithUpdatedParstats(vevent, oldOccurrence, REQUEST);
    requireActiveAddress(selfAddress);
    const map = await getCheckedSendPreferences(sc, extractInviteEmails(inviteActions, vevent, oldOccurrence), []);
    let addedAttendeesPublicKeysMap: Record<string, any>;
    try {
        addedAttendeesPublicKeysMap = await getAddedAttendeesPublicKeysMap(sc.ctx, sc.mailSettings, vevent, inviteActions, map);
    } catch (error: any) {
        throw new InvitationActionError(`Cannot invite a Proton guest: ${errorText(error)}`, 'failed');
    }
    const emails = await prepareSaveEmails(
        { ctx, selfAddress, sendPreferencesMap: map, mailSettings: sc.mailSettings, timestamp, language: await resolveInvitationLanguage(ctx) },
        { inviteActions, vevent, cancelVevent: oldOccurrence, ...(await sharedKeyOf(sc, edit.event)) }
    );
    const operations: any[] = [];
    if (!original.sequence) {
        operations.push(
            await buildUpdateOperation(ctx, {
                calendarID,
                addressID: memberAddress.ID,
                calendarEvent: state.master.event,
                vevent: originalWithSequence,
                hasDefaultNotifications: state.master.hasDefaultNotifications,
                keepComments: true,
            })
        );
    }
    operations.push(
        await buildUpdateOperation(ctx, {
            calendarID,
            addressID: memberAddress.ID,
            calendarEvent: edit.event,
            vevent,
            hasDefaultNotifications: edit.hasDefaultNotifications,
            addedAttendeesPublicKeysMap,
        })
    );
    await sendThenSync(sc, emails, operations, { doing: 'changing this occurrence' });
};

/** Changing "this occurrence" when it is a single edit already. */
const updateSingleEdit = async (sc: SeriesContext, input: VcalVeventComponent, edit: ReadInvitation) => {
    if (isUnfinishedEdit(sc.state, edit)) {
        return finishSingleEdit(sc, input, edit);
    }
    const { ctx, calendarID, state, memberAddress, selfAddress, timestamp } = sc;
    const original = state.master.vevent;
    const safeSequence = Math.max(original.sequence?.value || 0, edit.vevent.sequence?.value || 0);
    const old = { ...edit.vevent, sequence: { value: safeSequence } } as VcalVeventComponent;
    let vevent = await buildVevent(ctx, input, { vevent: edit.vevent, isOrganizer: true }, selfAddress, timestamp, {
        recurrenceFromInput: false,
    });
    if (!sameGuests(ctx, vevent, edit.vevent)) {
        throw new InvitationActionError(ONE_OCCURRENCE_GUESTS, 'unsupported');
    }
    vevent = withVeventSequence(withUpdatedDtstamp(vevent, old, timestamp), old);
    const corrected = getCorrectedSaveInviteActions(vevent, old);
    const isSendType = corrected.type !== 'NONE';
    const inviteActions: InviteActions =
        isSendType && edit.event.IsPersonalSingleEdit ? { ...corrected, type: 'SEND_INVITATION' } : corrected;
    vevent = getInviteVeventWithUpdatedParstats(vevent, old, isSendType ? REQUEST : undefined);
    const hasUpdatedInviteData = getHasUpdatedInviteData({ newVevent: vevent, oldVevent: old });
    const isBreakingChange = getHasModifiedDateTimes(vevent, old);

    const emails: PreparedEmail[] = [];
    let addedAttendeesPublicKeysMap: Record<string, any> | undefined;
    if (isSendType) {
        requireActiveAddress(selfAddress);
        const newGuests = (inviteActions.addedAttendees || []).map((attendee) => getAttendeeEmail(attendee));
        const map = await getCheckedSendPreferences(sc, extractInviteEmails(inviteActions, vevent, edit.vevent), newGuests, {
            vevent,
            doing: 'changing this occurrence',
        });
        try {
            addedAttendeesPublicKeysMap = await getAddedAttendeesPublicKeysMap(sc.ctx, sc.mailSettings, vevent, inviteActions, map);
        } catch (error: any) {
            throw new InvitationActionError(`Cannot invite a Proton guest: ${errorText(error)}`, 'failed');
        }
        emails.push(
            ...(await prepareSaveEmails(
                { ctx, selfAddress, sendPreferencesMap: map, mailSettings: sc.mailSettings, timestamp, language: await resolveInvitationLanguage(ctx) },
                { inviteActions, vevent, cancelVevent: edit.vevent, ...(await sharedKeyOf(sc, edit.event)) }
            ))
        );
    }
    const operations: any[] = [];
    if (!original.sequence) {
        operations.push(
            await buildUpdateOperation(ctx, {
                calendarID,
                addressID: memberAddress.ID,
                calendarEvent: state.master.event,
                vevent: { ...original, sequence: { value: 0 } } as VcalVeventComponent,
                hasDefaultNotifications: state.master.hasDefaultNotifications,
                keepComments: true,
            })
        );
    }
    operations.push(
        await buildUpdateOperation(ctx, {
            calendarID,
            addressID: memberAddress.ID,
            calendarEvent: edit.event,
            vevent,
            hasDefaultNotifications: edit.hasDefaultNotifications,
            addedAttendeesPublicKeysMap,
            removedAttendeesEmails: inviteActions.removedAttendees?.map((attendee) => getAttendeeEmail(attendee)),
            isPersonalSingleEdit: hasUpdatedInviteData && edit.event.IsPersonalSingleEdit ? false : undefined,
            keepComments: !isBreakingChange,
        })
    );
    await sendThenSync(sc, emails, operations, { doing: 'changing this occurrence' });
};

// ---------------------------------------------------------------------------------------------
// Saving a series
// ---------------------------------------------------------------------------------------------

const splitSeries = (vevents: VcalVeventComponent[]) => {
    const masters = vevents.filter((vevent) => !vevent['recurrence-id']);
    if (masters.length !== 1) {
        throw new InvitationActionError(
            masters.length ? 'A series can only have one main event.' : 'The series has no main event (only changed occurrences).',
            'unsupported'
        );
    }
    return { input: masters[0], exceptions: vevents.filter((vevent) => vevent['recurrence-id']) };
};

const getSeriesContext = async (
    ctx: InvitationContext,
    calendarID: string,
    state: SeriesState,
    timestamp: number
): Promise<SeriesContext> => {
    const membership = await getMembership(ctx, calendarID);
    const memberAddress = ctx.addresses.find(({ ID }) => ID === membership.addressID);
    const selfAddress = (state.master.isOrganizer && state.master.selfAddress) || memberAddress;
    if (!memberAddress || !selfAddress) {
        throw new InvitationActionError('None of your addresses is linked to this calendar', 'failed');
    }
    if ((state.master.vevent.attendee || []).length && !membership.owned) {
        throw new InvitationActionError('Creating invites in a shared calendar is not allowed.', 'unsupported');
    }
    const { MailSettings: mailSettings } = await ctx.api<{ MailSettings: any }>(getMailSettings());
    return { ctx, calendarID, state, memberAddress, selfAddress, mailSettings, owned: membership.owned, timestamp, result: newResult(state) };
};

/** A new series, with changed occurrences: the series (like a single event), then each occurrence. */
const createSeries = async (
    ctx: InvitationContext,
    calendarID: string,
    input: VcalVeventComponent,
    exceptions: VcalVeventComponent[]
): Promise<OrganizerActionResult> => {
    if (exceptions.length && !input.rrule) {
        throw new InvitationActionError('Changed occurrences need a repeating event.', 'unsupported');
    }
    // Everything that would refuse an occurrence is checked before the series is created.
    for (const exception of exceptions) {
        if (!findOccurrence({ ...input, exdate: input.exdate } as VcalVeventComponent, exception['recurrence-id'])) {
            throw new InvitationActionError(
                `${describeOccurrence(exception['recurrence-id'])} is not an occurrence of this series.`,
                'unsupported'
            );
        }
        if (!isCancelledVevent(exception) && !sameGuests(ctx, exception, input)) {
            throw new InvitationActionError(ONE_OCCURRENCE_GUESTS, 'unsupported');
        }
        if (isFloating(input)) {
            throw new InvitationActionError(FLOATING_REFUSAL, 'unsupported');
        }
    }
    const cancelled = exceptions.filter(isCancelledVevent);
    const master = cancelled.length
        ? ({ ...input, exdate: [...(input.exdate || []), ...cancelled.map((exception) => exception['recurrence-id']!)] } as VcalVeventComponent)
        : input;
    const created = await saveOrganizedEvent(ctx, { calendarID, vevent: master });
    for (const exception of exceptions.filter((candidate) => !isCancelledVevent(candidate))) {
        try {
            const state = await readSeries(ctx, calendarID, created.eventId);
            const sc = await getSeriesContext(ctx, calendarID, state, +serverTime());
            const occurrence = findOccurrence(state.master.vevent, exception['recurrence-id']);
            if (occurrence && (await createSingleEdit(sc, exception, occurrence))) {
                created.emails.push(...sc.result.emails);
                created.changedEventIds.push(...sc.result.changedEventIds);
                created.warnings.push(...sc.result.warnings);
            }
        } catch (error: any) {
            throw new InvitationActionError(
                `The meeting was created and your guests invited, but the change to ${describeOccurrence(exception['recurrence-id'])} ` +
                    `could not be saved (${errorText(error)}). Save the event again to finish.`,
                'incomplete',
                created.emails[0],
                created.emails,
                { eventID: created.eventId, uid: created.protonUid }
            );
        }
    }
    return created;
};

/**
 * A change to the whole series is carried into changed occurrences by Proton's rules, so the
 * calendar app's occurrences are not used. One that matches neither its version in Proton nor the
 * merged result is a second change in the same save (e.g. made offline): refused rather than lost.
 */
const refuseOccurrenceChangesAlongside = async (sc: SeriesContext, newMaster: VcalVeventComponent, exceptions: VcalVeventComponent[]) => {
    const { ctx, state, selfAddress, timestamp } = sc;
    const original = state.master.vevent;
    const merge = omit(getUpdateSingleEditMergeVevent(newMaster, original), ['components']);
    const refuse = (exception: VcalVeventComponent) => {
        throw new InvitationActionError(
            `This save changes the whole series and ${describeOccurrence(exception['recurrence-id'])} at the same time. ` +
                'Make one change at a time.',
            'unsupported'
        );
    };
    for (const exception of exceptions) {
        const key = keyOf(exception['recurrence-id']);
        const edit = state.singleEdits.get(key);
        if (isCancelledVevent(exception)) {
            if (!exdateKeys(original).has(key) && !isCancelledVevent(edit?.vevent)) {
                refuse(exception);
            }
            continue;
        }
        let asIs: VcalVeventComponent;
        if (edit) {
            asIs = edit.vevent;
        } else {
            const occurrence = findOccurrence(original, exception['recurrence-id']);
            if (!occurrence) {
                refuse(exception);
                continue;
            }
            asIs = getCurrentVevent(original, occurrence);
        }
        const built = await buildVevent(ctx, exception, { vevent: asIs, isOrganizer: true }, selfAddress, timestamp, {
            recurrenceFromInput: false,
        });
        if (hasGuestRelevantChange(ctx, built, asIs) && hasGuestRelevantChange(ctx, built, { ...asIs, ...merge } as VcalVeventComponent)) {
            refuse(exception);
        }
    }
};

/**
 * Saves a recurring meeting you organize (see saveOrganizedSeriesOnce). With
 * `withoutRefusedGuests`, new guests who cannot be invited are left out of every VEVENT and the
 * series is saved without them; `droppedGuests` lists them.
 */
export const saveOrganizedSeries = async (ctx: InvitationContext, input: SaveOrganizedSeriesInput): Promise<OrganizerActionResult> => {
    try {
        return await saveOrganizedSeriesOnce(ctx, input);
    } catch (error: any) {
        if (!input.withoutRefusedGuests || !(error instanceof RefusedGuestsError)) {
            throw error;
        }
        const refused = error.refusedGuests;
        const emails = refused.map(({ email }) => email);
        const vevents = input.vevents.map((vevent) => withoutGuests(ctx, vevent, emails));
        const master = vevents.find((vevent) => !vevent['recurrence-id']);
        if (!master?.attendee?.length && vevents.some((vevent) => vevent['recurrence-id'])) {
            // Nobody left to invite, but changed occurrences: those are only saved as part of a
            // meeting, so leaving the guests out would lose them. Refused as a whole instead.
            throw error;
        }
        const result = await saveOrganizedSeriesOnce(ctx, { ...input, vevents });
        return { ...result, emails: [...error.emails, ...result.emails], droppedGuests: refused, warnings: [...result.warnings, droppedGuestsWarning(refused)] };
    }
};

const saveOrganizedSeriesOnce = async (
    ctx: InvitationContext,
    { calendarID, eventID, vevents, basedOn }: SaveOrganizedSeriesInput
): Promise<OrganizerActionResult> => {
    const { input, exceptions } = splitSeries(vevents);
    if (!eventID) {
        return createSeries(ctx, calendarID, input, exceptions);
    }
    const state = await readSeries(ctx, calendarID, eventID);
    const original = state.master.vevent;
    if (!original.rrule && !state.singleEdits.size) {
        if (exceptions.length) {
            throw new InvitationActionError('Make the event repeat first, then change single occurrences.', 'unsupported');
        }
        // A single event (which may start repeating): Proton's single-event save.
        return saveOrganizedEvent(ctx, {
            calendarID,
            eventID: state.master.event.ID,
            vevent: input,
            basedOn: basedOn?.find((vevent) => !vevent['recurrence-id']),
        });
    }
    if (basedOn?.length && seriesChangedSince(ctx, basedOn, state)) {
        throw new InvitationActionError(STALE_REFUSAL, 'stale');
    }
    const timestamp = +serverTime();
    const sc = await getSeriesContext(ctx, calendarID, state, timestamp);

    // The series' main event: did anything guests see change (time, repeat rule, text, guests)?
    const candidate = withStoredRrule(await buildVevent(ctx, input, state.master, sc.selfAddress, timestamp), original);
    const masterChanged = hasGuestRelevantChange(ctx, candidate, original);
    const oldExdates = exdateKeys(original);
    const newExdates = exdateKeys(candidate);
    const addedExdates = (candidate.exdate || []).filter((exdate) => !oldExdates.has(keyOf(exdate)));
    const removedExdates = (original.exdate || []).filter((exdate) => !newExdates.has(keyOf(exdate)));

    if (masterChanged) {
        const isBreakingChange =
            getHasModifiedDateTimes(candidate, original) || !getIsRruleEqual(original.rrule, candidate.rrule, true);
        if (!isBreakingChange && (addedExdates.length || removedExdates.length)) {
            throw new InvitationActionError(
                'This save changes the whole series and deletes or restores occurrences at the same time. Make one change at a time.',
                'unsupported'
            );
        }
        // eventModal/helpers.ts getParticipantsError
        const guestCount = candidate.attendee?.length || 0;
        if (guestCount && !sc.owned) {
            throw new InvitationActionError('Creating invites in a shared calendar is not allowed.', 'unsupported');
        }
        const maxAttendees = sc.mailSettings?.RecipientLimit || MAX_ATTENDEES;
        if (guestCount > maxAttendees) {
            throw new InvitationActionError(`At most ${maxAttendees} participants are allowed per invitation.`, 'unsupported');
        }
        if (!isBreakingChange) {
            await refuseOccurrenceChangesAlongside(sc, keepSingleModifications(candidate, original), exceptions);
        }
        await updateAll(sc, input);
        return sc.result;
    }

    if (removedExdates.length) {
        throw new InvitationActionError(
            `A deleted occurrence (${describeOccurrence(removedExdates[0])}) cannot be brought back from here. Add it as a separate event, ` +
                'or change the series in Proton Calendar.',
            'unsupported'
        );
    }
    const inputExceptions = new Map(exceptions.map((exception) => [keyOf(exception['recurrence-id']), exception]));
    const servedKeys = new Set((basedOn || []).filter((vevent) => vevent['recurrence-id']).map((vevent) => keyOf(vevent['recurrence-id'])));
    const unfinished: Array<{ input: VcalVeventComponent; edit: ReadInvitation }> = [];
    type Change =
        | { kind: 'cancel'; recurrenceId: any }
        | { kind: 'create'; input: VcalVeventComponent; occurrence: Occurrence }
        | { kind: 'update'; input: VcalVeventComponent; edit: ReadInvitation };
    const changes: Change[] = [];
    const cancelling = new Set<string>();
    for (const exdate of addedExdates) {
        cancelling.add(keyOf(exdate));
        changes.push({ kind: 'cancel', recurrenceId: exdate });
    }
    for (const [key, exception] of inputExceptions) {
        if (cancelling.has(key)) {
            continue;
        }
        const edit = state.singleEdits.get(key);
        if (isCancelledVevent(exception)) {
            // Some apps cancel an occurrence with a STATUS:CANCELLED copy instead of an EXDATE.
            if (!oldExdates.has(key) && !isCancelledVevent(edit?.vevent)) {
                changes.push({ kind: 'cancel', recurrenceId: exception['recurrence-id'] });
            }
            continue;
        }
        if (edit) {
            if (basedOn?.length && !servedKeys.has(key)) {
                // Proton changed this occurrence, but the calendar app was never shown that version
                // (outside the synced range, or changed since the last sync): don't overwrite it.
                throw new InvitationActionError(
                    `${describeOccurrence(exception['recurrence-id'])} was changed in Proton Calendar, and your calendar app does not ` +
                        'have that version. Nothing was sent. If it was changed just now, try again after the next sync; if it lies ' +
                        'far in the past or future (outside the range the bridge syncs), change it in Proton Calendar.',
                    'unsupported'
                );
            }
            const built = await buildVevent(ctx, exception, { vevent: edit.vevent, isOrganizer: true }, sc.selfAddress, timestamp, {
                recurrenceFromInput: false,
            });
            if (hasGuestRelevantChange(ctx, built, edit.vevent)) {
                changes.push({ kind: 'update', input: exception, edit });
            } else if (isUnfinishedEdit(state, edit)) {
                unfinished.push({ input: exception, edit });
            }
            continue;
        }
        if (oldExdates.has(key)) {
            throw new InvitationActionError(
                `${describeOccurrence(exception['recurrence-id'])} was deleted from this series; it cannot be changed.`,
                'unsupported'
            );
        }
        const occurrence = findOccurrence(original, exception['recurrence-id']);
        if (!occurrence) {
            throw new InvitationActionError(
                `${describeOccurrence(exception['recurrence-id'])} is not an occurrence of this series.`,
                'unsupported'
            );
        }
        const asIs = getCurrentVevent(original, occurrence);
        const built = await buildVevent(ctx, exception, { vevent: asIs, isOrganizer: true }, sc.selfAddress, timestamp, {
            recurrenceFromInput: false,
        });
        if (hasGuestRelevantChange(ctx, built, asIs)) {
            changes.push({ kind: 'create', input: exception, occurrence });
        }
    }
    for (const [key, edit] of state.singleEdits) {
        if (!inputExceptions.has(key) && !cancelling.has(key) && servedKeys.has(key)) {
            throw new InvitationActionError(
                `The change to ${describeOccurrence(edit.vevent['recurrence-id'])} cannot be undone from here. ` +
                    'Change that occurrence back, or delete it.',
                'unsupported'
            );
        }
    }
    if (!changes.length && unfinished.length) {
        // Nothing else changed: finish an occurrence an interrupted save left without guests — but only
        // while its emails are remembered (so none goes out again), not as a side effect of e.g. an alert.
        if (hasPendingEmails(ctx, pendingKey(calendarID, original.uid.value), stampOf(state.events))) {
            changes.push({ kind: 'update', ...unfinished[0] });
        } else {
            sc.result.warnings.push(
                `The change to ${describeOccurrence(unfinished[0].edit.vevent['recurrence-id'])} is not finished: its guests are not saved ` +
                    'in Proton. Change that occurrence again to finish it (its guests are emailed the change), or check it in Proton Calendar.'
            );
        }
    }
    if (!changes.length) {
        // Nothing guests would see (e.g. an alert added in the calendar app).
        return sc.result;
    }
    if (changes.length > 1) {
        throw new InvitationActionError('This save changes several occurrences at once. Change one occurrence at a time.', 'unsupported');
    }
    if (isFloating(original)) {
        throw new InvitationActionError(FLOATING_REFUSAL, 'unsupported');
    }
    const [change] = changes;
    if (change.kind === 'cancel') {
        await cancelOccurrence(sc, change.recurrenceId);
    } else if (change.kind === 'create') {
        await createSingleEdit(sc, change.input, change.occurrence);
    } else {
        await updateSingleEdit(sc, change.input, change.edit);
    }
    return sc.result;
};

// ---------------------------------------------------------------------------------------------
// Deleting a series (getDeleteRecurringEventActions, ALL, organizer)
// ---------------------------------------------------------------------------------------------

/**
 * Cancels a series for its guests (the series and every changed occurrence that is not personal),
 * then deletes it with all its occurrences. Without `notifyAttendees`, just deletes.
 */
export const cancelOrganizedSeries = async (
    ctx: InvitationContext,
    { calendarID, eventID, notifyAttendees }: { calendarID: string; eventID: string; notifyAttendees: boolean }
): Promise<OrganizerActionResult> => {
    const state = await readSeries(ctx, calendarID, eventID);
    const timestamp = +serverTime();
    const { selfAddress } = state.master;
    const result = newResult(state);
    const toCancel = [state.master, ...[...state.singleEdits.values()].filter(({ event }) => !event.IsPersonalSingleEdit)].filter(
        ({ vevent }) => (vevent.attendee || []).length
    );
    const canSend = !!selfAddress && getIsAddressActive(selfAddress);
    if (notifyAttendees && toCancel.length && !canSend) {
        result.warnings.push(`Your guests were not told: your address ${selfAddress?.Email || ''} cannot send emails.`);
    }
    const emails: PreparedEmail[] = [];
    if (notifyAttendees && toCancel.length && canSend) {
        const { MailSettings: mailSettings } = await ctx.api<{ MailSettings: any }>(getMailSettings());
        const map = await getSendPreferencesMap(
            ctx,
            [...new Set(toCancel.flatMap(({ vevent }) => (vevent.attendee || []).map((attendee) => getAttendeeEmail(attendee))))],
            mailSettings
        );
        const errors = errorsAmong(Object.keys(map), map);
        if (errors.length) {
            result.warnings.push(`Not emailed (Proton cannot send to them): ${errors.join(', ')}`);
        }
        for (const { vevent, event } of toCancel) {
            const cancel = await prepareCancelEmail(
                { ctx, selfAddress: selfAddress!, sendPreferencesMap: map, mailSettings, timestamp, language: await resolveInvitationLanguage(ctx) },
                { cancelVevent: vevent, sharedEventID: (event as any).SharedEventID }
            );
            if (cancel) {
                emails.push(cancel);
            }
        }
    }
    const sc: SeriesContext = {
        ctx,
        calendarID,
        state,
        memberAddress: selfAddress!,
        selfAddress: selfAddress!,
        mailSettings: undefined,
        owned: true, // not used when deleting
        timestamp,
        result,
    };
    await sendThenSync(sc, emails, state.events.map((event) => buildDeleteOperation(event)), {
        doing: 'cancelling this series',
        deleting: true,
    });
    return result;
};

/** True when the Proton event is (part of) a series: then cancelOrganizedSeries applies. */
export const isPartOfSeries = async (ctx: InvitationContext, calendarID: string, eventID: string) => {
    const event = await fetchEvent(ctx.api, calendarID, eventID);
    if ((event as any).RRule || (event as any).RecurrenceID) {
        return true;
    }
    const all = await fetchEventsByUID(ctx.api, calendarID, event.UID);
    return all.length > 1;
};

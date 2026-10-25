import * as protonCalendarClient from '../src/proton-calendar-api.ts';

const username = process.env.PROTON_USERNAME;
const password = process.env.PROTON_PASSWORD;

if (!username || !password) {
    throw new Error('Set PROTON_USERNAME and PROTON_PASSWORD before running the smoke test');
}

const assert = (condition: unknown, message: string): asserts condition => {
    if (!condition) {
        throw new Error(message);
    }
};

(async () => {
    const { createProtonCalendarAPI } = protonCalendarClient;
    const api = await createProtonCalendarAPI({ username, password });
    const smokeStart = new Date(Date.now() + 60 * 60 * 1000);
    smokeStart.setUTCSeconds(0, 0);
    const smokeEnd = new Date(smokeStart.getTime() + 30 * 60 * 1000);
    const rangeStart = new Date(smokeStart.getTime() - 60 * 60 * 1000);
    const rangeEnd = new Date(smokeEnd.getTime() + 60 * 60 * 1000);
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const createdTitle = `Codex smoke create ${suffix}`;
    const updatedTitle = `Codex smoke update ${suffix}`;

    const createPayload: protonCalendarClient.EventData = {
        title: createdTitle,
        description: `Smoke test create ${suffix}`,
        location: 'API smoke test',
        startTime: Math.floor(smokeStart.getTime() / 1000),
        endTime: Math.floor(smokeEnd.getTime() / 1000),
        timezone: 'UTC',
        isAllDay: false
    };

    const updatePayload: protonCalendarClient.EventData = {
        ...createPayload,
        title: updatedTitle,
        description: `Smoke test update ${suffix}`,
        location: 'API smoke test updated'
    };

    let createdEventId: string | null = null;

    try {
        const createResult = await api.createEvent(createPayload);
        assert(createResult.success, createResult.error || 'Create failed');
        assert(createResult.id, 'Create returned no event id');
        createdEventId = createResult.id;

        const rawCreatedEvent = await api.getEvent(createdEventId);
        assert(rawCreatedEvent, 'Created event could not be fetched by id');

        const decryptedCreatedEvent = await api.decryptEvent(createdEventId);
        assert(decryptedCreatedEvent, 'Created event could not be decrypted');
        assert(
            decryptedCreatedEvent.summary === createdTitle || decryptedCreatedEvent.title === createdTitle,
            `Created event title mismatch: ${decryptedCreatedEvent.summary || decryptedCreatedEvent.title}`
        );

        const rangeEventsAfterCreate = await api.getEventsInRange(rangeStart, rangeEnd);
        assert(
            rangeEventsAfterCreate.some((event) => event.id === createdEventId),
            'Created event did not appear in range read'
        );

        const updateResult = await api.updateEvent(createdEventId, updatePayload);
        assert(updateResult.success, updateResult.error || 'Update failed');

        const decryptedUpdatedEvent = await api.decryptEvent(createdEventId);
        assert(decryptedUpdatedEvent, 'Updated event could not be decrypted');
        assert(
            decryptedUpdatedEvent.summary === updatedTitle || decryptedUpdatedEvent.title === updatedTitle,
            `Updated event title mismatch: ${decryptedUpdatedEvent.summary || decryptedUpdatedEvent.title}`
        );

        const searchResults = await api.searchEvents(updatedTitle, rangeStart, rangeEnd);
        assert(searchResults.some((event) => event.id === createdEventId), 'Updated event did not appear in search results');

        const deleteResult = await api.deleteEvent(createdEventId);
        assert(deleteResult.success, deleteResult.error || 'Delete failed');

        const deletedEvent = await api.getEvent(createdEventId);
        assert(!deletedEvent, 'Deleted event was still returned by getEvent');
        createdEventId = null;

        console.log(
            JSON.stringify({
                success: true,
                created: true,
                updated: true,
                deleted: true,
                title: updatedTitle
            })
        );
    } finally {
        if (createdEventId) {
            try {
                await api.deleteEvent(createdEventId);
            } catch {
                // Best effort cleanup for disposable smoke events.
            }
        }
    }
})().catch((error) => {
    console.error(
        JSON.stringify({
            success: false,
            error: error instanceof Error ? error.message : String(error)
        })
    );
    process.exit(1);
});

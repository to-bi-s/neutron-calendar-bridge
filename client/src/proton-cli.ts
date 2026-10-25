#!/usr/bin/env node

/**
 * CLI wrapper for the extracted Proton Calendar API
 * This exposes the API functionality via command line for integration with the bridge app
 * while keeping the core API logic in the local package.
 */

import { readFileSync } from 'fs';

import { createProtonCalendarAPI } from './proton-calendar-api';

async function getOrCreateAPI(credentials: any) {
    // Always create a new API instance - the CLI should be stateless
    // but always return the full credentials so the caller can manage state
    console.log('🔐 Creating API instance...');
    const api = await createProtonCalendarAPI(credentials);
    return api;
}

async function main() {
    const args = process.argv.slice(2);
    const command = args[0];

    if (!command) {
        console.log('Usage: npx tsx src/proton-cli.ts <command> <credentials_json> [args...]');
        console.log('Commands:');
        console.log('  init <credentials_json> - Test initialization with credentials');
        console.log('  get-calendars <credentials_json> - Get all calendars');
        console.log('  get-calendars-decrypted <credentials_json> - Get all calendars with decrypted names');
        console.log('  get-events <credentials_json> - Get all events');
        console.log('  create-event <credentials_json> <title> <description> <location> <startTime> <endTime> <isAllDay> - Create event');
        console.log('  update-event <credentials_json> <eventId> <title> <description> <location> <startTime> <endTime> <isAllDay> - Update event');
        console.log('  delete-event <credentials_json> <eventId> - Delete event');
        console.log('  decrypt-event <credentials_json> <eventId> - Decrypt event content');
        console.log('  batch-operations <credentials_json> <operations_json> - Batch CRUD operations');
        console.log('  search-events <credentials_json> <query> - Search events by text');
        console.log('  search-events-range <credentials_json> <query> <startDate> <endDate> - Search events by text in range');
        console.log('  get-events-range <credentials_json> <startDate> <endDate> - Get events in date range');
        console.log('  get-events-with-content <credentials_json> - Get all events with decrypted content');
        console.log('');
        console.log('Credentials JSON format: {"username": "user", "password": "pass", "session": {...}}');
        process.exit(1);
    }

    try {
        // All commands require credentials JSON as first argument
        if (args.length < 2) {
            throw new Error(`${command} requires credentials JSON as first argument`);
        }

        const credentials = JSON.parse(args[1]);

        switch (command) {
            case 'init':
                const api = await getOrCreateAPI(credentials);
                // Return updated credentials that the app can use for subsequent calls
                const updatedCredentials = {
                    username: credentials.username,
                    password: credentials.password,
                    session: api.getSession()
                };
                console.log(JSON.stringify({ 
                    success: true, 
                    message: 'Initialized successfully',
                    credentials: updatedCredentials
                }));
                break;

            case 'get-calendars':
                const calendarsAPI = await getOrCreateAPI(credentials);
                const calendars = await calendarsAPI.getCalendars();
                console.log(JSON.stringify({ 
                    success: true, 
                    data: calendars,
                    credentials: credentials // Return same credentials for app to use
                }));
                break;

            case 'get-calendars-decrypted':
                const decryptedCalendarsAPI = await getOrCreateAPI(credentials);
                const decryptedCalendars = await decryptedCalendarsAPI.getCalendarsWithDecryptedNames();
                console.log(JSON.stringify({ 
                    success: true, 
                    data: decryptedCalendars,
                    credentials: credentials // Return same credentials for app to use
                }));
                break;

            case 'get-events':
                const eventsAPI = await getOrCreateAPI(credentials);
                const events = await eventsAPI.getEvents();
                console.log(JSON.stringify({ 
                    success: true, 
                    data: events,
                    credentials: credentials // Return same credentials for app to use
                }));
                break;

            case 'create-event':
                if (args.length < 8) {
                    throw new Error('create-event requires credentials, title, description, location, startTime, endTime, isAllDay');
                }
                const createAPI = await getOrCreateAPI(credentials);
                const eventData = {
                    title: args[2],
                    description: args[3],
                    location: args[4],
                    startTime: parseInt(args[5]),
                    endTime: parseInt(args[6]),
                    isAllDay: args[7] === 'true',
                    timezone: 'UTC'
                };
                const result = await createAPI.createEvent(eventData);
                console.log(JSON.stringify({ 
                    success: true, 
                    data: result,
                    credentials: credentials // Return same credentials for app to use
                }));
                break;

            case 'update-event':
                if (args.length < 9) {
                    throw new Error('update-event requires credentials, eventId, title, description, location, startTime, endTime, isAllDay');
                }
                const updateAPI = await getOrCreateAPI(credentials);
                const updateEventData = {
                    title: args[3],
                    description: args[4],
                    location: args[5],
                    startTime: parseInt(args[6]),
                    endTime: parseInt(args[7]),
                    isAllDay: args[8] === 'true',
                    timezone: 'UTC'
                };
                const updateResult = await updateAPI.updateEvent(args[2], updateEventData);
                console.log(JSON.stringify({ 
                    success: true, 
                    data: updateResult,
                    credentials: credentials // Return same credentials for app to use
                }));
                break;

            case 'delete-event':
                if (args.length < 3) {
                    throw new Error('delete-event requires credentials, eventId');
                }
                const deleteAPI = await getOrCreateAPI(credentials);
                await deleteAPI.deleteEvent(args[2]);
                console.log(JSON.stringify({ 
                    success: true, 
                    message: 'Event deleted successfully',
                    credentials: credentials // Return same credentials for app to use
                }));
                break;

            case 'decrypt-event':
                if (args.length < 3) {
                    throw new Error('decrypt-event requires credentials, eventId');
                }
                const decryptAPI = await getOrCreateAPI(credentials);
                const decryptedEvent = await decryptAPI.decryptEvent(args[2]);
                if (!decryptedEvent) {
                    throw new Error('Event not found');
                }
                console.log(JSON.stringify({ 
                    success: true, 
                    data: decryptedEvent,
                    credentials: credentials // Return same credentials for app to use
                }));
                break;

            case 'batch-operations':
                if (args.length < 3) {
                    throw new Error('batch-operations requires credentials, operations_json');
                }
                const batchAPI = await getOrCreateAPI(credentials);
                const operations = JSON.parse(args[2]);
                const batchResult = await batchAPI.batchOperations(operations);
                console.log(JSON.stringify({ 
                    success: true, 
                    data: batchResult,
                    credentials: credentials // Return same credentials for app to use
                }));
                break;

            case 'batch-operations-file':
                if (args.length < 3) {
                    throw new Error('batch-operations-file requires credentials, operations_file_path');
                }
                const batchFileAPI = await getOrCreateAPI(credentials);
                const operationsFilePath = args[2];
                const operationsFromFile = JSON.parse(readFileSync(operationsFilePath, 'utf8'));
                const batchFileResult = await batchFileAPI.batchOperations(operationsFromFile);
                console.log(JSON.stringify({ 
                    success: true, 
                    data: batchFileResult,
                    credentials: credentials // Return same credentials for app to use
                }));
                break;

            case 'search-events':
                if (args.length < 3) {
                    throw new Error('search-events requires credentials, query');
                }
                const searchAPI = await getOrCreateAPI(credentials);
                const searchResult = await searchAPI.searchEvents(args[2]);
                console.log(JSON.stringify({ 
                    success: true, 
                    data: searchResult,
                    credentials: credentials // Return same credentials for app to use
                }));
                break;

            case 'search-events-range':
                if (args.length < 5) {
                    throw new Error('search-events-range requires credentials, query, startDate, endDate');
                }
                const searchRangeAPI = await getOrCreateAPI(credentials);
                const searchRangeResult = await searchRangeAPI.searchEvents(
                    args[2],
                    new Date(args[3]),
                    new Date(args[4])
                );
                console.log(JSON.stringify({
                    success: true,
                    data: searchRangeResult,
                    credentials: credentials
                }));
                break;

            case 'get-events-range':
                if (args.length < 4) {
                    throw new Error('get-events-range requires credentials, startDate, endDate');
                }
                const rangeAPI = await getOrCreateAPI(credentials);
                const startDate = new Date(args[2]);
                const endDate = new Date(args[3]);
                const rangeResult = await rangeAPI.getEventsInRange(startDate, endDate);
                console.log(JSON.stringify({ 
                    success: true, 
                    data: rangeResult,
                    credentials: credentials // Return same credentials for app to use
                }));
                break;

            case 'get-events-with-content':
                const contentAPI = await getOrCreateAPI(credentials);
                const contentResult = await contentAPI.getEventsWithContent();
                console.log(JSON.stringify({ 
                    success: true, 
                    data: contentResult,
                    credentials: credentials // Return same credentials for app to use
                }));
                break;

            default:
                throw new Error(`Unknown command: ${command}`);
        }
    } catch (error) {
        console.log(JSON.stringify({ 
            success: false, 
            error: error instanceof Error ? error.message : 'Unknown error' 
        }));
        process.exit(1);
    }
}

// Run the CLI
main().catch(error => {
    console.log(JSON.stringify({ 
        success: false, 
        error: error instanceof Error ? error.message : 'Unknown error' 
    }));
    process.exit(1);
});

#!/usr/bin/env node

import { readFileSync } from 'fs';
import { createInterface } from 'readline';
import { inspect } from 'util';

import { createProtonCalendarAPI, Credentials, ProtonCalendarAPI } from './proton-calendar-api';

interface DaemonRequest {
    id: number;
    command: string;
    args?: any[];
    credentials?: Credentials;
}

interface DaemonResponse {
    id: number;
    success: boolean;
    data?: any;
    error?: string;
    message?: string;
    credentials?: Credentials;
}

const formatLogArg = (value: unknown) =>
    typeof value === 'string' ? value : inspect(value, { depth: 4, breakLength: Infinity, compact: true });

const writeLog = (...args: unknown[]) => {
    process.stderr.write(`${args.map(formatLogArg).join(' ')}\n`);
};

console.log = writeLog;
console.warn = writeLog;
console.error = writeLog;

let api: ProtonCalendarAPI | null = null;
let activeCredentials: Credentials | null = null;

const writeResponse = (response: DaemonResponse) => {
    process.stdout.write(`${JSON.stringify(response)}\n`);
};

const getSessionFingerprint = (credentials?: Credentials | null) =>
    `${credentials?.session?.UID || ''}:${credentials?.session?.AccessToken || ''}`;

const shouldReinitialize = (credentials?: Credentials) => {
    if (!credentials) {
        return api === null;
    }

    if (!api || !activeCredentials) {
        return true;
    }

    if (credentials.username !== activeCredentials.username) {
        return true;
    }

    const incomingFingerprint = getSessionFingerprint(credentials);
    const activeFingerprint = getSessionFingerprint(activeCredentials);

    return Boolean(incomingFingerprint) && incomingFingerprint !== activeFingerprint;
};

const getUpdatedCredentials = () => {
    if (!activeCredentials) {
        return undefined;
    }

    return {
        username: activeCredentials.username,
        password: activeCredentials.password,
        session: api?.getSession() || activeCredentials.session || null
    };
};

const ensureApi = async (credentials?: Credentials, forceReinitialize: boolean = false) => {
    if (forceReinitialize || shouldReinitialize(credentials)) {
        if (!credentials) {
            throw new Error('Credentials are required to initialize the daemon');
        }

        api = await createProtonCalendarAPI(credentials);
        activeCredentials = {
            username: credentials.username,
            password: credentials.password,
            session: api.getSession()
        };
    }

    if (!api) {
        throw new Error('API not initialized');
    }

    return api;
};

const parseEventData = (args: any[], offset: number) => ({
    title: String(args[offset] ?? ''),
    description: String(args[offset + 1] ?? ''),
    location: String(args[offset + 2] ?? ''),
    startTime: parseInt(String(args[offset + 3] ?? '0'), 10),
    endTime: parseInt(String(args[offset + 4] ?? '0'), 10),
    isAllDay: String(args[offset + 5] ?? 'false') === 'true',
    timezone: 'UTC'
});

const handleRequest = async (request: DaemonRequest): Promise<DaemonResponse> => {
    try {
        const args = request.args || [];

        switch (request.command) {
            case 'init': {
                const initializedApi = await ensureApi(request.credentials, true);
                return {
                    id: request.id,
                    success: true,
                    message: 'Initialized successfully',
                    credentials: getUpdatedCredentials(),
                    data: { ready: Boolean(initializedApi) }
                };
            }
            case 'get-calendars': {
                const initializedApi = await ensureApi(request.credentials);
                return {
                    id: request.id,
                    success: true,
                    data: await initializedApi.getCalendars(),
                    credentials: getUpdatedCredentials()
                };
            }
            case 'get-calendars-decrypted': {
                const initializedApi = await ensureApi(request.credentials);
                return {
                    id: request.id,
                    success: true,
                    data: await initializedApi.getCalendarsWithDecryptedNames(),
                    credentials: getUpdatedCredentials()
                };
            }
            case 'get-events': {
                const initializedApi = await ensureApi(request.credentials);
                return {
                    id: request.id,
                    success: true,
                    data: await initializedApi.getEvents(),
                    credentials: getUpdatedCredentials()
                };
            }
            case 'create-event': {
                const initializedApi = await ensureApi(request.credentials);
                return {
                    id: request.id,
                    success: true,
                    data: await initializedApi.createEvent(parseEventData(args, 0)),
                    credentials: getUpdatedCredentials()
                };
            }
            case 'update-event': {
                if (args.length < 7) {
                    throw new Error('update-event requires eventId, title, description, location, startTime, endTime, isAllDay');
                }
                const initializedApi = await ensureApi(request.credentials);
                return {
                    id: request.id,
                    success: true,
                    data: await initializedApi.updateEvent(String(args[0]), parseEventData(args, 1)),
                    credentials: getUpdatedCredentials()
                };
            }
            case 'delete-event': {
                if (args.length < 1) {
                    throw new Error('delete-event requires eventId');
                }
                const initializedApi = await ensureApi(request.credentials);
                return {
                    id: request.id,
                    success: true,
                    data: await initializedApi.deleteEvent(String(args[0])),
                    credentials: getUpdatedCredentials()
                };
            }
            case 'decrypt-event': {
                if (args.length < 1) {
                    throw new Error('decrypt-event requires eventId');
                }
                const initializedApi = await ensureApi(request.credentials);
                const event = await initializedApi.decryptEvent(String(args[0]));
                if (!event) {
                    throw new Error('Event not found');
                }
                return {
                    id: request.id,
                    success: true,
                    data: event,
                    credentials: getUpdatedCredentials()
                };
            }
            case 'batch-operations': {
                if (args.length < 1) {
                    throw new Error('batch-operations requires operations payload');
                }
                const initializedApi = await ensureApi(request.credentials);
                const operations = typeof args[0] === 'string' ? JSON.parse(args[0]) : args[0];
                return {
                    id: request.id,
                    success: true,
                    data: await initializedApi.batchOperations(operations),
                    credentials: getUpdatedCredentials()
                };
            }
            case 'batch-operations-file': {
                if (args.length < 1) {
                    throw new Error('batch-operations-file requires operations file path');
                }
                const initializedApi = await ensureApi(request.credentials);
                const operations = JSON.parse(readFileSync(String(args[0]), 'utf8'));
                return {
                    id: request.id,
                    success: true,
                    data: await initializedApi.batchOperations(operations),
                    credentials: getUpdatedCredentials()
                };
            }
            case 'search-events': {
                if (args.length < 1) {
                    throw new Error('search-events requires query');
                }
                const initializedApi = await ensureApi(request.credentials);
                return {
                    id: request.id,
                    success: true,
                    data: await initializedApi.searchEvents(String(args[0])),
                    credentials: getUpdatedCredentials()
                };
            }
            case 'search-events-range': {
                if (args.length < 3) {
                    throw new Error('search-events-range requires query, startDate, endDate');
                }
                const initializedApi = await ensureApi(request.credentials);
                return {
                    id: request.id,
                    success: true,
                    data: await initializedApi.searchEvents(
                        String(args[0]),
                        new Date(String(args[1])),
                        new Date(String(args[2]))
                    ),
                    credentials: getUpdatedCredentials()
                };
            }
            case 'get-events-range': {
                if (args.length < 2) {
                    throw new Error('get-events-range requires startDate and endDate');
                }
                const initializedApi = await ensureApi(request.credentials);
                return {
                    id: request.id,
                    success: true,
                    data: await initializedApi.getEventsInRange(new Date(String(args[0])), new Date(String(args[1]))),
                    credentials: getUpdatedCredentials()
                };
            }
            case 'get-events-with-content': {
                const initializedApi = await ensureApi(request.credentials);
                return {
                    id: request.id,
                    success: true,
                    data: await initializedApi.getEventsWithContent(),
                    credentials: getUpdatedCredentials()
                };
            }
            case 'shutdown': {
                return {
                    id: request.id,
                    success: true,
                    message: 'Shutting down'
                };
            }
            default:
                throw new Error(`Unknown command: ${request.command}`);
        }
    } catch (error) {
        return {
            id: request.id,
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error'
        };
    }
};

const rl = createInterface({
    input: process.stdin,
    crlfDelay: Infinity
});

let requestQueue = Promise.resolve();

rl.on('line', (line) => {
    requestQueue = requestQueue.then(async () => {
        let request: DaemonRequest;

        try {
            request = JSON.parse(line) as DaemonRequest;
        } catch (error) {
            writeResponse({
                id: -1,
                success: false,
                error: error instanceof Error ? error.message : 'Invalid JSON request'
            });
            return;
        }

        const response = await handleRequest(request);
        writeResponse(response);

        if (request.command === 'shutdown' && response.success) {
            rl.close();
            setImmediate(() => process.exit(0));
        }
    });
});

rl.on('close', () => {
    process.exit(0);
});

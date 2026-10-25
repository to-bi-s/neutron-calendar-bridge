/**
 * Which account a log line is about (0.36.4). Several BridgeServices log through the one console;
 * instead of threading a name through every log call, each account's service is wrapped so that
 * every method runs inside an AsyncLocalStorage context carrying the account's tag — awaits, timers
 * and callbacks started inside inherit it — and the log sink (main.ts) prefixes the line with it.
 * The tag is short and private (`a:` + the first four characters of the account ID; the address
 * only while detailed logging is on); Settings → Accounts shows it next to the account.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

import { isDetailedLogging } from './private-log';

export interface AccountContext {
    id: string;
    tag: string;
    /** The account's address, for the detailed log only. */
    label: () => string | null;
}

const storage = new AsyncLocalStorage<AccountContext>();

/** The log tag of an account ID: "a:" and its first four characters. */
export const accountTag = (id: string) => `a:${id.slice(0, 4)}`;

/** The account the running code belongs to, if any. */
export const currentAccount = () => storage.getStore() ?? null;

/** What to put in front of a log line: "[a:3f9a] ", with the address while detailed logging is on; nothing outside an account. */
export const logPrefix = () => {
    const context = currentAccount();
    if (!context) {
        return '';
    }
    const label = isDetailedLogging() ? context.label() : null;
    return `[${context.tag}${label ? ` ${label}` : ''}] `;
};

/** Runs a function inside an account's context. */
export const runInAccount = <T>(context: AccountContext, run: () => T): T => storage.run(context, run);

/**
 * The service as seen from outside: every method call runs inside the account's context. `this` in
 * the methods is the real object (private fields and all); properties are read and written through.
 */
export const inAccountContext = <T extends object>(service: T, context: AccountContext): T =>
    new Proxy(service, {
        get(target, property, receiver) {
            void receiver;
            const value = Reflect.get(target, property, target);
            if (typeof value === 'function') {
                return (...args: unknown[]) => storage.run(context, () => value.apply(target, args));
            }
            return value;
        },
        set(target, property, value) {
            return Reflect.set(target, property, value);
        }
    });

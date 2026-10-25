import { contextBridge, ipcRenderer } from 'electron';

import type { RendererBridgeApi } from '../shared/types';

const api: RendererBridgeApi = {
    signIn: (credentials, accountId) => ipcRenderer.invoke('bridge:sign-in', credentials, accountId ?? null),
    completeHumanVerification: (submission) => ipcRenderer.invoke('bridge:complete-human-verification', submission),
    cancelHumanVerification: () => ipcRenderer.invoke('bridge:cancel-human-verification'),
    answerSignInPrompt: (accountId, answer) => ipcRenderer.invoke('bridge:answer-sign-in-prompt', accountId, answer),
    cancelSignInPrompt: (accountId) => ipcRenderer.invoke('bridge:cancel-sign-in-prompt', accountId),
    addAccount: () => ipcRenderer.invoke('bridge:add-account'),
    cancelAddAccount: () => ipcRenderer.invoke('bridge:cancel-add-account'),
    signOut: (accountId) => ipcRenderer.invoke('bridge:sign-out', accountId),
    removeAccount: (accountId) => ipcRenderer.invoke('bridge:remove-account', accountId),
    setAccountOrder: (accountIds) => ipcRenderer.invoke('bridge:set-account-order', accountIds),
    getBridgeState: () => ipcRenderer.invoke('bridge:get-state'),
    getCalendars: (accountId) => ipcRenderer.invoke('bridge:get-calendars', accountId),
    getCalDAVConfig: (accountId) => ipcRenderer.invoke('bridge:get-caldav-config', accountId),
    refreshNow: (accountId) => ipcRenderer.invoke('bridge:refresh-now', accountId),
    setUpCalendarApp: (accountId) => ipcRenderer.invoke('bridge:set-up-calendar-app', accountId),
    openProfilesSettings: () => ipcRenderer.invoke('bridge:open-profiles-settings'),
    getTranslations: () => ipcRenderer.invoke('bridge:get-translations'),
    setOpenAtLogin: (enabled) => ipcRenderer.invoke('bridge:set-open-at-login', enabled),
    setCalendarSyncEnabled: (accountId, protonCalendarId, enabled) =>
        ipcRenderer.invoke('bridge:set-calendar-sync-enabled', accountId, protonCalendarId, enabled),
    getSyncStatus: (accountId) => ipcRenderer.invoke('bridge:get-sync-status', accountId),
    openHumanVerification: () => ipcRenderer.invoke('bridge:open-human-verification'),
    openExternal: (url) => ipcRenderer.invoke('bridge:open-external', url),
    updateConfig: (patch, accountId) => ipcRenderer.invoke('bridge:update-config', patch, accountId ?? null),
    syncCalendar: (accountId, protonCalendarId) => ipcRenderer.invoke('bridge:sync-calendar', accountId, protonCalendarId),
    syncCategory: (accountId, kind) => ipcRenderer.invoke('bridge:sync-category', accountId, kind),
    onNavigate: (callback) => {
        ipcRenderer.on('bridge:navigate', (_event, page: string, accountId?: string | null) => callback(page, accountId ?? null));
    },
    onStateChanged: (callback) => {
        ipcRenderer.on('bridge:state-changed', () => callback());
    },
    getChangelog: () => ipcRenderer.invoke('bridge:get-changelog'),
    checkForUpdates: () => ipcRenderer.invoke('bridge:check-for-updates'),
    installUpdate: () => ipcRenderer.invoke('bridge:install-update'),
    deleteLogs: () => ipcRenderer.invoke('bridge:delete-logs'),
    copyCalDAVPassword: (accountId) => ipcRenderer.invoke('bridge:copy-caldav-password', accountId)
};

contextBridge.exposeInMainWorld('bridgeApi', api);

ipcRenderer.on('bridge:verification-complete', () => {
    window.dispatchEvent(new Event('bridge:verification-complete'));
});

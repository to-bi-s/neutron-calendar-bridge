import { ipcRenderer } from 'electron';

const ALLOWED_ORIGINS = new Set(['https://mail-api.proton.me', 'https://verify-api.proton.me']);

const normalizeMessageData = (data: unknown) => {
    if (typeof data !== 'string') {
        return data;
    }

    try {
        return JSON.parse(data);
    } catch {
        return data;
    }
};

window.addEventListener('message', (event) => {
    if (!ALLOWED_ORIGINS.has(event.origin) || !event.data) {
        return;
    }

    const data = normalizeMessageData(event.data) as any;

    ipcRenderer.send('bridge:verification-debug', {
        origin: event.origin,
        type: data?.type,
        keys: data && typeof data === 'object' ? Object.keys(data) : []
    });

    if (data?.type === 'pm_captcha' && typeof data.token === 'string') {
        ipcRenderer.send('bridge:captcha-solved', {
            token: data.token,
            tokenType: 'captcha'
        });
        return;
    }

    if (data?.type === 'pm_height' && Number.isFinite(data.height)) {
        ipcRenderer.send('bridge:captcha-height', Number(data.height));
    }
});

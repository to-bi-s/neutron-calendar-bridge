/**
 * The window's texts in the chosen language (0.32). The catalog (English text → translation) comes
 * from the main process over IPC; renderer.js calls `t()` for the texts it builds, and `applyToDom()`
 * translates the static markup: every text-only element and attribute whose English text is a key,
 * and the elements marked data-i18n-html (text mixed with inline tags) by their markup. The English
 * original is remembered per node, so the language can change at run time without a reload.
 */
(() => {
    let catalog = {};
    let language = 'en';
    /**
     * For dates and times: the Mac's full locale (en-GB, de-CH, pt-BR) while the language follows macOS or
     * matches the Mac's; the chosen language when the user picked a different one.
     */
    let locale = 'en';
    /** Node → its English text (or markup), so a later language keeps translating from the source. */
    const originals = new WeakMap();
    const attributeOriginals = new WeakMap();
    const TRANSLATED_ATTRIBUTES = ['title', 'placeholder', 'aria-label'];

    const normalize = (text) => text.replace(/\s+/g, ' ').trim();
    const interpolate = (text, params) => (params ? text.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match)) : text);

    const lookup = (key) => (Object.hasOwn(catalog, key) ? catalog[key] : undefined);
    const t = (text, params) => interpolate(lookup(text) || text, params);

    const pluralForm = (count, forms) => {
        if (forms <= 1) return 0;
        try {
            return new Intl.PluralRules(language).select(count) === 'one' ? 0 : forms - 1;
        } catch {
            return count === 1 ? 0 : forms - 1;
        }
    };
    const tn = (one, other, count, params) => {
        const translated = lookup(`${one}|${other}`);
        const forms = translated ? translated.split('|') : [one, other];
        return interpolate(forms[Math.min(pluralForm(count, forms.length), forms.length - 1)] ?? other, { count, ...(params || {}) });
    };

    /** Translates a text node whose whole (trimmed) text is a key; keeps the surrounding whitespace. */
    const translateTextNode = (node) => {
        const original = originals.has(node) ? originals.get(node) : node.nodeValue;
        if (!originals.has(node)) originals.set(node, original);
        const key = normalize(original);
        if (!key) return;
        const replacement = lookup(key) || key;
        const leading = original.match(/^\s*/)[0];
        const trailing = original.match(/\s*$/)[0];
        const next = `${leading}${replacement}${trailing}`;
        if (node.nodeValue !== next) node.nodeValue = next;
    };

    const applyToDom = (root = document) => {
        // Mixed elements (text with inline tags): by their markup.
        for (const element of root.querySelectorAll('[data-i18n-html]')) {
            const original = originals.has(element) ? originals.get(element) : element.innerHTML;
            if (!originals.has(element)) originals.set(element, original);
            const key = normalize(original);
            const next = lookup(key) || key;
            if (normalize(element.innerHTML) !== next) element.innerHTML = next;
        }
        // Text-only nodes anywhere else.
        const walker = document.createTreeWalker(root.body || root, NodeFilter.SHOW_TEXT, {
            acceptNode: (node) => {
                const parent = node.parentElement;
                if (!parent || parent.closest('script, style, [data-i18n-html], [data-i18n-skip]')) return NodeFilter.FILTER_REJECT;
                return /\S/.test(node.nodeValue) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
            }
        });
        const nodes = [];
        while (walker.nextNode()) nodes.push(walker.currentNode);
        nodes.forEach(translateTextNode);
        // Attributes people read.
        for (const attribute of TRANSLATED_ATTRIBUTES) {
            for (const element of root.querySelectorAll(`[${attribute}]`)) {
                if (element.closest('[data-i18n-skip]')) continue;
                const store = attributeOriginals.get(element) || {};
                if (!(attribute in store)) {
                    store[attribute] = element.getAttribute(attribute);
                    attributeOriginals.set(element, store);
                }
                const original = store[attribute];
                const next = lookup(normalize(original)) || original;
                if (element.getAttribute(attribute) !== next) element.setAttribute(attribute, next);
            }
        }
        document.documentElement.lang = language;
    };

    const setCatalog = (code, data, systemLocale, followsSystem = false) => {
        language = code || 'en';
        catalog = data && typeof data === 'object' ? data : {};
        const system = String(systemLocale || '');
        locale = followsSystem || system.split(/[-_]/)[0].toLowerCase() === language ? system : language;
        try {
            new Intl.DateTimeFormat(locale);
        } catch {
            locale = language; // a tag Intl does not take would make every date format throw
        }
    };

    window.i18n = { t, tn, applyToDom, setCatalog, get language() { return language; }, get locale() { return locale; } };
})();

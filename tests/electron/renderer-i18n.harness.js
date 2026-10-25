/**
 * Renderer translation smoke run (0.32): loads the built window (dist/renderer/index.html without
 * renderer.js, so no bridge API is needed), applies each catalog with window.i18n.applyToDom() and
 * reports what stayed English — text nodes, attributes and data-i18n-html blocks whose text is a key
 * of keys.json but was not replaced — then switches back to English and checks the markup is the
 * original again. Exit code 1 when anything stayed English or did not switch back.
 *   npm run build && xvfb-run -a electron tests/electron/renderer-i18n.harness.js
 */
const { app, BrowserWindow } = require('electron');
const { mkdtempSync, readFileSync, writeFileSync, copyFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

const root = join(__dirname, '..', '..');
const dist = join(root, 'dist', 'renderer');
const locales = join(root, 'dist', 'locales');
const keys = Object.keys(JSON.parse(readFileSync(join(locales, 'keys.json'), 'utf8')));
const languages = ['de', 'nl', 'fr', 'es', 'it'];

app.on('window-all-closed', () => undefined);

const main = async () => {
    const dir = mkdtempSync(join(tmpdir(), 'renderer-i18n-'));
    const html = readFileSync(join(dist, 'index.html'), 'utf8').replace(/<script src="\.\/renderer\.js"><\/script>/, '');
    writeFileSync(join(dir, 'index.html'), html);
    for (const file of ['i18n.js', 'styles.css']) copyFileSync(join(dist, file), join(dir, file));

    const window = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, sandbox: true } });
    await window.loadFile(join(dir, 'index.html'));
    const run = (script) => window.webContents.executeJavaScript(script, true);

    // data-i18n-html blocks come back with their whitespace collapsed (the key is normalized), so compare without whitespace.
    const original = await run('document.body.innerHTML.replace(/\\s+/g, "")');
    let failures = 0;
    for (const code of languages) {
        const catalog = JSON.parse(readFileSync(join(locales, `${code}.json`), 'utf8'));
        const report = await run(`(() => {
            const catalog = ${JSON.stringify(catalog)};
            // A key whose translation is the English text itself (brand name, "Port") is not a miss.
            const keys = new Set(${JSON.stringify(keys)}.filter((key) => catalog[key] && catalog[key] !== key));
            window.i18n.setCatalog(${JSON.stringify(code)}, catalog);
            window.i18n.applyToDom();
            const normalize = (text) => text.replace(/\\s+/g, ' ').trim();
            const english = [];
            const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
            while (walker.nextNode()) {
                const node = walker.currentNode;
                if (node.parentElement.closest('script, style, [data-i18n-skip]')) continue;
                const text = normalize(node.nodeValue);
                if (keys.has(text)) english.push('text: ' + text.slice(0, 80));
            }
            for (const element of document.querySelectorAll('[data-i18n-html]')) {
                if (keys.has(normalize(element.innerHTML))) english.push('html: ' + normalize(element.textContent).slice(0, 80));
            }
            for (const attribute of ['title', 'placeholder', 'aria-label']) {
                for (const element of document.querySelectorAll('[' + attribute + ']')) {
                    if (element.closest('[data-i18n-skip]')) continue;
                    if (keys.has(normalize(element.getAttribute(attribute)))) english.push(attribute + ': ' + element.getAttribute(attribute).slice(0, 80));
                }
            }
            return { english, lang: document.documentElement.lang, sample: normalize(document.querySelector('h1, h2')?.textContent || '') };
        })()`);
        console.log(`${code}: lang=${report.lang}, first heading "${report.sample}", ${report.english.length} left in English`);
        for (const line of report.english) console.log(`   ${line}`);
        if (report.english.length) failures += 1;
    }
    await run(`window.i18n.setCatalog('en', {}); window.i18n.applyToDom();`);
    const back = await run('document.body.innerHTML.replace(/\\s+/g, "")');
    if (back !== original) {
        failures += 1;
        const at = [...back].findIndex((char, index) => char !== original[index]);
        console.log(`back to English: markup differs at ${at}: …${original.slice(Math.max(0, at - 60), at + 60)}… vs …${back.slice(Math.max(0, at - 60), at + 60)}…`);
    } else {
        console.log('back to English: markup identical to the original');
    }
    window.close();
    console.log(failures ? `FAILED (${failures})` : 'OK');
    setTimeout(() => app.exit(failures ? 1 : 0), 500);
};

app.whenReady().then(main).catch((error) => {
    console.error(error);
    app.exit(1);
});

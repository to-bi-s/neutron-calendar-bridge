/**
 * Herbert's looks, as pictures: loads the demo page from the file system in Electron at 3x,
 * runs through every state, every reaction, the seasons and the switches, and writes one PNG
 * each plus contact sheets into a folder. Look at the sheets after a change to the drawing or
 * the CSS (the app's window harness does the same for the window). Fails on a renderer error.
 *   npx electron prototypes/herbert/test/screenshots.js <shots-dir>
 */
const { app, BrowserWindow } = require('electron');
const { mkdirSync, writeFileSync } = require('node:fs');
const { join, resolve } = require('node:path');

const out = resolve(process.argv.slice(2).filter((a) => !a.startsWith('-') && !a.endsWith('.js')).pop() || 'herbert-shots');
mkdirSync(out, { recursive: true });
app.commandLine.appendSwitch('force-device-scale-factor', '3');
app.on('window-all-closed', () => undefined);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
    const win = new BrowserWindow({ width: 1000, height: 760, show: false });
    const errors = [];
    win.webContents.on('console-message', (e, level, msg) => { if (level >= 2 && !/Electron Security Warning/.test(msg)) errors.push(msg); });
    await win.loadFile(join(__dirname, '..', 'index.html'));
    await sleep(1500);
    const run = (js) => win.webContents.executeJavaScript(js + '; true');
    const shot = async (name) => {
        const img = await win.webContents.capturePage({ x: 0, y: 440, width: 251, height: 320 });
        writeFileSync(join(out, `${name}.png`), img.toPNG());
        return name;
    };
    const names = [];
    const reset = "herbert.setState('idle',{quiet:true}); herbert.hush(); herbert.setSeason('none'); herbert.element.classList.remove('is-night','is-drowsy')";
    await run(reset + "; herbert.setSeason('none')");
    for (const theme of ['dark', 'light']) {
        await run(`document.querySelector('[data-theme-choice="${theme}"]').click()`);
        for (const state of ['idle', 'curious', 'talking', 'asleep', 'worried', 'content']) {
            await run(reset + `; herbert.setState('${state}', ${state === 'talking' ? '{text: herbert.texts.talkingSample}' : '{}'})`);
            await sleep(900); names.push(await shot(`${theme}-state-${state}`));
        }
    }
    const reactions = await win.webContents.executeJavaScript('herbert.reactions');
    for (const name of reactions) {
        await run(reset + `; herbert.react('${name}')`);
        await sleep(name === 'coffee' || name === 'snack' ? 2500 : 900); names.push(await shot(`react-${name}`));
    }
    await run(reset + "; herbert.setState('asleep')"); await sleep(500); await run("herbert.touch('face')"); await sleep(1000); names.push(await shot('asleep-poke'));
    for (const s of ['christmas', 'newyear', 'halloween', 'valentine', 'winter', 'summer']) {
        await run(reset + `; herbert.setSeason('${s}')`); await sleep(500); names.push(await shot(`season-${s}`));
    }
    await run(reset + "; herbert.element.classList.add('is-night'); herbert.setState('asleep')"); await sleep(800); names.push(await shot('night-asleep'));
    await run(reset + "; herbert.setPending(3); herbert.setBusy(true); herbert.think('Hmm…')"); await sleep(900); names.push(await shot('pending-busy-think'));
    await run(reset + "; herbert.setPending(0); herbert.setBusy(false); herbert.element.classList.add('is-drowsy')"); await sleep(600); names.push(await shot('drowsy'));
    await run(reset + "; herbert.setSize('compact')"); await sleep(700); names.push(await shot('compact'));
    await run("herbert.setSize('normal'); herbert.setEnabled(false)"); await sleep(900); names.push(await shot('hidden'));
    await run("herbert.setEnabled(true)");
    // contact sheets, 6 per row, drawn in the page itself so no image library is needed here
    const sheet = await win.webContents.executeJavaScript(`(async () => {
        const names = ${JSON.stringify(names)};
        const dir = ${JSON.stringify('file://' + out)};
        const imgs = await Promise.all(names.map((n) => new Promise((ok) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => ok(null); i.src = dir + '/' + n + '.png'; })));
        const good = imgs.filter(Boolean); if (!good.length) return null;
        const w = good[0].width, h = good[0].height, cols = 6, rows = Math.ceil(good.length / cols);
        const c = document.createElement('canvas'); c.width = w * cols; c.height = h * rows;
        const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
        good.forEach((img, i) => ctx.drawImage(img, (i % cols) * w, Math.floor(i / cols) * h));
        return c.toDataURL('image/png');
    })()`);
    if (sheet) writeFileSync(join(out, 'sheet.png'), Buffer.from(sheet.split(',')[1], 'base64'));
    console.log(`${names.length} pictures in ${out}${sheet ? ' (sheet.png has them all)' : ''}`);
    if (errors.length) { console.error('renderer errors:\n' + errors.join('\n')); app.exit(1); return; }
    app.quit();
});

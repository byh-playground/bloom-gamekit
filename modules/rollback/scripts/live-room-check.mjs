/* global reference */
// Optional external relay smoke. The bounded reference E2E uses local SDP/ICE + real RTC.
import assert from 'node:assert/strict';
import { writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { demoPath, resultsDirectory, launchBrowser, serveRepository } from './browser-helpers.mjs';
if (process.env.RUN_LIVE_ROOM_CHECK !== '1') {
    throw Error('Set RUN_LIVE_ROOM_CHECK=1 for public Nostr/WebRTC smoke');
}
let server;
let browser;
const ERRORS = [];
try {
    if (!process.env.BASE_URL) {
        server = await serveRepository();
    }
    browser = await launchBrowser();
    const PAGES = await Promise.all(
        [0, 1].map(async () => {
            const CONTEXT = await browser.newContext();
            const PAGE = await CONTEXT.newPage();
            PAGE.on('pageerror', (e) => ERRORS.push(e.message));
            return PAGE;
        }),
    );
    const BASE = process.env.BASE_URL ?? `http://127.0.0.1:${server.address().port}${demoPath}`,
        ROOM = String(Math.floor(Math.random() * 10000)).padStart(4, '0');
    for (const [I, PAGE] of PAGES.entries()) {
        await PAGE.goto(BASE);
        await PAGE.selectOption('#mode', I ? 'join' : 'host');
        await PAGE.fill('#room-input', ROOM);
        await PAGE.selectOption('#tps', '10');
        await PAGE.click('#start');
    }
    await Promise.all(
        PAGES.map((page) =>
            page.waitForFunction(
                () =>
                    reference.diagnostics.peers[0]?.commands &&
                    Object.keys(reference.diagnostics.peers[0].actors).length === 2 &&
                    reference.diagnostics.peers[0].tick > 10,
                null,
                {
                    timeout: 60000,
                },
            ),
        ),
    );
    for (const PAGE of PAGES) {
        await PAGE.click('[data-player="a"][data-command="2"]');
    }
    await Promise.all(
        PAGES.map((page) =>
            page.waitForFunction(
                () => Object.values(reference.diagnostics.peers[0].counts).every((c) => c.fire === 1),
                null,
                {
                    timeout: 15000,
                },
            ),
        ),
    );
    const DIAGNOSTICS = await Promise.all(PAGES.map((page) => page.evaluate(() => reference.diagnostics)));
    DIAGNOSTICS.forEach((d) => assert.deepEqual(d.errors, []));
    assert.deepEqual(ERRORS, []);
    assert.deepEqual(DIAGNOSTICS[0].peers[0].counts, DIAGNOSTICS[1].peers[0].counts);
    const REPORT = {
        status: 'PASS',
        publicSignaling: true,
        actualWebRTC: true,
        separateContexts: true,
        differentNetworks: false,
        room: ROOM,
        diagnostics: DIAGNOSTICS,
    };
    await mkdir(resultsDirectory, {
        recursive: true,
    });
    await writeFile(resolve(resultsDirectory, 'live-room-report.json'), JSON.stringify(REPORT, null, 2));
    console.log(JSON.stringify(REPORT));
    await Promise.all(PAGES.map((page) => page.click('#stop')));
} finally {
    await browser?.close();
    if (server) {
        await new Promise((r) => server.close(r));
    }
}

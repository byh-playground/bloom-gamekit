/* global scenarioDemo */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import assert from 'node:assert/strict';
import { navigationFlow } from '../../navigation/tests/browser.mjs';
const SERVER = createServer(async (req, res) => {
    try {
        const P = resolve('.', '.' + new URL(req.url, 'http://localhost').pathname);
        res.setHeader('Content-Type', extname(P) === '.html' ? 'text/html' : 'text/javascript');
        res.end(await readFile(P));
    } catch {
        res.writeHead(404);
        res.end();
    }
});
await new Promise((r) => SERVER.listen(0, '127.0.0.1', r));
let browser;
try {
    browser = await chromium.launch({
        headless: true,
        ...(process.env.CHROMIUM_EXECUTABLE_PATH
            ? {
                  executablePath: process.env.CHROMIUM_EXECUTABLE_PATH,
              }
            : {}),
    });
    const PAGE = await browser.newPage();
    const ERRORS = [];
    PAGE.on('pageerror', (e) => ERRORS.push(e.message));
    const BASE = 'http://127.0.0.1:' + SERVER.address().port;
    await navigationFlow(PAGE, BASE);
    await PAGE.goto(BASE + '/modules/scenario/examples/index.html');
    await PAGE.waitForFunction(() => window.scenarioDemo);
    await PAGE.click('#play');
    await PAGE.waitForFunction(() => scenarioDemo.runner.snapshot().tick > 5);
    await PAGE.click('#pause');
    const PAUSED = await PAGE.evaluate(() => scenarioDemo.runner.snapshot());
    await PAGE.waitForTimeout(80);
    assert.deepEqual(await PAGE.evaluate(() => scenarioDemo.runner.snapshot()), PAUSED);
    await PAGE.click('#play');
    await PAGE.waitForFunction(() => scenarioDemo.runner.state === 'ended');
    assert.equal(await PAGE.evaluate(() => scenarioDemo.value), 430);
    await PAGE.click('#restart');
    await PAGE.waitForFunction(() => scenarioDemo.runner.state === 'ended');
    assert.equal(await PAGE.evaluate(() => scenarioDemo.value), 430);
    await PAGE.click('#repeat');
    await PAGE.click('#play');
    await PAGE.waitForFunction(() => scenarioDemo.runner.snapshot().iteration >= 1);
    await PAGE.click('#stop');
    const STOPPED = await PAGE.evaluate(() => ({
        state: scenarioDemo.runner.state,
        created: scenarioDemo.created,
        disposed: scenarioDemo.disposed,
        backend: scenarioDemo.backend,
    }));
    assert.equal(STOPPED.created, STOPPED.disposed);
    assert.equal(STOPPED.state, 'stopped');
    assert.match(STOPPED.backend, /WebGL/);
    // Live introductions must occupy the whole viewport like Bounko, not a fixed preview card.
    await PAGE.evaluate(async () => {
        const { installShowcase } = await import('/modules/scenario/index.js');
        window.showcaseLayoutTest = installShowcase({
            title: '시연 게임',
            launcher: '#play',
            playSelector: '#play',
            durationMs: 1500,
            ready: () => true,
            timeline: [
                { atMs: 0, action: 'chapter', index: 0, title: '실제 게임 장면', caption: '전체 화면 소개' },
            ],
        });
    });
    await PAGE.click('.bloom-showcase-link');
    await PAGE.waitForSelector('#bloom-showcase:not([hidden]) iframe');
    for (const VIEW of [
        { width: 1280, height: 800 },
        { width: 390, height: 844 },
        { width: 844, height: 390 },
    ]) {
        await PAGE.setViewportSize(VIEW);
        const LAYOUT = await PAGE.evaluate(() => {
            const RECT = (selector) => {
                const ELEMENT = document.querySelector(selector);
                const BOX = ELEMENT.getBoundingClientRect();
                return { left: BOX.left, top: BOX.top, right: BOX.right, bottom: BOX.bottom, width: BOX.width, height: BOX.height };
            };
            return {
                stage: RECT('.bloom-showcase-stage'),
                root: RECT('#bloom-showcase'),
                close: RECT('#bloom-showcase [data-action=close]'),
                play: RECT('#bloom-showcase [data-action=play]'),
                replay: RECT('#bloom-showcase [data-action=replay]'),
                border: getComputedStyle(document.querySelector('.bloom-showcase-stage')).borderTopWidth,
                chapter: document.querySelector('#bloom-showcase').dataset.chapter,
            };
        });
        assert.ok(LAYOUT.stage.width >= VIEW.width - 1 && LAYOUT.stage.height >= VIEW.height - 1, 'The live scene must fill the viewport');
        assert.equal(LAYOUT.border, '0px', 'There must be no inset preview card border');
        for (const BUTTON of [LAYOUT.close, LAYOUT.play, LAYOUT.replay]) {
            assert.ok(BUTTON.left >= 0 && BUTTON.right <= VIEW.width + 1, 'Controls fit horizontally');
            assert.ok(BUTTON.top >= 0 && BUTTON.bottom <= VIEW.height + 1, 'Controls fit vertically');
        }
        assert.equal(LAYOUT.root.width, VIEW.width);
        assert.equal(LAYOUT.root.height, VIEW.height);
    }
    await PAGE.click('#bloom-showcase [data-action=close]');
    assert.equal(await PAGE.locator('#bloom-showcase').isHidden(), true);
    assert.equal(new URL(PAGE.url()).hash, '');
    await PAGE.evaluate(() => window.showcaseLayoutTest.dispose());
    assert.deepEqual(ERRORS, []);
    console.log(
        JSON.stringify({
            navigation: 'PASS',
            scenario: 'PASS',
            ...STOPPED,
        }),
    );
} finally {
    await browser?.close();
    SERVER.close();
}

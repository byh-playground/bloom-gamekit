/* global __bloomImpulse */
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
const BROWSER = await chromium.launch({
    headless: true,
    ...(process.env.CHROMIUM_EXECUTABLE_PATH
        ? {
              executablePath: process.env.CHROMIUM_EXECUTABLE_PATH,
          }
        : {}),
});
const BASE = process.env.BOUNKO_URL || 'https://byh-playground.github.io/bloom-bounko/';
async function game(_folder, hash) {
    const PAGE = await BROWSER.newPage({
            viewport: {
                width: 390,
                height: 844,
            },
        }),
        ERRORS = [];
    PAGE.on('pageerror', (e) => ERRORS.push(e.message));
    await PAGE.goto(BASE + hash);
    await PAGE.waitForFunction(() => window.__bloomImpulse);
    return {
        page: PAGE,
        errors: ERRORS,
    };
}
const CLOSE = () => BROWSER.close();
const REPORT = [];
try {
    for (const WIDTH of [390, 1280]) {
        const { page: PAGE, errors: ERRORS } = await game('bounko', '#/tech/iceShatter', false);
        await PAGE.setViewportSize({
            width: WIDTH,
            height: 844,
        });
        await PAGE.waitForSelector('#techPanel.open');
        const BEFORE = await PAGE.evaluate(() => ({
            storage: JSON.stringify({
                ...localStorage,
            }),
            tech: __bloomImpulse.getState().tech,
        }));
        await PAGE.reload();
        await PAGE.waitForFunction(() => window.__bloomImpulse);
        assert.match(PAGE.url(), /#\/tech\/iceShatter$/);
        await PAGE.click('#techClose');
        await PAGE.click('#wikiOpen');
        await PAGE.goBack();
        await PAGE.waitForFunction(() => !document.querySelector('#wikiPanel').classList.contains('open'));
        await PAGE.goForward();
        await PAGE.waitForSelector('#wikiPanel.open');
        await PAGE.reload();
        await PAGE.waitForSelector('#wikiPanel.open');
        await PAGE.click('#wikiClose');
        await PAGE.click('#ultimateOpen');
        const BUTTON = PAGE.locator('#ultimatePanel [data-preview-id="laserBloom"]');
        await BUTTON.click();
        await PAGE.waitForSelector('#previewPanel:not([hidden])');
        const CHILD = () => PAGE.frames().find((f) => f.url().includes('?preview='));
        await PAGE.waitForFunction(
            () =>
                document.querySelector('#previewViewport iframe')?.contentWindow.__bloomImpulse?.preview?.snapshot()
                    .tick > 10,
        );
        await PAGE.click('#previewToggle');
        const PAUSED = await CHILD().evaluate(() => __bloomImpulse.preview.snapshot());
        await PAGE.waitForTimeout(100);
        assert.deepEqual(await CHILD().evaluate(() => __bloomImpulse.preview.snapshot()), PAUSED);
        await PAGE.click('#previewToggle');
        await PAGE.waitForTimeout(100);
        assert.ok((await CHILD().evaluate(() => __bloomImpulse.preview.snapshot())).tick > PAUSED.tick);
        await PAGE.click('#previewReplay');
        await PAGE.waitForFunction(
            () =>
                document.querySelector('#previewViewport iframe')?.contentWindow.__bloomImpulse?.preview?.snapshot()
                    .tick > 0,
        );
        await PAGE.click('#previewClose');
        assert.equal(await PAGE.locator('#previewViewport iframe').count(), 0);
        assert.equal(await BUTTON.evaluate((el) => document.activeElement === el), true);
        await PAGE.click('#ultimateClose');
        await PAGE.click('#introOpen');
        await PAGE.waitForSelector('#introPanel:not([hidden])');
        await PAGE.waitForFunction(
            () =>
                document.querySelector('#introViewport iframe')?.contentWindow.__bloomImpulse?.intro?.snapshot().tick >
                2,
        );
        await PAGE.click('#introReplay');
        await PAGE.click('#introClose');
        assert.equal(await PAGE.locator('#introViewport iframe').count(), 0);
        assert.equal(new URL(PAGE.url()).hash, '');
        assert.deepEqual(
            await PAGE.evaluate(() => ({
                storage: JSON.stringify({
                    ...localStorage,
                }),
                tech: __bloomImpulse.getState().tech,
            })),
            BEFORE,
        );
        await PAGE.click('#startRun');
        await PAGE.waitForSelector('#themeStartPanel.open');
        await PAGE.locator('[data-start-theme]').first().click();
        await PAGE.waitForFunction(() => __bloomImpulse.getState().tick > 2);
        await PAGE.click('#tune');
        const TICK = await PAGE.evaluate(() => __bloomImpulse.getState().tick);
        await PAGE.waitForTimeout(100);
        assert.equal(await PAGE.evaluate(() => __bloomImpulse.getState().tick), TICK);
        await PAGE.goBack();
        await PAGE.waitForFunction((t) => __bloomImpulse.getState().tick > t, TICK);
        await PAGE.goForward();
        await PAGE.waitForSelector('#settings.open');
        await PAGE.click('#closeSettings');
        assert.equal(new URL(PAGE.url()).hash, '');
        assert.deepEqual(ERRORS, []);
        REPORT.push({
            width: WIDTH,
            navigation: true,
            preview: true,
            intro: true,
            storageUnchanged: true,
            combatSettings: true,
            errors: ERRORS,
        });
        await PAGE.close();
    }
    console.log(REPORT);
} finally {
    await CLOSE();
}

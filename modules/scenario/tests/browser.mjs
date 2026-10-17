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

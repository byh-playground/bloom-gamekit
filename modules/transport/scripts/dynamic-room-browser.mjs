import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..'),
    ERRORS = [];
const SERVER = createServer(async (req, res) => {
    try {
        const PATH = resolve(ROOT, '.' + new URL(req.url, 'http://localhost').pathname);
        if (!PATH.startsWith(ROOT + sep)) {
            res.writeHead(403).end();
            return;
        }
        const DATA = await readFile(PATH);
        res.writeHead(200, {
            'content-type': extname(PATH) === '.html' ? 'text/html' : 'text/javascript',
            'cache-control': 'no-store',
        }).end(DATA);
    } catch {
        res.writeHead(404).end();
    }
});
await new Promise((ok, no) => {
    SERVER.once('error', no);
    SERVER.listen(0, '127.0.0.1', ok);
});
let browser;
try {
    browser = await chromium.launch({
        headless: true,
        ...(process.env.CHROMIUM_EXECUTABLE_PATH
            ? {
                  executablePath: process.env.CHROMIUM_EXECUTABLE_PATH,
              }
            : process.env.BROWSER_CHANNEL
              ? {
                    channel: process.env.BROWSER_CHANNEL,
                }
              : {}),
    });
    const PAGE = await browser.newPage();
    PAGE.on('pageerror', (e) => ERRORS.push(e.message));
    await PAGE.goto(`http://127.0.0.1:${SERVER.address().port}/modules/transport/tests/dynamic-browser.html`);
    await PAGE.waitForFunction(() => typeof window.runDynamicRoomScenario === 'function');
    const LEGACY = await PAGE.evaluate(() => window.runDynamicRoomScenario());
    assert.deepEqual(ERRORS, []);
    assert.equal(LEGACY.passed, true);
    const PREPARED = await PAGE.evaluate(() =>
        window.runDynamicRoomScenario({
            prepared: true,
        }),
    );
    assert.deepEqual(ERRORS, []);
    assert.equal(PREPARED.passed, true);
    const PACED = await PAGE.evaluate(() =>
        window.runDynamicRoomScenario({
            prepared: true,
            paced: true,
        }),
    );
    assert.deepEqual(ERRORS, []);
    assert.equal(PACED.passed, true);
    const AVAILABLE = await PAGE.evaluate(() =>
        window.runDynamicRoomScenario({
            available: true,
        }),
    );
    assert.deepEqual(ERRORS, []);
    assert.equal(AVAILABLE.passed, true);
    const RESULT = {
        passed: true,
        legacy: LEGACY,
        prepared: PREPARED,
        paced: PACED,
        available: AVAILABLE,
    };
    await mkdir(resolve(ROOT, 'test-results/rollback'), {
        recursive: true,
    });
    await writeFile(
        resolve(ROOT, 'test-results/rollback/dynamic-room-report.json'),
        JSON.stringify(RESULT, null, 2) + '\n',
    );
    console.log(JSON.stringify(RESULT, null, 2));
} finally {
    await browser?.close();
    await new Promise((ok) => SERVER.close(ok));
}

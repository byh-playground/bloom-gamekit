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
    const STRICT = await PAGE.evaluate(() =>
        window.runDynamicRoomScenario({
            simulationMode: 'rollback',
        }),
    );
    assert.deepEqual(ERRORS, []);
    assert.equal(STRICT.passed, true);
    const AVAILABLE = await PAGE.evaluate(() =>
        window.runDynamicRoomScenario({
            simulationMode: 'rollback',
            available: true,
        }),
    );
    assert.deepEqual(ERRORS, []);
    assert.equal(AVAILABLE.passed, true);
    const RESULT = {
        passed: true,
        strict: STRICT,
        available: AVAILABLE,
    };
    await mkdir(resolve(ROOT, 'test-results/rollback'), {
        recursive: true,
    });
    await writeFile(
        resolve(ROOT, 'test-results/rollback/room-modes-report.json'),
        JSON.stringify(RESULT, null, 2) + '\n',
    );
    console.log(
        JSON.stringify({
            passed: true,
            strict: STRICT.samples,
            available: AVAILABLE.samples,
        }),
    );
} finally {
    await browser?.close();
    await new Promise((ok) => SERVER.close(ok));
}

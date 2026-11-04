import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { launchBrowser, root, serveRepository } from '../../rollback/scripts/browser-helpers.mjs';
const INDEX_PATH = '/modules/transport/tests/room-browser.html';
const ERRORS = [];
const SERVER = await serveRepository({ indexPath: INDEX_PATH });
let browser;
try {
    browser = await launchBrowser();
    const PAGE = await browser.newPage();
    PAGE.on('pageerror', (error) => ERRORS.push(error.message));
    await PAGE.goto(`http://127.0.0.1:${SERVER.address().port}${INDEX_PATH}`);
    await PAGE.waitForFunction(() => typeof window.runRoomScenario === 'function');
    const RESULT = await PAGE.evaluate(() => window.runRoomScenario());
    assert.deepEqual(ERRORS, []);
    assert.equal(RESULT.passed, true);
    await mkdir(resolve(root, 'test-results/transport'), { recursive: true });
    await writeFile(resolve(root, 'test-results/transport/room-report.json'), JSON.stringify(RESULT, null, 2) + '\n');
    console.log(JSON.stringify(RESULT, null, 2));
} finally {
    await browser?.close();
    await new Promise((done) => SERVER.close(done));
}

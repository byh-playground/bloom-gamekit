import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const ROOT = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const ERRORS = [];
const REPORT = { status: 'FAIL', scenarios: [] };
const SERVER = createServer(async (req, res) => {
    try {
        const FILE = resolve(ROOT, '.' + new URL(req.url, 'http://localhost').pathname);
        if (!FILE.startsWith(ROOT + sep)) {
            res.writeHead(403).end();
            return;
        }
        res.setHeader('Content-Type', extname(FILE) === '.html' ? 'text/html; charset=utf-8' : 'text/javascript');
        res.end(await readFile(FILE));
    } catch {
        res.writeHead(404).end();
    }
});
let browser;
try {
    await mkdir(resolve(ROOT, 'test-results'), { recursive: true });
    await new Promise((resolve) => SERVER.listen(0, '127.0.0.1', resolve));
    browser = await chromium.launch({
        headless: true,
        ...(process.env.CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.CHROMIUM_EXECUTABLE_PATH } : {}),
    });
    REPORT.browser = browser.version();
    const PAGE = await browser.newPage({ viewport: { width: 1100, height: 900 } });
    PAGE.on('pageerror', (error) => ERRORS.push(error.message));
    await PAGE.route('**/*', (route) =>
        route.request().url().startsWith(`http://127.0.0.1:${SERVER.address().port}/`) ||
        route.request().url().startsWith('file:')
            ? route.continue()
            : route.abort(),
    );
    await PAGE.goto(`http://127.0.0.1:${SERVER.address().port}/modules/pixel-physics/examples/index.html`);
    await PAGE.waitForFunction(() => window.pixelPhysicsExample?.diagnostics.tick > 10);
    const START = await PAGE.evaluate(() => window.pixelPhysicsExample.diagnostics);
    await PAGE.keyboard.down('d');
    await PAGE.waitForFunction((tick) => window.pixelPhysicsExample.diagnostics.tick > tick + 25, START.tick);
    await PAGE.keyboard.up('d');
    const MOVED = await PAGE.evaluate(() => window.pixelPhysicsExample.diagnostics);
    assert(MOVED.player.x > START.player.x + 1, 'DOM keyboard moves the simulated player');
    REPORT.scenarios.push('keyboard movement');
    await PAGE.keyboard.press('4');
    const BEFORE = await PAGE.evaluate(() => window.pixelPhysicsExample.diagnostics);
    const STAGE = await PAGE.locator('#c').boundingBox();
    await PAGE.mouse.click(STAGE.x + STAGE.width * 0.35, STAGE.y + STAGE.height * 0.25);
    await PAGE.waitForFunction((count) => window.pixelPhysicsExample.diagnostics.rigidCount > count, BEFORE.rigidCount);
    REPORT.scenarios.push('DOM tool selection and rigid launch');
    await PAGE.click('#dbg');
    assert(await PAGE.locator('#dbg').evaluate((button) => button.classList.contains('on')));
    await PAGE.screenshot({ path: resolve(ROOT, 'test-results/pixel-physics-desktop.png'), fullPage: true });
    await PAGE.click('#det');
    await PAGE.waitForFunction(() => document.querySelector('#out').textContent.includes('롤백'));
    const RESULT = await PAGE.locator('#out').innerText();
    const LINES = RESULT.split('\n');
    assert(LINES.find((line) => line.includes('독립 인스턴스'))?.endsWith('일치'));
    assert(!LINES.find((line) => line.includes('독립 인스턴스'))?.includes('불일치'));
    const CHECKPOINT = LINES.find((line) => line.startsWith('롤백'));
    assert(CHECKPOINT?.includes('체크포인트 true') && CHECKPOINT.endsWith('일치') && !CHECKPOINT.includes('불일치'));
    REPORT.determinism = RESULT;
    REPORT.scenarios.push('same-browser seed reproduction and checkpoint restore');
    await PAGE.click('#reset');
    await PAGE.waitForFunction(() => document.querySelector('#hud').textContent.includes('HP'));
    await PAGE.close();

    // Built preview must run as a single file with all network requests blocked.
    const PREVIEW = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true });
    PREVIEW.on('pageerror', (error) => ERRORS.push(error.message));
    await PREVIEW.route('**/*', (route) =>
        route.request().url().startsWith('file:') ? route.continue() : route.abort(),
    );
    await PREVIEW.goto(pathToFileURL(resolve(ROOT, 'dist/previews/pixel-physics.html')).href);
    await PREVIEW.waitForFunction(() => window.pixelPhysicsExample?.diagnostics.tick > 10);
    assert(await PREVIEW.locator('#c').isVisible());
    await PREVIEW.click('#dbg');
    await PREVIEW.screenshot({ path: resolve(ROOT, 'test-results/pixel-physics-mobile.png'), fullPage: true });
    REPORT.scenarios.push('network-blocked standalone HTML at mobile viewport');
    assert.deepEqual(ERRORS, []);
    REPORT.status = 'PASS';
} catch (error) {
    REPORT.error = error.stack;
    throw error;
} finally {
    await browser?.close();
    await new Promise((resolve) => SERVER.close(resolve));
    await mkdir(resolve(ROOT, 'test-results'), { recursive: true });
    await writeFile(resolve(ROOT, 'test-results/pixel-physics.json'), JSON.stringify(REPORT, null, 2));
    console.log(JSON.stringify(REPORT));
}

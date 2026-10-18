import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { MATTER_URL } from '../dependencies.js';

const ROOT = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const ERRORS = [];
const MODULE_REQUESTS = [];
const MATTER_REQUESTS = [];
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
    PAGE.on('request', (request) => {
        if (request.url() === MATTER_URL) {
            MATTER_REQUESTS.push(request.url());
        }
        const PATH = new URL(request.url()).pathname;
        if (PATH.startsWith('/dist/') && PATH.endsWith('.js')) {
            MODULE_REQUESTS.push(PATH);
        }
    });
    await PAGE.route('**/*', (route) =>
        route.request().url().startsWith(`http://127.0.0.1:${SERVER.address().port}/`) ||
        route.request().url() === MATTER_URL
            ? route.continue()
            : route.abort(),
    );
    await PAGE.goto(`http://127.0.0.1:${SERVER.address().port}/modules/pixel-physics/examples/index.html`);
    await PAGE.waitForFunction(() => window.pixelPhysicsExample?.diagnostics.tick > 10);
    assert.deepEqual(MODULE_REQUESTS, ['/dist/pixel-physics.js']);
    assert.deepEqual(MATTER_REQUESTS, [MATTER_URL]);
    REPORT.matterUrl = MATTER_URL;
    REPORT.scenarios.push('single GameKit module imports Matter from its declared web URL');
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

    // Open-world example: holding thrust climbs, the 320x240 window follows the rocket, and a crater left at the
    // start is written back to the map data once its rows scroll out of the window.
    const OPEN = await browser.newPage({ viewport: { width: 900, height: 700 } });
    OPEN.on('pageerror', (error) => ERRORS.push(error.message));
    await OPEN.route('**/*', (route) =>
        route.request().url().startsWith(`http://127.0.0.1:${SERVER.address().port}/`) ||
        route.request().url() === MATTER_URL
            ? route.continue()
            : route.abort(),
    );
    await OPEN.goto(`http://127.0.0.1:${SERVER.address().port}/modules/pixel-physics/examples/open-world.html`);
    await OPEN.waitForFunction(() => window.openWorldExample?.diagnostics.tick > 10);
    const OPEN_START = await OPEN.evaluate(() => window.openWorldExample.diagnostics);
    assert.equal(OPEN_START.shifts, 0);
    const OPEN_STAGE = await OPEN.locator('#c').boundingBox();
    await OPEN.mouse.click(OPEN_STAGE.x + OPEN_STAGE.width * 0.5, OPEN_STAGE.y + OPEN_STAGE.height * 0.78);
    await OPEN.keyboard.down('Space');
    await OPEN.waitForFunction(
        () => {
            const D = window.openWorldExample.diagnostics;
            return D.altitude > 260 && D.shifts >= 3 && D.edits > 0;
        },
        undefined,
        { timeout: 60000 },
    );
    await OPEN.keyboard.up('Space');
    const OPEN_END = await OPEN.evaluate(() => window.openWorldExample.diagnostics);
    assert(OPEN_END.origin.y < OPEN_START.origin.y, 'window moved up with the rocket');
    assert(OPEN_END.absolute.y < OPEN_START.absolute.y - 200);
    assert.deepEqual(OPEN_END.stream, OPEN_START.stream);
    await OPEN.screenshot({ path: resolve(ROOT, 'test-results/pixel-physics-open-world.png'), fullPage: true });
    REPORT.openWorld = OPEN_END;
    REPORT.scenarios.push('open-world rocket climbs, window follows, crater is evicted to map data');
    await OPEN.close();

    // 모바일(터치 에뮬레이션): 모든 예제는 키보드 없이 터치만으로 조작되어야 합니다. Chromium의 터치 입력(CDP)으로 버튼을 누릅니다.
    // 실제 기기가 아니라 에뮬레이션이며, 멀티터치는 두 접점을 함께 보내 확인합니다.
    const TOUCH_CONTEXT = await browser.newContext({
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
        deviceScaleFactor: 2,
    });
    const TOUCH_ROUTE = (route) =>
        route.request().url().startsWith(`http://127.0.0.1:${SERVER.address().port}/`) ||
        route.request().url() === MATTER_URL
            ? route.continue()
            : route.abort();
    const CENTER = async (page, selector) => {
        const BOX = await page.locator(selector).boundingBox();
        return { x: BOX.x + BOX.width / 2, y: BOX.y + BOX.height / 2 };
    };
    const NO_HORIZONTAL_SCROLL = (page) => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);

    const TOUCH_OPEN = await TOUCH_CONTEXT.newPage();
    TOUCH_OPEN.on('pageerror', (error) => ERRORS.push(error.message));
    await TOUCH_OPEN.route('**/*', TOUCH_ROUTE);
    await TOUCH_OPEN.goto(`http://127.0.0.1:${SERVER.address().port}/modules/pixel-physics/examples/open-world.html`);
    await TOUCH_OPEN.waitForFunction(() => window.openWorldExample?.diagnostics.tick > 10);
    assert(await NO_HORIZONTAL_SCROLL(TOUCH_OPEN), 'open-world has no horizontal scroll on a phone');
    const OPEN_CANVAS = await TOUCH_OPEN.locator('#c').boundingBox();
    assert(OPEN_CANVAS.y + OPEN_CANVAS.height <= 844, 'open-world canvas fits in the first phone screen');
    for (const ID of ['#bl', '#bt', '#br']) {
        const BOX = await TOUCH_OPEN.locator(ID).boundingBox();
        assert(BOX.height >= 56 && BOX.width >= 56, `${ID} is a finger-sized target`);
    }
    const TOUCH = await TOUCH_CONTEXT.newCDPSession(TOUCH_OPEN);
    const THRUST = await CENTER(TOUCH_OPEN, '#bt');
    const TOUCH_START = await TOUCH_OPEN.evaluate(() => window.openWorldExample.diagnostics);
    await TOUCH.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...THRUST, id: 1 }] });
    await TOUCH_OPEN.waitForFunction(() => window.openWorldExample.diagnostics.altitude > 120, undefined, {
        timeout: 60000,
    });
    // 공중에서도 분사 불꽃이 꼬리에서 그려집니다(연기 발사체는 날아가는 동안 격자 셀이 아니라서 따로 그림).
    const FLAME_PIXELS = await TOUCH_OPEN.evaluate(() => {
        const CANVAS = document.getElementById('c'),
            DATA = CANVAS.getContext('2d').getImageData(0, 0, CANVAS.width, CANVAS.height).data;
        let count = 0;
        for (let i = 0; i < DATA.length; i += 4) {
            if (
                (DATA[i] === 255 && DATA[i + 1] === 216 && DATA[i + 2] === 138) ||
                (DATA[i] === 255 && DATA[i + 1] === 143 && DATA[i + 2] === 69)
            ) {
                count++;
            }
        }
        return count;
    });
    assert(FLAME_PIXELS >= 3, 'exhaust flame is visible while flying');
    assert(await TOUCH_OPEN.locator('#bt').evaluate((button) => button.classList.contains('on')));
    await TOUCH_OPEN.screenshot({ path: resolve(ROOT, 'test-results/pixel-physics-open-world-touch.png') });
    await TOUCH.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await TOUCH_OPEN.waitForFunction(() => !document.getElementById('bt').classList.contains('on'));
    const TOUCH_END = await TOUCH_OPEN.evaluate(() => window.openWorldExample.diagnostics);
    assert(TOUCH_END.absolute.y < TOUCH_START.absolute.y - 100, 'touch thrust climbed');
    REPORT.scenarios.push(
        'open-world works by touch emulation: fits a phone screen, thrust climbs, flame is drawn in the air',
    );
    await TOUCH_OPEN.close();

    const TOUCH_PLATFORMER = await TOUCH_CONTEXT.newPage();
    TOUCH_PLATFORMER.on('pageerror', (error) => ERRORS.push(error.message));
    await TOUCH_PLATFORMER.route('**/*', TOUCH_ROUTE);
    await TOUCH_PLATFORMER.goto(`http://127.0.0.1:${SERVER.address().port}/modules/pixel-physics/examples/index.html`);
    await TOUCH_PLATFORMER.waitForFunction(() => window.pixelPhysicsExample?.diagnostics.tick > 10);
    assert(await NO_HORIZONTAL_SCROLL(TOUCH_PLATFORMER), 'platformer has no horizontal scroll on a phone');
    assert(await TOUCH_PLATFORMER.locator('#pad').isVisible(), 'touch controls are shown on a touch device');
    const PLATFORMER_TOUCH = await TOUCH_CONTEXT.newCDPSession(TOUCH_PLATFORMER);
    const RIGHT = await CENTER(TOUCH_PLATFORMER, '#tr'),
        JUMP = await CENTER(TOUCH_PLATFORMER, '#tj');
    const PLATFORMER_START = await TOUCH_PLATFORMER.evaluate(() => window.pixelPhysicsExample.diagnostics);
    await PLATFORMER_TOUCH.send('Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: [{ ...RIGHT, id: 1 }],
    });
    await TOUCH_PLATFORMER.waitForFunction(
        (tick) => window.pixelPhysicsExample.diagnostics.tick > tick + 40,
        PLATFORMER_START.tick,
    );
    const PLATFORMER_MOVED = await TOUCH_PLATFORMER.evaluate(() => window.pixelPhysicsExample.diagnostics);
    assert(PLATFORMER_MOVED.player.x > PLATFORMER_START.player.x + 3, 'touch right button moves the player');
    // 이동을 누른 채 점프를 함께 누릅니다(멀티터치).
    await PLATFORMER_TOUCH.send('Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: [
            { ...RIGHT, id: 1 },
            { ...JUMP, id: 2 },
        ],
    });
    await TOUCH_PLATFORMER.waitForFunction(
        (y) => window.pixelPhysicsExample.diagnostics.player.y < y - 6,
        PLATFORMER_MOVED.player.y,
    );
    await PLATFORMER_TOUCH.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await TOUCH_PLATFORMER.waitForFunction(
        () => ![...document.querySelectorAll('#pad button')].some((button) => button.classList.contains('down')),
    );
    REPORT.scenarios.push('platformer works by touch emulation: move and multi-touch jump, buttons release');
    await TOUCH_PLATFORMER.close();

    // 소환수 전투 시험판: 소환 버튼, 흙 놓기/분사 도구 전환, 캔버스 터치 조준을 터치만으로 확인합니다.
    const TOUCH_SUMMON = await TOUCH_CONTEXT.newPage();
    TOUCH_SUMMON.on('pageerror', (error) => ERRORS.push(error.message));
    await TOUCH_SUMMON.route('**/*', TOUCH_ROUTE);
    await TOUCH_SUMMON.goto(`http://127.0.0.1:${SERVER.address().port}/modules/pixel-physics/examples/summon.html`);
    await TOUCH_SUMMON.waitForFunction(() => window.summonExample?.diagnostics.tick > 10);
    assert(await NO_HORIZONTAL_SCROLL(TOUCH_SUMMON), 'summon has no horizontal scroll on a phone');
    const SUMMON_TOUCH = await TOUCH_CONTEXT.newCDPSession(TOUCH_SUMMON);
    const GOLEM = await CENTER(TOUCH_SUMMON, '#summons button:nth-child(4)');
    await SUMMON_TOUCH.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...GOLEM, id: 1 }] });
    await SUMMON_TOUCH.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await TOUCH_SUMMON.waitForFunction(() => window.summonExample.diagnostics.allies >= 1);
    // 흙 도구: 누르고 있는 동안 포인터에 흙 셀 덩어리를 붙잡고, 놓으면 모래처럼 떨어져 지형 셀이 됩니다.
    const SUMMON_CANVAS = await TOUCH_SUMMON.locator('#c').boundingBox();
    const AIM = {
        x: SUMMON_CANVAS.x + SUMMON_CANVAS.width * (14 / 160),
        y: SUMMON_CANVAS.y + SUMMON_CANVAS.height * (44 / 80),
    };
    const TAP = async (selector) => {
        await SUMMON_TOUCH.send('Input.dispatchTouchEvent', {
            type: 'touchStart',
            touchPoints: [{ ...(await CENTER(TOUCH_SUMMON, selector)), id: 1 }],
        });
        await SUMMON_TOUCH.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    };
    await TAP('#toolSoil');
    await SUMMON_TOUCH.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...AIM, id: 1 }] });
    await TOUCH_SUMMON.waitForFunction(() => window.summonExample.diagnostics.blob >= 6);
    await SUMMON_TOUCH.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await TOUCH_SUMMON.waitForFunction(() => window.summonExample.diagnostics.blob === 0);
    const SOIL_RELEASED = await TOUCH_SUMMON.evaluate(() => window.summonExample.diagnostics);
    assert(SOIL_RELEASED.dirt >= 6 && SOIL_RELEASED.throws === 0, 'released soil stays as sand cells');
    // 던지기 도구: 끌어모았다 놓으면 덩어리가 발사체로 바뀌어 날아갑니다.
    await TAP('#toolThrow');
    await SUMMON_TOUCH.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...AIM, id: 1 }] });
    await TOUCH_SUMMON.waitForFunction(() => window.summonExample.diagnostics.blob >= 6);
    await SUMMON_TOUCH.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await TOUCH_SUMMON.waitForFunction(() => window.summonExample.diagnostics.throws === 1);
    // 분사 도구로 바꿔 누르고 있으면 연료가 줄어 듭니다.
    await TAP('#toolJet');
    await SUMMON_TOUCH.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...AIM, id: 1 }] });
    await TOUCH_SUMMON.waitForFunction(() => window.summonExample.diagnostics.fuel < 80);
    await SUMMON_TOUCH.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    REPORT.scenarios.push(
        'summon works by touch emulation: summon button, soil tool holds and drops a sand clump, throw tool flings it, jet tool burns fuel',
    );
    await TOUCH_SUMMON.close();
    await TOUCH_CONTEXT.close();

    // htmlpreview.github.io recreates inline scripts as classic scripts, so a module script or static import cannot run there.
    for (const NAME of ['pixel-physics', 'pixel-physics-open-world', 'pixel-physics-summon']) {
        const PREVIEW_HTML = await readFile(resolve(ROOT, `dist/previews/${NAME}.html`), 'utf8');
        for (const [, ATTRIBUTES, BODY] of PREVIEW_HTML.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
            assert(!/\btype\s*=/i.test(ATTRIBUTES) && !/^\s*(?:import|export)\b/m.test(BODY));
        }
    }
    REPORT.scenarios.push('preview HTML has only classic inline scripts');

    // A local preview still loads Matter from the web; its engine is not embedded.
    const PREVIEW = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true });
    PREVIEW.on('pageerror', (error) => ERRORS.push(error.message));
    await PREVIEW.route('**/*', (route) =>
        route.request().url().startsWith('file:') || route.request().url() === MATTER_URL
            ? route.continue()
            : route.abort(),
    );
    await PREVIEW.goto(pathToFileURL(resolve(ROOT, 'dist/previews/pixel-physics.html')).href);
    await PREVIEW.waitForFunction(() => window.pixelPhysicsExample?.diagnostics.tick > 10);
    assert(await PREVIEW.locator('#c').isVisible());
    await PREVIEW.click('#dbg');
    await PREVIEW.screenshot({ path: resolve(ROOT, 'test-results/pixel-physics-mobile.png'), fullPage: true });
    REPORT.scenarios.push('file HTML loads external Matter at mobile viewport');
    assert.deepEqual(ERRORS, []);
    const BLOCKED = await browser.newPage();
    let blockedMatter = false;
    await BLOCKED.route('**/*', (route) => {
        if (route.request().url() === MATTER_URL) {
            blockedMatter = true;
            return route.abort();
        }
        return route.request().url().startsWith('file:') ? route.continue() : route.abort();
    });
    await BLOCKED.goto(pathToFileURL(resolve(ROOT, 'dist/previews/pixel-physics.html')).href);
    assert(blockedMatter);
    assert(await BLOCKED.evaluate(() => window.pixelPhysicsExample === undefined));
    REPORT.scenarios.push('blocked Matter web URL prevents startup with no embedded fallback');
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

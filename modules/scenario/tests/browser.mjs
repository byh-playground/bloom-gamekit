/* global scenarioDemo */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import assert from 'node:assert/strict';
import { navigationFlow } from '../../navigation/tests/browser.mjs';
const SERVER = createServer(async (req, res) => {
    try {
        const PATH = new URL(req.url, 'http://localhost').pathname;
        if (PATH === '/scenario-frame-slow') {
            res.setHeader('Content-Type', 'text/html');
            setTimeout(() => res.end('<p>ready</p>'), 300);
            return;
        }
        if (PATH === '/scenario-frame-ready') {
            res.setHeader('Content-Type', 'text/html');
            res.end('<script>parent.postMessage("scenario-frame-ready",location.origin)</script>');
            return;
        }
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
    // An embedded game reports readiness by message, and a closed player cancels preparation.
    const EMBEDDED = await PAGE.evaluate(async () => {
        const { mountScenarioFrame: MOUNT, createScenario: CREATE } = await import('/modules/scenario/index.js');
        const HOST = document.createElement('div');
        document.body.append(HOST);
        const FRAME = MOUNT({
            container: HOST,
            src: '/scenario-frame-ready',
            prepare({ frame, signal }) {
                return new Promise((resolve) => {
                    window.addEventListener(
                        'message',
                        (event) => {
                            if (
                                event.origin === location.origin &&
                                event.source === frame.contentWindow &&
                                event.data === 'scenario-frame-ready'
                            ) {
                                resolve();
                            }
                        },
                        { signal },
                    );
                });
            },
        });
        const READY = await FRAME.ready;
        FRAME.dispose();
        let loadedAfterReady;
        const EARLY = MOUNT({
            container: HOST,
            src: '/scenario-frame-slow',
            prepare({ loaded }) {
                loadedAfterReady = loaded;
            },
        });
        const EARLY_READY = await EARLY.ready;
        const LATE_LOAD = await loadedAfterReady;
        EARLY.dispose();
        let cancelledLoad;
        const EARLY_CANCEL = MOUNT({
            container: HOST,
            src: '/scenario-frame-slow',
            prepare({ loaded }) {
                cancelledLoad = loaded;
            },
        });
        await EARLY_CANCEL.ready;
        EARLY_CANCEL.dispose();
        const LOAD_CANCELLED = await cancelledLoad;
        const POST_LOAD = MOUNT({
            container: HOST,
            src: '/scenario-frame-slow',
            timeoutMs: 200,
            timeoutAfterLoad: true,
            async prepare({ loaded }) {
                await loaded;
                await new Promise((resolve) => setTimeout(resolve, 30));
            },
        });
        const POST_LOAD_READY = await POST_LOAD.ready;
        POST_LOAD.dispose();
        const CANCEL = MOUNT({ container: HOST, src: '/scenario-frame-ready', prepare: () => new Promise(() => {}) });
        CANCEL.dispose();
        const CANCELLED = await CANCEL.ready;
        let timeout = false;
        const STUCK = MOUNT({
            container: HOST,
            src: '/scenario-frame-ready',
            timeoutMs: 50,
            prepare: () => new Promise(() => {}),
        });
        try {
            await STUCK.ready;
        } catch (error) {
            timeout = error.message === 'scenario frame readiness timed out';
        }
        let allow = false,
            steps = 0,
            renders = 0;
        const SCENARIO = CREATE({
            definition: { tickRate: 100, endTick: 100 },
            canAdvance: () => allow,
            createRun: () => ({
                step() {
                    steps++;
                },
                render() {
                    renders++;
                },
                dispose() {},
            }),
        });
        SCENARIO.play({ automatic: false });
        const HELD = SCENARIO.step();
        allow = true;
        const ADVANCED = SCENARIO.step();
        allow = false;
        SCENARIO.pulse(0);
        SCENARIO.pulse(100);
        const TICK_WHILE_HELD = SCENARIO.snapshot().tick;
        allow = true;
        SCENARIO.pulse(110);
        const TICK_AFTER_RESUME = SCENARIO.snapshot().tick;
        SCENARIO.dispose();
        const LEFT = HOST.querySelectorAll('iframe').length;
        HOST.remove();
        return {
            ready: READY,
            earlyReady: EARLY_READY,
            lateLoad: LATE_LOAD,
            loadCancelled: LOAD_CANCELLED,
            postLoadReady: POST_LOAD_READY,
            cancelled: CANCELLED,
            timeout,
            held: HELD.status,
            advanced: ADVANCED.status,
            tickWhileHeld: TICK_WHILE_HELD,
            tickAfterResume: TICK_AFTER_RESUME,
            steps,
            renders,
            left: LEFT,
        };
    });
    assert.deepEqual(EMBEDDED, {
        ready: true,
        earlyReady: true,
        lateLoad: true,
        loadCancelled: false,
        postLoadReady: true,
        cancelled: false,
        timeout: true,
        held: 'held',
        advanced: 'advanced',
        tickWhileHeld: 1,
        tickAfterResume: 2,
        steps: 2,
        renders: 3,
        left: 0,
    });
    // Live introductions must fill the viewport, not a centered preview card.
    await PAGE.evaluate(async () => {
        const { installShowcase: INSTALL_SHOWCASE } = await import('/modules/scenario/index.js');
        window.showcaseLayoutTest = INSTALL_SHOWCASE({
            title: '시연 게임',
            locale: 'en',
            launcher: '#play',
            playSelector: '#play',
            durationMs: 1500,
            ready: () => true,
            timeline: [{ atMs: 0, action: 'chapter', title: '전체 화면 소개' }],
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
        const BOXES = await PAGE.evaluate(() => {
            const ROOT = document.querySelector('#bloom-showcase');
            const SELECTORS = [
                '.bloom-showcase-stage',
                '[data-action=close]',
                '[data-action=play]',
                '[data-action=replay]',
            ];
            return SELECTORS.map((selector) => {
                const BOUNDS = ROOT.querySelector(selector).getBoundingClientRect();
                return [BOUNDS.left, BOUNDS.top, BOUNDS.right, BOUNDS.bottom];
            });
        });
        assert.deepEqual(BOXES[0], [0, 0, VIEW.width, VIEW.height]);
        for (const BOUNDS of BOXES.slice(1)) {
            assert.ok(BOUNDS[0] >= 0 && BOUNDS[2] <= VIEW.width + 1);
            assert.ok(BOUNDS[1] >= 0 && BOUNDS[3] <= VIEW.height + 1);
        }
    }
    // The host's own controls follow the locale option, and the isolated demo is told the same language.
    const COPY = await PAGE.evaluate(() => ({
        close: document.querySelector('#bloom-showcase [data-action=close]').textContent,
        play: document.querySelector('#bloom-showcase [data-action=play]').textContent,
        lang: new URL(document.querySelector('#bloom-showcase iframe').src).searchParams.get('lang'),
    }));
    assert.deepEqual(COPY, { close: 'Close', play: 'Play now', lang: 'en' });
    const REJECTED = await PAGE.evaluate(async () => {
        const { installShowcase: INSTALL_SHOWCASE } = await import('/modules/scenario/index.js');
        try {
            INSTALL_SHOWCASE({ title: '시연 게임', locale: 'fr', launcher: '#play', timeline: [] });
            return false;
        } catch (error) {
            return error instanceof TypeError;
        }
    });
    assert.equal(REJECTED, true);
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

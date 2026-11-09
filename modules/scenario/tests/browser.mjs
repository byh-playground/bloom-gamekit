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
    // A card switch reuses the same prepared WebGL surface and cancels the prior scene.
    const REUSED = await PAGE.evaluate(async () => {
        const { createScenarioSurface: CREATE_SURFACE } = await import('/modules/scenario/index.js');
        const FIRST_HOST = document.createElement('div');
        const SECOND_HOST = document.createElement('div');
        document.body.append(FIRST_HOST, SECOND_HOST);
        let created = 0;
        let surfaceDisposals = 0;
        let element;
        let finishSlow;
        let slowSignal;
        let openOnAbort;
        let preparedAfterAttach = true;
        const CALLS = [];
        const ERROR = new Error('scene preparation failed');
        const HOST = CREATE_SURFACE({
            createSurface() {
                created++;
                element = document.createElement('canvas');
                const GL = element.getContext('webgl2');
                if (!GL) {
                    throw new Error('WebGL2 unavailable');
                }
                const TEXTURE = GL.createTexture();
                GL.bindTexture(GL.TEXTURE_2D, TEXTURE);
                return {
                    element,
                    gl: GL,
                    texture: TEXTURE,
                    dispose() {
                        surfaceDisposals++;
                        GL.deleteTexture(TEXTURE);
                    },
                };
            },
            prepare({ surface, scene, signal, present }) {
                preparedAfterAttach &&= surface.element.parentElement === scene.container;
                if (scene.name === 'failed') {
                    throw ERROR;
                }
                if (scene.name === 'next') {
                    signal.addEventListener('abort', () => openOnAbort?.(), { once: true });
                }
                const RUN = {
                    play() {
                        CALLS.push(`play:${scene.name}`);
                        if (!surface.gl.isTexture(surface.texture)) {
                            throw new Error('prepared texture was released during switch');
                        }
                        surface.gl.clearColor(0, 1, 0, 1);
                        surface.gl.clear(surface.gl.COLOR_BUFFER_BIT);
                        present();
                    },
                    pause() {
                        CALLS.push(`pause:${scene.name}`);
                    },
                    dispose() {
                        CALLS.push(`dispose:${scene.name}`);
                    },
                };
                if (scene.name === 'slow') {
                    slowSignal = signal;
                    return new Promise((resolve) => {
                        finishSlow = () => resolve(RUN);
                    });
                }
                return RUN;
            },
        });
        const MOUNT = (container, name, active = false) =>
            HOST.mount({
                container,
                scene: { container, name },
                active,
            });

        const FIRST = MOUNT(FIRST_HOST, 'first');
        FIRST.setActive(true);
        const FIRST_READY = await FIRST.ready;
        FIRST.setActive(true);
        FIRST.setActive(false);
        FIRST.setActive(false);
        const ORIGINAL = FIRST_HOST.querySelector('canvas');
        const SLOW = MOUNT(FIRST_HOST, 'slow', true);
        await Promise.resolve();
        const NEXT = MOUNT(SECOND_HOST, 'next', true);
        const SLOW_READY = await SLOW.ready;
        const NEXT_READY = await NEXT.ready;
        finishSlow();
        await Promise.resolve();
        const REUSED_ELEMENT = ORIGINAL === SECOND_HOST.querySelector('canvas');
        SLOW.dispose();

        let newest;
        openOnAbort = () => {
            newest = MOUNT(SECOND_HOST, 'newest', true);
        };
        const REPLACED = MOUNT(FIRST_HOST, 'replaced', true);
        const REPLACED_READY = await REPLACED.ready;
        const NEWEST_READY = await newest.ready;
        const ATTACHED_TO_NEWEST = ORIGINAL === SECOND_HOST.querySelector('canvas');

        const FAILED = MOUNT(FIRST_HOST, 'failed', true);
        let sameError = false;
        try {
            await FAILED.ready;
        } catch (error) {
            sameError = error === ERROR;
        }
        const DETACHED_AFTER_ERROR = !element.isConnected;
        const FINAL = MOUNT(SECOND_HOST, 'final', true);
        const FINAL_READY = await FINAL.ready;
        HOST.dispose();
        HOST.dispose();
        const DETACHED_AFTER_CLOSE = !element.isConnected;
        FIRST_HOST.remove();
        SECOND_HOST.remove();

        return {
            created,
            surfaceDisposals,
            preparedAfterAttach,
            calls: CALLS,
            firstReady: FIRST_READY,
            firstPresented: await FIRST.presented,
            slowReady: SLOW_READY,
            slowAborted: slowSignal.aborted,
            nextReady: NEXT_READY,
            reusedElement: REUSED_ELEMENT,
            replacedReady: REPLACED_READY,
            newestReady: NEWEST_READY,
            attachedToNewest: ATTACHED_TO_NEWEST,
            sameError,
            detachedAfterError: DETACHED_AFTER_ERROR,
            finalReady: FINAL_READY,
            detachedAfterClose: DETACHED_AFTER_CLOSE,
        };
    });
    assert.deepEqual(REUSED, {
        created: 1,
        surfaceDisposals: 1,
        preparedAfterAttach: true,
        calls: [
            'play:first',
            'pause:first',
            'dispose:first',
            'play:next',
            'dispose:slow',
            'dispose:next',
            'play:newest',
            'dispose:newest',
            'play:final',
            'dispose:final',
        ],
        firstReady: true,
        firstPresented: true,
        slowReady: false,
        slowAborted: true,
        nextReady: true,
        reusedElement: true,
        replacedReady: false,
        newestReady: true,
        attachedToNewest: true,
        sameError: true,
        detachedAfterError: true,
        finalReady: true,
        detachedAfterClose: true,
    });
    const FIRST_FRAME = await PAGE.evaluate(async () => {
        const { createScenarioSurface: CREATE_SURFACE } = await import('/modules/scenario/index.js');
        const CONTAINER = document.createElement('div');
        document.body.append(CONTAINER);
        const CANVAS = document.createElement('canvas');
        CANVAS.style.setProperty('visibility', 'visible', 'important');
        const GL = CANVAS.getContext('webgl2');
        if (!GL) {
            throw new Error('WebGL2 unavailable');
        }
        const SIGNALS = new Map();
        const ERROR = new Error('scene play failed');
        let finish;
        const HOST = CREATE_SURFACE({
            createSurface: () => ({ element: CANVAS }),
            prepare({ scene, present }) {
                SIGNALS.set(scene, present);
                const RUN = {
                    play() {
                        if (scene === 'failed') {
                            present();
                            throw ERROR;
                        }
                    },
                    pause() {},
                    dispose() {},
                };
                if (scene === 'canceled') {
                    present();
                    return new Promise((resolve) => {
                        finish = () => resolve(RUN);
                    });
                }
                return RUN;
            },
        });
        const HIDDEN = () => getComputedStyle(CANVAS).visibility === 'hidden';
        const CANCELED = HOST.mount({ container: CONTAINER, scene: 'canceled', active: true });
        await Promise.resolve();
        const HIDDEN_DURING_PREPARE = HIDDEN() && CANVAS.getBoundingClientRect().width > 0;
        const LIVE = HOST.mount({ container: CONTAINER, scene: 'live', active: true });
        const CANCELED_PRESENTED = await CANCELED.presented;
        const LIVE_READY = await LIVE.ready;
        finish();
        SIGNALS.get('canceled')();
        const HIDDEN_WHEN_READY = HIDDEN();
        const PIXEL = new Uint8Array(4);
        await new Promise((resolve) => {
            requestAnimationFrame(() => {
                GL.clearColor(0, 1, 0, 1);
                GL.clear(GL.COLOR_BUFFER_BIT);
                GL.readPixels(0, 0, 1, 1, GL.RGBA, GL.UNSIGNED_BYTE, PIXEL);
                SIGNALS.get('live')();
                resolve();
            });
        });
        const LIVE_PRESENTED = await LIVE.presented;
        LIVE.setActive(false);
        const VISIBLE_WHILE_PAUSED = !HIDDEN() && CANVAS.style.getPropertyPriority('visibility') === 'important';
        const CLOSED = HOST.mount({ container: CONTAINER, scene: 'closed', active: true });
        await CLOSED.ready;
        SIGNALS.get('live')();
        const HIDDEN_AFTER_SWITCH = HIDDEN();
        CLOSED.dispose();
        SIGNALS.get('closed')();
        const CLOSED_PRESENTED = await CLOSED.presented;
        const RESTORED_AFTER_CLOSE = !CANVAS.isConnected && CANVAS.style.visibility === 'visible';
        const FAILED = HOST.mount({ container: CONTAINER, scene: 'failed', active: true });
        let playError = false;
        try {
            await FAILED.ready;
        } catch (error) {
            playError = error === ERROR;
        }
        const FAILED_PRESENTED = await FAILED.presented;
        HOST.dispose();
        CONTAINER.remove();
        return {
            hiddenDuringPrepare: HIDDEN_DURING_PREPARE,
            canceledPresented: CANCELED_PRESENTED,
            liveReady: LIVE_READY,
            hiddenWhenReady: HIDDEN_WHEN_READY,
            pixel: [...PIXEL],
            livePresented: LIVE_PRESENTED,
            visibleWhilePaused: VISIBLE_WHILE_PAUSED,
            hiddenAfterSwitch: HIDDEN_AFTER_SWITCH,
            closedPresented: CLOSED_PRESENTED,
            restoredAfterClose: RESTORED_AFTER_CLOSE,
            playError,
            failedPresented: FAILED_PRESENTED,
        };
    });
    assert.deepEqual(FIRST_FRAME, {
        hiddenDuringPrepare: true,
        canceledPresented: false,
        liveReady: true,
        hiddenWhenReady: true,
        pixel: [0, 255, 0, 255],
        livePresented: true,
        visibleWhilePaused: true,
        hiddenAfterSwitch: true,
        closedPresented: false,
        restoredAfterClose: true,
        playError: true,
        failedPresented: false,
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

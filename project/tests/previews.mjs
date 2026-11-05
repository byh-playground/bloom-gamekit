/* global audioExample, demo, reference, scenarioDemo, renderingExamples */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { EXAMPLES, buildPreviews, previewURL } from '../previews.mjs';
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const PUBLIC_MODE = process.argv.includes('--public');
const NAMES = new Set(EXAMPLES.map(([name]) => name));
let server;
let browser;
const REPORT = {
    mode: PUBLIC_MODE ? 'public-htmlpreview' : 'local-html',
    examples: [],
};
try {
    if (!PUBLIC_MODE) {
        await buildPreviews(ROOT);
        server = createServer(async (req, res) => {
            const NAME = new URL(req.url, 'http://localhost').pathname.slice(1).replace(/\.html$/, '');
            if (!NAMES.has(NAME)) {
                res.writeHead(404).end();
                return;
            }
            res.setHeader('Content-Type', 'text/html; charset=utf-8');
            res.end(await readFile(resolve(ROOT, 'dist/previews', `${NAME}.html`)));
        });
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    }
    browser = await chromium.launch({
        headless: true,
        ...(process.env.CHROMIUM_EXECUTABLE_PATH
            ? {
                  executablePath: process.env.CHROMIUM_EXECUTABLE_PATH,
              }
            : {}),
        args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
    });
    for (const [NAME] of EXAMPLES) {
        const PAGE = await browser.newPage();
        const ERRORS = [];
        PAGE.on('pageerror', (error) => ERRORS.push(error.message));
        const URL_LOCAL = PUBLIC_MODE ? previewURL(NAME) : `http://127.0.0.1:${server.address().port}/${NAME}.html`;
        await PAGE.goto(URL_LOCAL, {
            waitUntil: 'domcontentloaded',
            timeout: 45000,
        });
        await PAGE.waitForFunction(
            (name) => {
                const GLOBALS = {
                    interpolation: 'demo',
                    'interpolation-frame': 'frameDemo',
                    'simloop-input-preview': 'inputPreviewDemo',
                    audio: 'audioExample',
                    navigation: 'navigationDemo',
                    'tech-tree': 'techTreeDemo',
                    rendering: 'renderingExamples',
                    'vector-assets': 'vectorAssetDemo',
                    'vector-raster-comparison': '__rasterComparison',
                    'rollback-reference': 'reference',
                    scenario: 'scenarioDemo',
                    'pixel-physics': 'pixelPhysicsExample',
                    'pixel-physics-open-world': 'openWorldExample',
                    'pixel-physics-side-battle': 'sideBattle',
                    bm: 'bmExample',
                };
                if (name === 'work-scheduler') {
                    return !!document.querySelector('#output')?.textContent;
                }
                return name === 'rollback-availability'
                    ? typeof document.querySelector('#host')?.onclick === 'function'
                    : !!window[GLOBALS[name]];
            },
            NAME,
            {
                timeout: 25000,
            },
        );
        if (NAME === 'interpolation') {
            await PAGE.waitForFunction(() => demo.diagnostics.frames > 5);
        }
        if (NAME === 'vector-raster-comparison') {
            await PAGE.waitForFunction(() => globalThis.__rasterComparison.ready);
            assert.equal(await PAGE.evaluate(() => globalThis.__rasterComparison.error), null);
            assert.equal(await PAGE.evaluate(() => globalThis.__rasterComparison.snapshot.count), 1);
        }
        if (NAME === 'work-scheduler') {
            await PAGE.click('#tick');
            assert.equal(await PAGE.locator('#output').evaluate((output) => JSON.parse(output.textContent).tick), 1);
            // 행동 탭: 멀리 있는 적에게는 돌진을 고르고, 그 공격이 예열 → 발동 → 회복으로 진행합니다.
            await PAGE.click('#tab-behavior');
            await PAGE.click('#behavior-far');
            const BEHAVIOR = () =>
                PAGE.locator('#behavior-output').evaluate((output) => JSON.parse(output.textContent));
            await PAGE.click('#behavior-tick');
            assert.deepEqual((await BEHAVIOR()).attack, { id: 'charge', phase: 'windup' });
            await PAGE.click('#behavior-tick');
            await PAGE.click('#behavior-tick');
            assert.equal((await BEHAVIOR()).attack.phase, 'recover');
            await PAGE.click('#behavior-near');
            assert.equal((await BEHAVIOR()).decided, 'continue attack');
            // 기하 탭: 벽 앞에서 멈춤·사영·조정이 서로 다른 끝 자리를 냅니다(마우스 누르기, 화살표 키, 방식 선택, 이동 적용).
            await PAGE.click('#tab-geometry');
            const GEOMETRY = () =>
                PAGE.locator('#geometry-output').evaluate((output) => JSON.parse(output.textContent));
            const CANVAS_BOX = await PAGE.locator('#geometry-canvas').boundingBox();
            const AT = (box, x, y) => [box.x + (x / 480) * box.width, box.y + (y / 320) * box.height];
            await PAGE.mouse.click(...AT(CANVAS_BOX, 440, 200));
            const CLICKED = (await GEOMETRY()).target;
            assert.ok(
                Math.abs(CLICKED.x - 440) <= 2 && Math.abs(CLICKED.y - 200) <= 2,
                'pointer target ' + JSON.stringify(CLICKED),
            );
            await PAGE.evaluate(() => globalThis.geometryExample.setTarget(440, 200));
            const WALL_EDGE = 'wall:3:edge';
            assert.deepEqual((await GEOMETRY()).results, {
                stop: { x: 188, y: 174.8, hit: WALL_EDGE },
                project: { x: 188, y: 200, hit: WALL_EDGE },
                steer: { x: 308.06, y: 308, hit: WALL_EDGE },
            });
            await PAGE.keyboard.press('ArrowLeft');
            assert.deepEqual((await GEOMETRY()).target, { x: 430, y: 200 });
            await PAGE.evaluate(() => globalThis.geometryExample.setTarget(440, 200));
            await PAGE.click('#geometry-mode-stop');
            await PAGE.click('#geometry-apply');
            assert.deepEqual((await GEOMETRY()).mover, { x: 188, y: 174.8 });
            await PAGE.click('#geometry-reset');
            assert.deepEqual((await GEOMETRY()).mover, { x: 40, y: 160 });
            // 거리장 탭: 목표까지 곧장 가는 선이 막혀도 벽을 돌아 내려가는 칸이 나오고, 걸음마다 비용이 줄어 도착합니다.
            await PAGE.click('#tab-pathfield');
            const PATHFIELD = () =>
                PAGE.locator('#pathfield-output').evaluate((output) => JSON.parse(output.textContent));
            const PATHFIELD_BOX = await PAGE.locator('#pathfield-canvas').boundingBox();
            await PAGE.mouse.click(...AT(PATHFIELD_BOX, 440, 200));
            const AIMED = await PATHFIELD();
            assert.ok(Math.abs(AIMED.goal.x - 440) <= 2 && Math.abs(AIMED.goal.y - 200) <= 2, 'pointer goal');
            await PAGE.evaluate(() => globalThis.pathfieldExample.setGoal(440, 200));
            const LAZY = await PATHFIELD();
            assert.equal(LAZY.straightRayClear, false, '곧장 가는 선은 벽에 막힘');
            assert.equal(LAZY.cost, 348);
            assert.deepEqual(LAZY.path, ['3,11', '4,12', '5,13', '6,14', '7,14', '8,14', '9,14', '10,14']);
            assert.ok(LAZY.settledCells < LAZY.openCells, '유닛 칸까지만 퍼뜨림');
            await PAGE.click('#pathfield-full');
            const FULL = await PATHFIELD();
            assert.equal(FULL.settledCells, FULL.openCells, '전부 계산하면 열린 칸 모두 닿음');
            assert.equal(FULL.cost, LAZY.cost, '게으르게 구한 비용과 같음');
            await PAGE.click('#pathfield-full');
            await PAGE.locator('#pathfield-canvas').focus();
            await PAGE.keyboard.press('ArrowLeft');
            assert.deepEqual((await PATHFIELD()).goal, { x: 424, y: 200 });
            await PAGE.evaluate(() => globalThis.pathfieldExample.setGoal(440, 200));
            let previousCost = LAZY.cost,
                walked = 0;
            for (; previousCost > 0 && walked < 12; walked++) {
                await PAGE.click('#pathfield-step');
                const AFTER = (await PATHFIELD()).cost;
                assert.ok(AFTER < previousCost, '걸음마다 목표에 가까워짐');
                previousCost = AFTER;
            }
            assert.equal(previousCost, 0, '걸어서 목표에 도착');
            assert.equal(walked, 6);
            await PAGE.click('#pathfield-reset');
            assert.deepEqual((await PATHFIELD()).unit, { x: 40, y: 160 });
            // 터치 에뮬레이션(실제 기기 검증이 아님): 좁은 화면에서 가로 스크롤 없이 첫 화면 안에서 캔버스를 눌러 목표를 정합니다.
            const TOUCH_CONTEXT = await browser.newContext({
                hasTouch: true,
                isMobile: true,
                viewport: { width: 390, height: 844 },
            });
            try {
                const TOUCH_PAGE = await TOUCH_CONTEXT.newPage();
                await TOUCH_PAGE.goto(URL_LOCAL + '#tab=geometry', { waitUntil: 'domcontentloaded', timeout: 45000 });
                await TOUCH_PAGE.waitForFunction(() => !!globalThis.geometryExample);
                const TOUCH_BOX = await TOUCH_PAGE.locator('#geometry-canvas').boundingBox();
                assert.ok(TOUCH_BOX.x >= 0 && TOUCH_BOX.x + TOUCH_BOX.width <= 390, 'canvas fits the width');
                assert.ok(TOUCH_BOX.y + TOUCH_BOX.height <= 844, 'canvas is inside the first screen');
                assert.ok(
                    await TOUCH_PAGE.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
                    'no horizontal scroll',
                );
                assert.ok(
                    await TOUCH_PAGE.locator('#panel-geometry button').evaluateAll((buttons) =>
                        buttons.every((button) => button.getBoundingClientRect().height >= 56),
                    ),
                    'touch buttons are at least 56px tall',
                );
                await TOUCH_PAGE.touchscreen.tap(...AT(TOUCH_BOX, 440, 200));
                const TAPPED = await TOUCH_PAGE.locator('#geometry-output').evaluate((output) =>
                    JSON.parse(output.textContent),
                );
                assert.ok(
                    Math.abs(TAPPED.target.x - 440) <= 2 && Math.abs(TAPPED.target.y - 200) <= 2,
                    'tap target ' + JSON.stringify(TAPPED.target),
                );
                assert.equal(TAPPED.results.stop.hit, WALL_EDGE);
                const TOUCH_PATHFIELD = await TOUCH_CONTEXT.newPage();
                await TOUCH_PATHFIELD.goto(URL_LOCAL + '#tab=pathfield', {
                    waitUntil: 'domcontentloaded',
                    timeout: 45000,
                });
                await TOUCH_PATHFIELD.waitForFunction(() => !!globalThis.pathfieldExample);
                const PATH_TOUCH_BOX = await TOUCH_PATHFIELD.locator('#pathfield-canvas').boundingBox();
                assert.ok(
                    PATH_TOUCH_BOX.y + PATH_TOUCH_BOX.height <= 844,
                    'pathfield canvas is inside the first screen',
                );
                assert.ok(
                    await TOUCH_PATHFIELD.locator('#panel-pathfield button').evaluateAll((buttons) =>
                        buttons.every((button) => button.getBoundingClientRect().height >= 56),
                    ),
                    'pathfield buttons are at least 56px tall',
                );
                assert.ok(
                    await TOUCH_PATHFIELD.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
                    'no horizontal scroll',
                );
                await TOUCH_PATHFIELD.touchscreen.tap(...AT(PATH_TOUCH_BOX, 100, 60));
                const TAPPED_GOAL = (
                    await TOUCH_PATHFIELD.locator('#pathfield-output').evaluate((output) =>
                        JSON.parse(output.textContent),
                    )
                ).goal;
                assert.ok(Math.abs(TAPPED_GOAL.x - 100) <= 2 && Math.abs(TAPPED_GOAL.y - 60) <= 2, 'tap goal');
            } finally {
                await TOUCH_CONTEXT.close();
            }
        }
        if (NAME === 'bm') {
            // 실제 광고 호출 없이 계약만 확인합니다: 광고 스크립트는 막고 adBreak와 google.ima를 가짜로 둡니다.
            const READ = (page) => page.locator('#output').evaluate((output) => JSON.parse(output.textContent));
            const FAKE_ADS = () => {
                globalThis.adConfig = (options) => options.onReady?.();
                globalThis.adBreak = (options) => {
                    if (options.type === 'reward') {
                        options.beforeReward(() => {
                            options.beforeAd();
                            options.adViewed();
                            options.adBreakDone({ breakStatus: 'viewed' });
                        });
                    } else {
                        options.beforeAd();
                        options.adBreakDone({ breakStatus: 'viewed' });
                    }
                };
                const MANAGER = {
                    listeners: {},
                    addEventListener(type, listener) {
                        (this.listeners[type] ??= []).push(listener);
                    },
                    emit(type) {
                        (this.listeners[type] ?? []).forEach((listener) => listener({}));
                    },
                    init() {},
                    resize() {},
                    destroy() {},
                    start() {
                        if (globalThis.__imaMode === 'noad') {
                            this.emit('all');
                            return;
                        }
                        this.emit('started');
                        this.emit(globalThis.__imaMode === 'skip' ? 'skipped' : 'complete');
                    },
                };
                globalThis.__imaMode = 'complete';
                globalThis.google = {
                    ima: {
                        AdDisplayContainer: class {
                            initialize() {}
                        },
                        AdsLoader: class {
                            constructor() {
                                this.listeners = {};
                            }
                            addEventListener(type, listener) {
                                (this.listeners[type] ??= []).push(listener);
                            }
                            requestAds(request) {
                                globalThis.__imaTag = request.adTagUrl;
                                queueMicrotask(() =>
                                    (this.listeners.loaded ?? []).forEach((listener) =>
                                        listener({ getAdsManager: () => MANAGER }),
                                    ),
                                );
                            }
                        },
                        AdsRequest: class {},
                        AdsManagerLoadedEvent: { Type: { ADS_MANAGER_LOADED: 'loaded' } },
                        AdErrorEvent: { Type: { AD_ERROR: 'adError' } },
                        AdEvent: {
                            Type: {
                                STARTED: 'started',
                                COMPLETE: 'complete',
                                SKIPPED: 'skipped',
                                USER_CLOSE: 'close',
                                ALL_ADS_COMPLETED: 'all',
                            },
                        },
                    },
                };
            };
            for (const TOUCH of [false, true]) {
                const CONTEXT = await browser.newContext(
                    TOUCH ? { hasTouch: true, isMobile: true, viewport: { width: 375, height: 812 } } : {},
                );
                await CONTEXT.route('https://pagead2.googlesyndication.com/**', (route) => route.fulfill({ body: '' }));
                const BM_PAGE = await CONTEXT.newPage();
                await BM_PAGE.addInitScript(FAKE_ADS);
                await BM_PAGE.goto(URL_LOCAL, { waitUntil: 'domcontentloaded', timeout: 45000 });
                await BM_PAGE.waitForFunction(() => !!window.bmExample);
                const PRESS = (selector) => (TOUCH ? BM_PAGE.tap(selector) : BM_PAGE.click(selector));
                const WAIT_OUTPUT = (check) =>
                    BM_PAGE.waitForFunction(
                        (source) =>
                            new Function('output', `return ${source}`)(
                                JSON.parse(document.querySelector('#output').textContent),
                            ),
                        check,
                    );
                assert.equal(await BM_PAGE.locator('#rewarded').isDisabled(), true);
                // Google H5 경로
                await BM_PAGE.selectOption('#source', 'google');
                await BM_PAGE.fill('#publisher', 'not-an-id');
                await PRESS('#connect');
                assert.equal(await BM_PAGE.locator('#rewarded').isDisabled(), true);
                await BM_PAGE.fill('#publisher', 'ca-pub-1234567890');
                await PRESS('#connect');
                await WAIT_OUTPUT('output.sdkReady === true');
                assert.equal(
                    await BM_PAGE.evaluate(() => !!document.querySelector('script[data-adbreak-test="on"]')),
                    true,
                );
                await PRESS('#rewarded');
                await WAIT_OUTPUT('output.rewards === 1');
                await PRESS('#interstitial');
                await WAIT_OUTPUT("output.last?.type === 'interstitial'");
                assert.equal((await READ(BM_PAGE)).shown.interstitial, 1);
                // IMA 경로: 끝까지 보면 보상, 건너뛰면 보상 없음, 광고가 없으면 unavailable, 오버레이는 남지 않음
                await BM_PAGE.selectOption('#source', 'ima-linear');
                await PRESS('#connect');
                await WAIT_OUTPUT('output.sdkReady === true');
                await PRESS('#rewarded');
                await WAIT_OUTPUT('output.rewards === 2');
                assert.match(await BM_PAGE.evaluate(() => globalThis.__imaTag), /single_ad_samples.*correlator=\d+/);
                await BM_PAGE.evaluate(() => (globalThis.__imaMode = 'skip'));
                await PRESS('#rewarded');
                await WAIT_OUTPUT("output.last?.status === 'dismissed'");
                assert.equal((await READ(BM_PAGE)).rewards, 2);
                await BM_PAGE.evaluate(() => (globalThis.__imaMode = 'noad'));
                await PRESS('#rewarded');
                await WAIT_OUTPUT("output.last?.status === 'unavailable'");
                assert.equal(await BM_PAGE.locator('body > div[style*="fixed"]').count(), 0);
                assert.equal(
                    await BM_PAGE.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
                    true,
                );
                if (TOUCH) {
                    // 터치 에뮬레이션은 실제 기기 검증이 아닙니다.
                    assert.equal(
                        await BM_PAGE.locator('#rewarded').evaluate(
                            (button) => button.getBoundingClientRect().height >= 56,
                        ),
                        true,
                    );
                }
                await CONTEXT.close();
            }
        }
        if (NAME === 'interpolation-frame') {
            await PAGE.click('#spawn');
            await PAGE.click('#rollback');
        }
        if (NAME === 'audio') {
            await PAGE.click('#tap');
            await PAGE.click('#confirmed');
            assert.equal(await PAGE.evaluate(() => audioExample.player.snapshot().state), 'running');
        }
        if (NAME === 'navigation') {
            await PAGE.click('#wiki');
            await PAGE.waitForFunction(() => document.querySelector('#screen').textContent.startsWith('wiki/'));
        }
        if (NAME === 'scenario') {
            await PAGE.click('#play');
            await PAGE.waitForFunction(() => scenarioDemo.value > 7);
            await PAGE.click('#stop');
        }
        if (NAME === 'rendering') {
            assert(
                await PAGE.evaluate(
                    () =>
                        renderingExamples.vector.device.stats.drawCalls > 0 &&
                        renderingExamples.vector.device.gl.getError() === 0,
                ),
            );
            await PAGE.click('#tab-atlas');
            await PAGE.waitForFunction(() => Boolean(renderingExamples.atlas));
            assert.equal(await PAGE.evaluate(() => renderingExamples.atlas.drawCalls), 1);
            await PAGE.click('#atlas-mixed');
            assert.equal(await PAGE.evaluate(() => renderingExamples.atlas.drawCalls), 1);
            assert.equal(await PAGE.evaluate(() => renderingExamples.atlas.device.gl.getError()), 0);
            await PAGE.click('#tab-materials');
            await PAGE.waitForFunction(() => Boolean(renderingExamples.materials));
            assert.equal(await PAGE.evaluate(() => renderingExamples.materials.draws), 1);
            await PAGE.click('#tab-paint');
            await PAGE.waitForFunction(() => Boolean(renderingExamples.paint));
            assert.equal(await PAGE.evaluate(() => renderingExamples.paint.device.gl.getError()), 0);
            // 표정 탭: 작은 얼굴 13개는 구운 이미지로, 확대된 선택 얼굴은 경로로 그리고, 표정을 바꿔도 그 구성이 같습니다.
            await PAGE.click('#tab-face');
            await PAGE.waitForFunction(() => Boolean(renderingExamples.face));
            assert.deepEqual(await PAGE.evaluate(() => renderingExamples.face.drawn), { images: 13, paths: 1 });
            await PAGE.click('#face-next');
            assert.equal(await PAGE.evaluate(() => renderingExamples.face.selected), 'happy');
            assert.deepEqual(await PAGE.evaluate(() => renderingExamples.face.drawn), { images: 13, paths: 1 });
            assert.equal(await PAGE.evaluate(() => renderingExamples.face.device.gl.getError()), 0);
        }
        if (NAME === 'rollback-reference') {
            await PAGE.click('#start');
            await PAGE.waitForFunction(
                () => reference.diagnostics.peers.length === 2 && reference.diagnostics.peers.every((p) => p.tick > 5),
                null,
                {
                    timeout: 20000,
                },
            );
            await PAGE.click('[data-player="a"][data-command="2"]');
            await PAGE.click('#compare');
            await PAGE.waitForFunction(() => document.querySelector('#comparison').dataset.result === 'matched', null, {
                timeout: 15000,
            });
            assert.equal(
                await PAGE.evaluate(() => reference.diagnostics.connections.filter((x) => x === 'connected').length),
                2,
            );
            await PAGE.click('#stop');
        }
        assert.deepEqual(ERRORS, [], NAME);
        REPORT.examples.push({
            name: NAME,
            status: 'PASS',
            url: URL_LOCAL,
        });
        await PAGE.close();
    }
    REPORT.status = 'PASS';
} catch (error) {
    REPORT.status = 'FAIL';
    REPORT.error = error.stack;
    throw error;
} finally {
    await browser?.close();
    if (server) {
        await new Promise((resolve) => server.close(resolve));
    }
    await mkdir(resolve(ROOT, 'test-results'), {
        recursive: true,
    });
    await writeFile(
        resolve(ROOT, `test-results/previews-${PUBLIC_MODE ? 'public' : 'local'}.json`),
        JSON.stringify(REPORT, null, 2),
    );
    console.log(JSON.stringify(REPORT));
}

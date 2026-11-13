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
            // 벽 다각형(0번) 왼쪽 면(변 3)의 접촉 키: contactKey(CONTACT_POLYGON, 0, 3) = 0·2^50 + 0·2^22 + 3·4 + 0.
            const WALL_EDGE = 12;
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
            } finally {
                await TOUCH_CONTEXT.close();
            }
            // 포털 탭: 건물을 놓으면 겹치는 청크만 다시 만들고, 벽의 틈을 막으면 양쪽이 다른 성분이 되며, 지우면 다시 이어집니다.
            await PAGE.click('#tab-portal');
            const PORTAL = () => PAGE.locator('#portal-output').evaluate((output) => JSON.parse(output.textContent));
            const ALL_ARRIVED = () =>
                PAGE.waitForFunction(
                    () => {
                        const OUT = JSON.parse(document.querySelector('#portal-output').textContent);
                        return OUT.units > 0 && OUT.arrived === OUT.units;
                    },
                    null,
                    { timeout: 30000 },
                );
            // 유동장: 유닛들이 벽의 틈을 돌아 목표에 닿고, 유닛이 물은 청크만 계산합니다.
            await ALL_ARRIVED();
            let portal = await PORTAL();
            assert.ok(portal.settledNodes > 0, '포털 노드의 추상 거리를 확정함');
            assert.ok(
                portal.nearChunks.length > 0 && portal.nearChunks.length < portal.chunks[0] * portal.chunks[1],
                '유닛이 지나간 청크만 계산함',
            );
            await PAGE.click('#portal-send');
            await PAGE.click('#portal-exact');
            portal = await PORTAL();
            assert.ok(portal.worstRatio >= 1 && portal.worstRatio <= 1.15, '유동장 값 ÷ A* 최단 비용');
            await PAGE.click('#portal-exact');
            await PAGE.click('#portal-goal-mode');
            await PAGE.locator('#portal-canvas').scrollIntoViewIfNeeded();
            await PAGE.mouse.click(...AT(await PAGE.locator('#portal-canvas').boundingBox(), 60, 290));
            assert.deepEqual((await PORTAL()).goal, [60, 290], '목표 정하기로 누른 곳이 목표');
            await ALL_ARRIVED();
            await PAGE.click('#portal-goal-mode');
            await PAGE.locator('#portal-canvas').scrollIntoViewIfNeeded();
            const PORTAL_BOX = await PAGE.locator('#portal-canvas').boundingBox();
            await PAGE.mouse.click(...AT(PORTAL_BOX, 330, 140));
            portal = await PORTAL();
            assert.deepEqual(
                [portal.circles, portal.rebuiltChunks, portal.components],
                [
                    [[330, 140]],
                    [
                        [2, 0],
                        [2, 1],
                    ],
                    1,
                ],
                '놓은 건물과 겹치는 청크만 다시 만듦',
            );
            await PAGE.click('#portal-gap');
            portal = await PORTAL();
            assert.deepEqual(
                [portal.rebuiltChunks, portal.leftRightConnected],
                [
                    [
                        [1, 2],
                        [2, 2],
                    ],
                    false,
                ],
                '틈을 막음',
            );
            // 버튼을 누르며 화면이 움직였을 수 있으므로 캔버스 위치를 다시 읽습니다.
            await PAGE.locator('#portal-canvas').scrollIntoViewIfNeeded();
            await PAGE.mouse.click(...AT(await PAGE.locator('#portal-canvas').boundingBox(), 240, 296));
            portal = await PORTAL();
            assert.equal(portal.leftRightConnected, true, '틈의 건물을 지우면 다시 이어짐');
            await PAGE.locator('#portal-canvas').focus();
            await PAGE.keyboard.press('ArrowLeft');
            await PAGE.keyboard.press('Enter');
            assert.deepEqual(
                (await PORTAL()).circles,
                [
                    [330, 140],
                    [232, 296],
                ],
                '화살표로 옮긴 십자 표시 자리에 Enter로 놓음',
            );
            // 강: 칸 비용이 바뀐 띠만 다시 만들고, 유동장 값은 여전히 A* 최단(물 비용 포함) 이상 1.15배 이하입니다.
            await PAGE.click('#portal-water');
            await PAGE.click('#portal-send');
            await PAGE.click('#portal-exact');
            portal = await PORTAL();
            assert.equal(portal.water, true, '강을 켬');
            assert.ok(portal.rebuiltChunks.length > 0, '물이 든 청크를 다시 만듦');
            assert.ok(
                portal.worstRatio >= 1 && portal.worstRatio <= 1.15,
                `물이 있어도 유동장 값 ÷ A* 최단 비용: ${portal.worstRatio}`,
            );
            await PAGE.click('#portal-exact');
            await PAGE.click('#portal-water');
            assert.equal((await PORTAL()).water, false, '강을 끔');
            const PORTAL_TOUCH = await browser.newContext({
                hasTouch: true,
                isMobile: true,
                viewport: { width: 390, height: 844 },
            });
            try {
                const TOUCH_PAGE = await PORTAL_TOUCH.newPage();
                await TOUCH_PAGE.goto(URL_LOCAL + '#tab=portal', { waitUntil: 'domcontentloaded', timeout: 45000 });
                await TOUCH_PAGE.waitForFunction(() => !!globalThis.portalExample);
                const TOUCH_BOX = await TOUCH_PAGE.locator('#portal-canvas').boundingBox();
                assert.ok(TOUCH_BOX.x >= 0 && TOUCH_BOX.x + TOUCH_BOX.width <= 390, 'canvas fits the width');
                assert.ok(TOUCH_BOX.y + TOUCH_BOX.height <= 844, 'portal canvas is inside the first screen');
                assert.ok(
                    await TOUCH_PAGE.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
                    'no horizontal scroll',
                );
                assert.ok(
                    await TOUCH_PAGE.locator('#panel-portal button').evaluateAll((buttons) =>
                        buttons.every((button) => button.getBoundingClientRect().height >= 56),
                    ),
                    'portal buttons are at least 56px tall',
                );
                await TOUCH_PAGE.touchscreen.tap(...AT(TOUCH_BOX, 100, 80));
                const TAPPED = await TOUCH_PAGE.locator('#portal-output').evaluate((output) =>
                    JSON.parse(output.textContent),
                );
                assert.deepEqual(
                    [TAPPED.circles, TAPPED.rebuiltChunks],
                    [
                        [[100, 80]],
                        [
                            [0, 0],
                            [1, 0],
                        ],
                    ],
                    'tap',
                );
                await TOUCH_PAGE.locator('#portal-goal-mode').tap();
                await TOUCH_PAGE.touchscreen.tap(
                    ...AT(await TOUCH_PAGE.locator('#portal-canvas').boundingBox(), 400, 280),
                );
                assert.deepEqual(
                    (await TOUCH_PAGE.locator('#portal-output').evaluate((output) => JSON.parse(output.textContent)))
                        .goal,
                    [400, 280],
                    'tap goal',
                );
            } finally {
                await PORTAL_TOUCH.close();
            }
            // 시야 탭: 벽 뒤 땅은 정찰(xray)로만 보이고, 벽의 틈에서는 보이며, 언덕에 오르면 언덕과 땅이 모두 보입니다.
            await PAGE.click('#tab-vision');
            const VISION = () => PAGE.locator('#vision-output').evaluate((output) => JSON.parse(output.textContent));
            const VISION_BOX = await PAGE.locator('#vision-canvas').boundingBox();
            await PAGE.mouse.click(...AT(VISION_BOX, 50, 170));
            let view = await VISION();
            assert.deepEqual(
                [view.observer.cell, view.observer.level, view.seen],
                [[2, 8], 0, { ground: false, hill: false }],
            );
            await PAGE.keyboard.press('ArrowDown');
            assert.deepEqual((await VISION()).observer.cell, [2, 9]);
            await PAGE.click('#vision-reset');
            await PAGE.click('#vision-xray');
            view = await VISION();
            assert.deepEqual([view.observer.level, view.seen], ['xray', { ground: true, hill: false }]);
            await PAGE.click('#vision-xray');
            await PAGE.evaluate(() => globalThis.visionExample.moveTo(190, 50));
            assert.deepEqual((await VISION()).seen, { ground: true, hill: false }, '벽의 틈에서는 벽 뒤 땅이 보인다');
            await PAGE.evaluate(() => globalThis.visionExample.moveTo(310, 130));
            view = await VISION();
            assert.deepEqual(
                [view.observer.level, view.seen],
                [1, { ground: true, hill: true }],
                '언덕에 올라서면 모두 보인다',
            );
            await PAGE.evaluate(() => globalThis.visionExample.moveTo(410, 130));
            view = await VISION();
            assert.deepEqual(
                [view.observer.level, view.seen.hill],
                [0, false],
                '땅에서는 언덕 위 대상이 보이지 않는다',
            );
            const REVISION = view.revision;
            await PAGE.click('#vision-radius-short');
            assert.ok((await VISION()).revision > REVISION, '반경이 바뀌면 다시 칠한다');
            // 터치 에뮬레이션(실제 기기 검증이 아님): 좁은 화면에서 가로 스크롤 없이 첫 화면 안에서 캔버스를 눌러 관찰자를 옮깁니다.
            const VISION_TOUCH = await browser.newContext({
                hasTouch: true,
                isMobile: true,
                viewport: { width: 390, height: 844 },
            });
            try {
                const TOUCH_PAGE = await VISION_TOUCH.newPage();
                await TOUCH_PAGE.goto(URL_LOCAL + '#tab=vision', { waitUntil: 'domcontentloaded', timeout: 45000 });
                await TOUCH_PAGE.waitForFunction(() => !!globalThis.visionExample);
                const TOUCH_BOX = await TOUCH_PAGE.locator('#vision-canvas').boundingBox();
                assert.ok(TOUCH_BOX.x >= 0 && TOUCH_BOX.x + TOUCH_BOX.width <= 390, 'canvas fits the width');
                assert.ok(TOUCH_BOX.y + TOUCH_BOX.height <= 844, 'canvas is inside the first screen');
                assert.ok(
                    await TOUCH_PAGE.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
                    'no horizontal scroll',
                );
                assert.ok(
                    await TOUCH_PAGE.locator('#panel-vision button').evaluateAll((buttons) =>
                        buttons.every((button) => button.getBoundingClientRect().height >= 56),
                    ),
                    'touch buttons are at least 56px tall',
                );
                await TOUCH_PAGE.touchscreen.tap(...AT(TOUCH_BOX, 190, 50));
                const TAPPED = await TOUCH_PAGE.locator('#vision-output').evaluate((output) =>
                    JSON.parse(output.textContent),
                );
                assert.deepEqual([TAPPED.observer.cell, TAPPED.seen.ground], [[9, 2], true]);
            } finally {
                await VISION_TOUCH.close();
            }
            // 접촉 탭: 예산과 상관없이 벽 관통은 0이고, 예산 0이면 몸끼리 하나도 풀지 않아 겹치며, 무제한이면 건너뛴 쌍이 없습니다.
            await PAGE.click('#tab-contacts');
            await PAGE.click('#contacts-run');
            assert.equal(await PAGE.getAttribute('#contacts-run', 'aria-pressed'), 'false', '자동 실행 멈춤');
            const CONTACTS = () =>
                PAGE.locator('#contacts-output').evaluate((output) => JSON.parse(output.textContent));
            for (const [INDEX, LABEL] of [
                [0, '0'],
                [1, '16'],
                [3, '무제한'],
            ]) {
                await PAGE.evaluate((index) => {
                    globalThis.contactsExample.reset();
                    globalThis.contactsExample.setBudget(index);
                    globalThis.contactsExample.step(40);
                }, INDEX);
                const RUN = await CONTACTS();
                assert.deepEqual(
                    [RUN.tick, RUN.budget, RUN.wallPenetrations],
                    [40, LABEL, 0],
                    `예산 ${LABEL}: 벽 관통 0`,
                );
                if (INDEX === 0) {
                    assert.equal(RUN.pairContacts, 0, '예산 0: 몸끼리 풀지 않음');
                    assert.ok(RUN.overlapsBeforeSeparate > 0, '예산 0: 적끼리 겹친 채 끝남');
                } else if (INDEX === 1) {
                    assert.ok(RUN.pairContacts <= 16, '예산 16: 푼 쌍은 예산 이하');
                } else {
                    assert.equal(RUN.skippedPairs, 0, '무제한: 건너뛴 쌍 없음');
                }
            }
            await PAGE.locator('#contacts-budget').focus();
            await PAGE.keyboard.press('ArrowLeft');
            assert.equal((await CONTACTS()).budget, '64', '슬라이더를 키보드로 한 칸 내림');
            // 터치 에뮬레이션(실제 기기 검증이 아님): 탭 여섯 개가 한 줄이고, 첫 화면 안의 캔버스를 누르면 구르는 몸이 그쪽으로 굴러갑니다.
            const CONTACTS_TOUCH = await browser.newContext({
                hasTouch: true,
                isMobile: true,
                viewport: { width: 390, height: 844 },
            });
            try {
                const TOUCH_PAGE = await CONTACTS_TOUCH.newPage();
                await TOUCH_PAGE.goto(URL_LOCAL + '#tab=contacts', { waitUntil: 'domcontentloaded', timeout: 45000 });
                await TOUCH_PAGE.waitForFunction(() => !!globalThis.contactsExample);
                await TOUCH_PAGE.tap('#contacts-run');
                const TOUCH_BOX = await TOUCH_PAGE.locator('#contacts-canvas').boundingBox();
                assert.ok(TOUCH_BOX.x >= 0 && TOUCH_BOX.x + TOUCH_BOX.width <= 390, 'canvas fits the width');
                assert.ok(TOUCH_BOX.y + TOUCH_BOX.height <= 844, 'canvas is inside the first screen');
                assert.ok(
                    await TOUCH_PAGE.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
                    'no horizontal scroll',
                );
                assert.equal(
                    await TOUCH_PAGE.locator('[role="tab"]').evaluateAll(
                        (tabs) => new Set(tabs.map((tab) => Math.round(tab.getBoundingClientRect().top))).size,
                    ),
                    1,
                    'tabs stay on one line',
                );
                assert.ok(
                    await TOUCH_PAGE.locator('#panel-contacts button, #contacts-budget').evaluateAll((controls) =>
                        controls.every((control) => control.getBoundingClientRect().height >= 56),
                    ),
                    'touch controls are at least 56px tall',
                );
                await TOUCH_PAGE.evaluate(() => globalThis.contactsExample.reset());
                // 첫 구르는 몸(100, 110)에 가장 가까운 오른쪽 아래(150, 250)를 누릅니다.
                await TOUCH_PAGE.touchscreen.tap(...AT(TOUCH_BOX, 150, 250));
                const ROLLED = await TOUCH_PAGE.evaluate(() => {
                    const BODY = globalThis.contactsExample.state.bodies[120];
                    return [BODY.dynamic, BODY.ivx > 0, BODY.ivy > BODY.ivx];
                });
                assert.deepEqual(ROLLED, [true, true, true], '누른 쪽으로 굴러감');
            } finally {
                await CONTACTS_TOUCH.close();
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
            // three.js 탭(three-kit, three r180을 CDN에서 받음): 물체 16개 + 바닥 표시는 표시 수와 무관하게 2 draw이고,
            // 미리 컴파일한 뒤 플레이 중 새 프로그램이 없습니다.
            await PAGE.click('#tab-three');
            await PAGE.waitForFunction(() => renderingExamples.three?.drawCalls > 0, null, { timeout: 30000 });
            const THREE_TAB = () =>
                PAGE.evaluate(() => {
                    const EXAMPLE = renderingExamples.three;
                    return [
                        EXAMPLE.drawCalls,
                        EXAMPLE.expectedDrawCalls,
                        EXAMPLE.programs - EXAMPLE.programsAfterWarmUp,
                    ];
                });
            assert.deepEqual(await THREE_TAB(), [2, 2, 0]);
            await PAGE.click('#three-more');
            await PAGE.waitForFunction(() => renderingExamples.three.instances === 480);
            await PAGE.waitForTimeout(300);
            assert.deepEqual(await THREE_TAB(), [2, 2, 0]);
            assert.equal(await PAGE.evaluate(() => renderingExamples.three.renderer.getContext().getError()), 0);
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

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

// 배포물(dist/tech-tree.js·dist/navigation.js)을 실제 Chromium에서 불러와, 게임이 쓰는 그대로 트리를 만들고
// 상태·상세·주소·줌/팬·손가락 크기·스크롤 없음을 고정 트리 하나로 확인한다.
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const STARTED = performance.now();
const PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<style>html,body{margin:0;height:100%;background:#151a2c;font:14px system-ui}#tech{position:fixed;inset:0;padding:8px}</style></head>
<body><div id="tech"></div>
<script type="module">
import { createNavigation } from '/navigation.js';
import { createTechTree } from '/tech-tree.js';
const NODE = (id, branch, requires, max = 1) => ({ id, branch, requires, max, cost: 1 });
const BIG = [NODE('b0', 'big', [])];
for (let i = 1; i <= 3; i++) BIG.push(NODE('b' + i, 'big', ['b0']));
for (let i = 4; i <= 12; i++) BIG.push(NODE('b' + i, 'big', ['b' + (1 + ((i - 4) % 3))]));
BIG.push(NODE('skip', 'big', ['b0', 'b6']));
for (let i = 13; i <= 15; i++) BIG.push(NODE('b' + i, 'big', ['b' + (i - 9), 'b' + (i - 8)]));
const NODES = [
    NODE('needlePower', 'needle', []),
    NODE('needleTempo', 'needle', ['needlePower']),
    NODE('needleEcho', 'needle', ['needleTempo']),
    NODE('needleSplit', 'needle', ['needlePower']),
    NODE('needleJoin', 'needle', ['needleTempo', 'needleSplit']),
    NODE('dash', 'move', [], 3),
    NODE('recharge', 'move', [], 5),
    NODE('speed', 'move', ['recharge', 'needlePower'], 4),
    ...BIG,
];
const LEVELS = {};
const STATE = { points: 1 };
const NAME = (node) => 'N-' + node.id;
const NAVIGATION = createNavigation({ window });
const BUYS = [];
let TREE;
const MAKE = (overrides = {}) =>
    createTechTree({
        root: document.querySelector('#tech'),
        navigation: NAVIGATION,
        screen: 'tech',
        nodes: NODES,
        level: (id) => LEVELS[id] ?? 0,
        canBuy: (node) => ({ ok: STATE.points >= node.cost }),
        onBuy(id) {
            BUYS.push(id);
            LEVELS[id] = (LEVELS[id] ?? 0) + 1;
            STATE.points -= 1;
            TREE.refresh();
        },
        renderNode(node, element) {
            const STRONG = document.createElement('strong');
            STRONG.textContent = NAME(node);
            element.append(STRONG);
        },
        renderDetail(node, element) {
            element.textContent = 'detail ' + node.id;
        },
        text: {
            branch: (branch) => 'B:' + branch,
            name: NAME,
            state: (state, node, level) => state + ' ' + level + '/' + node.max,
            buy: (state, node) => (state === 'available' ? 'buy ' + node.cost : state),
            reason: (state) => 'why ' + state,
            prerequisite: (required, met) => (met ? 'ok ' : 'need ') + NAME(required),
            level: (node, level) => level + '/' + node.max,
            map: () => 'tree map',
        },
        ...overrides,
    });
window.__start = (overrides = {}) => (TREE = MAKE(overrides));
window.__tree = () => TREE;
window.__nav = NAVIGATION;
window.__buys = BUYS;
window.__levels = LEVELS;
window.__state = STATE;
window.__make = MAKE;
window.__view = () => {
    const WORLD = document.querySelector('.tt-world');
    const MATCH = /translate\\(([-\\d.e]+)px, ([-\\d.e]+)px\\) scale\\(([-\\d.e]+)\\)/.exec(WORLD.style.transform);
    const VIEW = document.querySelector('.tt-view');
    return { tx: +MATCH[1], ty: +MATCH[2], scale: +MATCH[3], pan: VIEW.dataset.pan, scrollLeft: VIEW.scrollLeft, scrollTop: VIEW.scrollTop, overflow: getComputedStyle(VIEW).overflowX, bar: VIEW.offsetWidth - VIEW.clientWidth };
};
window.__rect = (id) => {
    const BOX = document.querySelector('.tt-node[data-id="' + id + '"]').getBoundingClientRect();
    return { x: BOX.x, y: BOX.y, w: BOX.width, h: BOX.height };
};
window.__edgeHits = () => {
    const WORLD = document.querySelector('.tt-world');
    const BOXES = [...WORLD.querySelectorAll('.tt-node')].map((el) => ({ id: el.dataset.id, x: el.offsetLeft, y: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight }));
    let hits = 0;
    let edges = 0;
    for (const PATH of WORLD.querySelectorAll('.tt-edge')) {
        edges += 1;
        const LENGTH = PATH.getTotalLength();
        for (let step = 0; step <= 120; step++) {
            const POINT = PATH.getPointAtLength((LENGTH * step) / 120);
            for (const BOX of BOXES) {
                if (BOX.id === PATH.dataset.from || BOX.id === PATH.dataset.to) continue;
                if (POINT.x > BOX.x + 1 && POINT.x < BOX.x + BOX.w - 1 && POINT.y > BOX.y + 1 && POINT.y < BOX.y + BOX.h - 1) hits += 1;
            }
        }
    }
    return { hits, edges };
};
window.__viewRect = () => {
    const BOX = document.querySelector('.tt-view').getBoundingClientRect();
    return { x: BOX.x, y: BOX.y, w: BOX.width, h: BOX.height };
};
window.__startReady = true;
</script></body></html>`;

const SERVER = createServer(async (request, response) => {
    const PATH = new URL(request.url, 'http://local').pathname;
    const FILE = { '/navigation.js': 'dist/navigation.js', '/tech-tree.js': 'dist/tech-tree.js' }[PATH];
    if (FILE) {
        response.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
        response.end(await readFile(resolve(ROOT, FILE)));
        return;
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(PAGE);
});
const SETTLE = (ms = 320) => new Promise((done) => setTimeout(done, ms));
let browser;
try {
    await new Promise((done) => SERVER.listen(0, '127.0.0.1', done));
    const ORIGIN = `http://127.0.0.1:${SERVER.address().port}`;
    browser = await chromium.launch();

    async function open(options, path = '/') {
        const CONTEXT = await browser.newContext(options);
        const PAGE_NOW = await CONTEXT.newPage();
        const ERRORS = [];
        PAGE_NOW.on('pageerror', (error) => ERRORS.push(error.message));
        await PAGE_NOW.goto(ORIGIN + path);
        await PAGE_NOW.waitForFunction(() => window.__startReady);
        await PAGE_NOW.evaluate(() => window.__start());
        return { context: CONTEXT, page: PAGE_NOW, errors: ERRORS };
    }
    const STATES = (page, ids) =>
        page.evaluate((list) => Object.fromEntries(list.map((id) => [id, window.__tree().stateOf(id)])), ids);

    // 1. 폰(390x844 터치): 작은 트리도 제스처로 움직이며, 노드는 손가락 크기이고 스크롤·지도 위 도구 버튼이 없다.
    let run = await open({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    let { page } = run;
    assert.deepEqual(await STATES(page, ['needlePower', 'needleTempo', 'needleJoin', 'speed']), {
        needlePower: 'available',
        needleTempo: 'locked',
        needleJoin: 'locked',
        speed: 'locked',
    });
    let view = await page.evaluate(() => window.__view());
    assert.equal(view.pan, 'on', 'gestures are available even when the branch fits');
    assert.equal(view.scale, 1);
    assert.deepEqual(
        [view.scrollLeft, view.scrollTop, view.overflow, view.bar],
        [0, 0, 'clip', 0],
        'no native scroll in the view',
    );
    assert.equal(await page.locator('.tt-tools, .tt-tool').count(), 0);
    for (const ID of ['needlePower', 'needleTempo', 'needleEcho', 'needleSplit', 'needleJoin']) {
        const BOX = await page.evaluate((id) => window.__rect(id), ID);
        assert.ok(BOX.w >= 56 && BOX.h >= 56, `${ID} is at least 56px (${BOX.w}x${BOX.h})`);
    }
    const POWER = await page.evaluate(() => window.__rect('needlePower'));
    const TEMPO = await page.evaluate(() => window.__rect('needleTempo'));
    assert.ok(TEMPO.y > POWER.y + 56, 'portrait: deeper layers go down');
    assert.equal(
        await page.evaluate(
            () =>
                document.documentElement.scrollHeight <= innerHeight &&
                document.documentElement.scrollWidth <= innerWidth,
        ),
        true,
    );

    // 2. 상세·조건 칩·구매: 선택은 replace(이력 추가 없음)로 주소에 쓰고, 칩은 충족 여부와 이동을 한다.
    const HISTORY = await page.evaluate(() => history.length);
    await page.locator('.tt-node[data-id="needleJoin"]').tap();
    assert.equal(await page.evaluate(() => location.hash), '#/tech/needleJoin');
    assert.equal(await page.evaluate(() => history.length), HISTORY, 'selecting replaces the URL');
    assert.equal(await page.locator('.tt-title').textContent(), 'N-needleJoin');
    assert.equal(await page.locator('.tt-body').textContent(), 'detail needleJoin');
    assert.deepEqual(
        await page.locator('.tt-req').evaluateAll((chips) => chips.map((chip) => [chip.textContent, chip.dataset.met])),
        [
            ['need N-needleTempo', 'false'],
            ['need N-needleSplit', 'false'],
        ],
    );
    assert.equal(await page.locator('.tt-buy').isDisabled(), true);
    await page.locator('.tt-req').first().tap();
    assert.equal(await page.evaluate(() => window.__tree().selected), 'needleTempo');
    await page.locator('.tt-node[data-id="needlePower"]').tap();
    assert.equal(await page.locator('.tt-buy').isDisabled(), false);
    await page.locator('.tt-buy').tap();
    assert.deepEqual(await page.evaluate(() => window.__buys), ['needlePower']);
    assert.deepEqual(await STATES(page, ['needlePower', 'needleTempo', 'needleSplit', 'needleJoin', 'speed']), {
        needlePower: 'owned',
        needleTempo: 'waiting',
        needleSplit: 'waiting',
        needleJoin: 'locked',
        speed: 'locked',
    });
    assert.equal(await page.locator('.tt-buy').isDisabled(), true, 'owned node cannot be bought again');
    assert.equal(await page.locator('.tt-node[data-id="needleTempo"] .tt-badge').textContent(), 'waiting 0/1');
    assert.equal(await page.locator('.tt-edge[data-from="needlePower"]').first().getAttribute('data-met'), 'true');

    // 3. 분류 탭과 다른 분류의 선행 조건: 선이 아니라 칩으로 읽고, 칩을 누르면 그 분류로 간다.
    await page.locator('.tt-tab').nth(1).tap();
    assert.equal(await page.evaluate(() => window.__tree().selected), 'dash');
    assert.equal(await page.locator('.tt-node').count(), 3);
    await page.locator('.tt-node[data-id="speed"]').tap();
    assert.deepEqual(
        await page.locator('.tt-req').evaluateAll((chips) => chips.map((chip) => [chip.textContent, chip.dataset.met])),
        [
            ['need N-recharge', 'false'],
            ['ok N-needlePower', 'true'],
        ],
    );
    await page.locator('.tt-req').nth(1).tap();
    assert.equal(await page.evaluate(() => window.__tree().selected), 'needlePower');
    assert.equal(await page.locator('.tt-tab[aria-selected="true"]').textContent(), 'B:needle');

    // 4. 주소: 직접 진입·뒤로/앞으로가 같은 선택을 복원하고, 모르는 항목은 첫 노드로 바로잡는다.
    await page.evaluate(() => window.__nav.navigate({ screen: 'tech', item: 'needleEcho' }));
    assert.equal(await page.evaluate(() => window.__tree().selected), 'needleEcho');
    await page.goBack();
    await page.waitForFunction(() => window.__tree().selected === 'needlePower');
    await page.goForward();
    await page.waitForFunction(() => window.__tree().selected === 'needleEcho');
    await run.context.close();
    run = await open({ viewport: { width: 390, height: 844 }, hasTouch: true }, '/#/tech/speed');
    assert.equal(await run.page.evaluate(() => window.__tree().selected), 'speed');
    assert.equal(await run.page.locator('.tt-tab[aria-selected="true"]').textContent(), 'B:move');
    await run.context.close();
    run = await open({ viewport: { width: 390, height: 844 }, hasTouch: true }, '/#/tech/nope');
    assert.equal(await run.page.evaluate(() => window.__tree().selected), 'needlePower');
    assert.equal(await run.page.evaluate(() => location.hash), '#/tech/needlePower');
    await run.context.close();

    // 5. 넘치는 분류(폰): 손가락 크기를 지킨 채 줌/팬이 되고 스크롤은 생기지 않는다. 작게 줄인 노드를 누르면 키워서 보여 준다.
    run = await open({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true }, '/#/tech/b0');
    ({ page } = run);
    view = await page.evaluate(() => window.__view());
    assert.equal(view.pan, 'on', 'big branch overflows into zoom/pan');
    assert.equal(await page.locator('.tt-tools, .tt-tool').count(), 0);
    assert.deepEqual(
        [view.scrollLeft, view.scrollTop, view.overflow, view.bar],
        [0, 0, 'clip', 0],
        'overflow is software pan, not native scroll',
    );
    const ROOT_AT = await page.evaluate(() => ({ box: window.__rect('b0'), view: window.__viewRect() }));
    assert.ok(
        Math.abs(ROOT_AT.box.x + ROOT_AT.box.w / 2 - (ROOT_AT.view.x + ROOT_AT.view.w / 2)) <= 8,
        'portrait first view centers the root across the width',
    );
    assert.ok(
        ROOT_AT.box.x >= ROOT_AT.view.x && ROOT_AT.box.x + ROOT_AT.box.w <= ROOT_AT.view.x + ROOT_AT.view.w,
        'root is visible',
    );
    const PHONE_EDGES = await page.evaluate(() => window.__edgeHits());
    assert.ok(
        PHONE_EDGES.edges >= 18 && PHONE_EDGES.hits === 0,
        `no edge crosses a node in portrait (${JSON.stringify(PHONE_EDGES)})`,
    );
    const START_BOX = await page.evaluate(() => window.__rect('b0'));
    assert.ok(START_BOX.w >= 56, `initial node is touchable (${START_BOX.w})`);
    const VIEW_BOX = await page.evaluate(() => window.__viewRect());
    const CDP = await run.context.newCDPSession(page);
    const TOUCH = (type, points) => CDP.send('Input.dispatchTouchEvent', { type, touchPoints: points });
    const CENTER = { x: VIEW_BOX.x + VIEW_BOX.w / 2, y: VIEW_BOX.y + VIEW_BOX.h / 2 };
    // 한 손가락 끌기 = 이동, 끝난 뒤 클릭으로 선택이 바뀌지 않는다.
    const BEFORE_DRAG = await page.evaluate(() => ({ view: window.__view(), selected: window.__tree().selected }));
    await TOUCH('touchStart', [{ x: CENTER.x, y: CENTER.y, id: 1 }]);
    await TOUCH('touchMove', [{ x: CENTER.x - 60, y: CENTER.y, id: 1 }]);
    await TOUCH('touchMove', [{ x: CENTER.x - 120, y: CENTER.y, id: 1 }]);
    await TOUCH('touchEnd', []);
    const AFTER_DRAG = await page.evaluate(() => ({ view: window.__view(), selected: window.__tree().selected }));
    assert.ok(AFTER_DRAG.view.tx < BEFORE_DRAG.view.tx - 60, 'one-finger drag pans');
    await SETTLE(250);
    assert.equal(
        await page.evaluate(() => window.__view().tx),
        AFTER_DRAG.view.tx,
        'late resize notices do not reset the view',
    );
    assert.equal(AFTER_DRAG.selected, BEFORE_DRAG.selected, 'drag does not select');
    // 두 손가락 벌리기 = 확대.
    const SCALE_BEFORE = AFTER_DRAG.view.scale;
    await TOUCH('touchStart', [
        { x: CENTER.x - 40, y: CENTER.y, id: 1 },
        { x: CENTER.x + 40, y: CENTER.y, id: 2 },
    ]);
    await TOUCH('touchMove', [
        { x: CENTER.x - 80, y: CENTER.y, id: 1 },
        { x: CENTER.x + 80, y: CENTER.y, id: 2 },
    ]);
    await TOUCH('touchEnd', []);
    assert.ok((await page.evaluate(() => window.__view().scale)) > SCALE_BEFORE * 1.3, 'pinch zooms in');
    // 지도에 포커스한 Home은 루트 시작 위치를 복원하고, 두 손가락 오므리기로 최소 배율까지 줄인다.
    await page.locator('.tt-view').focus();
    await page.keyboard.press('Home');
    const FITTED = await page.evaluate(() => window.__view());
    assert.equal(FITTED.scale, view.scale);
    await TOUCH('touchStart', [
        { x: CENTER.x - 160, y: CENTER.y, id: 1 },
        { x: CENTER.x + 160, y: CENTER.y, id: 2 },
    ]);
    await TOUCH('touchMove', [
        { x: CENTER.x - 10, y: CENTER.y, id: 1 },
        { x: CENTER.x + 10, y: CENTER.y, id: 2 },
    ]);
    await TOUCH('touchEnd', []);
    await SETTLE();
    const SMALLEST = await page.evaluate(() => window.__view());
    assert.ok(SMALLEST.scale < FITTED.scale && SMALLEST.scale > 0.2, 'zoom out stops at the overview scale');
    const SMALL_ID = await page.evaluate(() => {
        const VIEW = window.__viewRect();
        return [...document.querySelectorAll('.tt-node')].find((node) => {
            const BOX = node.getBoundingClientRect();
            return BOX.x >= VIEW.x && BOX.y >= VIEW.y && BOX.right <= VIEW.x + VIEW.w && BOX.bottom <= VIEW.y + VIEW.h;
        })?.dataset.id;
    });
    assert.ok(SMALL_ID, 'the zoomed-out view contains a tappable node');
    const SMALL_NODE = await page.evaluate((id) => window.__rect(id), SMALL_ID);
    assert.ok(SMALL_NODE.w < 56, 'overview nodes are smaller than a finger');
    await page.locator(`.tt-node[data-id="${SMALL_ID}"]`).tap();
    await SETTLE();
    assert.equal(await page.evaluate(() => window.__tree().selected), SMALL_ID);
    const GROWN = await page.evaluate((id) => ({ box: window.__rect(id), view: window.__viewRect() }), SMALL_ID);
    assert.ok(GROWN.box.w >= 55.5, `selecting a tiny node grows it to touch size (${GROWN.box.w})`);
    assert.ok(
        GROWN.box.x >= GROWN.view.x && GROWN.box.x + GROWN.box.w <= GROWN.view.x + GROWN.view.w,
        'selected node is in view',
    );
    assert.deepEqual(run.errors, []);
    await run.context.close();

    // 6. 데스크톱(1280x800): 가로가 길면 깊이가 왼쪽에서 오른쪽으로 가고, 휠 확대·마우스 끌기가 되고 상세는 아래에 놓인다.
    run = await open({ viewport: { width: 1280, height: 800 } });
    ({ page } = run);
    const D_POWER = await page.evaluate(() => window.__rect('needlePower'));
    const D_TEMPO = await page.evaluate(() => window.__rect('needleTempo'));
    assert.ok(D_TEMPO.x > D_POWER.x + 56, 'landscape: deeper layers go right');
    assert.equal(await page.locator('.bloom-tech').getAttribute('data-layout'), 'wide');
    const DETAIL_BOX = await page.locator('.tt-detail').boundingBox();
    const D_VIEW = await page.evaluate(() => window.__viewRect());
    assert.ok(DETAIL_BOX.y >= D_VIEW.y + D_VIEW.h - 1, 'detail stays below the view on desktop too');
    await page.locator('.tt-tab').nth(2).click();
    assert.equal(await page.evaluate(() => window.__view().pan), 'on');
    const D_ROOT = await page.evaluate(() => ({ box: window.__rect('b0'), view: window.__viewRect() }));
    assert.ok(
        D_ROOT.box.x >= D_ROOT.view.x &&
            D_ROOT.box.y >= D_ROOT.view.y &&
            D_ROOT.box.y + D_ROOT.box.h <= D_ROOT.view.y + D_ROOT.view.h,
        'landscape first view shows the root',
    );
    const MID = await page.evaluate(() => window.__viewRect());
    const W_BEFORE = await page.evaluate(() => window.__view().scale);
    await page.mouse.move(MID.x + MID.w / 2, MID.y + MID.h / 2);
    await page.mouse.wheel(0, 300);
    await SETTLE(80);
    const W_OUT = await page.evaluate(() => window.__view().scale);
    assert.ok(W_OUT < W_BEFORE, 'wheel down zooms out');
    await page.mouse.wheel(0, -900);
    await SETTLE(80);
    const W_IN = await page.evaluate(() => window.__view().scale);
    assert.ok(W_IN > W_OUT && W_IN <= 1.6, 'wheel up zooms in, capped at 1.6');
    const DESKTOP_EDGES = await page.evaluate(() => window.__edgeHits());
    assert.ok(
        DESKTOP_EDGES.edges >= 18 && DESKTOP_EDGES.hits === 0,
        `no edge crosses a node in landscape (${JSON.stringify(DESKTOP_EDGES)})`,
    );
    const M_BEFORE = await page.evaluate(() => window.__view());
    await page.mouse.move(MID.x + MID.w / 2, MID.y + MID.h / 2);
    await page.mouse.down();
    await page.mouse.move(MID.x + MID.w / 2 + 40, MID.y + MID.h / 2 + 40, { steps: 4 });
    await page.mouse.up();
    const M_AFTER = await page.evaluate(() => window.__view());
    assert.ok(M_AFTER.tx !== M_BEFORE.tx || M_AFTER.ty !== M_BEFORE.ty, 'mouse drag pans');
    assert.deepEqual([M_AFTER.scrollLeft, M_AFTER.scrollTop], [0, 0], 'drag and focus never scroll natively');
    // 키보드 포커스가 화면 밖 노드로 가면 보이는 곳으로 옮긴다.
    await page.locator('.tt-node[data-id="b15"]').focus();
    await SETTLE();
    const B15 = await page.evaluate(() => ({ box: window.__rect('b15'), view: window.__viewRect() }));
    assert.ok(
        B15.box.x >= B15.view.x - 1 && B15.box.x + B15.box.w <= B15.view.x + B15.view.w + 1,
        'focused node is revealed',
    );
    assert.deepEqual(run.errors, []);

    await page.evaluate(() => window.__tree().select('b15'));
    await page.locator('.tt-view').focus();
    await page.keyboard.press('Home');
    const HOME_ROOT = await page.evaluate(() => ({ box: window.__rect('b0'), view: window.__viewRect() }));
    assert.ok(
        Math.abs(HOME_ROOT.box.x - HOME_ROOT.view.x - 16) < 1,
        'Home restores the root even when a deep node is selected',
    );
    assert.equal(
        await page.evaluate(() => window.__tree().selected),
        'b15',
        'resetting the camera does not change the detail selection',
    );

    // 작은 트리도 휠·키보드로 조작하고, 루트 9개 시작 위치는 폰과 PC에서 실제 좌표로 확인한다.
    for (const SIZE of [
        { width: 390, height: 844 },
        { width: 1280, height: 800 },
    ]) {
        await page.setViewportSize(SIZE);
        for (const [POSITION, X, Y] of [
            ['center', 0.5, 0.5],
            ['top', 0.5, 0],
            ['left', 0, 0.5],
            ['right', 1, 0.5],
            ['bottom', 0.5, 1],
            ['top-left', 0, 0],
            ['top-right', 1, 0],
            ['bottom-left', 0, 1],
            ['bottom-right', 1, 1],
        ]) {
            await page.evaluate((position) => {
                window.__tree().dispose();
                window.__nav.replace({ screen: 'tech', item: 'b0' });
                window.__start({ rootPosition: position });
            }, POSITION);
            await SETTLE(40);
            const AT = await page.evaluate(() => ({ root: window.__rect('b0'), view: window.__viewRect() }));
            const EXPECT_X = AT.view.x + (AT.view.w - AT.root.w) * X + 16 * (1 - 2 * X);
            const EXPECT_Y = AT.view.y + (AT.view.h - AT.root.h) * Y + 16 * (1 - 2 * Y);
            assert.ok(Math.abs(AT.root.x - EXPECT_X) < 1, `${SIZE.width}px ${POSITION} root x: ${JSON.stringify(AT)}`);
            assert.ok(Math.abs(AT.root.y - EXPECT_Y) < 1, `${SIZE.width}px ${POSITION} root y: ${JSON.stringify(AT)}`);
        }
        const DETAIL = await page.locator('.tt-detail').boundingBox();
        const VIEW = await page.locator('.tt-view').boundingBox();
        const TABS = await page.locator('.tt-tabs').boundingBox();
        assert.ok(
            TABS.y >= VIEW.y + VIEW.height && DETAIL.y >= TABS.y + TABS.height,
            'map, branches and detail never overlap',
        );
    }
    await page.evaluate(() => {
        window.__tree().dispose();
        window.__nav.replace({ screen: 'tech', item: 'needlePower' });
        window.__start({ rootPosition: 'center' });
    });
    const SMALL_VIEW = await page.evaluate(() => window.__viewRect());
    const BEFORE_WHEEL = await page.evaluate(() => window.__view().scale);
    await page.mouse.move(SMALL_VIEW.x + SMALL_VIEW.w / 2, SMALL_VIEW.y + SMALL_VIEW.h / 2);
    await page.mouse.wheel(0, -200);
    await SETTLE(80);
    assert.ok(await page.evaluate((before) => window.__view().scale > before, BEFORE_WHEEL), 'small trees can zoom in');
    await page.locator('.tt-view').focus();
    await page.keyboard.press('Home');
    const BEFORE_KEY = await page.evaluate(() => window.__view());
    await page.keyboard.press('ArrowRight');
    assert.ok(
        await page.evaluate((before) => window.__view().tx < before, BEFORE_KEY.tx),
        'keyboard pans without overlay controls',
    );
    await page.keyboard.press('+');
    assert.ok(
        await page.evaluate((before) => window.__view().scale > before, BEFORE_KEY.scale),
        'keyboard zoom remains available',
    );

    // 7. 잘못된 입력은 기본값으로 대체하지 않고 바로 던진다.
    const THROWN = await page.evaluate(() => {
        const CATCH = (run) => {
            try {
                window.__tree().dispose();
                run();
                return null;
            } catch (error) {
                return error.message;
            }
        };
        const BASE = (extra) => () => window.__make(extra);
        const NODE = (id, requires, extra = {}) => ({ id, branch: 'x', requires, max: 1, ...extra });
        return {
            cycle: CATCH(BASE({ nodes: [NODE('a', ['b']), NODE('b', ['a'])] })),
            unknown: CATCH(BASE({ nodes: [NODE('a', ['zzz'])] })),
            duplicate: CATCH(BASE({ nodes: [NODE('a', []), NODE('a', [])] })),
            noMax: CATCH(BASE({ nodes: [NODE('a', [], { max: 0 })] })),
            noRequires: CATCH(BASE({ nodes: [{ id: 'a', branch: 'x', max: 1 }] })),
            noText: CATCH(BASE({ text: {} })),
            noNavigation: CATCH(BASE({ navigation: null })),
            noScreen: CATCH(BASE({ screen: '' })),
            noRootPosition: CATCH(BASE({ rootPosition: 'north' })),
        };
    });
    const ONE_BRANCH = await page.evaluate(() => {
        window.__tree().dispose();
        const SINGLE = window.__make({ nodes: [{ id: 'a', branch: 'x', requires: [], max: 1 }] });
        const HIDDEN =
            document.querySelector('.tt-tabs').hidden &&
            getComputedStyle(document.querySelector('.tt-tabs')).display === 'none';
        SINGLE.dispose();
        return HIDDEN;
    });
    assert.equal(ONE_BRANCH, true, 'a single branch shows no tab');
    assert.match(THROWN.cycle, /requires form a cycle/);
    assert.match(THROWN.unknown, /requires unknown node zzz/);
    assert.match(THROWN.duplicate, /unique/);
    assert.match(THROWN.noMax, /max must be a positive integer/);
    assert.match(THROWN.noRequires, /requires must be an array/);
    assert.match(THROWN.noText, /text\.branch must be a function/);
    assert.match(THROWN.noNavigation, /navigation must provide/);
    assert.match(THROWN.noScreen, /screen must be a non-empty string/);
    assert.match(THROWN.noRootPosition, /rootPosition must be/);
    await run.context.close();

    // 배포할 실제 예제: 상단 도구줄 없음, 하단 설정으로 큰 트리·루트 위치를 바꾸고 닫아도 루트가 맞는다.
    for (const SIZE of [
        { width: 390, height: 568 },
        { width: 1280, height: 800 },
    ]) {
        const CONTEXT = await browser.newContext({ viewport: SIZE, hasTouch: SIZE.width < 720 });
        const EXAMPLE = await CONTEXT.newPage();
        const ERRORS = [];
        EXAMPLE.on('pageerror', (error) => ERRORS.push(error.message));
        await EXAMPLE.goto(pathToFileURL(resolve(ROOT, 'dist/previews/tech-tree.html')).href);
        await EXAMPLE.waitForFunction(() => window.techTreeDemo);
        await SETTLE(40);
        const INITIAL = await EXAMPLE.evaluate(() => {
            const VIEW = document.querySelector('.tt-view').getBoundingClientRect();
            const DETAIL = document.querySelector('.tt-detail').getBoundingClientRect();
            return {
                buttonsAbove: [...document.querySelectorAll('button')].filter(
                    (button) => button.getBoundingClientRect().bottom <= VIEW.top,
                ).length,
                tools: document.querySelectorAll('.tt-tool, .tt-tools').length,
                detailBelow: DETAIL.top >= VIEW.bottom,
                overflow:
                    document.documentElement.scrollHeight > innerHeight ||
                    document.documentElement.scrollWidth > innerWidth,
            };
        });
        assert.deepEqual(INITIAL, { buttonsAbove: 0, tools: 0, detailBelow: true, overflow: false });
        await EXAMPLE.locator('#example-settings summary').click();
        await EXAMPLE.locator('#tree-kind').selectOption('big');
        await EXAMPLE.locator('#root-position').selectOption('center');
        await EXAMPLE.locator('#example-settings summary').click();
        await SETTLE(40);
        const CENTERED = await EXAMPLE.evaluate(() => {
            const VIEW = document.querySelector('.tt-view').getBoundingClientRect();
            const ROOT = document.querySelector('.tt-node[data-id="r0"]').getBoundingClientRect();
            return {
                dx: ROOT.x + ROOT.width / 2 - VIEW.x - VIEW.width / 2,
                dy: ROOT.y + ROOT.height / 2 - VIEW.y - VIEW.height / 2,
            };
        });
        assert.ok(
            Math.abs(CENTERED.dx) < 1 && Math.abs(CENTERED.dy) < 1,
            `example root centered after settings close: ${JSON.stringify(CENTERED)}`,
        );
        assert.deepEqual(ERRORS, []);
        await CONTEXT.close();
    }

    console.log(`tech-tree e2e ok (${Math.round(performance.now() - STARTED)}ms)`);
} finally {
    await browser?.close();
    SERVER.close();
}

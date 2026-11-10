import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

// 배포물(dist/boot-build.mjs)로 약 20개 모듈 그래프 목록을 만들고, 요청마다 지연을 둔 서버에서 실제 Chromium이
// 그 목록을 병렬 preload → n/N 진행 → 같은 URL의 import()가 추가 요청 없이 실행되는 흐름을 확인한다.
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const { listModuleGraph: LIST_MODULE_GRAPH } = await import(
    new URL('dist/boot-build.mjs', `file:///${ROOT.replace(/\\/g, '/')}`)
);
const SITE = await mkdtemp(resolve(tmpdir(), 'bloom-boot-'));
const DELAY_MS = 40;
const STARTED = performance.now();

// 깊이 6의 사슬과 넓은 가지, re-export, 문자열 dynamic import, 문법 함정(주석·문자열·template·정규식 속 import)을 섞는다.
const FILES = {
    'graph/app.js': [
        "import { chain } from './chain/c1.js';",
        "export * from './reexport.js';",
        "export { leaf as leafAgain } from './leaves/l1.js';",
        "import './side-effect.js';",
        "// import './comment-trap.js';",
        'const TRAP = "import \'./string-trap.js\'";',
        'const TEMPLATE = `import "./template-trap.js" ${TRAP.length}`;',
        "const RE = /import '.\\/regex-trap.js'/g;",
        'const LEAVES = await Promise.all([1, 2, 3, 4, 5, 6].map((n) => import(`./leaves/l${n}.js`)));',
        "const LAZY = await import('./lazy.js');",
        'window.__appRan = [chain(), LEAVES.length, LAZY.lazy, TEMPLATE.length > 0, RE.test("x")].join(":");',
    ],
    'graph/chain/c1.js': ["import { chain as next } from './c2.js';", "export const chain = () => 'c1>' + next();"],
    'graph/chain/c2.js': ["import { chain as next } from './c3.js';", "export const chain = () => 'c2>' + next();"],
    'graph/chain/c3.js': ["import { chain as next } from './c4.js';", "export const chain = () => 'c3>' + next();"],
    'graph/chain/c4.js': ["import { chain as next } from './c5.js';", "export const chain = () => 'c4>' + next();"],
    'graph/chain/c5.js': ["import { chain as next } from './c6.js';", "export const chain = () => 'c5>' + next();"],
    'graph/chain/c6.js': ["import { shared } from '../shared.js';", "export const chain = () => 'c6' + shared;"],
    'graph/shared.js': ["export const shared = '!';"],
    'graph/reexport.js': ["export * from './re/r1.js';", "export { r2 } from './re/r2.js';"],
    'graph/re/r1.js': ["import '../shared.js';", 'export const r1 = 1;'],
    'graph/re/r2.js': ['export const r2 = 2;'],
    'graph/side-effect.js': ["import { shared } from './shared.js';", 'window.__side = shared;'],
    'graph/lazy.js': ["export { leaf as lazy } from './leaves/l6.js';"],
    'graph/leaves/l1.js': ["export const leaf = 'l1';"],
    'graph/leaves/l2.js': ["export const leaf = 'l2';"],
    'graph/leaves/l3.js': ["export const leaf = 'l3';"],
    'graph/leaves/l4.js': ["export const leaf = 'l4';"],
    'graph/leaves/l5.js': ["export const leaf = 'l5';"],
    'graph/leaves/l6.js': ["export const leaf = 'l6';"],
    'broken/entry.js': ["import './ok.js';", "import { x } from './missing.js';"],
    'broken/ok.js': ['export {};'],
};
const HTML = (list, stages) => `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body><progress id="bar"></progress><p id="label"></p>
<script type="module">
import { createBoot, bindBootProgress } from '/boot.js';
window.__states = [];
const BOOT = createBoot({ stages: ${JSON.stringify(stages)}, onChange: (state) => window.__states.push({ ...state, failed: state.failed?.message }) });
bindBootProgress(BOOT, { progress: document.querySelector('#bar'), label: document.querySelector('#label') });
window.__run = async (entry) => {
    try {
        await BOOT.preloadModules(${JSON.stringify(list)}, { stage: 'modules' });
        window.__requestsAfterPreload = await (await fetch('/requests')).json();
        await import(entry);
        BOOT.begin('work', 4);
        for (let i = 0; i < 4; i++) BOOT.advance('work');
        BOOT.complete();
    } catch (error) {
        BOOT.fail(error);
    }
};
</script></body></html>`;

const REQUESTS = new Map();
let page = '';
const SERVER = createServer(async (request, response) => {
    const PATH = decodeURIComponent(new URL(request.url, 'http://local').pathname);
    if (PATH === '/requests') {
        response
            .writeHead(200, { 'content-type': 'application/json' })
            .end(JSON.stringify(Object.fromEntries(REQUESTS)));
        return;
    }
    if (PATH === '/') {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(page);
        return;
    }
    try {
        const BYTES = await readFile(PATH === '/boot.js' ? resolve(ROOT, 'dist/boot.js') : resolve(SITE, '.' + PATH));
        if (PATH !== '/boot.js') {
            REQUESTS.set(PATH, (REQUESTS.get(PATH) ?? 0) + 1);
            await new Promise((done) => setTimeout(done, DELAY_MS));
        }
        response.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' });
        response.end(BYTES);
    } catch {
        REQUESTS.set(PATH, (REQUESTS.get(PATH) ?? 0) + 1);
        response.writeHead(404).end();
    }
});
let browser;
try {
    for (const [FILE, LINES] of Object.entries(FILES)) {
        await mkdir(resolve(SITE, FILE, '..'), { recursive: true });
        await writeFile(resolve(SITE, FILE), LINES.join('\n') + '\n');
    }

    // 1. 빌드 시점 목록: 진입점이 첫 항목, 너비 우선, 함정 문자열은 제외, 계산된 import()는 따라가지 않는다.
    const LIST = LIST_MODULE_GRAPH({ root: SITE, entry: 'graph/app.js' });
    assert.deepEqual(LIST, [
        'graph/app.js',
        'graph/chain/c1.js',
        'graph/reexport.js',
        'graph/leaves/l1.js',
        'graph/side-effect.js',
        'graph/lazy.js',
        'graph/chain/c2.js',
        'graph/re/r1.js',
        'graph/re/r2.js',
        'graph/shared.js',
        'graph/leaves/l6.js',
        'graph/chain/c3.js',
        'graph/chain/c4.js',
        'graph/chain/c5.js',
        'graph/chain/c6.js',
    ]);
    assert.throws(
        () => LIST_MODULE_GRAPH({ root: SITE, entry: 'broken/entry.js' }),
        /unresolved import in broken\/entry\.js: broken\/missing\.js/,
    );
    await writeFile(resolve(SITE, 'broken/bare.js'), "import 'lodash';\n");
    assert.throws(() => LIST_MODULE_GRAPH({ root: SITE, entry: 'broken/bare.js' }), /unsupported specifier/);
    // 계산된 import()의 l2~l5는 목록 밖이므로 브라우저가 import 시점에 요청한다. 목록 전체를 미리 읽게 하려면 문자열로 쓴다.
    const PRELOAD = [...LIST, ...[2, 3, 4, 5].map((n) => `graph/leaves/l${n}.js`)];

    await new Promise((done) => SERVER.listen(0, '127.0.0.1', done));
    const ORIGIN = `http://127.0.0.1:${SERVER.address().port}`;
    browser = await chromium.launch();
    const STAGES = [
        { id: 'modules', weight: 3 },
        { id: 'work', weight: 1 },
    ];

    // 2. 실제 브라우저: n/N이 1씩 끝까지, 전체 진행률 단조 증가 후 1, preload 뒤 import()의 추가 모듈 요청 0.
    page = HTML(PRELOAD, STAGES);
    const PAGE = await browser.newPage();
    const ERRORS = [];
    PAGE.on('pageerror', (error) => ERRORS.push(error.message));
    await PAGE.goto(ORIGIN + '/');
    REQUESTS.clear();
    await PAGE.evaluate(() => window.__run('/graph/app.js'));
    const RESULT = await PAGE.evaluate(() => ({
        states: window.__states,
        ran: window.__appRan,
        side: window.__side,
        after: window.__requestsAfterPreload,
        bar: document.querySelector('#bar').value,
        label: document.querySelector('#label').textContent,
    }));
    assert.deepEqual(ERRORS, []);
    assert.equal(RESULT.ran, 'c1>c2>c3>c4>c5>c6!:6:l6:true:false');
    assert.equal(RESULT.side, '!');
    const MODULE_STATES = RESULT.states.filter((state) => state.stage === 'modules');
    assert.deepEqual(
        MODULE_STATES.map((state) => `${state.completed}/${state.total}`),
        Array.from({ length: PRELOAD.length + 1 }, (_, n) => `${n}/${PRELOAD.length}`),
    );
    const OVERALL = RESULT.states.map((state) => state.overall);
    assert.ok(
        OVERALL.every((value, index) => index === 0 || value >= OVERALL[index - 1]),
        `overall must not decrease: ${OVERALL.join(',')}`,
    );
    assert.equal(MODULE_STATES.at(-1).overall, 0.75);
    assert.equal(OVERALL.at(-1), 1);
    assert.equal(RESULT.bar, 1);
    assert.equal(RESULT.label, 'work 4/4 · 100%');
    assert.deepEqual(RESULT.after, Object.fromEntries(PRELOAD.map((file) => ['/' + file, 1])));
    assert.deepEqual(Object.fromEntries(REQUESTS), RESULT.after, 'import() after preload must not request modules');
    await PAGE.close();

    // 3. 실패: 없는 파일이 섞이면 나머지는 끝까지 세고 preloadModules가 던지며, fail 뒤 상태는 고정된다.
    page = HTML(['graph/shared.js', 'graph/nope.js'], STAGES);
    const FAIL_PAGE = await browser.newPage();
    await FAIL_PAGE.goto(ORIGIN + '/');
    await FAIL_PAGE.evaluate(() => window.__run('/graph/app.js'));
    const FAILED = await FAIL_PAGE.evaluate(() => window.__states.at(-1));
    assert.match(FAILED.failed, /module preload failed \(1\/2\): .*\/graph\/nope\.js/);
    assert.equal(FAILED.completed, 1);
    assert.equal(FAILED.total, 2);
    console.log(
        `boot: ${PRELOAD.length} modules preloaded n/N, import() extra requests 0, failure path ok ` +
            `(${Math.round(performance.now() - STARTED)}ms)`,
    );
} finally {
    await browser?.close();
    SERVER.close();
    await rm(SITE, { recursive: true, force: true });
}

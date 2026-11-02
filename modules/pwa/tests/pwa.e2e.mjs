import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

// 샘플 게임 폴더를 만들어 배포물(dist/pwa-build.mjs·dist/pwa.js)로 PWA를 생성하고, 실제 Chromium에서
// 첫 방문(설치 때 받는 파일 없음) → 파일 배포 후 새로고침 한 번에 새 버전 → 오프라인 새로고침에 마지막 버전을 확인한다.
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const { buildPwa: BUILD_PWA } = await import(new URL('dist/pwa-build.mjs', `file:///${ROOT.replace(/\\/g, '/')}`));
const SITE = await mkdtemp(resolve(tmpdir(), 'bloom-pwa-'));
const GAMEKIT = `https://cdn.jsdelivr.net/gh/byh-playground/bloom-gamekit@${'a'.repeat(40)}/probe.js`;
const ICON = (color) =>
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect x="6" y="6" width="88" height="88" rx="22" fill="${color}"/><circle cx="50" cy="50" r="26" fill="#ffd166"/></svg>\n`;
const SHARE =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 630"><rect width="1200" height="630" fill="#16303a"/><circle cx="300" cy="315" r="180" fill="#ffd166"/><rect x="560" y="220" width="520" height="190" rx="40" fill="#ef476f"/></svg>\n';
const HTML = [
    '<!doctype html>',
    '<html lang="ko">',
    '    <head>',
    '        <meta charset="utf-8">',
    '        <meta name="viewport" content="width=device-width, initial-scale=1">',
    '        <title>PWA sample</title>',
    '        <!-- bloom-pwa:start -->',
    '        <!-- bloom-pwa:end -->',
    '    </head>',
    '    <body>',
    '        <p id="version">loading</p>',
    '        <script type="module" src="src/main.js"></script>',
    '    </body>',
    '</html>',
    '',
].join('\n');
const MAIN = `import { registerPwa } from './pwa.js';
import { VERSION } from './version.js';
window.__probe = () => import(${JSON.stringify(GAMEKIT)}).then((module) => module.PROBE);
window.__events = [];
window.__pwa = registerPwa({
    serviceWorker: './sw.js',
    onError: (error) => window.__events.push('error:' + error.message),
});
document.querySelector('#version').textContent = VERSION;
`;
const OPTIONS = (check) => ({
    chromium,
    name: 'PWA Sample',
    shortName: '샘플',
    description: '오프라인으로 시작하는 샘플 게임 & "따옴표"',
    lang: 'ko',
    icon: 'assets/icon.svg',
    share: 'assets/share.svg',
    themeColor: '#16303a',
    backgroundColor: '#16303a',
    startUrl: './',
    scope: './',
    siteUrl: 'https://example.test/sample/',
    html: 'index.html',
    out: '.',
    check,
});
const REJECTS = async (promise, pattern) => {
    let error = null;
    try {
        await promise;
    } catch (caught) {
        error = caught;
    }
    assert.ok(error, `expected rejection matching ${pattern}`);
    assert.match(error.message, pattern);
    return error.message;
};
const PNG_SIZE = (bytes) => {
    assert.equal(bytes.subarray(1, 4).toString('latin1'), 'PNG');
    return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
};
const TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.webmanifest': 'application/manifest+json',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
};
// GitHub Pages처럼 max-age=600과 ETag를 보낸다. worker가 HTTP cache의 이전 파일을 쓰면 새 버전이 늦게 보인다.
const SERVED = [];
const SERVER = createServer(async (request, response) => {
    const PATH = decodeURIComponent(new URL(request.url, 'http://local').pathname);
    SERVED.push(PATH);
    try {
        const BYTES = await readFile(resolve(SITE, '.' + (PATH.endsWith('/') ? PATH + 'index.html' : PATH)));
        const ETAG = `"${createHash('sha256').update(BYTES).digest('hex').slice(0, 16)}"`;
        const HEADERS = { 'cache-control': 'max-age=600', etag: ETAG };
        if (request.headers['if-none-match'] === ETAG) {
            response.writeHead(304, HEADERS).end();
            return;
        }
        response.writeHead(200, { ...HEADERS, 'content-type': TYPES[extname(PATH)] ?? 'text/html' });
        response.end(BYTES);
    } catch {
        response.writeHead(404).end();
    }
});
const REPORT = {};
let browser;
try {
    await mkdir(resolve(SITE, 'assets'), { recursive: true });
    await mkdir(resolve(SITE, 'src'), { recursive: true });
    await writeFile(resolve(SITE, 'index.html'), HTML);
    await writeFile(resolve(SITE, 'assets/icon.svg'), ICON('#118ab2'));
    await writeFile(resolve(SITE, 'assets/share.svg'), SHARE);
    await writeFile(resolve(SITE, 'src/main.js'), MAIN);
    await writeFile(resolve(SITE, 'src/version.js'), "export const VERSION = 'one';\n");
    await cp(resolve(ROOT, 'dist/pwa.js'), resolve(SITE, 'src/pwa.js'));
    process.chdir(SITE);

    // 1. 생성: manifest·아이콘·공유 이미지·sw.js·<head> 태그.
    const FIRST = await BUILD_PWA(OPTIONS(false));
    assert.deepEqual(FIRST.changed, FIRST.files);
    assert.deepEqual(FIRST.files, [
        'index.html',
        'manifest.webmanifest',
        'pwa/apple-touch-icon.png',
        'pwa/icon-192.png',
        'pwa/icon-512.png',
        'pwa/maskable-512.png',
        'pwa/share.png',
        'sw.js',
    ]);
    const MANIFEST = JSON.parse(await readFile(resolve(SITE, 'manifest.webmanifest'), 'utf8'));
    assert.equal(MANIFEST.name, 'PWA Sample');
    assert.equal(MANIFEST.short_name, '샘플');
    assert.equal(MANIFEST.start_url, './');
    assert.equal(MANIFEST.scope, './');
    assert.equal(MANIFEST.display, 'standalone');
    assert.equal(MANIFEST.theme_color, '#16303a');
    assert.deepEqual(
        MANIFEST.icons.map(({ sizes, purpose }) => `${sizes}:${purpose}`),
        ['192x192:any', '512x512:any', '512x512:maskable'],
    );
    REPORT.png = {};
    for (const [FILE, SIZE] of [
        ['pwa/icon-192.png', [192, 192]],
        ['pwa/icon-512.png', [512, 512]],
        ['pwa/maskable-512.png', [512, 512]],
        ['pwa/apple-touch-icon.png', [180, 180]],
        ['pwa/share.png', [1200, 630]],
    ]) {
        const BYTES = await readFile(resolve(SITE, FILE));
        assert.deepEqual(PNG_SIZE(BYTES), SIZE, FILE);
        REPORT.png[FILE] = BYTES.length;
        if (process.env.PWA_CAPTURE_DIR) {
            await mkdir(process.env.PWA_CAPTURE_DIR, { recursive: true });
            await writeFile(resolve(process.env.PWA_CAPTURE_DIR, FILE.split('/').at(-1)), BYTES);
        }
    }
    const PAGE_HTML = await readFile(resolve(SITE, 'index.html'), 'utf8');
    for (const TAG of [
        '        <link rel="manifest" href="manifest.webmanifest">',
        '        <link rel="apple-touch-icon" href="pwa/apple-touch-icon.png">',
        '        <meta property="og:image" content="https://example.test/sample/pwa/share.png">',
        '        <meta property="og:url" content="https://example.test/sample/">',
        '        <meta name="description" content="오프라인으로 시작하는 샘플 게임 &amp; &quot;따옴표&quot;">',
    ]) {
        assert.ok(PAGE_HTML.includes(TAG + '\n'), TAG);
    }
    const WORKER = await readFile(resolve(SITE, 'sw.js'), 'utf8');
    assert.ok(!WORKER.includes('localStorage') && !WORKER.includes('indexedDB'));

    // 2. 같은 입력은 같은 bytes: 다시 실행해도 바뀌는 파일이 없고 check가 통과한다.
    const SNAPSHOT = new Map();
    for (const FILE of FIRST.files) {
        SNAPSHOT.set(FILE, await readFile(resolve(SITE, FILE)));
    }
    assert.deepEqual((await BUILD_PWA(OPTIONS(false))).changed, []);
    for (const FILE of FIRST.files) {
        assert.ok(SNAPSHOT.get(FILE).equals(await readFile(resolve(SITE, FILE))), FILE);
    }
    assert.deepEqual((await BUILD_PWA(OPTIONS(true))).changed, []);

    // 3. 원본이 바뀌면 check는 쓰지 않고 던진다. 잘못된 설정도 기본값 없이 던진다.
    await writeFile(resolve(SITE, 'assets/icon.svg'), ICON('#ef476f'));
    REPORT.staleCheck = await REJECTS(BUILD_PWA(OPTIONS(true)), /out of date.*pwa\/icon-192\.png/);
    assert.ok(SNAPSHOT.get('pwa/icon-192.png').equals(await readFile(resolve(SITE, 'pwa/icon-192.png'))));
    await writeFile(resolve(SITE, 'assets/icon.svg'), ICON('#118ab2'));
    assert.deepEqual((await BUILD_PWA(OPTIONS(true))).changed, []);
    const MISSING = { ...OPTIONS(true), themeColor: undefined };
    await REJECTS(BUILD_PWA(MISSING), /themeColor must be a #rrggbb color/);
    await REJECTS(BUILD_PWA({ ...OPTIONS(true), precache: ['index.html'] }), /unknown option "precache"/);
    await REJECTS(BUILD_PWA({ ...OPTIONS(true), share: 'assets/icon.svg' }), /share SVG viewBox must have aspect/);

    // 4. 실제 Chromium 첫 방문: worker가 페이지를 제어하고, 설치 때 받는 파일(precache)이 없다.
    await new Promise((done) => SERVER.listen(0, '127.0.0.1', done));
    const ORIGIN = `http://127.0.0.1:${SERVER.address().port}`;
    browser = await chromium.launch();
    // Playwright는 route가 있는 동안 HTTP cache를 끈다. 배포·새로고침 단계는 route 없이 실제 HTTP cache로 확인한다.
    const CONTEXT = await browser.newContext({ serviceWorkers: 'allow' });
    const PAGE = await CONTEXT.newPage();
    // 이전 precache 캐시(이 scope)와 다른 게임(다른 scope)의 캐시를 미리 만든다.
    await PAGE.goto(ORIGIN + '/assets/share.svg');
    await PAGE.evaluate(() =>
        Promise.all(['bloom-pwa:/:0123456789abcdef', 'bloom-pwa:/other/:runtime'].map((name) => caches.open(name))),
    );
    SERVED.length = 0;
    await PAGE.goto(ORIGIN + '/');
    await PAGE.waitForFunction(() => document.querySelector('#version').textContent === 'one');
    await PAGE.evaluate(
        () =>
            new Promise((done) => {
                if (navigator.serviceWorker.controller) {
                    done();
                } else {
                    navigator.serviceWorker.addEventListener('controllerchange', done, { once: true });
                }
            }),
    );
    REPORT.firstVisit = await PAGE.evaluate(async () => ({
        controlled: !!navigator.serviceWorker.controller,
        caches: (await caches.keys()).sort(),
        events: [...window.__events],
    }));
    REPORT.firstVisit.served = SERVED.filter((path) => path.startsWith('/src/') || path === '/');
    assert.equal(REPORT.firstVisit.controlled, true);
    assert.deepEqual(REPORT.firstVisit.events, []);
    // 설치가 파일을 받았다면 같은 파일을 두 번 요청한다. 첫 방문의 게임 파일은 각각 한 번만 요청된다.
    assert.deepEqual(
        [...REPORT.firstVisit.served].sort(),
        ['/', '/src/main.js', '/src/pwa.js', '/src/version.js'],
        'install downloads nothing',
    );
    assert.ok(!REPORT.firstVisit.caches.includes('bloom-pwa:/:0123456789abcdef'), 'old precache cache is deleted');
    assert.ok(REPORT.firstVisit.caches.includes('bloom-pwa:/other/:runtime'), 'other scope cache is kept');
    assert.ok(!REPORT.firstVisit.caches.some((name) => /^bloom-pwa:\/:[0-9a-f]{16}$/.test(name)), 'no precache');
    assert.equal(
        await PAGE.evaluate(async () => (await navigator.serviceWorker.getRegistration()).updateViaCache),
        'none',
    );

    // 5. 배포가 파일을 바꾸면 새로고침 한 번에 새 버전이 열린다. sw.js는 다시 생성할 필요가 없다.
    await writeFile(resolve(SITE, 'src/version.js'), "export const VERSION = 'two';\n");
    assert.deepEqual((await BUILD_PWA(OPTIONS(true))).changed, [], 'deploy needs no regeneration');
    await PAGE.reload();
    await PAGE.waitForFunction(() => document.querySelector('#version').textContent !== 'loading');
    REPORT.afterDeploy = await PAGE.textContent('#version');
    assert.equal(REPORT.afterDeploy, 'two', 'one reload serves the deployed file despite max-age=600');
    REPORT.waiting = await PAGE.evaluate(async () => !!(await navigator.serviceWorker.getRegistration()).waiting);
    assert.equal(REPORT.waiting, false);

    // 6. 오프라인 새로고침은 마지막으로 읽은 버전을 캐시에서 연다. 고정 gamekit 주소는 cache-first다.
    // 고정된 gamekit 주소는 네트워크 대신 이 시험이 응답한다(서비스 워커의 요청도 포함).
    await CONTEXT.route(GAMEKIT, (route) =>
        route.fulfill({
            status: 200,
            headers: { 'content-type': 'text/javascript', 'access-control-allow-origin': '*' },
            body: "export const PROBE = 'gamekit';\n",
        }),
    );
    assert.equal(await PAGE.evaluate(() => window.__probe()), 'gamekit');
    await CONTEXT.unrouteAll();
    await CONTEXT.setOffline(true);
    await PAGE.reload();
    await PAGE.waitForFunction(() => document.querySelector('#version').textContent !== 'loading');
    REPORT.offline = [await PAGE.textContent('#version'), await PAGE.evaluate(() => window.__probe())];
    assert.deepEqual(REPORT.offline, ['two', 'gamekit']);
    await CONTEXT.close();

    // 7. 자동화 브라우저가 service worker를 막으면 register는 빈 값으로 끝난다. 던지지 않고 onError로 알린다.
    const BLOCKED = await browser.newContext({ serviceWorkers: 'block' });
    const BLOCKED_PAGE = await BLOCKED.newPage(),
        PAGE_ERRORS = [];
    BLOCKED_PAGE.on('pageerror', (error) => PAGE_ERRORS.push(error.message));
    await BLOCKED_PAGE.goto(ORIGIN + '/');
    await BLOCKED_PAGE.waitForFunction(() => window.__events?.length > 0);
    REPORT.blocked = await BLOCKED_PAGE.evaluate(() => [...window.__events]);
    assert.deepEqual(REPORT.blocked, ['error:service worker registration was blocked by the browser']);
    assert.deepEqual(PAGE_ERRORS, []);
    await BLOCKED.close();
    console.log(JSON.stringify({ status: 'PASS', scenario: 'pwa', ...REPORT }));
} finally {
    await browser?.close();
    SERVER.close();
    process.chdir(ROOT);
    await rm(SITE, { recursive: true, force: true });
}

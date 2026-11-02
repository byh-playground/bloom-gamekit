// 게임 저장소에서 로컬로 실행하는 PWA 생성기입니다(Node ESM, `dist/pwa-build.mjs`).
// SVG 원본과 설정 하나에서 manifest·아이콘·공유 이미지·sw.js·<head> 태그를 만들고, 게임은 결과를 커밋합니다.
// sw.js는 게임 파일 목록·내용과 무관한 고정 코드이므로 배포마다 다시 생성할 필요가 없습니다.
// 같은 입력·같은 Playwright Chromium이면 같은 bytes를 씁니다. check 모드는 아무것도 쓰지 않고 차이가 있으면 던집니다.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

const MARKER_START = '<!-- bloom-pwa:start -->';
const MARKER_END = '<!-- bloom-pwa:end -->';
const COLOR = /^#[0-9a-f]{6}$/i;
const SHARE_SIZE = Object.freeze({ width: 1200, height: 630 });
// 원본 아이콘을 maskable 안전 영역(지름 80%) 안에 넣습니다. maskableIcon을 주면 그 SVG를 꽉 채워 씁니다.
const MASKABLE_SAFE_ZONE = 0.8;
const MANIFEST_FILE = 'manifest.webmanifest';
const WORKER_FILE = 'sw.js';
// 생성 이미지 경로(out 기준).
const IMAGES = Object.freeze({
    icon192: 'pwa/icon-192.png',
    icon512: 'pwa/icon-512.png',
    maskable: 'pwa/maskable-512.png',
    apple: 'pwa/apple-touch-icon.png',
    share: 'pwa/share.png',
});
// 커밋에 고정된 gamekit 배포물은 바뀌지 않으므로 cache-first가 안전합니다.
const GAMEKIT_URL = /https:\/\/cdn\.jsdelivr\.net\/gh\/byh-playground\/bloom-gamekit@[0-9a-f]{40}\/[A-Za-z0-9._/-]+/;
const TEXT_FILE = /\.(?:html?|m?js|css|json|webmanifest|svg|txt)$/i;
const OPTION_KEYS = new Set([
    'chromium',
    'name',
    'shortName',
    'description',
    'lang',
    'icon',
    'maskableIcon',
    'share',
    'themeColor',
    'backgroundColor',
    'startUrl',
    'scope',
    'siteUrl',
    'html',
    'out',
    'check',
]);

const POSIX = (path) => path.split(sep).join('/');
const IS_TEXT = (path) => TEXT_FILE.test(path);
// 저장소의 줄바꿈 설정(autocrlf)과 무관하게 같은 내용을 같은 것으로 봅니다.
const CANONICAL = (path, bytes) =>
    IS_TEXT(path) ? Buffer.from(bytes.toString('utf8').replace(/\r\n/g, '\n'), 'utf8') : bytes;
const ESCAPE = (value) =>
    String(value).replace(/[&"<>]/g, (char) => ({ '&': '&amp;', '"': '&quot;', '<': '&lt;', '>': '&gt;' })[char]);

function fail(message) {
    throw new Error(`buildPwa: ${message}`);
}

function readOptions(options) {
    if (options === null || typeof options !== 'object') {
        fail('options object is required');
    }
    for (const KEY of Object.keys(options)) {
        if (!OPTION_KEYS.has(KEY)) {
            fail(`unknown option "${KEY}"`);
        }
    }
    if (typeof options.chromium?.launch !== 'function') {
        fail('chromium must be Playwright chromium (import { chromium } from "playwright")');
    }
    for (const KEY of [
        'name',
        'shortName',
        'description',
        'lang',
        'icon',
        'share',
        'startUrl',
        'scope',
        'siteUrl',
        'html',
        'out',
    ]) {
        if (typeof options[KEY] !== 'string' || options[KEY].trim() === '') {
            fail(`${KEY} must be a non-empty string`);
        }
    }
    if (options.maskableIcon !== undefined && (typeof options.maskableIcon !== 'string' || !options.maskableIcon)) {
        fail('maskableIcon must be a non-empty string when given');
    }
    for (const KEY of ['themeColor', 'backgroundColor']) {
        if (typeof options[KEY] !== 'string' || !COLOR.test(options[KEY])) {
            fail(`${KEY} must be a #rrggbb color`);
        }
    }
    if (typeof options.check !== 'boolean') {
        fail('check must be true or false');
    }
    let site;
    try {
        site = new URL(options.siteUrl);
    } catch {
        fail(`siteUrl must be an absolute URL: ${options.siteUrl}`);
    }
    if (site.protocol !== 'https:' || !site.pathname.endsWith('/') || site.search || site.hash) {
        fail('siteUrl must be the https URL of the published out folder, ending with "/"');
    }
    return options;
}

// 모든 경로는 현재 작업 폴더(게임 루트) 기준입니다. out 밖의 파일은 게임 origin에서 서비스되지 않습니다.
function inside(root, path, label) {
    const RELATIVE = relative(root, path);
    if (RELATIVE === '' || RELATIVE.startsWith('..') || isAbsolute(RELATIVE)) {
        fail(`${label} must be inside out: ${path}`);
    }
    return POSIX(RELATIVE);
}

async function readSource(cwd, path, label) {
    try {
        return await readFile(resolve(cwd, path), 'utf8');
    } catch (error) {
        fail(`cannot read ${label} ${path}: ${error.message}`);
    }
}

// Playwright Chromium으로 SVG를 PNG로 그립니다. 게임이 chromium을 넘기므로 이 모듈은 의존성을 찾지 않습니다.
async function rasterize(chromium, sources, jobs) {
    const BROWSER = await chromium.launch();
    try {
        const PAGE = await BROWSER.newPage({ viewport: { width: 64, height: 64 }, deviceScaleFactor: 1 });
        for (const [LABEL, { svg: SVG, aspect: ASPECT }] of Object.entries(sources)) {
            const PROBLEM = await PAGE.evaluate(
                ({ svg, aspect }) => {
                    const DOCUMENT = new DOMParser().parseFromString(svg, 'image/svg+xml');
                    const ROOT = DOCUMENT.documentElement;
                    if (DOCUMENT.querySelector('parsererror') || ROOT.localName !== 'svg') {
                        return 'is not a valid SVG document';
                    }
                    const BOX = ROOT.viewBox.baseVal;
                    if (!ROOT.hasAttribute('viewBox') || !(BOX.width > 0) || !(BOX.height > 0)) {
                        return 'needs a viewBox with positive width and height';
                    }
                    if (Math.abs(BOX.width / BOX.height - aspect) > 1e-3) {
                        return `viewBox must have aspect ${aspect.toFixed(4)} (got ${BOX.width}x${BOX.height})`;
                    }
                    for (const ELEMENT of DOCUMENT.querySelectorAll('*')) {
                        for (const ATTRIBUTE of ELEMENT.attributes) {
                            if (
                                ATTRIBUTE.localName === 'href' &&
                                !ATTRIBUTE.value.startsWith('#') &&
                                !ATTRIBUTE.value.startsWith('data:')
                            ) {
                                return `must not reference external files (${ATTRIBUTE.value})`;
                            }
                        }
                    }
                    return null;
                },
                { svg: SVG, aspect: ASPECT },
            );
            if (PROBLEM) {
                fail(`${LABEL} SVG ${PROBLEM}`);
            }
        }
        const IMAGES_OUT = new Map();
        for (const {
            file: FILE,
            svg: SVG,
            width: WIDTH,
            height: HEIGHT,
            background: BACKGROUND,
            inset: INSET,
        } of jobs) {
            await PAGE.setViewportSize({ width: WIDTH, height: HEIGHT });
            const BOX = { width: WIDTH * INSET, height: HEIGHT * INSET };
            await PAGE.setContent(
                `<!doctype html><style>html,body{margin:0;width:${WIDTH}px;height:${HEIGHT}px;overflow:hidden;` +
                    `background:${BACKGROUND ?? 'transparent'}}img{position:absolute;display:block;` +
                    `left:${(WIDTH - BOX.width) / 2}px;top:${(HEIGHT - BOX.height) / 2}px;` +
                    `width:${BOX.width}px;height:${BOX.height}px}</style>` +
                    `<img alt="" src="data:image/svg+xml;base64,${Buffer.from(SVG).toString('base64')}">`,
            );
            const DECODED = await PAGE.evaluate(() =>
                document.images[0].decode().then(
                    () => null,
                    (error) => String(error),
                ),
            );
            if (DECODED !== null) {
                fail(`cannot draw SVG for ${FILE}: ${DECODED}`);
            }
            IMAGES_OUT.set(
                FILE,
                await PAGE.screenshot({
                    type: 'png',
                    omitBackground: BACKGROUND === null,
                    clip: { x: 0, y: 0, width: WIDTH, height: HEIGHT },
                }),
            );
        }
        return IMAGES_OUT;
    } finally {
        await BROWSER.close();
    }
}

function headBlock(html, tags) {
    const START = html.indexOf(MARKER_START);
    const END = html.indexOf(MARKER_END);
    if (
        START < 0 ||
        END < START ||
        html.indexOf(MARKER_START, START + 1) >= 0 ||
        html.indexOf(MARKER_END, END + 1) >= 0
    ) {
        fail(`html needs exactly one "${MARKER_START}" followed by one "${MARKER_END}" inside <head>`);
    }
    const HEAD_END = html.search(/<\/head\s*>/i);
    if (HEAD_END < 0 || END > HEAD_END) {
        fail('the bloom-pwa markers must be inside <head>');
    }
    const BEFORE = html.slice(0, START);
    const AFTER = html.slice(END + MARKER_END.length);
    // 마커 밖에 같은 역할의 태그가 있으면 어느 쪽이 쓰일지 모르므로 지우라고 알립니다.
    const CONFLICTS = (BEFORE + AFTER).match(
        /<link\b[^>]*\brel\s*=\s*["']?(?:manifest|icon|apple-touch-icon)\b[^>]*>|<meta\b[^>]*\b(?:name\s*=\s*["']?(?:theme-color|description|apple-mobile-web-app-title|twitter:[\w:-]+)|property\s*=\s*["']?og:[\w:-]+)\b[^>]*>/gi,
    );
    if (CONFLICTS) {
        fail(`remove these tags outside the bloom-pwa markers (they are generated): ${CONFLICTS.join(' ')}`);
    }
    const EOL = html.includes('\r\n') ? '\r\n' : '\n';
    const INDENT = BEFORE.slice(BEFORE.lastIndexOf('\n') + 1);
    if (INDENT.trim() !== '') {
        fail(`"${MARKER_START}" must be on its own line`);
    }
    return [BEFORE + MARKER_START, ...tags.map((tag) => INDENT + tag), INDENT + MARKER_END + AFTER].join(EOL);
}

// sw.js 본문입니다. 함수 소스를 그대로 sw.js에 써서 설정(config)과 함께 실행합니다.
// 페이지를 읽을 때마다 서버에 다시 확인하고, 캐시는 오프라인일 때만 씁니다. 설치 때 아무것도 받지 않습니다.
// localStorage·IndexedDB는 다루지 않습니다. 저장은 게임과 save 모듈이 소유합니다.
function serviceWorker(config) {
    const PREFIX = `bloom-pwa:${new URL(self.registration.scope).pathname}:`;
    const RUNTIME = PREFIX + 'runtime';
    const GAMEKIT_CACHE = PREFIX + 'gamekit';
    const GAMEKIT = new RegExp(config.gamekit);
    self.addEventListener('install', () => {
        // 새 sw.js는 기다리지 않고 바로 이어받습니다. 받을 파일 목록(precache)은 없습니다.
        self.skipWaiting();
    });
    self.addEventListener('activate', (event) => {
        event.waitUntil(
            Promise.all([
                self.clients.claim(),
                caches
                    .keys()
                    .then((keys) =>
                        Promise.all(
                            keys
                                .filter((key) => key.startsWith(PREFIX) && key !== RUNTIME && key !== GAMEKIT_CACHE)
                                .map((key) => caches.delete(key)),
                        ),
                    ),
            ]),
        );
    });
    async function offline(request, error) {
        const STORE = await caches.open(RUNTIME);
        const NAVIGATE = request.mode === 'navigate';
        let response = await STORE.match(request, { ignoreSearch: NAVIGATE });
        const ADDRESS = new URL(request.url);
        if (!response && NAVIGATE && ADDRESS.pathname.endsWith('/')) {
            response = await STORE.match(new URL('index.html', ADDRESS).href);
        }
        if (!response) {
            throw error;
        }
        return response;
    }
    async function sameOrigin(event) {
        const REQUEST = event.request;
        let response;
        try {
            // GitHub Pages의 max-age=600 동안 HTTP cache의 이전 파일이 섞이지 않도록 매번 서버에 확인합니다.
            response = await fetch(REQUEST, { cache: 'no-cache' });
        } catch (error) {
            return offline(REQUEST, error);
        }
        // 206(Range)·redirect·오류 응답은 오프라인 사본으로 두지 않습니다.
        if (response.status === 200) {
            const COPY = response.clone();
            event.waitUntil(caches.open(RUNTIME).then((store) => store.put(REQUEST, COPY)));
        }
        return response;
    }
    async function gamekit(request) {
        const STORE = await caches.open(GAMEKIT_CACHE);
        const CACHED = await STORE.match(request);
        if (CACHED) {
            return CACHED;
        }
        const RESPONSE = await fetch(request);
        if (RESPONSE.ok) {
            await STORE.put(request, RESPONSE.clone());
        }
        return RESPONSE;
    }
    self.addEventListener('fetch', (event) => {
        const REQUEST = event.request;
        if (REQUEST.method !== 'GET') {
            return;
        }
        if (new URL(REQUEST.url).origin === self.location.origin) {
            event.respondWith(sameOrigin(event));
        } else if (GAMEKIT.test(REQUEST.url)) {
            event.respondWith(gamekit(REQUEST));
        }
        // 그 밖의 cross-origin 요청(relay·광고 등)은 손대지 않고 네트워크로 보냅니다.
    });
}

/**
 * SVG 원본과 설정에서 PWA 파일을 만듭니다. 경로는 현재 작업 폴더(게임 루트) 기준입니다.
 * @returns {Promise<{ files: string[], changed: string[] }>} out 기준 생성 파일과 바뀐(check면 바뀔) 파일
 */
export async function buildPwa(options) {
    const {
        chromium: CHROMIUM,
        name: NAME,
        shortName: SHORT_NAME,
        description: DESCRIPTION,
        lang: LANG,
        icon: ICON,
        maskableIcon: MASKABLE_ICON,
        share: SHARE,
        themeColor: THEME_COLOR,
        backgroundColor: BACKGROUND_COLOR,
        startUrl: START_URL,
        scope: SCOPE,
        siteUrl: SITE_URL,
        html: HTML,
        out: OUT,
        check: CHECK,
    } = readOptions(options);
    const CWD = process.cwd();
    const OUT_DIR = resolve(CWD, OUT);
    const HTML_PATH = resolve(CWD, HTML);
    const HTML_FILE = inside(OUT_DIR, HTML_PATH, 'html');

    // start_url과 scope는 manifest(out 루트) 기준 상대 주소입니다.
    const BASE = new URL('https://pwa.invalid/');
    const START = new URL(START_URL, BASE);
    const SCOPE_URL = new URL(SCOPE, BASE);
    if (START.origin !== BASE.origin || SCOPE_URL.origin !== BASE.origin) {
        fail('startUrl and scope must be relative to the out folder');
    }
    if (!SCOPE_URL.pathname.endsWith('/') || !START.pathname.startsWith(SCOPE_URL.pathname)) {
        fail('scope must be a folder ("./") that contains startUrl');
    }

    const SOURCES = {
        icon: { svg: await readSource(CWD, ICON, 'icon'), aspect: 1 },
        share: { svg: await readSource(CWD, SHARE, 'share'), aspect: SHARE_SIZE.width / SHARE_SIZE.height },
    };
    if (MASKABLE_ICON !== undefined) {
        SOURCES.maskableIcon = { svg: await readSource(CWD, MASKABLE_ICON, 'maskableIcon'), aspect: 1 };
    }
    // maskable과 apple-touch-icon은 불투명한 같은 구성입니다(iOS는 투명 영역을 검게 칠합니다).
    const OPAQUE = SOURCES.maskableIcon
        ? { svg: SOURCES.maskableIcon.svg, inset: 1 }
        : { svg: SOURCES.icon.svg, inset: MASKABLE_SAFE_ZONE };
    const PNG = await rasterize(CHROMIUM, SOURCES, [
        { file: IMAGES.icon192, svg: SOURCES.icon.svg, width: 192, height: 192, background: null, inset: 1 },
        { file: IMAGES.icon512, svg: SOURCES.icon.svg, width: 512, height: 512, background: null, inset: 1 },
        { file: IMAGES.maskable, ...OPAQUE, width: 512, height: 512, background: BACKGROUND_COLOR },
        { file: IMAGES.apple, ...OPAQUE, width: 180, height: 180, background: BACKGROUND_COLOR },
        { file: IMAGES.share, svg: SOURCES.share.svg, ...SHARE_SIZE, background: null, inset: 1 },
    ]);

    const OUTPUTS = new Map(PNG);
    OUTPUTS.set(
        MANIFEST_FILE,
        Buffer.from(
            JSON.stringify(
                {
                    id: START_URL,
                    name: NAME,
                    short_name: SHORT_NAME,
                    description: DESCRIPTION,
                    lang: LANG,
                    start_url: START_URL,
                    scope: SCOPE,
                    display: 'standalone',
                    background_color: BACKGROUND_COLOR,
                    theme_color: THEME_COLOR,
                    icons: [
                        { src: IMAGES.icon192, sizes: '192x192', type: 'image/png', purpose: 'any' },
                        { src: IMAGES.icon512, sizes: '512x512', type: 'image/png', purpose: 'any' },
                        { src: IMAGES.maskable, sizes: '512x512', type: 'image/png', purpose: 'maskable' },
                    ],
                },
                null,
                2,
            ) + '\n',
        ),
    );

    const HREF = (file) => POSIX(relative(dirname(HTML_PATH), resolve(OUT_DIR, file)));
    const PAGE_URL = new URL(HTML_FILE.replace(/(^|\/)index\.html$/, '$1'), SITE_URL).href;
    const TAGS = [
        `<link rel="manifest" href="${ESCAPE(HREF(MANIFEST_FILE))}">`,
        `<meta name="theme-color" content="${ESCAPE(THEME_COLOR)}">`,
        `<meta name="description" content="${ESCAPE(DESCRIPTION)}">`,
        `<link rel="icon" type="image/png" sizes="192x192" href="${ESCAPE(HREF(IMAGES.icon192))}">`,
        `<link rel="apple-touch-icon" href="${ESCAPE(HREF(IMAGES.apple))}">`,
        `<meta name="apple-mobile-web-app-title" content="${ESCAPE(SHORT_NAME)}">`,
        '<meta property="og:type" content="website">',
        `<meta property="og:url" content="${ESCAPE(PAGE_URL)}">`,
        `<meta property="og:title" content="${ESCAPE(NAME)}">`,
        `<meta property="og:description" content="${ESCAPE(DESCRIPTION)}">`,
        `<meta property="og:image" content="${ESCAPE(new URL(IMAGES.share, SITE_URL).href)}">`,
        `<meta property="og:image:width" content="${SHARE_SIZE.width}">`,
        `<meta property="og:image:height" content="${SHARE_SIZE.height}">`,
        '<meta name="twitter:card" content="summary_large_image">',
    ];
    OUTPUTS.set(HTML_FILE, Buffer.from(headBlock(await readSource(CWD, HTML, 'html'), TAGS), 'utf8'));

    const CONFIG = { gamekit: `^${GAMEKIT_URL.source}$` };
    OUTPUTS.set(
        WORKER_FILE,
        Buffer.from(
            '// bloom-gamekit pwa가 생성한 파일입니다. 직접 고치지 말고 생성 스크립트를 다시 실행하세요.\n' +
                `(${serviceWorker.toString()})(${JSON.stringify(CONFIG, null, 4)});\n`,
        ),
    );

    const CHANGED = [];
    for (const [FILE, BYTES] of OUTPUTS) {
        let current = null;
        try {
            current = await readFile(resolve(OUT_DIR, FILE));
        } catch (error) {
            if (error.code !== 'ENOENT') {
                throw error;
            }
        }
        if (current === null || !CANONICAL(FILE, current).equals(CANONICAL(FILE, BYTES))) {
            CHANGED.push(FILE);
        }
    }
    CHANGED.sort();
    if (CHECK) {
        if (CHANGED.length > 0) {
            fail(`generated PWA files are out of date; run the generator without check: ${CHANGED.join(', ')}`);
        }
    } else {
        for (const FILE of CHANGED) {
            const TARGET = resolve(OUT_DIR, FILE);
            await mkdir(dirname(TARGET), { recursive: true });
            await writeFile(TARGET, OUTPUTS.get(FILE));
        }
    }
    return { files: [...OUTPUTS.keys()].sort(), changed: CHANGED };
}

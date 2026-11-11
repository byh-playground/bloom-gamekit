// 디버그 장면 주소 하나를 브라우저로 열어 상태·캡처를 뽑는 Node 도구입니다(`dist/debug-scene.mjs`). 시험이 아닙니다:
// 결과를 통과·실패로 판정하지 않습니다. 게임은 Playwright `chromium`과 체크아웃 하나를 띄우는 `serve`만 넘깁니다.
//
//   node scripts/debug-scene.cjs "<query>" [--ticks N] [--state <json>] [--capture out.png]
//                                [--compare <checkout>] [--compare-query "<query>"] [--repeat N] [--heap] [--gpu] [--json]
//
// <query>는 주소의 `?debug=1&` 뒤입니다. 장면이 `__bloomDebug.ready || error`가 될 때까지 기다린 뒤 `step(N)`,
// `state(<json>)`을 읽습니다. --compare/--compare-query가 있으면 두 쪽을 라운드마다 순서를 바꿔 가며 번갈아 돌리고
// 요약 표를 냅니다(--json이면 원시 기록도). 기본은 SwiftShader(같은 주소의 캡처가 픽셀까지 같음), --gpu는 ANGLE D3D11.
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const ANGLE = Object.freeze({
    swiftshader: Object.freeze({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] }),
    gpu: Object.freeze({
        args: ['--use-angle=d3d11', '--ignore-gpu-blocklist', '--enable-gpu'],
        ignoreDefaultArgs: ['--enable-unsafe-swiftshader'],
    }),
});
const USAGE =
    'usage: "<query>" [--ticks N] [--state <json>] [--capture out.png] [--compare <checkout>] ' +
    '[--compare-query "<query>"] [--repeat N] [--heap] [--gpu] [--json]';
// 힙 표본 간격(바이트). 작을수록 정확하고 느립니다.
const HEAP_SAMPLING_BYTES = 1024;

function readArguments(argv) {
    const [QUERY, ...REST] = argv;
    if (!QUERY || QUERY.startsWith('--')) {
        throw new Error(USAGE);
    }
    const OPTIONS = {
        query: QUERY,
        ticks: 0,
        state: undefined,
        capture: null,
        compare: null,
        compareQuery: null,
        repeat: 1,
        heap: false,
        gpu: false,
        json: false,
    };
    for (let index = 0; index < REST.length; index++) {
        const NAME = REST[index];
        const VALUE = () => {
            const TEXT = REST[++index];
            if (TEXT === undefined) {
                throw new Error(`${NAME} needs a value`);
            }
            return TEXT;
        };
        if (NAME === '--gpu' || NAME === '--heap' || NAME === '--json') {
            OPTIONS[NAME.slice(2)] = true;
        } else if (NAME === '--ticks' || NAME === '--repeat') {
            const COUNT = Number(VALUE());
            if (!Number.isSafeInteger(COUNT) || COUNT < (NAME === '--repeat' ? 1 : 0)) {
                throw new Error(`${NAME} needs an integer`);
            }
            OPTIONS[NAME.slice(2)] = COUNT;
        } else if (NAME === '--state') {
            OPTIONS.state = JSON.parse(VALUE());
        } else if (NAME === '--capture') {
            OPTIONS.capture = resolve(VALUE());
        } else if (NAME === '--compare') {
            OPTIONS.compare = resolve(VALUE());
        } else if (NAME === '--compare-query') {
            OPTIONS.compareQuery = VALUE();
        } else {
            throw new Error(`unknown option ${NAME}\n${USAGE}`);
        }
    }
    if (OPTIONS.heap && !OPTIONS.ticks) {
        throw new Error('--heap measures the ticks of --ticks N; give N > 0');
    }
    return OPTIONS;
}

// 같은 커밋이라도 작업 트리에 미커밋 변경이 있으면 다른 코드입니다. 표에 둘 다 보입니다.
function describeCheckout(root) {
    const GIT = (args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
    return { root, commit: GIT(['rev-parse', '--short', 'HEAD']), dirty: GIT(['status', '--porcelain']) !== '' };
}

// 표본 힙 프로파일러가 구간 동안 할당한 바이트(이미 수거된 것 포함)를 추정합니다.
async function sampleAllocation(cdp, operation) {
    await cdp.send('HeapProfiler.startSampling', {
        samplingInterval: HEAP_SAMPLING_BYTES,
        includeObjectsCollectedByMajorGC: true,
        includeObjectsCollectedByMinorGC: true,
    });
    await operation();
    const { profile: PROFILE } = await cdp.send('HeapProfiler.stopSampling');
    let total = 0;
    const PENDING = [PROFILE.head];
    while (PENDING.length) {
        const NODE = PENDING.pop();
        total += NODE.selfSize;
        PENDING.push(...NODE.children);
    }
    return total;
}

async function runScene(browser, side, options, capture, { viewport, ready }) {
    const CONTEXT = await browser.newContext({ ...(viewport ? { viewport } : {}), deviceScaleFactor: 1 });
    const PAGE = await CONTEXT.newPage(),
        PAGE_ERRORS = [];
    PAGE.on('pageerror', (error) => PAGE_ERRORS.push(error.message));
    try {
        await side.site.route?.(PAGE);
        const URL_TEXT = side.site.url;
        await PAGE.goto(`${URL_TEXT}${URL_TEXT.includes('?') ? '&' : '?'}debug=1&${side.query}`, {
            waitUntil: 'domcontentloaded',
        });
        await PAGE.waitForFunction(() => globalThis.__bloomDebug?.error || globalThis.__bloomDebug?.ready, null, {
            timeout: 600_000,
            polling: 100,
        });
        const ERROR = await PAGE.evaluate(() => globalThis.__bloomDebug.error);
        if (ERROR) {
            throw new Error(ERROR);
        }
        if (ready) {
            await PAGE.waitForFunction(ready, null, { timeout: 600_000, polling: 100 });
        }
        const STEP = (count) =>
            PAGE.evaluate((n) => globalThis.__bloomDebug.step(n), count, {
                timeout: 600_000,
            });
        let heap;
        if (options.heap) {
            // step(n)은 n틱 뒤 한 번 그립니다. 같은 상태를 한 번 더 그리는 step(0)을 따로 재어 빼면 틱만의 할당입니다.
            const CDP = await CONTEXT.newCDPSession(PAGE);
            const STEPPED = await sampleAllocation(CDP, () => STEP(options.ticks));
            const RENDER = await sampleAllocation(CDP, () => STEP(0));
            await CDP.detach();
            heap = {
                stepBytes: STEPPED,
                renderBytes: RENDER,
                perTickBytes: Math.round((STEPPED - RENDER) / options.ticks),
            };
        } else if (options.ticks) {
            await STEP(options.ticks);
        }
        const STATE = await PAGE.evaluate((state) => globalThis.__bloomDebug.state(state), options.state);
        const HASH = await PAGE.evaluate(() => globalThis.__bloomDebug.hash());
        if (capture) {
            mkdirSync(dirname(capture), { recursive: true });
            await PAGE.screenshot({ path: capture, animations: 'disabled' });
        }
        return {
            state: STATE,
            hash: HASH ?? null,
            ...(heap ? { heap } : {}),
            ...(capture ? { capture } : {}),
            ...(PAGE_ERRORS.length ? { pageErrors: PAGE_ERRORS } : {}),
        };
    } finally {
        await CONTEXT.close();
    }
}

const PICK = (value, path) => path.split('.').reduce((item, key) => item?.[key], value);

/**
 * 디버그 장면 주소를 열어 상태 JSON·캡처·두 쪽 비교를 냅니다. 게임 저장소의 얇은 스크립트가 부릅니다.
 * @param {object} options
 * @param {import('playwright').BrowserType} options.chromium 게임의 Playwright chromium(이 모듈은 번들하지 않음)
 * @param {string[]} options.argv 명령줄 인자(`process.argv.slice(2)`)
 * @param {string} options.root 이 체크아웃의 경로
 * @param {(root: string) => Promise<{url: string, route?: (page: object) => unknown, close: () => unknown}>} options.serve
 *   체크아웃 하나를 띄워 장면 페이지 주소와(고정 GameKit을 로컬로 돌리는) route, 닫기를 돌려줍니다.
 * @param {() => unknown} [options.ready] `__bloomDebug.ready` 뒤 페이지에서 더 기다릴 조건(예: 로딩 화면이 걷힘)
 * @param {string[]} [options.fields] 비교 표에 넣을 state 필드 경로(`'tickMs.mean'`처럼 점으로 구분)
 * @param {{width: number, height: number}} [options.viewport]
 */
export async function runDebugScene({ chromium, argv, root, serve, ready, fields = [], viewport }) {
    if (typeof chromium?.launch !== 'function' || typeof serve !== 'function' || typeof root !== 'string') {
        throw new TypeError('runDebugScene needs chromium, root and serve');
    }
    const OPTIONS = readArguments(argv);
    const COMPARING = OPTIONS.compare !== null || OPTIONS.compareQuery !== null;
    const ROOTS = [resolve(root), ...(COMPARING ? [OPTIONS.compare ?? resolve(root)] : [])];
    const SITES = new Map();
    let browser;
    try {
        for (const ROOT of new Set(ROOTS)) {
            SITES.set(ROOT, { ...describeCheckout(ROOT), site: await serve(ROOT) });
        }
        const SIDES = ROOTS.map((sideRoot, index) => ({
            name: index ? 'B' : 'A',
            ...SITES.get(sideRoot),
            query: index && OPTIONS.compareQuery !== null ? OPTIONS.compareQuery : OPTIONS.query,
        }));
        browser = await chromium.launch(OPTIONS.gpu ? ANGLE.gpu : ANGLE.swiftshader);
        const RUNS = [];
        for (let round = 0; round < (COMPARING ? OPTIONS.repeat : 1); round++) {
            // 라운드마다 먼저 도는 쪽을 바꿔 워밍업·부하 변화가 한쪽에 몰리지 않게 합니다.
            const ORDER = round % 2 ? [...SIDES].reverse() : SIDES;
            for (const SIDE of ORDER) {
                const CAPTURE =
                    OPTIONS.capture && round === 0
                        ? SIDE.name === 'A'
                            ? OPTIONS.capture
                            : OPTIONS.capture.replace(/(\.[^.\\/]+)?$/, '-compare$1')
                        : null;
                const RESULT = await runScene(browser, SIDE, OPTIONS, CAPTURE, { viewport, ready });
                RUNS.push({
                    side: SIDE.name,
                    round: round + 1,
                    root: SIDE.root,
                    commit: SIDE.commit,
                    dirty: SIDE.dirty,
                    query: SIDE.query,
                    gpu: OPTIONS.gpu ? 'd3d11' : 'swiftshader',
                    ...RESULT,
                });
            }
        }
        if (!COMPARING) {
            const [RUN] = RUNS;
            const BRIEF = {
                ...RUN.state,
                ...(RUN.heap ? { heap: RUN.heap } : {}),
                ...(RUN.pageErrors ? { pageErrors: RUN.pageErrors } : {}),
            };
            console.log(JSON.stringify(OPTIONS.json ? RUN : BRIEF, null, 2));
            return RUNS;
        }
        if (OPTIONS.json) {
            console.log(JSON.stringify(RUNS, null, 2));
        }
        for (const SIDE of SIDES) {
            console.log(
                `${SIDE.name}: ${SIDE.root} @ ${SIDE.commit}${SIDE.dirty ? ' (미커밋 변경 있음)' : ''} ?${SIDE.query}`,
            );
        }
        console.table(
            RUNS.map((run) => ({
                run: `${run.side} #${run.round}`,
                hash: run.hash,
                ...Object.fromEntries(fields.map((field) => [field, PICK(run.state, field)])),
                ...(run.heap ? { 'heap B/tick': run.heap.perTickBytes, 'render B': run.heap.renderBytes } : {}),
                ...(run.pageErrors ? { pageErrors: run.pageErrors.length } : {}),
            })),
        );
        return RUNS;
    } finally {
        await browser?.close();
        for (const SITE of SITES.values()) {
            await SITE.site.close();
        }
    }
}

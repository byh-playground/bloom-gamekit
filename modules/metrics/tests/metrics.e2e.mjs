import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

// 실제 Workers 런타임(wrangler dev)과 로컬 D1에 bm 예제의 '지표' 탭을 연결한다. 데스크톱(마우스)과 터치 에뮬레이션에서
// 세션 시작 → 랠리 입력 → 경기 끝 → 서버 집계 → 탭 숨김(에뮬레이션) → 페이지 닫힘(sendBeacon)을 거쳐 D1 행을 직접 읽는다.
// 이어서 rollback Session 두 참가자가 같은 matchId로 보낸 경기가 한 행만 남고, 저장된 replay로 같은 hash를 다시 계산하는지 본다.
// 끝으로 페이지가 보여 준 접속 키를 owners에 넣어 지난 세션이 소급해 '나'로 빠지는지 본다.
// D1에는 원본만 있으므로 플레이 시간·체류 시간·회선·일별 값·완주율은 모두 /stats·/daily가 조회 때 계산한 값을 본다.
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const SERVER_DIR = resolve(ROOT, 'modules/metrics/server');
const WRANGLER = resolve(ROOT, 'node_modules/wrangler/bin/wrangler.js');
const GAME = 'gamekit-example';
const SECRET = 'e2e-secret';
const READ_SECRET = 'e2e-read-secret';
const STARTED = performance.now();
// 배포물을 그대로 씁니다(npm run build 필요). dist/metrics.js는 createMetrics 전에는 document를 읽지 않습니다.
const { reviveBytes: REVIVE_BYTES } = await import(pathToFileURL(resolve(ROOT, 'dist/metrics.js')).href);
const { playReplay: PLAY_REPLAY } = await import(pathToFileURL(resolve(ROOT, 'dist/replay.js')).href);

// 짧은 경로: miniflare의 D1 파일 경로가 Windows 경로 길이 상한을 넘지 않게 합니다.
const PERSIST = await mkdtemp(resolve(tmpdir(), 'bmx-'));
const CHILDREN = new Set();
let browser = null;
let site = null;

function freePort() {
    return new Promise((done, fail) => {
        const PROBE = createNetServer();
        PROBE.once('error', fail);
        PROBE.listen(0, '127.0.0.1', () => {
            const { port: PORT } = PROBE.address();
            PROBE.close(() => done(PORT));
        });
    });
}

function runWrangler(args, readyText) {
    return new Promise((done, fail) => {
        const CHILD = spawn(process.execPath, [WRANGLER, ...args, '-c', 'wrangler.toml', '--persist-to', PERSIST], {
            cwd: SERVER_DIR,
            env: { ...process.env, WRANGLER_SEND_METRICS: 'false', NO_COLOR: '1' },
            windowsHide: true,
            detached: process.platform !== 'win32',
        });
        CHILDREN.add(CHILD);
        let output = '';
        const READ = (chunk) => {
            output += chunk;
            if (readyText && output.includes(readyText)) {
                done(CHILD);
            }
        };
        CHILD.stdout.on('data', READ);
        CHILD.stderr.on('data', READ);
        CHILD.on('exit', (code) => {
            CHILDREN.delete(CHILD);
            if (!readyText && code === 0) {
                done(CHILD);
            } else {
                fail(new Error(`wrangler ${args[0]} exited ${code}:\n${output.slice(-2000)}`));
            }
        });
    });
}

function stopChild(child) {
    if (child.exitCode !== null) {
        return;
    }
    if (process.platform === 'win32') {
        spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    } else {
        // wrangler의 CLI wrapper뿐 아니라 stdout/stderr를 물려받은 Workers도 함께 닫습니다.
        process.kill(-child.pid, 'SIGKILL');
    }
}

async function until(read, label, timeoutMs = 15000) {
    const DEADLINE = performance.now() + timeoutMs;
    for (;;) {
        const VALUE = await read();
        if (VALUE) {
            return VALUE;
        }
        if (performance.now() > DEADLINE) {
            throw new Error('timed out waiting for ' + label);
        }
        await new Promise((done) => setTimeout(done, 100));
    }
}

async function openDatabase(readOnly = true) {
    const DIR = resolve(PERSIST, 'v3/d1/miniflare-D1DatabaseObject');
    const FILE = (await readdir(DIR)).find((name) => name.endsWith('.sqlite') && name !== 'metadata.sqlite');
    return new DatabaseSync(resolve(DIR, FILE), { readOnly });
}

// 테스트 안에서 rollback Session과 Node의 playReplay가 함께 쓰는 1바이트 입력 시뮬레이션입니다.
function createCounterAdapter() {
    let state = { tick: 0, sum: 0 };
    return {
        saveInto: (out) => out.write(new TextEncoder().encode(JSON.stringify(state))),
        load(bytes) {
            state = JSON.parse(new TextDecoder().decode(bytes));
        },
        validateSnapshot: () => true,
        step({ inputs }) {
            for (const { input: INPUT } of inputs) {
                state.sum += INPUT[0] * (state.tick + 1);
            }
            state.tick++;
        },
    };
}

try {
    const WORKER_PORT = await freePort();
    // 운영과 같은 migrations를 먼저 적용합니다. 동시에 띄우면 두 workerd가 같은 D1 파일을 열다 SQLITE_IOERR로 가끔 실패합니다.
    await runWrangler(['d1', 'migrations', 'apply', 'bloom-metrics', '--local']);
    await runWrangler(
        [
            'dev',
            '--port',
            String(WORKER_PORT),
            '--ip',
            '127.0.0.1',
            '--var',
            'IP_KEY_SECRET:' + SECRET,
            '--var',
            'METRICS_READ_SECRET:' + READ_SECRET,
        ],
        'Ready on',
    );
    const API = `http://127.0.0.1:${WORKER_PORT}`;

    const READ = (path, options = {}) =>
        fetch(API + path, {
            ...options,
            headers: { ...options.headers, Authorization: `Bearer ${READ_SECRET}` },
        });
    for (const PATH of ['/stats?game=test', '/daily?game=test', '/whoami']) {
        assert.equal((await fetch(API + PATH)).status, 401, `${PATH} needs authentication`);
        assert.equal(
            (await fetch(API + PATH, { headers: { Authorization: 'Bearer wrong' } })).status,
            401,
            `${PATH} rejects a wrong key`,
        );
    }
    const { default: WORKER } = await import('../server/worker.js');
    assert.equal(
        (await WORKER.fetch(new Request(API + '/whoami'), { IP_KEY_SECRET: SECRET })).status,
        503,
        'missing read secret fails closed',
    );

    // 계약 밖 요청은 저장하지 않고 이유와 함께 거절합니다.
    const POST = (body) => fetch(API + '/batch', { method: 'POST', body });
    assert.deepEqual(
        [(await POST('{"schemaVersion":1}')).status, (await POST('not json')).status],
        [400, 400],
        'schema and JSON errors are rejected',
    );
    assert.equal((await POST('x'.repeat(1000001))).status, 413, 'a batch over 1MB is rejected');
    assert.equal((await READ('/stats')).status, 400, 'stats needs a game name');
    assert.equal((await READ(`/daily?game=${GAME}&days=91`)).status, 400, 'daily covers at most 90 days');
    const PREFLIGHT = await fetch(API + '/batch', { method: 'OPTIONS' });
    assert.equal(PREFLIGHT.headers.get('access-control-allow-origin'), '*', 'CORS preflight answers any game page');
    assert.match(
        PREFLIGHT.headers.get('access-control-allow-headers'),
        /authorization/i,
        'authenticated reads permit preflight',
    );
    // 운영에서는 Cloudflare가 CF-Connecting-IP를 붙입니다. 로컬 wrangler dev는 요청 헤더를 그대로 넘깁니다.
    const KEY_OF = async (ip) => (await (await READ('/whoami', { headers: { 'CF-Connecting-IP': ip } })).json()).ipKey;
    const [V6_A, V6_B, V6_OTHER, V4] = await Promise.all(
        ['2001:db8:1:2:aaaa::1', '2001:db8:1:2:bbbb::7', '2001:db8:1:3::1', '203.0.113.9'].map(KEY_OF),
    );
    assert.match(V4, /^[0-9a-f]{32}$/, 'the connection key is a 16-byte hex HMAC');
    assert.equal(V6_A, V6_B, 'IPv6 addresses on the same /64 line share one key');
    assert.notEqual(V6_A, V6_OTHER, 'another /64 line is another key');

    site = createServer(async (request, response) => {
        const PATHNAME = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
        const FILE = resolve(ROOT, '.' + PATHNAME);
        if (!FILE.startsWith(ROOT.replace(/[\\/]$/, '') + sep)) {
            response.writeHead(403).end();
            return;
        }
        try {
            const TYPE =
                { '.html': 'text/html', '.js': 'text/javascript' }[extname(FILE)] ?? 'application/octet-stream';
            response.writeHead(200, { 'Content-Type': TYPE + ';charset=utf-8' }).end(await readFile(FILE));
        } catch {
            response.writeHead(404).end();
        }
    });
    await new Promise((done) => site.listen(0, '127.0.0.1', done));
    const PAGE_PATH = `http://127.0.0.1:${site.address().port}/modules/bm/examples/index.html`;
    const PAGE_HASH = `#tab=metrics&server=${API}&seed=7`;
    const PAGE_URL = PAGE_PATH + PAGE_HASH;
    browser = await chromium.launch({ headless: true });

    // 두 기기 모두 로컬 페이지라 '개발'로 셉니다. 소유자 목록이 비어 있어 아직 '나'는 없습니다.
    const DEVICES = [
        ['desktop', { viewport: { width: 1280, height: 800 } }],
        ['touch', { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 }],
    ];
    const SESSIONS = [];
    let ownerKey = null;
    for (const [NAME, OPTIONS] of DEVICES) {
        const CONTEXT = await browser.newContext(OPTIONS);
        const PAGE = await CONTEXT.newPage();
        const ERRORS = [];
        PAGE.on('pageerror', (error) => ERRORS.push(error.message));
        await PAGE.goto(PAGE_URL);
        await PAGE.waitForSelector('#panel-metrics:not([hidden])');
        // 세션 시작 전부터 페이지 시계를 고정합니다. 플레이 시간·heartbeat·플러시 간격을 실제 시간 없이 진행합니다.
        await PAGE.clock.install({ time: new Date('2026-11-04T00:00:00Z') });
        await PAGE.clock.pauseAt(new Date('2026-11-04T00:00:01Z'));
        const PRESS = (selector) => (NAME === 'touch' ? PAGE.tap(selector) : PAGE.click(selector));
        const OUTPUT = async () => JSON.parse(await PAGE.textContent('#metrics-output'));

        const LAYOUT = await PAGE.evaluate(() => ({
            panel: !document.querySelector('#panel-metrics').hidden,
            overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
            shortest: Math.min(
                ...[...document.querySelectorAll('#panel-metrics button')].map((b) => b.getBoundingClientRect().height),
            ),
        }));
        assert.ok(LAYOUT.panel, `${NAME}: #tab=metrics opens the metrics tab`);
        assert.ok(LAYOUT.overflow <= 0, `${NAME}: no horizontal scroll`);
        assert.ok(LAYOUT.shortest >= 56, `${NAME}: buttons are at least 56px tall`);

        await PAGE.fill('#metrics-read-secret', READ_SECRET);
        await PRESS('#metrics-connect');
        for (let hit = 0; hit < 3; hit++) {
            await PRESS('#metrics-hit');
        }
        await PAGE.clock.runFor(5000);
        await PRESS('#metrics-end');
        const COUNT = SESSIONS.length + 1;
        const AFTER_MATCH = await until(async () => {
            const STATE = await OUTPUT();
            return STATE.server?.dev.matches === COUNT && STATE;
        }, `${NAME} match reaches the server as dev`);
        assert.equal(AFTER_MATCH.server.dev.sessions, COUNT, `${NAME}: the server counts this session as dev`);
        assert.equal(AFTER_MATCH.server.users.sessions, 0, `${NAME}: local sessions are not users`);
        assert.equal(AFTER_MATCH.hits, 0, `${NAME}: a new match starts after the record`);
        await PRESS('#metrics-whoami');
        const { whoami: WHOAMI } = await until(async () => {
            const STATE = await OUTPUT();
            return STATE.whoami && STATE;
        }, `${NAME} connection key`);
        assert.match(WHOAMI.ipKey, /^[0-9a-f]{32}$/, `${NAME}: the page shows this line's connection key`);
        assert.equal(WHOAMI.owner, null, `${NAME}: the key is not an owner yet`);
        ownerKey ??= WHOAMI.ipKey;
        assert.equal(WHOAMI.ipKey, ownerKey, `${NAME}: the same line gives the same key`);

        // 에뮬레이션: headless Chromium은 탭 숨김을 바꾸지 못하므로 visibilityState만 바꿔 같은 이벤트를 보냅니다.
        const SET_HIDDEN = (hidden) =>
            PAGE.evaluate((value) => {
                if (value) {
                    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
                } else {
                    delete document.visibilityState;
                }
                document.dispatchEvent(new Event('visibilitychange'));
            }, hidden);
        const PLAYED = await PAGE.evaluate(() => window.metricsExample.metrics.playMs);
        assert.equal(PLAYED, 5000, `${NAME}: play time is the visible time on the page clock`);
        // 모바일 망 유실 흉내: 숨길 때의 beacon 요청만 망에서 끊습니다. sendBeacon은 보냈다고 답하지만 서버에 닿지 않습니다.
        const DROP_BEACON = (route) =>
            route.request().resourceType() === 'ping' ? route.abort('internetdisconnected') : route.continue();
        await PAGE.route(API + '/batch', DROP_BEACON);
        await SET_HIDDEN(true);
        await PAGE.clock.runFor(60000);
        assert.equal(
            await PAGE.evaluate(() => window.metricsExample.metrics.playMs),
            PLAYED,
            `${NAME}: hidden time is not play time`,
        );
        const HIDDEN_SEQ = Number(
            (await PAGE.textContent('#metrics-log')).match(/#(\d+) beacon heartbeat/)?.[1] ?? NaN,
        );
        assert.ok(Number.isSafeInteger(HIDDEN_SEQ), `${NAME}: hiding sends a beacon`);
        const STORED_ROWS = async () => {
            const READER = await openDatabase();
            try {
                return READER.prepare('SELECT COUNT(*) AS n FROM batches WHERE session_id = ? AND seq = ?').get(
                    await PAGE.evaluate(() => window.metricsExample.metrics.sessionId),
                    HIDDEN_SEQ,
                ).n;
            } finally {
                READER.close();
            }
        };
        assert.equal(await STORED_ROWS(), 0, `${NAME}: the dropped beacon did not reach the server`);
        await PAGE.unroute(API + '/batch', DROP_BEACON);
        // 다시 보이면 메모리에 남은 같은 seq를 fetch로 보냅니다. 서버에는 한 행만 남습니다.
        await SET_HIDDEN(false);
        await until(async () => (await STORED_ROWS()) === 1, `${NAME} dropped beacon batch resent on visible`);
        await PAGE.clock.runFor(1000);
        const SESSION_ID = await PAGE.evaluate(() => window.metricsExample.metrics.sessionId);
        // 실제 페이지 이동: pagehide에서 session_end를 sendBeacon으로 보냅니다.
        // 체류 시간은 첫 이벤트(연결)부터 session_end까지의 페이지 시계이고 숨긴 60초를 포함합니다.
        await PAGE.goto('about:blank');
        // 화면 크기는 구간 경계로 내립니다: 1280x800 → 1280x768, 390x844 → 360x768.
        const CONTEXT_PROPS =
            NAME === 'touch'
                ? { locale: 'ko', viewport: '360x768', touch: true }
                : { locale: 'ko', viewport: '1280x768', touch: false };
        SESSIONS.push({
            name: NAME,
            id: SESSION_ID,
            playMs: PLAYED + 1000,
            wallMs: 5000 + 60000 + 1000,
            context: CONTEXT_PROPS,
        });
        assert.deepEqual(ERRORS, [], `${NAME}: no page errors`);
        await CONTEXT.close();
    }

    const DATABASE = await openDatabase();
    const MIGRATIONS = (await readdir(resolve(SERVER_DIR, 'migrations'))).filter((name) => name.endsWith('.sql'));
    assert.deepEqual(
        DATABASE.prepare('SELECT name FROM d1_migrations ORDER BY id')
            .all()
            .map((row) => row.name),
        MIGRATIONS.sort(),
        'every migration file is applied in order and recorded',
    );
    for (const SESSION of SESSIONS) {
        const ROW = await until(() => {
            const FOUND = DATABASE.prepare(
                `SELECT MAX(b.play_ms) AS play_ms, s.ip_key, s.user_agent, s.origin
                 FROM sessions s JOIN batches b ON b.session_id = s.session_id WHERE s.session_id = ? GROUP BY s.session_id`,
            ).get(SESSION.id);
            const ENDED = DATABASE.prepare(
                "SELECT COUNT(*) AS n FROM batches WHERE session_id = ? AND events LIKE '%session_end%'",
            ).get(SESSION.id);
            return ENDED.n === 1 && FOUND;
        }, `${SESSION.name} session_end beacon in D1`);
        assert.equal(ROW.play_ms, SESSION.playMs, `${SESSION.name}: batches keep the visible play time`);
        const [FIRST] = JSON.parse(
            DATABASE.prepare('SELECT events FROM batches WHERE session_id = ? AND seq = 0').get(SESSION.id).events,
        );
        assert.deepEqual(
            [FIRST.type, FIRST.props],
            ['session_start', SESSION.context],
            `${SESSION.name}: session_start carries the game locale, a viewport bucket and the main pointer`,
        );
        assert.equal(ROW.ip_key, ownerKey, `${SESSION.name}: D1 keeps the connection key, not the IP`);
        assert.match(ROW.user_agent, /Chrome/, `${SESSION.name}: D1 keeps the user agent`);
        assert.match(ROW.origin, /^http:\/\/127\.0\.0\.1:/, `${SESSION.name}: D1 keeps the page origin`);
    }
    // 게임 페이지(itch.io 등 원격 출처)에서 다른 회선으로 온 배치만 유저로 셉니다. Origin·CF-Connecting-IP를 흉내 냅니다.
    const USER_BATCH = {
        schemaVersion: 3,
        game: GAME,
        build: 'example',
        sessionId: 'remote-user',
        seq: 0,
        playMs: 2500,
        events: [{ type: 'session_start', t: 0 }],
        matches: [],
    };
    const USER_POST = await fetch(API + '/batch', {
        method: 'POST',
        headers: { Origin: 'https://html-classic.itch.zone', 'CF-Connecting-IP': '203.0.113.9' },
        body: JSON.stringify(USER_BATCH),
    });
    assert.equal(USER_POST.status, 200);
    const BY_AUDIENCE = await (await READ(`/stats?game=${GAME}`)).json();
    assert.deepEqual(
        ['users', 'owner', 'dev'].map((name) => BY_AUDIENCE[name].sessions),
        [1, 0, 2],
        'stats split users and local builds',
    );
    assert.equal(BY_AUDIENCE.users.avgPlayMs, 2500, 'user play time excludes local builds');
    assert.deepEqual(
        [BY_AUDIENCE.dev.avgPlayMs, BY_AUDIENCE.dev.avgWallMs],
        [SESSIONS[0].playMs, SESSIONS[0].wallMs],
        'play and wall time are computed from the stored batches',
    );
    assert.deepEqual(
        ['users', 'dev'].map((name) => [BY_AUDIENCE[name].lines, BY_AUDIENCE[name].returningLines]),
        [
            [1, 0],
            [1, 0],
        ],
        'both local sessions are one line seen on one day',
    );
    assert.equal(BY_AUDIENCE.note, 'lines are IP networks, not people');
    const SOLO = DATABASE.prepare(
        'SELECT mode, seed, summary, replay FROM matches m JOIN sessions s USING (session_id) WHERE s.game = ?',
    ).all(GAME);
    assert.equal(SOLO.length, 2, 'one D1 row per finished match');
    for (const MATCH of SOLO) {
        const REPLAY = JSON.parse(MATCH.replay);
        assert.equal(MATCH.mode, 'solo');
        assert.equal(JSON.parse(MATCH.seed), 7, 'the seed from the page address is stored');
        assert.deepEqual(JSON.parse(MATCH.summary), { hits: 3 });
        assert.deepEqual(
            REPLAY.frames.map((frame) => frame.tick),
            [0, 1, 2],
            'every rally input is in the match record',
        );
    }

    // 멀티플레이: 같은 경기를 두 참가자가 rollback Session replay와 같은 matchId로 보냅니다.
    const MULTI_CONTEXT = await browser.newContext();
    const MULTI = await MULTI_CONTEXT.newPage();
    await MULTI.goto(PAGE_URL.replace(/#.*$/, ''));
    const ONLINE = await MULTI.evaluate(
        async ({ api, adapterSource }) => {
            const METRICS = await import('/dist/metrics.js');
            const { createSession: CREATE_SESSION } = await import('/dist/rollback.js');
            const CREATE_ADAPTER = new Function('return (' + adapterSource + ')')();
            const SESSION = CREATE_SESSION({
                players: ['a'],
                localPlayerId: 'a',
                sessionId: 'metrics-e2e',
                simulationVersion: '1',
                seed: 11,
                inputSize: 1,
                adapter: CREATE_ADAPTER(),
                recordReplay: true,
                profile: {
                    mode: 'lockstep',
                    tickRate: 20,
                    baseInputDelayTicks: 0,
                    minInputDelayTicks: 0,
                    maxInputDelayTicks: 0,
                    adaptiveInputDelay: false,
                    pacingPolicy: 'none',
                },
            });
            for (let tick = 0; tick < 30; tick++) {
                SESSION.advance(new Uint8Array([(tick * 7) % 5]));
            }
            const PEERS = ['a', 'b'].map(() =>
                METRICS.createMetrics({ game: 'gamekit-e2e', version: '1', adapter: new METRICS.HttpAdapter(api) }),
            );
            for (const PEER of PEERS) {
                await PEER.recordMatch(
                    new METRICS.SessionReplayRecorder({ session: SESSION, matchId: 'online-1', mode: 'online' }),
                    { winner: 'a' },
                );
            }
            await Promise.all(PEERS.map((peer) => peer.dispose()));
            return { hash: SESSION.getStateHash(), tick: SESSION.exportReplay().tick };
        },
        { api: API, adapterSource: createCounterAdapter.toString() },
    );
    await MULTI_CONTEXT.close();
    const STATS = await (await READ('/stats?game=gamekit-e2e')).json();
    assert.deepEqual([STATS.dev.sessions, STATS.dev.matches], [2, 1], 'two peers, one stored match');
    const ONLINE_ROW = DATABASE.prepare('SELECT mode, seed, players, replay FROM matches WHERE match_id = ?').get(
        'online-1',
    );
    assert.deepEqual(
        [ONLINE_ROW.mode, JSON.parse(ONLINE_ROW.seed), JSON.parse(ONLINE_ROW.players)],
        ['online', 11, ['a']],
    );
    // 저장된 기록만으로 같은 시뮬레이션을 다시 돌립니다. 바이트는 {"$bytes"}에서 Uint8Array로 돌아옵니다.
    const STORED = JSON.parse(ONLINE_ROW.replay, REVIVE_BYTES);
    assert.ok(STORED.initialState instanceof Uint8Array, 'replay bytes survive JSON storage');
    const REPLAYED = PLAY_REPLAY({ adapter: createCounterAdapter(), replay: STORED });
    assert.deepEqual(REPLAYED, { tick: ONLINE.tick, hash: ONLINE.hash }, 'the stored replay recomputes the same state');

    // 후 필터: 페이지가 보여 준 접속 키를 소유자 목록에 넣으면 그 회선의 지난 세션이 소급해 '나'로 빠집니다.
    // 실행 중인 wrangler dev가 D1 파일을 잡고 있어 wrangler d1 execute 대신 같은 파일에 직접 씁니다.
    // 운영에서는 README "개발자 본인 플레이 분리"의 wrangler d1 execute --remote 명령입니다.
    const WRITER = await openDatabase(false);
    WRITER.prepare('INSERT INTO owners (ip_key, label, added_at) VALUES (?, ?, 0)').run(ownerKey, 'e2e-pc');
    WRITER.close();
    const FINAL = await (await READ(`/stats?game=${GAME}`)).json();
    assert.deepEqual(
        ['users', 'owner', 'dev'].map((name) => [FINAL[name].sessions, FINAL[name].matches]),
        [
            [1, 0],
            [2, 2],
            [0, 0],
        ],
        'owner sessions and their matches leave users and dev retroactively',
    );
    assert.deepEqual(FINAL.owner.keys, { 'e2e-pc': 2 }, 'owner sessions are counted per owner line');
    assert.equal(FINAL.users.avgPlayMs, 2500, 'the other line stays a user');
    // 일별 값은 첫 배치를 받은 날(KST)로 묶습니다. 이 실행의 세션은 모두 오늘입니다.
    const DAILY = await (await READ(`/daily?game=${GAME}&days=1`)).json();
    const TODAY = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
    assert.deepEqual(
        DAILY.daily.map(({ day, audience, sessions, lines, newLines, medianPlayMs, avgWallMs, matches }) => [
            day,
            audience,
            sessions,
            lines,
            newLines,
            medianPlayMs,
            avgWallMs,
            matches,
        ]),
        [
            [TODAY, 'owner', 2, 1, 1, SESSIONS[0].playMs, SESSIONS[0].wallMs, 2],
            [TODAY, 'users', 1, 1, 1, 2500, 0, 0],
        ],
        'daily rows per KST day and audience',
    );
    // 기기마다 연결 때와 경기 기록 뒤 새 경기에서 시작 이벤트를 보내고 경기는 하나씩 끝냈습니다.
    assert.deepEqual(
        DAILY.events.owner,
        { 'match:solo:start': 4, 'match:rally:hit': 6, 'match:rally:end': 2 },
        'event counts come from the stored event arrays',
    );
    assert.deepEqual(DAILY.completion.owner, { solo: { starts: 4, matches: 2, rate: 0.5 } }, 'completion per mode');
    assert.deepEqual(
        DAILY.contexts,
        {
            users: { locale: { unknown: 1 }, viewport: { unknown: 1 }, touch: { unknown: 1 } },
            owner: { locale: { ko: 2 }, viewport: { '1280x768': 1, '360x768': 1 }, touch: { false: 1, true: 1 } },
            dev: { locale: {}, viewport: {}, touch: {} },
        },
        'language, screen and touch come from each session_start; a batch without them is unknown',
    );
    assert.deepEqual(
        ['users', 'owner'].map((name) => Object.values(DAILY.countries[name]).reduce((sum, count) => sum + count, 0)),
        [1, 2],
        'every session is counted under one country',
    );
    const OWNER_WHOAMI = await (await READ('/whoami', { headers: { 'CF-Connecting-IP': '127.0.0.1' } })).json();
    assert.equal(OWNER_WHOAMI.owner, 'e2e-pc', 'whoami names the owner line');
    DATABASE.close();

    console.log(
        JSON.stringify({
            stats: FINAL,
            daily: DAILY,
            sessions: SESSIONS,
            online: { stats: STATS, replayed: REPLAYED },
            elapsedMs: Math.round(performance.now() - STARTED),
        }),
    );
    console.log('metrics e2e: PASS (desktop mouse + touch emulation; tab hiding is emulated, page close is real)');
} finally {
    await browser?.close();
    site?.close();
    for (const CHILD of CHILDREN) {
        stopChild(CHILD);
    }
    await rm(PERSIST, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {
        // workerd가 늦게 닫히면 임시 폴더가 남을 수 있습니다. 다음 실행은 새 폴더를 씁니다.
    });
}

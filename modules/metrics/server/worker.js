import {
    SCHEMA_VERSION,
    EVENT_TYPES,
    MAX_BATCH_BYTES,
    MAX_BATCH_EVENTS,
    MAX_BATCH_MATCHES,
    isName,
    isRecord,
} from '../protocol.js';

// 응답에 쿠키·인증이 없으므로 어느 게임 페이지(itch.io 등)에서든 받습니다.
const CORS = Object.freeze({
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
});
const ENCODER = new TextEncoder();
const MAX_ORIGIN_LENGTH = 200;
// 집계 대상 구분: 개발자가 이름표를 붙인 기기 → 'tester', 로컬·파일에서 띄운 개발 빌드 → 'dev', 나머지 → 'users'.
// 이름표가 한 번이라도 붙은 세션은 끝까지 tester입니다.
const AUDIENCE_SQL = `CASE
    WHEN tester IS NOT NULL THEN 'tester'
    WHEN origin IS NULL OR origin = 'null' OR origin LIKE 'http://localhost%' OR origin LIKE 'http://127.0.0.1%'
        OR origin LIKE 'http://[::1]%' THEN 'dev'
    ELSE 'users' END`;
const AUDIENCES = Object.freeze(['users', 'tester', 'dev']);

function reply(status, body) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { ...CORS, 'Content-Type': 'application/json;charset=UTF-8' },
    });
}

function isCount(value) {
    return Number.isSafeInteger(value) && value >= 0;
}

/** 배치가 계약과 다르면 거부 이유를, 맞으면 null을 돌려줍니다. */
function findBatchError(batch) {
    if (!isRecord(batch) || batch.schemaVersion !== SCHEMA_VERSION) {
        return 'schema-version';
    }
    if (!isName(batch.game) || !isName(batch.build) || !isName(batch.sessionId)) {
        return 'identity';
    }
    if (!isCount(batch.seq) || !isCount(batch.playMs)) {
        return 'counter';
    }
    if (batch.tester !== null && !isName(batch.tester)) {
        return 'tester';
    }
    const { events: EVENTS, matches: MATCHES } = batch;
    if (!Array.isArray(EVENTS) || !Array.isArray(MATCHES)) {
        return 'shape';
    }
    if (EVENTS.length + MATCHES.length === 0) {
        return 'empty';
    }
    if (EVENTS.length > MAX_BATCH_EVENTS || MATCHES.length > MAX_BATCH_MATCHES) {
        return 'too-many';
    }
    for (const EVENT of EVENTS) {
        if (!isRecord(EVENT) || !EVENT_TYPES.includes(EVENT.type) || !Number.isFinite(EVENT.t)) {
            return 'event';
        }
        if (
            EVENT.type === 'event' &&
            !(isName(EVENT.category) && isName(EVENT.target) && isName(EVENT.action) && isRecord(EVENT.props))
        ) {
            return 'event';
        }
    }
    for (const MATCH of MATCHES) {
        if (
            !isRecord(MATCH) ||
            !isName(MATCH.matchId) ||
            !isName(MATCH.mode) ||
            !Array.isArray(MATCH.players) ||
            !isRecord(MATCH.summary)
        ) {
            return 'match';
        }
    }
    return null;
}

async function receiveBatch(request, env) {
    const DECLARED = Number(request.headers.get('Content-Length'));
    if (DECLARED > MAX_BATCH_BYTES) {
        return reply(413, { error: 'too-large' });
    }
    const TEXT = await request.text();
    if (ENCODER.encode(TEXT).byteLength > MAX_BATCH_BYTES) {
        return reply(413, { error: 'too-large' });
    }
    let batch;
    try {
        batch = JSON.parse(TEXT);
    } catch {
        return reply(400, { error: 'json' });
    }
    const ERROR = findBatchError(batch);
    if (ERROR) {
        return reply(400, { error: ERROR });
    }
    const RECEIVED_AT = Date.now();
    const { game: GAME, build: BUILD, sessionId: SESSION_ID, tester: TESTER } = batch;
    // 브라우저가 붙이는 요청 출처. 페이지가 바꿀 수 없어 개발 빌드(localhost)를 가르는 데 씁니다.
    const ORIGIN = request.headers.get('Origin')?.slice(0, MAX_ORIGIN_LENGTH) ?? null;
    // 배치 하나 = 세션 요약 1행 + (이벤트가 있으면) 원본 1행 + 경기마다 1행. 같은 배치를 다시 받아도 결과가 같습니다.
    const STATEMENTS = [
        env.DB.prepare(
            `INSERT INTO sessions (session_id, game, build, schema_version, started_at, last_seen_at, play_ms, tester, origin)
             VALUES (?1, ?2, ?3, ?4, ?5, ?5, ?6, ?7, ?8)
             ON CONFLICT (session_id) DO UPDATE SET
                 last_seen_at = MAX(last_seen_at, excluded.last_seen_at),
                 play_ms = MAX(play_ms, excluded.play_ms),
                 tester = COALESCE(excluded.tester, tester)`,
        ).bind(SESSION_ID, GAME, BUILD, SCHEMA_VERSION, RECEIVED_AT, batch.playMs, TESTER, ORIGIN),
    ];
    if (batch.events.length) {
        STATEMENTS.push(
            env.DB.prepare(
                `INSERT OR IGNORE INTO batches (session_id, seq, game, build, schema_version, received_at, events)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
            ).bind(SESSION_ID, batch.seq, GAME, BUILD, SCHEMA_VERSION, RECEIVED_AT, JSON.stringify(batch.events)),
        );
    }
    for (const MATCH of batch.matches) {
        // 멀티플레이는 참가자마다 같은 matchId로 보냅니다. 먼저 도착한 하나만 남깁니다.
        STATEMENTS.push(
            env.DB.prepare(
                `INSERT OR IGNORE INTO matches
                     (match_id, session_id, game, build, schema_version, mode, seed, players, summary, replay, recorded_at,
                      tester, origin)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)`,
            ).bind(
                MATCH.matchId,
                SESSION_ID,
                GAME,
                BUILD,
                SCHEMA_VERSION,
                MATCH.mode,
                JSON.stringify(MATCH.seed ?? null),
                JSON.stringify(MATCH.players),
                JSON.stringify(MATCH.summary),
                JSON.stringify(MATCH.replay ?? null),
                RECEIVED_AT,
                TESTER,
                ORIGIN,
            ),
        );
    }
    await env.DB.batch(STATEMENTS);
    return reply(200, { ok: true });
}

async function readStats(url, env) {
    const GAME = url.searchParams.get('game');
    const BUILD = url.searchParams.get('build');
    if (!isName(GAME) || (BUILD !== null && !isName(BUILD))) {
        return reply(400, { error: 'identity' });
    }
    const [SESSIONS, MATCHES, TESTERS] = await env.DB.batch([
        env.DB.prepare(
            `SELECT ${AUDIENCE_SQL} AS audience, COUNT(*) AS sessions, AVG(play_ms) AS avgPlayMs,
                    AVG(last_seen_at - started_at) AS avgWallMs
             FROM sessions WHERE game = ?1 AND (?2 IS NULL OR build = ?2) GROUP BY audience`,
        ).bind(GAME, BUILD),
        env.DB.prepare(
            `SELECT ${AUDIENCE_SQL} AS audience, COUNT(*) AS matches
             FROM matches WHERE game = ?1 AND (?2 IS NULL OR build = ?2) GROUP BY audience`,
        ).bind(GAME, BUILD),
        env.DB.prepare(
            `SELECT tester, COUNT(*) AS sessions FROM sessions
             WHERE game = ?1 AND (?2 IS NULL OR build = ?2) AND tester IS NOT NULL GROUP BY tester`,
        ).bind(GAME, BUILD),
    ]);
    const BODY = { game: GAME, build: BUILD };
    for (const AUDIENCE of AUDIENCES) {
        const ROW = SESSIONS.results.find((row) => row.audience === AUDIENCE);
        BODY[AUDIENCE] = {
            sessions: ROW?.sessions ?? 0,
            avgPlayMs: Math.round(ROW?.avgPlayMs ?? 0),
            avgWallMs: Math.round(ROW?.avgWallMs ?? 0),
            matches: MATCHES.results.find((row) => row.audience === AUDIENCE)?.matches ?? 0,
        };
    }
    // 개발자 기기별 세션 수: 어느 기기의 플레이가 빠졌는지 확인합니다.
    BODY.tester.devices = Object.fromEntries(TESTERS.results.map((row) => [row.tester, row.sessions]));
    return reply(200, BODY);
}

export default {
    async fetch(request, env) {
        const URL_VALUE = new URL(request.url);
        if (request.method === 'OPTIONS') {
            return new Response(null, { status: 204, headers: CORS });
        }
        if (URL_VALUE.pathname === '/batch' && request.method === 'POST') {
            return receiveBatch(request, env);
        }
        if (URL_VALUE.pathname === '/stats' && request.method === 'GET') {
            return readStats(URL_VALUE, env);
        }
        return reply(404, { error: 'not-found' });
    },
};

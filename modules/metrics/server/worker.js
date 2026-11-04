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
    const { game: GAME, build: BUILD, sessionId: SESSION_ID } = batch;
    // 배치 하나 = 세션 요약 1행 + (이벤트가 있으면) 원본 1행 + 경기마다 1행. 같은 배치를 다시 받아도 결과가 같습니다.
    const STATEMENTS = [
        env.DB.prepare(
            `INSERT INTO sessions (session_id, game, build, schema_version, started_at, last_seen_at, play_ms)
             VALUES (?1, ?2, ?3, ?4, ?5, ?5, ?6)
             ON CONFLICT (session_id) DO UPDATE SET
                 last_seen_at = MAX(last_seen_at, excluded.last_seen_at),
                 play_ms = MAX(play_ms, excluded.play_ms)`,
        ).bind(SESSION_ID, GAME, BUILD, SCHEMA_VERSION, RECEIVED_AT, batch.playMs),
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
                     (match_id, session_id, game, build, schema_version, mode, seed, players, summary, replay, recorded_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`,
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
    const [SESSIONS, MATCHES] = await env.DB.batch([
        env.DB.prepare(
            `SELECT COUNT(*) AS sessions, COALESCE(AVG(play_ms), 0) AS avgPlayMs,
                    COALESCE(AVG(last_seen_at - started_at), 0) AS avgWallMs
             FROM sessions WHERE game = ?1 AND (?2 IS NULL OR build = ?2)`,
        ).bind(GAME, BUILD),
        env.DB.prepare(`SELECT COUNT(*) AS matches FROM matches WHERE game = ?1 AND (?2 IS NULL OR build = ?2)`).bind(
            GAME,
            BUILD,
        ),
    ]);
    const ROW = SESSIONS.results[0];
    return reply(200, {
        game: GAME,
        build: BUILD,
        sessions: ROW.sessions,
        avgPlayMs: Math.round(ROW.avgPlayMs),
        avgWallMs: Math.round(ROW.avgWallMs),
        matches: MATCHES.results[0].matches,
    });
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

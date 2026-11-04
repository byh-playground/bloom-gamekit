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
const MAX_TEXT_LENGTH = 200;
// 집계 대상 구분: 소유자 목록(owners)에 있는 접속 키 → 'owner', 로컬·파일에서 띄운 개발 빌드 → 'dev', 나머지 → 'users'.
// 소유자는 저장된 접속 키로 조회 때 가르므로, 키를 나중에 owners에 넣어도 지난 세션까지 함께 빠집니다.
const AUDIENCE_SQL = `CASE
    WHEN o.ip_key IS NOT NULL THEN 'owner'
    WHEN s.origin IS NULL OR s.origin = 'null' OR s.origin LIKE 'http://localhost%' OR s.origin LIKE 'http://127.0.0.1%'
        OR s.origin LIKE 'http://[::1]%' THEN 'dev'
    ELSE 'users' END`;
const AUDIENCES = Object.freeze(['users', 'owner', 'dev']);

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

function clip(value) {
    return typeof value === 'string' ? value.slice(0, MAX_TEXT_LENGTH) : null;
}

/** IPv6는 기기마다 뒤 64비트가 바뀌므로 앞 64비트(회선)로 묶습니다. IPv4는 주소 그대로입니다. */
function networkOf(ip) {
    if (!ip.includes(':')) {
        return ip;
    }
    const [HEAD, TAIL] = ip.split('::');
    const LEFT = HEAD ? HEAD.split(':') : [];
    const RIGHT = TAIL ? TAIL.split(':') : [];
    const GROUPS = TAIL === undefined ? LEFT : [...LEFT, ...Array(8 - LEFT.length - RIGHT.length).fill('0'), ...RIGHT];
    return (
        GROUPS.slice(0, 4)
            .map((group) => parseInt(group || '0', 16).toString(16))
            .join(':') + '::/64'
    );
}

/**
 * 요청 회선의 접속 키와 접속 정보. 원본 IP는 저장하지 않고 서버 비밀값(IP_KEY_SECRET)으로 만든 HMAC 앞 16바이트만 씁니다.
 * 같은 회선은 늘 같은 키라 소유자 목록으로 나중에 가를 수 있고, 비밀값 없이는 키에서 IP를 되돌릴 수 없습니다.
 */
async function readConnection(request, env) {
    const IP = request.headers.get('CF-Connecting-IP');
    let ipKey = null;
    if (IP) {
        const KEY = await crypto.subtle.importKey(
            'raw',
            ENCODER.encode(env.IP_KEY_SECRET),
            { name: 'HMAC', hash: 'SHA-256' },
            false,
            ['sign'],
        );
        const SIGNATURE = new Uint8Array(await crypto.subtle.sign('HMAC', KEY, ENCODER.encode(networkOf(IP))));
        ipKey = Array.from(SIGNATURE.subarray(0, 16), (byte) => byte.toString(16).padStart(2, '0')).join('');
    }
    const CF = request.cf ?? {};
    return {
        ipKey,
        country: clip(CF.country),
        city: clip(CF.city),
        asn: Number.isSafeInteger(CF.asn) ? CF.asn : null,
        asOrg: clip(CF.asOrganization),
        userAgent: clip(request.headers.get('User-Agent')),
        // 브라우저가 붙이는 요청 출처. 페이지가 바꿀 수 없어 개발 빌드(localhost)를 가르는 데 씁니다.
        origin: clip(request.headers.get('Origin')),
    };
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
    const CONNECTION = await readConnection(request, env);
    // 배치 하나 = 세션 요약 1행 + (이벤트가 있으면) 원본 1행 + 경기마다 1행. 같은 배치를 다시 받아도 결과가 같습니다.
    // 접속 정보는 세션의 첫 배치 것을 남깁니다.
    const STATEMENTS = [
        env.DB.prepare(
            `INSERT INTO sessions
                 (session_id, game, build, schema_version, started_at, last_seen_at, play_ms,
                  ip_key, country, city, asn, as_org, user_agent, origin)
             VALUES (?1, ?2, ?3, ?4, ?5, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
             ON CONFLICT (session_id) DO UPDATE SET
                 last_seen_at = MAX(last_seen_at, excluded.last_seen_at),
                 play_ms = MAX(play_ms, excluded.play_ms)`,
        ).bind(
            SESSION_ID,
            GAME,
            BUILD,
            SCHEMA_VERSION,
            RECEIVED_AT,
            batch.playMs,
            CONNECTION.ipKey,
            CONNECTION.country,
            CONNECTION.city,
            CONNECTION.asn,
            CONNECTION.asOrg,
            CONNECTION.userAgent,
            CONNECTION.origin,
        ),
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
    // 경기는 그 경기를 처음 보낸 세션의 구분을 따릅니다.
    const [SESSIONS, MATCHES, OWNERS] = await env.DB.batch([
        env.DB.prepare(
            `SELECT ${AUDIENCE_SQL} AS audience, COUNT(*) AS sessions, AVG(s.play_ms) AS avgPlayMs,
                    AVG(s.last_seen_at - s.started_at) AS avgWallMs
             FROM sessions s LEFT JOIN owners o ON o.ip_key = s.ip_key
             WHERE s.game = ?1 AND (?2 IS NULL OR s.build = ?2) GROUP BY audience`,
        ).bind(GAME, BUILD),
        env.DB.prepare(
            `SELECT ${AUDIENCE_SQL} AS audience, COUNT(*) AS matches
             FROM matches m JOIN sessions s ON s.session_id = m.session_id LEFT JOIN owners o ON o.ip_key = s.ip_key
             WHERE m.game = ?1 AND (?2 IS NULL OR m.build = ?2) GROUP BY audience`,
        ).bind(GAME, BUILD),
        env.DB.prepare(
            `SELECT o.label AS label, COUNT(*) AS sessions FROM sessions s JOIN owners o ON o.ip_key = s.ip_key
             WHERE s.game = ?1 AND (?2 IS NULL OR s.build = ?2) GROUP BY o.label`,
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
    // 소유자 회선 이름(owners.label)별 세션 수: 어느 회선의 플레이가 빠졌는지 확인합니다.
    BODY.owner.keys = Object.fromEntries(OWNERS.results.map((row) => [row.label, row.sessions]));
    return reply(200, BODY);
}

/** 지금 요청한 회선의 접속 키와 접속 정보. 소유자는 이 키를 owners에 넣어 자기 플레이를 집계에서 뺍니다. */
async function readWhoami(request, env) {
    const CONNECTION = await readConnection(request, env);
    const OWNER = CONNECTION.ipKey
        ? await env.DB.prepare('SELECT label FROM owners WHERE ip_key = ?1').bind(CONNECTION.ipKey).first()
        : null;
    return reply(200, {
        ipKey: CONNECTION.ipKey,
        country: CONNECTION.country,
        city: CONNECTION.city,
        asn: CONNECTION.asn,
        asOrg: CONNECTION.asOrg,
        owner: OWNER?.label ?? null,
    });
}

export default {
    async fetch(request, env) {
        const URL_VALUE = new URL(request.url);
        if (request.method === 'OPTIONS') {
            return new Response(null, { status: 204, headers: CORS });
        }
        if (!env.IP_KEY_SECRET) {
            // 배포 설정 누락: 접속 키 없이 받으면 소유자 플레이를 가를 수 없으므로 받지 않습니다.
            return reply(500, { error: 'ip-key-secret' });
        }
        if (URL_VALUE.pathname === '/batch' && request.method === 'POST') {
            return receiveBatch(request, env);
        }
        if (URL_VALUE.pathname === '/stats' && request.method === 'GET') {
            return readStats(URL_VALUE, env);
        }
        if (URL_VALUE.pathname === '/whoami' && request.method === 'GET') {
            return readWhoami(request, env);
        }
        return reply(404, { error: 'not-found' });
    },
};

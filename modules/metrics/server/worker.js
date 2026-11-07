import {
    SCHEMA_VERSION,
    EVENT_TYPES,
    MAX_BATCH_BYTES,
    MAX_BATCH_EVENTS,
    MAX_BATCH_MATCHES,
    isName,
    isRecord,
} from '../protocol.js';
import { checkBatchRate } from './rate-limit.js';

// 수집은 공개이며 조회는 별도 인증을 요구합니다.
const CORS = Object.freeze({
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
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
// 날짜 경계는 한국 시간(KST, UTC+9)입니다. 세션의 날짜는 첫 배치를 받은 날입니다.
const DAY_SQL = `date(s.started_at / 1000, 'unixepoch', '+9 hours')`;
const KST_OFFSET_MS = 9 * 3600000;
const DAY_MS = 86400000;
const MAX_DAYS = 90;
// 회선은 사람이 아닙니다. 휴대폰 데이터는 한 사람이 여러 회선으로, 집·학교 NAT은 여러 사람이 한 회선으로 세어집니다.
const LINES_NOTE = 'lines are IP networks, not people';
/**
 * 조회 대상 세션: 세션마다 한 행(구분·날짜·접속 정보). sessions만 읽습니다. ?1 게임, ?2 빌드(null이면 전부), ?3 이 시각 이후 세션.
 * per_session은 여기에 batches 원본에서 계산한 값을 붙입니다. play_ms는 클라이언트가 보낸 누적값의 최댓값,
 * wall_ms는 첫 이벤트와 마지막 이벤트의 클라이언트 시각 차(숨긴 시간 포함)입니다. 배치 안 이벤트는 시간순이라 첫·마지막 원소만 읽습니다.
 * 쓰지 않는 CTE는 계산되지 않으므로 batches가 필요 없는 조회는 in_range만 읽습니다(D1 읽기 행).
 */
const IN_RANGE_SQL = `in_range AS MATERIALIZED (
        SELECT s.session_id, s.ip_key, s.country, ${AUDIENCE_SQL} AS audience, ${DAY_SQL} AS day
        FROM sessions s LEFT JOIN owners o ON o.ip_key = s.ip_key
        WHERE s.game = ?1 AND (?2 IS NULL OR s.build = ?2) AND s.started_at >= ?3),
    per_session AS (
        SELECT a.*, MAX(b.play_ms) AS play_ms,
               MAX(json_extract(b.events, '$[#-1].t')) - MIN(json_extract(b.events, '$[0].t')) AS wall_ms
        FROM in_range a JOIN batches b ON b.session_id = a.session_id GROUP BY a.session_id)`;
const EVENT_NAME_SQL = `json_extract(e.value, '$.category') || ':' || json_extract(e.value, '$.target') || ':' ||
    json_extract(e.value, '$.action')`;

function reply(status, body) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { ...CORS, 'Content-Type': 'application/json;charset=UTF-8', 'Cache-Control': 'no-store' },
    });
}

// 비밀값은 서버에서만 보관합니다. 고정 길이 해시를 비교해 입력 길이에 따른 비교 분기를 피합니다.
async function canRead(request, secret) {
    const AUTH = request.headers.get('Authorization') ?? '';
    if (!secret || !AUTH.startsWith('Bearer ')) {
        return false;
    }
    const [EXPECTED, ACTUAL] = await Promise.all(
        [secret, AUTH.slice(7)].map((value) => crypto.subtle.digest('SHA-256', ENCODER.encode(value))),
    );
    return crypto.subtle.timingSafeEqual(EXPECTED, ACTUAL);
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
    // 받은 원본만 저장합니다(README "수집 서버"). 세션은 첫 배치의 접속 정보 1행, 배치는 이벤트가 없어도 1행,
    // 경기마다 1행. 같은 배치를 다시 받아도 결과가 같습니다.
    const STATEMENTS = [
        env.DB.prepare(
            `INSERT OR IGNORE INTO sessions
                 (session_id, game, build, schema_version, started_at, ip_key, country, city, asn, as_org, user_agent, origin)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)`,
        ).bind(
            SESSION_ID,
            GAME,
            BUILD,
            SCHEMA_VERSION,
            RECEIVED_AT,
            CONNECTION.ipKey,
            CONNECTION.country,
            CONNECTION.city,
            CONNECTION.asn,
            CONNECTION.asOrg,
            CONNECTION.userAgent,
            CONNECTION.origin,
        ),
        env.DB.prepare(
            `INSERT OR IGNORE INTO batches (session_id, seq, received_at, play_ms, events) VALUES (?1, ?2, ?3, ?4, ?5)`,
        ).bind(SESSION_ID, batch.seq, RECEIVED_AT, batch.playMs, JSON.stringify(batch.events)),
    ];
    for (const MATCH of batch.matches) {
        // 멀티플레이는 참가자마다 같은 matchId로 보냅니다. 먼저 도착한 하나만 남깁니다.
        STATEMENTS.push(
            env.DB.prepare(
                `INSERT OR IGNORE INTO matches (match_id, session_id, mode, seed, players, summary, replay, recorded_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
            ).bind(
                MATCH.matchId,
                SESSION_ID,
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

function readIdentity(url) {
    const GAME = url.searchParams.get('game');
    const BUILD = url.searchParams.get('build');
    return isName(GAME) && (BUILD === null || isName(BUILD)) ? { game: GAME, build: BUILD } : null;
}

/** 구분마다 그 구분의 행으로 값을 만듭니다. 행이 없는 구분도 빈 값으로 채웁니다. */
function byAudience(rows, read) {
    return Object.fromEntries(
        AUDIENCES.map((audience) => [audience, read(rows.filter((row) => row.audience === audience))]),
    );
}

function countBy(rows, key, value) {
    return Object.fromEntries(rows.map((row) => [row[key] ?? 'unknown', row[value]]));
}

/** 같은 key 값끼리 세션 수를 더합니다. 값이 없으면 'unknown'입니다. */
function sumBy(rows, key) {
    const SUMS = {};
    for (const ROW of rows) {
        const NAME = ROW[key] ?? 'unknown';
        SUMS[NAME] = (SUMS[NAME] ?? 0) + ROW.sessions;
    }
    return SUMS;
}

/** in_range·per_session을 앞에 둔 조회들을 한 번에 실행합니다. 원본만 저장하므로 값은 모두 조회 때 계산합니다. */
function queryInRange(env, identity, since, sqls) {
    return env.DB.batch(
        sqls.map((sql) => env.DB.prepare(`WITH ${IN_RANGE_SQL}${sql}`).bind(identity.game, identity.build, since)),
    );
}

async function readStats(url, env) {
    const IDENTITY = readIdentity(url);
    if (!IDENTITY) {
        return reply(400, { error: 'identity' });
    }
    // 경기는 그 경기를 처음 보낸 세션의 구분을 따릅니다. 재방문 회선은 서로 다른 날(KST) 2일 이상 온 회선입니다.
    const [SESSIONS, LINES, MATCHES, OWNERS] = await queryInRange(env, IDENTITY, 0, [
        ` SELECT audience, COUNT(*) AS sessions, AVG(play_ms) AS avgPlayMs, AVG(wall_ms) AS avgWallMs
         FROM per_session GROUP BY audience`,
        ` SELECT audience, COUNT(*) AS lines, SUM(days >= 2) AS returningLines FROM (
             SELECT audience, ip_key, COUNT(DISTINCT day) AS days FROM in_range
             WHERE ip_key IS NOT NULL GROUP BY audience, ip_key)
         GROUP BY audience`,
        ` SELECT p.audience, COUNT(*) AS matches FROM matches m JOIN in_range p ON p.session_id = m.session_id
         GROUP BY p.audience`,
        ` SELECT o.label, COUNT(*) AS sessions FROM in_range p JOIN owners o ON o.ip_key = p.ip_key
         GROUP BY o.label`,
    ]);
    const BODY = {
        game: IDENTITY.game,
        build: IDENTITY.build,
        note: LINES_NOTE,
        ...byAudience(SESSIONS.results, ([row]) => ({
            sessions: row?.sessions ?? 0,
            lines: 0,
            returningLines: 0,
            avgPlayMs: Math.round(row?.avgPlayMs ?? 0),
            avgWallMs: Math.round(row?.avgWallMs ?? 0),
            matches: 0,
        })),
    };
    for (const ROW of LINES.results) {
        Object.assign(BODY[ROW.audience], { lines: ROW.lines, returningLines: ROW.returningLines });
    }
    for (const ROW of MATCHES.results) {
        BODY[ROW.audience].matches = ROW.matches;
    }
    // 소유자 회선 이름(owners.label)별 세션 수: 어느 회선의 플레이가 빠졌는지 확인합니다.
    BODY.owner.keys = countBy(OWNERS.results, 'label', 'sessions');
    return reply(200, BODY);
}

/** 모드별 완주율: 저장된 경기 수 / 'match:<mode>:start' 이벤트 수. 시작 이벤트가 없으면 rate는 null입니다. */
function readCompletion(events, matches) {
    const STARTS = {};
    for (const [NAME, COUNT] of Object.entries(events)) {
        const MODE = NAME.match(/^match:(.+):start$/)?.[1];
        if (MODE) {
            STARTS[MODE] = COUNT;
        }
    }
    const MODES = [...new Set([...Object.keys(STARTS), ...Object.keys(matches)])].sort();
    return Object.fromEntries(
        MODES.map((mode) => {
            const [STARTED, ENDED] = [STARTS[mode] ?? 0, matches[mode] ?? 0];
            return [mode, { starts: STARTED, matches: ENDED, rate: STARTED ? ENDED / STARTED : null }];
        }),
    );
}

/**
 * 최근 days일(KST, 오늘 포함, 상한 90)의 날짜·구분별 값과 기간 합계(국가·이벤트·경기 완주율).
 * 새 회선은 그 회선을 이 게임에서 처음 본 날로 셉니다(기간 밖 세션까지 봅니다).
 */
async function readDaily(url, env) {
    const IDENTITY = readIdentity(url);
    if (!IDENTITY) {
        return reply(400, { error: 'identity' });
    }
    const DAYS = Number(url.searchParams.get('days') ?? 30);
    if (!Number.isSafeInteger(DAYS) || DAYS < 1 || DAYS > MAX_DAYS) {
        return reply(400, { error: 'days' });
    }
    const TODAY = Math.floor((Date.now() + KST_OFFSET_MS) / DAY_MS);
    const SINCE = (TODAY - DAYS + 1) * DAY_MS - KST_OFFSET_MS;
    const [DAILY, COUNTRIES, EVENTS, MODES, CONTEXTS] = await queryInRange(env, IDENTITY, SINCE, [
        `, first_seen AS (
             SELECT ${AUDIENCE_SQL} AS audience, s.ip_key, MIN(${DAY_SQL}) AS day
             FROM sessions s LEFT JOIN owners o ON o.ip_key = s.ip_key
             WHERE s.game = ?1 AND (?2 IS NULL OR s.build = ?2) AND s.ip_key IS NOT NULL GROUP BY audience, s.ip_key),
         ranked AS (
             SELECT p.*, ROW_NUMBER() OVER (PARTITION BY day, audience ORDER BY play_ms) AS r,
                    COUNT(*) OVER (PARTITION BY day, audience) AS n FROM per_session p),
         summary AS (
             SELECT day, audience, COUNT(*) AS sessions, COUNT(DISTINCT ip_key) AS lines, AVG(play_ms) AS avgPlayMs,
                    AVG(CASE WHEN r IN ((n + 1) / 2, (n + 2) / 2) THEN play_ms END) AS medianPlayMs,
                    AVG(wall_ms) AS avgWallMs
             FROM ranked GROUP BY day, audience),
         new_lines AS (SELECT day, audience, COUNT(*) AS newLines FROM first_seen GROUP BY day, audience),
         day_matches AS (
             SELECT p.day, p.audience, COUNT(*) AS matches FROM matches m JOIN in_range p ON p.session_id = m.session_id
             GROUP BY p.day, p.audience)
         SELECT summary.*, COALESCE(newLines, 0) AS newLines, COALESCE(matches, 0) AS matches
         FROM summary LEFT JOIN new_lines USING (day, audience) LEFT JOIN day_matches USING (day, audience)
         ORDER BY day, audience`,
        ` SELECT audience, country, COUNT(*) AS sessions FROM in_range GROUP BY audience, country`,
        // 이벤트 하나하나를 펼쳐 셉니다. 경기 시작은 게임이 track('match', <mode>, 'start')로 보냅니다.
        ` SELECT p.audience, ${EVENT_NAME_SQL} AS name, COUNT(*) AS count
         FROM in_range p JOIN batches b ON b.session_id = p.session_id, json_each(b.events) e
         WHERE json_extract(e.value, '$.type') = 'event' GROUP BY p.audience, name`,
        ` SELECT p.audience, m.mode, COUNT(*) AS matches FROM matches m JOIN in_range p ON p.session_id = m.session_id
         GROUP BY p.audience, m.mode`,
        // 세션의 첫 배치(seq 0) 첫 이벤트가 session_start입니다. 기본키로 세션마다 한 행만 읽습니다.
        // 그 배치가 없거나 props가 없는 옛 빌드 세션은 값이 null이라 'unknown'으로 셉니다.
        ` SELECT p.audience, json_extract(b.events, '$[0].props.locale') AS locale,
                json_extract(b.events, '$[0].props.viewport') AS viewport,
                CASE json_type(b.events, '$[0].props.touch') WHEN 'true' THEN 'true' WHEN 'false' THEN 'false' END AS touch,
                COUNT(*) AS sessions
         FROM in_range p LEFT JOIN batches b ON b.session_id = p.session_id AND b.seq = 0
              AND json_extract(b.events, '$[0].type') = 'session_start'
         GROUP BY p.audience, locale, viewport, touch`,
    ]);
    const EVENT_COUNTS = byAudience(EVENTS.results, (rows) => countBy(rows, 'name', 'count'));
    const MATCH_COUNTS = byAudience(MODES.results, (rows) => countBy(rows, 'mode', 'matches'));
    return reply(200, {
        game: IDENTITY.game,
        build: IDENTITY.build,
        days: DAYS,
        since: SINCE,
        timeZone: 'Asia/Seoul',
        note: LINES_NOTE,
        daily: DAILY.results.map((row) => ({
            day: row.day,
            audience: row.audience,
            sessions: row.sessions,
            lines: row.lines,
            newLines: row.newLines,
            avgPlayMs: Math.round(row.avgPlayMs ?? 0),
            medianPlayMs: Math.round(row.medianPlayMs ?? 0),
            avgWallMs: Math.round(row.avgWallMs ?? 0),
            matches: row.matches,
        })),
        countries: byAudience(COUNTRIES.results, (rows) => countBy(rows, 'country', 'sessions')),
        contexts: byAudience(CONTEXTS.results, (rows) =>
            Object.fromEntries(['locale', 'viewport', 'touch'].map((key) => [key, sumBy(rows, key)])),
        ),
        events: EVENT_COUNTS,
        completion: Object.fromEntries(
            AUDIENCES.map((audience) => [audience, readCompletion(EVENT_COUNTS[audience], MATCH_COUNTS[audience])]),
        ),
    });
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
            const RATE = await checkBatchRate(request, env);
            if (RATE === 'limited') {
                return new Response(JSON.stringify({ error: RATE }), {
                    status: 429,
                    headers: { ...CORS, 'Content-Type': 'application/json;charset=UTF-8', 'Retry-After': '60' },
                });
            }
            if (RATE) {
                return reply(RATE === 'missing-ip' ? 400 : 503, { error: RATE });
            }
            return receiveBatch(request, env);
        }
        if (request.method === 'GET' && ['/stats', '/daily', '/whoami'].includes(URL_VALUE.pathname)) {
            if (!env.METRICS_READ_SECRET) {
                return reply(503, { error: 'read-secret' });
            }
            if (!(await canRead(request, env.METRICS_READ_SECRET))) {
                return reply(401, { error: 'unauthorized' });
            }
        }
        if (URL_VALUE.pathname === '/stats' && request.method === 'GET') {
            return readStats(URL_VALUE, env);
        }
        if (URL_VALUE.pathname === '/daily' && request.method === 'GET') {
            return readDaily(URL_VALUE, env);
        }
        if (URL_VALUE.pathname === '/whoami' && request.method === 'GET') {
            return readWhoami(request, env);
        }
        return reply(404, { error: 'not-found' });
    },
};

import {
    SCHEMA_VERSION,
    EVENT_TYPES,
    MAX_BATCH_BYTES,
    MAX_BATCH_EVENTS,
    MAX_BATCH_MATCHES,
    MAX_PROPS_BYTES,
    MAX_SUMMARY_BYTES,
    MAX_PLAYERS_BYTES,
    MAX_REPLAY_BYTES,
    jsonBytes,
    isName,
    isRecord,
} from '../protocol.js';

// 응답에 쿠키가 없습니다. 보내기(/batch)는 허용 출처(ALLOWED_ORIGINS)만 받고, 조회(/stats·/daily)는 Authorization 헤더의 키로 가립니다.
const CORS = Object.freeze({
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
});
const ENCODER = new TextEncoder();
const MAX_TEXT_LENGTH = 200;
// 로컬·파일에서 띄운 개발 빌드의 출처. 보내기 허용과 집계의 'dev' 칸이 같은 규칙입니다(Origin 'null'은 file://·샌드박스 iframe).
const DEV_HOSTS = Object.freeze(['localhost', '127.0.0.1', '[::1]']);
// user_agent의 로봇 표시: 검색·미리보기 로봇(Googlebot/·bingbot/·Discordbot/·Slackbot-·TelegramBot (like TwitterBot)·
// facebookexternalhit 등)과 헤드리스·스크립트 클라이언트. 'cubot'(휴대폰 기종) 같은 이름에 걸리지 않게 'bot' 뒤 구분자를 봅니다.
const BOT_UA_SQL = ['%bot/%', '%bot-%', '%bot)%', '%crawler%', '%spider%', '%facebookexternalhit%', '%HeadlessChrome%']
    .concat(['%Lighthouse%', '%PhantomJS%', '%curl/%', '%python%', '%Go-http-client%'])
    .map((pattern) => `s.user_agent LIKE '${pattern}'`)
    .join(' OR ');
// 집계 구분(위가 먼저): 소유자 목록(owners)에 있는 접속 키 → 'owner', 개발 빌드 출처 → 'dev', 로봇 → 'bot', 나머지 → 'users'.
// 로봇은 user_agent에 로봇 표시가 있거나 없음, 또는 한 번도 보인 적 없는 세션(playMs가 0보다 큰 배치가 없음: 미리 렌더링 등)입니다.
// playMs는 페이지가 보이는 동안만 늘어서(heartbeat도 보일 때만) 사람이 본 세션은 늦어도 숨김·닫힘 배치에서 0보다 큽니다.
// 모두 저장된 원본으로 조회 때 가르므로, 키를 나중에 owners에 넣거나 기준을 고쳐도 지난 세션까지 함께 바뀝니다.
const AUDIENCE_SQL = `CASE
    WHEN o.ip_key IS NOT NULL THEN 'owner'
    WHEN s.origin IS NULL OR s.origin = 'null' OR s.origin LIKE 'http://localhost%' OR s.origin LIKE 'http://127.0.0.1%'
        OR s.origin LIKE 'http://[::1]%' THEN 'dev'
    WHEN s.user_agent IS NULL OR ${BOT_UA_SQL}
        OR NOT EXISTS (SELECT 1 FROM batches v WHERE v.session_id = s.session_id AND v.play_ms > 0) THEN 'bot'
    ELSE 'users' END`;
const AUDIENCES = Object.freeze(['users', 'owner', 'dev', 'bot']);
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
        if (EVENT.props !== undefined && jsonBytes(EVENT.props) > MAX_PROPS_BYTES) {
            return 'size';
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
        if (
            jsonBytes(MATCH.summary) > MAX_SUMMARY_BYTES ||
            jsonBytes(MATCH.players) > MAX_PLAYERS_BYTES ||
            jsonBytes(MATCH.replay) > MAX_REPLAY_BYTES
        ) {
            return 'size';
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

/** 쉼표로 나눈 변수 값(wrangler.toml [vars]) → 이름 집합 */
function listOf(value) {
    return new Set(
        String(value ?? '')
            .split(',')
            .map((item) => item.trim())
            .filter(Boolean),
    );
}

/**
 * 보내기를 받을 출처: ALLOWED_ORIGINS(정확한 출처 문자열)와 개발 빌드(http의 localhost·127.0.0.1·[::1], 'null').
 * 브라우저는 POST에 Origin을 늘 붙이고(fetch·keepalive·sendBeacon 모두, Fetch 표준 "append a request Origin header")
 * 페이지가 바꿀 수 없으므로, Origin이 없는 요청은 브라우저 밖(스크립트·봇)이라 받지 않습니다.
 * 브라우저 밖에서는 Origin을 흉내 낼 수 있으므로 인증이 아니라 다른 사이트 페이지가 보내는 것을 막는 정도입니다.
 */
function isAllowedOrigin(origin, env) {
    if (origin === null) {
        return false;
    }
    if (origin === 'null' || listOf(env.ALLOWED_ORIGINS).has(origin)) {
        return true;
    }
    try {
        const URL_VALUE = new URL(origin);
        return URL_VALUE.protocol === 'http:' && DEV_HOSTS.includes(URL_VALUE.hostname);
    } catch {
        return false;
    }
}

async function receiveBatch(request, env) {
    if (!isAllowedOrigin(request.headers.get('Origin'), env)) {
        return reply(403, { error: 'origin' });
    }
    const CONNECTION = await readConnection(request, env);
    // 회선(접속 키)마다 횟수 제한(wrangler.toml [[ratelimits]], Cloudflare 위치마다 근사치). 정상 게임은 분당 약 2배치입니다.
    const { success: WITHIN_LIMIT } = await env.BATCH_LIMIT.limit({ key: CONNECTION.ipKey ?? 'no-ip' });
    if (!WITHIN_LIMIT) {
        return reply(429, { error: 'rate' });
    }
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
    const { game: GAME, build: BUILD, sessionId: SESSION_ID } = batch;
    if (!listOf(env.ALLOWED_GAMES).has(GAME)) {
        return reply(403, { error: 'game' });
    }
    const RECEIVED_AT = Date.now();
    // 받은 원본만 저장합니다(README "수집 서버"). 세션은 첫 배치의 접속 정보 1행, 배치는 이벤트가 없어도 1행,
    // 경기마다 1행. 같은 배치를 다시 받아도 결과가 같습니다. 배치·경기는 세션의 game이 이 배치의 game일 때만 넣고
    // (같은 sessionId로 다른 게임이 섞이지 않게), 마지막 문장이 세션의 game을 읽어 거절 여부를 알려 줍니다. D1 batch는 한 트랜잭션입니다.
    const SAME_GAME = `(SELECT game FROM sessions WHERE session_id = ?1) = ?2`;
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
            `INSERT OR IGNORE INTO batches (session_id, seq, received_at, play_ms, events)
             SELECT ?1, ?3, ?4, ?5, ?6 WHERE ${SAME_GAME}`,
        ).bind(SESSION_ID, GAME, batch.seq, RECEIVED_AT, batch.playMs, JSON.stringify(batch.events)),
    ];
    for (const MATCH of batch.matches) {
        // 멀티플레이는 참가자마다 같은 matchId로 보냅니다. 먼저 도착한 하나만 남깁니다.
        // client_ended_at은 클라이언트가 recordMatch한 시각(match.t, 클라이언트 시계) 원본입니다.
        STATEMENTS.push(
            env.DB.prepare(
                `INSERT OR IGNORE INTO matches
                     (match_id, session_id, mode, seed, players, summary, replay, recorded_at, client_ended_at)
                 SELECT ?3, ?1, ?4, ?5, ?6, ?7, ?8, ?9, ?10 WHERE ${SAME_GAME}`,
            ).bind(
                SESSION_ID,
                GAME,
                MATCH.matchId,
                MATCH.mode,
                JSON.stringify(MATCH.seed ?? null),
                JSON.stringify(MATCH.players),
                JSON.stringify(MATCH.summary),
                JSON.stringify(MATCH.replay ?? null),
                RECEIVED_AT,
                Number.isFinite(MATCH.t) ? MATCH.t : null,
            ),
        );
    }
    STATEMENTS.push(env.DB.prepare('SELECT game FROM sessions WHERE session_id = ?1').bind(SESSION_ID));
    const RESULTS = await env.DB.batch(STATEMENTS);
    if (RESULTS.at(-1).results[0]?.game !== GAME) {
        return reply(409, { error: 'session-game' });
    }
    return reply(200, { ok: true });
}

function readIdentity(url) {
    const GAME = url.searchParams.get('game');
    const BUILD = url.searchParams.get('build');
    return isName(GAME) && (BUILD === null || isName(BUILD)) ? { game: GAME, build: BUILD } : null;
}

/** 조회 기간: 최근 days일(KST, 오늘 포함, 1~90, 기본 30). 맞지 않으면 null. since는 그 첫날 0시(KST)의 epoch ms입니다. */
function readRange(url) {
    const DAYS = Number(url.searchParams.get('days') ?? 30);
    if (!Number.isSafeInteger(DAYS) || DAYS < 1 || DAYS > MAX_DAYS) {
        return null;
    }
    const TODAY = Math.floor((Date.now() + KST_OFFSET_MS) / DAY_MS);
    return { days: DAYS, since: (TODAY - DAYS + 1) * DAY_MS - KST_OFFSET_MS };
}

async function digestOf(text) {
    return crypto.subtle.digest('SHA-256', ENCODER.encode(text));
}

/** `Authorization: Bearer <STATS_KEY>`인지. 길이가 같은 해시끼리 일정 시간 비교(Workers의 timingSafeEqual)합니다. */
async function hasStatsKey(request, env) {
    const TOKEN = /^Bearer (.+)$/.exec(request.headers.get('Authorization') ?? '')?.[1];
    if (TOKEN === undefined) {
        return false;
    }
    const [GIVEN, EXPECTED] = await Promise.all([digestOf(TOKEN), digestOf(env.STATS_KEY)]);
    return crypto.subtle.timingSafeEqual(GIVEN, EXPECTED);
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
    const RANGE = readRange(url);
    if (!RANGE) {
        return reply(400, { error: 'days' });
    }
    // 경기는 그 경기를 처음 보낸 세션의 구분을 따릅니다. 재방문 회선은 기간 안 서로 다른 날(KST) 2일 이상 온 회선입니다.
    const [SESSIONS, LINES, MATCHES, OWNERS] = await queryInRange(env, IDENTITY, RANGE.since, [
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
        days: RANGE.days,
        since: RANGE.since,
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

/**
 * 모드별 완주율: 저장된 경기 수 / 시작 수. 시작은 'match:<mode>:start' 이벤트의 서로 다른 props.matchId 수이고
 * (온라인 두 참가자의 같은 경기는 1), `record: false` 시작은 빼며, matchId가 없는 옛 빌드의 시작은 하나씩 셉니다.
 * 기록된 경기만 있고 시작이 없으면 rate는 null입니다.
 */
function readCompletion(rows, matches) {
    const STARTS = {};
    for (const ROW of rows) {
        const MODE = ROW.starts === null ? null : ROW.name.match(/^match:(.+):start$/)?.[1];
        // record: false 시작만 있는 모드(관전·연습)는 시작 0이라 완주율 표에 넣지 않습니다.
        if (MODE && ROW.starts > 0) {
            STARTS[MODE] = ROW.starts;
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
    const RANGE = readRange(url);
    if (!RANGE) {
        return reply(400, { error: 'days' });
    }
    const { days: DAYS, since: SINCE } = RANGE;
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
        // 이벤트 하나하나를 펼쳐 셉니다(json_each 한 번). 경기 시작(beginMatch가 보내는 match:<mode>:start)은 같은 줄에
        // 완주율의 시작 수(readCompletion)를 함께 셉니다: 서로 다른 matchId + matchId 없는 옛 시작, record: false 제외.
        `, flat AS (
             SELECT p.audience, ${EVENT_NAME_SQL} AS name,
                    json_extract(e.value, '$.category') = 'match' AND json_extract(e.value, '$.action') = 'start' AS is_start,
                    json_extract(e.value, '$.props.matchId') AS match_id,
                    json_extract(e.value, '$.props.record') IS NOT 0 AS counted
             FROM in_range p JOIN batches b ON b.session_id = p.session_id, json_each(b.events) e
             WHERE json_extract(e.value, '$.type') = 'event')
         SELECT audience, name, COUNT(*) AS count,
                CASE WHEN MAX(is_start) THEN COUNT(DISTINCT CASE WHEN counted THEN match_id END)
                    + SUM(counted AND match_id IS NULL) END AS starts
         FROM flat GROUP BY audience, name`,
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
            AUDIENCES.map((audience) => [
                audience,
                readCompletion(
                    EVENTS.results.filter((row) => row.audience === audience),
                    MATCH_COUNTS[audience],
                ),
            ]),
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
            return receiveBatch(request, env);
        }
        const READ = { '/stats': readStats, '/daily': readDaily }[URL_VALUE.pathname];
        if (READ && request.method === 'GET') {
            // 조회 키가 설정되지 않은 배포는 열어 두지 않고 거절합니다.
            if (!env.STATS_KEY) {
                return reply(500, { error: 'stats-key' });
            }
            if (!(await hasStatsKey(request, env))) {
                return reply(401, { error: 'unauthorized' });
            }
            return READ(URL_VALUE, env);
        }
        if (URL_VALUE.pathname === '/whoami' && request.method === 'GET') {
            return readWhoami(request, env);
        }
        return reply(404, { error: 'not-found' });
    },
};

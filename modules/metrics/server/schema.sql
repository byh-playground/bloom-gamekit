-- bloom-gamekit metrics 수집 서버 D1 스키마. 다시 실행해도 기존 데이터를 지우지 않습니다.
-- 무료 한도는 쓰기 행 수로 세므로 인덱스를 따로 두지 않습니다(인덱스 갱신도 쓰기 행입니다).

-- 세션 하나에 한 행. 배치마다 last_seen_at·play_ms를 갱신합니다. tester는 개발자 기기 이름표, origin은 요청 출처입니다.
CREATE TABLE IF NOT EXISTS sessions (
    session_id TEXT PRIMARY KEY,
    game TEXT NOT NULL,
    build TEXT NOT NULL,
    schema_version INTEGER NOT NULL,
    started_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    play_ms INTEGER NOT NULL,
    tester TEXT,
    origin TEXT
);

-- 이벤트가 있는 배치 하나에 한 행. events는 받은 그대로의 JSON 배열입니다.
CREATE TABLE IF NOT EXISTS batches (
    session_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    game TEXT NOT NULL,
    build TEXT NOT NULL,
    schema_version INTEGER NOT NULL,
    received_at INTEGER NOT NULL,
    events TEXT NOT NULL,
    PRIMARY KEY (session_id, seq)
);

-- 경기 하나에 한 행. replay는 결정론 기록 JSON이며 바이트는 {"$bytes": base64}입니다.
CREATE TABLE IF NOT EXISTS matches (
    match_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    game TEXT NOT NULL,
    build TEXT NOT NULL,
    schema_version INTEGER NOT NULL,
    mode TEXT NOT NULL,
    seed TEXT NOT NULL,
    players TEXT NOT NULL,
    summary TEXT NOT NULL,
    replay TEXT NOT NULL,
    recorded_at INTEGER NOT NULL,
    tester TEXT,
    origin TEXT
);

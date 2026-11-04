-- bloom-gamekit metrics 수집 서버 D1 스키마 0002: 원본 사실만 저장합니다(README "수집 서버").
-- 배치마다 갱신하던 누적 열(sessions.last_seen_at·play_ms)과 세션에서 얻는 중복 열(batches·matches의 game·build·schema_version)을 없앱니다.
-- 체류 시간·마지막 수신 시각·플레이 시간은 조회 때 batches에서 계산합니다. 이제 이벤트가 없는 배치도 한 행씩 남깁니다.

-- 클라이언트가 배치마다 보낸 누적 플레이 시간(playMs) 원본.
ALTER TABLE batches ADD COLUMN play_ms INTEGER;

-- 일회성 이관: 0001까지는 세션마다 가장 큰 playMs만 남았으므로 그 값을 세션의 마지막 배치로 옮깁니다.
-- 0001의 세션은 첫 배치 때 이벤트(session_start)가 있어 모두 배치 행이 하나 이상 있습니다.
UPDATE batches SET play_ms = (SELECT s.play_ms FROM sessions s WHERE s.session_id = batches.session_id)
WHERE seq = (SELECT MAX(b.seq) FROM batches b WHERE b.session_id = batches.session_id);

ALTER TABLE sessions DROP COLUMN last_seen_at;
ALTER TABLE sessions DROP COLUMN play_ms;
ALTER TABLE batches DROP COLUMN game;
ALTER TABLE batches DROP COLUMN build;
ALTER TABLE batches DROP COLUMN schema_version;
ALTER TABLE matches DROP COLUMN game;
ALTER TABLE matches DROP COLUMN build;
ALTER TABLE matches DROP COLUMN schema_version;

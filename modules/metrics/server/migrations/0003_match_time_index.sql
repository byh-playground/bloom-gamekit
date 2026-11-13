-- bloom-gamekit metrics 수집 서버 D1 스키마 0003: 경기의 클라이언트 시각 원본과 세션 조인 인덱스.

-- 클라이언트가 recordMatch한 시각(배치의 match.t, 클라이언트 시계 epoch ms). 0002까지는 받고도 버렸습니다.
-- 0003 이전에 저장된 경기는 값이 없어 NULL입니다(recorded_at은 서버 수신 시각).
ALTER TABLE matches ADD COLUMN client_ended_at INTEGER;

-- /stats·/daily가 경기를 세션으로 조인할 때 matches 전체를 훑지 않게 합니다. 경기 1행마다 인덱스 쓰기 1행이 더 듭니다.
CREATE INDEX matches_session_id ON matches (session_id);

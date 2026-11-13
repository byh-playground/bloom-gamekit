// 클라이언트(createMetrics)와 수집 서버(server/worker.js)가 함께 쓰는 전송 계약입니다. 값을 바꾸면 둘이 같이 바뀝니다.

/**
 * 배치 모양의 버전. 출시된 게임 빌드가 보내므로 고정하고 필드는 추가만 합니다(올리지 않음).
 * 깨는 변경은 README "버전 관리"의 변환 절차로만 합니다. 서버는 다른 값을 거부합니다.
 */
export const SCHEMA_VERSION = 3;

/** 이벤트 종류. 'event'만 게임이 `track`으로 보내고 나머지는 세션 수명주기가 만듭니다. */
export const EVENT_TYPES = Object.freeze(['session_start', 'heartbeat', 'event', 'session_end']);

/** 한 배치(요청 하나)의 상한. 경기 기록이 D1 한 행(2MB)에 들어가도록 절반으로 둡니다. */
export const MAX_BATCH_BYTES = 1000000;
export const MAX_BATCH_EVENTS = 100;
export const MAX_BATCH_MATCHES = 4;
/** game·build·sessionId·matchId·category·target·action·mode 문자열 길이 상한 */
export const MAX_NAME_LENGTH = 64;
/**
 * 값 하나의 JSON 크기 상한(UTF-8 바이트, `encodeBytes`로 바꾼 뒤). 클라이언트는 넘기는 순간 던지고 서버는 그 배치를 400으로 거절합니다.
 * props는 이벤트 하나의 부가 값, summary는 경기 요약, players는 참가자 목록, replay는 결정론 기록입니다.
 */
export const MAX_PROPS_BYTES = 2000;
export const MAX_SUMMARY_BYTES = 8000;
export const MAX_PLAYERS_BYTES = 4000;
export const MAX_REPLAY_BYTES = 900000;

/**
 * session_start props의 화면 크기 구간(CSS px). 가로·세로를 각각 이 경계 중 아래쪽으로 내려 'WxH'로 보냅니다.
 * 정확한 크기는 보내지 않습니다(식별성을 줄이려고 원본을 거칠게 받습니다).
 */
export const VIEWPORT_STEPS = Object.freeze([0, 360, 480, 600, 768, 1024, 1280, 1600, 1920]);

/** 페이지가 닫힐 때 sendBeacon·keepalive가 보낼 수 있는 크기. 브라우저 공통 상한 64KiB보다 작게 둡니다. */
export const MAX_UNLOAD_BYTES = 60000;

/** game·build·sessionId·matchId·category·target·action·mode에 쓰는 이름: 1~MAX_NAME_LENGTH자 문자열 */
export function isName(value) {
    return typeof value === 'string' && value.length > 0 && value.length <= MAX_NAME_LENGTH;
}

/** props·summary: 배열이 아닌 JSON 객체 */
export function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

const BYTES_KEY = '$bytes';
const SIZE_ENCODER = new TextEncoder();

function toBase64(bytes) {
    let text = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
        text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    return btoa(text);
}

/** JSON.stringify replacer: Uint8Array를 `{ $bytes: base64 }`로 바꿉니다. rollback replay의 입력·초기 상태가 바이트입니다. */
export function encodeBytes(_key, value) {
    return value instanceof Uint8Array ? { [BYTES_KEY]: toBase64(value) } : value;
}

/** JSON.parse reviver: 저장된 경기 기록을 다시 계산할 때 `{ $bytes }`를 Uint8Array로 되돌립니다. */
export function reviveBytes(_key, value) {
    if (value && typeof value === 'object' && typeof value[BYTES_KEY] === 'string' && Object.keys(value).length === 1) {
        return Uint8Array.from(atob(value[BYTES_KEY]), (char) => char.charCodeAt(0));
    }
    return value;
}

/** 값 하나를 배치에 넣었을 때의 JSON 크기(UTF-8 바이트). 클라이언트·서버가 같은 식으로 상한을 잽니다. undefined는 null로 셉니다. */
export function jsonBytes(value) {
    return SIZE_ENCODER.encode(JSON.stringify(value ?? null, encodeBytes)).byteLength;
}

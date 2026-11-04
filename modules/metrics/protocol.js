// 클라이언트(createMetrics)와 수집 서버(server/worker.js)가 함께 쓰는 전송 계약입니다. 값을 바꾸면 둘이 같이 바뀝니다.

/** 배치 모양의 버전. 서버는 다른 값을 거부합니다. */
export const SCHEMA_VERSION = 1;

/** 이벤트 종류. 'event'만 게임이 `track`으로 보내고 나머지는 세션 수명주기가 만듭니다. */
export const EVENT_TYPES = Object.freeze(['session_start', 'heartbeat', 'event', 'session_end']);

/** 한 배치(요청 하나)의 상한. 경기 기록이 D1 한 행(2MB)에 들어가도록 절반으로 둡니다. */
export const MAX_BATCH_BYTES = 1000000;
export const MAX_BATCH_EVENTS = 100;
export const MAX_BATCH_MATCHES = 4;
/** game·build·sessionId·matchId·category·target·action·mode 문자열 길이 상한 */
export const MAX_NAME_LENGTH = 64;

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

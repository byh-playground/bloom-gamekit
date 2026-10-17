// 기존 N인 검증 화면을 재사용한다. 릴레이 대역과 공개 릴레이의 검증 범위는 화면에 표시한다.
import { serveRepository } from '../../rollback/scripts/browser-helpers.mjs';
const PORT = Number(process.argv[2] ?? 8770);
if (!Number.isInteger(PORT) || PORT < 0 || PORT > 65535) {
    throw new RangeError('port must be an integer from 0 to 65535');
}
const INDEX_PATH = '/modules/transport/tests/group-browser.html';
const SERVER = await serveRepository({
    indexPath: INDEX_PATH,
    port: PORT,
});
console.log(`N인 WebRTC 검사: http://127.0.0.1:${SERVER.address().port}${INDEX_PATH}`);
console.log('같은 브라우저의 실제 RTC 검사입니다. 기본 릴레이 대역은 공개 릴레이/NAT 검증이 아닙니다.');
for (const SIGNAL of ['SIGINT', 'SIGTERM']) {
    process.once(SIGNAL, () => SERVER.close());
}

// 기존 N인 검증 화면을 재사용한다. 릴레이 대역과 공개 릴레이의 검증 범위는 화면에 표시한다.
import { serveRepository } from './browser-helpers.mjs';
const port = Number(process.argv[2] ?? 8770);
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new RangeError('port must be an integer from 0 to 65535');
const indexPath = '/modules/rollback-netcode/tests/group-browser.html';
const server = await serveRepository({ indexPath, port });
console.log(`N인 WebRTC 검사: http://127.0.0.1:${server.address().port}${indexPath}`);
console.log('같은 브라우저의 실제 RTC 검사입니다. 기본 릴레이 대역은 공개 릴레이/NAT 검증이 아닙니다.');
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => server.close());

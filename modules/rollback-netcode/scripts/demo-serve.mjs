import { demoPath, serveRepository } from './browser-helpers.mjs';
const port = Number(process.argv[2] ?? 8771);
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new RangeError('port must be an integer from 0 to 65535');
const server = await serveRepository({ port });
console.log(`한국어 동기화 예제: http://127.0.0.1:${server.address().port}${demoPath}`);
console.log('기본 모드는 같은 브라우저 안에서 실제 WebRTC로 연결하며 공개 릴레이를 사용하지 않습니다.');
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => server.close());

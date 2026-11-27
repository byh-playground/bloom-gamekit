# authoritative-session

## 언제 쓰나

- 서버가 채널 안의 월드 하나를 확정하고 여러 참가자의 입력을 고정 틱에 적용할 때 씁니다. 곡갱이.io의 Node 서버와 Cloudflare Durable Object가 채널마다 같은 세션을 사용합니다.

## 쓰는 모양

```js
// bloom-pickaxe 서버 어댑터의 입력과 스냅샷 흐름
import { createAuthoritativeSession } from './vendor/authoritative-session.js';

const SESSION = createAuthoritativeSession({
    world,
    createInput: () => ({ x: 0, y: 0, attack: false }),
    mergeInput(current, packet) {
        current.x = packet.x;
        current.y = packet.y;
        current.attack ||= packet.attack;
    },
    resetInput(current) {
        Object.assign(current, { x: 0, y: 0, attack: false });
    },
    consumeInput(current) {
        current.attack = false;
    },
});

SESSION.join(playerId, nowMs);
// receive 전에 게임의 패킷 형식과 이동축을 검증합니다.
SESSION.receive(playerId, packet.seq, packet, nowMs);
SESSION.step(nowMs);
const FRAME = SESSION.snapshot(playerId);
// FRAME.snapshot과 FRAME.ackSeq로 게임이 기존 송신 패킷을 작성합니다.
```

## 쓰지 말아야 할 때

- WebRTC 연결과 피어 방 배정에는 [transport](../transport/README.md)를, 입력 예측·롤백에는 [rollback](../rollback/README.md)을 사용합니다.
- 채널 배정·접속 제한, 타이머, WebSocket의 메시지 해석과 송신, 스냅샷 델타는 서버 어댑터나 게임이 맡습니다.

## 계약

- 공개 모듈은 외부 런타임 import가 없는 `dist/authoritative-session.js`입니다. ID 생성과 용량 제한은 어댑터가 소유합니다. `size`는 현재 참가자 수입니다.
- `join(id, nowMs)`은 월드에 참가자를 등록하고 독립 입력을 생성합니다. 중복 참가나 종료 후 참가는 `false`입니다. `leave(id)`는 월드와 입력을 정리하며, 등록되지 않은 ID면 `false`입니다. 재입장은 새 입력 스트림을 시작합니다.
- `receive(id, seq, packet, nowMs)`는 등록된 참가자의 이전 순번보다 큰 안전 정수만 적용하고 성공 여부를 돌려줍니다. `lastReceivedAt(id)`는 참가 또는 마지막 수락 시각입니다. 알 수 없는 ID는 `undefined`입니다.
- `step(nowMs)` 한 번이 월드 틱 한 번입니다. 참가자가 없으면 틱을 실행하지 않습니다. 마지막 수락 후 `inputTimeoutMs`(기본 500 ms)를 **초과**한 입력을 틱 전에 초기화합니다. 월드 틱이 돌아온 뒤 ACK를 갱신하고 입력 에지를 소비합니다. 입력 정책이 정의하는 초기화·소비는 게임마다 다를 수 있습니다.
- `snapshot(id)`은 `{ snapshot, ackSeq }`를 반환합니다. 최초 ACK는 `-1`입니다. 참가자가 없거나 월드가 스냅샷을 만들지 못한 경우 `null`입니다. 발송 성공 여부는 세션의 ACK를 변경하지 않습니다.
- `dispose()`는 전체 세션과 월드를 한 번만 정리합니다. 참가자별 연결 객체는 어댑터가 정리합니다.
- 어댑터는 같은 시계의 밀리초 값을 넘깁니다. 월드와 입력 콜백은 동기적으로 실행합니다. `createInput`은 참가자별 새 상태를 만들고, 나머지 입력 콜백은 받은 입력을 제자리에서 수정합니다. 월드는 틱 중 입력 맵을 읽기만 합니다. 콜백에서 세션을 재진입하거나 입력 맵과 입력 객체를 틱 밖에 저장하지 않습니다. 예외는 호출자에 전달됩니다.

배포본의 고정 시나리오는 `npm run build` 후 `node modules/authoritative-session/tests/session.e2e.mjs`로 재현합니다.

# rollback-netcode 호환 모듈

기존 SDK [보존 snapshot c3173914519a78834360430071e7a125736d86d5](./legacy/README.md)의 plain JavaScript 구현을 기능 소유자별로 옮겼습니다. VERSION은 기존 `0.2.0-dev`, PROTOCOL_VERSION은 1입니다. 새로운 게임 엔진이나 동기화 엔진을 만들지 않았습니다.

## 사용과 계약

전체 기존 API를 유지하려면 외부 import 없는 `dist/rollback-netcode.js` 하나를 사용합니다. 필요한 기능만 선택하면 아래 독립 파일을 조합합니다.

- `rollback.js`: createSession, RollbackSession, createRoomSession, RoomSession, createBootstrapReplay, profiles, VERSION, PROTOCOL_VERSION, CHUNK_SIZE, MAX_TICK
- `deterministic.js`: hashBytes, statelessRandom, SeededPRNG, fixedPoint, createValueCodec, binaryCodec, jsonCodec, createSyncTestSession, SyncTestSession, runSyncTest, runSyncTestAsync, DeterminismError
- `simloop.js`: createLoop
- `transport.js`: WebRTCTransport, createWebRTCPeer, createNostrRoom, createNostrGroupRoom, createNostrDynamicRoom, createNostrPublicRoom, createNostrSignaler, nostrCrypto
- `replay.js`: playReplay

전체 번들과 분리 번들은 대안입니다. 동시에 가져오면 구현 코드가 중복 로드되므로 한 방식을 선택하세요. 분리 번들마다 필요한 순수 도우미가 포함되며 네트워크·세션을 자동 초기화하지 않습니다. 소비자는 npm·Node·bundler가 필요하지 않습니다.

[공개 타입](./rollback-netcode.d.ts), [개발 계약](./CONTRACT.md), [이전 검증](./docs/rollback-migration.md)을 참조하세요. 기존 옵션 설명과 사용 예제는 [보존 snapshot](./legacy/README.md)에 포함된 원본 README.md에 남아 있습니다. 현재 [한국어 실행 예제](./examples/index.html)는 gamekit의 빌드 결과를 사용합니다. 원본 README의 배포·빌드 명령은 원본 저장소 기준이며 이 저장소는 루트 README의 main→dist CI 정책을 따릅니다.

```js
import { createSession, profiles } from './rollback.js';
import { createLoop } from './simloop.js';
import { playReplay } from './replay.js';
const session = createSession({
  players: ['local'], localPlayerId: 'local', sessionId: 'demo',
  simulationVersion: 'your-game-v1', inputSize: 1, profile: profiles.action,
  adapter: gameAdapter // save/load/step/validateSnapshot를 모두 구현
});
const loop = createLoop({ session, getInput, render });
loop.start();
// 종료: loop.stop(); session.close(); 별도 room도 room.close();
```

## 모듈 구성과 실행

`index.js`는 형제 모듈의 공개 API를 조합합니다. `tests/`는 전체 SDK의 API·출처·실제 RTC 통합과 실행 도구를 검사합니다. 기능 단위 검사는 각 소유 모듈의 `tests/`에 둡니다. `docs/`는 이전 검증, `legacy/`는 고정 원본 자료를 소유합니다.

프로젝트 루트에서 `npm run build` 후 `npm run serve:rollback-demo`로 예제를 엽니다. `npm run serve:rollback-group`은 고정 그룹 RTC harness를 엽니다. `npm run test:rollback-demo`는 실제 Chromium 두 페이지를 사용하며 `npm run test:browser`에도 포함됩니다. 공용 relay를 쓰는 `npm run test:rollback-live`는 `RUN_LIVE_ROOM_CHECK=1`을 명시한 경우에만 실행하고 기본 CI에는 포함하지 않습니다.

측정 도구는 `npm run benchmark:rollback`, `npm run benchmark:rollback-primitives`, `npm run benchmark:rally`입니다. Rally 측정은 외부 소비자 fixture를 명시적으로 지정해야 하며 원본 게임 상태를 이 모듈이 소유하지 않습니다. 각 도구의 과거 결과와 현재 실행 결과를 구분하세요.

## 보존한 동작

프로토콜 VERSION과 packet framing, save/load bytes, RV codec 형식, input/command sequence와 tick, snapshot 검증·복구 트랜잭션, replay schema를 바꾸지 않았습니다. 새 모드 HELLO 필드가 없는 이전 bundle과의 혼합 연결은 거절합니다. 배포 파일 SHA는 번들러·경로 변경 때문에 달라집니다. 이 이유만으로 게임 simulationVersion을 바꾸거나 저장 파일을 변환하지 않습니다.

기본 rollback 모드의 StateHistory는 기존 full-copy snapshot ring입니다. 설정 가능한 효율적 lockstep 모드와 checkpoint·hash·복구의 비용/호환성은 [실행 모드 계약](../rollback/README.md#실행-모드-rollback--lockstep)을 따릅니다. FullCopy/NativeMemento/DirtyDelta/UndoLog/CheckpointDelta 전략은 이 이전에 새로 구현하지 않았습니다. `_rollback-shared`는 protocol/frame/StateHistory의 단일 내부 구현이며 별도 공개 SDK가 아닙니다. 재실행·진단·replay가 같은 frame 실행 경계를 재사용합니다.

onEvent의 `rollback`은 state load 후, 동기적 재실행 전에 전달됩니다. poll/advance가 반환되면 재실행이 끝납니다. `confirmedTick`은 마지막 확정 입력 tick이고 `tick`은 다음 실행 tick입니다. 표현은 `Math.min(session.confirmedTick, session.tick - 1)`까지 확정할 수 있습니다. 복구 후보의 `recovering:true` 실행은 거절될 수 있으므로 확정 전 외부 효과를 발생시키면 안 됩니다.

## 출처와 배포

[provenance.json](./provenance.json)의 files에 원본 저장소·commit·파일 SHA-256을 보존합니다. 이전 후 core/loop 수정은 별도 modifiedFiles 해시와 사유로 기록하며 수정본과 원본의 byte-identical을 주장하지 않습니다. 원본 commit에는 LICENSE 파일이 없습니다. 기존 저작권/참고 문구를 보존하며 임의의 라이선스를 부여하지 않습니다. BIP-340 fixture는 기존 테스트의 원본과 참조를 보존합니다. 기존 저장소와 과거 배포는 수정하거나 삭제하지 않습니다.

소스만 main에 커밋하고 GitHub Actions가 `dist` 브랜치에 독립 JS와 manifest를 생성합니다. dist commit SHA로 고정하고 manifest의 SHA-256을 검증하세요. 별도 Pages·Release·npm·artifact 저장·유료 runner를 추가하지 않습니다.


## 진행 중 합류와 공개 Start

고정 매치 API는 그대로입니다. 새 게임이 같은 세계에서 1명부터 시작하고 실행 중 참가자 변경을 받아야 하면 [RoomSession 계약](../rollback/README.md#동적-방-세션-같은-세계-바뀌는-roster)과 [동적/공개 transport](../transport/README.md)를 사용합니다. `createNostrPublicRoom`은 서버 없는 Nostr 디렉터리/자리 예약을 처리하고, `createRoomSession`은 기존 lockstep Core를 membership epoch로 조합합니다. 실제 입장 commit과 세계 상태는 transport가 소유하지 않습니다.

분할 네트워크에서 독립적으로 host를 선출하지 않으며, graceful coordinator 퇴장은 합의된 경계에서 승계합니다. 탭 새로고침은 opt-in room-scoped sessionStorage identity와 살아 있는 peer의 상태를 필요로 합니다. 공용 relay/NAT/모바일 성능은 Node fixture 통과만으로 검증되지 않습니다.

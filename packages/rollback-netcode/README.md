# rollback-netcode 호환 모듈

기존 SDK [c3173914519a78834360430071e7a125736d86d5](https://github.com/byh-playground/rollback-netcode/tree/c3173914519a78834360430071e7a125736d86d5)의 plain JavaScript 구현을 기능 소유자별로 옮겼습니다. VERSION은 기존 `0.2.0-dev`, PROTOCOL_VERSION은 1입니다. 새로운 게임 엔진이나 동기화 엔진을 만들지 않았습니다.

## 사용과 계약

전체 기존 API를 유지하려면 외부 import 없는 `dist/rollback-netcode.js` 하나를 사용합니다. 필요한 기능만 선택하면 아래 독립 파일을 조합합니다.

- `rollback.js`: createSession, RollbackSession, profiles, VERSION, PROTOCOL_VERSION, CHUNK_SIZE, MAX_TICK
- `deterministic.js`: hashBytes, statelessRandom, SeededPRNG, fixedPoint, createValueCodec, binaryCodec, jsonCodec, createSyncTestSession, SyncTestSession, runSyncTest, runSyncTestAsync, DeterminismError
- `simloop.js`: createLoop
- `transport.js`: WebRTCTransport, createWebRTCPeer, createNostrRoom, createNostrGroupRoom, createNostrSignaler, nostrCrypto
- `replay.js`: playReplay

전체 번들과 분리 번들은 대안입니다. 동시에 가져오면 구현 코드가 중복 로드되므로 한 방식을 선택하세요. 분리 번들마다 필요한 순수 도우미가 포함되며 네트워크·세션을 자동 초기화하지 않습니다. 소비자는 npm·Node·bundler가 필요하지 않습니다.

[공개 타입](rollback-netcode.d.ts), [개발 계약](CONTRACT.md), [이전 검증](../../docs/rollback-migration.md)을 참조하세요. 옵션과 기존 사용 예제는 고정된 [upstream README](https://github.com/byh-playground/rollback-netcode/blob/c3173914519a78834360430071e7a125736d86d5/README.md)에서 확인할 수 있습니다. 원본 README의 배포·빌드 명령은 원본 저장소 기준이며 이 저장소는 루트 README의 main→dist CI 정책을 따릅니다.

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

## 보존한 동작

프로토콜 VERSION과 packet framing, save/load bytes, RV codec 형식, input/command sequence와 tick, snapshot 검증·복구 트랜잭션, replay schema를 바꾸지 않았습니다. 새 모드 HELLO 필드가 없는 이전 bundle과의 혼합 연결은 거절합니다. 배포 파일 SHA는 번들러·경로 변경 때문에 달라집니다. 이 이유만으로 게임 simulationVersion을 바꾸거나 저장 파일을 변환하지 않습니다.

기본 rollback 모드의 StateHistory는 기존 full-copy snapshot ring입니다. 설정 가능한 효율적 lockstep 모드와 checkpoint·hash·복구의 비용/호환성은 [실행 모드 계약](../rollback/README.md#실행-모드-rollback--lockstep)을 따릅니다. FullCopy/NativeMemento/DirtyDelta/UndoLog/CheckpointDelta 전략은 이 이전에 새로 구현하지 않았습니다. `_rollback-shared`는 protocol/frame/StateHistory의 단일 내부 구현이며 별도 공개 SDK가 아닙니다. 재실행·진단·replay가 같은 frame 실행 경계를 재사용합니다.

onEvent의 `rollback`은 state load 후, 동기적 재실행 전에 전달됩니다. poll/advance가 반환되면 재실행이 끝납니다. `confirmedTick`은 마지막 확정 입력 tick이고 `tick`은 다음 실행 tick입니다. 표현은 `Math.min(session.confirmedTick, session.tick - 1)`까지 확정할 수 있습니다. 복구 후보의 `recovering:true` 실행은 거절될 수 있으므로 확정 전 외부 효과를 발생시키면 안 됩니다.

## 출처와 배포

[provenance.json](provenance.json)의 files에 원본 저장소·commit·파일 SHA-256을 보존합니다. 이전 후 core/loop 수정은 별도 modifiedFiles 해시와 사유로 기록하며 수정본과 원본의 byte-identical을 주장하지 않습니다. 원본 commit에는 LICENSE 파일이 없습니다. 기존 저작권/참고 문구를 보존하며 임의의 라이선스를 부여하지 않습니다. BIP-340 fixture는 기존 테스트의 원본과 참조를 보존합니다. 기존 저장소와 과거 배포는 수정하거나 삭제하지 않습니다.

소스만 main에 커밋하고 GitHub Actions가 `dist` 브랜치에 독립 JS와 manifest를 생성합니다. dist commit SHA로 고정하고 manifest의 SHA-256을 검증하세요. 별도 Pages·Release·npm·artifact 저장·유료 runner를 추가하지 않습니다.

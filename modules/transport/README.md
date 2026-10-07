# transport

WebRTC 바이너리 전송과 Nostr 방·시그널링을 제공합니다. 게임 상태와 세션을 만들지 않습니다.

공개 API: `WebRTCTransport, createWebRTCPeer, createNostrRoom, createNostrGroupRoom, createNostrDynamicRoom, createNostrSignaler, nostrCrypto`. 외부 import가 없는 `dist/transport.js` 하나로 사용할 수 있습니다. 도구 설치나 다른 모듈 초기화는 필요하지 않습니다.

기존 rollback-netcode의 동일 함수를 책임별로 이동했습니다. [공개 타입](../rollback-netcode/rollback-netcode.d.ts), [개발 계약](../rollback-netcode/CONTRACT.md), [상세 사용법과 이전](../rollback-netcode/README.md)을 따릅니다. 이 모듈은 게임 규칙·권위 상태를 정의하지 않습니다.

## 소유권과 비용

방 close와 session close는 각 소유자의 자원을 정리합니다. Nostr 시그널링은 공개 서명 메시지이며 민감한 게임 상태를 넣지 않습니다. 실제 통신은 명시적으로 생성할 때만 시작합니다. 단순 import에는 접속 부수 효과가 없습니다.


## 동적 방 연결 capability

`createNostrDynamicRoom({ role: 'host' | 'join', room, namespace, ... })`은 같은 방에서 참가·이탈·재연결을 계속 처리하는 1..5인 mesh 연결입니다. 고정 2..8인 `createNostrGroupRoom`의 시작 barrier나 roster 계약은 바꾸지 않습니다. Nostr에는 discovery와 SDP/ICE만 보내며 게임 제어·snapshot·입력은 RTC를 사용합니다. 기본 ICE는 기존 `createWebRTCPeer`와 같은 STUN이며 서버나 자동 TURN fallback은 추가하지 않습니다.

- host는 Nostr 초기화 직후 혼자 반환됩니다. join은 발견한 coordinator와 RTC가 연결되면 반환됩니다. **연결 완료는 게임 참가 승인이나 snapshot 동기화 완료가 아닙니다.** join의 초기 `players`에는 자신이 없을 수 있습니다.
- `localPlayerId`, `sessionId`, `coordinatorId`, `epoch`, `players`, `role`, `joining`, `closed`를 제공합니다. `role`은 최초 생성 역할이며 현재 coordinator는 `coordinatorId === localPlayerId`로 판단합니다. `players`는 정렬·동결된 승인 roster입니다.
- `transports: Map<playerId, Transport>`와 `peerConnections`는 현재 열린 물리 연결입니다. 소비자는 Map을 직접 수정하지 않습니다. 게임 바이너리 채널은 상위 RoomSession이 소유하며 제어 패킷과 시뮬레이션 패킷을 한 곳에서 분류해야 합니다. transport는 `BMDYNPR1`로 시작하는 정확히 25-byte 생존 확인 프레임만 내부에서 분류·제거합니다. 게임 패킷에 추가 헤더를 붙이지 않습니다.
- `subscribe(fn)`은 `{ type: 'peer-connected', peerId, transport, generation }`, `{ type: 'peer-disconnected', peerId, reason }`, `peer-failed`, `signal-error`, `room-closed` 등의 이벤트를 전달하고 해제 함수를 반환합니다. 이전 이벤트를 재생하지 않으므로 구독한 뒤 현재 `transports`도 확인합니다. `onStatus`는 같은 생명주기 및 하위 peer 진단 이벤트를 받습니다. 관찰자의 예외는 연결을 중단하지 않습니다.
- `setRoster({ epoch, players, coordinatorId })`는 상위 세션이 확정한 roster를 반영합니다. epoch은 0..65534 정수이며 이전 epoch와 같은 epoch의 다른 내용은 거절합니다. 같은 내용의 중복 호출은 허용합니다. 첫 host roster는 epoch 0 / `[localPlayerId]`입니다. 정상 이탈 또는 대기 중인 참가자의 최신 welcome 반영을 위해 자신이 빠진 roster도 허용합니다. 대기 후보가 새 epoch를 반영하면 해당 epoch의 재전송 mesh 초대를 처리하며, 아직 승인된 적 없는 후보의 resume record를 이탈로 오인해 삭제하지 않습니다.
- `connectMesh(players): Promise<void>`는 제안된 참가자 사이의 로컬 연결이 모두 열릴 때 완료됩니다. coordinator는 Nostr로 제한된 임시 연결 초대를 전달하므로 새 참가자와 기존 참가자 사이에서도 mesh를 구성할 수 있습니다. 이 호출도 승인 roster를 변경하지 않습니다. 모든 참가자의 준비 여부는 상위 RoomSession이 확인합니다.
- `reconnect(peerId): Promise<Transport>`는 **현재 capability의 같은 Nostr identity**로 RTC 연결을 교체합니다. peer별 증가 generation과 무작위 connection ID로 이전 SDP/ICE를 격리합니다. 동시 재연결 요청은 결정론적 initiator가 합칩니다. 기본값에서는 새 capability가 새 identity입니다. 명시적인 `resume` 설정을 사용하면 아래의 탭 저장소 복원을 선택할 수 있습니다.
- `setRoster`는 빠진 참가자의 연결을 즉시 닫지 않습니다. RoomSession이 commit 전달·확인을 마친 뒤 `disconnect(peerId)`로 해당 물리 연결·대기·임시 초대·신호 backlog를 정리합니다. 이 메서드는 roster를 변경하지 않습니다. `close()`는 모든 자원과 타이머를 정리합니다.
- 새 coordinator가 확정된 뒤 각 세션이 `setRoster`를 호출하면 그 참가자가 동일한 sessionId/방 코드를 다시 광고합니다. coordinator의 갑작스러운 손실을 투표·자동 선출·새 게임 시작으로 바꾸지 않습니다. 이 동작의 결정과 복구 UI는 RoomSession/게임 책임입니다.

```js
import { createNostrDynamicRoom } from './transport.js';

const room = await createNostrDynamicRoom({ role: 'host', namespace: 'my-game' });
// RoomSession에 capability를 전달합니다. 여기서는 게임 admission을 직접 만들지 않습니다.
console.log(room.room, room.localPlayerId, room.players);
// 종료 시 RoomSession을 먼저 닫고 방 소유자가 room.close()를 호출합니다.
```

### 시간·크기·실패 한도

설정 시간의 단위는 모두 ms입니다. 기본값은 초기 `timeoutMs: 60000`, 연결·미승인 참가자 유효시간 `peerTimeoutMs: 20000`, 신호 재시도 `retryMs: 1500`, coordinator 광고 `advertiseIntervalMs: 5000`입니다. `maxPlayers`는 1..5(기본 5), 동시 미완료 연결 `maxPendingPeers`는 1..5(기본 5)입니다. `signal`은 생성 전후 abort를 지원하며 초기 signaler 생성 자체도 timeout으로 제한됩니다. transport 단독으로 연결된 뒤 `peerTimeoutMs` 안에 승인되지 않은 coordinator의 후보 연결은 정리됩니다.

신호 publication은 최대 32개, RTC 대기 연결은 최대 5개이며 이전 연결의 commit 정리를 고려한 총 물리 연결도 제한됩니다. RTC 신호는 128 KiB 이하, 사전 수신 backlog는 최대 5 scope / scope당 32개 / 총 2 MiB이며 연결 시간 뒤 만료됩니다. 완료된 연결의 offer/answer 재전송은 멈추며 연결 실패는 그 peer만 보고합니다. peer별 지난 generation은 제한된 64개 tombstone으로 관리합니다. 재시도는 타이머와 deadline을 사용하며 busy loop나 무기한 초기 접속 대기는 없습니다.

`expectedSessionId`로 join 대상 session을 고정할 수 있습니다. 다른 session의 광고는 선택하지 않으며 저장된 resume session이 기대값과 다르면 명시적으로 실패합니다. `authorizeJoin(peerId, { sessionId, room })`는 coordinator가 새 후보를 받기 전에 실행하는 동기 reservation gate입니다. 정확히 `true`를 반환해야 승인하며 기존 확정 참가자 복구는 새로운 admission으로 계산하지 않습니다.

기본 public Nostr relay가 서명을 검증하지만 방 코드는 비밀·인증 수단이 아닙니다. 동적 방은 `namespace + ':dynamic-v1'`으로 고정 방과 격리하며, 네 자리 코드의 전 세계 유일성이나 공개 방 목록을 보장하지 않습니다. roster 승인·게임 버전 확인·snapshot 검증·epoch 전환은 반드시 상위 세션이 수행해야 합니다.

`modules/transport/tests/dynamic-room.test.mjs`는 주입된 메모리 signaler/peer capability로 1→5인 mesh, 연결과 admission 분리, coordinator 초대, generation 재연결, 정상 승계, 신호 손실, backlog 한도, 종료·abort·deadline을 검증합니다. 이 Node fixture를 실제 Nostr relay·브라우저 RTC·NAT/모바일 검증으로 부르지 않습니다.


### 명시적인 탭 저장소 resume

`resume: { storage: sessionStorage, key?, lifetimeMs?, reset? }`를 전달하면 같은 페이지를 새로고침한 뒤 살아 있는 같은 방에 복귀할 수 있습니다. 기본 저장은 없으며 cookie·서버·지갑·사용자 계정은 만들지 않습니다. 여기서 `sessionStorage`는 소비자 앱이 명시적으로 제공하는 표준 저장소 capability입니다. 기본 key에는 namespace와 방 코드가 들어가며 저장 내용에는 동일 sessionId, 확정 roster/epoch, coordinator와 임시 Nostr 개인 서명 키가 포함됩니다. 기본 수명은 8시간, 범위는 1000ms..24시간이고 갱신 때 수명을 무한 연장하지 않습니다.

- 새로고침에는 **같은 room 코드·namespace·storage key**를 다시 전달해야 합니다. host에서 방 코드를 생략해 새 코드를 생성하면 이전 방을 찾아내지 않습니다. 저장된 참가자 identity가 기존 승인 roster에 있으면 `resumed: true`이며, RTC 연결만 복원한 상태이므로 RoomSession의 새 snapshot/suffix 검증을 기다려야 합니다.
- `resumePeerId`는 처음 복구한 상대입니다. coordinator 자신이 새로고침했을 때도 다른 살아 있는 승인 참가자가 동일 sessionId에 한정된 resume discovery를 답하고 그 참가자와 먼저 연결합니다. `coordinatorId`를 바꾸거나 새 세계를 만들지 않습니다. 혼자 남았거나 모든 참가자가 사라졌으면 초기 timeout으로 명시적으로 실패합니다.
- 기존 동일 identity 연결이 있으면 암호학적으로 무작위 nonce를 넣은 신뢰 채널 probe로 생존을 확인합니다. 기존 탭이 응답하면 중복 탭을 거절하며 기존 연결을 퇴출하지 않습니다. 기본 `resumeProbeMs: 1500` 후 응답이 없으면 새로운 incarnation/generation을 승인합니다. 각 RTC 신호는 상대 incarnation까지 범위를 제한하므로 복제 탭의 오래된 신호가 새 연결로 들어오지 않습니다. 네트워크 partition의 절대적인 단일 실행 증명은 아니며 게임 세션은 여전히 unanimous epoch barrier와 fail-closed 정책을 사용합니다.
- `close()`는 RTC/메모리 키를 정리하되 아직 유효한 저장 record를 남깁니다. `forgetResume()`는 미래 복구를 위한 저장 record를 삭제합니다. 확정 roster에서 자신이 빠지면 자동 삭제합니다. `resume.reset: true`는 이전 record를 버리고 명시적으로 새 identity를 시작합니다.
- 만료·손상·잘못된 키·다른 namespace/room record는 초기화 오류로 반환합니다. 실패 후 재시도해도 자동으로 새 identity로 조용히 바뀌지 않습니다. 사용자가 새 방/초기화를 선택한 뒤 `reset: true`를 전달합니다. 저장소가 금지되거나 quota에 걸린 경우도 오류이며 무저장 resume로 가장하지 않습니다.

이 저장 키는 짧게 쓰는 게임 세션 키이지만 **개인 서명 키**입니다. 앱은 record를 로그·URL·공유 payload에 넣지 않아야 합니다. sessionStorage는 같은 origin의 JavaScript에서 읽을 수 있으므로 XSS 방어가 필요하며 보안 vault나 HttpOnly cookie와 같지 않습니다. Room capability는 비밀 키를 반환하지 않습니다. 기본 Nostr signaler의 선택적 `identity: { id, sign(hash, auxiliary, cryptoImpl), close() }`는 내부 저장 helper가 쓰는 서명 capability이고 원시 키 인자가 아닙니다. 개인 wallet 키를 이 기능에 재사용하지 않습니다.

## 공개 방 자동 선택

`createNostrPublicRoom({ namespace, simulationVersion, ... })`은 Start 한 번에 살아 있는 호환 공개 방을 찾고, 자리를 예약한 뒤 그 방의 `DynamicRoom` capability를 반환합니다. 건강한 relay에서 관찰한 결과에 참가 가능한 방이 없으면 무작위 네 자리 코드와 별도의 무작위 sessionId를 가진 새 host를 만듭니다. 이후에는 같은 `createRoomSession({ mode: 'online', room, ... })`을 사용합니다. **예약과 RTC 연결은 게임 참가 승인·snapshot 복구 완료가 아닙니다.** 최종 roster와 admission은 계속 RoomSession/Core가 확정합니다.

```js
const room = await createNostrPublicRoom({
  namespace: 'my-game', simulationVersion: 'my-simulation-v1', maxPlayers: 5,
  resume: { storage: sessionStorage }, // 선택 사항; 기본 저장 없음
});
const session = createRoomSession({ mode: 'online', room, simulationVersion: 'my-simulation-v1',
  inputSize, adapter, membership: { maxPlayers: 5 } });
```

- 목록은 같은 public Nostr relay의 `namespace + ':public-v1'` / `0000` 채널에만 있습니다. 실제 게임 방 신호는 기존 `:dynamic-v1`과 선택된 방 코드로 분리합니다. 별도 서버·DB·계정·지갑·고정 공개 shard·자동 TURN fallback을 추가하지 않습니다. `relays`, `rtcConfig`는 기존 capability로 전달합니다.
- 광고에는 simulationVersion, 최대 인원, 방 코드, sessionId, coordinator의 서명 identity, 확정 roster/epoch, 증가 sequence, 발행·만료 시각, 확정 인원과 미완료 예약 인원만 넣습니다. 게임 snapshot·입력·저장 키는 목록에 넣지 않습니다. Nostr signaler가 서명/namespace를 검증하고, directory가 짧은 lease와 epoch/sequence를 검사합니다. 방 코드가 우연히 같아도 join의 `expectedSessionId`로 다른 세계의 광고를 채택하지 않습니다.
- coordinator가 예약을 단독 관리하며 `확정 인원 + 미완료 예약 <= maxPlayers`를 유지합니다. 하나의 서명 identity에는 한 자리만 있고 중복 요청으로 수명을 연장하지 않습니다. 예약은 **directory 요청자와 실제 RTC의 동일한 서명 identity**에 귀속되며 공개 payload의 requestId를 복사해서 사용할 수 없습니다. `authorizeJoin`은 이 identity의 유효한 예약을 확인한 뒤에만 미승인 연결 후보를 만듭니다. 예약 release·실패/이탈·만료는 자리를 반환하며 확정된 참가자는 pending에서 빠집니다.
- `setRoster`로 확정 인원이 바뀌면 광고를 갱신합니다. 같은 coordinator의 순차 admission 동안 다른 참가자의 예약은 유지합니다. 정상 승계로 coordinator가 바뀌면 새 coordinator가 동일 방/sessionId와 새 epoch를 광고하며 이전 coordinator의 미승인 예약은 폐기합니다. 갑작스러운 coordinator 손실을 자동 선거·새 게임 시작으로 대체하지 않습니다.
- 연결된 relay subscription과 관찰 구간 전후의 positive publication OK를 확인합니다. `PUBLIC_RELAY_UNAVAILABLE`은 relay 접속/발행 실패이며, 이 경우 목록이 비었다고 해석해 새 세계를 만들지 않습니다. 선택한 방이 실패하면 제한된 다른 후보를 확인하고, 현재 목록에 실패한 후보만 남으면 명시적으로 실패합니다. 호환 방이 모두 가득 찬 경우는 참가 가능한 방이 없는 경우입니다.
- 공개 relay는 전역 유일한 목록이나 가용성 합의를 제공하지 않습니다. 동시에 빈 목록에서 시작한 두 사용자는 각각 방을 만들 수 있고, relay 분할·검열·NAT·시계 차이로 발견/연결이 실패할 수 있습니다. 광고는 서명된 발견 힌트이며 처음 보는 coordinator의 멤버십을 외부에서 증명하지 않습니다. 알려진 session의 coordinator 교체는 이전 광고의 roster와 증가 epoch를 검사합니다. 악성 identity/Sybil에 대한 신뢰·치트 방지는 이 목록 기능의 계약이 아닙니다.

시간은 모두 ms이며 기본값은 `discoveryMs: 1500`, 전체 초기화 `totalTimeoutMs: 60000`, 광고 `leaseMs: 15000`, 예약 `reservationMs: 30000`, 최대 후보 시도 `maxAttempts: 3`입니다. 범위는 각각 10..30000, 10..120000, 100..60000, 100..120000, 1..8입니다. 광고는 lease의 약 1/3마다 갱신됩니다. directory는 최대 64개 lease, 동시 publication은 최대 16개, 예약은 최대 4개입니다. RTC 시도는 전체 deadline과 `peerTimeoutMs`로 제한하며 무기한 초기 접속이나 busy loop는 없습니다. `peerFactory`, `signalerFactory`, `dynamicRoomFactory` 주입은 로컬 검증용 capability이며 실제 기본 경로도 동일한 한도를 적용합니다.

반환 capability는 기존 DynamicRoom API와 `publicMetrics: { directoryEntries, pendingReservations, pendingPublications }`를 제공합니다. `onStatus`/`subscribe`에는 기존 동적 방 이벤트와 `public-discovering`, `public-hosting`, `public-joining`, `public-resuming`, `public-attempt-failed`, `public-directory-error`, `public-room-ready`, `public-room-closed`가 추가됩니다. `close()`는 directory subscription/타이머, 방 연결, 메모리 키를 함께 닫습니다. shutdown 중 전달되지 않은 예약 release는 연결 종료나 짧은 예약 만료로 회수됩니다. 소유자는 graceful leave가 필요하면 session의 leave를 먼저 완료한 뒤 닫습니다.

### 공개 방의 명시적 resume

같은 `resume: { storage, key?, lifetimeMs?, reset? }`를 매번 전달하면 방 코드를 앱이 따로 기억하지 않아도 확정된 방으로 복귀할 수 있습니다. 저장소에는 namespace·simulationVersion에 한정된 작은 공개 방 pointer와 **방 코드에 한정된** 기존 identity record만 둡니다. 사용자 공통 credential은 만들지 않습니다. `key`를 지정하면 방 identity key에 `:<room>`을 붙이고 pointer key에는 `:pointer`를 붙입니다. pointer는 admission이 확정된 뒤에만 보존합니다.

복원 시 저장된 정확한 room/sessionId와 기존 live-peer challenge를 사용합니다. 살아 있는 방을 찾지 못하거나 저장 record가 손상·만료되면 새 세계나 identity로 자동 대체하지 않습니다. `forgetResume()`는 pointer와 해당 방 record를 지우고, 명시적인 `reset: true`는 새 선택을 시작합니다. `close()`만으로는 유효한 resume record를 지우지 않습니다. 개인 서명 키와 sessionStorage의 보안 한계는 위의 동적 방 resume 계약과 같습니다.

`modules/transport/tests/public-room.test.mjs`는 메모리 signaling/RTC fixture로 건강한 빈 목록, relay 실패 구분, 1→5 연결과 admission 분리, 동시 예약, 만료·release, identity 귀속, 호환 버전, 목록 크기, 정상 승계, resume와 deadline/abort 정리를 검사합니다. 이 검사를 public relay·실제 인터넷·브라우저 RTC·모바일 NAT 검증으로 부르지 않습니다.

중간 roster 광고를 놓친 승계는 이전 lease를 후보에서 제외하고 원래 만료 뒤 새로 발행된 승계 광고를 기다리며, 그동안 `PUBLIC_HANDOVER_PENDING`으로 명시적으로 실패할 수 있습니다. 이를 빈 목록으로 보고 새 세계를 만들지 않습니다.

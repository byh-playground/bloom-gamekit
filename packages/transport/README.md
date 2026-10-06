# transport

WebRTC 바이너리 전송과 Nostr 방·시그널링을 제공합니다. 게임 상태와 세션을 만들지 않습니다.

공개 API: `WebRTCTransport, createWebRTCPeer, createNostrRoom, createNostrGroupRoom, createNostrSignaler, nostrCrypto`. 외부 import가 없는 `dist/transport.js` 하나로 사용할 수 있습니다. 도구 설치나 다른 모듈 초기화는 필요하지 않습니다.

기존 rollback-netcode의 동일 함수를 책임별로 이동했습니다. [공개 타입](../rollback-netcode/rollback-netcode.d.ts), [개발 계약](../rollback-netcode/CONTRACT.md), [상세 사용법과 이전](../rollback-netcode/README.md)을 따릅니다. 이 모듈은 게임 규칙·권위 상태를 정의하지 않습니다.

## 소유권과 비용

방 close와 session close는 각 소유자의 자원을 정리합니다. Nostr 시그널링은 공개 서명 메시지이며 민감한 게임 상태를 넣지 않습니다. 실제 통신은 명시적으로 생성할 때만 시작합니다. 단순 import에는 접속 부수 효과가 없습니다.

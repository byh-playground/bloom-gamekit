# rollback 내부 공유 구현

`protocol.js`는 frame·packet·profile 계약, `history.js`는 snapshot·checkpoint 보관을 소유합니다. rollback, deterministic, transport, replay의 단일 내부 구현이며 공개 배포 모듈이 아닙니다.

게임은 [rollback-netcode 공개 API](../rollback-netcode/README.md) 또는 각 독립 모듈의 진입점을 사용합니다. 이 디렉터리의 구현을 복제하거나 직접 사용하는 소비자 계약을 추가하지 않습니다. 공개 번들 빌드는 필요한 코드를 포함하며 외부 runtime import를 남기지 않습니다.

# save

게임 저장 레코드 하나(키 하나)를 읽고, 이관하고, 검증하고, 다른 탭과의 충돌을 감지하는 순수 ESM 모듈입니다. 레코드의 의미·기본값·검증 규칙·이관 내용은 게임이 소유합니다. 저장소는 어댑터로 바꿔 끼웁니다: IndexedDB, localStorage, 메모리.

```js
import { createSave, indexedDbAdapter, memoryAdapter } from '@bloom-gamekit/save';

const CLUB = createSave({
    adapter: indexedDbAdapter({ database: 'bloom-takraw-club', store: 'club' }),
    key: 'my-team',
    version: 1,
    create: () => defaultClub(), // 레코드가 없을 때만
    validate: validateClub, // 형식이 틀리면 던집니다
    migrate: { 1: (data) => ({ ...data, campaign: { cleared: [] } }) }, // schema 1 → 2
});
await CLUB.load(); // CLUB.data
await CLUB.update((draft) => {
    draft.credits -= 10;
});
CLUB.onExternalChange(({ revision }) => showReloadNotice(revision));

// 디버그 장면·시험: 저장된 데이터와 무관하게 항상 같은 상태
const FIXED = createSave({ ...CLUB_OPTIONS, adapter: memoryAdapter() });
```

## 계약

- 저장되는 모양은 게임 데이터에 `schema`(버전)와 `revision`(쓰기 횟수)을 더한 평평한 객체입니다. `data`에는 둘이 빠진 게임 데이터만 있습니다.
- API는 어댑터와 무관하게 항상 비동기입니다. 같은 save의 `load`·`update`는 호출 순서대로 하나씩 실행합니다.
- `load()`: 레코드가 없으면 `create()`로 만들어 revision 0으로 저장합니다. 저장된 `schema`가 `version`보다 낮으면 `migrate[n]`을 차례로 적용해 저장하고 revision을 1 올립니다.
- **읽지 못한 저장은 덮어쓰지 않습니다.** schema·revision이 없거나, JSON이 아니거나, 미래 schema이거나, 이관 단계가 없거나, `validate`가 던지면 `SaveError('unreadable')`을 던지고 `locked`가 됩니다. 잠긴 save의 `update`는 거부합니다. 기본값이나 새 레코드로 바꾸지 않습니다.
- `update(mutate)`: 저장소의 레코드 복사본을 `mutate`에 주고, `validate`를 통과하면 revision을 1 올려 저장합니다. `mutate`가 `false`를 반환하면 저장하지 않습니다. `mutate`는 동기 함수여야 합니다(IndexedDB 트랜잭션 안에서 실행). 마지막으로 읽은 revision과 저장소가 다르면 아무것도 쓰지 않고 `SaveError('conflict')`를 던집니다. 다시 `load()`한 뒤 고치세요.
- `mutate`·`validate`·`create`·`migrate`가 던진 게임 오류는 바꾸지 않고 그대로 전달합니다(단, `load` 중 `validate` 실패는 unreadable로 감쌉니다). 저장소 자체의 실패는 `SaveError('storage')`, `dispose()` 뒤 호출은 `SaveError('closed')`입니다.
- 다른 탭이 같은 레코드를 저장하면 BroadcastChannel로 `onExternalChange({revision})`을 부릅니다. 메모리 어댑터는 알리지 않습니다.

## 어댑터

- `indexedDbAdapter({database, store='records'})`: 읽기와 쓰기를 한 `readwrite` 트랜잭션에서 합니다. 데이터베이스 버전 1에서 `store`가 없으면 만듭니다.
- `localStorageAdapter({prefix=''})`: `prefix + key`에 JSON으로 둡니다. 한 탭 안에서는 읽기·쓰기 사이에 끼어들 수 없고, 다른 탭과의 경합은 revision 비교로 감지합니다.
- `memoryAdapter(records={})`: 메모리에만 둡니다. `records`는 저장 모양(`schema`·`revision` 포함)입니다. 비우면 첫 `load`가 `create()`를 씁니다.
- 직접 만들 때는 `{channelName, transact(key, body), close?}`를 구현합니다. `body(stored)`는 `{value, write}`를 반환하며, `write`가 true면 같은 단계에서 `value`를 저장해야 합니다.

## 범위

백업(마지막 정상본·원본)과 가져오기·내보내기는 아직 없습니다. 실제로 필요한 게임을 옮길 때 추가합니다.

[고정 브라우저 시나리오](./tests/save.browser.mjs)는 실제 IndexedDB·localStorage·BroadcastChannel에서 생성·건너뛰기·규칙 오류·두 탭 충돌과 알림·다시 읽기·읽지 못한 저장 보존·미래 schema·이관을 확인합니다.

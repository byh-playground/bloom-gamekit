# navigation

독립 `navigation.js`는 해시 화면과 브라우저 이력을 소유합니다. UI·포커스·스크롤·게임 입력·구매 명령은 소비자가 소유합니다.

## API

`createNavigation({window=globalThis.window, normalize=route=>route})`.
화면은 `{screen:'tech', item:'iceGarden', query:'tab=details'}`이며 `#/tech/iceGarden?tab=details`로 표현합니다. screen/item은 각각 URL 인코딩하며 query는 URLSearchParams 복사본입니다. main은 빈 해시입니다. 두 경로 구간은 화면과 선택 항목을 뜻하며 임의 깊이의 URL 라우터는 아닙니다.

- `navigate(route,{force=false})`: URL이 바뀔 때만 pushState.
- `replace(route,{force=false})`: 새 항목 없이 현재 URL 교체.
- `back()`: 브라우저 history.back 위임.
- `snapshot()`: 독립 route/query 복사본.
- `subscribe(listener,{immediate=false})`: (route,{previous,source}) 알림, unsubscribe 반환.
- `dispose()`: 이벤트와 구독 해제. 반복 호출 가능. 이후 이동은 무효.

초기화는 URL을 읽고 이력을 쓰지 않습니다. normalize는 게임의 허용 화면/선택 검증만 합니다. 초기 canonical URL 교체가 필요하면 snapshot을 replace하세요. popstate/hashchange 쌍은 같은 상태일 때 한 번만 알리며 이력 복원은 URL을 쓰지 않습니다. 구독에서 구매나 전투 명령을 실행하지 마세요. query는 해시 안의 화면 옵션만 읽고 바깥 `?preview=...` 검색 옵션을 보존하지만 화면으로 해석하지 않습니다.

[실행 예제](examples/index.html): build 후 저장소 루트를 HTTP 제공. `npm run test:execution`은 직접 URL, push/replace, 뒤로/앞으로, 새로고침, 정리를 실제 브라우저에서 검사합니다. Browser/History를 중복 구현하지 않습니다. 이동당 URL/route 복사 비용이며 프레임 루프는 없습니다.

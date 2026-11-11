# navigation

**HTML 실행 프리뷰:** [navigation](https://htmlpreview.github.io/?https://github.com/byh-playground/bloom-gamekit/blob/previews/navigation.html)

## 언제 쓰나

- 화면 전환을 **해시 주소(`#/화면/항목?옵션`)와 브라우저 뒤로 가기**에 맞추고 싶을 때. 직접 주소로 안쪽 화면을 열고, 새로고침해도 같은 화면이 열립니다.

## 쓰는 모양

```js
// meow-tumble/src/main.js (줄임)
const navigation = createNavigation({
    normalize: (route) => ({ screen: SCREENS.includes(route.screen) ? route.screen : 'main' }),
});
navigation.subscribe(renderMenu); // (route, { previous, source })
button.addEventListener('click', () => navigation.navigate({ screen: button.dataset.route })); // 이력 추가
navigation.replace({ screen: 'play' }); // 이력 없이 교체
navigation.snapshot().screen;
```

## 쓰지 말아야 할 때

| 이런 일                         | 대신                                                       |
| ------------------------------- | ---------------------------------------------------------- |
| 임의 깊이의 URL 라우터          | 화면·항목 두 구간만 다룹니다                               |
| 구독 안에서 구매·전투 명령 실행 | 하지 않습니다. 명령은 게임의 명령 경로로 보냅니다          |
| 디버그 장면을 주소로 열기       | [debug-tools](../debug-tools/README.md) `installDebugHost` |

## 상세

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

normalize는 게임의 허용 화면/선택 검증만 합니다. 주소창의 해시는 언제나 지금 route의 정규 주소(normalize 결과를 해시로 쓴 값)입니다.

- 생성: URL을 읽어 route를 정하고, 해시가 정규 주소가 아니면 `replaceState`로 고칩니다. 이력 항목은 늘지 않고 구독자에게 알리지 않습니다(구독 전이므로). 화면을 맞추려면 `subscribe(listener, { immediate: true })`나 `snapshot()`을 씁니다.
- 이력 복원(뒤로·앞으로·주소창 입력, `source: 'history'`): 들어온 주소의 정규 주소가 그 주소와 다르면 먼저 `replaceState`로 고칩니다(push하지 않아 이력 항목 수가 그대로). 그다음 정규 route가 지금 route와 다를 때만 알립니다. 예: 경기 중(`#/play`) 주소창에 `#/nope`를 넣으면 normalize 결과가 `play`면 주소만 `#/play`로 돌아가고 알림은 없습니다. 주소를 먼저 고치므로 구독자 안에서 다시 `navigate`·`replace`하면 그 주소가 최종 주소입니다.
- 다른 주체가 직접 쓰는 주소(예: scenario `installShowcase`의 `#/showcase`): normalize가 그 화면을 그대로 돌려주면 정규 주소라 건드리지 않습니다. 돌려주지 않으면 navigation이 고치므로 그 화면을 허용 목록에 넣으세요.
- 해시만 고치고 바깥 검색 옵션(`?preview=...`, `?debug=1&scene=...`)은 보존하며 화면으로 해석하지 않습니다. 정규 주소는 각 구간을 `encodeURIComponent`, query를 `URLSearchParams` 문자열로 쓴 값이라 `#/`·`#/main`은 해시 없는 주소로, `#nope`는 `#/nope`와 같이 읽혀 그 정규 주소로 고쳐집니다.

popstate/hashchange 쌍은 같은 상태일 때 한 번만 알립니다. 이력 복원은 게임 명령을 실행하지 않습니다. 구독에서 구매나 전투 명령을 실행하지 마세요. `dispose()` 뒤에는 주소를 고치지 않습니다.

[실행 예제](examples/index.html): build 후 저장소 루트를 HTTP 제공. `npm run test:execution`은 직접 URL, push/replace, 뒤로/앞으로, 새로고침, 모르는 주소 입력의 정규 주소 교정, 정리를 실제 브라우저에서 검사합니다. Browser/History를 중복 구현하지 않습니다. 이동당 URL/route 복사 비용이며 프레임 루프는 없습니다.

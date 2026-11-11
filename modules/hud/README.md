# hud

## 언제 쓰나

- 월드 위치(XYZ)에 있는 대상 위에 이름표·체력 막대 같은 화면 요소를 붙이려고 **화면 좌표를 한 번 투영**하고 싶을 때(`resolveAnchorInto`).
- 그 요소를 DOM으로 두되 움직이는 것만 transform으로 갱신하고 싶을 때(`DOMHud`).

## 쓰는 모양

```js
// rally-frontier/src/main.js (줄임): 건물 체력 막대 위치
const anchor = RallyGamekit.resolveAnchorInto(
    this.stableCamera(),
    { space: 'world', x: this.viewX(b.x), y: this.viewY(b.y), z: terrainHeight },
    {},
);
const { x, y } = anchor; // 화면 CSS 픽셀. 그리기는 게임이 함
```

`DOMHud` 예: [interpolation 예제](../interpolation/examples/demo.js)의 `new DOMHud({ camera, root })`, `add(id, { anchor, text })`, `setAnchor`, `remove`.

## 쓰지 말아야 할 때

| 이런 일                       | 대신                                                   |
| ----------------------------- | ------------------------------------------------------ |
| 입력을 받는 메뉴              | 별도 게임 UI. 이 overlay는 `pointer-events:none`입니다 |
| 체력 감소 연출·겹침 회피 배치 | 게임이 갖습니다                                        |
| 투영 수식 자체                | [camera](../camera/README.md)                          |

## 상세

게임의 health·cards·damage 규칙을 모르는 screen/world anchor와 작은 DOM adapter입니다.

`resolveAnchorInto(camera,{space='world',x,y,z=0,offsetX=0,offsetY=0,visible=true,clamp=false,margin=0},out)`는 camera의 같은 absolute XYZ pose를 한 번 투영합니다. out은 `{x,y,onScreen,visible}`이며 offsets/margin은 CSS 픽셀입니다. screen anchor는 투영하지 않습니다. extent 기반 layout/겹침 회피/health drain 같은 정책은 게임에 남습니다.

`new DOMHud({camera,root})`는 상대 위치를 가진 canvas 크기의 overlay root를 받습니다. `add(id,{element?,anchor,text?})`, `setAnchor(id,patch)`, `setText(id,text)`, `update()`, `remove(id)`, `dispose()`를 제공합니다. anchor 설정 시 객체를 복사하며 매 frame의 계산 출력은 재사용합니다. 움직이는 항목은 transform만 바꾸고 정지 항목/동일 text는 DOM에 다시 쓰지 않습니다. DOM 전체를 재구축하지 않습니다. stats.writes/nodes가 실제 쓰기/등록 수를 셉니다.

외부 element를 넘기면 제거 시 이전 style/hidden/실제 child node/부모 위치를 복구합니다. HUD가 만든 element는 제거합니다. adapter 수명 중 같은 element/style/children을 별도로 수정하지 마세요. 입력을 받는 메뉴는 별도 게임 UI로 유지하세요. 이 overlay는 pointer-events:none입니다.

Canvas 또는 WebGL 텍스트/geometry adapter는 `paintAnchored(camera,anchor,out,paint)`나 resolveAnchorInto만 사용할 수 있습니다. 게임이 viewport CSS 좌표를 renderer 평면으로 되돌릴 필요가 있으면 camera.screenToPlaneInto를 사용합니다. 별도 projection 수식을 복제하지 않습니다.

Budmori WorldUI의 동일 pose/head/ground 문제와 Rally screen HUD를 기준으로 새로 작성했습니다. 게임의 표현 정책·아트·license는 포함하지 않습니다.

# tech-tree

선행 조건이 있는 성장 트리 화면(스탯·업그레이드·연구)을 맡는 모듈입니다. 게임은 노드의 `requires`만 적습니다. 좌표는 적지 않습니다. 배치·연결선·상태 계산·상세 패널·조건 칩·주소 동기화·줌/팬은 모듈이 처리하고, 노드 규칙·비용·구매 실행·그림·문구는 게임이 소유합니다. 모듈은 구매를 실행하지 않으며 `onBuy`를 부를 뿐입니다.

노드 지도를 가장 위에 두고, 그 아래에 분류 탭과 선택한 노드의 상세·구매 영역을 분리합니다. 모바일과 데스크톱 모두 지도를 가리는 조작 버튼은 없습니다.

```js
import { createTechTree } from '.../tech-tree.js';

const TREE = createTechTree({
    root: document.querySelector('#techPanel'),
    navigation, // gamekit navigation 인스턴스: #/tech/:id
    screen: 'tech',
    rootPosition: 'top', // auto · center · top · bottom · left · right · 네 모서리
    nodes: TECH_NODES, // { id, branch, max, requires: [], ...게임 필드 }  좌표 없음
    level: (id) => progress.upgrades[id] ?? 0,
    canBuy: (node) => ({ ok: techPoints() >= node.cost }), // 포인트·재화 규칙은 게임 소유
    onBuy: (id) => buyTech(player, id), // 레벨을 올리고 저장한 뒤 TREE.refresh()
    renderNode: (node, el) => {
        el.append(symbolOf(node), nameOf(node));
    },
    renderDetail: (node, el) => {
        el.textContent = node.desc;
    },
    text: {
        branch: (branch) => t(`branch.${branch}`),
        name: (node) => t(`tech.${node.id}`),
        state: (state, node, level) => t(`state.${state}`, { level, max: node.max }),
        buy: (state, node) => (state === 'available' ? t('buy', { cost: node.cost }) : t(`buy.${state}`)),
        reason: (state, node, check) => t(`reason.${state}`),
        prerequisite: (required, met) => (met ? '✓ ' : '') + t(`tech.${required.id}`),
        level: (node, level) => `${level}/${node.max}`,
        map: () => t('map'),
    },
});
TREE.refresh(); // 포인트·저장이 바뀐 뒤 (배치는 그대로, 상태·문구·조건 칩만 다시 계산)
```

[바로 보기: 스탯 트리·큰 트리 예제](https://htmlpreview.github.io/?https://github.com/byh-playground/bloom-gamekit/blob/previews/tech-tree.html) · [예제 코드](./examples/index.html)

## 계약

- **필수 옵션이 빠지거나 노드가 잘못이면 기본값 없이 던집니다.** 중복 id, `max`가 1 이상의 정수가 아님, `requires`가 배열이 아님(없으면 `[]`), 모르는 선행 id, 선행 조건의 순환, `navigation`·`screen`·`text`의 모든 함수가 없음.
- **상태 4종은 모듈이 계산합니다.** `owned`(레벨 ≥ max) · `locked`(선행 노드 중 레벨 0이 있음) · `available`(선행을 갖췄고 `canBuy(node).ok === true`) · `waiting`(선행을 갖췄지만 살 수 없음). 선행 조건은 모두 1단계 이상이어야 하는 AND입니다. `canBuy`는 `owned`·`locked`일 때는 부르지 않습니다.
- **배치.** 분류(`branch`)마다 같은 분류 안 선행 조건의 최대 깊이로 층을 나누고, 같은 층은 부모 평균 위치로 정렬해 교차를 줄입니다. 화면이 세로로 길면 깊이가 위에서 아래로, 가로로 길면 왼쪽에서 오른쪽으로 갑니다. 노드는 한 변 72px입니다(손가락 영역 56px 이상). 다른 분류의 선행 조건은 선이 아니라 상세의 조건 칩으로 읽고, 칩을 누르면 그 노드와 분류로 갑니다.
- **제스처 조작.** 트리 크기와 관계없이 휠 확대·축소, 마우스·한 손가락 끌기, 두 손가락 핀치를 사용합니다. `+`/`−`/맞춤 조작 버튼은 만들지 않습니다. 지도에 키보드 포커스를 두면 `+`·`−`로 줌, 방향키로 이동, `Home`으로 루트 시작 위치를 복원합니다. 처음 배율은 노드가 56px 아래로 줄지 않는 선에서 가로에 맞추고, 축소는 전체 크기가 들어갈 배율까지, 확대는 1.6배까지입니다. 빈 공간 쪽으로도 이동할 수 있지만 지도를 완전히 벗어나지는 않습니다. 줄어든 노드를 누르면 56px이 되는 배율까지 키워 보여 주고, 키보드 포커스가 화면 밖 노드로 가면 보이는 곳으로 옮깁니다. **브라우저 스크롤은 생기지 않습니다**(`overflow: clip`, 이동은 transform).
- **루트 시작 위치.** `rootPosition`은 `auto`(기본), `center`, `top`, `bottom`, `left`, `right`, `top-left`, `top-right`, `bottom-left`, `bottom-right` 중 하나입니다. `auto`는 세로 배치에서 상단 가운데, 가로 배치에서 왼쪽 가운데입니다. 같은 분류의 깊이 0 루트가 여러 개면 그룹의 경계를 맞춥니다. 가장자리는 16px 여백을 두고, 가운데는 루트 그룹의 중심을 맞춥니다. **처음 카메라 위치를 정하는 옵션**이며 선행 층의 세로·가로 배치 방향은 화면 비율로 정합니다. URL의 깊은 노드나 다른 분류의 노드를 선택하면 그 노드가 보이도록 이동할 수 있습니다.
- **지도와 상세 분리.** 분류 탭·상세·조건 칩·구매 버튼은 지도 아래에 두며 PC에서도 지도를 덮지 않습니다. 상세가 길면 상세 안에서 스크롤합니다. 예제 종류·시작 위치·포인트 변경·초기화는 예제 하단의 접이식 설정에만 있습니다.
- **연결선.** 선행이 갖춰진 선은 실선·굵게, 아닌 선은 점선입니다(색만으로 구분하지 않음). 두 층 이상 건너뛰는 선은 중간 층마다 노드 사이의 빈 길로 곧게 지나가 노드를 관통하지 않습니다. 같은 빈 길을 쓰는 선이 여럿이면 겹쳐 굵게 보일 수 있습니다.
- **분류가 하나뿐이면 탭을 두지 않습니다.** 크기가 바뀌어도(모바일 주소창 등) 조작 전에는 같은 방향의 크기 변화에도 루트 시작 위치를 다시 맞추고, 사용자가 조작한 뒤에는 이동·배율을 지키며 범위만 다시 잡습니다. 크기가 그대로인 알림은 무시합니다.
- **주소.** 선택은 `#/<screen>/<id>`입니다. 선택을 바꾸면 `navigation.replace`로 쓰고(이력 추가 없음), 뒤로/앞으로·직접 진입은 구독으로 받아 선택을 복원합니다. 시작할 때 주소를 읽되 이력을 쓰지 않고, 모르는 항목이면 첫 노드로 바로잡아 `replace`합니다. 구매·소모 같은 명령을 주소나 이력 복원으로 실행하지 않습니다.
- **문구는 전부 게임이 소유합니다**(`text.*`). 모듈은 문구를 만들지 않으므로 언어 전환·i18n은 게임의 방식을 따릅니다. 노드 그림은 `renderNode`, 상세 본문은 `renderDetail`(선택이 바뀔 때만 호출)입니다. 조건 칩은 선택이 바뀔 때만 다시 만들어 `refresh`가 자주 불려도 눌리는 중인 칩이 바뀌지 않습니다.
- **스타일.** 한 번 `<style id="bloom-tech-tree-style">`을 넣고 `--tt-fg`·`--tt-bg`·`--tt-node`·`--tt-line`·`--tt-accent`·`--tt-on-accent` CSS 변수로 테마를 바꿉니다. 클래스는 `.bloom-tech`·`.tt-*`입니다.
- `dispose()`는 구독과 관찰자를 풀고 `root`를 비웁니다. 패널 열고 닫기·`inert`·열기 전 포커스 복원은 게임이 소유합니다.

## 범위

레벨 저장·포인트 규칙·구매 효과·키보드 단축키(열기)·패널 열기/닫기는 하지 않습니다. 자동 배치는 같은 분류 안 선행 조건 기준의 층 배치이며 최적 교차 최소화는 아닙니다. 세로·가로 전환은 화면 비율로만 정합니다. 노드 수백 개 규모의 성능은 측정하지 않았습니다.

[고정 브라우저 시나리오](./tests/tech-tree.e2e.mjs)는 실제 Chromium에서 상태 4종, 조건 칩(AND·다른 분류), 구매 후 상태 변화, 주소(replace·뒤로/앞으로·직접 진입·모르는 항목), 폰 390×844 터치와 데스크톱 1280×800의 배치 방향, 노드 56px 이상, 스크롤 없음, 한 손가락 끌기·핀치·휠·마우스 끌기, 작은 노드 선택 시 확대, 키보드 조작·포커스 이동, 9개 시작 위치의 실제 루트 좌표, 상세 하단 분리, 잘못된 입력 오류를 확인합니다. 실기기·Safari·Firefox는 확인하지 않았습니다.

## v0.47.0 이전

지도 위 조작 버튼을 제거하면서 `text.zoomIn`·`text.zoomOut`·`text.fit` 계약을 삭제했습니다. 소비자는 이 문구 콜백을 제거하고 필요하면 `rootPosition`을 지정합니다. 런타임 호환용 버튼 옵션이나 별칭은 두지 않습니다. 지도·분류·상세의 새 배치와 작은 트리에서도 가능한 제스처를 게임 화면에서 확인하세요. 노드 상태·구매 콜백·주소 계약은 그대로입니다.

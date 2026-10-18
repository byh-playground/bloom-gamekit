# pixel-physics

**HTML 실행 프리뷰:** [pixel-physics](https://htmlpreview.github.io/?https://github.com/byh-playground/bloom-gamekit/blob/previews/pixel-physics.html) · [pixel-physics-open-world](https://htmlpreview.github.io/?https://github.com/byh-playground/bloom-gamekit/blob/previews/pixel-physics-open-world.html) · [pixel-physics-summon](https://htmlpreview.github.io/?https://github.com/byh-playground/bloom-gamekit/blob/previews/pixel-physics-summon.html)

사용자가 제공한 단일 HTML의 픽셀 셀 물리·엔티티·Matter.js 강체 연동을 독립 ESM으로 이전했습니다. [원본과 변경 범위](./docs/provenance/README.md), [플랫포머 예제 소스](./examples/index.html)를 함께 보세요. 게임 규칙·재료·플레이어·몬스터·입력과 실행 루프는 예제에만 있습니다.

```js
import { PixelWorld, Body, MatterBridge, PixelRenderer } from './pixel-physics.js';

const WORLD = new PixelWorld(200, 120, { seed: 7 });
WORLD.define({ name: 'stone', kind: 'solid', color: [110, 112, 122] });
WORLD.define({ name: 'sand', kind: 'powder', density: 15, color: [222, 190, 110] });
WORLD.define({ name: 'water', kind: 'liquid', density: 10, dispersion: 5, color: [60, 120, 220] });
WORLD.rect(0, 100, 199, 119, 'stone');
WORLD.paint(100, 30, 10, 'sand');
WORLD.attachBridge(new MatterBridge());
WORLD.addEntity(new Body({ x: 20, y: 80, w: 3, h: 6 }));
const RENDERER = new PixelRenderer(document.querySelector('canvas'), WORLD);
WORLD.tick();
RENDERER.draw();
```

픽셀 셀·엔티티·강체는 `pixel-physics` 하나의 기능 묶음입니다. 소비자는 `pixel-physics.js` 하나를 가져오고 `new MatterBridge(options)`를 사용합니다. Matter는 브라우저가 고정 웹 URL에서 가져오며 GameKit JS·프리뷰 HTML에 포함하지 않습니다. URL과 버전의 단일 원본은 [dependencies.js](./dependencies.js)이며 빌드·프리뷰·브라우저 검증이 같은 정의를 사용합니다. Matter용 npm 패키지·별도 GameKit 공개 모듈·소스 복사본을 관리하지 않습니다. 물리 core에는 DOM import가 없으며 Canvas2D 출력은 renderer가 소유합니다.

## API와 소유권

- `new PixelWorld(w, h, {seed})`: `Uint8Array` 셀·수명·갱신 상태와 시드 난수를 소유합니다. 이름 `empty`와 재료 ID 0은 빈 셀입니다. 8비트 재료 ID 표현을 사용하므로 정의 개수는 빈 셀과 브릿지가 추가하는 내부 ghost 재료를 포함해 256개 이내로 유지해야 합니다. 크기·정의의 입력 검증은 원본 수준이며 잘못된 설정을 자동 보정하지 않습니다.
- `define({name, kind, ...})`, `defineStatus(name, definition)`: `solid|powder|liquid|gas`, 밀도·분산·부력·색·수명·반응·엔티티 효과를 정의합니다. 선언형 `reactions`와 코드형 `react(context)`를 지원합니다. 원본 상단 주석과 예제 `defineAll`에 상세 옵션이 있습니다.
- `get(x,y)`, `set(x,y,material)`, `setCell(index,id,life)`, `rect(x0,y0,x1,y1,material)`, `paint(x,y,r,material,options)`, `carve`, `explode`, `spray`: 셀·폭발·분사를 변경합니다. `rect`의 양쪽 끝 셀은 포함됩니다. 공개 셀 배열을 직접 수정하면 dirty·sleep·강체 지형 갱신 계약을 건너뛰므로 변경 메서드를 사용합니다.
- `tick()`: 셀, 엔티티, 장착한 강체 브릿지를 한 논리 틱 갱신합니다. `on(type, callback)`은 `chip`, `explosion`, `hit`, `collapse`, `bake`, `fracture` 이벤트를 구독하며 해제 반환값은 없습니다. world 생명주기와 함께 콜백을 관리합니다.
- `new Body(options)`: 박스·원 엔티티입니다. `world.addEntity(body)`로 등록하고(snapshot용 `eid` 부여) `body.input`에 게임 입력을 기록합니다. 충돌·센서·체력·상태·접촉 콜백과 엔티티 간 밀기·탑승을 지원합니다. Matter 강체와 별개인 게임 엔티티입니다.
- `PhysicsBridge`: 사용자 물리 구현을 주입할 때의 기본 인터페이스입니다. 기본 메서드는 무동작이므로 그 자체를 완성된 강체 엔진으로 사용하지 않습니다.
- `MatterBridge`: `addBox`, `addCircle`, `addPolygon`, `addConvex`, `addBody({kind:'compound',parts,...})`, `removeBody`, `getPolys`, `getBounds`, `setVelocity`, `setAngularVelocity`, `applyForce`, `applyImpulse`, `applyImpulseAt`, `damp`를 제공합니다. `addJoint`, `removeJoint`, `addPin`은 관절·줄·스프링을 만듭니다. 반환 핸들은 bridge가 소유하며 native Matter 객체는 `handle.body`에 있습니다.
- `enableCollapse(options)`, `spawnCells(cells,options)`, `fracture`, `shatter`, `cellsOf`: 지형 연결성·마스크 강체·충격 파편화·정착을 다룹니다. 강체가 덮은 유령 셀은 입자 갱신 중 임시 상태이며, 실제 재료 셀과 강체 핸들을 같은 권위 데이터로 중복 관리하지 않습니다.
- `new PixelRenderer(canvas,world,{overlay})`: 매 draw마다 전체 격자 ImageData를 출력합니다. `draw(drawBody?,extra?)`로 엔티티와 추가 표시를 그립니다. overlay를 전달하면 CSS 크기×DPR의 별도 Canvas2D에 그립니다. renderer는 게임 루프를 시작하지 않습니다.
- `hyp(x,y)`, `now()`: 원본 예제가 사용하던 길이·측정 보조 함수입니다. `now()`는 실행 비용 측정용이며 시뮬레이션 입력 시간이 아닙니다.

## 시간·스냅샷·결정성 제한

이전 범위는 원본 동작 보존입니다. `tick()`은 **60Hz 고정 실행**을 전제로 하며 Matter에는 `1000 / 60`ms를 전달합니다. `world.time`, 재료 `life`, 상태 지속시간, 입력 cooldown, 엔티티 속도·가속도는 원본의 틱·셀 단위입니다. 임의 dt나 TPS 변경을 지원하는 ms API로 해석하지 마세요. 게임은 고정 60Hz 호출과 실제 시간 누적을 소유합니다. 예제는 이 단위 계약을 보여 줍니다.

`snapshot()` / `restore(snapshot)` / `hash()` / `isCheckpoint()`는 원본의 제한된 복원 기능입니다. MatterBridge 기본 `deterministic:true`, `checkpoint:30`에서는 체크포인트마다 접촉 캐시를 정리합니다. 강체 복원 후 같은 결과를 비교하려면 `isCheckpoint()`가 참인 경계에서 저장하고 동일 정의·콜백·입력·엔진 버전을 사용해야 합니다. 임의 틱의 강체 snapshot은 접촉 캐시를 완전히 저장하지 않습니다. snapshot은 게임 전체·외부 콜백 closure·런타임 설정을 자동 직렬화하는 저장 형식이 아닙니다. 게임이 그 상태를 별도로 소유해야 합니다. `hash()`는 원본이 선택한 시뮬레이션 상태의 32비트 비교용 값이며 암호학적 무결성이나 게임 전체 상태 일치를 보장하지 않습니다.

## rollback·deterministic 연동

`savePixelWorld(world)` / `loadPixelWorld(world, bytes, {createBody})` / `validatePixelWorld(world, bytes)`는 `snapshot()`을 [deterministic](../deterministic/README.md)의 `createValueCodec` 바이트로 바꿉니다. rollback의 `SimulationAdapter`가 요구하는 `save()`·`load()`·`validateSnapshot()`에 그대로 연결합니다. 이 모듈은 어댑터를 대신 소유하지 않습니다. 입력 해석과 `step`은 게임이 작성합니다. 어댑터 전체는 [tests/rollback.mjs](./tests/rollback.mjs)에 있습니다.

```js
const ADAPTER = {
    save: () => savePixelWorld(WORLD),
    load: (bytes) => loadPixelWorld(WORLD, bytes, { createBody: (eid, state) => makeBody(state) }),
    validateSnapshot: (bytes) => validatePixelWorld(WORLD, bytes),
    step(context) {
        /* context.inputs → body.input, 지형 변경 → */ WORLD.tick();
    },
};
```

- **되감기 조건:** rollback 모드는 임의 tick으로 되감으므로 `new MatterBridge({ checkpoint: 1 })`로 접촉 쌍을 매 tick 비워야 합니다. 기본 `checkpoint:30`은 락스텝처럼 체크포인트 tick만 저장·복원할 때만 비트 일치합니다. tickRate는 60이어야 합니다.
- **엔티티 식별:** 엔티티는 `world.addEntity(body)`로 등록합니다(`world.bodies.push`는 `eid`가 없어 저장할 때 오류). 살아 있는 엔티티·강체 핸들·조인트는 식별자로 찾아 재사용하고, 없으면 `createBody(eid, state)`가 만든 Body를 씁니다. 형상·콜백은 게임이 소유하므로 저장하지 않습니다.
- **저장 범위:** 셀·수명·분사체·엔티티 가변 상태·강체 자세와 속도·마스크 강체의 셀 집합·조인트 파라미터·`data`입니다. `Body.data`, 강체 `data`, 상태에는 유한한 숫자·문자열·불리언·일반 객체와 배열만 넣을 수 있습니다(`Infinity`·`NaN`·참조는 오류). 값 코덱이 `-0`을 `0`으로 정규화합니다. 핸들에 게임이 직접 붙인 속성은 저장되지 않습니다.
- **크기와 비용:** 격자 배열은 같은 값 구간(run)으로 줄여 저장합니다. 정지한 1280×720 월드는 원본 배열 2.77MB가 약 24KB(tests/rollback.mjs 측정), 모래가 흐르는 장면은 36~76KB 수준이며, 구간이 줄지 않는 잡음 격자는 원본 그대로 저장합니다. 크기는 격자 크기가 아니라 변화의 복잡도에 비례하므로 64MB 히스토리 예산과 4MiB 스냅샷 한도 안에 큰 월드도 들어옵니다. 저장은 1280×720에서 약 4ms(원본 배열 복사 포함)입니다.
- **검증 범위:** Node의 `runSyncTest`로 8틱 되감기를 400틱 동안 비교하고, 붕괴·파편화·굳히기·폭발·조인트가 일어나는 장면에서 통과했습니다. 새 월드에 불러와도 이후 200틱의 바이트가 같습니다. 브라우저·다른 기기·큰 월드는 검증하지 않았습니다.

## 열린 월드: 창 이동과 뷰포트

격자(`PixelWorld(w, h)`)는 항상 고정 크기 **창** 하나이고, 큰 세계는 게임이 소유한 맵 데이터입니다. 절대 좌표 = `originX/originY + 창 좌표`이며, 창이 맵 위를 움직입니다. 예제: [열린 월드(로켓)](https://htmlpreview.github.io/?https://github.com/byh-playground/bloom-gamekit/blob/previews/pixel-physics-open-world.html) · [소스](./examples/open-world.html).

```js
const WORLD = new PixelWorld(320, 240, { originX: -160, originY: -140, stream: { margin: 88, step: 32 } });
// 맵 데이터에서 읽기: rect = {world, x0, y0, x1, y1, originX, originY} (창 좌표 사각형, 절대 = origin + 창 좌표)
const load = (rect) =>
    rect.world.writeRegion(rect.x0, rect.y0, w, h, cellsFromMap(rect.originX + rect.x0, rect.originY + rect.y0, w, h));
const evict = (rect) =>
    saveToMap(rect.originX + rect.x0, rect.originY + rect.y0, rect.world.readRegion(rect.x0, rect.y0, w, h));
// 틱이 끝난 뒤 초점(절대 좌표)을 알려 주면, 여유 구간을 벗어났을 때만 창을 옮깁니다.
const MOVED = WORLD.scrollTo(WORLD.originX + rocket.x, WORLD.originY + rocket.y, { load, evict });
```

- **미리 불러오기 설정:** `stream: { margin, step }`(생성 옵션) 또는 `setStreaming({margin, step})`입니다. `margin`은 초점이 창 가장자리에서 이만큼 안쪽을 벗어나면 옮기는 "미리 불러둘 거리"(셀)로, 카메라 시야의 반 크기보다 커야 시야가 불러온 영역 안에 있습니다. `step`은 한 번에 옮기는 단위(셀, 16의 배수)로, 크면 드물게 크게 불러오고 작으면 자주 조금씩 불러옵니다. `step <= min(w,h) - 2*margin`이어야 하며 어기면 RangeError입니다. 생략하면 margin은 짧은 변의 1/4, step은 16 이상 32 이하의 가능한 최대값입니다. 이 설정은 시뮬레이션 상태가 아니라서 snapshot에 들어가지 않으니 모든 참가자가 같게 두세요. 청크 크기 16은 sleep 단위라 고정입니다.
- **`shiftWindow(dx, dy, {load, evict})`:** `scrollTo`가 부르는 원형입니다. dx, dy는 16의 배수 정수이며 틱 사이에만 호출합니다. 창 좌표 (x,y)의 셀은 (x-dx, y-dy)로 옮겨지고 origin이 dx, dy만큼 늘어납니다. 가로·세로·대각선이 모두 되고 창보다 큰 이동도 됩니다(전부 다시 불러옴). `evict(rect)`는 밀려나기 직전에 옛 origin 기준으로 불려 `readRegion`으로 편집을 맵에 되쓰게 하고, `load(rect)`는 새로 드러난 영역(최대 두 사각형)마다 새 origin 기준으로 불립니다. 호출하지 않은 영역은 빈 셀입니다.
- **함께 옮겨지는 것:** 셀(`g`/`life`/`u`), 청크 플래그(`awake`/`reac`/`chd`/`chunkTick`)와 정적 지형 충돌체(청크 id를 바꿔 이동하고 새로 드러난 이음매 청크만 다시 만듦), 발사체(좌우·아래로 나가면 사라지고 위로 나간 것은 유지), 엔티티와 강체의 위치(속도·각도는 그대로), 핀과 월드 고정 조인트의 고정점, 부력 평활화 상태, 붕괴 지지 검사 요청(`supDirty`)입니다. 접촉 캐시는 옛 좌표 기준이라 비웁니다.
- **지우지 않는 것:** 창 밖으로 나간 엔티티와 강체는 지우지 않고 반환값 `{entities, bodies, projectiles}`로 돌려줍니다. 지우거나 다른 구간으로 옮기는 것은 게임이 정합니다. 밖으로 나간 개체는 지형과 충돌하지 않습니다.
- **결정성:** `shiftWindow`/`scrollTo`를 부르는 틱은 게임 규칙이므로 초점 같은 시뮬레이션 상태로만 정해야 합니다(`scrollTo`는 초점 좌표와 설정이 같으면 같은 이동을 합니다). `load`는 월드 난수열(`rand`, 수명 범위가 있는 재료의 `set`)을 쓰지 않아야 같은 절대 좌표가 언제 불러도 같습니다. `writeRegion`은 life를 주지 않으면 재료의 수명 최솟값을 쓰며 난수열을 소비하지 않습니다. 절차 생성이라면 월드 난수열 대신 `hashCell(seed, 절대x, 절대y)`처럼 절대 좌표와 시드만으로 정해지는 함수를 쓰세요.
- **붕괴(`enableCollapse`):** 앵커는 바닥·좌우 가장자리와 앵커 재료입니다. 창의 위쪽 가장자리는 맵을 자른 선일 뿐이라 위로 이어진 구조물이 허공 덩어리로 오인될 수 있으니, 위쪽도 앵커로 쓰려면 `enableCollapse({ anchorTop: true })`를 켜세요(기본 꺼짐).
- **`readRegion(x,y,w,h)` / `writeRegion(x,y,w,h,cells,life?)`:** 창 안 사각형을 `Uint8Array`로 읽고 쓰는 일괄 경로입니다. 쓴 영역과 이웃 청크는 깨우고 충돌체와 붕괴 검사를 다시 계산합니다. 창 밖 사각형, 길이가 다른 배열, 정의되지 않은 재료 id는 RangeError입니다.

**snapshot / restore / hash / savePixelWorld:** `originX`/`originY`는 시뮬레이션 상태입니다. `snapshot()`/`restore()`/`savePixelWorld()`/`loadPixelWorld()`는 창 안의 셀과 청크·분사체·엔티티·강체와 origin을 함께 저장하고 복원하며, `hash()`는 origin을 섞습니다(셀이 같아도 origin이 다르면 다른 상태). **창 밖의 맵 데이터는 저장되지 않습니다.** 그 데이터(와 `evict`로 되써 둔 편집)는 게임 소유이므로, 되감기에서는 맵 데이터도 같은 시점으로 되돌리거나(편집을 시간순 로그로 두고 되감기), `load`/`evict`가 되감기 중 부수효과를 내지 않게 하세요. 창 이동 이전 시점의 snapshot으로 되감으면 그 시점의 창(origin 포함)이 복원되고, 이후 틱을 다시 돌릴 때 같은 틱에서 같은 이동이 일어나면 같은 해시가 됩니다(Node, `checkpoint:1`, `tests/open-world.mjs`). 되감은 뒤 창 밖에서 일어난 편집이 맵에 남아 있으면 다른 결과가 나옵니다.

**뷰포트 렌더:** `writeGridPixels(world, pixels, shade, background, view)`에 `view = {x, y, w, h}`(창 좌표 정수)를 주면 그 사각형만 `view.w*view.h` 크기의 `pixels`에 행 우선으로 씁니다. view가 격자 밖에 걸치면 밖의 칸은 `background`이고 오류가 아닙니다(완전히 밖이어도 전부 배경). `pixels` 길이가 맞지 않거나 view가 정수가 아니거나 w, h가 음수면 RangeError입니다. 음영은 절대 좌표를 격자 크기로 감아 `shade`를 찾으므로 창이 움직여도 같은 셀은 같은 색입니다(origin이 0이면 이전과 같은 결과). `PixelRenderer`는 `{ view }` 옵션과 `setView(view)`를 받으며, 크기가 같으면 위치만 바꾸는 비용이 없습니다. 개체와 `extra` 훅은 창 좌표 그대로 그리면 view에 맞춰 이동됩니다. WebGL이면 view 크기의 텍스처를 한 번 만들고 `writeGridPixels(..., view)` 뒤 `updateTexture`로 올립니다.

**측정(Node, 브라우저 아님, 시나리오당 짧은 반복의 중앙값, 이 개발 환경):** 지면과 희소한 암석이 있는 1M셀 창(512×2048, 1024×1024)에서 `shiftWindow` 32칸 이동은 가로·세로·대각선 모두 약 4~7ms(`load` 포함), 640×360 뷰포트 쓰기는 약 2~3ms(전체 격자 쓰기는 11~20ms)였습니다. 지형 밀도와 정적 충돌체 수에 따라 달라지며, 모든 셀이 잘게 쪼개진 무작위 지형은 Matter 정적 충돌체 수가 폭증해 틱 자체가 수백 ms가 되었습니다. 브라우저·GPU 업로드 비용은 재지 않았습니다.

## rendering 연동

`writeGridPixels(world, pixels, shade)`는 격자만 `Uint32Array` RGBA로 씁니다(엔티티·강체는 제외, DOM·Canvas 비의존). `PixelRenderer`도 같은 함수를 씁니다. [rendering](../rendering/README.md)의 `createTexture({width,height,data}, {filter:'nearest'})`로 한 번 올리고, 틱마다 `writeGridPixels` 뒤 `updateTexture`로 갱신해 `Renderer2D.sprite`로 그립니다(불투명 격자는 premultiply를 건너뛰고, 바뀐 영역만 `{x,y,width,height}`로 올릴 수 있습니다). 엔티티와 강체는 같은 프레임에서 `rect`·`ellipse`·폴리곤으로 그리고, 강체 다각형은 `bridge.getPolys(h)`를 씁니다. 그림 순서와 카메라는 rendering의 `setCamera`와 호출 순서가 정합니다. [tests/rendering.e2e.mjs](./tests/rendering.e2e.mjs)가 실제 WebGL 픽셀을 읽어 격자와 비교합니다(헤드리스 Chromium 한 대, 40×30 월드). 큰 월드는 아래 "뷰포트 렌더"처럼 카메라 영역만 쓰고 올릴 수 있습니다.

`installDeterministicTrig()`를 명시적으로 호출하면 **전역 `Math.sin`과 `Math.cos`를 다항식 구현으로 덮어씁니다.** 자동 설치·복원 API는 없으며 같은 realm의 다른 라이브러리에도 영향을 줍니다. 예제는 Matter 생성 전에 호출합니다. 이를 사용해도 서로 다른 브라우저·CPU·Matter 버전 사이의 비트 단위 일치는 보장하지 않습니다. 실제 대상 환경에서 같은 입력과 체크포인트 해시를 비교해야 합니다. 이 모듈을 가져오는 것만으로 전역 함수를 바꾸지는 않습니다.

## 비용과 실행

셀 기본 배열·청크 배열은 월드 셀 수에 비례해 메모리를 사용합니다. 매 틱 활성 16×16 청크의 셀을 스캔하며 재료 반응과 분사체·엔티티 수가 비용을 추가합니다. 청크 sleep은 비활성 영역 스캔을 줄이지만 전체 셀 렌더링·dirty 강체 재구성·붕괴 연결성 검사 비용을 없애지 않습니다. 붕괴 flood와 마스크 래스터화·파편화는 추가 배열과 객체를 할당하고, 강체·관절·충돌 형상 증가는 Matter 계산량을 늘립니다. 전체 snapshot과 hash도 셀·엔티티·강체 상태를 순회합니다. 큰 월드나 잦은 snapshot을 저비용이라고 가정하지 마세요.

`PixelRenderer.draw()`는 전체 월드 픽셀을 순회하고 업로드하며, overlay의 픽셀 수는 CSS 면적×DPR²에 비례합니다. 예제의 벤치마크 버튼은 해당 기기·브라우저에서만의 입자 CPU 틱 측정이며 GPU 완료시간·범용 FPS 보장이 아닙니다. 예제의 결정성 버튼도 같은 브라우저 내 비교입니다.

저장소 루트에서 `npm run build` 후 HTTP 서버를 열어 `/modules/pixel-physics/examples/index.html`을 실행합니다. 예제는 `/dist/pixel-physics.js` 하나를 직접 import합니다. 키보드·포인터 조작, 재시작, 디버그, 결정성 검사, 입자 벤치마크를 포함합니다. `window.pixelPhysicsExample.diagnostics`는 E2E가 읽을 수 있는 tick·플레이어·강체 수·도구의 복사본이며 수정해도 게임 상태를 바꾸지 않습니다. 실제 브라우저·게임킷 결합 검증 범위는 PR의 검증 기록을 따릅니다.

Matter.js 0.19.0은 jsDelivr의 ESM 웹 경로로 로드합니다. [jsDelivr ESM 문서](https://www.jsdelivr.com/esm), [Matter 원본](https://github.com/liabru/matter-js/tree/0.19.0)을 참조하세요. GameKit manifest는 자체 JS bytes와 그 안에 고정된 URL을 검증하며 CDN 응답 bytes를 검증하는 파일은 아닙니다. 초기 실행에는 이 URL에 대한 네트워크 접근이 필요합니다. 예제 HTML을 file://로 열어도 Matter는 웹에서 가져오며 엔진을 포함한 오프라인 fallback은 없습니다. 기존 두 파일을 사용하던 소비자는 Matter import를 제거하고 `new MatterBridge(Matter, options)`를 `new MatterBridge(options)`로 바꿉니다. 구 별도 번들과 주입 생성자 호환 경로는 남기지 않습니다.

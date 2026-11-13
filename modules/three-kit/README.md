# three-kit

## 언제 쓰나

- three.js로 3D를 그리는 게임에서 **프레임당 드로우콜·삼각형·프로그램·텍스처 수**를 언제든 읽고 싶을 때(`RenderStats`, DEV-033).
- 플레이 중 처음 보이는 객체 때문에 셰이더 컴파일과 버퍼·텍스처 업로드가 **경기 중에 일어나지 않게** 로딩 때 미리 끝내고 싶을 때(`warmUp`, DEV-032).
- 입자·안내 표시처럼 **인스턴스마다 투명도가 다르거나 모양이 여러 가지인** 것을 한 번에 그리고 싶을 때(`InstanceLayer`·`mergeShapes`, DEV-034).
- 선수 부위·장식처럼 **모양이 다르고 따로 움직이는 딱딱한 물체 여럿**을 한 번에 그리고 싶을 때(`RigidBatch`·`PartList`·`mergeColored`, DEV-034).

## 쓰는 모양

```js
// bloom-takraw/src/presentation (모듈로 옮긴 뒤의 모양, 줄임)
import * as THREE from 'three'; // 게임이 고정한 three.js. 모듈은 three를 import하지 않습니다.
import { RenderStats, warmUp, InstanceLayer, mergeShapes, RigidBatch, PartList } from '@bloom-gamekit/three-kit';

// 렌더 통계: 후처리로 render()를 여러 번 불러도 프레임 합계
const stats = new RenderStats(renderer);
stats.begin();
renderer.render(scene, camera); // + 후처리 패스
stats.end();
stats.snapshot().counts.drawCalls; // { mean, p50, p95, max, ... } · 진단 한 줄은 stats.line()

// 로딩 때 한 번: 숨긴 객체까지 플레이와 같은 카메라·조명으로 컴파일하고 버퍼·텍스처까지 올림(화면에는 남지 않음)
warmUp(renderer, scene, camera);

// 바닥 안내: 모양 여럿 × 인스턴스 투명도 = 1 draw
const ground = mergeShapes(THREE, {
    ring: new THREE.RingGeometry(0.3, 0.34, 40),
    dot: new THREE.CircleGeometry(0.16, 28),
});
const marks = new InstanceLayer(THREE, { geometry: ground.geometry, capacity: 48, side: THREE.DoubleSide });
scene.add(marks.mesh);
marks.begin();
marks.add(matrix, color, 0.6, ground.shapes.ring); // 프레임마다
marks.end();

// 선수 6명: 부위마다 뼈 하나, 몇 부위든 본체 1 draw
const batch = new RigidBatch(THREE);
scene.add(batch.root);
const parts = new PartList(THREE);
parts.body = batch.add();
parts.box(0.3, 0.5, 0.2, 0xd04040, 0, 1, 0);
const material = batch.glowMaterial(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85 }));
batch.mesh(parts.build(), material);
batch.bone(0).position.set(x, y, z); // 프레임마다 뼈를 움직임
batch.setGlow(0, 0.4); // 이 부위만 emissive 가산(재컴파일 없음)
```

## 쓰지 말아야 할 때

| 이런 일                                         | 대신                                                                           |
| ----------------------------------------------- | ------------------------------------------------------------------------------ |
| 같은 모양·같은 투명도만 많이                    | three.js `InstancedMesh` 그대로(인스턴스 색은 기본 기능)                       |
| 수시로 생기고 사라지는 물체를 `RigidBatch`로    | 맞지 않습니다. 뼈 수는 첫 `mesh()`에서 고정됩니다. 입자·효과는 `InstanceLayer` |
| 재질 하나를 여러 `RigidBatch`에                 | `glowMaterial`로 감싼 재질은 한 묶음에만 씁니다(물체 번호가 그 묶음의 뼈 번호) |
| 물체마다 다른 텍스처                            | 한 아틀라스에 모으고 `uvRect`로 칸을 고릅니다(텍스처가 다르면 재질이 갈림)     |
| 뼈대가 있는 캐릭터 애니메이션(관절이 굽는 메시) | three.js `SkinnedMesh`·`AnimationMixer` 그대로                                 |
| WebGL 2 2D 도형·스프라이트·벡터                 | [rendering](../rendering/README.md)                                            |
| CPU 단계 시간 재기                              | [debug-tools](../debug-tools/README.md) `FrameMetrics`·`PerformanceProfiler`   |

## three.js 기본 기능과의 관계

있는 기능은 감싸기만 하고 다시 만들지 않습니다. 더하는 것은 기본 기능에 없는 것뿐입니다.

| 공개 API                  | 감싸는 three.js 기능                                               | 더하는 것                                                                                   |
| ------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| `RenderStats`             | `renderer.info`(`autoReset = false` + 프레임 시작 `reset`)         | 최근 프레임 링과 요약(debug-tools `FrameMetrics`를 그대로 씁니다)                           |
| `warmUp`                  | `renderer.compile(scene, camera)` + `renderer.render`              | 숨긴 객체·조명을 켜고 화면 1픽셀에 한 번 그려 버퍼·텍스처까지 올린 뒤 되돌림                |
| `InstanceLayer`           | `InstancedMesh` + `MeshBasicMaterial`, 인스턴스 색                 | 인스턴스 투명도(`instanceOpacity`)·모양 고르기(`instanceShape`) 셰이더 주입, 쓴 칸만 올리기 |
| `mergeShapes`             | `BufferGeometry`                                                   | 정점마다 모양 번호(`aShape`)                                                                |
| `RigidBatch`              | `SkinnedMesh` + `Skeleton`(뼈 행렬 텍스처, 그림자 깊이)            | 물체마다 평평한 뼈 하나, 물체별 emissive 가산(`glowMaterial`·`setGlow`) 셰이더 주입         |
| `mergeColored`·`PartList` | `BufferGeometry`·`BoxGeometry`·`CylinderGeometry`·`SphereGeometry` | 변환·정점 색·물체 번호(skinIndex)·아틀라스 uv를 구워 합치기, 거울 변환의 감김 보정          |

쓰지 않는 기본 기능과 이유(r180 소스로 확인):

- `InstancedMesh`·`BatchedMesh`에는 인스턴스 알파가 없습니다. 그래서 `InstanceLayer`가 투명도를 주입합니다.
- `BatchedMesh`는 `WEBGL_multi_draw` 확장이 없는 기기에서 인스턴스마다 따로 그립니다. 기기와 무관하게 1 draw인 `SkinnedMesh`를 씁니다.

## three.js를 받는 방식

three.js가 필요한 API는 모두 **첫 인자로 three.js 네임스페이스를 받습니다**(`new InstanceLayer(THREE, …)`, `new RigidBatch(THREE)`, `new PartList(THREE)`, `mergeShapes(THREE, …)`, `mergeColored(THREE, …)`). renderer·scene만 다루는 `RenderStats`·`warmUp`은 받지 않습니다. 모듈은 three를 import하지 않고 `dist/three-kit.js`에 three가 들어 있지 않으므로, 게임이 고정한 three 하나만 쓰입니다(게임마다 버전·로딩 방식이 다릅니다: 발배구 r180 import map, 와르르냥 r170, 디그모리는 부팅 때 받아 주입).

## 셰이더 주입과 지원 revision

`InstanceLayer`·`RigidBatch.glowMaterial`은 `onBeforeCompile`에서 three 내장 셰이더 소스의 문자열을 바꿔 끼웁니다. 모든 주입은 `replaceShaderChunk(source, target, replacement)` 하나를 거치고, **바꿀 대상이 없으면 조용히 넘어가지 않고 오류를 냅니다.** 소비자 주입도 같은 함수를 씁니다.

주입 대상(`MeshBasicMaterial`: `void main() {`·`#include <begin_vertex>`·`vec4 diffuseColor = vec4( diffuse, opacity );`, `MeshStandardMaterial`·`MeshPhysicalMaterial`: `void main() {`·`#include <skinbase_vertex>`·`vec3 totalEmissiveRadiance = emissive;`)이 있는지 확인한 revision:

| revision | 근거                                                                                                                                                 |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| r170     | GitHub `mrdoob/three.js` 태그 `r170`의 `meshbasic.glsl.js`·`meshphysical.glsl.js`(정점·조각 각 1회), `WebGLProgram.js`의 `attribute vec4 skinIndex;` |
| r180     | 같은 파일의 태그 `r180`(두 셰이더 파일은 r170과 바이트 단위로 같음)                                                                                  |
| r186     | 저장소 devDependency `three@0.186.1`. 고정 시나리오 `tests/three-kit.e2e.mjs`가 실제 `THREE.ShaderLib`에 주입해 봅니다                               |

범위 밖 revision에서는: 대상 문자열이 그대로면 그대로 동작합니다. 바뀌었으면 그 재질의 **첫 컴파일 때** `three-kit: 셰이더에 주입 대상 "…"이 없습니다` 오류가 납니다(주입이 빠진 채 그려지지 않습니다). 로딩 때 `warmUp`을 부르면 이 오류가 경기 중이 아니라 로딩 단계에서 납니다. 새 revision을 쓰려면 위 파일에서 대상을 확인하고 이 표에 더합니다.

## 소비자 셰이더 주입(확장점)

게임 고유의 주입(예: 발배구의 "화면에서 공 원판 안은 입자를 그리지 않음")은 `InstanceLayer`의 `extend`로 끼웁니다. `inject(shader)`는 레이어 주입 뒤에 불리고, `key`는 프로그램 캐시 키에 들어가 주입이 다른 레이어와 프로그램을 나누지 않습니다.

```js
const mask = { value: new THREE.Vector3() }; // 중심 x·y, 반지름(그리는 버퍼 픽셀)
const cloud = new InstanceLayer(THREE, {
    geometry: shapes.geometry,
    capacity,
    side: THREE.DoubleSide,
    extend: {
        key: 'ball-mask',
        inject(shader) {
            shader.uniforms.uBallMask = mask;
            shader.fragmentShader = replaceShaderChunk(
                shader.fragmentShader,
                'void main() {',
                'uniform vec3 uBallMask;\nvoid main() {',
            );
            shader.fragmentShader = replaceShaderChunk(
                shader.fragmentShader,
                '#include <clipping_planes_fragment>',
                '#include <clipping_planes_fragment>\n    if (distance(gl_FragCoord.xy, uBallMask.xy) < uBallMask.z) discard;',
            );
        },
    },
});
```

## API

- `new RenderStats(renderer, { capacity = 240 })`: `begin()`·`end()`로 한 프레임을 감쌉니다. `snapshot()`은 debug-tools `FrameMetrics.snapshot`(느린 프레임 50ms 이상 3개), `line()`은 진단 한 줄, `metrics`는 그 `FrameMetrics`입니다. 카운터는 `drawCalls`·`triangles`·`programs`(지금까지 만든 프로그램 수)·`textures`입니다. 그림자 패스의 draw도 `drawCalls`에 들어갑니다.
- `warmUp(renderer, scene, camera)`: 숨긴 객체를 모두 보이게 하고(화면 밖 객체도 올리려고 `frustumCulled`도 잠깐 끔) 렌더 타깃을 화면(`null`)으로 두고 scissor를 1픽셀로 줄여 `renderer.compile`·`renderer.render`·`renderer.clear` 뒤, `finally`에서 숨김·`frustumCulled`·렌더 타깃·scissor·`shadowMap.needsUpdate`·`info.render`(그리기·삼각형·점·선 수)를 되돌립니다. 숨긴 것은 플레이 중 보일 것이라고 가정합니다(숨긴 조명이 켜진 변종으로 컴파일됩니다). 소비자가 더 준비할 것(예: 화면 복사 패스)은 `warmUp` 뒤에 자기 코드로 부릅니다.
- `new InstanceLayer(THREE, { geometry, capacity, side, opaque, depthTest, order, extend })`: `mesh`(장면에 넣음)·`material`(레이어 소유)·`begin()`·`add(matrix, color, opacity, shape)`·`end()`·`dispose()`. geometry에 `aShape`가 있으면 모양 합본입니다. 넘치는 `add()`는 그리지 않고, 빈 프레임은 `visible = false`입니다. 레이어끼리 같은 geometry를 넘기면 정적 속성을 공유합니다. 같은 `extend.key`를 쓰는 레이어끼리는 셰이더 프로그램이 하나로 공유되고, 재질 객체(`MeshBasicMaterial`)만 레이어마다 따로 생깁니다.
- `mergeShapes(THREE, { 이름: geometry })` → `{ geometry, shapes }`: 위치만 합칩니다(법선·uv 없음, `MeshBasicMaterial` 전용).
- `new RigidBatch(THREE)`: `root`·`add()`(첫 `mesh()` 전에만)·`bone(i)`·`mesh(geometry, material)`·`setGeometry(mesh, geometry)`·`glowMaterial(material)`·`setGlow(i, value)`·`dispose()`(geometry·뼈 텍스처 해제, 재질은 소비자 소유). `glowMaterial`의 값은 물체 4개당 uniform vec4 하나라 물체 수가 정점 셰이더 uniform 한도 안이어야 합니다.
- `mergeColored(THREE, [{ geometry, color, matrix, body, uvRect }])`, `new PartList(THREE)`(`body`·`add(geometry, color, { position, rotation, scale, parent, body, uvRect })`·`box`·`cylinder`·`sphere`·`build()`): 정점 색·물체 번호·아틀라스 uv를 구워 합칩니다. 거울 변환(행렬식 < 0)은 감김을 뒤집어 앞면을 지킵니다. `body`·`uvRect`는 모든 도형에 있거나 모두 없어야 합니다.
- `replaceShaderChunk(source, target, replacement)`: 위 "셰이더 주입".

## warmUp이 하는 일과 하지 않는 일

`renderer.compile`은 장면의 재질 **프로그램만** 만듭니다(r170·r180 모두 숨긴 메시도 포함, 조명은 보이는 것만 셈). geometry 속성·인스턴스 속성·재질 텍스처·뼈 텍스처는 올리지 않습니다. 이것들은 실제로 그릴 때 올라갑니다(r180 소스로 확인, r170도 같은 구조).

| 올라가는 것                                                 | 올라가는 시점(`render`)                                                                                                |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| geometry 속성(인스턴스 속성 포함)·`InstancedMesh`의 행렬·색 | `projectObject` → `WebGLObjects.update` → `WebGLAttributes.update`(처음이면 `createBuffer`가 배열 전체를 `bufferData`) |
| 인덱스·VAO                                                  | `renderBufferDirect` → `bindingStates.setup`                                                                           |
| 재질 텍스처·뼈 텍스처                                       | `renderBufferDirect` → `setProgram` → uniform 올리기 → `WebGLTextures.setTexture2D` → `uploadTexture`                  |
| 그림자 깊이 재질 프로그램·그림자 맵                         | `shadowMap.render`(그림자를 켠 장면)                                                                                   |

`warmUp`은 컴파일 뒤에 이 그리기를 한 번 합니다. 그래서:

- **프로그램 변종이 플레이와 같습니다.** 프로그램 키는 렌더 타깃이 `null`일 때만 `renderer.outputColorSpace`·`renderer.toneMapping`을 씁니다(타깃이 있으면 선형 색 공간·톤 매핑 없음, `WebGLPrograms.getParameters`). 그래서 렌더 타깃이 아니라 화면(`null`)에 그립니다.
- **화면에 남지 않습니다.** scissor 1픽셀로 줄여 그리고 `renderer.clear()`로 그 1픽셀을 지웁니다. 숨긴 객체가 보이는 프레임이 없고, 왼쪽 아래 1픽셀만 지운 색이 됩니다.
- **인스턴스 수 0인 `InstanceLayer`도 버퍼 전체가 올라갑니다.** 업로드는 그리기 전 `WebGLObjects.update`에서 일어나고, `count`가 0이면 마지막 `drawArraysInstanced`만 건너뜁니다(`renderInstances`의 `primcount === 0`). 레이어를 따로 준비하지 않아도 됩니다.
- **화면 밖 객체도 올라갑니다.** 절두체 컬링에 걸리면 `objects.update`를 건너뛰므로 `frustumCulled`를 잠깐 끕니다.
- `info.render.frame`은 되돌리지 않습니다. 되돌리면 다음 진짜 프레임이 같은 번호가 되어 geometry 갱신을 건너뜁니다(`WebGLObjects.update`의 프레임당 한 번 규칙).

하지 않는 것: 화면 크기에 묶인 렌더 타깃·복사 텍스처(예: 화면 복사 후처리), `renderer.initTexture`로 따로 올려야 하는 장면 밖 텍스처. 이것들은 소비자가 `warmUp` 뒤에 자기 코드로 준비합니다(DEV-032).

## 그리기 수(DEV-034)

`InstanceLayer` 하나와 `RigidBatch` 메시 하나는 각각 1 draw이고, 인스턴스 수·모양 수·물체 수·색 수로 늘지 않습니다. 렌더 상태(재질·투명/불투명·깊이 테스트·renderOrder)가 다른 것만 따로 그립니다. 그림자를 드리우면 그림자 패스에서 1 draw씩 더합니다.

## 시험과 예제

- 고정 시나리오 `node modules/three-kit/tests/three-kit.e2e.mjs`(core): Node에서 저장소의 three(r186)로 `PartList`·`mergeColored`의 정점 수·물체 번호·거울 감김, 실제 내장 셰이더 주입, 주입 대상 없음 오류, 칸 넘침을 봅니다. GPU를 쓰지 않습니다.
- 예제: [렌더링 예제의 three.js 탭](../rendering/examples/index.html)(three r180을 CDN에서 받아 넘김). 미리보기 시나리오(`project/tests/previews.mjs`)가 표시 수를 늘려도 2 draw이고 미리 컴파일 뒤 새 프로그램이 없는지, `warmUp` 뒤 숨겨 둔 레이어를 처음 그릴 때 새 버퍼·텍스처 할당이 없는지(`createBuffer`·`bufferData`·`createTexture`·`texStorage2D`·`texImage2D` 호출 수)를 봅니다.

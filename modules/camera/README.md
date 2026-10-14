# camera

Budmori의 OrthographicPitch와 공통 렌더 좌표를 분리한 독립 ESM입니다. 카메라는 표현만 바꾸며 시뮬레이션 좌표를 수정하지 않습니다.

## 충돌 boom 거리

`CollisionBoom`은 2D 투영과 독립적으로 쓸 수 있는 scalar 거리 컨트롤러입니다. 3D 카메라의 방향·pivot·ray/sphere cast·충돌 레이어·반경·벽 여유 거리는 게임이 소유하며, 물리 엔진 의존성이나 대체 시점 탐색을 포함하지 않습니다.

```js
import { CollisionBoom } from './camera.js';
const boom = new CollisionBoom({ distance: 4, holdMs: 150, releaseHalfLifeMs: 180 });
// 게임이 현재 pivot에서 원하는 방향으로 sphere cast하고 반경/여유 거리를 적용합니다.
const distance = boom.update(desiredDistance, clearDistance, elapsedMs);
// pivot + direction * distance를 최종 카메라 위치로 적용합니다.
// 순간이동/재시작에는 이전 벽의 hold를 지웁니다.
boom.reset(desiredDistance);
```

- `new CollisionBoom({distance=0,holdMs=120,releaseHalfLifeMs=180})`: 거리 단위는 게임 좌표, 시간은 ms입니다. 모든 인수는 유한한 비음수이며, 잘못된 값은 상태를 바꾸기 전에 거부합니다.
- `update(desiredDistance,clearDistance,elapsedMs) → number`: `min(desiredDistance,clearDistance)`가 안전 상한입니다. 충돌이 없으면 `clearDistance=desiredDistance`를 전달합니다. 상한이 현재 거리보다 짧아지면 0ms에도 즉시 축소하고 hold를 시작합니다. 최근접 장애물이 다시 관측되면 hold를 갱신하여 모서리에서 짧은 clear/blocked 교대에 따른 펌핑을 줄입니다.
- hold가 끝난 프레임은 남은 시간만 사용해 지수 복원합니다. 고정 목표와 같은 경과 시간에서는 프레임 분할에 무관한 반감기입니다. 0ms에는 복원하지 않으며, `releaseHalfLifeMs=0`은 hold 후 양수 시간이 흐르면 즉시 복원합니다. 새 장애물은 hold/복원 중에도 항상 즉시 적용합니다.
- 읽기 전용 `distance`는 현재 거리를 반환합니다. `reset(distance=0) → this`는 거리와 hold를 초기화합니다. reset은 충돌을 검사하지 않으므로 teleport/restart 후 새 pivot의 안전 거리를 다시 쿼리하고 update한 뒤 렌더하세요.
- **안전성은 호출자의 probe 구간에 한정됩니다.** 출력 뒤에 XYZ 위치 보간을 더하거나, 검사한 방향·pivot을 바꾸면 보장되지 않습니다. 이 컨트롤러는 시선 회전·타깃 추적·관통 복구를 구현하지 않습니다. 같은 거리라도 방향을 바꾼 프레임에는 새 probe를 전달해야 합니다.
- 프레임당 O(1), 외부 호출·타이머·프레임별 객체 할당 없이 현재 거리와 hold 시간을 보관합니다. 충돌 쿼리 비용은 게임 소유입니다.

설계 참고: [Unity Cinemachine Deoccluder](https://docs.unity3d.com/Packages/com.unity.cinemachine@3.1/manual/CinemachineDeoccluder.html)의 최근접 위치 유지와 복원 damping, [Unreal SpringArmComponent](https://dev.epicgames.com/documentation/en-us/unreal-engine/API/Runtime/Engine/USpringArmComponent)의 충돌 시 boom 축소/해제 시 복원을 참고했습니다. 엔진 구현은 복사하지 않았습니다.

## 투영과 viewport

- `OrthographicProjection({degrees=40,pixel2to1=false})`: XY 지면, 절대 Z 높이. K=sin(pitch), H=cos(pitch), 평면 y=Y×K−Z×H, depth=Y×H+Z×K. pitch는 지면에 대한 고도각 (0,90]이며 pixel2to1은 K=.5입니다.
- `projectInto(x,y,z,out)`, `groundInto(px,py,out,z=0)`, `depth(y,z=0)`, `angle(radians)`, `intentInto(x,y,out)`는 호출자 출력 객체를 재사용합니다. terrain 지면 높이와 jump/bob은 게임이 합성해 절대 Z로 전달합니다.
- `CameraViewport({projection,width,height,dpr,left,top,x,y,zoom,rotation})`: x/y는 위 투영 평면의 중심입니다. CSS 픽셀과 backing 픽셀을 구별합니다. `setViewport`, `setCamera`, `setShake(CSSx,CSSy)`는 명시적 설정입니다.
- `worldToScreenInto(x,y,z,out)`, `planeToScreenInto(x,y,out)`, `screenToPlaneInto(x,y,out)`, `clientToScreenInto`, `screenToClientInto`, `screenToBackingInto`.
- `screenToGroundInto(x,y,out,{z=0,intersect=null})`: 평면 지면 역변환은 정확합니다. 언덕은 `intersect(projectedX,projectedY,projection,out) → boolean`에 게임의 terrain solver를 연결합니다. 임의 지형을 고정 횟수로 근사해 성공했다고 주장하지 않습니다.
- `rendererCameraInto(out)`, `applyToRenderer(renderer,resize=false)`: rendering의 기존 2D 중심/zoom/radians 계약과 같은 회전 수식을 사용합니다. plane geometry에 XYZ를 다시 투영하지 않습니다. renderer 변환과 이 API의 픽셀 일치를 실제 WebGL E2E로 검사합니다.
- `follow(projectedX,projectedY,elapsedMs,halfLifeMs=0)`: 반감기 기반 시간 독립 지수 추적입니다. 0이면 즉시 이동합니다. bounds/zoom 제한/추적 대상을 게임이 정합니다. 흔들림 파형·RNG·타이머를 소유하지 않습니다.

화면 좌표는 canvas 내용 영역 CSS 기준입니다. left/top은 client offset입니다. CSS rotate/skew/border는 자동 추측하지 않으므로 caller가 입력 좌표를 내용 영역으로 정규화하세요. DPR은 출력 backing 좌표에만 적용합니다. Rally는 자신의 (x,z 지면 / y 높이) 축을 API 경계에서 매핑합니다. 카메라 흔들림을 입력 역변환에서 제외하는 게임은 camera shake를 0으로 유지하고 최종 합성에 별도로 적용합니다.

출처: [Budmori.io 88c93e7](https://github.com/byh-playground/budmori-io/tree/88c93e7)의 사용자 소유 OrthographicPitch 동작을 기준으로 새 모듈을 작성했습니다. 원본에 없는 라이선스를 임의 부여하지 않습니다.

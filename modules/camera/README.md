# camera

Budmori의 OrthographicPitch와 공통 렌더 좌표를 분리한 독립 ESM입니다. 카메라는 표현만 바꾸며 시뮬레이션 좌표를 수정하지 않습니다.

- `OrthographicProjection({degrees=40,pixel2to1=false})`: XY 지면, 절대 Z 높이. K=sin(pitch), H=cos(pitch), 평면 y=Y×K−Z×H, depth=Y×H+Z×K. pitch는 지면에 대한 고도각 (0,90]이며 pixel2to1은 K=.5입니다.
- `projectInto(x,y,z,out)`, `groundInto(px,py,out,z=0)`, `depth(y,z=0)`, `angle(radians)`, `intentInto(x,y,out)`는 호출자 출력 객체를 재사용합니다. terrain 지면 높이와 jump/bob은 게임이 합성해 절대 Z로 전달합니다.
- `CameraViewport({projection,width,height,dpr,left,top,x,y,zoom,rotation})`: x/y는 위 투영 평면의 중심입니다. CSS 픽셀과 backing 픽셀을 구별합니다. `setViewport`, `setCamera`, `setShake(CSSx,CSSy)`는 명시적 설정입니다.
- `worldToScreenInto(x,y,z,out)`, `planeToScreenInto(x,y,out)`, `screenToPlaneInto(x,y,out)`, `clientToScreenInto`, `screenToClientInto`, `screenToBackingInto`.
- `screenToGroundInto(x,y,out,{z=0,intersect=null})`: 평면 지면 역변환은 정확합니다. 언덕은 `intersect(projectedX,projectedY,projection,out) → boolean`에 게임의 terrain solver를 연결합니다. 임의 지형을 고정 횟수로 근사해 성공했다고 주장하지 않습니다.
- `rendererCameraInto(out)`, `applyToRenderer(renderer,resize=false)`: rendering의 기존 2D 중심/zoom/radians 계약과 같은 회전 수식을 사용합니다. plane geometry에 XYZ를 다시 투영하지 않습니다. renderer 변환과 이 API의 픽셀 일치를 실제 WebGL E2E로 검사합니다.
- `follow(projectedX,projectedY,elapsedMs,halfLifeMs=0)`: 반감기 기반 시간 독립 지수 추적입니다. 0이면 즉시 이동합니다. bounds/zoom 제한/추적 대상을 게임이 정합니다. 흔들림 파형·RNG·타이머를 소유하지 않습니다.

화면 좌표는 canvas 내용 영역 CSS 기준입니다. left/top은 client offset입니다. CSS rotate/skew/border는 자동 추측하지 않으므로 caller가 입력 좌표를 내용 영역으로 정규화하세요. DPR은 출력 backing 좌표에만 적용합니다. Rally는 자신의 (x,z 지면 / y 높이) 축을 API 경계에서 매핑합니다. 카메라 흔들림을 입력 역변환에서 제외하는 게임은 camera shake를 0으로 유지하고 최종 합성에 별도로 적용합니다.

출처: [Budmori.io 88c93e7](https://github.com/byh-playground/budmori-io/tree/88c93e7)의 사용자 소유 OrthographicPitch 동작을 기준으로 새 모듈을 작성했습니다. 원본에 없는 라이선스를 임의 부여하지 않습니다.

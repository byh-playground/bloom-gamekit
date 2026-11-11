# face

## 언제 쓰나

- 몸마다 얼굴을 따로 그리지 않고, **몸 SVG의 소켓 점 세 개에 같은 표정 부품(눈·입·볼)을 얹고** 싶을 때. 표정 13가지(`FACE_IDS`)를 모듈이 정의합니다.
- 작게 그릴 때는 구운 이미지, 크게 그릴 때는 경로로 같은 얼굴을 그리고 싶을 때(`FaceOverlay`·`drawFacePaths`).

## 쓰는 모양

```js
// rally-frontier/src/main.js (줄임)
this.grainFaces = new RallyGamekit.FaceOverlay(this.vectorContext, { faces: GRAIN_FACE_IDS });
this.grainFaces.prepare(); // 자원 준비 때 한 번
// 프레임마다: 몸을 그린 뒤 그 몸의 포즈된 소켓에 표정을 얹음
C.drawVectorActor(grain.actor, { matrix: grain.matrix });
this.grainFaces.draw(grain.compiled, grain.actor, grain.face, grain.matrix, 1);
// 정리
this.grainFaces.dispose();
```

경로 그리기 예: `rally-frontier/src/ui/grain-portrait.js`(`drawFacePaths(C, compiled, 'neutral')`).

## 쓰지 말아야 할 때

| 이런 일                                  | 대신                                                                            |
| ---------------------------------------- | ------------------------------------------------------------------------------- |
| 상태 → 표정 선택, 캐릭터별 표정, 진영 색 | 게임이 정합니다                                                                 |
| 게임 고유 표정 등록                      | API가 없습니다. 필요하면 모듈의 정의 표에 추가합니다                            |
| 몸 그림 자체                             | [vector-assets](../vector-assets/README.md)·[rendering](../rendering/README.md) |

## 상세

몸마다 얼굴을 따로 그리지 않고, **몸 SVG의 소켓 점 세 개에 모든 몸이 같은 표정 부품을 얹는** 모듈입니다. 표정 정의(눈·입·볼의 모양)는 이 모듈의 데이터이고, 어떤 몸이 언제 어떤 표정을 지을지는 게임이 정합니다.

- 표정 13가지(`FACE_IDS`)는 눈 사이 거리를 1로 둔 단위로 한 번 정의하고, 몸은 점 세 개로 부품을 옮기고 키울 뿐입니다.
- 그리기는 두 가지입니다. 작게 그릴 때는 한 번 구워 둔 이미지를 몸 위에 얹고, 이미지가 늘어나게 될 때는 같은 부품을 경로로 그립니다. 두 그림은 같은 얼굴입니다.
- 번들(`dist/face.js`)은 외부 import가 없습니다. rendering의 `VectorContext`와 vector-assets의 컴파일 결과·actor는 모양(duck typing)만 맞으면 받으며, 이 모듈이 다른 모듈을 불러오지 않습니다.

예외:

- 게임 규칙은 모듈에 없습니다. 상태 → 표정 선택, 캐릭터별 표정, 진영·속성 색, 어떤 표정을 구울지는 게임이 정합니다. 볼 색은 호출할 때 `cheekColor`로 받습니다.
- 표정은 모듈의 정의 표(`geometry.js`의 상태 표정 표와 성격 표정 배열)에 있습니다. 게임이 자체 표정을 등록하는 API는 없습니다(필요가 생기면 정의 표에 추가).
- 굽는 데는 브라우저의 `OffscreenCanvas`·`Path2D`가 필요합니다. 기하(`buildFace`·`faceSvg` 등)는 Node에서도 돕니다.

## 몸에 필요한 것

몸 SVG는 `metadata`의 소켓 세 개만 선언하면 됩니다. 이름은 `FACE_SOCKETS`입니다.

    face-eye-left   face-eye-right   face-mouth      // 모두 몸 캔버스 좌표의 점

    import { faceAnchor, posedFace } from '../../../dist/face.js';

    const REST = faceAnchor(compiled); // { eyeLeft, eyeRight, mouth }, 몸마다 한 번 만들어 캐시
    const SCRATCH = [0, 0, 0, 0, 0, 0];
    posedFace(actor, REST, SCRATCH); // 눌림·기울기·튀기를 반영한 [a, b, c, d, e, f]

`posedFace`는 쉬는 자세의 소켓 삼각형을 지금 자세의 삼각형으로 옮기는 변환을 `out`에 씁니다. 몸 뒤에 그리는 장식(보스의 후광처럼 머리를 따라다니는 것)도 같은 변환을 쓸 수 있습니다. 세 점이 한 줄에 있으면 변환이 정의되지 않습니다(NaN).

## 표정 정의

    import { FACE_IDS, STATE_FACES, TEMPERAMENT_FACES, faceParts, buildFace, faceSvg } from '../../../dist/face.js';

    STATE_FACES;       // neutral happy focused attack surprised hurt hungry dead
    TEMPERAMENT_FACES; // temperament-0 … temperament-4: neutral일 때 보여 줄 다섯 가지 평소 표정(번호의 뜻은 게임이 정함)
    faceParts('happy'); // { eyes: [왼눈 ops, 오른눈 ops], mouth: ops, cheeks: { scale, opacity } } — 눈 간격 1 단위, 부품 자기 점이 원점
    buildFace('happy', REST, '#4f8fe8'); // 몸 캔버스 좌표의 그리기 명령(ops). 색 하나에 명령 하나
    faceSvg('happy', REST, null);        // 같은 얼굴의 SVG <path> 문자열(초상화용). null이면 DEFAULT_CHEEK_COLOR

ops는 `{ fill | stroke, path: [['M', x, y], ['C', …], …], width?, opacity? }`입니다. 같은 색은 겹침이 층 순서를 바꾸지 않는 한 한 명령으로 합칩니다. `faceParts`는 표정마다 얼린 객체 하나를 돌려줍니다. 정의에 없는 표정은 `RangeError`입니다.

## 몸 위에 얼굴 얹기

    import { FaceOverlay } from '../../../dist/face.js';

    const FACES = new FaceOverlay(vectorContext, { faces: ['neutral', 'attack', 'hurt'] }); // faces를 빼면 13가지 모두
    FACES.prepare(); // 렌더러 시작에서 한 번, 게임 프레임 밖에서. device가 ready가 아니면 아무것도 안 하니 준비되면 다시 부름

    // 매 프레임: 몸을 먼저 제출한 뒤, 같은 화면 행렬로
    context.drawVectorActor(actor, { matrix, alpha });
    const BAKED = FACES.draw(compiled, actor, 'attack', matrix, alpha, cheekColor); // true: 이미지, false: 경로

    FACES.dispose(); // 올린 아틀라스 영역을 돌려줌

- 몸 하나는 `compiled`(소켓을 담은 컴파일 결과)와 `actor`(`getSocket(id)`이 지금 자세의 `{ x, y }`를 돌려주는 객체)입니다. 표정과 볼 색은 호출마다 바꿀 수 있어 몸과 얼굴이 따로 움직입니다.
- 부품 이미지(표정마다 왼눈·오른눈·입, 그리고 볼 하나)는 장치의 텍스처 아틀라스 영역이고, 몸과 같은 그리기 호출에 `drawRegion`으로 섞여 들어갑니다. 컨텍스트를 잃었다 되찾으면 장치가 올린 영역을 되살리므로 다시 굽지 않습니다.
- 이미지로 그리지 못하는 경우는 모두 같은 얼굴을 경로로 그립니다: 굽기 전, 컨텍스트가 없는 동안, 굽지 않은 표정, 그리고 이미지를 반 크기보다 크게 늘리게 될 때(눈 간격 × 화면 배율이 64픽셀을 넘을 때). 반환값이 false인 경우입니다.
- `faces`에 없는 표정을 굽지 않는 것은 아틀라스 용량을 아끼기 위해서입니다. 용량은 `WebGLDevice`의 `textureAtlas` 옵션이 정합니다. 굽다가 용량이 모자라면 `prepare`가 올린 것을 돌려주고 오류를 던져, 반쯤 굽힌 채로 남지 않습니다.

## 경로로만 그리기와 초상화

    import { drawFacePaths, drawOperations } from '../../../dist/face.js';

    // 2D canvas에 몸 SVG를 그린 뒤, 변환이 몸 캔버스를 가리키는 상태에서
    drawFacePaths(canvas2d, compiled, 'neutral', cheekColor);
    // 이미 가진 ops를 그릴 때
    drawOperations(context, operations, alpha);

`drawFacePaths`는 몸·표정·볼 색마다 ops를 한 번 만들어 몸에 붙여 캐시합니다(`FaceOverlay`의 경로 그리기도 같은 함수). `drawOperations`는 Canvas 경로 API(`beginPath`, `moveTo`, …, `fill`, `stroke`)를 가진 어떤 컨텍스트에서도 돕고, `lineCap`·`lineJoin`·`globalAlpha`·스타일을 바꿔 놓으니 `save`/`restore` 사이에서 부릅니다. SVG 문자열 초상화는 `faceSvg`입니다.

## 다른 그림도 같은 방식으로: OperationImages

`FaceOverlay`가 쓰는 "그리기 명령을 한 번 굽고 아틀라스에서 그린다"를 그대로 꺼낸 클래스입니다. 얼굴이 아닌 작은 표시(예: 속성 마크)를 같은 방식으로 올릴 때 씁니다.

    import { OperationImages } from '../../../dist/face.js';

    const MARKS = new OperationImages(vectorContext, [
        ['fire', { operations: FIRE_OPS, pixelsPerUnit: 64 / 24 }],
    ]); // 키는 아무 값(객체면 문자열 해시 없이 찾음)
    MARKS.prepare();
    if (MARKS.ready) {
        MARKS.draw('fire', x, y, scaleX, scaleY); // 그림의 원점이 (x, y), 지역 단위가 (scaleX, scaleY)
    }

## 비용과 제한

- 굽기: 13가지 표정 전부는 이미지 40장(약 89,000픽셀, RGBA 약 350KB), 표정 3가지는 10장(약 25,000픽셀, 약 100KB)입니다. 이미지는 눈 간격 1당 128픽셀, 볼은 64픽셀로 고정입니다(두 게임이 같은 값을 써 옵션으로 열지 않았습니다).
- 그리기: 얼굴 하나는 `save`·`restore`, 변환 두 번, 사각형 5개(볼 둘, 눈 둘, 입)입니다. 사각형은 몸과 같은 그리기 호출에 들어가며, 예제 탭은 몸 14개와 얼굴 14개를 호출 1회로 그립니다. 호출당 작은 객체 몇 개(배치·볼 타원·`withColor` 콜백)를 만듭니다. 이미지 조회는 부품 ops 객체가 키라서 문자열을 만들지 않습니다.
- 경로로 그릴 때는 표정마다 그리기 명령 3~7개(경로 명령 20~60개)를 매번 그려서 이미지 사각형 5개보다 비쌉니다. 얼굴이 큰 장면(확대, 큰 초상화)에서만 이 경로가 됩니다.
- 얼굴은 소켓 세 점으로 정해지는 아핀 변환(이동·회전·비율·기울임)으로만 몸을 따라갑니다. 몸의 입이 비틀리거나 눈이 따로 움직이는 변형은 표현하지 못합니다.
- 얼굴은 몸을 제출한 뒤 얹습니다. 몸·얼굴의 깊이 정책 같은 그리기 상태는 게임이 정합니다.
- 범용 라이브러리와는 따로 비교하지 않았습니다. 몸 아트에는 점 세 개만 두고 같은 부품을 모든 몸에 입히는 게임 아트 계약에 묶인 모듈이고, 몸마다 얼굴을 그리는 리깅 도구(Spine, Live2D)와는 쓰는 방식이 다릅니다.

## 두 게임에서 올린 범위

budmori-io와 rally-frontier에 있던 코드를 읽고, 글자 단위로 같은 부분만 올렸습니다.

| 부분                                                              | budmori-io                            | rally-frontier                   | 이 모듈                           |
| ----------------------------------------------------------------- | ------------------------------------- | -------------------------------- | --------------------------------- |
| 표정 기하(`face-layer.js` 397줄)                                  | 있음                                  | 같은 내용(줄바꿈만 CRLF)         | `geometry.js` 그대로              |
| 소켓 → 쉬는 앵커(`faceAnchor`)                                    | WeakMap 캐시, 오류 "Body is missing…" | 같은 구조, 오류 "Grain body is…" | `faceAnchor`                      |
| 자세 삼각형 변환(`posedFace`)                                     | 같은 식, 보스 후광도 사용             | 같은 식                          | `posedFace`(`out`은 호출자 소유)  |
| 그리기 명령 → 이미지 → 아틀라스(`rasterise`·`prepare`·`dispose`)  | 표정 13 + 볼 + 속성 마크              | 표정 3 + 볼                      | `OperationImages` + `FaceOverlay` |
| 이미지로 그리기 / 늘어나면 경로로(`drawFace` / `drawImages`)      | 볼 색을 인자로 받음                   | 볼 색 고정                       | `FaceOverlay.draw`(볼 색 인자)    |
| 경로 그리기(`drawOperations`)                                     | 있음                                  | 있음(초상화에도)                 | `drawOperations`·`drawFacePaths`  |
| 상태 → 표정(`unitLook`), 속성 → 볼 색, 속성 마크(`ELEMENT_ICONS`) | 있음                                  | 없음                             | 올리지 않음(게임 규칙·아트)       |
| 어떤 표정을 구울지(`GRAIN_FACE_IDS`)                              | 전부                                  | 3가지                            | `faces` 옵션으로 게임이 정함      |
| SVG 몸 DOM에 얼굴 그룹 붙이기(`species-paint`)                    | 있음                                  | 없음                             | `faceSvg`만 올림, DOM 조립은 게임 |

같은 점은 그대로 올렸고, 다른 점은 모두 게임이 고르는 값(볼 색, 굽는 표정 목록)이거나 한 게임에만 있는 규칙(속성 마크, 상태 → 표정)이었습니다. 앞의 둘은 인자와 옵션으로 열었고, 뒤의 둘은 모듈에 두지 않았습니다. 속성 마크를 굽는 부분만은 얼굴과 같은 코드라 `OperationImages`로 꺼냈습니다.

## 실행 예제

[렌더링 예제의 "표정" 탭](../rendering/examples/index.html#face)([바로 보기](https://htmlpreview.github.io/?https://github.com/byh-playground/bloom-gamekit/blob/previews/rendering.html#face))에서 13가지 표정을 작은 이미지와 큰 경로로 나란히 보고, 몸이 눌리고 기울 때 얼굴이 따라가는 것과 볼 색 바꾸기를 눌러 봅니다. 터치와 마우스로 얼굴을 눌러 고릅니다.

고정 시나리오는 `node modules/face/tests/face.e2e.mjs`입니다. 실제 Chromium·WebGL에서 진짜 SVG 몸과 vector actor 위에 굽기 → 그리기 → 확대 → 컨텍스트 소실·복구 → 정리를 이어서 확인합니다.

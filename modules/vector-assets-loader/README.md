# vector-assets-loader

## 언제 쓰나

- 게임 시작 때 **원본 SVG를 받아 SHA-256을 확인하고 한 번 컴파일**해, [vector-assets](../vector-assets/README.md)의 `createVectorActor`가 쓸 geometry로 만들고 싶을 때. 같은 요청은 한 번만 받고 완료 결과는 LRU 캐시에 둡니다.
- 생성한 메시를 저장소·배포물에 커밋하지 않고 원본 SVG만 두고 싶을 때.

## 쓰는 모양

```js
// yarn-mayhem/src/main.js (줄임)
const sourceManifest = await (await fetch(new URL('assets/active-theme/manifest.json', document.baseURI))).json();
const loader = createVectorAssetLoader({ maxEntries: 8 });
const loadedAssets = await Promise.all(
    sourceManifest.assets.map(async (item) => [
        item.key,
        await loader.load(new URL(item.path, document.baseURI).href, {
            sourcePath: item.path,
            expectedSha256: item.sha256,
            maxBytes: 512 * 1024,
            curveSegments: 16,
        }),
    ]),
);
```

로딩 진행률과 함께 쓰는 예: `rally-frontier/src/core/gamekit.js`의 `loadRallyVectorAssets`(파일마다 [boot](../boot/README.md) `advance`).

## 쓰지 말아야 할 때

| 이런 일                     | 대신                                                            |
| --------------------------- | --------------------------------------------------------------- |
| 컴파일한 자산을 그리기·재생 | [vector-assets](../vector-assets/README.md) `createVectorActor` |
| 빌드 때 미리 컴파일해 커밋  | 하지 않습니다. 원본 SVG만 두고 시작 시 컴파일합니다             |

## 상세

`dist/vector-assets-loader.js`는 `createVectorAssetLoader`와 `VECTOR_ASSET_QUALITY_PRESETS`만 내보내는 별도 번들입니다. 구현은 [vector-assets](../vector-assets/README.md)의 `browser-loader.js`와 공유 컴파일러이며, `loader.load(url, options)`의 옵션·캐시 키·품질 preset 계약은 [vector-assets README의 Build and runtime](../vector-assets/README.md#build-and-runtime)이 원본입니다.

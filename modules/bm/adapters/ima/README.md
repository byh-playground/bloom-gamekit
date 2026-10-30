# bm IMA 영상 광고 어댑터

Google IMA SDK(HTML5)로 VAST 영상 광고를 전체 화면에 재생하는 어댑터입니다. 계정 없이 Google의 공개 **샘플 광고 태그**로 실제 영상 광고를 재생해 볼 수 있어서, 승인 전에 `bm`의 광고 흐름(보상·닫기·광고 없음·정지·재개)을 실제 영상으로 확인하는 데 씁니다.

## 신청과 준비

- **테스트**: 신청이 필요 없습니다. `IMA_SAMPLE_TAGS`는 Google 문서의 공개 샘플 태그이며 [문서](https://developers.google.com/interactive-media-ads/docs/sdks/html5/client-side/tags)에 계정 요건이 적혀 있지 않습니다. 광고 차단을 끄고 HTTPS로 열어야 합니다.
- **운영**: 샘플 태그는 테스트 전용입니다. 운영하려면 VAST 광고 태그를 내주는 광고 수요처(예: Google Ad Manager 계정, 또는 VAST를 제공하는 다른 광고 서버)와 계약해야 합니다. 어떤 조건과 승인이 필요한지는 확인하지 못했습니다. 수요처를 정하면 그 절차를 이 README에 추가합니다.

## 사용

    import { createBm } from '../../../../dist/bm.js';
    import { createImaAdapter, IMA_SAMPLE_TAGS } from '../../../../dist/bm-ima.js';

    const BM = createBm({ adapter: createImaAdapter({ adTagUrl: IMA_SAMPLE_TAGS.linear }) });
    await BM.preload('entry'); // ima3.js를 미리 불러 둠

    button.onclick = async () => {
        const RESULT = await BM.showRewarded('entry');
        if (RESULT.status === 'rewarded') {
            reward();
        }
    };

- `adTagUrl`: https 주소 문자열 또는 `(placement, type) => 주소` 함수입니다. 끝의 빈 `correlator=`는 매번 다른 값으로 채웁니다.
- `IMA_SAMPLE_TAGS`: `linear`(건너뛸 수 없음), `skippable`, `vertical`, `redirectError`(광고가 없는 경우 확인용)입니다.
- `loadTimeoutMs`(기본 10초): 광고가 시작되기까지의 시간입니다. 넘으면 `unavailable`입니다. `playTimeoutMs`(기본 100초): 시작한 광고가 끝나기까지의 시간입니다. 넘으면 `error`입니다.

## 동작과 제약

- 광고마다 전체 화면 오버레이를 만들고 끝나면 지웁니다. 소리·시뮬레이션 정지는 모듈이 하지 않고 `adstart`/`adend`에서 게임이 합니다.
- 결과: 끝까지 재생(`COMPLETE`)이면 보상형은 `rewarded`, 전면은 `viewed`입니다. 건너뛰거나(`SKIPPED`) 닫으면(`USER_CLOSE`) `dismissed`입니다. 시작 전 오류나 광고 없음은 `unavailable`, 재생 중 오류는 `error`입니다.
- `AdDisplayContainer.initialize()`는 클릭과 같은 task에서 부르도록 SDK가 이미 있으면 `show` 안에서 바로 호출합니다. 그래서 `preload`를 미리 해 두세요. 이 호출에 사용자 입력이 꼭 필요한지는 문서에서 확인하지 못했습니다.
- 건너뛸 수 있는 광고 태그를 보상형에 쓰면 건너뛴 사용자는 보상을 받지 못합니다. 보상형에는 건너뛸 수 없는 태그가 자연스럽습니다.

## 실제 영상으로 확인한 것과 남은 것

2026-10-30에 이 PC의 헤드리스 Chromium(Playwright, 데스크톱 폭)에서 [예제 하네스](../../examples/index.html)로 Google 공개 샘플 태그를 직접 호출했습니다.

- [x] `linear` 태그: 약 13초 재생되고 `rewarded`로 끝납니다. `adstart`/`adend`가 한 쌍으로 불리고 광고 뒤 다시 눌립니다.
- [x] `redirectError` 태그: 약 2초 만에 `unavailable`로 끝나고 잠금이 풀려 다시 눌립니다.
- [x] `skippable` 태그를 끝까지 재생: `rewarded`로 끝납니다.
- [ ] `skippable` 태그를 건너뛰었을 때 `dismissed`: 자동으로 건너뛰기 버튼을 누르지 못해 실제 광고로는 확인하지 못했습니다(가짜 IMA로 계약만 확인).
- [ ] 건너뛴 뒤 `ALL_ADS_COMPLETED`가 와도 `dismissed`로 유지됩니다(이벤트 순서를 문서로 확인하지 못했습니다).
- [ ] 광고 차단이 켜진 상태: `preload`가 false이고 요청은 `unavailable`입니다.
- [ ] 모바일 실기기에서 한 번 눌러 영상이 재생됩니다.

참고: 재생 중 `securepubads.g.doubleclick.net`, `gen_204` 같은 추적 요청이 실패로 기록되었지만 광고 재생과 결과에는 영향이 없었습니다. 헤드리스 환경 특성일 수 있습니다.

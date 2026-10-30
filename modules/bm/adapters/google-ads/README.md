# bm Google H5 Games Ads 어댑터

Google의 Ad Placement API(`adBreak`)를 bm 계약에 맞춰 줍니다. 전면과 보상형을 지원합니다.

## 신청과 준비 (개발자가 한 번 해 둘 일)

1. **승인된 AdSense 계정**이 필요합니다. 승인된 계정이 있어야 H5 게임에 광고를 낼 수 있습니다.
2. **H5 Games Ads 베타를 신청**합니다. 신청 폼: <https://adsense.google.com/start/h5-beta>. 전면·보상형 광고는 베타 참여 승인 범위에서만 허용되며, 승인은 보장되지 않습니다. 안내: <https://developers.google.com/ad-placement/docs/beta>
3. 승인 뒤 AdSense의 게시자 ID(`ca-pub-...`)를 `clientId`로 넘깁니다.
4. 게시할 사이트·도메인이 AdSense에 등록돼 있어야 합니다.
5. 개발 중에는 반드시 `testMode: true`를 씁니다(테스트 광고만 나옵니다). **출시 전에 끕니다.** 테스트가 아닌 광고를 개발 중에 직접 누르거나 반복 노출하면 정책 위반이 될 수 있습니다.

## 사용

    import { createBm } from '../../../../dist/bm.js';
    import { createGoogleAdsAdapter } from '../../../../dist/bm-google-ads.js';

    const BM = createBm({ adapter: createGoogleAdsAdapter({ clientId: 'ca-pub-123456789', testMode: true }) });
    await BM.preload('entry'); // SDK가 준비되면 true. 첫 광고 요청 전에 해 두세요.

`loadScript: false`로 `adsbygoogle.js`를 페이지에 직접 넣을 수도 있습니다. 그 경우 `data-adbreak-test`도 직접 붙입니다.

## 동작과 제약

- 보상형은 `adBreak({ type: 'reward' })`를 부르고 `beforeReward`에서 바로 `showAdFn`을 호출합니다. 즉 사용자가 이미 누른 입력을 수락으로 봅니다. Google은 광고마다 사용자가 직접 선택할 것을 요구합니다. 버튼 문구에 광고를 본다는 점이 드러나야 하고, 광고 한 편마다 클릭이 한 번 필요합니다. 한 번 더 확인 창을 두려면 `onRewardReady(acceptAd)`를 넘기고 사용자가 수락할 때 `acceptAd()`를 호출합니다.
- `adBreak`는 사용자 입력에 대한 응답으로 불러야 합니다. 그래서 `preload`를 화면이 뜰 때 미리 해 두고, 광고 요청은 클릭 핸들러 안에서 바로 합니다.
- 전면은 `interstitialType`(기본 `next`: 다음 단계로 넘어갈 때)에 맞는 시점에만 호출합니다.
- `load()`는 SDK 준비 여부만 알려 줍니다. 광고 한 편이 실제로 준비됐는지는 Google이 알려 주지 않으며, 없으면 `show`가 `unavailable`로 끝납니다. 빈도 제한(`frequencyCapped`) 등 Google 쪽 사유도 `unavailable`입니다.
- 광고 시청 콜백(`adViewed`)은 브라우저 신호입니다. 서버에서 검증할 수 없으므로 돈이나 상품처럼 가치가 큰 보상의 근거로 쓰지 마세요.
- `adConfig`의 `preloadAdBreaks`, `onReady`는 문서 전문을 확인하지 못한 채 쓴 옵션입니다. 실제 브라우저 테스트 광고로 동작을 확인해야 합니다.

## 출시 전에 확인

- Google의 [H5 Games 정책](https://support.google.com/adsense/answer/15405364)과 보상형 광고 정책을 읽고, 보상 내용이 정책에 맞는지 확인합니다.
- `testMode`를 껐는지, 사이트가 AdSense에 등록돼 있는지 확인합니다.

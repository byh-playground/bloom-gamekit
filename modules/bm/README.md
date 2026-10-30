# bm

광고 SDK를 하나의 인터페이스로 감싸고 빈도 정책을 적용하는 순수 ESM 모듈입니다. 광고사마다 어댑터를 붙이며, 게임은 어댑터가 무엇이든 같은 코드를 씁니다. 결제·상금·서버 정산은 이 모듈의 범위가 아닙니다.

## 구성

    modules/bm/index.js                  코어 (dist/bm.js)
    modules/bm/adapters/mock/            테스트·예제용 (dist/bm-mock.js)
    modules/bm/adapters/google-ads/      Google H5 Games Ads (dist/bm-google-ads.js)

어댑터는 코어를 import하지 않고 아래 계약만 지키는 별도 번들입니다. 필요한 광고사 번들만 가져옵니다. 신청·승인 절차와 키는 각 어댑터 폴더의 README에 적습니다.

## 사용

    import { createBm } from '../../../dist/bm.js';
    import { createGoogleAdsAdapter } from '../../../dist/bm-google-ads.js';

    const BM = createBm({
        adapter: createGoogleAdsAdapter({ clientId: 'ca-pub-123456789', testMode: true }),
        policy: { interstitialCooldownMs: 90000, rewardedPerSession: 5 },
    });
    BM.on('adstart', () => { AUDIO.mute(); SIM.pause(); });
    BM.on('adend', () => { AUDIO.unmute(); SIM.resume(); });
    await BM.preload('entry'); // 화면이 뜰 때 미리 한 번

    startButton.onclick = async () => {
        const RESULT = await BM.showRewarded('entry');
        if (RESULT.status === 'rewarded') {
            startRun();
        }
    };

소리와 시뮬레이션 정지는 모듈이 소유하지 않습니다. `adstart`/`adend`에서 게임이 `audio`, `simloop`을 직접 다룹니다.

## 결과

`showRewarded`/`showInterstitial`은 항상 `{ status, type, placement, reason?, error? }`로 끝나며 던지지 않습니다.

| status        | 뜻                                     | 보상 지급 |
| ------------- | -------------------------------------- | --------- |
| `rewarded`    | 보상형 광고를 끝까지 봄                | 예        |
| `viewed`      | 전면 광고가 나옴                       | -         |
| `dismissed`   | 광고를 중간에 닫음                     | 아니오    |
| `unavailable` | 지금 보여 줄 광고가 없음               | 아니오    |
| `blocked`     | 정책이나 상태 때문에 요청하지 않음     | 아니오    |
| `error`       | 어댑터 오류·시간 초과·계약에 없는 결과 | 아니오    |

`blocked`의 `reason`은 `busy`, `session-cap`, `cooldown`, `no-user-activation`, `disposed`입니다. 같은 시간에 광고는 하나만 열립니다.

## 정책

- 전면 광고는 마지막 광고가 끝난 뒤 `interstitialCooldownMs`(기본 60초) 동안 막습니다. 보상형은 쿨다운이 없습니다. 사용자가 직접 요청한 광고이기 때문입니다.
- `interstitialPerSession`, `rewardedPerSession`(기본 Infinity)은 실제로 화면에 나온 광고(`rewarded`/`viewed`/`dismissed`)만 셉니다. `unavailable`, `error`는 세지 않습니다.
- `canShow(type)`은 정책만 `{ ok, reason?, retryAfterMs? }`로 알려 줍니다. 버튼 표시·비활성화에 씁니다.
- 광고마다 사용자의 입력이 필요합니다. 기본적으로 `navigator.userActivation.isActive`가 거짓이면 `blocked`/`no-user-activation`으로 막아 자동 재생을 코드로 차단합니다. 이 API가 없는 브라우저는 막지 않습니다. 버튼 문구가 광고임을 알리는 일은 게임이 합니다.
- 어댑터가 `showTimeoutMs`(기본 120초) 안에 끝나지 않으면 `error`로 잠금을 풉니다. 늦게 도착한 결과는 무시합니다.

## 어댑터 계약

    {
        id: 'google-ads',
        load(placement, type) { /* Promise<boolean> 준비 여부 */ },
        show(placement, type) {
            /* Promise<결과>
               rewarded:     'rewarded' | 'dismissed' | 'unavailable' | 'error'
               interstitial: 'viewed'   | 'dismissed' | 'unavailable' | 'error' */
        },
        dispose() {}, // 선택
    }

`show`가 거부(reject)되면 `error`로 바뀝니다. 계약에 없는 결과도 `error`/`invalid-outcome`입니다. 새 광고사는 이 계약을 구현하는 `adapters/<이름>/` 폴더(index.js, README.md)와 `project/distribution.mjs`·`project/build.mjs`의 등록을 더합니다.

## 범위 밖

결제·상품, 광고 시청을 근거로 한 서버 보상 확정은 포함하지 않습니다. 브라우저 SDK의 시청 콜백은 서버가 믿을 수 없는 신호이므로, 가치가 걸린 보상은 서버 검증이 있는 경로로 따로 설계해야 합니다.

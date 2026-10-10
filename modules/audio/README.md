# audio

실제 필요가 생긴 게임의 짧은 효과음을 위한 독립 Web Audio ESM입니다. AudioPlayer는 오디오 자원·음량·재생 예산을 소유하고, 게임은 음형·이벤트·강도를 소유합니다. 배경 음악·전투 규칙·rollback history·파일 fetch/decode는 넣지 않습니다.

## 시작과 수명

`new AudioPlayer(config)`는 AudioContext를 만들거나 소리를 재생하지 않습니다. 실제 pointer/keyboard 제스처에서 `await player.unlock()` 후 true와 `snapshot().state === 'running'`을 확인합니다. 기본 DOM 제스처 구독은 같은 context를 생성/재개하며, 없는 API·브라우저 잠금·실패는 false입니다. 잠긴 동안의 이벤트는 버리고 나중에 몰아서 재생하지 않습니다.

문서가 숨겨지면 소스를 종료하고 context를 suspend합니다. interrupted/suspended 상태에서도 활성 자원을 종료합니다. 돌아온 뒤 다음 제스처가 같은 context를 resume합니다. 실제 iOS/Android 기기의 정책은 별도 확인이 필요합니다. `dispose()`는 구독·노드·등록 버퍼·context를 해제하며 반복 호출할 수 있습니다. dispose한 player를 다시 쓰지 말고 새 세션에서 새 player를 만듭니다.

`config`는 audioDefaults와 합쳐집니다. 공개 지속시간은 ms이며 Web Audio의 seconds 경계에서만 변환합니다.

- `sounds`: `{id:{category,layers,priority?,gapMs?}}`. layer는 tone `{kind:'tone',hz,end,ms,gain,type,delay?}`, noise `{kind:'noise',hz,ms,gain,delay?}`, 또는 재사용 AudioBuffer `{kind:'buffer',bufferId,ms,gain,delay?}`입니다. tone type은 sine/triangle/square/sawtooth입니다.
- `categories`: `{name:{volume,max,gapMs,priority}}`. 짧은 category 중복 제한과 category/global voice 상한은 소리만 제한하며 게임 피해·입력·journal identity를 합치지 않습니다. 상한에서 더 높은 priority가 낮은 소리를 종료합니다. 같은 priority는 새 소리를 버립니다.
- `maxVoices` 기본 12, `headroom` .24, `volume` .7. one-shot 하나를 하나의 voice로 세며 그 안의 layer 수는 게임이 정합니다. compressor는 hard limiter가 아닙니다. 게임이 layer gain·밀집 peak를 측정하고 headroom을 남겨야 합니다.
- `synthesis`: attackMs/releaseTailMs/sourceTailMs/noiseMs/minGain/minHz. 한 노이즈 AudioBuffer를 재사용하고 짧은 source와 envelope gain만 만듭니다. ended에서 source/filter/gain을 disconnect합니다.
- `compressor`: threshold/knee/ratio/attackMs/releaseMs. 한 compressor/master mix를 재사용합니다.
- `storageKey`는 기본 null. 지정하면 master volume/mute와 알려진 category volume만 해당 로컬 키에 보관합니다. 다른 게임 진행 저장은 소유하지 않습니다.

`play(id,strength=1)`은 실제 source를 시작했을 때만 true입니다. `start(id,strength=1,onEnded?)`는 stoppable handle 또는 null입니다. 무음/volume 0/잠김/제한/정의 없음은 재생으로 집계하지 않습니다. `setBuffer(id,AudioBuffer)`는 소비자가 로드하거나 만든 버퍼의 참조를 재사용하며 그 데이터는 복사하지 않습니다. `setVolume`, `setMuted`, `setCategoryVolume`은 사용자 조절 경로입니다.

`snapshot()`은 context 상태·활성/최대 voice·played/dropped/blocked·sound별 시작 횟수·설정을 반환합니다. `meter()`는 요청할 때만 analyser의 peak/RMS를 읽으며 프레임별 진단 루프를 만들지 않습니다. analyser 비영 출력은 실제 그래프 샘플의 증거이며 스피커 청취·기기 볼륨·주관적 타격감의 증거는 아닙니다.

## 표현 journal과 조합

`player.createAdapter({onEnded?})`는 presentation-events의 `{start,stop,reversible:false}` adapter입니다. payload는 `{soundId,strength?}`이고 one-shot은 기존 journal의 **confirmed** 정책을 사용합니다. speculative를 요청하면 거부합니다. 모듈에 두 번째 identity/tick/rollback history는 없습니다.

소비자가 `onEnded:event => journal.finish(event)`를 연결해 자연 종료 시 자원을 해제합니다. replay seek/새 세션은 journal과 player를 dispose합니다. 확인 후 브라우저가 잠겨 소리를 시작하지 못하면 null로 끝나며 오래된 소리를 재생 큐에 쌓지 않습니다. 바운코 같은 단일 게임은 journal 없이 `player.play()`를 바로 사용할 수 있습니다.

## 예제·실제 검증

[실행 예제](./examples/index.html)는 unlock, 직접 재생, confirmed 재생, 밀집 소리, volume/mute를 보여줍니다. `npm run test:audio`는 저장소의 동일한 180초 상한 실행기에서 이 고정 사용자 흐름을 실제 Chromium/Windows Edge로 확인합니다. 같은 실제 graph builder를 OfflineAudioContext로 렌더해 유한 샘플·peak/RMS·밀집 출력·buffer 재사용을 구분합니다. 생성 dist/audio.js는 기존 main→dist CI 목록에 포함되며 소스 커밋에는 넣지 않습니다.

공식 경계: [Web Audio best practices](https://developer.mozilla.org/en-US/docs/Web/API/Web_Audio_API/Best_practices), [AudioBufferSourceNode](https://developer.mozilla.org/en-US/docs/Web/API/AudioBufferSourceNode), [OfflineAudioContext](https://developer.mozilla.org/en-US/docs/Web/API/OfflineAudioContext/startRendering), [AnalyserNode](https://developer.mozilla.org/en-US/docs/Web/API/AnalyserNode/getFloatTimeDomainData).

# debug-tools

로컬 진단과 SDK replay adapter만 제공합니다. 네트워크·telemetry·storage·자동 저장파일 수집·시뮬레이션 history를 만들지 않습니다.

TypeScript 공개 선언은 [index.d.ts](./index.d.ts)에 있습니다.

- `DiagnosticRing({capacity=20,now=()=>performance.now(),release=''})`: 고정 배열 진단 ring입니다. `report(error,{kind,visibility,fatal,origin,...})`, `snapshot()`, `format()`, `clear()`, `dispose()`를 제공합니다. 기본 문자열·stack만 기록하며 arbitrary object는 직렬화하지 않습니다.
  - `visibility`는 `log | notice | blocking | fatal` 중 하나입니다. 생략하면 기존 report 호출과의 호환을 위해 `blocking`이며, `fatal: true`는 항상 `fatal`로 분류합니다. `visibility: 'fatal'`도 기존 소비자가 보는 `record.fatal: true`를 설정합니다.
  - 네 분류는 모두 ring에 기록됩니다. snapshot v2의 `counts.total`은 수락된 report 수(밀려난 record 포함), `counts.retained`와 `counts.log/notice/blocking/fatal`은 ring에 남은 report 수(동일 진단의 `count` 포함)입니다. `blockerCount`는 retained `blocking + fatal` 수로, `log`와 `notice`는 포함하지 않습니다. 기존 `total`, `dropped`, `errors` 키와 각 record의 `fatal`은 유지됩니다. `dropped`는 용량 초과로 밀려난 record와 재진입으로 기록을 버린 수입니다.
  - 분류와 카운트는 진단 데이터만 제공합니다. badge·패널 표시와 gameplay 중단은 소비자가 결정하며 `log`/`notice`를 자동으로 숨기거나 `fatal`에서 자동 정지하지 않습니다.
- `installGlobal(eventTarget,{onReport?}) → cleanup`: error/unhandledrejection listener만 추가합니다. 기존 onerror를 덮어쓰거나 preventDefault 하지 않습니다. fatal 상태에서 게임을 정지할지는 게임이 결정합니다. cleanup/dispose가 listener를 제거합니다.
- `redactDiagnostic(text,limit=1600)`: URL/로컬 경로/email/token/password 키를 best-effort 마스킹합니다. 완전한 개인정보 제거 보증이 아니므로 공유 전 사용자가 내용을 확인해야 합니다. 외부 전송은 하지 않습니다.
- `await copyDiagnostic(text,{clipboard,textarea})`: clipboard 성공은 copied:true. 거절되면 supplied textarea 선택 또는 portable text를 반환하며 copied:false입니다. DOM을 숨기거나 자동 다운로드하지 않습니다. UI 경합/패널의 focus 정책은 caller가 소유합니다.
- `ReplayTimeline({read,seek,setPlaying})`: read는 `{tick,firstTick,lastTick,playing}`을 반환합니다. readInto(out), seek(tick), step(delta=1), setPlaying(boolean)이 실제 SDK replay adapter에 위임합니다. bounds clamp만 하고 snapshot/history를 저장하지 않습니다.
- `compareStateFields(left,right,[{name,read,equal?}],{maxDifferences=100})`: 선택한 primitive 필드만 비교·마스킹합니다. 기본 Object.is, 구조화 값은 명시적 comparator가 필요합니다. 반환은 equal/mismatches/truncated/differences입니다. 완전한 state hash는 SDK 결정론 도구를 쓰세요.
- `PerformanceProfiler({capacity=120,now,maxStages=64})`: **opt-in** 로컬 프레임 프로파일러입니다. `setEnabled(true)` 뒤 `beginFrame(meta)`, `stage(name,durationMs,metadata)`, `count(name,value)`, `measure(name,fn,metadata)`, `endFrame(meta)`를 사용합니다. `snapshot({limit=30})`은 최근 bounded samples와 frame/stage p50·p95·max 요약을 반환합니다. 고정 ring으로 최근 capacity 프레임을 시간순 반환하며, limit는 반환 sample 수만 제한합니다. `limit:0`은 빈 frames와 전체 retained 요약을 반환합니다. maxStages는 한 프레임의 stage 이름과 counter 이름을 각각 제한하며, 한도에 도달하면 새 이름은 false를 반환하고 기존 이름 누적은 계속합니다. 요약은 값 배열을 한 번 정렬하여 p50/p95를 함께 구합니다. metadata는 redacted primitive 최대 8개만 허용하며 게임 상태·snapshot·DOM·네트워크 payload를 보관하지 않습니다. 꺼져 있을 때 `measure`는 clock을 읽지 않고 operation만 실행합니다. 게임은 실제 구간 이름을 소유하고, renderer는 필요할 때 이 plain hook을 선택적으로 연결합니다.

Budmori의 local diagnostic bootstrap에서 입증된 오류 redaction/ring/copy-fallback 동작과 Rally replay-control 경계를 참고해 새로 작성했습니다. 기존 게임의 저장 정책·fatal UI를 가져오지 않습니다. 원본에 없는 라이선스를 새로 부여하지 않습니다.

report context의 source/line/column/workerTimeMs/cause도 제한된 generic metadata로 지원합니다. source/cause는 redaction, 위치는 비음수 safe integer, worker 시간은 유한 비음수로만 저장합니다.

CPU·보유 heap의 전후 비교와 재현 명령은 [비용 측정](./docs/cost-measurement.md)에 있습니다.

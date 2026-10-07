# debug-tools

로컬 진단과 SDK replay adapter만 제공합니다. 네트워크·telemetry·storage·자동 저장파일 수집·시뮬레이션 history를 만들지 않습니다.

- `DiagnosticRing({capacity=20,now=()=>performance.now(),release=''})`: 고정 배열 오류 ring, 동일 오류 집계, report(error,{kind,fatal,origin}), snapshot(), format(), clear(), dispose(). 기본 문자열·stack만 기록하며 arbitrary object는 직렬화하지 않습니다. dropped와 total을 보고합니다.
- `installGlobal(eventTarget,{onReport?}) → cleanup`: error/unhandledrejection listener만 추가합니다. 기존 onerror를 덮어쓰거나 preventDefault 하지 않습니다. fatal 상태에서 게임을 정지할지는 게임이 결정합니다. cleanup/dispose가 listener를 제거합니다.
- `redactDiagnostic(text,limit=1600)`: URL/로컬 경로/email/token/password 키를 best-effort 마스킹합니다. 완전한 개인정보 제거 보증이 아니므로 공유 전 사용자가 내용을 확인해야 합니다. 외부 전송은 하지 않습니다.
- `await copyDiagnostic(text,{clipboard,textarea})`: clipboard 성공은 copied:true. 거절되면 supplied textarea 선택 또는 portable text를 반환하며 copied:false입니다. DOM을 숨기거나 자동 다운로드하지 않습니다. UI 경합/패널의 focus 정책은 caller가 소유합니다.
- `ReplayTimeline({read,seek,setPlaying})`: read는 `{tick,firstTick,lastTick,playing}`을 반환합니다. readInto(out), seek(tick), step(delta=1), setPlaying(boolean)이 실제 SDK replay adapter에 위임합니다. bounds clamp만 하고 snapshot/history를 저장하지 않습니다.
- `compareStateFields(left,right,[{name,read,equal?}],{maxDifferences=100})`: 선택한 primitive 필드만 비교·마스킹합니다. 기본 Object.is, 구조화 값은 명시적 comparator가 필요합니다. 반환은 equal/mismatches/truncated/differences입니다. 완전한 state hash는 SDK 결정론 도구를 쓰세요.

Budmori의 local diagnostic bootstrap에서 입증된 오류 redaction/ring/copy-fallback 동작과 Rally replay-control 경계를 참고해 새로 작성했습니다. 기존 게임의 저장 정책·fatal UI를 가져오지 않습니다. 원본에 없는 라이선스를 새로 부여하지 않습니다.

report context의 source/line/column/workerTimeMs/cause도 제한된 generic metadata로 지원합니다. source/cause는 redaction, 위치는 비음수 safe integer, worker 시간은 유한 비음수로만 저장합니다.

# bloom-gamekit

**New SVG vector asset example:** [vector-assets](https://htmlpreview.github.io/?https://github.com/byh-playground/bloom-gamekit/blob/previews/vector-assets.html)

**HTML ���� ������:** [interpolation](https://htmlpreview.github.io/?https://github.com/byh-playground/bloom-gamekit/blob/previews/interpolation.html) �� [interpolation-frame](https://htmlpreview.github.io/?https://github.com/byh-playground/bloom-gamekit/blob/previews/interpolation-frame.html) �� [simloop-input-preview](https://htmlpreview.github.io/?https://github.com/byh-playground/bloom-gamekit/blob/previews/simloop-input-preview.html) �� [audio](https://htmlpreview.github.io/?https://github.com/byh-playground/bloom-gamekit/blob/previews/audio.html) �� [navigation](https://htmlpreview.github.io/?https://github.com/byh-playground/bloom-gamekit/blob/previews/navigation.html) �� [rendering-vector](https://htmlpreview.github.io/?https://github.com/byh-playground/bloom-gamekit/blob/previews/rendering-vector.html) �� [rollback-availability](https://htmlpreview.github.io/?https://github.com/byh-playground/bloom-gamekit/blob/previews/rollback-availability.html) �� [rollback-reference](https://htmlpreview.github.io/?https://github.com/byh-playground/bloom-gamekit/blob/previews/rollback-reference.html) �� [scenario](https://htmlpreview.github.io/?https://github.com/byh-playground/bloom-gamekit/blob/previews/scenario.html)

������ ���ӿ��� �������� ���� ���������������Է¡����ࡤ�����С����ۡ����÷��̡��ѹ� ����� ���� ���� �����ϴ� ������Դϴ�. �ʿ��� ��ɸ� ��� �����ϸ�, ���� ��ü�� �����ϴ� ���� ���� Ŭ������ ������ �ʽ��ϴ�.

**��� ���� ����� �������� plain JavaScript ESM�Դϴ�.** �Һ��ڴ� �ʿ��� ���ϸ� �������� �ܺ� import�� ���� chunk�� �䱸���� �ʽ��ϴ�. ������ pose, WebGL renderer/device�� GPU ���⡤�ڿ�, input�� ��ġ �̺�Ʈ/action, simloop�� ���� ������, camera�� �������浹 boom �Ÿ� ǥ��, presentation-events�� ǥ�� �ڿ�, hud�� ȭ�� anchor, debug-tools�� ����, audio�� ���� ����� �ڿ��� ��� ������ �����մϴ�. �����С����ۡ����÷��̡�rollback�� ���� SDK ������ å�Ӻ��� �и�������, ���� �� ���� �̷��� SDK ��ó ������ ������ ����մϴ�.

## �����ϱ�

- [�ؽ� ȭ��� ������ �̷�](./modules/navigation/README.md) �� [�ݸ� �ó����� ���](./modules/scenario/README.md) �� `npm run test:execution`

- [���� API���ð��������ֱ� ���](./modules/interpolation/README.md)
- [WebGL 1 ������ API��texture�������ֱ�](./modules/rendering/README.md)
- [Web Audio �����������confirmed SFX adapter](./modules/audio/README.md) �� [���� �ռ������ ����](./modules/audio/examples/index.html) �� `npm run test:audio`
- [�Է� action��DOM��tick �Һ� ���](./modules/input/README.md)
- [���� ����� ������ detached local input preview](./modules/simloop/README.md) �� [ī�޶�ǥ�� �̺�Ʈ](./modules/presentation-events/README.md) �� [HUD](./modules/hud/README.md) �� [����](./modules/debug-tools/README.md) �� [ī�޶�](./modules/camera/README.md)
- [���� �桤���� ���塤���ΰ�ħ ����](./modules/rollback/README.md) �� [Nostr ���͸�������](./modules/transport/README.md)
- [SDK ��ü/�и� API�� ����](./modules/rollback/docs/api-migration.md)
- [��Ȱ�� �����ڡ����뼺 ��å���ڵ� coordinator �̰�](./modules/rollback/README.md#��Ȱ��-�����ڿ�-������-���뼺) �� [���� deadline pump ����](./modules/rollback/examples/availability/index.html)
- [���� ���� ������ �����ϴ� ���� ����](./modules/interpolation/examples/index.html) �� [detached �Է� preview ����](./modules/simloop/examples/input-preview/index.html) �� [WebGL ���͡��ؽ�Ʈ���׷� �ռ� ����](./modules/rendering/examples/vector/index.html)
- [���� ������ E2E](./project/tests/browser.e2e.mjs) �� [���� ���� ��ġ��ũ](./modules/interpolation/scripts/benchmark.mjs)

```text
modules/<module>/*.js              ���� ��� runtime �ҽ�
modules/<module>/README.md         API����롤����
modules/<module>/{docs,examples,tests,scripts}/  �ش� ��� ���� �ڷ�
modules/_rollback-shared/          rollback �迭�� ���� ���� ������SDK ���� ���� ����
modules/rollback/docs/provenance/  ���� zip��manifest����ó
project/                         ����� ���� ���塤������������ ����
project/{tests,docs,benchmarks}/  ���� ���������� ���
.github/workflows/ci.yml           PR �˻� / main��dist���Һ� �±ס�previews
```

���� ������ `npm ci`, `npm test`, `npm run test:browser`�Դϴ�. ������ ù ��ġ�� `npx playwright install chromium`�Դϴ�. �ҽ����������˻硤������������ ����� ������ ��⿡ �Բ� �Ӵϴ�. ����� ���� �ڷ�� project �Ʒ��� ������ ��Ʈ�� docs/scripts/tests/examples�� ���� �ʽ��ϴ�. `rollback`�� ���ǰ� ���� ����, `transport`�� RTC/discovery �˻縦 �����մϴ�. ���� ���� �������� �����ϴ�.

���� ��å ������ [���� ������Ʈ ���� ��Ģ ��13](https://github.com/byh-playground/bloom-reference/blob/main/rules/project-management.html#verification)�Դϴ�. `npm test`�� ���� DOM �Է� �� �ù� �� ǥ�� �� �� WebGL��HUD�������� ���� �ó������� �����մϴ�. `npm run test:network`�� RTC���� �����ֱ�, `npm run test:availability`�� ���뼺�����͡����� �ó������Դϴ�. `npm run test:scenarios`�� build �� ���� �ó������� �ִ� �� ���� �����ϰ� ������� �����մϴ�. �� ���� ��ü ������ 180���̸� �ʰ��ϰų� �� ��ΰ� �����ϸ� ���� �ڽ� ���μ����� �����ϰ� �����մϴ�. ���� �� ���� ���� ������ �Ϸ� �� �����ϰ� ���� ���ο� ���� ȸ�� ������ �������� �ʽ��ϴ�. CPU���Ҵ� ������ `benchmark:interpolation`, `benchmark:presentation`, ���� SDK benchmark �������� ���� �����մϴ�.

��Ʈ package.json�� ���� ������ �����ϸ� ��⺰ ������workspace��npm ������ ���� �������� �ʾҽ��ϴ�.

## GitHub ���� ����

PR������ �ҽ� ���� checkout, ���� ��� build, ���� manifest, bundle bytes�� ���� ����� font assets�� Ȯ���մϴ�. main�� ���ε� ������ ������ GitHub Actions�� ���� build ����� Ȯ���� �� `dist` �귣ġ�� ���� 15�� JavaScript ����, `manifest.json`, ���õ� font assets�� �ڵ� �����մϴ�. modules/assets�� ��Ȯ�� ��ϰ� �ڻ� ���� project/distribution.mjs�� ���� manifest�� �����մϴ�. ���� JS�� asset ���纻�� �ҽ� Ŀ�Կ� ���� �ʽ��ϴ�. ���� Node��Chromium E2E�� benchmark�� ���� ���� �������� �����ϸ� �ڵ� ���� ��ο� �������� �ʽ��ϴ�. ǥ�� `ubuntu-latest`�� ����ϸ� ���� runner��artifact ���塤Release��npm��Pages�� ���� �ʽ��ϴ�. HTML Preview�� ���� HTML�� ���� CI �������� ���� previews �귣ġ�� �����մϴ�.

main ������ �����ϸ� [interpolation.js](https://github.com/byh-playground/bloom-gamekit/blob/dist/interpolation.js), [rendering.js](https://github.com/byh-playground/bloom-gamekit/blob/dist/rendering.js), [input.js](https://github.com/byh-playground/bloom-gamekit/blob/dist/input.js), [hash manifest](https://github.com/byh-playground/bloom-gamekit/blob/dist/manifest.json)���� ������ ������ �� �ֽ��ϴ�. GitHub Raw URL�� JS MIME/CORS�� �����ϴ� �� ȣ���� ����� �ƴϹǷ� �������� ���� import �ּҷ� �������� ������. **CORS-enabled font assets**�� `https://cdn.jsdelivr.net/gh/byh-playground/bloom-gamekit@<dist-commit>/assets/fonts/<file>`ó�� ��Ȯ�� ���� dist commit�� ������ �������� manifest�� byte length/SHA-256�� �����մϴ�. ��Ȯ�� �Һ� ���� �±� �Ǵ� dist commit SHA�� ����ϰ� branch-latest �ּҴ� ������� ������. dist Ŀ�� �޽����� source commit�� manifest�� bundle/asset SHA-256 �� asset byte length�� ��ϵ˴ϴ�. �˻� job�� manifest hash�� ���� ���� ��� ����� ������ �����մϴ�. ���� dist�� �ٸ� ������ �����ϰ�, stale main ������ �ǳʶٸ� ���� �� non-fast-forward�� �ߴ��մϴ�. �귣ġ �Խ��� ���� ������ main ���� �� ������ Ȯ���ؾ� �մϴ�.

�ڼ��� [������������������ ���](./project/docs/releases.md)�� [���� �˻� ����](./project/docs/verification.md)�� �����ϼ���.

## ���� ���� ��Ģ

- **����ȭ�� ����, ��̰� �״����Դϴ�.** ��귮��ȣ�� �󵵡��Ҵ硤�޸𸮡��ʱ� �ε���ƽ������ ����� �Բ� �Ǵ��մϴ�. ����� �ٸ� �������� �ű� ���� �����ߴٰ� ������� �ʽ��ϴ�. ����� ������ �����ϰ� ���� ȸ�͸� ������ �ʽ��ϴ�.
- **Is-a:** �� ��ü�� �����̸� � å���� ������ ���� ��ü������ �����մϴ�.
- **Has-a:** �ʿ��� capability�� ��å�� �����մϴ�. ��� �߰��� ���� �Ŵ��� ���� Ŭ������ �帣�� ��� ü�踦 ������ �ʽ��ϴ�.
- **Can-be:** ���ࡤ��⡤���������� ���� �ش� �������� ���¿� ��å���� �ٷ�ϴ�. ���� ����� ������ ��Ȳ���� �������� �ʽ��ϴ�.
- �뷱�������ӽð���ǥ�� �ѵ������� ��å�� Definition �Ǵ� ������ ������ �������� ����ϴ�. ���� ��Ģ�� ���� �Լ��� ���ǹ��� ����� �������� �ʽ��ϴ�.
- ���ӽð��� �ð��� ���� ������ **�и���(ms)**�Դϴ�. �ùķ��̼� tick�� �Է� sequence�� �ð��� �����Դϴ�. �ܺ� API�� ������ �ٸ��� ��迡�� ���������� ��ȯ�ϸ�, TPS�� �ٲ㵵 ���� ���ӽð��� �޶����� �ʾƾ� �մϴ�.
- �Է� �� �������� �ùķ��̼� �� ǥ���� �������� �и��մϴ�. ���� pose������ ĳ�á�ī�޶�����Ʈ�� ���� ���¸� �籸���ϰų� ����� �ʽ��ϴ�.
- ��Ű���� �ٸ� ��Ű���� ���� ���¸� ���� �ʽ��ϴ�. �ʿ��� �����Ϳ� ������ ���� ������� �����ϸ�, ��� �ϳ��� ����Ϸ��� ������ ��Ű���� �ʱ�ȭ�ϰ� ������ �ʽ��ϴ�.

## rollback SDK ������ ���� ���

���� [rollback-netcode ���� snapshot](modules/rollback/docs/provenance/README.md)�� ������ �ҽ��� �� ����ҷ� å�Ӻ� �����߽��ϴ�. [���� API����ó������ ���](./modules/rollback/docs/api-migration.md)�� �����ϼ���. ���� ����Ҵ� �����ϸ� �Է� ���������� sequence��tick���������ѹ顤������ ���� �������� �ʽ��ϴ�. `deterministic.js`, `simloop.js`, `transport.js`, `replay.js`, `rollback.js`�� �ʿ��� ��ɺ��� ���� �����ɴϴ�. �и� ��⵵ �ܺ� runtime import�� ������ dist commit SHA�� manifest hash�� �����մϴ�.

������ �ڽ��� Definition����Ģ������ ���¡������� snapshot�� �������� ����͸� �����մϴ�. UI�� AI�� ������ �ൿ�� ���� ���� ��θ� ���� SDK�� ���� tick���� ����˴ϴ�. input ��Ű���� ��� �̺�Ʈ�� ������ ��, ��ü Ÿ�̸ӷ� ������ �����ϰų� ���� ���¸� ���� �������� �ʽ��ϴ�. ��Ŀ�� ��ǰ� �Է� ������ ���� �Է� ��࿡ �����մϴ�.

�������������� �Ϸ�� �ùķ��̼� ����� ǥ���մϴ�. ǥ���� ���� �ð��� SDK�� ���� ���� �ð��� ȥ������ ������, ������ ������ �����Ϸ��� �ùķ��̼� dt�� �ٲ��� �ʽ��ϴ�. ����� �� �Ҹ����˸�������Ʈ�� �ߺ� �߻���Ű�� �ʵ��� ������ ǥ�� �̺�Ʈ ��迡 ����ϴ�.

## ù ���� ������ ����

ù ����� �� snapshot ���Ű� ���� ������ ������ retarget ���Ӽ��Դϴ�. ������ rAF���� �׷ȴ� pose�� �״�� �� ���������� ���� ���� �������� ������ ���� ��� ��ġ�� ��߳� �� �ֽ��ϴ�.

- �� ��ǥ�� ������ **�� �ð��� ���� ���� ��� ���� pose**���� ����� �ֽ� ��ǥ���� �̾�ϴ�. ���Ű� ���� �򰡿��� ���� ���� �ð� ������ ����մϴ�.
- �ʱ� �⺻ ��å�� �� ��ǥ���� **�ùķ��̼� �� ƽ�� �ð�(`1000 / TPS` ms)** ���� �����ϴ� continuous retarget�Դϴ�. ������ ���� 500ms ���۳� �̷� ��ġ �ܻ��� �⺻������ ���� �ʽ��ϴ�.
- �� ��å���� ��ǥ�� ���󰡴� ǥ�� ������ �ֽ��ϴ�. �� ǥ���� �ʾ� ��ǥ�� ���� �����ϸ� �� ��ġ���� ����ϹǷ� ��� ���Ϳ� ������ ���شٰ� �������� �ʽ��ϴ�. ���������ۡ���� ��å�� ������ ������ ����� �巯���ϴ�.
- hitstop�� ���� XYZ�� ���� �̵��ߴٰ� ���� �������� ���ư��� ������� ó������ �ʽ��ϴ�. ǥ�� ������ �簳�� ���� pose���ð� ��å�� ������ �ϸ�, �����̵���spawn/despawn���ѹ� ����ó�� �ҿ����� �ʿ��� ���� ���������� �����մϴ�.
- ���� ������ NavMesh�����������塤ķ���� ��Ģ�� ���� ��Ű���� �������� �ʽ��ϴ�. ���Ӻ��� ���� �ٸ� ���� Ž�� ��å�� �ϳ��� �������� �ʽ��ϴ�.

�� ����� ���� ���� ���� fixture�� �˻��մϴ�. ���� ���� ��ü�� �����ϰų� �� ������ ���͸� �ذ��ߴٴ� ������ �ƴմϴ�.

## ������ ����

ū ���պ� �׽�Ʈ ��Ϻ��� **���� ��Ű���� ���� ��θ� �����ϴ� �ϳ��� ���� E2E**�� �߽����� �����մϴ�. ù ���� �������� ���� ������ snapshot ���� �ð���rAF �ð�����ǥ pose fixture�� ������ ��Ģ�� ����, ���͡�����, retarget, hitstop�� �簳�� ���� �帧���� Ȯ���մϴ�. ������ E2E�� ���� ���� �������� ���� DOM �Է� �� 100ms ���� �ùķ��̼� �� ���� �� WebGL �ȼ��� �����մϴ�. Ű/��ġ edge��UI ���ܡ�blur��DPR��texture/alpha/order��camera��batch ���롤context loss/restore��dispose�� �� ���࿡�� �̾� �˻��մϴ�. �߰��� ���п��� �ʿ��� ���� ȸ�� �˻縸 �߰��մϴ�.

���� �Է¡�seed���Ը𿡼� ���� ���ĸ� ���ϰ�, ���� ��ꡤ�Ҵ硤�޸𸮿� ���� ȭ�� ���� ������ ������ ����մϴ�. CPU ���� ���� �ð��� GPU �Ϸ�ð����� �θ��� �ʽ��ϴ�. ���� ��⡤����������顤���� ������ ����� ª�� �����̳� �� ����� ����� ��ü �������� �Ϲ�ȭ���� �ʽ��ϴ�.

���� �˻糪 ���� ������ ���� ��������WebGL����� �������� ������� �ʽ��ϴ�. ��������С��̽��� ������ �����ϰ�, Ȯ������ ���� ����� Stable �Ǵ� VALIDATED��� ǥ������ �ʽ��ϴ�. ���� ������ ȯ��� Ŀ���� PR ���� ��Ͽ� ����ϴ�. ���� CI�� �ҽ������塤���� �����̸� ������ E2E�� ���� �����Դϴ�.

## ����� �����ϴ� ����

������ ������ 100ms �ùķ��̼� ��Ģ������ �Һ�y-sort��UI ������ �����մϴ�. simloop�� createLoop�� ����/������ ������ �ð� camera��presentation-events��hud��debug-tools�� �����մϴ�. input�� sample�� edge�� ������ ������ ����/SDK�� ������ ������ �� consume�մϴ�. rendering���� interpolation import�� ����, �ϼ��� pose�� ���� ������ body/shadow/health�� �����մϴ�. context ���� �� texture handle�� �����Ǹ� ���� �������� �����ϴ�.

�� ������ �ּ� core�� �ϼ��� ���Դϴ�. terrain/fog������ ��Ʈ��������sprite animation��scenegraph�����Ӻ� ����/geometry��asset loading�� ���� ���� ��Ģ���� �������� �ʾҽ��ϴ�. WebGLDevice�� ���� ������ �����ϴ� shader��geometry�� �޾� �ڿ���buffer��draw ȣ���� �����մϴ�. ���� Budmori/Rally ���ӿ��� ���� �������� �ʾҽ��ϴ�. ���� ������ E2E�� ���� WebGL 1 shader�� �ȼ��� SwiftShader�� �˻��ϹǷ� Canvas2D ���� ������ �ƴ�����, ����ϡ���� GPU FPS ������ �ƴմϴ�. ȭ�� metrics�� ���� draw/vertex/upload count�� ���� interval/CPU ���� �ð��̸� GPU �Ϸ� �ð����� �ؼ����� �ʽ��ϴ�.

## �۾��� ����

�� README�� ��� ������ ������� ���� �����Դϴ�. ���� ���� PR�� ���� ������ ���� Ȯ���ϰ� �ٸ� �۾��� �����մϴ�. ���� ����� ��� ������ ������ `codex/` �۾� �귣ġ���� �����ϰ� `main` ��� PR�� �����մϴ�. ���� ������ ���ϻ� �ƴ϶� �Լ������� �����ڡ����� ��ࡤȣ�� ������ ��ħ�� Ȯ���մϴ�.

���� �۾��� �ǵ�����硤���´� PR ������ �����ϸ� ���� ��ȹ�� ���� ���Ͽ� �������� �ʽ��ϴ�. ���� ������ �߿��� ȸ�� ����, ���� ���� ����� �̰��� ������ ����ϴ�. �ڵ� ���� �Ϸ�� ��Ű�� ���� ������ �����ϰ�, �������� ����� ���� ���� �����ϰų� ���� ������ �������� �ʽ��ϴ�.

������ Ŀ�� �޽����� �ѱ�� �⺻���� �մϴ�. �ĺ��ڡ�API �̸����θ� ���� ��� ���� ���� ǥ�⸦ �����մϴ�.

```text
[Ÿ��] ���� ���� ���

- �ʿ��� ���� ������ ���� ����
```

�⺻ Ÿ���� `[feature]`, `[bug-fix]`, `[refactor]`, `[performance]`, `[docs]`, `[test]`, `[chore]`�̸� ���� ����� `[init]`�� ����մϴ�.

## ����

- [RALLY FRONTIER](https://github.com/byh-playground/rally-frontier): ���ӡ�SDK��ǥ���� ���� ���� �۾� �
- [Budmori.io](https://github.com/byh-playground/budmori-io): ����ȭ �켱, Definition, ms �ð�, ���� ���� E2E ����
- [rollback-netcode ���� ���](modules/rollback/CONTRACT.md): �����С����ɡ�ƽ��snapshot�������� ����

���Ӻ� README�� ���๰ ��������ã�⡤���� ��Ģ�� �� ���ӿ� ����ϴ�. �� ����ҿ��� �Բ� ����� �� �ִ� ���� ��踸 �����ɴϴ�.

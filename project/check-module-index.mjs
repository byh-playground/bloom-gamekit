// 루트 README의 "하려는 일 → 모듈" 표가 modules/ 아래 모든 공개 모듈을 가리키는지, 상대 링크가 실제 파일인지 확인합니다.
// `_`로 시작하는 폴더는 소비자가 직접 쓰지 않는 내부 구현이라 제외합니다.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const README = readFileSync(resolve(ROOT, 'README.md'), 'utf8');
const MODULES = readdirSync(resolve(ROOT, 'modules'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('_'))
    .map((entry) => entry.name);
const FAILURES = [];
for (const NAME of MODULES) {
    if (!README.includes(`](./modules/${NAME}/README.md)`)) {
        FAILURES.push(`루트 README 표에 ${NAME} 링크가 없습니다: [${NAME}](./modules/${NAME}/README.md)`);
    }
}
for (const [, TARGET] of README.matchAll(/\]\((\.\/[^)\s#]+)(?:#[^)\s]*)?\)/g)) {
    if (!existsSync(resolve(ROOT, decodeURI(TARGET)))) {
        FAILURES.push(`루트 README의 링크 대상이 없습니다: ${TARGET}`);
    }
}
if (FAILURES.length) {
    console.error(FAILURES.join('\n'));
    process.exit(1);
}

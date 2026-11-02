// 게임 저장소에서 로컬로 실행하는 모듈 그래프 목록 도구입니다(Node ESM, `dist/boot-build.mjs`).
// 진입 모듈에서 정적 import·export-from과 문자열 리터럴 dynamic import()를 따라가 로컬 파일 목록을 만듭니다.
// 게임은 결과를 runtime manifest에 커밋하고, 브라우저의 `preloadModules`가 같은 URL을 병렬로 미리 읽습니다.
import { readFileSync, statSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// 이 키워드 뒤의 `/`는 나눗셈이 아니라 정규식 시작입니다.
const REGEX_AFTER_WORD = new Set([
    'return',
    'typeof',
    'instanceof',
    'in',
    'of',
    'new',
    'delete',
    'void',
    'throw',
    'case',
    'do',
    'else',
    'yield',
    'await',
]);
const WORD_START = /[A-Za-z_$#\u0080-￿]/;
const WORD_PART = /[\w$\u0080-￿]/;
const SPACE = /\s/;
const EXTERNAL = /^[a-z][a-z\d+.-]*:/i;

function fail(message) {
    throw new Error(`listModuleGraph: ${message}`);
}

// 주석·문자열·template·정규식을 건너뛰는 최소 토큰화입니다. 식별자(w), 문자열(s), 구두점(p), 그 밖의 값(x)만 냅니다.
function tokenize(source, file) {
    const TOKENS = [];
    const BRACES = [];
    let i = source.startsWith('#!') ? source.indexOf('\n') + 1 || source.length : 0;
    const PREVIOUS = () => TOKENS.at(-1);
    const REGEX_ALLOWED = () => {
        const TOKEN = PREVIOUS();
        if (!TOKEN) {
            return true;
        }
        if (TOKEN.t === 'w') {
            return REGEX_AFTER_WORD.has(TOKEN.v);
        }
        return TOKEN.t === 'p' && TOKEN.v !== ')' && TOKEN.v !== ']';
    };
    // 백틱 다음부터 읽고, `${`를 만나면 중괄호 스택에 template을 넣고 토큰화로 돌아갑니다.
    const TEMPLATE = () => {
        while (i < source.length) {
            const CHAR = source[i];
            if (CHAR === '\\') {
                i += 2;
            } else if (CHAR === '`') {
                i++;
                TOKENS.push({ t: 'x' });
                return;
            } else if (CHAR === '$' && source[i + 1] === '{') {
                i += 2;
                BRACES.push('template');
                TOKENS.push({ t: 'p', v: '${' });
                return;
            } else {
                i++;
            }
        }
        fail(`unterminated template literal in ${file}`);
    };
    while (i < source.length) {
        const CHAR = source[i];
        if (SPACE.test(CHAR)) {
            i++;
        } else if (CHAR === '/' && source[i + 1] === '/') {
            const END = source.indexOf('\n', i);
            i = END < 0 ? source.length : END;
        } else if (CHAR === '/' && source[i + 1] === '*') {
            const END = source.indexOf('*/', i + 2);
            if (END < 0) {
                fail(`unterminated comment in ${file}`);
            }
            i = END + 2;
        } else if (CHAR === '"' || CHAR === "'") {
            let value = '';
            i++;
            while (source[i] !== CHAR) {
                if (i >= source.length || source[i] === '\n') {
                    fail(`unterminated string in ${file}`);
                }
                if (source[i] === '\\') {
                    i++;
                }
                value += source[i++];
            }
            i++;
            TOKENS.push({ t: 's', v: value });
        } else if (CHAR === '`') {
            i++;
            TEMPLATE();
        } else if (CHAR === '/' && REGEX_ALLOWED()) {
            let inClass = false;
            i++;
            while (source[i] !== '/' || inClass) {
                if (i >= source.length || source[i] === '\n') {
                    fail(`unterminated regular expression in ${file}`);
                }
                if (source[i] === '\\') {
                    i++;
                } else if (source[i] === '[') {
                    inClass = true;
                } else if (source[i] === ']') {
                    inClass = false;
                }
                i++;
            }
            i++;
            while (i < source.length && WORD_PART.test(source[i])) {
                i++;
            }
            TOKENS.push({ t: 'x' });
        } else if (WORD_START.test(CHAR)) {
            const START = i++;
            while (i < source.length && WORD_PART.test(source[i])) {
                i++;
            }
            TOKENS.push({ t: 'w', v: source.slice(START, i) });
        } else if (/\d/.test(CHAR) || (CHAR === '.' && /\d/.test(source[i + 1]))) {
            while (i < source.length && /[\w.]/.test(source[i])) {
                i++;
            }
            TOKENS.push({ t: 'x' });
        } else if (CHAR === '{') {
            i++;
            BRACES.push('brace');
            TOKENS.push({ t: 'p', v: '{' });
        } else if (CHAR === '}') {
            i++;
            if (BRACES.pop() === 'template') {
                TEMPLATE();
            } else {
                TOKENS.push({ t: 'p', v: '}' });
            }
        } else {
            i++;
            TOKENS.push({ t: 'p', v: CHAR });
        }
    }
    return TOKENS;
}

const IS = (token, type, value) => token?.t === type && (value === undefined || token.v === value);

// 정적 import·export-from과 문자열 리터럴 dynamic import()의 지정자를 소스 순서대로 반환합니다.
function moduleSpecifiers(source, file) {
    const TOKENS = tokenize(source, file);
    const FOUND = [];
    // `from` 다음 문자열을 찾되, 문장이 끝나면 멈춥니다.
    const FROM = (start) => {
        for (let j = start; j < TOKENS.length - 1; j++) {
            if (IS(TOKENS[j], 'p', ';')) {
                return;
            }
            if (IS(TOKENS[j], 'w', 'from') && IS(TOKENS[j + 1], 's')) {
                FOUND.push(TOKENS[j + 1].v);
                return;
            }
        }
    };
    for (let i = 0; i < TOKENS.length; i++) {
        const TOKEN = TOKENS[i],
            NEXT = TOKENS[i + 1];
        // 속성 접근(`x.import`)과 객체 키는 모듈 문법이 아닙니다.
        if (IS(TOKENS[i - 1], 'p', '.') || IS(NEXT, 'p', ':')) {
            continue;
        }
        if (IS(TOKEN, 'w', 'import')) {
            if (IS(NEXT, 'p', '(')) {
                // 계산된 지정자는 빌드 시점에 알 수 없으므로 목록에 넣지 않습니다.
                if (IS(TOKENS[i + 2], 's') && (IS(TOKENS[i + 3], 'p', ')') || IS(TOKENS[i + 3], 'p', ','))) {
                    FOUND.push(TOKENS[i + 2].v);
                }
            } else if (IS(NEXT, 's')) {
                FOUND.push(NEXT.v);
            } else if (!IS(NEXT, 'p', '.')) {
                FROM(i + 1);
            }
        } else if (IS(TOKEN, 'w', 'export') && IS(NEXT, 'p', '*')) {
            FROM(i + 1);
        } else if (IS(TOKEN, 'w', 'export') && IS(NEXT, 'p', '{')) {
            let j = i + 2;
            while (j < TOKENS.length && !IS(TOKENS[j], 'p', '}')) {
                j++;
            }
            if (IS(TOKENS[j + 1], 'w', 'from') && IS(TOKENS[j + 2], 's')) {
                FOUND.push(TOKENS[j + 2].v);
            }
        }
    }
    return FOUND;
}

/**
 * 진입 모듈이 불러오는 로컬 모듈 전체를 root 기준 POSIX 경로로 반환합니다. 진입 모듈이 첫 항목이고, 이후는 진입점에서
 * 가까운 순서(너비 우선)와 각 파일의 import 순서를 따릅니다. 지정자의 query는 브라우저 URL과 같도록 유지합니다.
 * `./`·`../` 지정자만 따라가며, `https:` 같은 절대 URL은 목록에서 뺍니다. 그 밖의 지정자(bare·`/` 시작)와
 * 파일이 없거나 root 밖인 지정자는 던집니다.
 */
export function listModuleGraph({ root, entry, ...rest }) {
    if (Object.keys(rest).length > 0) {
        fail(`unknown option ${Object.keys(rest)[0]}`);
    }
    if (typeof root !== 'string' || typeof entry !== 'string' || !root || !entry) {
        fail('root and entry must be non-empty strings');
    }
    const ROOT = resolve(root);
    const ROOT_URL = pathToFileURL(ROOT + sep);
    const LOCAL = (url, from) => {
        const PATH = fileURLToPath(url);
        const RELATIVE = relative(ROOT, PATH);
        if (!RELATIVE || RELATIVE.startsWith('..') || resolve(ROOT, RELATIVE) !== PATH) {
            fail(`${from} imports a module outside root: ${url.pathname}`);
        }
        let file;
        try {
            file = statSync(PATH).isFile();
        } catch {
            file = false;
        }
        if (!file) {
            fail(`unresolved import in ${from}: ${RELATIVE.split(sep).join('/')}`);
        }
        return RELATIVE.split(sep).join('/') + url.search;
    };
    const FIRST = LOCAL(new URL(entry, ROOT_URL), 'entry');
    const SEEN = new Set([FIRST]);
    const ORDER = [FIRST];
    for (let index = 0; index < ORDER.length; index++) {
        const FILE = ORDER[index];
        const FILE_URL = new URL(FILE, ROOT_URL);
        for (const SPECIFIER of moduleSpecifiers(readFileSync(fileURLToPath(FILE_URL), 'utf8'), FILE)) {
            if (EXTERNAL.test(SPECIFIER)) {
                continue;
            }
            if (!SPECIFIER.startsWith('./') && !SPECIFIER.startsWith('../')) {
                fail(`unsupported specifier in ${FILE}: ${SPECIFIER} (use ./ or ../)`);
            }
            const NEXT = LOCAL(new URL(SPECIFIER, FILE_URL), FILE);
            if (!SEEN.has(NEXT)) {
                SEEN.add(NEXT);
                ORDER.push(NEXT);
            }
        }
    }
    return ORDER;
}

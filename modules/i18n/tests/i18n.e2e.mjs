import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

// 배포물(dist/i18n.js)을 실제 Chromium 페이지에서 불러와, 게임이 쓰는 그대로 언어를 정하고 문구를 그리는 흐름을 확인한다.
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const STARTED = performance.now();
const PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body><h1 data-i18n="title"></h1><button data-i18n="start" data-i18n-aria-label="startLabel"></button>
<script type="module">
import { createLocale } from '/i18n.js';
const ISOLATED = new URLSearchParams(location.search).has('iso');
const LOCALE = createLocale({ locales: ['ko', 'en'], fallback: 'en', storageKey: 'game:locale', isolated: ISOLATED });
const PAGE = LOCALE.messages({
    title: { ko: '발 배구', en: 'Foot Volley' },
    start: { ko: '시작', en: 'Start' },
    startLabel: { ko: '경기 시작', en: 'Start match' },
});
LOCALE.applyPage(document, PAGE);
const CLUB = LOCALE.messages({
    joined: { ko: ({ name }) => name + ' 선수가 팀에 합류했어요.', en: ({ name }) => name + ' joined the team.' },
});
const CAUGHT = (run) => { try { run(); return null; } catch (error) { return error.message; } };
window.__result = {
    locale: LOCALE.locale,
    lang: document.documentElement.lang,
    title: document.querySelector('h1').textContent,
    label: document.querySelector('button').getAttribute('aria-label'),
    joined: CLUB.joined({ name: 'Tae-o' }),
    chapter: LOCALE.text({ ko: '서브', en: 'Serve' }),
    number: LOCALE.number(1234567),
    plural: [1, 2].map((count) => LOCALE.plural(count, { one: 'sprout', other: 'sprouts' })),
    missingPair: CAUGHT(() => LOCALE.messages({ hit: { ko: '타격' } })),
    extraLocale: CAUGHT(() => LOCALE.text({ ko: '타격', en: 'Hit', ja: '打撃' })),
    typo: CAUGHT(() => CLUB.joind({ name: 'x' })),
    pageTypo: CAUGHT(() => {
        const ROOT = document.createElement('div');
        ROOT.innerHTML = '<b data-i18n="titel"></b>';
        LOCALE.applyPage(ROOT, PAGE);
    }),
    saved: localStorage.getItem('game:locale'),
};
window.__choose = (code) => LOCALE.choose(code);
</script></body></html>`;

const SERVER = createServer(async (request, response) => {
    const PATH = new URL(request.url, 'http://local').pathname;
    if (PATH === '/i18n.js') {
        response.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
        response.end(await readFile(resolve(ROOT, 'dist/i18n.js')));
        return;
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(PAGE);
});
let browser;
try {
    await new Promise((done) => SERVER.listen(0, '127.0.0.1', done));
    const ORIGIN = `http://127.0.0.1:${SERVER.address().port}`;
    browser = await chromium.launch();

    async function open(path, { locale = 'ko-KR', saved = null } = {}) {
        const CONTEXT = await browser.newContext({ locale });
        if (saved) {
            await CONTEXT.addInitScript((value) => {
                if (!sessionStorage.getItem('seeded')) {
                    localStorage.setItem('game:locale', value);
                    sessionStorage.setItem('seeded', '1');
                }
            }, saved);
        }
        const PAGE_NOW = await CONTEXT.newPage();
        await PAGE_NOW.goto(ORIGIN + path);
        await PAGE_NOW.waitForFunction(() => window.__result);
        return { context: CONTEXT, page: PAGE_NOW, result: await PAGE_NOW.evaluate(() => window.__result) };
    }

    // 1. 브라우저 언어(ko-KR → ko): 문구·정적 문구·<html lang>·조사가 든 함수 문구가 한국어다.
    let run = await open('/');
    assert.equal(run.result.locale, 'ko');
    assert.equal(run.result.lang, 'ko');
    assert.equal(run.result.title, '발 배구');
    assert.equal(run.result.label, '경기 시작');
    assert.equal(run.result.joined, 'Tae-o 선수가 팀에 합류했어요.');
    assert.equal(run.result.chapter, '서브');
    assert.equal(run.result.number, '1,234,567');
    assert.deepEqual(run.result.plural, ['sprouts', 'sprouts']);
    // 짝 누락·남는 언어·키 오타는 다른 언어나 키 이름으로 대체하지 않고 바로 오류다.
    assert.match(run.result.missingPair, /message hit must define exactly ko, en/);
    assert.match(run.result.extraLocale, /not a text pair of ko, en/);
    assert.match(run.result.typo, /unknown message joind/);
    assert.match(run.result.pageTypo, /unknown message titel/);

    // 2. choose: 저장하고 ?lang=en으로 새로고침한다.
    await Promise.all([run.page.waitForURL(/\?lang=en$/), run.page.evaluate(() => window.__choose('en'))]);
    await run.page.waitForFunction(() => window.__result);
    const CHOSEN = await run.page.evaluate(() => window.__result);
    assert.equal(CHOSEN.locale, 'en');
    assert.equal(CHOSEN.saved, 'en');
    assert.equal(CHOSEN.title, 'Foot Volley');
    assert.equal(CHOSEN.joined, 'Tae-o joined the team.');
    assert.deepEqual(CHOSEN.plural, ['sprout', 'sprouts']);
    // 주소 없이 다시 열어도 저장한 선택을 따른다.
    await run.page.goto(ORIGIN + '/');
    await run.page.waitForFunction(() => window.__result);
    assert.equal(await run.page.evaluate(() => window.__result.locale), 'en');
    await run.context.close();

    // 3. ?lang=이 저장한 선택보다 먼저다.
    run = await open('/?lang=ko', { locale: 'en-US', saved: 'en' });
    assert.equal(run.result.locale, 'ko');
    await run.context.close();

    // 4. 격리 장면: 저장한 선택(en)을 읽지 않고, choose도 저장하지 않는다(주소로만 바뀐다).
    run = await open('/?iso=1', { saved: 'en' });
    assert.equal(run.result.locale, 'ko');
    await Promise.all([run.page.waitForURL(/lang=en/), run.page.evaluate(() => window.__choose('en'))]);
    await run.page.waitForFunction(() => window.__result);
    assert.equal(await run.page.evaluate(() => window.__result.locale), 'en');
    assert.equal(await run.page.evaluate(() => localStorage.getItem('game:locale')), 'en'); // 처음 심은 값 그대로
    await run.page.evaluate(() => localStorage.removeItem('game:locale'));
    await Promise.all([run.page.waitForURL(/lang=ko/), run.page.evaluate(() => window.__choose('ko'))]);
    await run.page.waitForFunction(() => window.__result);
    assert.equal(await run.page.evaluate(() => localStorage.getItem('game:locale')), null);
    await run.context.close();

    // 5. 지원하지 않는 브라우저 언어는 fallback.
    run = await open('/', { locale: 'fr-FR' });
    assert.equal(run.result.locale, 'en');
    await run.context.close();

    console.log(`i18n e2e ok (${Math.round(performance.now() - STARTED)}ms)`);
} finally {
    await browser?.close();
    SERVER.close();
}

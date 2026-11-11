/* global navigationDemo */
import assert from 'node:assert/strict';
export async function navigationFlow(page, base) {
    await page.goto(base + '/modules/navigation/examples/index.html?preview=internal#/wiki');
    await page.waitForFunction(() => window.navigationDemo);
    assert.equal(await page.locator('output').textContent(), 'wiki/?');
    await page.click('#skill');
    assert.equal(new URL(page.url()).hash, '#/tech/iceGarden');
    await page.click('#wiki');
    await page.goBack();
    assert.equal(await page.locator('output').textContent(), 'tech/iceGarden?');
    await page.goForward();
    assert.equal(await page.locator('output').textContent(), 'wiki/?section=rules');
    await page.reload();
    await page.waitForFunction(() => window.navigationDemo);
    assert.equal(await page.locator('output').textContent(), 'wiki/?section=rules');
    await page.click('#main');
    assert.equal(new URL(page.url()).hash, '');
    assert.equal(new URL(page.url()).search, '?preview=internal');
    // 주소창에 모르는 화면을 넣으면 지금 화면(메인)으로 읽히고, 주소는 이력 항목을 늘리지 않고 정규 주소로 고쳐집니다.
    const LENGTH = await page.evaluate(() => history.length);
    await page.evaluate(() => (location.hash = '#/nope'));
    await page.waitForFunction(() => location.hash === '');
    assert.equal(await page.evaluate(() => history.length), LENGTH + 1);
    assert.equal(await page.locator('output').textContent(), 'main/?');
    assert.equal(new URL(page.url()).search, '?preview=internal');
    await page.evaluate(() => {
        navigationDemo.dispose();
        navigationDemo.navigate({
            screen: 'ignored',
        });
    });
    assert.equal(new URL(page.url()).hash, '');
}

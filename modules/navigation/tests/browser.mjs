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
    await page.evaluate(() => {
        navigationDemo.dispose();
        navigationDemo.navigate({
            screen: 'ignored',
        });
    });
    assert.equal(new URL(page.url()).hash, '');
}

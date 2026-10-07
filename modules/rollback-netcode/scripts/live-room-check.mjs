// Optional live integration check: public relays + actual WebRTC, no test signaling server.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { demoPath, resultsDirectory, launchBrowser, serveRepository } from './browser-helpers.mjs';

// 외부 릴레이 상태는 결정론 CI의 통과 조건이 아니다. 명시적으로 선택해야 실행한다.
if (process.env.RUN_LIVE_ROOM_CHECK !== '1') {
  throw new Error('공개 릴레이 검사는 선택 사항입니다. RUN_LIVE_ROOM_CHECK=1로 실행하세요. 서로 다른 네트워크/NAT 검증은 포함하지 않습니다.');
}
let server;
let browser;
let pages = [];
const errors = [];
try {
  if (!process.env.BASE_URL) server = await serveRepository();
  browser = await launchBrowser();
  const contexts = await Promise.all([browser.newContext(), browser.newContext()]);
  pages = await Promise.all(contexts.map(context => context.newPage()));
  pages.forEach((page, index) => page.on('pageerror', error => errors.push({ index, message: error.message })));
  const base = process.env.BASE_URL ?? `http://127.0.0.1:${server.address().port}${demoPath}`;
  await Promise.all(pages.map(page => page.goto(base)));
  await pages[0].selectOption('#mode', 'host'); await pages[0].click('#start');
  const room = await pages[0].locator('#room-display').textContent();
  assert.match(room, /^\d{4}$/);
  await pages[1].selectOption('#mode', 'join'); await pages[1].fill('#room-input', room); await pages[1].click('#start');
  await Promise.all(pages.map(page => page.waitForFunction(() =>
    document.querySelector('#connection-status').dataset.state === 'connected', null, { timeout: 35000 })));
  await pages[0].click('#command-a'); await pages[1].click('#command-b');
  await Promise.all(pages.map(page => page.waitForFunction(() => {
    try { return JSON.parse(document.querySelector('#debug-state').textContent).peers[0]?.commandCount === 2; } catch { return false; }
  }, null, { timeout: 15000 })));
  await pages[0].keyboard.down('ArrowRight'); await pages[0].waitForTimeout(200); await pages[0].keyboard.up('ArrowRight');
  await pages[1].keyboard.down('a'); await pages[1].waitForTimeout(160); await pages[1].keyboard.up('a');
  await Promise.all(pages.map(page => page.click('#release')));
  await pages[0].waitForTimeout(500);
  const reports = await Promise.all(pages.map(page => page.locator('#debug-state').textContent().then(JSON.parse)));
  assert.deepEqual(reports[0].peers[0].positions, reports[1].peers[0].positions);
  assert.deepEqual(reports[0].peers[0].scores, reports[1].peers[0].scores);
  await Promise.all(pages.map(page => page.click('#replay')));
  await Promise.all(pages.map(page => page.waitForFunction(() => document.querySelector('#replay-result').dataset.result === 'matched', null, { timeout: 5000 })));
  assert.deepEqual(errors, []);
  const out = resultsDirectory; await mkdir(out, { recursive: true });
  const report = { passed: true, room, browser: browser.version(), publicSignaling: true,
    actualWebRTC: true, separateContexts: true, differentNetworks: false, reports, errors };
  await writeFile(resolve(out, 'live-room-report.json'), JSON.stringify(report, null, 2));
  await Promise.all(pages.map((page, i) => page.screenshot({ path: resolve(out, `live-room-${i}.png`), fullPage: true })));
  console.log(JSON.stringify({ passed: true, room, positions: reports[0].peers[0].positions,
    scores: reports[0].peers[0].scores, publicSignaling: true, actualWebRTC: true, browser: report.browser }));
  await Promise.all(pages.map(page => page.click('#stop')));
} catch (error) {
  console.error(error.stack);
  const diagnostics = await Promise.all(pages.map(page => page.evaluate(() => ({
    status: document.querySelector('#connection-status')?.textContent,
    error: document.querySelector('#error-log')?.textContent,
    state: document.querySelector('#debug-state')?.textContent,
  })).catch(() => null)));
  const failure = { passed: false, requestedSignaling: 'public Nostr relays', differentNetworks: false, failure: error.message, errors, diagnostics };
  await mkdir(resultsDirectory, { recursive: true });
  await writeFile(resolve(resultsDirectory, 'live-room-failure.json'), JSON.stringify(failure, null, 2));
  console.error(JSON.stringify(failure)); process.exitCode = 1;
} finally { await browser?.close(); if (server) await new Promise(done => server.close(done)); }

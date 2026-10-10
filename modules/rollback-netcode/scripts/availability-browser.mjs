import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..'), errors = [], results = [];
const server = createServer(async (req, res) => { try { const path = resolve(root, '.' + new URL(req.url, 'http://localhost').pathname); if (!path.startsWith(root + sep)) { res.writeHead(403).end(); return; } const data = await readFile(path); res.writeHead(200, { 'content-type': extname(path) === '.html' ? 'text/html' : 'text/javascript', 'cache-control': 'no-store' }).end(data); } catch { res.writeHead(404).end(); } });
await new Promise(ok => server.listen(0, '127.0.0.1', ok));
let browser;
const sleep = ms => new Promise(ok => setTimeout(ok, ms));
async function snapshots(pages) { return Promise.all(pages.map(p => p.evaluate(() => window.snapshot()))); }
async function until(pages, predicate, label, timeout = 18000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const values = await snapshots(pages); if (values.some(s => s.failure)) throw new Error(label + ': ' + JSON.stringify(values)); if (predicate(values)) return values; await sleep(80); }
  throw new Error(label + ' timeout: ' + JSON.stringify(await Promise.all(pages.map(p => p.evaluate(() => window.diagnostics())))));
}
async function room(count, available = true, transfer = false) {
  const context = await browser.newContext(), pages = [], players = ['A', 'B', 'C', 'D'].slice(0, count);
  for (const id of players) { const page = await context.newPage(); page.on('pageerror', e => errors.push(e.message)); await page.goto(`http://127.0.0.1:${server.address().port}/modules/rollback-netcode/tests/availability-browser.html`); await page.waitForFunction(() => typeof window.setup === 'function'); await page.evaluate(({ id, players, available, transfer }) => window.setup(id, players, available, transfer), { id, players, available, transfer }); pages.push(page); }
  for (let a = 0; a < count; a++) for (let b = a + 1; b < count; b++) { const offer = await pages[a].evaluate(id => window.offer(id), players[b]); const answer = await pages[b].evaluate(({ id, offer }) => window.answer(id, offer), { id: players[a], offer }); await pages[a].evaluate(({ id, answer }) => window.accept(id, answer), { id: players[b], answer }); }
  await Promise.all(pages.map(p => p.evaluate(() => window.startPump())));
  await until(pages, values => values.every(s => s.tick >= 15 && s.status === 'running' && s.activePlayers.length === count) && new Set(values.map(s => s.branch)).size === 1, 'initial play');
  return { pages, context, players };
}
async function checkpoint(pages, label) {
  await until(pages, values => values.every(s => s.status === 'running' && s.activePlayers.length === pages.length) && new Set(values.map(s => s.branch)).size === 1, label + ' reconnect ready');
  const values = await snapshots(pages), tick = Math.max(...values.map(s => s.tick)) + 4;
  await Promise.all(pages.map(p => p.evaluate(t => window.setTarget(t), tick)));
  const same = await until(pages, values => values.every(s => s.tick === tick && s.status === 'running'), label);
  assert.equal(new Set(same.map(s => s.hash)).size, 1, label + ' same state'); results.push({ label, tick, hash: same[0].hash, coordinatorId: same[0].coordinatorId });
  await Promise.all(pages.map(p => p.evaluate(() => window.setTarget(Infinity))));
}
async function closeRoom(value) { await Promise.all(value.pages.map(p => p.evaluate(() => window.stop()).catch(() => {}))); await value.context.close(); }
try {
  browser = await chromium.launch({ headless: process.env.AVAILABILITY_HEADED !== '1', ignoreDefaultArgs: ['--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'], ...(process.env.CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.CHROMIUM_EXECUTABLE_PATH } : process.env.BROWSER_CHANNEL ? { channel: process.env.BROWSER_CHANNEL } : {}) });
  const two = await room(2), [host, guest] = two.pages;
  await Promise.all(two.pages.map(p => p.evaluate(() => window.stopRender())));
  const beforeRenderStop = await snapshots(two.pages);
  await sleep(700);
  const afterRenderStop = await snapshots(two.pages);
  afterRenderStop.forEach((s, i) => { assert.ok(s.tick >= beforeRenderStop[i].tick + 6, 'timer/RTC progress with rendering stopped'); assert.equal(s.renderedFrames, beforeRenderStop[i].renderedFrames); });
  results.push({ label: 'render stopped; independent timer and RTC continue', ticks: afterRenderStop.map(s => s.tick), fault: 'explicit rAF cancellation, not browser visibility' });
  await Promise.all(two.pages.map(p => p.evaluate(() => window.resumeRender())));
  const beforeBackground = (await host.evaluate(() => window.snapshot())).tick;
  if (process.env.AVAILABILITY_HEADED === '1') {
    const visibility = await two.context.newCDPSession(guest);
    // Playwright normally forces every page focused/visible, including headed.
    await visibility.send('Emulation.setFocusEmulationEnabled', { enabled: false });
    const { windowId } = await visibility.send('Browser.getWindowForTarget');
    await visibility.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } });
  }
  await host.bringToFront(); await sleep(2100);
  const hidden = await guest.evaluate(() => document.hidden);
  const afterBackground = (await host.evaluate(() => window.snapshot())).tick;
  assert.ok(afterBackground > beforeBackground + 10, 'foreground ticks progress while other tab is background');
  results.push({ label: 'background tab', visibilityStatus: hidden ? 'PASS' : 'environment-blocked', observedHidden: hidden, beforeTick: beforeBackground, afterTick: afterBackground,
    claim: hidden ? 'actual document.hidden; Playwright focus emulation disabled' : 'visibility not observed; hidden-tab coverage is NOT PASS' });
  if (process.env.AVAILABILITY_HEADED === '1') {
    const visibility = await two.context.newCDPSession(guest);
    const { windowId } = await visibility.send('Browser.getWindowForTarget');
    await visibility.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
    await visibility.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  }
  const beforeGuestFreeze = (await host.evaluate(() => window.snapshot())).tick;
  const guestCDP = await two.context.newCDPSession(guest); await guestCDP.send('Emulation.setScriptExecutionDisabled', { value: true });
  await until([host], v => v[0].tick >= beforeGuestFreeze + 10 && v[0].activePlayers.length === 1, 'inactive guest');
  await host.locator('#move').click(); await until([host], v => v[0].state.commands.includes('A:1:7'), 'active input while guest frozen');
  await guestCDP.send('Emulation.setScriptExecutionDisabled', { value: false }); await guest.evaluate(() => window.resumePump()); await checkpoint(two.pages, 'guest resume state');
  const beforeHostFreeze = (await guest.evaluate(() => window.snapshot())).tick;
  const hostCDP = await two.context.newCDPSession(host); await hostCDP.send('Emulation.setScriptExecutionDisabled', { value: true });
  await until([guest], v => v[0].tick >= beforeHostFreeze + 10 && v[0].coordinatorId === 'B', 'inactive coordinator');
  await hostCDP.send('Emulation.setScriptExecutionDisabled', { value: false }); await host.evaluate(() => window.resumePump()); await checkpoint(two.pages, 'coordinator resume follows active guest');
  const heldTick = Math.max(...(await snapshots(two.pages)).map(s=>s.tick))+4;
  await Promise.all(two.pages.map(p=>p.evaluate(t=>window.setTarget(t),heldTick)));
  await until(two.pages,v=>v.every(s=>s.tick===heldTick&&s.status==='running'),'common boundary before room-wide pause');
  await Promise.all(two.pages.map(p=>p.evaluate(()=>window.stopPump()))); await sleep(1900);
  console.log(JSON.stringify({label:'room-wide pause before resume',peers:await Promise.all(two.pages.map(p=>p.evaluate(()=>window.diagnostics())))}));
  await host.evaluate(()=>{window.setTarget(Infinity);window.resumePump();});
  await guest.evaluate(()=>{window.setTarget(Infinity);window.setPulseInterval(1000);});
  await until([host],v=>v[0].tick>=heldTick+10&&v[0].status==='running'&&v[0].activePlayers.length===1,'foreground resume with slow retained voter');
  results.push({label:'room-wide gap; slow voter confirms checkpoint without input',fault:'fixture timer interval 1000ms, not natural browser throttling',diagnostics:await Promise.all(two.pages.map(p=>p.evaluate(()=>window.diagnostics())))});
  await guest.evaluate(()=>{window.setPulseInterval(50);window.resumePump();});
  await checkpoint(two.pages,'room-wide resume state');
  results.push({ label: 'RTC two player', ...(await guest.evaluate(() => window.rtcStats())) }); await closeRoom(two);
  const four = await room(4);
  await Promise.all(four.pages.map((p, i) => p.evaluate(ids => window.block(ids, true), i === 3 ? ['A', 'B', 'C'] : ['D'])));
  const crashAt = Math.max(...(await snapshots(four.pages.slice(0, 3))).map(s => s.tick));
  await until(four.pages.slice(0, 3), v => v.every(s => s.tick > crashAt + 8 && s.activePlayers.length === 3), 'one peer transport interruption');
  await Promise.all(four.pages.map((p, i) => p.evaluate(ids => window.block(ids, false, true), i === 3 ? ['A', 'B', 'C'] : ['D'])));
  await checkpoint(four.pages, 'one peer transport reconnect');
  await Promise.all(four.pages.map((p, i) => p.evaluate(({ ids, blocked }) => window.block(ids, blocked), { ids: i < 2 ? ['C', 'D'] : ['A', 'B'], blocked: true })));
  const splitAt = Math.max(...(await snapshots(four.pages)).map(s => s.tick));
  await until(four.pages, v => v.every(s => s.tick > splitAt + 10 && s.activePlayers.length === 2), '2/2 partition availability');
  await Promise.all(four.pages.map((p, i) => p.evaluate(ids => window.block(ids, false, true), i < 2 ? ['C', 'D'] : ['A', 'B'])));
  await checkpoint(four.pages, 'partition rejoin discards losing branch and stale traffic');
  results.push({ label: 'RTC four player', ...(await four.pages[0].evaluate(() => window.rtcStats())) }); await closeRoom(four);
  const auto = await room(2, true, true);
  await auto.pages[1].evaluate(() => window.pausePumpOnProbe());
  await auto.pages[0].evaluate(() => window.setCost(3));
  await until([auto.pages[1]], v => v[0].probePaused, 'transfer probe received');
  await until([auto.pages[0]], v => v[0].events.some(e=>e.type==='availability-retry'), 'transfer timeout retry');
  const timeoutTick = (await snapshots([auto.pages[0]]))[0].tick;
  await until([auto.pages[0]], v => v[0].tick >= timeoutTick+10 && v[0].activePlayers.length===1, 'active pump continues after interrupted transfer');
  results.push({label:'interrupted transfer checkpoint retry',diagnostic:await auto.pages[0].evaluate(()=>window.diagnostics())});
  await auto.pages[1].evaluate(() => window.resumePump());
  await until(auto.pages, v => v.every(s => s.coordinatorId === 'B'), 'quality coordinator transfer'); await checkpoint(auto.pages, 'automatic transfer checkpoint');
  results.push({ label: 'automatic transfer', observations: (await snapshots(auto.pages)).map(s => ({ coordinatorId: s.coordinatorId, stepMs: s.stepMs })) }); await closeRoom(auto);
  for (const count of [3, 2]) {
    const mismatch = await room(count), initial = (await snapshots(mismatch.pages))[1], boundary = initial.baseTick + 40;
    await Promise.all(mismatch.pages.map(p => p.evaluate(t => window.setTarget(t), boundary)));
    await mismatch.pages[0].evaluate(t => window.corruptAt(t - 1), boundary);
    const expectedBasis = count === 3 ? 'roster-majority' : 'responsive-coordinator';
    const resolved = await until(mismatch.pages, v => v.every(s => s.tick === boundary && s.status === 'running' && s.events.some(e => e.type === 'branch-selected' && e.basis === expectedBasis)) && new Set(v.map(s => s.branch)).size === 1 && new Set(v.map(s => s.hash)).size === 1, 'same tick snapshot ' + expectedBasis);
    assert.equal(resolved[0].state.value, initial.state.value + (boundary - initial.tick) * count + (count === 2 ? 7 : 0), 'majority overrides coordinator, tie follows coordinator');
    results.push({ label: 'same tick snapshot ' + expectedBasis, tick: boundary, value: resolved[0].state.value, hash: resolved[0].hash }); await closeRoom(mismatch);
  }
  const strict = await room(2, false); const strictGuestCDP = await strict.context.newCDPSession(strict.pages[1]);
  await strictGuestCDP.send('Emulation.setScriptExecutionDisabled', { value: true }); await sleep(1000); const held = (await snapshots([strict.pages[0]]))[0].tick;
  await sleep(2100); assert.equal((await snapshots([strict.pages[0]]))[0].tick, held, 'strict holds absent input');
  await strictGuestCDP.send('Emulation.setScriptExecutionDisabled', { value: false }); await strict.pages[1].evaluate(() => window.resumePump()); await checkpoint(strict.pages, 'strict resume regression'); await closeRoom(strict);
  assert.deepEqual(errors, []);
  const report = { passed: true, browser: browser.version(), transport: 'actual Chromium RTCPeerConnection data channels across 2/4 pages; in-process RoomTransport fixture, no public relay/NAT', faults: 'CDP script-execution suspension; explicit timer gap/1000ms interval; pump stops during transfer probe; partition injected at transport send/receive, retained stale packets replayed; not OS suspend', results };
  await mkdir(resolve(root, 'test-results/rollback'), { recursive: true }); await writeFile(resolve(root, 'test-results/rollback/availability-report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
} finally { await browser?.close(); await new Promise(ok => server.close(ok)); }

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
const simulationMode = process.env.ROOM_SIMULATION_MODE ?? 'lockstep';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..'), errors = [], results = [];
const server = createServer(async (req, res) => { try { const url = new URL(req.url, 'http://localhost').pathname;
  const base = process.env.INPUT_BASELINE_DIST && url.startsWith('/dist/') ? resolve(process.env.INPUT_BASELINE_DIST) : root;
  const path = resolve(base, '.' + (base === root ? url : url.slice(5)));
  if (!path.startsWith(base + sep)) { res.writeHead(403).end(); return; } const data = await readFile(path); res.writeHead(200, { 'content-type': extname(path) === '.html' ? 'text/html' : 'text/javascript', 'cache-control': 'no-store' }).end(data); } catch { res.writeHead(404).end(); } });
await new Promise(ok => server.listen(0, '127.0.0.1', ok));
let browser;
const sleep = ms => new Promise(ok => setTimeout(ok, ms));
async function snapshots(pages) { return Promise.all(pages.map(p => p.evaluate(() => window.snapshot()))); }
async function until(pages, predicate, label, timeout = 18000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const values = await snapshots(pages); if (values.some(s => s.failure)) throw new Error(label + ': ' + JSON.stringify(values)); if (predicate(values)) return values; await sleep(80); }
  throw new Error(label + ' timeout: ' + JSON.stringify(await Promise.all(pages.map(p => p.evaluate(() => window.diagnostics())))));
}
async function room(count, available = true, transfer = false, cooperative = false, rates = null) {
  const context = await browser.newContext(), contexts=[context], pages = [], players = ['A', 'B', 'C', 'D'].slice(0, count);
  for (const id of players) { const owner = rates?.remote && pages.length ? await browser.newContext() : context; if(owner!==context)contexts.push(owner); const page = await owner.newPage(); page.on('pageerror', e => errors.push(e.message)); await page.goto(`http://127.0.0.1:${server.address().port}/modules/rollback-netcode/tests/availability-browser.html`); await page.waitForFunction(() => typeof window.setup === 'function'); if(rates?.remote){const cdp=await owner.newCDPSession(page);await cdp.send('Emulation.setFocusEmulationEnabled',{enabled:true});} await page.evaluate(({ id, players, available, transfer, cooperative, simulationMode, rates }) => rates ? window.setupLatency(id, players, rates) : window.setup(id, players, available, transfer, cooperative, simulationMode), { id, players, available, transfer, cooperative, simulationMode, rates }); pages.push(page); }
  for (let a = 0; a < count; a++) for (let b = a + 1; b < count; b++) { const offer = await pages[a].evaluate(id => window.offer(id), players[b]); const answer = await pages[b].evaluate(({ id, offer }) => window.answer(id, offer), { id: players[a], offer }); await pages[a].evaluate(({ id, answer }) => window.accept(id, answer), { id: players[b], answer }); }
  await Promise.all(pages.map(p => p.evaluate(() => window.startPump())));
  await until(pages, values => values.every(s => s.tick >= 15 && s.status === 'running' && s.activePlayers.length === count) && new Set(values.map(s => s.branch)).size === 1, 'initial play');
  return { pages, context, contexts, players };
}
async function checkpoint(pages, label, resume = true) {
  await until(pages, values => values.every(s => s.status === 'running' && s.activePlayers.length === pages.length) && new Set(values.map(s => s.branch)).size === 1, label + ' reconnect ready');
  const values = await snapshots(pages), tick = Math.max(...values.map(s => s.tick)) + 4;
  await Promise.all(pages.map(p => p.evaluate(t => window.setTarget(t), tick)));
  const same = await until(pages, values => values.every(s => s.tick === tick && s.confirmedTick + 1 >= tick && !s.resimulating && s.status === 'running'), label);
  assert.equal(new Set(same.map(s => s.hash)).size, 1, label + ' same state'); results.push({ label, tick, hash: same[0].hash, coordinatorId: same[0].coordinatorId });
  if(resume)await Promise.all(pages.map(p => p.evaluate(() => window.setTarget(Infinity))));
}
async function closeRoom(value) { await Promise.all(value.pages.map(p => p.evaluate(() => window.stop()).catch(() => {}))); await Promise.all((value.contexts??[value.context]).map(c=>c.close())); }
try {
  browser = await chromium.launch({ headless: process.env.AVAILABILITY_HEADED !== '1', ignoreDefaultArgs: process.env.REMOTE_INPUT_LATENCY ? [] : ['--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'], ...(process.env.CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.CHROMIUM_EXECUTABLE_PATH } : process.env.BROWSER_CHANNEL ? { channel: process.env.BROWSER_CHANNEL } : {}) });
  if(process.env.INPUT_LATENCY){
    const samples=[];
    const configurations=process.env.INPUT_POLICY_EXPERIMENT ? [
      {label:'aggressive',inputSafetyMarginMs:0,inputJitterMultiplier:0},
      {label:'balanced',inputSafetyMarginMs:8,inputJitterMultiplier:2},
      {label:'conservative',inputSafetyMarginMs:40,inputJitterMultiplier:3},
    ].map(({label,...policy})=>({simulationHz:15,inputHz:60,renderHz:60,label,policy:{inputScheduling:'network',...policy}})) : [{simulationHz:5,inputHz:30,renderHz:60},{simulationHz:15,inputHz:40,renderHz:30}];
    for(const rates of configurations){
      rates.remote=process.env.REMOTE_INPUT_LATENCY==='1';
      const pair=await room(2,false,false,false,rates),host=pair.pages[0];
      if(rates.policy){await Promise.all(pair.pages.map(p=>p.evaluate(()=>window.networkDelay(35,[0,0,3,0,0,12,0,0,0,80,0,0]))));const warm=await snapshots(pair.pages);await until(pair.pages,v=>v.every((s,i)=>s.tick>=warm[i].tick+20&&s.metrics.smoothedRTT>40),'network estimate warmup');}
      await host.bringToFront();
      await Promise.all(pair.pages.map(p=>p.evaluate(()=>window.beginMeasurement())));
      if(rates.remote){
        const clockBefore=await host.evaluate(()=>window.synchronizeClock());
        const commandCount=rates.policy?24:8;
        for(let id=1;id<=commandCount;id++){
          const delayMs=id<=4?10:3500/rates.simulationHz;
          await host.evaluate(({id,delayMs,network})=>{if(!network)window.networkDelay(delayMs);window.inputEvent(id);},{id,delayMs,network:!!rates.policy});
          await pair.pages[1].waitForFunction(id=>window.latencyReport().remoteTraces.some(t=>t.id===id&&t.screen!==undefined),id,{timeout:6000});
        }
        await checkpoint(pair.pages,'remote application '+rates.simulationHz,false);
        const clockAfter=await host.evaluate(()=>window.synchronizeClock());
        const peers=await Promise.all(pair.pages.map(p=>p.evaluate(()=>window.latencyReport())));
        assert.ok(peers.every(p=>!p.failure));assert.ok(peers.every(p=>p.visibility==='visible'&&p.focused),'remote measurement active pages');assert.equal(peers[0].hash,peers[1].hash);
        assert.deepEqual(peers[0].commands,Array.from({length:commandCount},(_,i)=>'A:'+(i+1)+':'+(i+1)));
        for(let id=1;id<=commandCount;id++){const a=peers[0].remoteTraces.find(t=>t.id===id),b=peers[1].remoteTraces.find(t=>t.id===id);assert.ok(b.screen!==undefined);assert.ok(b.applications.every(x=>x.tick===a.applications[0].tick),'shared execution tick');const submitted=peers[0].traces.find(t=>t.id===id);if(submitted.assignedTick!==undefined)assert.ok(a.applications.every(x=>x.tick===submitted.assignedTick),'immutable submitted execution tick');}
        let invariants;
        if(!rates.policy&&!process.env.INPUT_BASELINE_DIST){
          await Promise.all(pair.pages.map(p=>p.evaluate(()=>{window.networkDelay(0);window.setTarget(Infinity);})));
          await host.evaluate(()=>{window.inputFault('hold');window.inputEvent(9);window.changeInputDelay(6);});
          await host.evaluate(()=>window.inputFault('reverse'));
          await checkpoint(pair.pages,'reserved T after delay growth',false);
          const before=await Promise.all(pair.pages.map(p=>p.evaluate(()=>window.latencyReport())));
          const submitted=before[0].traces.find(t=>t.id===9);assert.ok(before.every(p=>p.remoteTraces.find(t=>t.id===9).applications.every(a=>a.tick===submitted.assignedTick)),'delay growth preserves initial T');
          await host.evaluate(()=>window.inputFault('reverse'));await sleep(250);
          const after=await Promise.all(pair.pages.map(p=>p.evaluate(()=>window.latencyReport())));
          assert.deepEqual(after.map(p=>p.sessionMetrics.rollbacks),before.map(p=>p.sessionMetrics.rollbacks),'duplicate packets cannot replay');assert.deepEqual(after.map(p=>p.hash),before.map(p=>p.hash));
          invariants={assignedTick:submitted.assignedTick,delayGrowth:true,duplicateRollbacks:0};
        }
        samples.push({rates,clockBefore,clockAfter,peers,invariants});await closeRoom(pair);continue;
      }
      for(let id=1;id<=24;id++){await host.evaluate(id=>window.inputEvent(id),id);await sleep(73+(id*17)%51);}
      await checkpoint(pair.pages,'latency final '+rates.simulationHz,false);
      const peers=await Promise.all(pair.pages.map(p=>p.evaluate(()=>window.latencyReport())));
      assert.ok(peers.every(p=>!p.failure));assert.equal(peers[0].hash,peers[1].hash);assert.equal(peers[0].commands.length,24);assert.equal(new Set(peers[0].commands).size,24);
      assert.ok(peers[0].traces.every(t=>t.tickBefore===t.tickAfter),'event must not advance simulation');
      assert.ok(peers[0].traces.every(t=>t.savesBefore===t.savesAfter),'event must not save authority');
      await Promise.all(pair.pages.map(p=>p.evaluate(()=>window.setTarget(Infinity))));
      await host.evaluate(()=>{window.inputFault('hold');for(const id of [25,26,27])window.inputEvent(id);});
      const revisions=await host.evaluate(()=>window.inputFault('reverse'));
      if(!process.env.INPUT_BASELINE_DIST){assert.equal(peers[0].sessionMetrics.inputReservations,24);assert.equal(revisions.length,3);assert.equal(new Set(revisions.map(p=>p.tick)).size,1);assert.ok(revisions.every(p=>p.type===8));}
      await checkpoint(pair.pages,'same tick revisions '+rates.simulationHz);
      await host.evaluate(()=>window.inputFault('reverse')); // duplicates arriving after canonical confirmation
      await host.evaluate(()=>{window.inputFault('hold');window.inputEvent(28);});await sleep(550);
      await host.evaluate(()=>window.inputFault('reverse'));
      await checkpoint(pair.pages,'delayed duplicate commands '+rates.simulationHz);
      await host.evaluate(()=>{window.inputFault('drafts');window.inputEvent(29);});await sleep(4000/rates.simulationHz);
      const lateRevisions=await host.evaluate(()=>window.inputFault('reverse'));
      await checkpoint(pair.pages,'draft after canonical '+rates.simulationHz,false);
      if(!process.env.INPUT_BASELINE_DIST){await host.evaluate(()=>window.inputFault('protocol1'));await pair.pages[1].waitForFunction(()=>window.snapshot().events.some(e=>e.type==='version-mismatch'&&e.field==='protocol'));}
      const faultPeers=await Promise.all(pair.pages.map(p=>p.evaluate(()=>window.latencyReport())));
      assert.equal(faultPeers[0].hash,faultPeers[1].hash);assert.deepEqual(faultPeers[0].commands,Array.from({length:29},(_,i)=>`A:${i+1}:${i+1}`));
      assert.ok(faultPeers.every(p=>!p.failure));
      samples.push({rates,peers,revisions,lateRevisions,faultPeers});await closeRoom(pair);
    }
    assert.deepEqual(errors,[]);const report={passed:true,browser:browser.version(),backgroundThrottlingDisabled:!!process.env.REMOTE_INPUT_LATENCY,label:process.env.INPUT_LATENCY,samples};
    await mkdir(resolve(root,'test-results/rollback'),{recursive:true});await writeFile(resolve(root,'test-results/rollback/input-latency-'+process.env.INPUT_LATENCY+'.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({passed:true,label:report.label,samples:samples.map(s=>({rates:s.rates,traces:s.peers[0].traces}))}));
  } else {
  const delayed = await room(2, false);
  await delayed.pages[0].evaluate(() => window.block(['B'], true));
  await delayed.pages[0].locator('#move').click();
  await sleep(350);
  await delayed.pages[0].evaluate(() => window.block(['B'], false, true));
  await checkpoint(delayed.pages, 'delayed input and command converge');
  const delayedState = await snapshots(delayed.pages);
  assert.ok(delayedState.every(s => s.state.commands.filter(c => c === 'A:1:7').length === 1), 'delayed command exactly once');
  if (simulationMode === 'rollback') assert.ok(delayedState.some(s => s.metrics.rollbacks > 0), 'delayed real RTC input exercised rollback');
  results.push({label:'delayed input',simulationMode,peers:delayedState.map(s=>({metrics:s.metrics,commands:s.state.commands}))});
  await closeRoom(delayed);
  const two = await room(2, true, false, true), [host, guest] = two.pages;
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
  await guest.locator('#move').click(); await checkpoint(two.pages, 'guest command before suspension');
  const beforeGuestFreeze = (await host.evaluate(() => window.snapshot())).tick;
  const guestCDP = await two.context.newCDPSession(guest); await guestCDP.send('Emulation.setScriptExecutionDisabled', { value: true });
  await until([host], v => v[0].tick >= beforeGuestFreeze + 10 && v[0].activePlayers.length === 1, 'inactive guest');
  await host.locator('#move').click(); await until([host], v => v[0].state.commands.includes('A:1:7'), 'active input while guest frozen');
  await guestCDP.send('Emulation.setScriptExecutionDisabled', { value: false }); await guest.evaluate(() => window.resumePump()); await checkpoint(two.pages, 'guest resume state');
  await guest.locator('#move').click(); await checkpoint(two.pages, 'guest sequence after suspension');
  assert.ok((await snapshots(two.pages)).every(s => s.state.commands.includes('B:1:7') && s.state.commands.includes('B:2:7') && new Set(s.state.commands).size === s.state.commands.length), 'suspended guest command sequence retained');
  const beforeHostFreeze = (await guest.evaluate(() => window.snapshot())).tick;
  const hostCDP = await two.context.newCDPSession(host); await hostCDP.send('Emulation.setScriptExecutionDisabled', { value: true });
  await until([guest], v => v[0].tick >= beforeHostFreeze + 10 && v[0].coordinatorId === 'B', 'inactive coordinator');
  await hostCDP.send('Emulation.setScriptExecutionDisabled', { value: false }); await host.evaluate(() => window.resumePump()); await checkpoint(two.pages, 'coordinator resume follows active guest');
  await host.locator('#move').click(); await checkpoint(two.pages, 'coordinator sequence after suspension');
  assert.ok((await snapshots(two.pages)).every(s => s.state.commands.includes('A:1:7') && s.state.commands.includes('A:2:7') && new Set(s.state.commands).size === s.state.commands.length), 'suspended coordinator command sequence retained');
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
  const cooperative = await snapshots(two.pages);
  for (const peer of cooperative) {
    assert.ok(peer.membershipInstalls > 0, 'cooperative availability prepared state committed');
    assert.ok(peer.membershipInstalls <= peer.membershipJobs, 'only completed recovery jobs install; canceled rounds may leave unused tokens');
    assert.ok(peer.membershipPrepareMs > 0 && peer.maxBoundaryTaskMs >= peer.membershipPrepareMs, 'cooperative availability boundary costs measured');
  }
  results.push({ label: 'cooperative membership through guest/coordinator/room-wide resume', peers: cooperative.map(({ membershipJobs, membershipInstalls, membershipPrepareMs, maxBoundaryTaskMs }) => ({ membershipJobs, membershipInstalls, membershipPrepareMs, maxBoundaryTaskMs })) });
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
  await mkdir(resolve(root, 'test-results/rollback'), { recursive: true }); await writeFile(resolve(root, 'test-results/rollback/availability-'+simulationMode+'-report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
  }
} finally { await browser?.close(); await new Promise(ok => server.close(ok)); }

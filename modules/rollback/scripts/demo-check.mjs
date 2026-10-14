import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {demoPath,resultsDirectory,launchBrowser,serveRepository} from './browser-helpers.mjs';
const server=await serveRepository();let browser,page;const report={checks:[]},started=performance.now();
try{
 browser=await launchBrowser();page=await browser.newPage({viewport:{width:1000,height:1100}});const errors=[];
 // Observe the actual Canvas body in both views, rather than an authority endpoint.
 await page.addInitScript(()=>{
   window.bodyFrames=[];window.recordBodies=false;
   const fill=CanvasRenderingContext2D.prototype.fillRect;
   CanvasRenderingContext2D.prototype.fillRect=function(x,y,w,h){
     if(window.recordBodies&&this.canvas.id==='simulation'&&x===-13&&w===26&&this.fillStyle==='#c8ef95'){
       const m=this.getTransform();bodyFrames.push({view:m.f<318?'local':'remote',x:m.e});
     }
     return fill.call(this,x,y,w,h);
   };
 });
 page.on('pageerror',e=>errors.push(e.message));await page.goto(process.env.REFERENCE_URL??`http://127.0.0.1:${server.address().port}${demoPath}`);
 const read=()=>page.evaluate(()=>reference.diagnostics);
 const healthy=async()=>{const d=await read();assert.deepEqual(d.errors,[]);assert.deepEqual(errors,[]);return d;};
 const start=async tps=>{await page.selectOption('#tps',String(tps));await page.click('#start');await page.waitForFunction(()=>reference.diagnostics.peers.length===2&&reference.diagnostics.peers.every(p=>p.tick>5),null,{timeout:20000});assert.equal(await page.locator('#tps').isDisabled(),true);const d=await healthy();assert.equal(d.tps,tps);assert.equal(d.connections.filter(x=>x==='connected').length,2);};
 const compare=async()=>{await page.click('#compare');await page.waitForFunction(()=>document.querySelector('#comparison').dataset.result==='matched',null,{timeout:15000});const d=await page.evaluate(()=>reference.lastComparison);assert.equal(d.peers[0].hash,d.peers[1].hash);await healthy();return d;};
 const teleportFlow=async tps=>{
   const movementBefore=await read(),movementViews={};
   await page.evaluate(()=>{bodyFrames=[];recordBodies=true;});
   await page.keyboard.down('ArrowRight');await page.waitForTimeout(350);await page.keyboard.up('ArrowRight');await page.waitForTimeout(450);
   const movement=await page.evaluate(()=>{recordBodies=false;return bodyFrames;});
   for(const view of ['local','remote']){
     const xs=movement.filter(f=>f.view===view).map(f=>f.x);
     assert(xs.some((x,i)=>i&&Math.abs(x-xs[i-1])>.01&&Math.abs(x-xs[i-1])<110/tps-.01),`${tps} ${view}: ordinary movement remains interpolated`);
     assert(xs.every((x,i)=>!i||x>=xs[i-1]-1e-4),`${tps} ${view}: held movement and release never rewind`);
     movementViews[view]={frames:xs.length,rewinds:0,interpolated:true};
   }
   const before=await read(),from=before.peers[0].actors.a.x,to=from<360?590:130;
   assert.equal(before.peers[0].rollback,movementBefore.peers[0].rollback,'local movement is not a simulation rollback');
   await page.click('#delay');
   await page.evaluate(()=>{bodyFrames=[];recordBodies=true;});
   await page.click('[data-player="a"][data-command="3"]');await page.waitForTimeout(1100);
   const frames=await page.evaluate(()=>{recordBodies=false;return bodyFrames;});
   const results={tps,from,to,movement:movementViews,localMovementRollbacks:before.peers[0].rollback-movementBefore.peers[0].rollback,views:{}};
   for(const view of ['local','remote']){
     const xs=frames.filter(f=>f.view===view).map(f=>f.x);
     // Canvas transforms use float precision; tolerate subpixel representation only.
     const middle=xs.filter(x=>Math.abs(x-from)>1e-4&&Math.abs(x-to)>1e-4);
     const arrival=xs.findIndex(x=>Math.abs(x-to)<1e-4);
     assert(arrival>=0,`${view}: destination displayed`);
     assert.deepEqual(middle,[],`${tps} ${view}: no intermediate teleport body, including reconcile/release`);
     assert(xs.slice(arrival).every(x=>Math.abs(x-to)<1e-4),`${view}: old display history never returns after arrival`);
     results.views[view]={frames:xs.length,intermediate:middle.length};
   }
   await page.click('#delay');const after=await compare();
   if(tps===30)assert(after.peers[1].rollback>before.peers[1].rollback,'late teleport exercises remote rollback/history reset');
   results.rollbacks=after.peers.map((p,i)=>p.rollback-before.peers[i].rollback);
   (report.teleports??=[]).push(results);
 };
 await start(10);report.checks.push('10 TPS: two RoomSessions, actual native WebRTC, TPS locked');
 const before=await read();await page.keyboard.down('ArrowRight');await page.waitForTimeout(400);await page.keyboard.up('ArrowRight');await page.keyboard.down('KeyA');await page.waitForTimeout(350);await page.keyboard.up('KeyA');
 await page.click('[data-player="a"][data-command="1"]');await page.waitForTimeout(90);await page.click('[data-player="b"][data-command="2"]');await page.waitForTimeout(450);await mkdir(resultsDirectory,{recursive:true});await page.screenshot({path:resolve(resultsDirectory,'reference-active.png'),fullPage:true});await page.waitForTimeout(950);
 let d=await compare();for(const p of d.peers){assert.equal(p.counts.a.dash,1);assert.equal(p.counts.b.fire,1);assert.equal(p.counts.b.dash,0);assert.equal(p.counts.a.fire,0);assert(p.actors.a.x>before.peers[0].actors.a.x);assert(p.actors.b.x<before.peers[0].actors.b.x);assert(p.stats.projectileFrames>0);assert(p.stats.previewFrames>0);assert(p.stats.optionalFrames>0);assert.equal(p.stats.duplicateSounds,0);assert.equal(p.stats.duplicateParticles,0);}report.checks.push('held movement, owned one-shot dash/fire, preview lifetime, optional state, seeded XYZ projectile');
 await page.click('#delay');const rollback=d.peers.reduce((n,p)=>n+p.rollback,0);
 await page.keyboard.down('ArrowLeft');await page.click('[data-player="a"][data-command="2"]');await page.waitForTimeout(350);await page.keyboard.up('ArrowLeft');await page.click('[data-player="a"][data-command="4"]');await page.waitForTimeout(1300);await page.click('#delay');await page.waitForTimeout(400);
 d=await compare();assert(d.peers.reduce((n,p)=>n+p.rollback,0)>rollback);for(const p of d.peers){assert.equal(p.counts.a.fire,1);assert.equal(p.counts.a.spark,1);assert.equal(p.stats.duplicateSounds,0);assert.equal(p.stats.duplicateParticles,0);assert.equal(p.stats.soundStarts,4);assert.equal(new Set(p.commands.map(c=>c.owner+':'+c.sequence)).size,p.commands.length);for(const c of p.commands){const submit=p.submissions.flatMap(s=>s.commands).find(s=>s.sequence===c.sequence&&c.owner===p.id);if(submit)assert.equal(c.tick,submit.executeTick);}}report.checks.push('late RTC input rolls back/replays; immutable command T; confirmed sound and speculative particles do not duplicate');
 await teleportFlow(10);await page.click('[data-player="b"][data-command="2"]');await page.waitForTimeout(1400);report.first=await compare();assert(report.first.peers.every(p=>p.stats.pathCorners>0&&p.stats.retainedFrames>0&&p.stats.releases>0&&p.actors.a.action===null&&p.actors.b.action===null));assert(report.first.peers.every(p=>p.actors.b.shotGeneration===2&&p.actors.a.teleportSerial===1));report.checks.push('teleport, expired shot ID reused with new generation, same-frame path/target assertions');
 await page.click('#stop');assert.equal((await read()).peers.length,0);await start(30);await teleportFlow(30);await page.click('[data-player="a"][data-command="1"]');await page.click('[data-player="b"][data-command="2"]');await page.waitForTimeout(1200);report.restarted=await compare();assert(report.restarted.peers.every(p=>p.counts.a.dash===1&&p.counts.b.fire===1&&p.stats.duplicateSounds===0));report.checks.push('whole-room stop, 30 TPS restart, fresh ownership/events/hash agreement');
 await mkdir(resultsDirectory,{recursive:true});await page.screenshot({path:resolve(resultsDirectory,'reference-example.png'),fullPage:true});await page.click('#stop');await page.waitForTimeout(80);d=await healthy();assert.equal(d.peers.length,0);assert.equal(d.connections.length,0);report.checks.push('loop, preview, journal, timers and native connections disposed');
 report.status='PASS';report.browser=browser.version();
}catch(error){report.status='FAIL';report.error=error.stack;report.diagnostics=await page?.evaluate(()=>({state:window.reference?.diagnostics,error:document.querySelector('#error-log')?.textContent})).catch(()=>null);throw error;}
finally{report.elapsedMs=Math.round(performance.now()-started);await mkdir(resultsDirectory,{recursive:true});await writeFile(resolve(resultsDirectory,'reference-example-report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));await browser?.close();await new Promise(r=>server.close(r));}

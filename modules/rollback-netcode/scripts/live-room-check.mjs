// Optional external relay smoke. The bounded reference E2E uses local SDP/ICE + real RTC.
import assert from 'node:assert/strict';
import {writeFile,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {demoPath,resultsDirectory,launchBrowser,serveRepository} from './browser-helpers.mjs';
if(process.env.RUN_LIVE_ROOM_CHECK!=='1')throw Error('Set RUN_LIVE_ROOM_CHECK=1 for public Nostr/WebRTC smoke');
let server,browser;const errors=[];
try{
 if(!process.env.BASE_URL)server=await serveRepository();browser=await launchBrowser();
 const pages=await Promise.all([0,1].map(async()=>{const context=await browser.newContext();const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));return page;}));
 const base=process.env.BASE_URL??`http://127.0.0.1:${server.address().port}${demoPath}`,room=String(Math.floor(Math.random()*10000)).padStart(4,'0');
 for(const [i,page]of pages.entries()){await page.goto(base);await page.selectOption('#mode',i?'join':'host');await page.fill('#room-input',room);await page.selectOption('#tps','10');await page.click('#start');}
 await Promise.all(pages.map(page=>page.waitForFunction(()=>reference.diagnostics.peers[0]?.commands&&Object.keys(reference.diagnostics.peers[0].actors).length===2&&reference.diagnostics.peers[0].tick>10,null,{timeout:60000})));
 for(const page of pages)await page.click('[data-player="a"][data-command="2"]');
 await Promise.all(pages.map(page=>page.waitForFunction(()=>Object.values(reference.diagnostics.peers[0].counts).every(c=>c.fire===1),null,{timeout:15000})));
 const diagnostics=await Promise.all(pages.map(page=>page.evaluate(()=>reference.diagnostics)));diagnostics.forEach(d=>assert.deepEqual(d.errors,[]));assert.deepEqual(errors,[]);
 assert.deepEqual(diagnostics[0].peers[0].counts,diagnostics[1].peers[0].counts);
 const report={status:'PASS',publicSignaling:true,actualWebRTC:true,separateContexts:true,differentNetworks:false,room,diagnostics};
 await mkdir(resultsDirectory,{recursive:true});await writeFile(resolve(resultsDirectory,'live-room-report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
 await Promise.all(pages.map(page=>page.click('#stop')));
}finally{await browser?.close();if(server)await new Promise(r=>server.close(r));}

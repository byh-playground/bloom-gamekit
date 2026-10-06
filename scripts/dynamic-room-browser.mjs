import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),errors=[];
const server=createServer(async(req,res)=>{try{const path=resolve(root,'.'+new URL(req.url,'http://localhost').pathname);if(!path.startsWith(root+sep)){res.writeHead(403).end();return;}const data=await readFile(path);res.writeHead(200,{'content-type':extname(path)==='.html'?'text/html':'text/javascript','cache-control':'no-store'}).end(data);}catch{res.writeHead(404).end();}});
await new Promise((ok,no)=>{server.once('error',no);server.listen(0,'127.0.0.1',ok);});
let browser;
try{
 browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_EXECUTABLE_PATH?{executablePath:process.env.CHROMIUM_EXECUTABLE_PATH}:process.env.BROWSER_CHANNEL?{channel:process.env.BROWSER_CHANNEL}:{})});
 const page=await browser.newPage();page.on('pageerror',e=>errors.push(e.message));await page.goto(`http://127.0.0.1:${server.address().port}/tests/rollback/dynamic-browser.html`);await page.waitForFunction(()=>typeof window.runDynamicRoomScenario==='function');
 const result=await page.evaluate(()=>window.runDynamicRoomScenario());assert.deepEqual(errors,[]);assert.equal(result.passed,true);
 await mkdir(resolve(root,'test-results/rollback'),{recursive:true});await writeFile(resolve(root,'test-results/rollback/dynamic-room-report.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result,null,2));
}finally{await browser?.close();await new Promise(ok=>server.close(ok));}

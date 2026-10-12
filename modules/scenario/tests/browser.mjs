import {chromium} from 'playwright';
import {createServer} from 'node:http';import {readFile} from 'node:fs/promises';import {resolve,extname} from 'node:path';import assert from 'node:assert/strict';
import {navigationFlow} from '../../navigation/tests/browser.mjs';
const server=createServer(async(req,res)=>{try{const p=resolve('.','.'+new URL(req.url,'http://localhost').pathname);res.setHeader('Content-Type',extname(p)==='.html'?'text/html':'text/javascript');res.end(await readFile(p));}catch{res.writeHead(404);res.end();}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));let browser;
try{browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_EXECUTABLE_PATH?{executablePath:process.env.CHROMIUM_EXECUTABLE_PATH}:{})});const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));const base='http://127.0.0.1:'+server.address().port;
 await navigationFlow(page,base);
 await page.goto(base+'/modules/scenario/examples/index.html');await page.waitForFunction(()=>window.scenarioDemo);
 await page.click('#play');await page.waitForFunction(()=>scenarioDemo.runner.snapshot().tick>5);await page.click('#pause');const paused=await page.evaluate(()=>scenarioDemo.runner.snapshot());await page.waitForTimeout(80);assert.deepEqual(await page.evaluate(()=>scenarioDemo.runner.snapshot()),paused);
 await page.click('#play');await page.waitForFunction(()=>scenarioDemo.runner.state==='ended');assert.equal(await page.evaluate(()=>scenarioDemo.value),430);
 await page.click('#restart');await page.waitForFunction(()=>scenarioDemo.runner.state==='ended');assert.equal(await page.evaluate(()=>scenarioDemo.value),430);
 await page.click('#repeat');await page.click('#play');await page.waitForFunction(()=>scenarioDemo.runner.snapshot().iteration>=1);await page.click('#stop');const stopped=await page.evaluate(()=>({state:scenarioDemo.runner.state,created:scenarioDemo.created,disposed:scenarioDemo.disposed,backend:scenarioDemo.backend}));assert.equal(stopped.created,stopped.disposed);assert.equal(stopped.state,'stopped');assert.match(stopped.backend,/WebGL/);assert.deepEqual(errors,[]);console.log(JSON.stringify({navigation:'PASS',scenario:'PASS',...stopped}));
}finally{await browser?.close();server.close();}

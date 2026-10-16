import { chromium } from 'playwright';
import { mkdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { exerciseAlphaRunBatching } from './alpha-run-batching.browser.mjs';

const root=resolve('.');
const executablePath=process.env.CHROMIUM_EXECUTABLE_PATH??['C:/Program Files/Google/Chrome/Application/chrome.exe','C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync);
if(!executablePath)throw new Error('Set CHROMIUM_EXECUTABLE_PATH to Chromium or Edge.');
const bundle=await readFile(resolve(root,'dist/rendering.js'));
const moduleURL='data:text/javascript;base64,'+bundle.toString('base64');
const evidenceDirectory=resolve(root,'evidence'); await mkdir(evidenceDirectory,{recursive:true});
const screenshotPath=resolve(evidenceDirectory,'alpha-run-batching-overlap-disjoint.png');
const browser=await chromium.launch({headless:true,executablePath,args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']});
try { const result=await exerciseAlphaRunBatching(browser,moduleURL,screenshotPath); console.log(JSON.stringify({...result,screenshotPath},null,2)); }
finally { await browser.close(); }

import { chromium } from 'playwright';
import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { compileVectorAssetFile } from '../compiler.js';
import { exerciseNonScalingStroke } from './non-scaling-stroke.browser.mjs';

const root=resolve('.');
const executablePath=process.env.CHROMIUM_EXECUTABLE_PATH
  ?? ['C:/Program Files/Google/Chrome/Application/chrome.exe','C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(path=>existsSync(path));
if(!executablePath)throw new Error('Set CHROMIUM_EXECUTABLE_PATH to Chromium or Edge.');
const asset=await compileVectorAssetFile(resolve(root,'modules/vector-assets/tests/non-scaling-stroke.svg'));
const geometry={...asset.geometry,vertices:Array.from(asset.geometry.vertices),indices:Array.from(asset.geometry.indices)};
const renderingBundle=await readFile(resolve(root,'dist/rendering.js'));
const moduleURL='data:text/javascript;base64,'+renderingBundle.toString('base64');
const evidenceDirectory=resolve(root,'..','evidence');
await mkdir(evidenceDirectory,{recursive:true});
const screenshotPath=resolve(evidenceDirectory,'non-scaling-stroke-webgl.png');
const browser=await chromium.launch({headless:true,executablePath,args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']});
try {
  const result=await exerciseNonScalingStroke(browser,moduleURL,geometry,screenshotPath);
  console.log(JSON.stringify({...result,evidencePath:screenshotPath},null,2));
} finally {
  await browser.close();
}

// 선택적 실제 Rally Adapter 벤치. 게임 파일/배포는 수정하지 않는다.
// RALLY_HTML: StrategySim/RallySimulationAdapter를 포함한 로컬 단일 HTML.
// 이전 게임/SDK 비교는 RALLY_BASELINE_HTML/RALLY_BASELINE_MODULE 파일을 명시할 때만 추가한다.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { launchBrowser, resultsDirectory } from './browser-helpers.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../..');
if(!process.env.RALLY_HTML)throw Error('RALLY_HTML을 StrategySim/RallySimulationAdapter가 포함된 게임 index.html로 지정하세요. 선택적 도구이며 기본 CI에 포함하지 않습니다.');
const htmlPath=path.resolve(process.env.RALLY_HTML),gameRoot=fs.realpathSync(path.dirname(htmlPath));
const currentHtml=fs.readFileSync(htmlPath,'utf8');
const legacyPath=process.env.RALLY_BASELINE_HTML?path.resolve(process.env.RALLY_BASELINE_HTML):null;
const legacyHtml=legacyPath?fs.readFileSync(legacyPath,'utf8'):null;
const sdkSource=fs.readFileSync(path.join(root,'dist/rollback-netcode.js'),'utf8');
const baselineSource=process.env.RALLY_BASELINE_MODULE?fs.readFileSync(path.resolve(process.env.RALLY_BASELINE_MODULE),'utf8'):null;
const counts=(process.env.RALLY_COUNTS||'20,60,200').split(',').map(Number),steps=Number(process.env.RALLY_STEPS||60),warmup=12;
assert.ok(counts.length&&counts.every(count=>Number.isSafeInteger(count)&&count>0),'RALLY_COUNTS must contain positive integers');
assert.ok(Number.isSafeInteger(steps)&&steps>0,'RALLY_STEPS must be a positive integer');
const browser=await launchBrowser(),results=[],pageErrors=[];
async function prepare(html,name,assetRoot=gameRoot){
  const page=await browser.newPage(),at=html.lastIndexOf('})();');
  assert.ok(at>0,'Rally fixture must expose its simulation inside the expected closing IIFE');
  let body=html.slice(0,at)+`window.__rallyPerf={StrategySim,GameRuleDefinition,HashUtil,StableSerializationUtil,
    RallySimulationAdapter:typeof RallySimulationAdapter==='undefined'?null:RallySimulationAdapter,
    RallyCommandCodec:typeof RallyCommandCodec==='undefined'?null:RallyCommandCodec};`+html.slice(at);
  // 기존 단일 SDK import만 현재 kit 번들로 연결한다. 외부 릴레이나 가짜 게임 구현을 주입하지 않는다.
  body=body.replace(/https:\/\/[^\s'"<>]+\/rollback-netcode\.js/g,'http://rally-perf.local/candidate.mjs');
  page.on('pageerror',error=>pageErrors.push({page:name,message:error.message}));
  await page.route('http://rally-perf.local/**',async route=>{
    const pathname=new URL(route.request().url()).pathname;
    if(pathname==='/candidate.mjs')return route.fulfill({contentType:'text/javascript',body:sdkSource});
    if(pathname==='/baseline.mjs'&&baselineSource)return route.fulfill({contentType:'text/javascript',body:baselineSource});
    if(pathname===`/game/${name}.html`)return route.fulfill({contentType:'text/html',body});
    // 게임이 함께 보관한 로컬 자원은 실제 파일로 제공한다. 임의 URL에 HTML/SDK를 대신 반환하지 않는다.
    try{
      if(!pathname.startsWith('/game/'))return route.fulfill({status:404,body:'Not found'});
      const file=fs.realpathSync(path.resolve(assetRoot,decodeURIComponent(pathname.slice('/game/'.length))));
      if(!file.startsWith(assetRoot+path.sep))return route.fulfill({status:403,body:'Forbidden'});
      const types={'.js':'text/javascript','.mjs':'text/javascript','.json':'application/json','.css':'text/css','.png':'image/png','.svg':'image/svg+xml'};
      return route.fulfill({contentType:types[path.extname(file)]||'application/octet-stream',body:fs.readFileSync(file)});
    }catch{return route.fulfill({status:404,body:'Not found'})}
  });
  await page.goto(`http://rally-perf.local/game/${name}.html`);
  await page.waitForFunction(()=>window.__rallyPerf);
  if(name==='current'){
    await page.evaluate(async hasBaseline=>{
      window.__newSDK=await import('/candidate.mjs');
      window.__baselineSDK=hasBaseline?await import('/baseline.mjs'):null;
      const q=window.__rallyPerf;
      if(typeof q.RallySimulationAdapter!=='function'||typeof q.RallyCommandCodec?.encode!=='function')throw Error('RALLY_HTML must provide RallySimulationAdapter and RallyCommandCodec.encode');
    },Boolean(baselineSource));
  }
  return page;
}
async function measure({mode,count,steps,warmup,round}){
  const q=window.__rallyPerf,all=steps+warmup,saveCosts=[],loadCosts=[],stepCosts=[],totals=[];
  const rules=q.GameRuleDefinition.resolve({overrides:{simulation:{tps:20}}});q.GameRuleDefinition.current=rules;
  const start=performance.now(),draft={decks:{host:['swordsman'],guest:['swordsman']},defenseCards:{host:[],guest:[]}};
  const sim=new q.StrategySim(draft,831047,rules);
  sim.applyDebugScenario({kind:'unit-combat',allyType:'swordsman',enemyType:'swordsman',allyCount:Math.min(count,60),enemyCount:Math.min(count,60),research:false,humanRole:'host'});
  // A benchmark scenario supplies only its initial roster through real spawn APIs.
  if(count>60)for(const side of [0,1])for(let i=60;i<count;i++){
    const col=(i-60)%16,row=Math.floor((i-60)/16);
    sim.spawnUnit(side,'swordsman',sim.world.width*.5+(col-7.5)*40,sim.world.height*.5+(side===0?1:-1)*(240+row*40));
  }
  sim.rebuildRuntimeIndexes();const initialUnits=sim.units.length,setupMs=performance.now()-start;
  const proto=q.StrategySim.prototype,originalStep=proto.step;
  proto.step=function(...args){const t=performance.now();try{return originalStep.apply(this,args)}finally{stepCosts.push(performance.now()-t)}};
  let core=null,adapter=null,initialBytes=null,sequence=0;
  const sdk=mode==='sdk-current'?window.__newSDK:window.__baselineSDK;
  if(mode.startsWith('sdk')){
    adapter=new q.RallySimulationAdapter({sim,onNetcodeFrameApplied(){}});
    const save=adapter.save.bind(adapter),load=adapter.load.bind(adapter);
    adapter.save=()=>{const t=performance.now();try{return save()}finally{saveCosts.push(performance.now()-t)}};
    adapter.load=b=>{const t=performance.now();try{return load(b)}finally{loadCosts.push(performance.now()-t)}};
    initialBytes=adapter.save().length;
    core=sdk.createSession({players:['host'],localPlayerId:'host',sessionId:'rally-perf',simulationVersion:'rally-perf-182',inputSize:1,seed:831047,adapter,recordReplay:true,
      profile:{...sdk.profiles.rts,baseInputDelayTicks:0,adaptiveInputDelay:false,pacingPolicy:'none',maxSnapshotBytes:8*1024*1024,maxHistoryBytes:256*1024*1024}});
  }
  const input=new Uint8Array(1);
  try{
    for(let tick=0;tick<all;tick++){
      const action=tick%17===4?{type:'SET_FLAG',x:sim.world.width*.5+(tick%3)*10,y:sim.world.height*.5-300,forced:true}:null;
      if(action){sequence++;if(core)core.queueCommand(q.RallyCommandCodec.encode(action));else sim.queueCommand({actor:'host',seq:tick*4096+1,tick:tick+1,netcodeSequence:sequence,action})}
      const before=performance.now();if(core){const result=core.advance(input);if(result.status!=='advanced')throw Error(result.status)}else sim.step();totals.push(performance.now()-before);
    }
    const stats=list=>{const sorted=list.slice(-steps).sort((a,b)=>a-b);return {p50:sorted[Math.floor(sorted.length*.5)]||0,p95:sorted[Math.floor(sorted.length*.95)]||0,total:list.reduce((a,b)=>a+b,0)}};
    const finalGameplayHash=sim.checksumBundle({includeScheduled:false}).root;
    const stateHash=adapter?window.__newSDK.hashBytes(adapter.save()):null;
    const snapshot=adapter?.save();if(snapshot)for(let i=0;i<8;i++)adapter.load(snapshot);
    return {round,mode,initialUnits,finalUnits:sim.units.length,tps:sim.tps,ticks:sim.tick,setupMs,snapshotBytes:initialBytes,totalMs:stats(totals),gameStepMs:stats(stepCosts),adapterSaveMs:stats(saveCosts),adapterLoadMs:stats(loadCosts),finalGameplayHash,stateHash,coreMetrics:core?.metrics||null};
  }finally{proto.step=originalStep;core?.close();sim.dispose('benchmark')}
}
async function measurePaired({count,steps,warmup}){
  const q=window.__rallyPerf,modes=['raw-current',...(window.__baselineSDK?['sdk-baseline']:[]),'sdk-current'],cases=[],rules=q.GameRuleDefinition.resolve({overrides:{simulation:{tps:20}}});
  q.GameRuleDefinition.current=rules;
  const original=q.StrategySim.prototype.step;let active=null;
  q.StrategySim.prototype.step=function(...args){const start=performance.now();try{return original.apply(this,args)}finally{if(active)active.step+=performance.now()-start}};
  const sample=(values)=>{const sorted=values.slice(warmup).sort((a,b)=>a-b);return {p50:sorted[Math.floor(sorted.length*.5)],p95:sorted[Math.floor(sorted.length*.95)],mean:sorted.reduce((a,b)=>a+b,0)/sorted.length}};
  try{
    for(const mode of modes){
      const sim=new q.StrategySim({decks:{host:['swordsman'],guest:['swordsman']},defenseCards:{host:[],guest:[]}},831047,rules);
      sim.applyDebugScenario({kind:'unit-combat',allyType:'swordsman',enemyType:'swordsman',allyCount:Math.min(count,60),enemyCount:Math.min(count,60),research:false,humanRole:'host'});
      if(count>60)for(const side of [0,1])for(let i=60;i<count;i++)sim.spawnUnit(side,'swordsman',sim.world.width*.5+((i-60)%16-7.5)*40,sim.world.height*.5+(side===0?1:-1)*(240+Math.floor((i-60)/16)*40));
      sim.rebuildRuntimeIndexes();
      const row={mode,sim,initialUnits:sim.units.length,total:[],game:[],save:[],coreOnly:[],core:null,adapter:null};
      if(mode.startsWith('sdk')){
        const sdk=mode==='sdk-current'?window.__newSDK:window.__baselineSDK,adapter=new q.RallySimulationAdapter({sim,onNetcodeFrameApplied(){}}),save=adapter.save.bind(adapter);
        row.snapshotBytes=save().length;adapter.save=()=>{const start=performance.now();try{return save()}finally{if(active)active.save+=performance.now()-start}};
        row.adapter=adapter;row.core=sdk.createSession({players:['host'],localPlayerId:'host',sessionId:'paired',simulationVersion:'rally-perf-182',inputSize:1,seed:831047,adapter,recordReplay:true,
          profile:{...sdk.profiles.rts,baseInputDelayTicks:0,adaptiveInputDelay:false,pacingPolicy:'none',maxSnapshotBytes:8*1024*1024,maxHistoryBytes:256*1024*1024}});
      }cases.push(row);
    }
    const input=new Uint8Array(1);let sequence=0;
    for(let tick=0;tick<steps+warmup;tick++){
      const action=tick%17===4?{type:'SET_FLAG',x:cases[0].sim.world.width*.5+(tick%3)*10,y:cases[0].sim.world.height*.5-300,forced:true}:null;
      if(action)sequence++;
      const order=tick%2?[...cases].reverse():cases;
      for(const row of order){
        if(action){if(row.core)row.core.queueCommand(q.RallyCommandCodec.encode(action));else row.sim.queueCommand({actor:'host',seq:tick*4096+1,tick:tick+1,netcodeSequence:sequence,action})}
        active={step:0,save:0};const start=performance.now();
        if(row.core){if(row.core.advance(input).status!=='advanced')throw Error('Core did not advance');if(row.core.tick%20===0)row.core.getStateHash()}
        else row.sim.step();
        const total=performance.now()-start;row.total.push(total);row.game.push(active.step);row.save.push(active.save);row.coreOnly.push(Math.max(0,total-active.step-active.save));active=null;
      }
    }
    const report=cases.map(row=>({mode:row.mode,initialUnits:row.initialUnits,finalUnits:row.sim.units.length,snapshotBytes:row.snapshotBytes??null,
      ticks:row.sim.tick,tps:row.sim.tps,totalMs:sample(row.total),gameStepMs:sample(row.game),adapterSaveMs:sample(row.save),runtimeResidualMs:sample(row.coreOnly),
      finalGameplayHash:row.sim.checksumBundle({includeScheduled:false}).root,stateHash:row.adapter?window.__newSDK.hashBytes(row.adapter.save()):null}));
    if(new Set(report.map(r=>r.finalGameplayHash)).size!==1||new Set(report.filter(r=>r.stateHash!==null).map(r=>r.stateHash)).size!==1)throw Error('Paired gameplay/state mismatch');
    return report;
  }finally{active=null;q.StrategySim.prototype.step=original;for(const row of cases){row.core?.close();row.sim.dispose('paired-benchmark')}}
}
try{
  const legacy=legacyHtml?await prepare(legacyHtml,'legacy',fs.realpathSync(path.dirname(legacyPath))):null,current=await prepare(currentHtml,'current');
  const paired=process.env.RALLY_PAIRED==='1';
  if(paired){
    for(const count of counts){const group=await current.evaluate(measurePaired,{count,steps,warmup});results.push(...group);console.log(JSON.stringify(group))}
  }else{
    for(let round=0;round<2;round++)for(const count of counts){
      const ordered=[...(legacy?['raw-legacy']:[]),'raw-current',...(baselineSource?['sdk-baseline']:[]),'sdk-current'];
      const modes=round?ordered.reverse():ordered,group=[];
      for(const mode of modes){const result=await(mode==='raw-legacy'?legacy:current).evaluate(measure,{mode,count,steps,warmup,round});results.push(result);group.push(result);console.log(JSON.stringify(result))}
      assert.equal(new Set(group.map(r=>r.finalGameplayHash)).size,1,'Same scenario/input timeline must preserve gameplay');
      assert.equal(new Set(group.filter(r=>r.stateHash!==null).map(r=>r.stateHash)).size,1,'SDK comparison must preserve the complete game memento');
    }
  }
  assert.deepEqual(pageErrors,[],'Game fixture must not report uncaught browser errors');
  fs.mkdirSync(resultsDirectory,{recursive:true});
  fs.writeFileSync(path.join(resultsDirectory,paired?'rally-paired-benchmark.json':'rally-benchmark.json'),JSON.stringify({htmlPath,
    baselineHtml:process.env.RALLY_BASELINE_HTML??null,baselineModule:process.env.RALLY_BASELINE_MODULE??null,
    browser:browser.version(),steps,warmup,interleaved:paired,periodicHashInterval:paired?20:null,results},null,2));
}finally{await browser.close()}

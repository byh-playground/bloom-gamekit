import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { cpus } from 'node:os';
import { createSession } from '../core.js';
import { hashBytes } from '../../deterministic/utilities.js';

// Identical deterministic entity simulation + canonical JSON save in both modes.
// Actual consumer adapter measurements are reported in their owning repositories.
const TICKS = 300, SAMPLES = 5, INTERVAL = 20;
const median = xs => [...xs].sort((a,b)=>a-b)[Math.floor(xs.length/2)];
function run(mode, count) {
  global.gc?.();
  const heapBefore = process.memoryUsage().heapUsed;
  let state = { tick: 0, entities: Array.from({length: count}, (_,id)=>({id,x:id*3,y:id*7,hp:100,energy:50,target:id%7,flags:0})) };
  let saveMs = 0, simulationMs = 0;
  const encoder = new TextEncoder(), decoder = new TextDecoder();
  const adapter = {
    save() { const start=performance.now(); const bytes=encoder.encode(JSON.stringify(state)); saveMs+=performance.now()-start; return bytes; },
    load(bytes) { state=JSON.parse(decoder.decode(bytes)); }, validateSnapshot: () => true,
    step({tick,inputs}) { const start=performance.now(); assert.equal(tick,state.tick); const n=inputs[0].input[0];
      for (const e of state.entities) { e.x=(e.x+n+e.id)%10000; e.y=(e.y+e.target)%10000; e.energy=(e.energy+1)%101; e.flags=(tick+e.id)&3; }
      state.tick++; simulationMs+=performance.now()-start; },
  };
  const session=createSession({players:['a'],localPlayerId:'a',sessionId:'bench',simulationVersion:'1',inputSize:1,adapter,recordReplay:true,
    profile:{mode,tickRate:20,baseInputDelayTicks:0,minInputDelayTicks:0,maxInputDelayTicks:0,adaptiveInputDelay:false,pacingPolicy:'none',stateHistorySize:64,checksumInterval:INTERVAL}});
  const samples=[], started=performance.now();
  for(let tick=0;tick<TICKS;tick++){const start=performance.now();assert.equal(session.advance(new Uint8Array([tick%13])).status,'advanced');samples.push(performance.now()-start);}
  const elapsedMs=performance.now()-started, metrics=session.metrics;
  global.gc?.(); const heapAfter=process.memoryUsage().heapUsed;
  const hash=hashBytes(encoder.encode(JSON.stringify(state)));
  const result={elapsedMs,medianAdvanceMs:median(samples),saveMs,simulationMs,snapshotSaves:metrics.snapshotSaves,serializedSnapshotBytes:metrics.serializedSnapshotBytes,
    retainedSnapshotBytes:metrics.retainedSnapshotBytes,postGcHeapDeltaBytes:heapAfter-heapBefore,hash};
  assert.equal(metrics.snapshotSaves,mode==='rollback'?TICKS+1:1+TICKS/INTERVAL);
  session.close();return result;
}
const results=[];
for(const entities of [1,155,1000]){
  for(const mode of ['rollback','lockstep'])run(mode,entities);
  const samples={rollback:[],lockstep:[]};
  for(let i=0;i<SAMPLES;i++)for(const mode of i%2?['lockstep','rollback']:['rollback','lockstep'])samples[mode].push(run(mode,entities));
  assert.ok([...samples.rollback,...samples.lockstep].every(x=>x.hash===samples.rollback[0].hash));
  results.push({entities,...Object.fromEntries(Object.entries(samples).map(([mode,values])=>[mode,{median:Object.fromEntries(Object.keys(values[0]).map(k=>[k,median(values.map(x=>x[k]))])),samples:values}]))});
}
console.log(JSON.stringify({environment:{node:process.version,cpu:cpus()[0].model,gc:!!global.gc},fixture:{ticks:TICKS,samples:SAMPLES,checksumInterval:INTERVAL,historyTicks:64,recordReplay:true},
  scope:'Node entity fixture, canonical JSON serialization, same adapter/inputs. Includes simulation and SDK save/copy cost; excludes network/browser/render/GPU. Timings are local medians, not phone FPS. Post-GC heap delta is noisy and not total allocation.',results},null,2));

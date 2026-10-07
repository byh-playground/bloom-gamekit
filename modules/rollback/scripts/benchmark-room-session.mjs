import { performance } from 'node:perf_hooks';
import { createRoomSession, createSession, profiles } from '../index.js';
const ticks=20000,bytes=128*1024,input=new Uint8Array([1]);
const profile={...profiles.lockstep,baseInputDelayTicks:0,checksumInterval:20,stateHistorySize:64,pacingPolicy:'none'};
function adapter(){let state=new Uint8Array(bytes),view=new DataView(state.buffer);return{save:()=>state.slice(),load:b=>{state=b.slice();view=new DataView(state.buffer);},validateSnapshot:b=>b.length===bytes,applyMembership(){},step({tick,inputs}){view.setUint32(0,tick+1,true);view.setUint32(4,view.getUint32(4,true)+inputs[0].input[0],true);}};}
function run(dynamic){const options={adapter:adapter(),simulationVersion:'bench',seed:1,inputSize:1,profile,recordReplay:false},s=dynamic?createRoomSession(options):createSession({...options,players:['local'],localPlayerId:'local',sessionId:'local'});const start=performance.now();for(let n=0;n<ticks;n++)s.advance(input);const ms=performance.now()-start,m=s.metrics;s.close();return{mode:dynamic?'RoomSession/local':'fixed Core',ticks,ms,usPerTick:ms/ticks*1000,snapshotSaves:m.snapshotSaves,serializedSnapshotBytes:m.serializedSnapshotBytes,retainedSnapshotBytes:m.retainedSnapshotBytes};}
run(false);run(true);const results=[];for(let n=0;n<5;n++){results.push(run(false),run(true));}
console.log(JSON.stringify({environment:process.version,scope:'Node CPU only; 128 KiB canonical snapshot, no rendering/network; includes hash checkpoint work',results},null,2));

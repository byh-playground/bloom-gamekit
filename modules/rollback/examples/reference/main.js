import { RoomSession, profiles } from '../../../../dist/rollback.js';
import { createNostrDynamicRoom, createWebRTCPeer } from '../../../../dist/transport.js';
import { createLoop, createDeadlineScheduler, LocalInputPreview } from '../../../../dist/simloop.js';
import {PresentationRuntime} from '../../../../dist/interpolation.js';
import {PresentationEventQueue} from '../../../../dist/presentation-events.js';
import {Actor,codec,createGame,stepWorld,entities,WIDTH,HEIGHT} from './game.js';

const $=id=>document.getElementById(id),canvas=$('simulation'),ctx=canvas.getContext('2d');
let peers=[],rooms=[],abort,serial=0,animation=0,audio=null,stopAt=Infinity,lastDiagnostic=0;
const devices=new Map(),errors=[],impairment={ms:0},liveConnections=new Set();
const fail=error=>{const message=String(error.stack??error);if(!errors.includes(message)&&errors.length<8)errors.push(message);$('error-log').textContent=errors.join('\n');$('error-log').hidden=false;};
const status=text=>{$('connection-status').textContent=text;};

// Local mode substitutes SDP/ICE routing only. Every game packet still crosses real WebRTC.
// Online mode uses the default Nostr signaler; neither path implements a synchronization engine.
function localSignaling(){const handlers=new Map();let n=0;return async()=>{
  const id=['a','b'][n++];return{id,send:async(to,message)=>{for(const [other,receive]of handlers)if(other!==id&&(!to||to==='*'||to===other))queueMicrotask(()=>receive({from:id,to,message:structuredClone(message)}));},subscribe(fn){handlers.set(id,fn);return()=>handlers.delete(id);},close(){handlers.delete(id);}};
};}
async function delayedPeer(options){
  const connection=await createWebRTCPeer(options);liveConnections.add(connection.peerConnection);
  const raw=connection.transport;let queue=[],timer=0,closed=false;
  const flush=()=>{timer=0;while(queue.length&&queue[0].due<=performance.now()){if(raw.send(queue[0].bytes)===false)break;queue.shift();}if(queue.length)timer=setTimeout(flush,Math.max(5,queue[0].due-performance.now()));};
  connection.transport={send(bytes){const delay=options.signaler.id==='a'?impairment.ms:0;if(closed||queue.length>=2048)return false;if(!delay&&!queue.length)return raw.send(bytes);queue.push({bytes:bytes.slice(),due:Math.max(performance.now()+delay,queue.at(-1)?.due??0)});if(!timer)timer=setTimeout(flush,delay);return true;},
    subscribe:fn=>raw.subscribe(fn),subscribeStatus:fn=>raw.subscribeStatus(fn),get state(){return raw.state;},close(){closed=true;clearTimeout(timer);queue=[];raw.close();}};
  const close=connection.close;connection.close=()=>{connection.transport.close();liveConnections.delete(connection.peerConnection);close();};return connection;
}
function eventKey(e){return JSON.stringify([e.tick,e.sequence,e.entityId,e.generation,e.kind]);}
function journalFor(peer){
  const particle={reversible:true,start(e,now){const key=eventKey(e);if(peer.particles.has(key))peer.stats.duplicateParticles++;peer.particles.add(key);if(peer.particles.size>256)peer.particles.delete(peer.particles.values().next().value);peer.stats.particleStarts++;const h={...e.payload,at:now,kind:e.kind,key:eventKey(e)};peer.effects.add(h);return h;},
    reconcile(h,e,old,now){peer.stats.particleReconciles++;Object.assign(h,e.payload);},
    stop(h){peer.stats.particleStops++;peer.effects.delete(h);}};
  return new PresentationEventQueue({retentionTicks:120,maxPending:2048,adapters:{particle,instant:particle,
    sound:{start(e){const key=eventKey(e);if(peer.sounds.has(key))peer.stats.duplicateSounds++;peer.sounds.add(key);if(peer.sounds.size>256)peer.sounds.delete(peer.sounds.values().next().value);peer.stats.soundStarts++;
      // Irreversible sound is confirmed-only. Local two-peer mode sounds one perspective.
      if(audio&&$('sound').checked&&peer===peers[0]){const osc=audio.createOscillator(),gain=audio.createGain();osc.frequency.value=420;gain.gain.setValueAtTime(.025,audio.currentTime);gain.gain.exponentialRampToValueAtTime(.001,audio.currentTime+.07);osc.connect(gain).connect(audio.destination);osc.onended=()=>{osc.disconnect();gain.disconnect();};osc.start();osc.stop(audio.currentTime+.08);}
    }}}});
}
function installPeer(room,tps){
  const stepMs=1000/tps,id=room.localPlayerId,device={axis:0,commands:[]};devices.set(id,device);
  const peer={id,room,tps,stepMs,effects:new Set(),sounds:new Set(),particles:new Set(),revision:0,sequence:0,needsReset:'reset',publishedTick:-1,epoch:-1,teleports:new Map(),
    stats:{frames:0,projectileFrames:0,retainedFrames:0,previewFrames:0,releases:0,rollbacks:0,particleStarts:0,particleStops:0,particleReconciles:0,soundStarts:0,duplicateSounds:0,duplicateParticles:0,optionalFrames:0,pathCorners:0},submission:[],display:{},status:'joining'};
  peer.journal=journalFor(peer);
  peer.game=createGame(stepMs,e=>peer.journal.emit(e));
  peer.presentation=new PresentationRuntime({stepMs,delayMs:stepMs,snapDistance:300});
  // Disable pacing holds here to demonstrate rollback on late changed input.
  peer.session=new RoomSession({mode:'online',room,inputSize:1,simulationVersion:'reference-v2-'+tps,seed:42,adapter:peer.game,
    profile:{...profiles.action,mode:'rollback',tickRate:tps,baseInputDelayTicks:1,minInputDelayTicks:1,maxInputDelayTicks:1,adaptiveInputDelay:false,rollbackWindowTicks:16,stateHistorySize:128,checksumInterval:10,pacingPolicy:'none'},membership:{maxPlayers:2},
    onEvent(e){try{
      if(e.type==='rollback'){
        peer.stats.rollbacks++;peer.needsReset='rollback';
        peer.journal.beginRollback(Math.max(e.from,peer.journal.confirmedTick+1));peer.inRollback=true;
      }
      if(e.type==='reconciled'){if(peer.inRollback)peer.journal.endRollback();peer.inRollback=false;peer.needsReset='rollback';}
      if(e.type==='membership-committed'||e.type==='recovered'){
        peer.journal.dispose();peer.effects.clear();peer.journal=journalFor(peer);peer.inRollback=false;peer.needsReset='reset';
      }
      if(e.type==='input-submitted'&&e.commands?.length){peer.submission.push({tick:e.tick,T:e.executeTick,commands:e.commands});if(peer.submission.length>16)peer.submission.shift();}
      if(['fatal','version-mismatch','handshake-mismatch','desync-unrecoverable'].includes(e.type))throw Error(e.type);
    }catch(error){fail(error);}}});
  const snapshot=()=>peer.game.save();
  peer.preview=new LocalInputPreview({presentation:peer.presentation,stepMs,maxAgeMs:1600,maxFutureTicks:16,maxPendingInputs:16,captureSnapshot:snapshot,cloneSnapshot:b=>b.slice(),
    isActive:fork=>!!fork.world.actors[id]?.action,
    createFork(bytes){let world=codec.decode(bytes);return{get world(){return world;},restore(b){world=codec.decode(b);},step(input,context){
      // Same update, detached world, this player only. No journal/audio/network from this fork.
      stepWorld(world,{tick:context.tick,inputs:[{playerId:id,input,commands:context.commands}]},stepMs);
    }};},readEntities:fork=>{const a=fork.world.actors[id];return a?[{id:'actor:'+id,generation:a.generation,source:a,type:Actor}]:[];}});
  function publish(){
    const session=peer.session;if(!session.ready||session.resimulating)return;
    if(peer.publishedTick===session.tick&&!peer.needsReset)return;
    const reset=peer.needsReset|| (peer.epoch!==session.epoch?'reset':null),now=performance.now();
    if(reset)peer.revision++;
    const list=entities(peer.game.world).map(e=>{
      const a=e.source;
      // Authority teleport discards buffered history immediately. The same serial
      // is a STATE_KEY in Actor, so detached local preview also cuts its pose.
      if(e.id.startsWith('actor:')){e.teleport=peer.teleports.has(e.id)&&peer.teleports.get(e.id)!==a.teleportSerial;peer.teleports.set(e.id,a.teleportSerial);}
      if(reset){delete e.pathPoints;delete e.initialSource;delete e.initialTimeMs;}
      else peer.stats.pathCorners+=e.pathPoints?.length??0;
      return e;
    });
    peer.presentation.capture({revision:peer.revision,sequence:++peer.sequence,timeMs:session.tick*stepMs,mode:reset==='rollback'?'rollback':reset?'reset':'continuous',entities:list},now);
    const local=session.localInputState;
    // Deliberately full checkpoints: no guessed remote continuation key / stale fork optimization.
    peer.preview.reconcile({snapshot:snapshot(),revision:peer.revision,tick:session.tick,epoch:session.epoch,mode:reset==='rollback'?'rollback':reset?'reset':'continuous',
      input:local.replayInput??local.executedInput,confirmedCommandSequence:local.executedCommandSequence??undefined,timeMs:now});
    peer.publishedTick=session.tick;peer.epoch=session.epoch;peer.needsReset=null;
  }
  peer.loop=createLoop({session:peer.session,inputPreview:peer.preview,rates:{baseHz:120,inputHz:60,renderHz:60},
    canAdvance:()=>peer.session.tick<stopAt,canObserveInput:()=>peer.session.ready&&!peer.session.resimulating&&peer.publishedTick>=0,
    getInput:()=>({input:Uint8Array.of(device.axis),commands:device.commands.splice(0).map(n=>({payload:Uint8Array.of(n)})),predict:device.axis!==0}),
    onAdvance(result){peer.status=result.status;publish();},onInputRelease(){device.axis=0;device.commands=[];},onPreviewError:fail,onError:fail,
    onBacklogDrop(){peer.needsReset='reset';},render(){publish();drawPeer(peer);}});
  publish();
  // Timer owns input/poll/fixed work; RAF owns drawing. Both use the official loop.
  peer.scheduler=createDeadlineScheduler({getIntervalMs:()=>1000/60,pulse:now=>{peer.loop.pollInput(now);peer.loop.pulse(now,{render:false,input:false});publish();
    if(!peer.inRollback&&peer.session.confirmedTick>=0)peer.journal.confirmThrough(Math.min(peer.session.confirmedTick,peer.session.tick-1));},onGap(){peer.loop.resetTiming();peer.needsReset='reset';},onError:fail});
  peers.push(peer);peer.scheduler.start();return peer;
}
function drawPeer(peer){
  if(peer.publishedTick<0||peer.session.resimulating)return;
  const frame=peer.presentation.frame(performance.now()),models=new Map(),path=[];peer.stats.frames++;
  frame.forEach((m,id,g)=>models.set(id,{m,g}));
  const local=models.get('actor:'+peer.id)?.m;
  const selected=peer.preview.active||peer.preview.pendingCount>0||devices.get(peer.id)?.axis!==0;
  if(selected)peer.stats.previewFrames++;if(peer.wasPreview&&!selected)peer.stats.releases++;peer.wasPreview=selected;
  peer.display={preview:selected,x:local?.x,action:local?.action??null,timeMs:frame.timeMs};
  const index=peers.indexOf(peer);ctx.save();ctx.translate(0,index*(HEIGHT+38));ctx.fillStyle='#8c9eb7';ctx.fillText(`참가자 ${peer.id.slice(0,8)}가 보는 세계 · ${selected?'로컬 preview':'authority'}`,16,18);ctx.translate(0,28);
  ctx.strokeStyle='#33455d';ctx.strokeRect(15,15,WIDTH-30,HEIGHT-30);
  for(const [id,{m,g}]of models){
    if(![m.x,m.y,m.z,m.angle].every(Number.isFinite))throw Error('Non-finite frame pose');
    if(frame.sample(id,g)!==m||frame.modelFor(m)!==m)throw Error('Mixed display frame');
    const radius=id.startsWith('actor:')?13:5;
    if(id.startsWith('shot:')){
      peer.stats.projectileFrames++;if(!peer.game.world.shots.some(s=>s.id===id&&s.generation===g))peer.stats.retainedFrames++;
      frame.pathInto(id,g,path);ctx.strokeStyle=m.color+'66';ctx.beginPath();path.forEach((p,i)=>i?ctx.lineTo(p.x,p.y):ctx.moveTo(p.x,p.y));ctx.stroke();
      const head=path.at(-1);if(head&&(Math.abs(head.x-m.x)>1e-7||Math.abs(head.y-m.y)>1e-7))throw Error('Trail/body time mismatch');
      const target=models.get('actor:'+m.target)?.m;if(target){ctx.setLineDash([3,5]);ctx.beginPath();ctx.moveTo(m.x,m.y-m.z);ctx.lineTo(target.x,target.y-target.z);ctx.stroke();ctx.setLineDash([]);}
    }else if(m.action){peer.stats.optionalFrames++;if(!Number.isFinite(m.action.left/m.action.total))throw Error('Partial optional action');}
    ctx.fillStyle='#0006';ctx.beginPath();ctx.ellipse(m.x,m.y, radius, radius*.4,0,0,Math.PI*2);ctx.fill();
    ctx.save();ctx.translate(m.x,m.y-m.z);ctx.rotate(m.angle);ctx.fillStyle=m.color;ctx.fillRect(-radius,-radius,radius*2,radius*2);ctx.fillStyle='#fff';ctx.fillRect(radius,-2,7,4);ctx.restore();
    if(m.action){ctx.strokeStyle='#fff';ctx.beginPath();ctx.arc(m.x,m.y-m.z,19,0,Math.PI*2*m.action.left/m.action.total);ctx.stroke();}
  }
  peer.journal.update(performance.now());
  for(const e of peer.effects){const age=(performance.now()-e.at)/260;ctx.strokeStyle=e.color;ctx.globalAlpha=Math.max(0,1-age);ctx.beginPath();if(e.kind==='instant'){ctx.moveTo(e.x,e.y);ctx.lineTo(e.x2,e.y2);}else ctx.arc(e.x,e.y,5+age*22,0,Math.PI*2);ctx.stroke();}ctx.globalAlpha=1;ctx.restore();
}
function diagnostic(){return{tps:peers[0]?.tps,connections:[...liveConnections].map(p=>p.connectionState),errors:[...errors],peers:peers.map(p=>({id:p.id,tick:p.session.tick,confirmedTick:p.session.confirmedTick,epoch:p.session.epoch,status:p.session.status,hash:p.session.getStateHash(),rollback:p.stats.rollbacks,preview:p.display.preview,counts:p.game.world.counts,commands:p.game.world.commands,actors:p.game.world.actors,display:p.display,stats:p.stats,submissions:p.submission}))};}
function render(now){try{ctx.clearRect(0,0,canvas.width,canvas.height);peers.forEach(p=>p.loop.render());if(now-lastDiagnostic>150){$('debug-state').textContent=JSON.stringify(diagnostic(),null,2);$('summary').textContent=peers.map(p=>`${p.id.slice(0,8)} tick ${p.session.tick}/${p.session.confirmedTick} · rollback ${p.stats.rollbacks} · preview ${!!p.display.preview} · SFX ${p.stats.soundStarts}`).join(' | ');lastDiagnostic=now;}}catch(e){fail(e);}animation=requestAnimationFrame(render);}
function controls(running){for(const id of ['mode','tps','room-input','start'])$(id).disabled=running;$('stop').disabled=!running;document.querySelectorAll('[data-command], [data-axis], #compare, #delay').forEach(e=>e.disabled=!running);}
function release(){for(const p of peers)p.loop.releaseInput();}
function stop(){serial++;abort?.abort();abort=null;cancelAnimationFrame(animation);release();for(const p of peers){p.scheduler.stop();p.loop.stop();p.preview.dispose();p.journal.dispose();p.session.close();}rooms.forEach(r=>r.close());rooms=[];peers=[];devices.clear();stopAt=Infinity;impairment.ms=0;controls(false);status('중지됨. 두 참가자가 나간 뒤 같은 TPS로 새 방을 시작하세요.');}
async function start(){stop();const token=serial;$('delay').textContent='A → B RTC 송신 지연: 0ms';errors.length=0;$('error-log').hidden=true;$('comparison').textContent='';abort=new AbortController();controls(true);
  const mode=$('mode').value,tps=Number($('tps').value),room=$('room-input').value;$('delay').disabled=mode!=='local';
  audio??=typeof AudioContext==='function'?new AudioContext():null;audio?.resume();
  const options={room,namespace:'bloom-reference-v2-'+tps,maxPlayers:2,signal:abort.signal,retryMs:200,advertiseIntervalMs:500};
  try{
    status(`${tps} TPS 방 준비 중…`);
    const add=async role=>{const r=await createNostrDynamicRoom({...options,role});if(serial!==token){r.close();return;}rooms.push(r);installPeer(r,tps);};
    if(mode==='local'){options.signalerFactory=localSignaling();options.peerFactory=delayedPeer;options.rtcConfig={iceServers:[]};await add('host');await add('join');}
    else await add(mode);
    if(serial!==token)return;canvas.height=(HEIGHT+38)*peers.length;
    document.querySelectorAll('[data-player="b"]').forEach(e=>e.hidden=mode!=='local');
    status(`${tps} TPS · 입력 60Hz / RAF 표시 · 방 ${room} · 실행 중 TPS 변경 불가`);animation=requestAnimationFrame(render);
  }catch(e){if(serial===token){stop();fail(e);}}
}
function peerAt(label){return peers[label==='b'?1:0];}
function observe(label,axis,command){const p=peerAt(label);if(!p?.session.ready)return;const d=devices.get(p.id);if(axis!==undefined)d.axis=axis;if(command)d.commands.push(command);p.loop.observeInput(performance.now());}
document.querySelectorAll('[data-axis]').forEach(b=>{b.onpointerdown=e=>{e.preventDefault();b.setPointerCapture(e.pointerId);observe(b.dataset.player,Number(b.dataset.axis));};for(const event of ['pointerup','pointercancel','lostpointercapture'])b.addEventListener(event,()=>observe(b.dataset.player,0));});
document.querySelectorAll('[data-command]').forEach(b=>b.onclick=()=>observe(b.dataset.player,undefined,Number(b.dataset.command)));
const keys={ArrowLeft:['a',1],ArrowRight:['a',2],KeyA:['b',1],KeyD:['b',2]};
window.addEventListener('keydown',e=>{if(/INPUT|SELECT|TEXTAREA/.test(e.target.tagName))return;if(keys[e.code]){e.preventDefault();observe(...keys[e.code]);}if(!e.repeat&&e.code==='Space'){e.preventDefault();observe('a',undefined,1);}if(!e.repeat&&e.code==='KeyF')observe('a',undefined,2);});
window.addEventListener('keyup',e=>{if(keys[e.code])observe(keys[e.code][0],0);});window.addEventListener('blur',release);
document.addEventListener('visibilitychange',()=>{if(document.hidden)release();else for(const p of peers){p.loop.resetTiming();p.scheduler.rebase();p.needsReset='reset';}});
window.addEventListener('pagehide',()=>{stop();audio?.close();});$('start').onclick=start;$('stop').onclick=stop;
$('delay').onclick=()=>{impairment.ms=impairment.ms?0:240;$('delay').textContent=`A → B RTC 송신 지연: ${impairment.ms}ms`;};
$('compare').onclick=async()=>{
  if(peers.length!==2)return;const comparisonSerial=serial;$('comparison').dataset.result='pending';release();stopAt=Math.max(...peers.map(p=>p.session.tick))+Math.ceil(peers[0].tps*.5);const target=stopAt,deadline=performance.now()+10000;
  while(serial===comparisonSerial&&performance.now()<deadline&&!peers.every(p=>p.session.tick===target&&p.session.confirmedTick>=target-1&&!p.session.resimulating))await new Promise(r=>setTimeout(r,20));
  if(serial!==comparisonSerial)return;
  const snapshot=diagnostic(),equal=snapshot.peers.every(p=>p.tick===target&&p.confirmedTick>=target-1)&&new Set(snapshot.peers.map(p=>p.hash)).size===1;
  $('comparison').dataset.result=equal?'matched':'failed';$('comparison').textContent=`tick ${target} · ${equal?'확정 hash 일치':'아직 불일치'} · ${snapshot.peers.map(p=>p.hash).join(' / ')}`;window.reference.lastComparison=snapshot;stopAt=Infinity;
};
window.reference={get diagnostics(){return diagnostic();},lastComparison:null};controls(false);

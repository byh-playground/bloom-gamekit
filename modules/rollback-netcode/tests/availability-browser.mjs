import { LocalInputPreview } from '../../../dist/simloop.js';
import { PresentationRuntime, RenderObject } from '../../../dist/interpolation.js';
import { Renderer2D } from '../../../dist/rendering.js';
import { createRoomSession, profiles, createValueCodec, createLoop, createDeadlineScheduler } from '../../../dist/rollback-netcode.js';

const codec = createValueCodec(), links = new Map(), events = [];
let session, loop, scheduler, frame, draw, state, renderedFrames = 0, input = 1, costMs = 0, stopped = false, target = Infinity, corruptTick = -1, pauseOnProbe = false, probePaused = false, pulseIntervalMs = 0;
let latency = null;
function stepWorld(world, inputs) { for (const f of inputs) { world.value += f.input[0]; for (const c of f.commands) world.commands.push(f.playerId + ':' + c.sequence + ':' + c.payload[0]); } world.tick++; }
const room = { localPlayerId: '', sessionId: 'availability-browser', coordinatorId: 'A', epoch: 0, players: [], transports: new Map(),
  subscribe() { return () => {}; }, connectMesh() { return Promise.resolve(); },
  setRoster(value) { Object.assign(this, value); }, close() {} };
function adapter(cooperative = false) {
  const implementation = {
  save: () => { const t=performance.now(), data=codec.encode(state);latency?.cost('save',performance.now()-t);return data; }, load: data => { const t=performance.now();state = codec.decode(data);latency?.cost('load',performance.now()-t); },
  validateSnapshot: (data, context) => { try { const candidate = codec.decode(data); return candidate.tick === context.tick && candidate.players.every(id => typeof id === 'string'); } catch { return false; } },
  applyMembership(change) {
    if (state.tick !== change.tick) throw new Error('membership boundary');
    state.epoch = change.epoch; state.players = [...change.players]; state.activePlayers = [...(change.activePlayers ?? change.players)];
  },
  step({ tick, membershipEpoch, inputs, resimulating }) {
    if (tick !== state.tick || membershipEpoch !== state.epoch) throw new Error('simulation boundary');
    const start = performance.now(); while (performance.now() - start < costMs) {}
    stepWorld(state, inputs);latency?.cost(resimulating?'replay':'step',performance.now()-start);latency?.executed(inputs,tick);
    if (tick === corruptTick) state.value += 7;
  },
  };
  if (cooperative) {
    const tokens = new WeakMap();
    implementation.prepareMembershipJob = (change, context) => {
      const original = state; let pulses = 0, done = false, result;
      return { get done() { return done; }, get result() { return result; }, cancel() { done = true; },
        pulse() {
          if (done || ++pulses < 2) return;
          if (state !== original || state.tick !== change.tick) throw new Error('membership job mutated live boundary');
          const candidate = structuredClone(state);
          candidate.epoch = change.epoch; candidate.players = [...change.players]; candidate.activePlayers = [...(change.activePlayers ?? change.players)];
          const prepared = {}; tokens.set(prepared, { candidate, context: structuredClone(context) });
          result = { bytes: codec.encode(candidate), prepared }; done = true; membershipJobs++;
        } };
    };
    implementation.loadPreparedSnapshot = (prepared, context) => {
      const owned = tokens.get(prepared);
      if (!owned || JSON.stringify(owned.context) !== JSON.stringify(context)) throw new Error('membership token context');
      tokens.delete(prepared); state = owned.candidate; membershipInstalls++;
    };
  }
  return implementation;
}
let membershipJobs = 0, membershipInstalls = 0;
window.setup = async (id, players, available = true, autoTransfer = false, cooperative = false, simulationMode = 'lockstep', options = {}) => {
  state = { tick: 0, epoch: -1, players: [], activePlayers: [], value: 0, commands: [] };
  room.localPlayerId = id; room.players = players;
  session = createRoomSession({ mode: 'online', room, simulationVersion: 'availability-v1', inputSize: 1, adapter: adapter(cooperative),
    profile: { ...(simulationMode === 'rollback' ? profiles.action : profiles.lockstep), tickRate: options.tickRate ?? 20, adaptiveInputDelay: options.adaptiveInputDelay ?? true, baseInputDelayTicks: 2, pacingPolicy: 'none', checksumInterval: 10,
      heartbeatMs: 100, peerInterruptMs: 3000, peerTimeoutMs: 15000 }, membership: { reconnectGraceMs: 15000 },
    availability: available ? { mode: 'available', heartbeatMs: 100, silenceMs: 1600, inputGraceMs: 1600, resumeGapMs: 1600,
      roundTimeoutMs: 4500, retryMs: 300, autoTransfer: { enabled: autoTransfer, intervalMs: 600, minTenureMs: 1600, minImprovementMs: 2, minSamples: 8, rttWeight: 0, jitterWeight: 0, stepWeight: 4 } } : {},
    onEvent: event => events.push(event) });
  loop = createLoop({ session, getInput: () => new Uint8Array([input]), canAdvance: () => session.tick < target,
    render: () => { renderedFrames++; document.querySelector('#state').value = `${session.tick}: ${state.value}`; }, onError: error => { window.failure = error.stack; } });
  scheduler = createDeadlineScheduler({ getIntervalMs: () => 50, setTimer: (fn, ms) => setTimeout(fn, Math.max(ms, pulseIntervalMs)), pulse: timestamp => loop.pulse(timestamp, { render: false }),
    onGap: () => loop.resetTiming() });
  draw = timestamp => { if (!stopped) { loop.observeInput(timestamp); loop.render(); frame = requestAnimationFrame(draw); } };
  frame = requestAnimationFrame(draw);
  document.querySelector('#move').onclick = () => { input = 3; session.queueCommand(new Uint8Array([7])); };
  document.addEventListener('visibilitychange', () => {
    if(stopped)return;
    if (document.hidden) loop.releaseInput();
    else { loop.resetTiming(); scheduler.rebase(); scheduler.wake(); }
  });
  window.snapshot = () => ({ state: structuredClone(state), tick: session.tick, hash: session.getStateHash(), confirmedTick: session.confirmedTick, resimulating: session.resimulating, metrics: session.metrics, status: session.status,
    failure: session.failure ?? window.failure, activePlayers: session.activePlayers, coordinatorId: session.coordinatorId, epoch: session.epoch,
    membershipJobs, membershipInstalls, membershipPrepareMs: session.metrics.membershipPrepareMs, maxBoundaryTaskMs: session.metrics.maxBoundaryTaskMs,
    branch: session.metrics.branch, baseTick: session.baseTick, events: events.slice(-24), hidden: document.hidden, renderedFrames, probePaused, stepMs: session.metrics.simulationStepMs });
  window.diagnostics = () => {
    const a = session._availability, r = a?.round, tr = session._transition, now = performance.now();
    return { ...window.snapshot(), pollIdleMs: a ? now - a.lastPoll : null, inputIdleMs: a ? now - a.lastAdvance : null,
      requested: a?.requested, recovering: a?.recovering, pumping: a?.summary(now).pumping, probePaused,
      round: r ? { ageMs: now-r.started, reason:r.reason, participants:r.participants, votes:[...r.votes].map(([id,v])=>({id,tick:v.tick,hash:v.hash,epoch:v.epoch,pumping:v.pumping,eligible:v.eligible})), staged:[...r.staged], decision:r.decision } : null,
      checkpoint: tr ? { target:tr.target, epoch:tr.proposal.epoch, applied:tr.applied, postHash:tr.postHash } : null,
      control: { incoming:session._incoming.length, queuedBytes:session.metrics.controlQueuedBytes, sentBytes:session.metrics.sentControlBytes, receivedBytes:session.metrics.receivedControlBytes },
      links:[...links].map(([id,l])=>({id,connection:l.pc.connectionState,channel:l.channel?.readyState,buffered:l.channel?.bufferedAmount})) };
  };
};
function attach(peerId, channel, pc) {
  const listeners = new Set();
  channel.binaryType = 'arraybuffer';
  const transport = { get state() { return channel.readyState === 'open' ? 'open' : 'connecting'; },
    send(data) { if (channel.readyState !== 'open') return false; const link = links.get(peerId); if (link.blocked) { if (link.saved.length < 64) link.saved.push(data.slice()); return true; } if(latency?.intercept(data,channel))return true;latency?.wire(data, 'sent'); channel.send(data); return true; },
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); } };
  channel.onmessage = event => {
    if(typeof event.data==='string'){latency?.echo(JSON.parse(event.data));return;}
    latency?.wire(new Uint8Array(event.data), 'received', channel);
    const data = new Uint8Array(event.data), view = new DataView(data.buffer);
    if (pauseOnProbe && data.length >= 24 && view.getUint32(0,true) === 0x31524d44 && view.getUint32(16,true) === 0 && view.getUint32(12,true) === data.length-24 && codec.decode(data.subarray(24)).op === 'availability-probe') {
      pauseOnProbe = false; probePaused = true; scheduler.stop();
    }
    if (!links.get(peerId).blocked) for (const fn of listeners) fn(data);
  };
  links.set(peerId, { pc, channel, blocked: false, saved: [] }); room.transports.set(peerId, transport); session._attach(peerId, transport);
}
window.offer = async peerId => { const pc = new RTCPeerConnection({ iceServers: [] }); attach(peerId, pc.createDataChannel('room', { ordered: true }), pc); await pc.setLocalDescription(await pc.createOffer()); await gathered(pc); return pc.localDescription.toJSON(); };
window.answer = async (peerId, offer) => { const pc = new RTCPeerConnection({ iceServers: [] }); pc.ondatachannel = e => attach(peerId, e.channel, pc); links.set(peerId, { pc }); await pc.setRemoteDescription(offer); await pc.setLocalDescription(await pc.createAnswer()); await gathered(pc); return pc.localDescription.toJSON(); };
window.accept = (id, answer) => links.get(id).pc.setRemoteDescription(answer);
async function gathered(pc) { if (pc.iceGatheringState === 'complete') return; await new Promise(resolve => pc.addEventListener('icegatheringstatechange', () => { if (pc.iceGatheringState === 'complete') resolve(); })); }
window.block = (ids, blocked, replay = false) => { for (const id of ids) { const link = links.get(id); link.blocked = blocked; if (!blocked) { if (replay) for (const packet of link.saved) link.channel.send(packet); link.saved = []; } } };
window.setTarget = tick => { target = tick; };
window.setCost = ms => { costMs = ms; };
window.corruptAt = tick => { corruptTick = tick; };
window.stopPump = () => { scheduler.stop(); };
window.setPulseInterval = ms => { scheduler.stop(); pulseIntervalMs = ms; scheduler.start(); };
window.pausePumpOnProbe = () => { pauseOnProbe = true; };
window.stopRender = () => cancelAnimationFrame(frame);
window.resumeRender = () => { frame = requestAnimationFrame(draw); };
window.resumePump = () => { scheduler.stop(); loop.resetTiming(); scheduler.start(); };
window.startPump = () => scheduler.start();
window.stop = () => { stopped = true; loop.stop(); latency?.dispose(); scheduler.stop(); cancelAnimationFrame(frame); session.close(); for (const link of links.values()) link.pc.close(); };
window.rtcStats = async () => { let bytesSent = 0; for (const link of links.values()) (await link.pc.getStats()).forEach(row => { if (row.type === 'data-channel') bytesSent += row.bytesSent ?? 0; }); return { connections: links.size, bytesSent }; };

// Extends the existing two-page RoomSession/RTC fixture, using the same game step.
window.setupLatency = async (id, players, rates) => {
  await window.setup(id, players, false, false, false, 'rollback', {tickRate:rates.simulationHz,adaptiveInputDelay:false});
  loop.stop(); cancelAnimationFrame(frame); input=0;
  const traces=new Map(), edges=[], counters={samples:0,pulses:0,advances:0,rendered:0,authoritySaves:0,previewSteps:0,previewMs:0,maxRafGapMs:0};
  let measurement=null, row=new Uint8Array(640*4), observation=0, capture=0, lastRender=-Infinity, nextInput=0, firstPulse=null, lastPulse=0, shown=40;
  const costs={}, faults={hold:false,packets:[],replays:0}, receipts=[];
  const dt=1000/rates.simulationHz, canvas=document.createElement('canvas');canvas.width=640;canvas.height=96;canvas.style.width='640px';canvas.style.height='96px';document.body.append(canvas);
  const renderer=new Renderer2D(canvas,{preserveDrawingBuffer:true,antialias:false});renderer.resize(640,96,1);
  class Unit extends RenderObject { static renderSchema={x:this.POSITION_X,y:this.POSITION_Y};constructor(x){super();this.x=x;this.y=40;}render(r,m){r.rect(m.x,m.y,12,16,[1,.2,.1,1]);} }
  const unit=new Unit(40), presentation=new PresentationRuntime({stepMs:dt,snapDistance:500});
  const entities=source=>[{id,generation:0,source}], bytes=()=>{counters.authoritySaves++;return codec.encode(state);};
  const preview=new LocalInputPreview({presentation,stepMs:dt,maxAgeMs:2000,maxFutureTicks:16,maxPendingInputs:64,
    createFork:snapshot=>{let world=codec.decode(snapshot);const source=new Unit(40+world.value*.1);return{source,restore:b=>{world=codec.decode(b);source.x=40+world.value*.1;},step:(held,ctx)=>{const start=performance.now();stepWorld(world,players.map(playerId=>({playerId,input:playerId===id?held:Uint8Array.of(0),commands:playerId===id?ctx.commands:[]})));source.x=40+world.value*.1;counters.previewSteps++;counters.previewMs+=performance.now()-start;for(const command of ctx.commands){const trace=traces.get(command.payload[0]);if(trace)trace.predicted??=performance.now();}}};},
    readEntities:fork=>{const trace=traces.get(observation);if(trace)trace.forecastX??=fork.source.x;return entities(fork.source);}});
  const reconcile=mode=>preview.reconcile({snapshot:bytes(),input:session.localInputState.replayInput??Uint8Array.of(0),revision:0,tick:session.tick,epoch:session.epoch,timeMs:performance.now(),mode});
  presentation.capture({revision:0,sequence:0,timeMs:0,entities:entities(unit)},performance.now());reconcile('reset');
  loop=createLoop({session,inputPreview:preview,getInput(){counters.samples++;return{input:Uint8Array.of(input),commands:edges.splice(0)};},
    canAdvance:()=>session.tick<target,onPreviewError:e=>{throw e;},onError:e=>{window.failure=e.stack;},
    onAdvance(result){if(result.status!=='advanced')return;counters.advances++;unit.x=40+state.value*.1;presentation.capture({revision:0,sequence:++capture,timeMs:session.tick*dt,entities:entities(unit)},performance.now());reconcile('continuous');},
    render(){counters.rendered++;const now=performance.now();if(counters.lastRender!==undefined)counters.maxRafGapMs=Math.max(counters.maxRafGapMs,now-counters.lastRender);counters.lastRender=now;renderer.beginFrame([0,0,0,1]);presentation.render(unit,renderer,now);renderer.endFrame();shown=presentation.modelFor(unit,now).x;
      const next=new Uint8Array(row.length);renderer.gl.readPixels(0,48,640,1,renderer.gl.RGBA,renderer.gl.UNSIGNED_BYTE,next);
      const trace=traces.get(observation);if(trace){if(trace.screen===undefined&&next.some((value,i)=>value!==trace.priorPixels[i]))trace.screen=performance.now();
        if(trace.target90===undefined&&Number.isFinite(trace.forecastX)&&Math.abs(trace.forecastX-trace.priorX)>.05&&Math.abs(shown-trace.priorX)>=.9*Math.abs(trace.forecastX-trace.priorX))trace.target90=performance.now();}
      row=next;
    }});
  scheduler=createDeadlineScheduler({getIntervalMs:()=>1000/Math.max(rates.inputHz,rates.simulationHz),pulse:time=>{firstPulse??=time;lastPulse=time;counters.pulses++;if(time>=nextInput){loop.observeInput(time);nextInput=Math.max(nextInput+1000/rates.inputHz,time);}loop.pulse(time,{render:false,input:false});},onGap:()=>loop.resetTiming()});
  draw=time=>{if(stopped)return;if(time-lastRender>=1000/rates.renderHz-1){lastRender=time;loop.render();}frame=requestAnimationFrame(draw);};frame=requestAnimationFrame(draw);
  function commandIds(data){const view=new DataView(data.buffer,data.byteOffset,data.byteLength);if(data.length<12||view.getUint32(0,true)!==0x314b4252)return[];const type=data[5],ids=[];let offset=12,count=1,size=1;
    if(type===2){count=view.getUint16(16,true);size=view.getUint16(18,true);offset=28;}else if(type===8){size=view.getUint16(20,true);offset=22;}else return ids;
    for(let consumed=0;consumed<count;){const run=type===2?view.getUint16(offset,true):1;if(type===2)offset+=2;offset+=size;const n=view.getUint16(offset,true);offset+=2;for(let i=0;i<n;i++){offset+=4;const length=view.getUint16(offset,true);offset+=2;ids.push(data[offset]);offset+=length;}consumed+=run;}return ids;
  }
  latency={cost(kind,ms){const c=costs[kind]??={calls:0,ms:0,maxMs:0};c.calls++;c.ms+=ms;c.maxMs=Math.max(c.maxMs,ms);},executed(inputs,tick){for(const f of inputs)for(const command of f.commands){const trace=traces.get(command.payload[0]);if(trace){trace.executed??=performance.now();trace.executeTick=tick;}}},intercept(data,channel){const v=new DataView(data.buffer,data.byteOffset,data.byteLength);if(faults.hold&&data.length>=12&&v.getUint32(0,true)===0x314b4252&&(faults.hold==='drafts'?data[5]===8:[2,8].includes(data[5]))){faults.packets.push(data.slice());return true;}return false;},wire(data,kind,channel){for(const commandId of commandIds(data)){if(kind==='sent'){const trace=traces.get(commandId);if(trace)trace.sent??=performance.now();}else{receipts.push({id:commandId,received:performance.now(),type:data[5]});channel.send(JSON.stringify({kind:'input-receipt',id:commandId,remoteReceived:performance.now()}));}}},echo(message){const trace=traces.get(message.id);if(trace&&message.kind==='input-receipt'){trace.echo??=performance.now();trace.remoteReceived??=message.remoteReceived;}},dispose(){preview.dispose();renderer.dispose();}};
  const button=document.querySelector('#move');
  button.onclick=()=>{const marker=Number(button.dataset.marker);input=marker;observation=marker;edges.push({payload:Uint8Array.of(marker)});const trace={id:marker,event:performance.now(),tickBefore:session.tick,priorX:shown,priorPixels:[...row],savesBefore:costs.save?.calls??0};traces.set(marker,trace);loop.observeInput(trace.event);trace.returned=performance.now();trace.tickAfter=session.tick;trace.savesAfter=costs.save?.calls??0;};
  window.inputEvent=marker=>{button.dataset.marker=marker;button.click();};
  window.inputFault=(mode)=>{if(mode==='hold'||mode==='drafts'){faults.hold=mode;faults.packets=[];return;}faults.hold=false;const packets=[...faults.packets];if(mode==='reverse')packets.reverse();for(const data of packets)for(let i=0;i<2;i++){links.get(players.find(p=>p!==id)).channel.send(data);faults.replays++;}return packets.map(data=>({type:data[5],tick:new DataView(data.buffer,data.byteOffset).getUint32(12,true),revision:data[5]===8?new DataView(data.buffer,data.byteOffset).getUint32(16,true):null}));};
  window.beginMeasurement=()=>{measurement={time:performance.now(),tick:session.tick,preview:preview.metrics};for(const key of Object.keys(costs))delete costs[key];for(const key of Object.keys(counters))counters[key]=0;delete counters.lastRender;firstPulse=null;};
  window.latencyReport=()=>({rates,measurement,endTime:performance.now(),traces:[...traces.values()].map(({priorPixels,...trace})=>trace),receipts,costs,faultReplays:faults.replays,counters,firstPulse,lastPulse,tick:session.tick,previewMetrics:preview.metrics,sessionMetrics:session.metrics,hash:session.getStateHash(),commands:state.commands,failure:window.failure??session.failure});
};

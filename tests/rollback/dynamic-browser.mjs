import { createNostrPublicRoom, createNostrSignaler, createWebRTCPeer, createRoomSession, createValueCodec, profiles } from '../../dist/rollback-netcode.js';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
class LocalRelay extends EventTarget {
  static sockets = new Set();
  constructor() { super(); this.readyState = 0; LocalRelay.sockets.add(this); queueMicrotask(() => { if(this.readyState === 0){this.readyState=1;this.dispatchEvent(new Event('open'));} }); }
  deliver(value) { if(this.readyState===1)this.dispatchEvent(new MessageEvent('message',{data:JSON.stringify(value)})); }
  send(text) { const [type,...args]=JSON.parse(text); if(type==='REQ'){this.subscription=args[0];this.filter=args[1];queueMicrotask(()=>this.deliver(['EOSE',this.subscription]));}
    if(type==='EVENT'){const event=args[0];queueMicrotask(()=>{this.deliver(['OK',event.id,true,'']);for(const socket of LocalRelay.sockets)if(socket.filter?.['#d']?.includes(event.tags.find(t=>t[0]==='d')?.[1]))socket.deliver(['EVENT',socket.subscription,event]);});} }
  close(){if(this.readyState===3)return;this.readyState=3;LocalRelay.sockets.delete(this);this.dispatchEvent(new Event('close'));}
}
function assert(value, message) { if (!value) throw new Error(message); }
function actor(prepared = false) {
  const codec = createValueCodec(); let state = { tick:0, epoch:-1, players:[], value:0, commands:[], joins:0, leaves:0, padding:new Uint8Array(32768) };
  let saves=0;
  const actor = { state:()=>state, get saves(){return saves;}, adapter:{
    save(){saves++;return codec.encode(state);}, load:b=>{state=codec.decode(b);},
    validateSnapshot:(b,{tick})=>{try{return codec.decode(b).tick===tick;}catch{return false;}},
    applyMembership({tick,epoch,players,joined,left}){assert(state.tick===tick&&state.epoch+1===epoch,'membership canonical boundary');state.epoch=epoch;state.players=[...players];state.joins+=joined.length;state.leaves+=left.length;},
    step({tick,membershipEpoch,inputs}){assert(tick===state.tick&&membershipEpoch===state.epoch,'global tick/epoch regression');assert(JSON.stringify(inputs.map(i=>i.playerId))===JSON.stringify(state.players),'input roster mismatch');for(const frame of inputs){state.value+=frame.input[0];for(const c of frame.commands)state.commands.push(frame.playerId+':'+c.sequence+':'+c.payload[0]);}state.tick++;}
  }};
  if (prepared) {
    const tokens = new WeakMap(), same = (a,b) => JSON.stringify(a) === JSON.stringify(b);
    const token = (candidate, context) => {
      assert(candidate.tick === context.tick && candidate.epoch === context.membershipEpoch && same(candidate.players, context.players), 'prepared context');
      const key = {}; tokens.set(key, { candidate, context: structuredClone(context) }); return key;
    };
    const job = work => { let done = false, result, pulses = 0; return {
      get done(){return done;}, get result(){return result;}, cancel(){done=true;},
      pulse(){if(!done && ++pulses===2){result=work();done=true;}}
    }; };
    actor.adapter.saveJob = () => job(() => actor.adapter.save());
    actor.adapter.prepareSnapshotJob = (data, context) => job(() => token(codec.decode(data), context));
    actor.adapter.loadPreparedSnapshot = (key, context) => {
      const owned = tokens.get(key); assert(owned && same(owned.context, context), 'owned token binding'); tokens.delete(key); state = owned.candidate;
    };
    actor.adapter.prepareMembershipJob = (change, context) => {
      const original = state;
      return job(() => {
        assert(state === original && state.tick === change.tick, 'no live mutation during prepared job');
        const candidate = structuredClone(state); candidate.epoch=change.epoch;candidate.players=[...change.players];candidate.joins+=change.joined.length;candidate.leaves+=change.left.length;
        return {bytes:codec.encode(candidate),prepared:token(candidate,context)};
      });
    };
  }
  return actor;
}
export async function runDynamicRoomScenario({ prepared = false } = {}) {
  const sessions=[],rooms=[],actors=[],events=[], samples=[]; let timer, target=Infinity, failure=null, maxPulseMs=0, maxCatchupPerPulse=0;
  const namespace='dynamic-e2e-'+crypto.randomUUID(),roomCode=String(Math.floor(Math.random()*10000)).padStart(4,'0');
  const options={room:roomCode,namespace,timeoutMs:30000,peerTimeoutMs:15000,retryMs:100,advertiseIntervalMs:1000,rtcConfig:{iceServers:[]},
    signalerFactory:opts=>createNostrSignaler({...opts,relays:['wss://fixture.invalid'],WebSocketImpl:LocalRelay,publishIntervalMs:0}),
    peerFactory:opts=>createWebRTCPeer({...opts,rtcConfig:{iceServers:[]}})};
  const profile={...profiles.lockstep,baseInputDelayTicks:2,pacingPolicy:'none',checksumInterval:20,stateHistorySize:96,heartbeatMs:30,peerInterruptMs:500,peerTimeoutMs:8000};
  async function add(role, slot = rooms.length){const room=await createNostrPublicRoom({...options,simulationVersion:'dynamic-browser-v1',discoveryMs:150,totalTimeoutMs:30000,leaseMs:1500,reservationMs:15000,resume:{storage:sessionStorage,key:namespace+':actor:'+slot,lifetimeMs:120000}});rooms.push(room);const a=actor(prepared);actors.push(a);const s=createRoomSession({mode:'online',room,adapter:a.adapter,inputSize:1,simulationVersion:'dynamic-browser-v1',profile,
    membership:{transitionTimeoutMs:30000,reconnectGraceMs:10000,maxCatchupSteps:2},onEvent:e=>{if(['membership-committed','membership-failed','partition-failed'].includes(e.type))events.push(e);}});sessions.push(s);return s;}
  function pulse(){const start=performance.now();try{for(const s of sessions)if(!s.closed){const before=s.metrics.bootstrapTicks;s.poll();maxCatchupPerPulse=Math.max(maxCatchupPerPulse,s.metrics.bootstrapTicks-before);if(!s.closed&&s.tick<target&&!s.resimulating)s.advance(new Uint8Array([1]));if(s.failure)throw new Error(JSON.stringify({player:s.localPlayerId,failure:s.failure}));}}catch(error){failure=error;}maxPulseMs=Math.max(maxPulseMs,performance.now()-start);}
  async function until(predicate,label,timeoutMs=35000){const end=performance.now()+timeoutMs;while(!predicate()){if(failure)throw failure;if(performance.now()>end)throw new Error(label+' timeout '+JSON.stringify(sessions.map(s=>({tick:s.tick,epoch:s.epoch,status:s.status,transition:s._transition&&{target:s._transition.target,prepared:s._transition.prepared.size,reached:s._transition.reached.size,installed:s._transition.installed.size,committed:s._transition.committed.size}}))));await sleep(10);}}
  async function checkpoint(label){const active=sessions.filter(s=>!s.closed);target=Math.max(...active.map(s=>s.tick));await until(()=>active.every(s=>s.tick===target),'checkpoint '+label);const hashes=active.map(s=>s.getStateHash());assert(new Set(hashes).size===1,'hash mismatch '+label);samples.push({label,tick:target,hash:hashes[0],players:active.length});target=Infinity;}
  try{
    let host=await add('host');timer=setInterval(pulse,8);await until(()=>host.tick>=75,'single start');
    for(let i=1;i<5;i++){host.queueCommand(new Uint8Array([i]));const joined=await add('join');await until(()=>joined.ready&&host.players.length===i+1&&!host._transition,'sequential join '+(i+1));await until(()=>sessions.every(s=>s.tick>=host.baseTick+25),'post admission advance');await checkpoint('players-'+(i+1));}
    assert(actors.every(a=>a.state().commands.length===4),'pending commands duplicated or lost');
    assert(maxCatchupPerPulse<=2,'bootstrap work exceeded per-pulse bound');
    await rooms[0].reconnect(rooms[2].localPlayerId);await until(()=>sessions.every(s=>s.ready),'retained identity reconnect');await checkpoint('reconnect');
    const oldGuest=sessions[2], guestId=oldGuest.localPlayerId;oldGuest.queueCommand(new Uint8Array([9]));
    await until(()=>actors[0].state().commands.length===5,'pre-refresh command');oldGuest.close();
    const resumedGuest=await add('join',2);assert(resumedGuest.localPlayerId===guestId,'refresh identity changed');
    await until(()=>resumedGuest.ready&&!host._transition,'guest refresh admission');resumedGuest.queueCommand(new Uint8Array([8]));
    await until(()=>actors[0].state().commands.length===6,'post-refresh command');await checkpoint('guest-refresh');
    const oldHostId=host.localPlayerId;host.close();host=await add('host',0);assert(host.localPlayerId===oldHostId,'coordinator refresh identity changed');
    await until(()=>host.ready&&sessions.filter(s=>!s.closed).every(s=>s.ready),'coordinator refresh');await checkpoint('coordinator-refresh');
    // Collect physical RTC traffic while all ten mesh edges still exist.
    let bytesSent=0,connections=0;for(const room of rooms.filter(r=>!r.closed))for(const pc of room.peerConnections.values()){connections++;const stats=await pc.getStats();stats.forEach(row=>{if(row.type==='data-channel')bytesSent+=row.bytesSent||0;});}
    assert(connections===20&&bytesSent>0,'five-player real RTC mesh evidence');
    const departing=host.leave();await until(()=>host.closed&&sessions.filter(s=>!s.closed).every(s=>s.players.length===4&&s.coordinatorId!==host.localPlayerId),'coordinator succession');await departing;
    const prior=Math.max(...sessions.filter(s=>!s.closed).map(s=>s.tick));await until(()=>sessions.filter(s=>!s.closed).every(s=>s.tick>=prior+25),'successor simulation');await checkpoint('coordinator-left');
    assert(actors.filter((a,i)=>!sessions[i].closed).every(a=>a.state().joins===5&&a.state().leaves===1),'membership exactly-once');
    return {passed:true,snapshotPath:prepared?'cooperative fixture':'legacy',transport:'real Chromium RTCPeerConnections; public directory/reservations via signed local Nostr relay fixture',samples,connections:connections/2,bytesSent,maxPulseMs,maxCatchupPerPulse,
      metrics:sessions.map(s=>s.metrics),snapshotSaves:actors.map(a=>a.saves),events};
  }finally{clearInterval(timer);sessions.forEach(s=>s.close());rooms.forEach(r=>r.close());}
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRoomSession } from '../../packages/rollback/src/room-session.js';
import { profiles } from '../../packages/rollback/src/index.js';
const encoder = new TextEncoder(), decoder = new TextDecoder();
function actor(prepared = false) {
  let state = { tick: 0, epoch: -1, players: [], value: 0, commands: [], membership: [] };
  const actor = { state: () => state, adapter: {
    save: () => encoder.encode(JSON.stringify(state)), load: b => { state = JSON.parse(decoder.decode(b)); },
    validateSnapshot: (b, { tick }) => { try { return JSON.parse(decoder.decode(b)).tick === tick; } catch { return false; } },
    applyMembership({ epoch, tick, players, joined, left }) {
      assert.equal(state.tick, tick); assert.equal(state.epoch + 1, epoch);
      state.epoch = epoch; state.players = [...players]; state.membership.push({ epoch, tick, joined, left });
    },
    step({ tick, inputs, membershipEpoch }) {
      assert.equal(state.tick, tick); assert.equal(state.epoch, membershipEpoch); assert.deepEqual(inputs.map(i => i.playerId), state.players);
      for (const frame of inputs) { state.value += frame.input[0]; for (const c of frame.commands) state.commands.push(`${frame.playerId}:${c.sequence}:${c.payload[0]}`); }
      state.tick++;
    }
  } };
  if (prepared) {
    const tokens = new WeakMap();
    const key = context => JSON.stringify(context);
    const prepare = (value, context) => {
      assert.equal(value.tick, context.tick); assert.equal(value.epoch, context.membershipEpoch);
      assert.deepEqual(value.players, context.players);
      const token = {}; tokens.set(token, { value, context: key(context) }); return token;
    };
    actor.adapter.prepareSnapshot = (data, context) => {
      const value = JSON.parse(decoder.decode(data));
      assert.deepEqual(encoder.encode(JSON.stringify(value)), data);
      return prepare(value, context);
    };
    actor.adapter.loadPreparedSnapshot = (token, context) => {
      const owned = tokens.get(token); assert(owned, 'unconsumed owned token');
      assert.equal(owned.context, key(context)); tokens.delete(token); state = owned.value;
    };
    actor.adapter.prepareMembership = (change, context) => {
      assert.equal(state.tick, change.tick); assert.equal(state.epoch + 1, change.epoch);
      const value = structuredClone(state);
      value.epoch = change.epoch; value.players = [...change.players];
      value.membership.push({ epoch: change.epoch, tick: change.tick, joined: change.joined, left: change.left });
      return { bytes: encoder.encode(JSON.stringify(value)), prepared: prepare(value, context) };
    };
  }
  if (prepared === 'jobs') {
    const deferred = work => { let n = 0, result, done = false; return {
      get done() { return done; }, get result() { return result; },
      pulse({ budgetMs }) { assert(budgetMs > 0); if (!done && ++n === 3) { result = work(); done = true; } },
      cancel() { done = true; },
    }; };
    actor.adapter.saveJob = () => deferred(() => actor.adapter.save());
    actor.adapter.prepareSnapshotJob = (data, context) => deferred(() => actor.adapter.prepareSnapshot(data, context));
    actor.adapter.prepareMembershipJob = (change, context) => {
      const before = actor.adapter.save();
      return deferred(() => { assert.deepEqual(actor.adapter.save(), before, 'world frozen through job'); return actor.adapter.prepareMembership(change, context); });
    };
  }
  return actor;
}
function network() {
  const rooms = new Map(), packets = []; let initialId;
  function pair(a, b) {
    if (rooms.get(a).transports.has(b)) return;
    const sides = new Map();
    for (const [self, remote] of [[a,b],[b,a]]) {
      const listeners = new Set(), status = new Set();
      const t = { state: 'open', send(data) { if (t.state !== 'open') return false; packets.push(() => { const other = sides.get(remote); if (other.state === 'open') for (const fn of other.listeners) fn(data.slice()); }); return true; },
        subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }, subscribeStatus(fn) { status.add(fn); return () => status.delete(fn); },
        listeners, close() { t.state = 'closed'; for (const fn of status) fn('closed'); } };
      sides.set(self, t); rooms.get(self).transports.set(remote, t);
    }
    for (const [self, remote] of [[a,b],[b,a]]) for (const fn of rooms.get(self).listeners) fn({ type: 'peer-connected', peerId: remote, transport: sides.get(self) });
  }
  function add(id, resumed = false) {
    const current = initialId && [...rooms.values()].find(r => !r.closed && r.players.includes(r.localPlayerId));
    if (!initialId) initialId = id;
    const room = { resumed, localPlayerId: id, sessionId: 'room', coordinatorId: current?.coordinatorId ?? id, players: current ? [...current.players] : [id], epoch: current?.epoch ?? 0,
      transports: new Map(), listeners: new Set(), subscribe(fn) { room.listeners.add(fn); return () => room.listeners.delete(fn); },
      async connectMesh(ids) { for (let i=0;i<ids.length;i++) for(let j=i+1;j<ids.length;j++) pair(ids[i],ids[j]); },
      setRoster({epoch,players,coordinatorId}) { room.epoch=epoch;room.players=[...players];room.coordinatorId=coordinatorId; },
      close() { room.closed=true; for(const t of room.transports.values())t.close(); } };
    rooms.set(id, room); if (current) pair(id, current.coordinatorId === id ? current.localPlayerId : current.coordinatorId); return room;
  }
  return { add, flush() { const batch=packets.splice(0); for(const fn of batch)fn(); }, reconnect(a,b) {
    for(const [self,remote] of [[a,b],[b,a]]) { rooms.get(self).transports.get(remote)?.close();rooms.get(self).transports.delete(remote); } pair(a,b);
  } };
}
const profile = { ...profiles.lockstep, baseInputDelayTicks: 2, checksumInterval: 8, stateHistorySize: 64, pacingPolicy: 'none', heartbeatMs: 10 };
async function harness(prepared = false) {
  const net=network(), sessions=[], actors=[];let now=0;
  const add=(id,resumed=false)=>{const a=actor(prepared),s=createRoomSession({ mode:'online',room:net.add(id,resumed),simulationVersion:'test',inputSize:1,adapter:a.adapter,profile,clock:()=>now,
    membership:{maxCatchupSteps:2,transitionTimeoutMs:20000,reconnectGraceMs:500}});actors.push(a);sessions.push(s);return s;};
  async function pulse(advance=true) { now+=5;net.flush(); for(const s of sessions)if(!s.closed){s.poll(now);if(advance&&!s.closed)s.advance(new Uint8Array([1]));}net.flush();await Promise.resolve(); }
  async function until(fn,limit=3000) {for(let n=0;n<limit;n++){if(fn())return;await pulse();const failed=sessions.filter(s=>s.failure);assert.deepEqual(failed.map(s=>({id:s.localPlayerId,failure:s.failure})),[]);}assert.fail('condition timeout '+JSON.stringify(sessions.map(s=>({id:s.localPlayerId,tick:s.tick,epoch:s.epoch,status:s.status,tr:s._transition&&{target:s._transition.target,prepared:[...s._transition.prepared],reached:[...s._transition.reached],installed:[...s._transition.installed],committed:[...s._transition.committed]}}))));}
  return{net,sessions,actors,add,pulse,until,advanceClock:ms=>{now+=ms;}};
}
for (const prepared of [false, true, 'jobs']) test(`continuous 1 → 2 → 5, pending commands, late checkpoint, reconnect and coordinator departure (prepared=${prepared})`, async()=>{
 const h=await harness(prepared),first=h.add('a'); await h.until(()=>first.tick>=65);
 for(const id of ['b','c','d','e']){first.queueCommand(new Uint8Array([7]));const s=h.add(id);await h.until(()=>s.ready&&first.players.length===h.sessions.length&&!first._transition);await h.until(()=>h.sessions.every(s=>s.tick>=first.baseTick+12));}
 const active=()=>h.sessions.filter(s=>!s.closed);let boundary=Math.max(...active().map(s=>s.tick));
 for(let i=0;i<100;i++){h.net.flush();for(const s of active()){s.poll();if(s.tick<boundary)s.advance(new Uint8Array([1]));}await Promise.resolve();}
 assert(active().every(s=>s.tick===boundary));assert.equal(new Set(active().map(s=>s.getStateHash())).size,1);
 assert(h.actors.every(a=>a.state().membership.length===5));assert(h.actors.every(a=>a.state().commands.length===4));
 h.net.reconnect('a','c');await h.until(()=>active().every(s=>s.ready));
 const leaving=first.leave();await h.until(()=>first.closed&&active().every(s=>s.coordinatorId==='b'&&s.players.length===4));await leaving;
 const previous=active()[0].tick;await h.until(()=>active().every(s=>s.tick>=previous+10));
 boundary=Math.max(...active().map(s=>s.tick));for(let i=0;i<100;i++){h.net.flush();for(const s of active()){s.poll();if(s.tick<boundary)s.advance(new Uint8Array([1]));}await Promise.resolve();}
 assert.equal(new Set(active().map(s=>s.getStateHash())).size,1);assert(active().every(s=>s.epoch===5));
 for(const s of active())s.close();
});
test('local room uses identical membership and fixed lockstep simulation',()=>{
 const a=actor(),s=createRoomSession({simulationVersion:'test',inputSize:1,adapter:a.adapter,profile:{...profile,baseInputDelayTicks:0}});
 for(let i=0;i<100;i++)assert.equal(s.advance(new Uint8Array([2])).status,'advanced');
 assert.equal(a.state().value,200);assert.equal(s.tick,100);assert.equal(s.metrics.snapshotSaves,13);s.close();
});

test('abrupt partition pauses then fails closed without independently removing a member', async()=>{
 const h=await harness(),a=h.add('a'),b=h.add('b');await h.until(()=>b.ready&&a.epoch===1);await h.until(()=>a.tick>15&&b.tick>15);
 b.close();await h.pulse();await h.pulse();const roster=[...a.players],epoch=a.epoch;h.advanceClock(10001);await h.pulse();h.advanceClock(501);await h.pulse();
 assert.equal(a.failure?.type,'partition-failed');assert.deepEqual(a.players,roster);assert.equal(a.epoch,epoch);const tick=a.tick;await h.pulse();assert.equal(a.tick,tick);a.close();
});
for (const prepared of [false, 'jobs']) test(`reload resumes the same actor using a highest confirmed donor and an empty roster delta (prepared=${prepared})`,async()=>{
 const h=await harness(prepared),a=h.add('a'),b=h.add('b');await h.until(()=>b.ready&&a.epoch===1);
 b.queueCommand(new Uint8Array([9]));await h.until(()=>a.tick>40&&b.tick>40);const oldMembership=h.actors[0].state().membership.length;
 b.close();const resumed=h.add('b',true);await h.until(()=>resumed.ready&&a.epoch===2&&!a._transition);
 resumed.queueCommand(new Uint8Array([8]));await h.until(()=>a.tick>=a.baseTick+8&&resumed.tick>=a.baseTick+8);
 assert.equal(h.actors[0].state().membership.length,oldMembership+1);assert.deepEqual(h.actors[0].state().membership.at(-1).joined,[]);
 assert.deepEqual(h.actors[0].state().membership.at(-1).left,[]);assert.deepEqual(h.actors[0].state().commands,['b:1:9','b:2:8']);a.close();resumed.close();
});
for (const prepared of [false, 'jobs']) test(`coordinator reload resumes its room from a surviving member without election (prepared=${prepared})`,async()=>{
 const h=await harness(prepared);let a=h.add('a');const b=h.add('b');await h.until(()=>b.ready&&a.epoch===1);await h.until(()=>a.tick>25&&b.tick>25);
 a.close();a=h.add('a',true);await h.until(()=>a.ready&&b.ready&&a.epoch===2);assert.equal(a.coordinatorId,'a');assert.equal(b.coordinatorId,'a');
 assert.deepEqual(h.actors[1].state().membership.at(-1).joined,[]);a.close();b.close();
});
test('unadmitted control messages cannot change the running membership', async()=>{
 const h=await harness(),a=h.add('a');await h.until(()=>a.tick>8);
 const before=a.tick;a._handle('not-admitted',{sessionId:a.sessionId,contract:a.contract,op:'propose',proposal:{}});
 assert.equal(a.failure,null);assert.equal(a.epoch,0);assert.deepEqual(a.players,['a']);await h.pulse();assert(a.tick>before);a.close();
});
test('membership observer cannot mutate protocol roster arrays',async()=>{
 const h=await harness(),a=h.add('a');a.onEvent=event=>{if(event.type==='membership-preparing')event.proposal.players.push('observer');};
 const b=h.add('b');await h.until(()=>b.ready&&a.epoch===1);assert.deepEqual(a.players,['a','b']);a.close();b.close();
});
test('noncoordinator leave waits for retirement acknowledgement and retains surviving play',async()=>{
 const h=await harness(),a=h.add('a'),b=h.add('b');await h.until(()=>b.ready&&a.epoch===1);const departure=b.leave();await h.until(()=>b.closed&&a.players.length===1);await departure;const tick=a.tick;await h.until(()=>a.tick>tick+5);a.close();
});
test('simultaneously connected candidates queue bounded admission and adopt current epoch before joining',async()=>{
 const h=await harness(),a=h.add('a');await h.until(()=>a.tick>12);const candidates=['b','c','d','e'].map(id=>h.add(id));
 await h.until(()=>a.players.length===5&&h.sessions.every(s=>s.ready));assert(h.sessions.every(s=>s.epoch===4));
 assert(h.actors.every(actor=>actor.state().players.length===5));for(const s of h.sessions)s.close();
});

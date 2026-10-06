import {createSession,createSyncTestSession,profiles,SimulationAdapter,SessionEvent,Transport,createNostrRoom,createLoop,runSyncTest,runSyncTestAsync,SyncTestMetrics} from '../../packages/rollback-netcode/rollback-netcode.js';
const adapter:SimulationAdapter={save:()=>new Uint8Array(8),load:()=>{},step:context=>context.tick,validateSnapshot:()=>true};
const event=(value:SessionEvent)=>{if(value.type==='peer-timeout')value.silenceMs;if(value.type==='desync-unrecoverable')value.attempts};
const transport:Transport={send:()=>true,subscribe:()=>()=>{}};
const session=createSession({players:['a','b'],localPlayerId:'a',sessionId:'types',simulationVersion:'1',inputSize:1,adapter,profile:profiles.rts,onEvent:event});
session.attachTransport('b',transport);session.advance(new Uint8Array(1));session.getPeerState('b')?.ackTick;
// @ts-expect-error logical ticks belong to the Core
session.tick=4;
// @ts-expect-error renderer is not an Adapter capability
createSession({players:['a'],localPlayerId:'a',sessionId:'bad',simulationVersion:'1',inputSize:1,adapter:{render(){}}});
createSyncTestSession({players:['a'],inputSize:1,adapter}).advance([{playerId:'a',input:new Uint8Array(1)}]);
createSession({players:['a'],localPlayerId:'a',sessionId:'prediction',simulationVersion:'1',inputSize:1,adapter,
  profile:{predictionPolicy:({previousInput,lastConfirmedTick})=>lastConfirmedTick>=0?previousInput:new Uint8Array(1)}});
createNostrRoom({role:'host'}).then(room=>room.close());

const loop=createLoop({session,beforeFrame:timestamp=>timestamp,canAdvance:()=>true,onAdvance:result=>result.tick});
loop.pulse(100);loop.resetTiming();
const diagnostics=runSyncTest({players:['a'],inputSize:1,adapter,frames:[]}).metrics;
const metrics:SyncTestMetrics=diagnostics;
// @ts-expect-error metrics snapshots are readonly
metrics.checkedTicks=2;
createSyncTestSession({players:['a'],inputSize:1,adapter,now:()=>0}).metrics.failure?.firstDifference;

runSyncTestAsync({players:['a'],inputSize:1,adapter,frames:[],yieldControl:async()=>{},signal:new AbortController().signal}).then(result=>result.metrics.checkedTicks);

session.exportSyncTestFrames({maxFrames:32}).frames[0]?.inputs[0]?.input;

import {createNostrGroupRoom, GroupRoom} from '../../packages/rollback-netcode/rollback-netcode.js';
createNostrGroupRoom({role:'host',playerCount:4,topology:'star',onStatus:s=>s.players?.length}).then((room:GroupRoom)=>{
  const group=createSession({players:[...room.players],localPlayerId:room.localPlayerId,authorityPlayerId:room.authorityPlayerId,
    sessionId:room.sessionId,simulationVersion:'group-v1',inputSize:1,adapter});
  for(const [id,transport] of room.transports)group.attachTransport(id,transport);
  room.peerConnections.get(room.hostPlayerId)?.getStats();room.metrics?.forwardedFrames;room.close();
  // @ts-expect-error participant roster is immutable
  room.players.push('late');
});
// @ts-expect-error supported transport topologies are explicit
createNostrGroupRoom({role:'host',topology:'server'});

const scalarPace:number=session.pace;
// @ts-expect-error pacing multiplier is readonly
session.pace=2;
createLoop({session,backlogPolicy:'retain'});
// @ts-expect-error backlog policies are explicit
createLoop({session,backlogPolicy:'unbounded'});

import {createBootstrapReplay,createRoomSession,createNostrDynamicRoom,ConfirmedBootstrap,
  LocalCommandState,RoomSimulationAdapter,DynamicRoom,RoomSession} from '../../packages/rollback-netcode/rollback-netcode.js';
const bootstrap:ConfirmedBootstrap=session.exportConfirmedBootstrap();
const handoff:LocalCommandState=session.exportLocalCommandState();
handoff.commands[0]?.payload.byteLength;
createSession({players:['a'],localPlayerId:'a',sessionId:'next-epoch',simulationVersion:'1',inputSize:1,adapter,
  profile:profiles.lockstep,localCommandState:handoff});
const catchup=createBootstrapReplay({adapter,bootstrap,maxCatchupSteps:4,maxSuffixTicks:32,
  simulationVersion:'1',inputSize:1,tickRate:20,players:['a'],seed:1});
catchup.pulse().steps;catchup.result?.hash;catchup.failure?.message;catchup.cancel();
// @ts-expect-error catch-up progress is owned by the replay job
catchup.tick=2;
// @ts-expect-error a confirmed bootstrap never contains predicted inputs
bootstrap.frames[0].inputs[0].predicted=true;
const roomAdapter:RoomSimulationAdapter={...adapter,
  step:context=>{context.membershipEpoch;return context.tick;},
  validateSnapshot:(_bytes,context)=>context.tick>=0,
  applyMembership:context=>{context.joined.forEach(id=>id);context.coordinatorId;context.epoch;}};
const localRoom:RoomSession=createRoomSession({mode:'local',simulationVersion:'room-v1',inputSize:1,adapter:roomAdapter,
  membership:{maxPlayers:5,maxCatchupSteps:2},onEvent:context=>context.epoch});
createLoop({session:localRoom,onAdvance:result=>result.status==='membership',render:context=>context.session.epoch}).pulse(50);
localRoom.getStateHash();localRoom.metrics.bootstrapTicks;localRoom.queueCommand(new Uint8Array([1]));localRoom.leave();
// @ts-expect-error a room adapter must apply deterministic membership changes
createRoomSession({simulationVersion:'missing-membership',inputSize:1,adapter});
// @ts-expect-error room modes are explicit
createRoomSession({mode:'rollback',simulationVersion:'bad-mode',inputSize:1,adapter:roomAdapter});
// @ts-expect-error membership roster is immutable
localRoom.players.push('unadmitted');
createNostrDynamicRoom({role:'host',maxPlayers:5,maxPendingPeers:3,onStatus:status=>status.transport?.state}).then((room:DynamicRoom)=>{
  const online=createRoomSession({mode:'online',room,simulationVersion:'room-v1',inputSize:1,adapter:roomAdapter});
  room.subscribe(event=>event.peerId);room.connectMesh([...room.players]);room.reconnect(room.coordinatorId);
  room.setRoster({epoch:room.epoch+1,players:[...room.players],coordinatorId:room.coordinatorId});
  room.metrics.signalBacklogBytes;room.peerConnections.get(room.coordinatorId)?.getStats();online.close();
  // @ts-expect-error dynamic roster is immutable
  room.players.push('unadmitted');
});
const sequenceBaselines:Record<string,number>=session.getCommandSequences();
const lastExecuted:number=bootstrap.commandSequences.a;
createSession({players:['a'],localPlayerId:'a',sessionId:'restored-epoch',simulationVersion:'1',inputSize:1,adapter,
  profile:profiles.lockstep,initialCommandSequences:sequenceBaselines,localCommandState:handoff});
createNostrDynamicRoom({role:'join',room:'1234',resume:{storage:sessionStorage,key:'room-tab',lifetimeMs:3600000},resumeProbeMs:500}).then(room=>{
  const resumed:boolean=room.resumed;const donor:string|null=room.resumePeerId;
  room.forgetResume();room.disconnect('departed');
});
// @ts-expect-error reload resume requires explicit storage
createNostrDynamicRoom({role:'join',room:'1234',resume:{}});

// 공개 Start도 같은 RoomSession adapter/loop 경계를 사용한다.
async function publicRoomExample(adapter: import('../../packages/rollback-netcode/rollback-netcode.js').RoomSimulationAdapter) {
  const sdk = await import('../../packages/rollback-netcode/rollback-netcode.js');
  const room = await sdk.createNostrPublicRoom({ namespace: 'example-game', simulationVersion: 'rules-v1', maxPlayers: 5,
    resume: { storage: sessionStorage, key: 'example-room', lifetimeMs: 3600000 } });
  const session = sdk.createRoomSession({ mode: 'online', room, adapter, simulationVersion: 'rules-v1', inputSize: 1 });
  sdk.createLoop({ session }); await session.leave();
}
void publicRoomExample;

import {createValueCodec} from '../../../dist/rollback-netcode.js';
import {RenderObject as R} from '../../../dist/interpolation.js';

// Game-owned rules/data only. No clock, DOM, network, audio or live-world preview writes.
export const codec=createValueCodec(), WIDTH=720, HEIGHT=280;
export class Actor extends R {
  static renderSchema={id:R.STEP,generation:R.STEP,x:R.POSITION_X,y:R.POSITION_Y,z:R.POSITION_Z,angle:R.ANGLE,color:R.STEP,
    'action.kind':R.STATE_KEY,'action.sequence':R.STATE_KEY,'action.left':R.COUNTDOWN_MS,'action.total':R.STATE_KEY,
    teleportSerial:R.STEP};
}
export class Shot extends R {
  static renderSchema={owner:R.STEP,target:R.STEP,x:R.POSITION_X,y:R.POSITION_Y,z:R.POSITION_Z,angle:R.ANGLE,
    originX:R.ORIGIN_X,originY:R.ORIGIN_Y,originZ:R.ORIGIN_Z,color:R.STEP};
  static renderPath={x:'x',y:'y',durationMs:220,maxPoints:32};
}
export function newWorld(){return{version:2,tick:0,epoch:0,players:[],actors:{},shots:[],commands:[],counts:{},teleports:0};}
export function membership(world,change){
  world.tick=change.tick;world.epoch=change.epoch;world.players=[...change.players];
  for(const id of change.left){delete world.actors[id];delete world.counts[id];}
  for(const id of change.joined){const index=world.players.indexOf(id);world.actors[id]={id,generation:change.epoch,x:index?540:180,y:index?200:80,z:0,angle:index?Math.PI:0,color:index?'#92c5ff':'#c8ef95',action:null,shotGeneration:0,teleportSerial:0};world.counts[id]={dash:0,fire:0,spark:0,teleport:0};}
  world.shots=world.shots.filter(s=>world.players.includes(s.owner));
}
export function stepWorld(world,{tick,inputs},stepMs,emit=()=>{}){
  if(tick!==world.tick)throw Error('Game snapshot/tick boundary');
  const seconds=stepMs/1000;
  for(const frame of [...inputs].sort((a,b)=>a.playerId<b.playerId?-1:a.playerId>b.playerId?1:0)){
    const a=world.actors[frame.playerId];if(!a)throw Error('Unknown input owner');
    const axis=frame.input[0]===1?-1:frame.input[0]===2?1:0;
    if(axis)a.angle=axis<0?Math.PI:0;
    for(const c of frame.commands){
      // Commands keep the SDK-assigned immutable T, including resimulation and fork replay.
      if(c.executeTick!==undefined&&c.executeTick!==tick)throw Error('Command executed outside reserved T');
      const kind=['','dash','fire','teleport','spark'][c.payload[0]];if(!kind)throw Error('Unknown command');
      world.counts[a.id][kind]++;world.commands.push({owner:a.id,sequence:c.sequence??-1,tick,kind});if(world.commands.length>64)world.commands.shift();
      const event={tick,sequence:c.sequence??0,entityId:a.id,generation:a.generation,payload:{x:a.x,y:a.y,z:0,color:a.color}};
      emit({...event,kind:'sound',policy:'confirmed',durationMs:0});
      emit({...event,kind:'particle',policy:'speculative',durationMs:260});
      if(kind==='teleport'){a.x=a.x<360?590:130;a.teleportSerial++;world.teleports++;a.action=null;}
      else if(kind==='spark'){
        // Born AND gone inside this tick: no endpoint snapshot can infer it.
        // Supply a timed, fixed anchor explicitly; confirmed journal owns delivery.
        emit({...event,kind:'instant',policy:'confirmed',durationMs:240,payload:{...event.payload,x2:a.x+Math.cos(a.angle)*55,y2:a.y}});
      }else a.action={kind,sequence:c.sequence??0,left:kind==='dash'?360:180,total:kind==='dash'?360:180};
    }
    const dash=a.action?.kind==='dash';a.x=Math.max(35,Math.min(WIDTH-35,a.x+(dash?Math.cos(a.angle)*310:axis*110)*seconds));
    if(a.action){a.action.left=Math.max(0,a.action.left-stepMs);if(a.action.left===0){
      if(a.action.kind==='fire'){
        const target=world.players.find(id=>id!==a.id)??a.id,b=world.actors[target];
        const angle=target===a.id?a.angle:Math.atan2(b.y-a.y,b.x-a.x);
        world.shots=world.shots.filter(s=>s.owner!==a.id);
        world.shots.push({id:'shot:'+a.id,generation:++a.shotGeneration,owner:a.id,target,color:a.color,
          x:a.x,y:a.y,z:0,originX:a.x,originY:a.y,originZ:0,angle,age:0,bornMs:tick*stepMs,pathPoints:[]});
      }
      a.action=null; // object→null is deliberately visible through delayed authority / preview release.
    }}
  }
  for(const s of world.shots){
    s.pathPoints=[];const vx=Math.cos(s.angle)*760,vy=Math.sin(s.angle)*760,edge=vx>0?WIDTH-15:15;
    const until=vx?(edge-s.x)/vx:Infinity;
    if(until>=0&&until<seconds){
      s.x=edge;s.y+=vy*until;
      // The renderer cannot invent a within-tick bounce. This exact corner is game data.
      s.pathPoints.push({timeMs:tick*stepMs+until*1000,x:s.x,y:s.y});
      s.angle=Math.PI-s.angle;s.x-=vx*(seconds-until);s.y+=vy*(seconds-until);
    }else{s.x+=vx*seconds;s.y+=vy*seconds;}
    s.age+=stepMs;s.z=45*Math.sin(Math.PI*Math.min(1,s.age/1000));
  }
  world.shots=world.shots.filter(s=>s.age<1000);world.tick=tick+1;
}
export function createGame(stepMs,emit=()=>{}){
  let world=newWorld();
  return{get world(){return world;},save:()=>codec.encode(world),load:bytes=>{world=codec.decode(bytes);},
    validateSnapshot(bytes,{tick}={}){try{const w=codec.decode(bytes);return w.version===2&&Number.isSafeInteger(w.tick)&&w.tick>=0&&(tick===undefined||w.tick===tick)&&w.players.every(id=>[w.actors[id].x,w.actors[id].y].every(Number.isFinite));}catch{return false;}},
    applyMembership:change=>membership(world,change),
    step:frame=>stepWorld(world,frame,stepMs,frame.recovering||frame.replaying?()=>{}:emit)};
}
export function entities(world){return[
  ...world.players.map(id=>({id:'actor:'+id,generation:world.actors[id].generation,type:Actor,source:world.actors[id]})),
  ...world.shots.map(s=>({id:s.id,generation:s.generation,type:Shot,source:s,initialTimeMs:s.bornMs,
    initialSource:{...s,x:s.originX,y:s.originY,z:s.originZ},pathPoints:s.pathPoints}))];}

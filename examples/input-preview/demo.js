import { ActionState, createDOMInput } from '../../dist/input.js';
import { Renderer2D } from '../../dist/rendering.js';
import { PresentationRuntime, RenderObject } from '../../dist/interpolation.js';
import { LocalInputPreview, createLoop } from '../../dist/simloop.js';
import { createSession, hashBytes, profiles } from '../../dist/rollback-netcode.js';
const DT=100,encoder=new TextEncoder(),decoder=new TextDecoder();
class Unit extends RenderObject {
 constructor(color){super();this.x=80;this.y=100;this.direction=1;this.roll={progress:0};this.flash=0;this.color=color;}
 static renderSchema={x:this.POSITION_X,y:this.POSITION_Y,direction:this.STEP,'roll.progress':this.CYCLE,flash:this.DECAY,color:this.STEP};
 render(r,m){r.rect(m.x,m.y,24,28,m.flash?[1,.65,.2,1]:m.color);r.rect(m.x+m.direction*13,m.y-19,11,3,[1,1,1,.85]);}
}
function stepUnit(unit,input,commands=[]){const axis=input[0]===1?-1:input[0]===2?1:0;if(axis)unit.direction=axis;unit.x+=axis*20;
 if(commands.some(c=>c.payload[0]===1)){unit.x+=unit.direction*22;unit.roll.progress=.01;unit.flash=1}else{unit.roll.progress=(unit.roll.progress+.18)%1;unit.flash=Math.max(0,unit.flash-.2)}
 if(unit.x<24||unit.x>696){unit.x=Math.max(24,Math.min(696,unit.x));unit.direction*=-1;unit.flash=1;}}
export function startInputPreviewDemo(canvas,status){
 const renderer=new Renderer2D(canvas,{antialias:false,preserveDrawingBuffer:true});renderer.resize(canvas.clientWidth,canvas.clientHeight,devicePixelRatio||1);
 const actions=new ActionState(),input=createDOMInput({target:canvas,state:actions,keys:{KeyA:'left',ArrowLeft:'left',KeyD:'right',ArrowRight:'right',Space:'roll'}});
 let unit,remote,presentation,preview,session,loop,enabled=true,frames=0,pose={},captureSequence=0,worldTick=0,forkCreates=0,forkRestores=0;
 const snapshot=()=>encoder.encode(JSON.stringify({unit,tick:worldTick}));
 const continuationKey='remote-inputs:stable';
 const checkpoint=mode=>preview.reconcile({snapshot:snapshot(),input:session.localInputState.replayInput??session.localInputState.executedInput,revision:0,tick:session.tick,epoch:0,continuationKey,timeMs:performance.now(),mode,
   confirmedCommandSequence:session.localInputState.executedCommandSequence});
 function start(){
  unit=new Unit([.25,.55,1,1]);remote=new Unit([.9,.25,.25,1]);remote.x=575;remote.y=150;captureSequence=0;worldTick=0;
  presentation=new PresentationRuntime({stepMs:DT,snapDistance:180});
  const adapter={save:snapshot,validateSnapshot(bytes){try{const data=JSON.parse(decoder.decode(bytes)),u=data.unit;return Number.isSafeInteger(data.tick)&&data.tick>=0&&[u.x,u.y,u.direction,u.roll?.progress,u.flash].every(Number.isFinite)&&Array.isArray(u.color)&&u.color.length===4&&u.color.every(Number.isFinite)}catch{return false}},load(bytes){const data=JSON.parse(decoder.decode(bytes));Object.assign(unit,data.unit);worldTick=data.tick},step(frame){if(frame.tick!==worldTick)throw Error('Authority tick boundary');stepUnit(unit,frame.inputs[0].input,frame.inputs[0].commands);worldTick++;}};
  session=createSession({players:['local'],localPlayerId:'local',sessionId:'preview',simulationVersion:'preview-v2',seed:1,inputSize:1,adapter,recordReplay:false,
    profile:{...profiles.lockstep,tickRate:10,maxCatchupSteps:1,baseInputDelayTicks:2,minInputDelayTicks:2,maxInputDelayTicks:2,adaptiveInputDelay:false,pacingPolicy:'none',checksumInterval:1}});
  const entities=()=>[{id:'local',generation:0,source:unit},{id:'remote',generation:0,source:remote}];
  presentation.capture({revision:0,sequence:0,timeMs:0,entities:entities()},performance.now());
  preview=new LocalInputPreview({presentation,stepMs:DT,maxPendingInputs:8,maxFutureTicks:8,maxAgeMs:1500,captureSnapshot:snapshot,
    createFork:bytes=>{forkCreates++;const fork=new Unit([.15,1,.55,1]);let forkTick;const restore=b=>{forkRestores++;const data=JSON.parse(decoder.decode(b));Object.assign(fork,data.unit);forkTick=data.tick;fork.color=[.15,1,.55,1]};restore(bytes);return{unit:fork,restore,step:(bytes,ctx)=>{if(ctx.tick!==forkTick)throw Error('Detached replay compressed a tick gap');for(const command of ctx.commands)if(command.executeTick!==undefined&&command.executeTick!==forkTick)throw Error('Canonical command executed at wrong preview tick');stepUnit(fork,bytes,ctx.commands);forkTick++}}},
    readEntities:fork=>[{id:'local',generation:0,source:fork.unit}]});
  checkpoint('reset');
  loop=createLoop({session,inputPreview:preview,
   getInput(){const left=actions.sample('left').held,right=actions.sample('right').held,roll=actions.sample('roll').pressed;actions.consume();return{input:Uint8Array.of(left===right?0:left?1:2),commands:roll?[{payload:Uint8Array.of(1)}]:[],continuationKey}},
   onPreviewError:error=>{throw error},
   onAdvance(result){if(result.status!=='advanced')return;presentation.capture({revision:0,sequence:++captureSequence,timeMs:session.tick*DT,entities:entities()},performance.now());const metadata=session.localInputState;
    const continued=preview.continueFromCheckpoint({input:metadata.replayInput??metadata.executedInput,revision:0,tick:session.tick,epoch:metadata.epoch,continuationKey,timeMs:performance.now(),confirmedCommandSequence:metadata.executedCommandSequence??undefined});
    if(!continued)checkpoint('continuous')},
   render(){frames++;const now=performance.now();renderer.beginFrame([.035,.07,.09,1]);renderer.rect(360,115,650,2,[.25,.36,.4,1]);presentation.render(unit,renderer,now);presentation.render(remote,renderer,now);renderer.endFrame();pose=presentation.modelFor(unit,now);status.textContent=`authority tick=${session.tick} · x=${unit.x.toFixed(1)} · displayed=${pose.x.toFixed(1)} · pending=${preview.pendingCount} · preview=${enabled}`;}});
  loop.start();
 }
 start();
 return{renderer,get presentation(){return presentation},get preview(){return preview},get session(){return session},
  get diagnostics(){return{authorityX:unit.x,displayedX:pose.x,displayFlash:pose.flash,remoteX:remote.x,authorityTick:session.tick,authorityHash:hashBytes(snapshot()),frames,pending:preview.pendingCount,forkCreates,forkRestores,metrics:preview.metrics,presentationMetrics:presentation.previewMetrics,confirmedCommandSequence:session.localInputState.executedCommandSequence}},
  setPreview(value){enabled=!!value;preview.setEnabled(enabled);if(enabled)checkpoint('reset')},
  forceCollision(){unit.x=695;presentation.capture({revision:0,sequence:++captureSequence,timeMs:session.tick*DT,entities:[{id:'local',generation:0,source:unit},{id:'remote',generation:0,source:remote}]},performance.now());checkpoint('reset')},clockGap(){loop.resetTiming(false);preview.clockGap()},
  restart(){loop.stop();preview.dispose();session.close();start()},
  dispose(){loop.stop();preview.dispose();session.close();input.dispose();renderer.dispose()}};
}

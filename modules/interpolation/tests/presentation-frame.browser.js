// One display-frame lifecycle scenario, exercised by the existing real-browser runner.
export async function runFrameChecks(page){return page.evaluate(async()=>{
  const {RenderObject:R,PresentationRuntime,InterpolationTimeline}=await import('/dist/interpolation.js');
  const check=(ok,message)=>{if(!ok)throw new Error(message);};
  class Shot extends R {static renderSchema={x:R.POSITION_X,y:R.POSITION_Y,color:R.STEP};static renderPath={x:'x',y:'y',durationMs:300,maxPoints:16};}
  const runtime=new PresentationRuntime({stepMs:100,delayMs:200});
  const capture=(sequence,timeMs,entities,extra={})=>runtime.capture({revision:0,sequence,timeMs,entities,...extra},timeMs);
  capture(0,0,[]);
  capture(1,100,[{id:'shot',generation:0,type:Shot,source:{x:10,y:10,color:'red',secret:99},initialSource:{x:0,y:0,color:'red'},initialTimeMs:0,pathPoints:[{timeMs:50,x:0,y:10}]}]);
  check(runtime.frame(150).sample('shot',0)===null,'birth hidden before its display time');
  capture(2,200,[{id:'shot',generation:0,type:Shot,source:{x:20,y:10,color:'blue'}}]);
  let frame=runtime.frame(225),model=frame.sample('shot',0),path=[];
  frame.pathInto('shot',0,path);
  check(model.x===0&&model.y===5&&model.color==='red'&&path.at(-1).y===5,'birth first interval and path share a clock');
  check(!('secret'in model)&&Object.getPrototypeOf(model)===Object.prototype,'detached declared data');
  frame=runtime.frame(275);model=frame.sample('shot',0);frame.pathInto('shot',0,path);
  check(model.x===5&&model.y===10&&path.some(p=>p.timeMs===50&&p.x===0&&p.y===10),'within-tick corner retained');
  check(path.every(p=>p.timeMs<=75)&&path.at(-1).x===model.x,'no future path; exact body endpoint');
  let expired=false;try{const old=frame;runtime.frame(276);old.sample('shot',0);}catch{expired=true;}check(expired,'expired frame diagnosed');
  capture(3,300,[]);frame=runtime.frame(350);let count=0;frame.forEach(()=>count++);check(count===1&&frame.sample('shot',0).x===15,'removed authority stays visible through delayed lifetime');
  check(runtime.frame(500).sample('shot',0)===null,'removed at display time');
  runtime.capture({revision:1,sequence:0,timeMs:100,mode:'rollback',entities:[{id:'shot',generation:1,type:Shot,source:{x:80,y:10,color:'blue'}}]},600);
  frame=runtime.frame(600);frame.pathInto('shot',1,path);check(frame.sample('shot',0)===null&&frame.sample('shot',1).x===80&&path.length===1&&path[0].x===80,'rollback resets path and generation immediately');
  runtime.capture({revision:1,sequence:1,timeMs:200,entities:[{id:'shot',generation:1,type:Shot,teleport:true,source:{x:150,y:10,color:'blue'}}]},700);
  check(runtime.frame(700).sample('shot',1).x===150,'teleport does not sweep old path');
  class Actor extends R{static renderSchema={x:R.POSITION_X,y:R.POSITION_Y};}
  const local=new PresentationRuntime({stepMs:100,delayMs:200}),source={x:0,y:0};
  local.capture({revision:0,sequence:0,timeMs:0,entities:[{id:'local',generation:0,type:Actor,source}]},0);
  local.selectPreview([{id:'local',generation:0}]);local.capturePreview({revision:0,sequence:0,timeMs:100,phaseStartMs:0,stepMs:100,entities:[{id:'local',generation:0,type:Actor,source:{x:10,y:0}}]},0);
  const selected=local.frame(50).sample('local',0);check(selected.x===5,'local preview is immediate despite delayed authority');
  const timeline=new InterpolationTimeline({stepMs:100,delayMs:200,schema:{x:'number'}});
  timeline.accept({revision:0,sequence:0,timeMs:0,entities:[]},0);
  timeline.accept({revision:0,sequence:1,timeMs:100,entities:[{id:'s',generation:0,values:{x:10},initialValues:{x:0}}]},100);
  const out={};timeline.sampleInto('s',0,225,out);check(out.x===2.5,'low-level timeline uses same seeded interval');
  // A pending attack is one state: its shape, key and countdown must switch together.
  class Attacker extends R {static renderSchema={x:R.POSITION_X,y:R.POSITION_Y,'pending.left':R.COUNTDOWN_SECONDS,'pending.total':R.STATE_KEY,'pending.target':R.STATE_KEY,'pending.tip.x':R.LINEAR,'optional.x':R.LINEAR};}
  const attack=new PresentationRuntime({stepMs:100,delayMs:200});
  const a={x:0,y:0,pending:{left:.1,total:.2,target:2,tip:{x:5}},optional:{x:3}};
  const publish=(sequence,timeMs)=>attack.capture({revision:0,sequence,timeMs,entities:[{id:'a',generation:0,type:Attacker,source:a}]},timeMs);
  publish(0,0);a.x=10;a.pending=null;a.optional=null;publish(1,100);
  a.x=20;a.pending={left:.3,total:.4,target:3,tip:{x:9}};delete a.optional;publish(2,200);
  const read=now=>{const f=attack.frame(now),p=f.sample('a',0);check(f.modelFor(a)===p&&f.modelFor(p)===p,'same display time uses same attack model');return p;};
  let p=read(250);check(p.x===5&&p.pending.left===.1&&p.pending.total===.2&&p.pending.tip.x===5&&p.optional.x===3,'object to null retains complete old state while body moves');
  check(Number.isFinite(1-p.pending.left/p.pending.total),'pending attack/muzzle charge stays finite');
  p=read(300);check(p.pending===null&&p.optional===null,'object to null switches exactly at display boundary');
  a.x=30;a.pending={left:.5,total:.6,target:4,tip:null};a.optional={x:7};publish(3,300);
  check(read(399).pending===null,'null to object stays null until its display boundary');
  p=read(400);check(p.pending.left===.3&&p.pending.total===.4&&p.pending.tip.x===9&&!('optional'in p),'null to object publishes complete target, missing shape preserved');
  p=read(450);check(p.pending.target===3&&p.pending.left===.3&&p.pending.tip.x===9,'STATE_KEY holds sibling fields and nested shape atomically');
  p=read(500);check(p.pending.target===4&&p.pending.left===.5&&p.pending.tip===null&&p.optional.x===7,'new keyed state and optional structure arrive together');
  const seeded=new PresentationRuntime({stepMs:100,delayMs:100});
  seeded.capture({revision:0,sequence:0,timeMs:100,entities:[{id:'a',generation:0,type:Attacker,source:a,initialTimeMs:0,initialSource:{x:0,y:0,pending:null}}]},100);
  check(seeded.frame(150).sample('a',0).pending===null,'explicit birth source keeps its initial optional shape');
  check(seeded.frame(200).sample('a',0).pending.total===.6,'explicit birth shape reaches target at display time');
  const released=new PresentationRuntime({stepMs:100,delayMs:100}),owner={x:0,y:0,pending:{left:.1,total:.2,target:2}};
  released.capture({revision:0,sequence:0,timeMs:0,mode:'reset',entities:[{id:'a',generation:0,type:Attacker,source:owner}]},0);
  owner.x=10;owner.pending=null;
  released.capture({revision:0,sequence:1,timeMs:100,entities:[{id:'a',generation:0,type:Attacker,source:owner}]},100);
  released.selectPreview([{id:'a',generation:0}]);
  released.capturePreview({revision:0,sequence:0,timeMs:110,phaseStartMs:100,stepMs:100,entities:[{id:'a',generation:0,type:Attacker,source:{...owner,x:20}}]},110);
  check(released.frame(115).sample('a',0).pending===null,'immediate preview has its complete target structure');
  released.releasePreview(120);
  p=released.frame(150).sample('a',0);check(p.x>10&&p.x<20&&p.pending===null,'preview release corrects its local pose without resurrecting buffered attack state');
  p=released.frame(200).sample('a',0);check(p.x===10&&p.pending===null,'released authority reaches its original display boundary');
  return {birth:'PASS',pathCorner:'PASS',lifetime:'PASS',rollback:'PASS',teleport:'PASS',preview:'PASS',frameGuard:'PASS',atomicAttackState:'PASS'};
});}

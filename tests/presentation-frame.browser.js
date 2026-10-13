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
  return {birth:'PASS',pathCorner:'PASS',lifetime:'PASS',rollback:'PASS',teleport:'PASS',preview:'PASS',frameGuard:'PASS'};
});}

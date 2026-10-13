import {RenderObject as R,PresentationRuntime} from '../../dist/interpolation.js';
import {Renderer2D} from '../../dist/rendering.js';
class Shot extends R {
  static renderSchema={x:R.POSITION_X,y:R.POSITION_Y,color:R.STEP};
  static renderPath={x:'x',y:'y',durationMs:600,maxPoints:64};
}
// Shape, bend and lifetime are game rules. The module owns display-time sampling.
export function startFrameDemo(canvas,status){
  const renderer=new Renderer2D(canvas),view=new PresentationRuntime({stepMs:100,delayMs:200});
  const path=[],shot={x:0,y:0,color:'cyan'};let sequence=0,revision=0,generation=0,timeMs=0,age=0,alive=false,stopped=false;
  const epoch=performance.now();view.capture({revision,sequence,timeMs,entities:[]},epoch);
  function spawn(){generation++;alive=true;age=0;shot.x=80;shot.y=100;}
  function rollback(){revision++;generation++;sequence=0;shot.x=80;shot.y=100;age=0;alive=true;
    view.capture({revision,sequence,timeMs,mode:'rollback',entities:[{id:'shot',generation,type:Shot,source:shot}]},performance.now());}
  const timer=setInterval(()=>{
    const initial={...shot};timeMs+=100;sequence++;
    if(alive){age+=100;shot.x+=20;shot.y=100+Math.max(0,Math.min(100,(age-500)/5));if(age>=2000)alive=false;}
    view.capture({revision,sequence,timeMs,entities:alive?[{id:'shot',generation,type:Shot,source:shot,
      ...(age===100?{initialSource:initial,initialTimeMs:timeMs-100}:{})}]:[]},performance.now());
  },100);
  function paint(){if(stopped)return;const now=performance.now(),frame=view.frame(now);let count=0;
    if(renderer.beginFrame([.03,.06,.09,1])){
      frame.forEach((model,id,generation)=>{count++;frame.pathInto(id,generation,path);
        for(let i=1;i<path.length;i++)renderer.line(path[i-1].x,path[i-1].y,path[i].x,path[i].y,3,[.2,.7,.9,.7]);
        renderer.rect(model.x,model.y,12,12,[.3,1,.8,1]);});renderer.endFrame();
    }
    status.textContent=`authority alive: ${alive} / displayed: ${count} / display ms: ${frame.timeMs.toFixed(0)}`;
    requestAnimationFrame(paint);
  }
  requestAnimationFrame(paint);spawn();return{spawn,rollback,dispose(){stopped=true;clearInterval(timer);renderer.dispose();}};
}

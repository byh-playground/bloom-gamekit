import { finite } from './schema.js';
// A bounded path belongs to the presentation identity, not to a renderer or effect engine.
export function pathPlan(declaration, indices) {
  if (!declaration) return null;
  const x=indices.get(declaration.x),y=indices.get(declaration.y),durationMs=finite(declaration.durationMs,'renderPath.durationMs');
  const maxPoints=declaration.maxPoints??64;
  if(x===undefined||y===undefined||durationMs<=0||!Number.isSafeInteger(maxPoints)||maxPoints<2||maxPoints>4096)throw new TypeError('invalid renderPath');
  return {x,y,durationMs,maxPoints};
}
export function capturePath(plan,old,from,target,startMs,timeMs,points,reset,delayMs,stepMs) {
  if(!plan)return null;
  const path=reset?[]:(old??[]).slice();
  const add=(timeMs,x,y)=>{finite(timeMs,'path timeMs');finite(x,'path x');finite(y,'path y');
    if(path.length&&timeMs<path.at(-1).timeMs)throw new RangeError('path points must be ordered');
    if(path.length&&timeMs===path.at(-1).timeMs)path[path.length-1]={timeMs,x,y};else path.push({timeMs,x,y});};
  if(!path.length)add(startMs,from[plan.x],from[plan.y]);
  if(points!==undefined){if(!Array.isArray(points))throw new TypeError('pathPoints must be an array');
    for(const point of points){if(point.timeMs<startMs||point.timeMs>timeMs)throw new RangeError('pathPoints must be inside this capture interval');add(point.timeMs,point.x,point.y);}}
  add(timeMs,target[plan.x],target[plan.y]);
  const floor=timeMs-plan.durationMs-delayMs-stepMs;
  while(path.length>2&&path[1].timeMs<floor)path.shift();
  return path.slice(-plan.maxPoints);
}
export function pointAt(path,timeMs,out){
  if(!path?.length)return false;
  let a=path[0],b=a;
  for(let i=1;i<path.length;i++){b=path[i];if(timeMs<=b.timeMs)break;a=b;}
  const t=b.timeMs===a.timeMs?1:Math.max(0,Math.min(1,(timeMs-a.timeMs)/(b.timeMs-a.timeMs)));
  out.timeMs=Math.max(path[0].timeMs,Math.min(timeMs,path.at(-1).timeMs));out.x=a.x+(b.x-a.x)*t;out.y=a.y+(b.y-a.y)*t;return true;
}
export function samplePath(path,timeMs,durationMs,out){
  let count=0;
  const write=point=>{const item=out[count]??(out[count]={});Object.assign(item,point);count++;};
  const head={};if(!pointAt(path,timeMs,head)){out.length=0;return out;}
  const floor=Math.max(path[0].timeMs,head.timeMs-durationMs),tail={};pointAt(path,floor,tail);write(tail);
  for(const point of path)if(point.timeMs>floor&&point.timeMs<head.timeMs)write(point);
  if(head.timeMs>floor)write(head);out.length=count;return out;
}

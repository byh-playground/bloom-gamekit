import { VectorRenderer } from './vector-renderer.js';
import { MeshRenderer } from './mesh-renderer.js';

const TAU = Math.PI * 2;
const IDENTITY = Object.freeze([1, 0, 0, 1, 0, 0]);
const NAMED = Object.freeze({
  black:'#000000', white:'#ffffff', red:'#ff0000', green:'#008000', blue:'#0000ff',
  yellow:'#ffff00', orange:'#ffa500', purple:'#800080', pink:'#ffc0cb', gray:'#808080',
  grey:'#808080', silver:'#c0c0c0', maroon:'#800000', olive:'#808000', lime:'#00ff00',
  aqua:'#00ffff', cyan:'#00ffff', teal:'#008080', navy:'#000080', fuchsia:'#ff00ff',
  magenta:'#ff00ff', rebeccapurple:'#663399', transparent:'#00000000'
});

function clamp(value, min=0, max=1){return Math.max(min,Math.min(max,value));}
function finite(value,name){if(!Number.isFinite(value))throw new TypeError(`${name} must be finite`);}
export function normalizeColor(value){
  if(Array.isArray(value)||ArrayBuffer.isView(value)){
    if(value.length!==4)throw new TypeError('RGBA paint must have four channels');
    const out=Array.from(value);if(out.some(v=>!Number.isFinite(v)||v<0||v>1))throw new RangeError('RGBA channels must be in [0,1]');return out;
  }
  let text=String(value??'black').trim().toLowerCase();text=NAMED[text]??text;
  if(text==='currentcolor'&&typeof getComputedStyle==='function')text=getComputedStyle(document.documentElement).color;
  if(text[0]==='#'){
    let hex=text.slice(1);if(!/^(?:[\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/i.test(hex))throw new TypeError(`Invalid CSS color: ${value}`);
    if(hex.length<5)hex=[...hex].map(c=>c+c).join('');
    return [parseInt(hex.slice(0,2),16)/255,parseInt(hex.slice(2,4),16)/255,parseInt(hex.slice(4,6),16)/255,hex.length===8?parseInt(hex.slice(6,8),16)/255:1];
  }
  const rgb=text.match(/^rgba?\((.*)\)$/);
  if(rgb){const fields=rgb[1].trim().replace(/\s*\/\s*/,' ').split(/[\s,]+/).filter(Boolean);if(fields.length<3||fields.length>4)throw new TypeError(`Invalid CSS color: ${value}`);const channel=s=>clamp(s.endsWith('%')?parseFloat(s)/100:parseFloat(s)/255);const alpha=fields[3]===undefined?1:clamp(fields[3].endsWith('%')?parseFloat(fields[3])/100:parseFloat(fields[3]));const out=[...fields.slice(0,3).map(channel),alpha];if(out.some(Number.isNaN))throw new TypeError(`Invalid CSS color: ${value}`);return out;}
  const hsl=text.match(/^hsla?\((.*)\)$/);
  if(hsl){const fields=hsl[1].trim().replace(/\s*\/\s*/,' ').split(/[\s,]+/).filter(Boolean);if(fields.length<3||fields.length>4)throw new TypeError(`Invalid CSS color: ${value}`);const h=((parseFloat(fields[0])%360)+360)%360/360,s=clamp(parseFloat(fields[1])/100),l=clamp(parseFloat(fields[2])/100),a=fields[3]===undefined?1:clamp(fields[3].endsWith('%')?parseFloat(fields[3])/100:parseFloat(fields[3]));const f=n=>{const k=(n+h*12)%12;return l-s*Math.min(l,1-l)*Math.max(-1,Math.min(k-3,9-k,1));};return[f(0),f(8),f(4),a];}
  if(typeof document!=='undefined'&&document.createElement&&document.body){const probe=document.createElement('span');probe.style.color='';probe.style.color=text;if(probe.style.color){document.body.append(probe);const resolved=getComputedStyle(probe).color;probe.remove();if(resolved!==text)return normalizeColor(resolved);}}
  throw new TypeError(`Unsupported CSS color: ${value}`);
}
function transformed(matrix,x,y){return{x:matrix[0]*x+matrix[2]*y+matrix[4],y:matrix[1]*x+matrix[3]*y+matrix[5]};}
function invert(matrix){const d=matrix[0]*matrix[3]-matrix[1]*matrix[2];if(Math.abs(d)<1e-15)return null;return[matrix[3]/d,-matrix[1]/d,-matrix[2]/d,matrix[0]/d,(matrix[2]*matrix[5]-matrix[3]*matrix[4])/d,(matrix[1]*matrix[4]-matrix[0]*matrix[5])/d];}

class RadialGradient {
  constructor(matrix,x0,y0,r0,x1,y1,r1){if(Math.hypot(x1-x0,y1-y0)>1e-8)throw new Error('Radial gradients require concentric circles');for(const [n,v]of Object.entries({x0,y0,r0,x1,y1,r1}))finite(v,n);if(r0<0||r1<0)throw new RangeError('Gradient radii must be non-negative');this.matrix=matrix.slice();this.x=x1;this.y=y1;this.r0=r0;this.r1=r1;this.stops=[];this.pixels=null;this.revision=0;}
  addColorStop(offset,value){if(!Number.isFinite(offset)||offset<0||offset>1)throw new RangeError('Invalid gradient stop');this.stops.push({offset,color:normalizeColor(value)});this.stops.sort((a,b)=>a.offset-b.offset);this.pixels=null;this.revision++;}
  raster(){if(this.pixels)return this.pixels;const data=new Uint8Array(256*4),stops=this.stops.length?this.stops:[{offset:0,color:[0,0,0,0]}];for(let i=0;i<256;i++){const t=(i/255*this.r1-this.r0)/Math.max(1e-8,this.r1-this.r0);let lo=stops[0],hi=stops.at(-1);for(let j=1;j<stops.length;j++)if(t<stops[j].offset){lo=stops[j-1];hi=stops[j];break;}const q=clamp((t-lo.offset)/(hi.offset-lo.offset||1)),alpha=lo.color[3]+(hi.color[3]-lo.color[3])*q;for(let k=0;k<3;k++)data[i*4+k]=Math.round((lo.color[k]+(hi.color[k]-lo.color[k])*q)*alpha*255);data[i*4+3]=Math.round(alpha*255);}this.pixels=data;return data;}
}

/** Canvas-style paint/path context over a caller-owned WebGLDevice and shared VectorRenderer. */
export class VectorContext {
  constructor(device,{vectorRenderer=null,glyphAtlas=vectorRenderer?.glyphAtlas??null,initialVertices=4096,maxVertices=262144,onError=null}={}){
    if(!device?.beginFrame||!device?.endFrame||!device?.createVertexBuffer)throw new TypeError('WebGLDevice is required');
    if(vectorRenderer&&vectorRenderer.device!==device)throw new TypeError('vectorRenderer must use the supplied WebGLDevice');
    this.device=device;this.canvas=device.canvas;this.vector=vectorRenderer??new VectorRenderer(device,{initialVertices,maxVertices,glyphAtlas});this.ownsVector=!vectorRenderer;
    this.glyphAtlas=glyphAtlas??this.vector.glyphAtlas;this.onError=typeof onError==='function'?onError:null;
    this.meshRenderer=null;this.active=false;this.state='ready';this.frame=0;this.pathCount=0;this.staticMeshes=new Set();this.deferredMeshes=[];this.gradientTextures=new Map();
    this.onLost=event=>{event.preventDefault();this.active=false;this.state='lost';this.meshRenderer?.discard();this._releaseGradientTextures();};
    this.onRestored=()=>{if(this.state==='disposed')return;try{for(const mesh of this.staticMeshes)this.device.uploadVertices(mesh.buffer,mesh.vertices);this.state='ready';}catch(error){this.state='failed';this.onError?.(error,{phase:'restore'});}};
    this.canvas.addEventListener('webglcontextlost',this.onLost);this.canvas.addEventListener('webglcontextrestored',this.onRestored);
    this._fillStyle='#000';this._strokeStyle='#000';this._globalAlpha=1;this._lineWidth=1;this._lineCap='butt';this._lineJoin='round';this._miterLimit=10;
    this._lineDash=[];this._lineDashOffset=0;this._font='10px sans-serif';this._textAlign='start';this._textBaseline='alphabetic';this._direction='inherit';this._filter='none';this.forceColor=null;
    this.stack=[];this.frameStats={};this.total={frames:0,drawCalls:0,vertices:0,uploadedBytes:0};
  }
  get globalAlpha(){return this._globalAlpha} set globalAlpha(v){finite(v,'globalAlpha');this._globalAlpha=clamp(v)}
  get fillStyle(){return this._fillStyle} set fillStyle(v){if(!(v instanceof RadialGradient))normalizeColor(v);this._fillStyle=v}
  get strokeStyle(){return this._strokeStyle} set strokeStyle(v){normalizeColor(v);this._strokeStyle=v}
  get lineWidth(){return this._lineWidth} set lineWidth(v){finite(v,'lineWidth');if(v>=0)this._lineWidth=v}
  get lineCap(){return this._lineCap} set lineCap(v){if(['butt','round','square'].includes(v))this._lineCap=v}
  get lineJoin(){return this._lineJoin} set lineJoin(v){if(['round','bevel','miter'].includes(v))this._lineJoin=v}
  get miterLimit(){return this._miterLimit} set miterLimit(v){finite(v,'miterLimit');if(v>0)this._miterLimit=v}
  get lineDashOffset(){return this._lineDashOffset} set lineDashOffset(v){finite(v,'lineDashOffset');this._lineDashOffset=v}
  get font(){return this._font} set font(v){this._font=String(v)}
  get textAlign(){return this._textAlign} set textAlign(v){if(['start','end','left','right','center'].includes(v))this._textAlign=v}
  get textBaseline(){return this._textBaseline} set textBaseline(v){if(['top','hanging','middle','alphabetic','ideographic','bottom'].includes(v))this._textBaseline=v}
  get direction(){return this._direction} set direction(v){if(['ltr','rtl','inherit'].includes(v))this._direction=v}
  get filter(){return this._filter} set filter(v){if(v!=='none'&&v!=='brightness(0) invert(1)')throw new RangeError('VectorContext supports only none and brightness(0) invert(1) filters');this._filter=v}
  _frame(){if(!this.active||this.device.state!=='ready')throw new Error('VectorContext frame is unavailable');}
  _paint(style){if(style instanceof RadialGradient)throw new TypeError('RadialGradient paint must be submitted through fill()');const color=normalizeColor(this.forceColor??style);color[3]*=this._globalAlpha;if(this._filter==='brightness(0) invert(1)')color[0]=color[1]=color[2]=1;return color;}
  _gradientPaint(gradient){let cached=this.gradientTextures.get(gradient);if(!cached){cached={texture:this.device.createTexture({width:256,height:1,data:gradient.raster()},{format:'rgba',premultiplied:true,filter:'linear'}),revision:gradient.revision};this.gradientTextures.set(gradient,cached);}else if(cached.revision!==gradient.revision){this.device.updateTexture(cached.texture,{width:256,height:1,data:gradient.raster()});cached.revision=gradient.revision;}const matrixInverse=invert(gradient.matrix);if(!matrixInverse)throw new RangeError('Radial gradient transform is singular');const color=normalizeColor(this.forceColor??[1,1,1,1]);color[3]*=this._globalAlpha;return{texture:cached.texture,centerX:gradient.x,centerY:gradient.y,radius:gradient.r1,matrixInverse,color,whiteFlash:this._filter==='brightness(0) invert(1)'};}
  _releaseGradientTextures(){for(const [gradient,cached]of this.gradientTextures){try{this.device.deleteTexture(cached.texture)}catch(error){try{this.onError?.(error,{phase:'gradient-release'})}catch{}}finally{gradient.pixels=null;}}this.gradientTextures.clear();}
  beginFrame({width=this.canvas.width,height=this.canvas.height,clearColor=[0,0,0,0]}={}){
    if(this.active)throw new Error('endFrame is required before beginFrame');
    if(this.state==='lost'||this.device.state==='lost')return false;
    if(this.state!=='ready')throw new Error(`VectorContext is ${this.state}`);
    try{const ready=this.device.beginFrame({width,height,clearColor});if(!ready)return false;this.active=true;this.meshRenderer?.beginFrame();this.frame++;this.pathCount=0;this.vector.beginPath();return true;}
    catch(error){this.onError?.(error,{phase:'beginFrame'});throw error;}
  }
  endFrame(){this._frame();try{this.flush();const stats=this.device.endFrame();this.active=false;for(const mesh of this.deferredMeshes.splice(0))this.deleteStaticMesh(mesh);this.frameStats={drawCalls:stats.drawCalls,vertices:stats.vertices,uploadedBytes:stats.bufferBytes??stats.uploadedBytes??0,textureUploads:stats.textureUploads??0,textureBytes:stats.textureBytes??0,gpuRenderTargetBytes:stats.gpuRenderTargetBytes??0,paths:this.pathCount};this.total.frames++;this.total.drawCalls+=this.frameStats.drawCalls;this.total.vertices+=this.frameStats.vertices;this.total.uploadedBytes+=this.frameStats.uploadedBytes;this._releaseGradientTextures();return this.stats();}catch(error){this.active=false;this._releaseGradientTextures();this.onError?.(error,{phase:'endFrame'});throw error;}}
  save(){this._frame();this.stack.push({fillStyle:this._fillStyle,strokeStyle:this._strokeStyle,globalAlpha:this._globalAlpha,lineWidth:this._lineWidth,lineCap:this._lineCap,lineJoin:this._lineJoin,miterLimit:this._miterLimit,lineDash:this._lineDash.slice(),lineDashOffset:this._lineDashOffset,font:this._font,textAlign:this._textAlign,textBaseline:this._textBaseline,direction:this._direction,filter:this._filter,forceColor:this.forceColor});this.vector.save();}
  restore(){this._frame();const s=this.stack.pop();if(!s)return;this.vector.restore();Object.assign(this,{_fillStyle:s.fillStyle,_strokeStyle:s.strokeStyle,_globalAlpha:s.globalAlpha,_lineWidth:s.lineWidth,_lineCap:s.lineCap,_lineJoin:s.lineJoin,_miterLimit:s.miterLimit,_lineDash:s.lineDash,_lineDashOffset:s.lineDashOffset,_font:s.font,_textAlign:s.textAlign,_textBaseline:s.textBaseline,_direction:s.direction,_filter:s.filter,forceColor:s.forceColor});}
  setTransform(a,b,c,d,e,f){this.vector.setTransform(a,b,c,d,e,f)} resetTransform(){this.vector.setTransform(...IDENTITY)} getTransform(){const m=this.vector.matrix;return{a:m[0],b:m[1],c:m[2],d:m[3],e:m[4],f:m[5]}}
  transform(a,b,c,d,e,f){this.vector.transform(a,b,c,d,e,f)} translate(x,y){this.vector.translate(x,y)} rotate(angle){this.vector.rotate(angle)} scale(x,y){this.vector.scale(x,y)}
  beginPath(){this._frame();this.pathCount++;this.vector.beginPath()} moveTo(x,y){this.vector.moveTo(x,y)} lineTo(x,y){this.vector.lineTo(x,y)} closePath(){this.vector.closePath()} quadraticCurveTo(cx,cy,x,y){this.vector.quadraticCurveTo(cx,cy,x,y)} bezierCurveTo(x1,y1,x2,y2,x,y){this.vector.bezierCurveTo(x1,y1,x2,y2,x,y)}
  _arcPoints(x,y,rx,ry,rotation,start,end,ccw){if(rx<0||ry<0)throw new RangeError('ellipse radii must be non-negative');let sweep=end-start;if(!ccw){if(sweep>=TAU)sweep=TAU;else while(sweep<0)sweep+=TAU}else if(sweep<=-TAU)sweep=-TAU;else while(sweep>0)sweep-=TAU;const m=this.vector.matrix,r=Math.max(rx,ry)*Math.max(Math.hypot(m[0],m[1]),Math.hypot(m[2],m[3])),step=r>.2?2*Math.acos(clamp(1-.2/r,-1,1)):Math.PI/2,n=Math.max(1,Math.min(256,Math.ceil(Math.abs(sweep)/Math.max(.01,step)))),c=Math.cos(rotation),s=Math.sin(rotation),out=[];for(let i=0;i<=n;i++){const a=start+sweep*i/n;out.push([x+Math.cos(a)*rx*c-Math.sin(a)*ry*s,y+Math.cos(a)*rx*s+Math.sin(a)*ry*c]);}return out;}
  arc(x,y,r,start,end,ccw=false){this.ellipse(x,y,r,r,0,start,end,ccw)}
  ellipse(x,y,rx,ry,rotation=0,start=0,end=TAU,ccw=false){const points=this._arcPoints(x,y,rx,ry,rotation,start,end,ccw);if(!this.vector.cursor)this.vector.moveTo(...points[0]);else this.vector.lineTo(...points[0]);for(let i=1;i<points.length;i++)this.vector.lineTo(...points[i]);}
  rect(x,y,w,h){this.moveTo(x,y);this.lineTo(x+w,y);this.lineTo(x+w,y+h);this.lineTo(x,y+h);this.closePath()}
  roundRect(x,y,w,h,r=0){const radii=Array.isArray(r)?r:[r,r,r,r];const max=Math.min(Math.abs(w)/2,Math.abs(h)/2);const q=radii.map(v=>clamp(Number(v)||0,0,max));this.moveTo(x+q[0],y);this.lineTo(x+w-q[1],y);this.arc(x+w-q[1],y+q[1],q[1],-Math.PI/2,0);this.lineTo(x+w,y+h-q[2]);this.arc(x+w-q[2],y+h-q[2],q[2],0,Math.PI/2);this.lineTo(x+q[3],y+h);this.arc(x+q[3],y+h-q[3],q[3],Math.PI/2,Math.PI);this.lineTo(x,y+q[0]);this.arc(x+q[0],y+q[0],q[0],Math.PI,Math.PI*1.5);this.closePath();}
  _temporaryPath(callback){const v=this.vector,saved={path:v.path,cursor:v.cursor,subpath:v.subpath};try{callback()}finally{v.path=saved.path;v.cursor=saved.cursor;v.subpath=saved.subpath}}
  fill(rule='nonzero'){this._frame();this.meshRenderer?.flush();if(this._fillStyle instanceof RadialGradient)this.vector.fillRadialGradient({...this._gradientPaint(this._fillStyle),rule});else this.vector.fill(this._paint(this._fillStyle),rule)}
  fillRect(x,y,w,h){this._frame();this._temporaryPath(()=>{this.vector.beginPath();this.rect(x,y,w,h);this.fill()})}
  stroke(){this._frame();this.meshRenderer?.flush();if(!(this._lineWidth>0))return;const m=this.vector.matrix,width=this._lineWidth*Math.max(Math.hypot(m[0],m[1]),Math.hypot(m[2],m[3])),paint=this._paint(this._strokeStyle),style={lineCap:this._lineCap,lineJoin:this._lineJoin,miterLimit:this._miterLimit},dash=this._lineDash,period=dash.reduce((a,b)=>a+b,0);if(!dash.length||!period){this.vector.stroke(paint,width,style);return;}const v=this.vector,original=v.path,matrix=v.matrix.slice();v.beginPath();v.setTransform(...IDENTITY);let phase=((this._lineDashOffset%period)+period)%period,index=0;while(phase>=dash[index]&&dash[index]>0){phase-=dash[index];index=(index+1)%dash.length;}let remaining=dash[index]-phase;for(const path of original)for(let i=1;i<path.length;i++){const a=path[i-1],b=path[i],length=Math.hypot(b.x-a.x,b.y-a.y);let at=0;while(at<length-1e-7){if(remaining<=1e-7){index=(index+1)%dash.length;remaining=dash[index];continue;}const stop=Math.min(length,at+remaining);if(index%2===0){v.moveTo(a.x+(b.x-a.x)*at/length,a.y+(b.y-a.y)*at/length);v.lineTo(a.x+(b.x-a.x)*stop/length,a.y+(b.y-a.y)*stop/length);}remaining-=stop-at;at=stop;}}v.stroke(paint,width,style);v.matrix=matrix;v.path=original;v.cursor=original.at(-1)?.at(-1)??null;v.subpath=original[0]?.[0]??null;}
  strokeRect(x,y,w,h){this._frame();this._temporaryPath(()=>{this.vector.beginPath();this.rect(x,y,w,h);this.stroke()})}
  setLineDash(values){if(!Array.isArray(values)||values.some(v=>!Number.isFinite(v)||v<0))throw new TypeError('dash must contain non-negative finite values');if(values.length%2)values=values.concat(values);this._lineDash=values.slice()}
  getLineDash(){return this._lineDash.slice()}
  clip(rule='nonzero'){this._frame();if(this.vector.path.filter(p=>p.length>=3).length>1)throw new RangeError('clip supports one contour per clip call');this.vector.clip(rule)}
  clipRect(x,y,w,h){this._frame();this.vector.clipRect(x,y,w,h)}
  fillTriangleFan(points,paint=this._fillStyle){this._frame();this.meshRenderer?.flush();if(points.length<3)return;this.vector.triangleFan(points,this._paint(paint))}
  beginGroup(opacity=1,bounds=null){this._frame();this.meshRenderer?.flush();this.vector.beginGroup(opacity,bounds)} endGroup(){this.meshRenderer?.flush();this.vector.endGroup()}
  withGroupOpacity(opacity,callback,bounds=null){this._frame();const previous=this._globalAlpha;this.beginGroup(opacity,bounds);this._globalAlpha=1;try{return callback()}finally{try{this.endGroup()}finally{this._globalAlpha=previous}}}
  groupBounds(x,y,radius){const m=this.vector.matrix,p=transformed(m,x,y),r=radius*Math.max(Math.hypot(m[0],m[1]),Math.hypot(m[2],m[3]));return{x:p.x-r,y:p.y-r,width:r*2,height:r*2}}
  withColor(color,callback){const previous=this.forceColor;this.forceColor=normalizeColor(color);try{return callback()}finally{this.forceColor=previous}}
  withSilhouette(color,width,paint,radius=128){const alpha=this._globalAlpha,bounds=this.groupBounds(0,0,radius+width);return this.withGroupOpacity(alpha,()=>{this.withColor(color,()=>{for(let i=0;i<8;i++){this.save();const a=i*TAU/8;this.translate(Math.cos(a)*width,Math.sin(a)*width);try{paint()}finally{this.restore()}}paint()});paint()},bounds)}
  _fontSize(){const m=this._font.match(/(?:^|\s)(\d+(?:\.\d+)?)px(?:\s|\/|$)/);return m?Number(m[1]):10}
  _align(){if(this._textAlign==='center')return'center';if(this._textAlign==='right'||this._textAlign==='end'&&this._direction!=='rtl'||this._textAlign==='start'&&this._direction==='rtl')return'right';return'left'}
  measureText(text){if(!this.glyphAtlas)throw new Error('GlyphAtlas is not configured');return this.glyphAtlas.measureText(String(text),{fontSize:this._fontSize(),align:this._align()})}
  fillText(text,x,y,maxWidth){this._frame();this.meshRenderer?.flush();if(!this.glyphAtlas)throw new Error('GlyphAtlas is not configured');const color=this._paint(this._fillStyle),fontSize=this._fontSize(),align=this._align(),baseline=this._textBaseline,measured=this.glyphAtlas.measureText(String(text),{fontSize}).width,scale=maxWidth&&Number.isFinite(maxWidth)?Math.min(1,maxWidth/(measured||1)):1;if(scale!==1){this.vector.save();this.vector.translate(x,y);this.vector.scale(scale,1);this.vector.translate(-x,-y);}try{return this.vector.fillText(String(text),x,y,{fontSize,align,baseline,color});}finally{if(scale!==1)this.vector.restore();}}
  strokeText(text,x,y,maxWidth){this._frame();this.meshRenderer?.flush();if(!this.glyphAtlas)throw new Error('GlyphAtlas is not configured');const scale=maxWidth&&Number.isFinite(maxWidth)?Math.min(1,maxWidth/(this.glyphAtlas.measureText(String(text),{fontSize:this._fontSize()}).width||1)):1;this.vector.save();try{if(scale!==1){this.vector.translate(x,y);this.vector.scale(scale,1);this.vector.translate(-x,-y);}return this.vector.strokeText(String(text),x,y,{fontSize:this._fontSize(),align:this._align(),baseline:this._textBaseline,color:this._paint(this._strokeStyle),lineWidth:this._lineWidth});}finally{this.vector.restore();}}
  createRadialGradient(x0,y0,r0,x1,y1,r1){return new RadialGradient(this.vector.matrix,x0,y0,r0,x1,y1,r1)}
  /** Retains caller-authored local-space triangles once; caller explicitly releases the handle. */
  createMesh(data){if(this.state!=='ready'||this.device.state!=='ready')throw new Error('VectorContext is not ready');this.meshRenderer??=new MeshRenderer(this.device);return this.meshRenderer.createMesh(data)}
  deleteMesh(mesh){return this.meshRenderer?.deleteMesh(mesh)??false}
  /** Local transform composes with current Canvas-style transform; all paint state is captured by value. */
  drawMesh(mesh,{transform=null,morph=[0,0],parts=null}={}){this._frame();if(!this.meshRenderer)throw new TypeError('createMesh required');this.vector.flush();let matrix=this.vector.matrix;if(transform){if(transform.length!==6||Array.from(transform).some(n=>!Number.isFinite(n)))throw new TypeError('Six finite transform values required');const m=matrix,[a,b,c,d,e,f]=transform;matrix=[m[0]*a+m[2]*b,m[1]*a+m[3]*b,m[0]*c+m[2]*d,m[1]*c+m[3]*d,m[0]*e+m[2]*f+m[4],m[1]*e+m[3]*f+m[5]]}this.meshRenderer.drawMesh(mesh,{matrix,projection:this.vector.projection,clips:this.vector.clips,morph,parts,color:this.forceColor??[1,1,1,1],forceColor:this.forceColor!==null,alpha:this._globalAlpha,whiteFlash:this._filter==='brightness(0) invert(1)'})}
  flush(){this._frame();this.meshRenderer?.flush();this.vector.flush()}
  createStaticMesh(vertices,{strideFloats=6}={}){if(this.state!=='ready'||this.device.state!=='ready')throw new Error('VectorContext is not ready');if(!(vertices instanceof Float32Array)||!Number.isSafeInteger(strideFloats)||strideFloats<2||vertices.length%strideFloats)throw new TypeError('mesh requires Float32Array and a matching strideFloats');const buffer=this.device.createVertexBuffer({capacityBytes:vertices.byteLength});this.device.uploadVertices(buffer,vertices);const mesh={context:this,buffer,vertices,count:vertices.length/strideFloats,strideFloats};this.staticMeshes.add(mesh);return mesh;}
  deleteStaticMesh(mesh){if(!mesh||mesh.context!==this||!this.staticMeshes.has(mesh))return false;this.device.deleteVertexBuffer(mesh.buffer);this.staticMeshes.delete(mesh);return true;}
  deferDeleteStaticMesh(mesh){if(!mesh||mesh.context!==this||!this.staticMeshes.has(mesh)||this.deferredMeshes.includes(mesh))return false;this.deferredMeshes.push(mesh);return true;}
  drawStaticMesh(mesh,{pipeline,projection,uniforms={},textures=[],blend='source-over',depth=null}={}){this._frame();if(!mesh||mesh.context!==this||!this.staticMeshes.has(mesh)||!pipeline)throw new TypeError('mesh owned by this context and caller pipeline are required');this.flush();const values={...uniforms};if(projection)values.u_projection=projection;this.device.draw({pipeline,buffer:mesh.buffer,count:mesh.count,uniforms:values,textures,blend,depth});}
  stats(){return{backend:'webgl1',available:this.device.state==='ready',contextLost:this.device.state==='lost',failure:this.device.failure??null,frame:this.frame,...this.frameStats,mesh:this.meshRenderer?.stats()??null,stagingBytes:this.vector.vertices.byteLength,gpuBufferBytes:this.device.stats.gpuBufferBytes??0,gpuRenderTargetBytes:this.device.stats.gpuRenderTargetBytes??0,textureCount:this.device.stats.textureCount??0,activeGradientTextureCount:this.gradientTextures.size,renderTargetCount:this.device.stats.renderTargetCount??0,bufferAllocations:this.device.stats.bufferAllocations??0,totals:{...this.total}};}
  dispose(){if(this.state==='disposed')return;this.canvas.removeEventListener('webglcontextlost',this.onLost);this.canvas.removeEventListener('webglcontextrestored',this.onRestored);this.meshRenderer?.dispose();for(const mesh of this.staticMeshes)this.device.deleteVertexBuffer(mesh.buffer);this._releaseGradientTextures();this.staticMeshes.clear();this.deferredMeshes.length=0;if(this.ownsVector)this.vector.dispose();this.active=false;this.state='disposed';}
}

/** Reusable low-poly primitive emitters; art-specific recipes remain with the caller. */
export class PrimitivePainter {
  constructor(target,{point=null,alphaMultiplier=1}={}){if(!target?.fillTriangleFan&&!(target?.beginPath&&target?.fill))throw new TypeError('VectorContext or native Canvas2D context is required');this.context=target;this.pointTransform=point;this.alphaMultiplier=alphaMultiplier;}
  point(x,y){const result=this.pointTransform?this.pointTransform(x,y):[x,y];return Array.isArray(result)?result:[result.x,result.y];}
  _paint(points,paint){if(points.length<3)return;const ctx=this.context,oldAlpha=ctx.globalAlpha??1,mul=typeof this.alphaMultiplier==='function'?this.alphaMultiplier():this.alphaMultiplier;ctx.globalAlpha=oldAlpha*clamp(mul);try{if(typeof ctx.fillTriangleFan==='function'){ctx.fillTriangleFan(points.map(p=>this.point(p[0],p[1])),paint);return;}const rgba=normalizeColor(paint);ctx.fillStyle=`rgba(${Math.round(rgba[0]*255)},${Math.round(rgba[1]*255)},${Math.round(rgba[2]*255)},${rgba[3]})`;ctx.beginPath();const a=this.point(points[0][0],points[0][1]);for(let i=1;i<points.length-1;i++){const b=this.point(points[i][0],points[i][1]),c=this.point(points[i+1][0],points[i+1][1]);ctx.moveTo(a[0],a[1]);ctx.lineTo(b[0],b[1]);ctx.lineTo(c[0],c[1]);ctx.closePath();}ctx.fill();}finally{ctx.globalAlpha=oldAlpha;}}
  poly(points,paint){this._paint(points,paint)}
  tri(x1,y1,x2,y2,x3,y3,paint){this.poly([[x1,y1],[x2,y2],[x3,y3]],paint)}
  quad(x1,y1,x2,y2,x3,y3,x4,y4,paint){this.poly([[x1,y1],[x2,y2],[x3,y3],[x4,y4]],paint)}
  regularPolygon(x,y,radius,paint,sides=10,rotation=0){if(sides<3||radius<=0)return;let unit=PRIMITIVE_DIRECTIONS.get(`${sides}|${rotation}`);if(!unit){unit=Array.from({length:sides},(_,i)=>[Math.cos(rotation+i/sides*TAU),Math.sin(rotation+i/sides*TAU)]);PRIMITIVE_DIRECTIONS.set(`${sides}|${rotation}`,unit);}this.poly(unit.map(p=>[x+p[0]*radius,y+p[1]*radius]),paint)}
  circle(x,y,radius,paint,segments=10){this.regularPolygon(x,y,radius,paint,segments,0)}
  hex(x,y,radius,paint){this.regularPolygon(x,y,radius,paint,6,Math.PI/6)}
  line(x0,y0,x1,y1,width,paint){const dx=x1-x0,dy=y1-y0,length=Math.hypot(dx,dy)||1,nx=-dy/length*width/2,ny=dx/length*width/2;this.quad(x0+nx,y0+ny,x1+nx,y1+ny,x1-nx,y1-ny,x0-nx,y0-ny,paint)}
  fan(points,paint){this.poly(points,paint)}
}

const PRIMITIVE_DIRECTIONS=new Map();

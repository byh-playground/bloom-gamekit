import assert from 'node:assert/strict';

/** Continues the same browser/built-module E2E; no fake GL or retained screenshots. */
export async function exerciseWebGLDevice(page) {
  const result = await page.evaluate(async () => {
    const { WebGLDevice } = await import('/dist/rendering.js');
    const check=(x,m)=>{if(!x)throw new Error(m);};
    const canvas=document.createElement('canvas');canvas.width=canvas.height=64;document.body.append(canvas);
    const d=new WebGLDevice(canvas,{alpha:false,antialias:false,preserveDrawingBuffer:true,maxBufferBytes:65536});const gl=d.gl;
    const pixel=(x=32,y=32)=>{const p=new Uint8Array(4);gl.readPixels(x,63-y,1,1,gl.RGBA,gl.UNSIGNED_BYTE,p);return [...p];};
    const near=(a,b,m)=>check(a.every((x,i)=>Math.abs(x-b[i])<3),`${m}: ${a} expected ${b}`);
    const pipeline=d.createPipeline({vertex:'attribute vec3 p;attribute vec4 c;uniform mat3 m;varying vec4 color;void main(){vec3 q=m*vec3(p.xy,1.0);gl_Position=vec4(q.xy,p.z,1.0);color=c;}',fragment:'precision mediump float;varying vec4 color;void main(){gl_FragColor=color;}',stride:28,attributes:[{name:'p',size:3,offset:0},{name:'c',size:4,offset:12}],uniforms:{m:'matrix3fv'}});
    const identity=new Float32Array([1,0,0,0,1,0,0,0,1]);const uniforms={m:identity};
    const buffer=d.createVertexBuffer({capacityBytes:28*6});
    function rect(x0,y0,x1,y1,z,c){const out=[];for(const [x,y]of [[x0,y0],[x1,y0],[x1,y1],[x0,y0],[x1,y1],[x0,y1]])out.push(x,y,z,...c);return new Float32Array(out);}
    const red=rect(-1,-1,1,1,-.5,[1,0,0,1]),blue=rect(-1,-1,1,1,.5,[0,0,1,1]),green=rect(-1,-1,1,1,.8,[0,1,0,1]);
    d.beginFrame();d.uploadVertices(buffer,blue);d.draw({pipeline,buffer,count:6,uniforms,depth:{func:'lequal'}});
    d.uploadVertices(buffer,red);d.draw({pipeline,buffer,count:6,uniforms,depth:{func:'lequal'}});
    d.uploadVertices(buffer,green);d.draw({pipeline,buffer,count:6,uniforms,depth:{func:'lequal'}});near(pixel(),[255,0,0,255],'depth LEQUAL rejects farther pass');
    d.draw({pipeline,buffer,count:6,uniforms,depth:{func:'greater',write:false}});near(pixel(),[0,255,0,255],'GREATER silhouette pass');d.endFrame();
    d.beginFrame({clearColor:[0,0,1,1]});d.uploadVertices(buffer,rect(-1,-1,0,1,0,[1,1,1,1]));
    d.draw({pipeline,buffer,count:6,uniforms,colorMask:[false,false,false,false],stencil:{func:'equal',ref:0,pass:'increment'}});
    d.uploadVertices(buffer,red);d.draw({pipeline,buffer,count:6,uniforms,stencil:{func:'equal',ref:1,writeMask:0}});
    near(pixel(16,32),[255,0,0,255],'stencil clipped left');near(pixel(48,32),[0,0,255,255],'stencil excludes right');
    d.clear({stencil:0});d.draw({pipeline,buffer,count:6,uniforms,stencil:{func:'equal',ref:1,writeMask:0}});near(pixel(48,32),[0,0,255,255],'explicit stencil clear');d.endFrame();
    d.beginFrame({clearColor:[0,0,1,1]});d.uploadVertices(buffer,rect(-1,-1,1,1,0,[1,0,0,.5]));d.draw({pipeline,buffer,count:6,uniforms,blend:'straight-alpha'});near(pixel(),[128,0,128,255],'straight-alpha Rally material');d.endFrame();

    // Shader/material policy stays game-owned: same resource core binds FPV11 gradients/white mask.
    const batch=d.createPipeline({vertex:'attribute vec2 p;attribute vec2 uv;attribute vec4 c;attribute float slot;attribute float mode;attribute float white;varying vec2 t;varying vec4 color;varying float s;varying float m;varying float w;void main(){gl_Position=vec4(p,0.,1.);t=uv;color=c;s=slot;m=mode;w=white;}',fragment:'precision mediump float;varying vec2 t;varying vec4 color;varying float s;varying float m;varying float w;uniform sampler2D tex[2];void main(){vec2 uv=m>1.5?vec2(clamp(length(t),0.,1.),.5):t;vec4 a=vec4(1.);if(m>.5){if(s<.5)a=texture2D(tex[0],uv);else a=texture2D(tex[1],uv);}a.rgb=mix(a.rgb,vec3(a.a),w);gl_FragColor=vec4(a.rgb*color.rgb,a.a)*color.a;}',stride:44,attributes:[{name:'p',size:2,offset:0},{name:'uv',size:2,offset:8},{name:'c',size:4,offset:16},{name:'slot',size:1,offset:32},{name:'mode',size:1,offset:36},{name:'white',size:1,offset:40}],uniforms:{'tex[0]':'1iv'}});
    const bytes={width:2,height:1,data:new Uint8Array([255,0,0,128,0,255,0,255])};const texture=d.createTexture(bytes,{filter:'nearest'});
    const second=d.createTexture({width:1,height:1,data:new Uint8Array([0,0,255,255])},{filter:'nearest'});
    const arena=d.createVertexBuffer();
    function quad(slot,mode,white,u=.25){const out=[];for(const [x,y]of [[-1,-1],[1,-1],[1,1],[-1,-1],[1,1],[-1,1]])out.push(x,y,u,0.5,1,1,1,1,slot,mode,white);return new Float32Array(out);}
    const command={pipeline:batch,buffer:arena,count:6,uniforms:{'tex[0]':new Int32Array([0,1])},textures:[texture,second]};
    d.beginFrame({clearColor:[0,0,1,1]});d.uploadVertices(arena,quad(0,1,0));d.draw(command);near(pixel(),[128,0,127,255],'FPV11 premultiplied texel');
    d.uploadVertices(arena,quad(1,1,1));d.draw(command);near(pixel(),[255,255,255,255],'second texture white-flash mask');
    d.uploadVertices(arena,quad(0,2,0,.8));d.draw(command);near(pixel(),[0,255,0,255],'radial gradient lookup');d.endFrame();
    bytes.data.set([0,0,255,255],0);d.updateTexture(texture,bytes,{x:0,y:0,width:1,height:1});
    d.beginFrame();d.uploadVertices(arena,quad(0,1,0));d.draw(command);near(pixel(),[0,0,255,255],'partial byte atlas update');d.endFrame();
    const dom=document.createElement('canvas');dom.width=2;dom.height=1;const ctx=dom.getContext('2d');ctx.fillStyle='red';ctx.fillRect(0,0,2,1);const domTexture=d.createTexture(dom,{filter:'nearest'});
    ctx.fillStyle='lime';ctx.fillRect(0,0,1,1);d.updateTexture(domTexture,dom,{x:0,y:0,width:1,height:1});command.textures[0]=domTexture;
    d.beginFrame();d.uploadVertices(arena,quad(0,1,0));d.draw(command);near(pixel(),[0,255,0,255],'partial DOM atlas update');d.endFrame();

    const fog=d.createPipeline({vertex:'attribute vec2 p;void main(){gl_Position=vec4(p,0.,1.);}',fragment:'precision mediump float;uniform sampler2D previous;uniform sampler2D next;uniform float transition;void main(){float v=mix(texture2D(previous,vec2(.5)).r,texture2D(next,vec2(.5)).r,transition);gl_FragColor=vec4(v,0.,0.,1.);}',stride:8,attributes:[{name:'p',size:2,offset:0}],uniforms:{previous:'1i',next:'1i',transition:'1f'}});
    const full=d.createVertexBuffer();d.uploadVertices(full,new Float32Array([-1,-1,1,-1,1,1,-1,-1,1,1,-1,1]));
    const dark=d.createTexture({width:3,height:1,data:new Uint8Array([0,0,0])},{format:'luminance'}),light=d.createTexture({width:3,height:1,data:new Uint8Array([255,255,255])},{format:'luminance'});
    d.beginFrame();d.draw({pipeline:fog,buffer:full,count:6,uniforms:{previous:0,next:1,transition:.5},textures:[dark,light]});near(pixel(),[128,0,0,255],'two NPOT luminance fog masks');
    const copied=d.createTexture({width:64,height:64,data:null});d.copyFrameToTexture(copied);d.clear({color:[0,0,0,1]});command.textures[0]=copied;d.uploadVertices(arena,quad(0,1,0,.5));d.draw(command);near(pixel(),[128,0,0,255],'GPU-resolved frame composition copy');d.endFrame();
    check(gl.getError()===gl.NO_ERROR,'device GL errors');
    const before=d.stats.bufferAllocations;d.beginFrame();d.uploadVertices(arena,quad(0,1,0));d.draw(command);const stats={...d.endFrame()};check(before===d.stats.bufferAllocations,'steady upload reuses GPU allocation');
    let invalidRejected=false;try{d.createPipeline({vertex:'invalid shader',fragment:'void main(){}',stride:8,attributes:[{name:'p',size:2,offset:0}]});}catch{invalidRejected=true;}check(invalidRejected,'shader failures must be explicit');
    window.deviceProbe={d,canvas,texture,command,arena,quad,pixel,full,domTexture};
    return {depth:true,stencil:true,straightAlpha:true,multitexture:true,radialWhiteMask:true,partialAtlas:true,luminanceFog:true,frameCopy:true,stats,invalidRejected};
  });
  const loss=await page.evaluate(()=>{deviceProbe.loss=deviceProbe.d.gl.getExtension('WEBGL_lose_context');if(!deviceProbe.loss)return false;deviceProbe.loss.loseContext();return true;});
  if(loss){
    await page.waitForFunction(()=>deviceProbe.d.state==='lost');assert.equal(await page.evaluate(()=>deviceProbe.d.beginFrame()),false);
    await page.evaluate(()=>deviceProbe.loss.restoreContext());await page.waitForFunction(()=>deviceProbe.d.state==='ready');
    const restored=await page.evaluate(()=>{const p=deviceProbe;p.d.beginFrame();p.command.textures[0]=p.domTexture;p.d.uploadVertices(p.arena,p.quad(0,1,0));p.d.draw(p.command);p.d.endFrame();return{pixel:p.pixel(),error:p.d.gl.getError(),restores:p.d.stats.restores};});
    assert.deepEqual(restored,{pixel:[0,255,0,255],error:0,restores:1});
  }
  result.restoration=loss;result.disposed=await page.evaluate(()=>{const d=deviceProbe.d;d.dispose();d.dispose();deviceProbe.canvas.remove();return d.state==='disposed'&&d.stats.pipelineCount===0&&d.stats.gpuBufferBytes===0;});assert.equal(result.disposed,true);
  return result;
}

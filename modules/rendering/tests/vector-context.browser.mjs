import assert from 'node:assert/strict';

/** Actual browser/WebGL pixel proof for VectorContext; parent E2E can call this helper. */
export async function exerciseVectorContext(page){
  const result=await page.evaluate(async()=>{
    const {WebGLDevice,VectorRenderer,VectorContext,PrimitivePainter,GlyphAtlas}=await import('/dist/rendering.js');
    const canvas=document.createElement('canvas');canvas.width=canvas.height=64;document.body.append(canvas);
    const device=new WebGLDevice(canvas,{alpha:true,antialias:false,depth:false,stencil:false,preserveDrawingBuffer:true});
    const atlas=new GlyphAtlas(device,{width:1,height:1,data:new Uint8Array([255,255,255,255]),unitsPerEm:1,ascent:1,descent:0,glyphs:{'U+41':{x:0,y:0,width:1,height:1,advance:1,bearingY:1}}});
    const vector=new VectorRenderer(device,{glyphAtlas:atlas,initialVertices:128,maxVertices:4096});
    const ctx=new VectorContext(device,{vectorRenderer:vector,glyphAtlas:atlas});const primitive=new PrimitivePainter(ctx);const gl=device.gl;
    const pipeline=device.createPipeline({vertex:'attribute vec2 p;void main(){gl_Position=vec4(p,0.,1.);}',fragment:'precision mediump float;void main(){gl_FragColor=vec4(1.,0.,0.,1.);}',stride:8,attributes:[{name:'p',size:2,offset:0}]});
    const mesh=ctx.createStaticMesh(new Float32Array([-.9,.7,-.7,.7,-.8,.9]),{strideFloats:2});
    const pixel=(x,y)=>{const p=new Uint8Array(4);gl.readPixels(x,63-y,1,1,gl.RGBA,gl.UNSIGNED_BYTE,p);return [...p]};
    ctx.beginFrame({clearColor:[0,0,1,1]});
    ctx.beginGroup(.5,{x:8,y:8,width:48,height:40});ctx.fillStyle='red';ctx.fillRect(8,8,32,32);ctx.fillRect(24,8,32,32);ctx.endGroup();
    ctx.save();ctx.beginPath();ctx.moveTo(2,44);ctx.lineTo(18,44);ctx.lineTo(18,60);ctx.lineTo(2,60);ctx.closePath();ctx.clip();
    ctx.fillTriangleFan([[2,44],[30,44],[30,48],[2,48]],'#00ff00');const fanBounds=vector.vertices.slice(0,vector.count*8).reduce((b,_,i,a)=>{if(i%8===0){b.minX=Math.min(b.minX,a[i]);b.maxX=Math.max(b.maxX,a[i]);}return b;},{minX:Infinity,maxX:-Infinity});ctx.restore();
    ctx.strokeStyle='#ffffff';ctx.lineWidth=4;ctx.lineCap='round';ctx.lineJoin='round';ctx.setLineDash([8,8]);ctx.beginPath();ctx.moveTo(4,52);ctx.lineTo(60,52);ctx.stroke();
    primitive.regularPolygon(48,52,6,'#ffffff',6,0);
    ctx.fillStyle='#ffffff';ctx.font='8px sans-serif';ctx.textAlign='center';ctx.textBaseline='top';ctx.fillText('A',32,4);
    ctx.drawStaticMesh(mesh,{pipeline});
    const stats=ctx.endFrame();const pixels={groupOuter:pixel(12,12),groupOverlap:pixel(28,12),clipInside:pixel(10,46),clipOutside:pixel(24,46),dash:pixel(8,52),dashGap:pixel(16,52),roundCap:pixel(3,52),primitive:pixel(48,52),glyph:pixel(32,7),staticMesh:pixel(6,6)};
    ctx.beginFrame();ctx.setLineDash([]);ctx.strokeStyle='white';ctx.lineWidth=2;
    for(let i=0;i<1000;i++){ctx.fillStyle=i===999?'blue':'red';ctx.fillRect(20,20,20,20);}
    ctx.beginPath();ctx.moveTo(4,4);ctx.lineTo(12,4);ctx.stroke();
    const batched=ctx.endFrame(),batchPixel=pixel(30,30),strokePixel=pixel(8,4);
    const error=gl.getError();window.vectorContextProbe={device,vector,atlas,ctx,canvas,pipeline,mesh};
    return{pixels,fanBounds,stats,batched,batchPixel,strokePixel,error,vertexCapacity:vector.vertices.length,textureBytes:device.stats.gpuRenderTargetBytes};
  });
  assert.ok(Math.abs(result.pixels.groupOuter[0]-128)<=3&&Math.abs(result.pixels.groupOuter[2]-127)<=3,'group opacity applies once to a path fill');
  assert.ok(Math.abs(result.pixels.groupOverlap[0]-128)<=3&&Math.abs(result.pixels.groupOverlap[2]-127)<=3,'overlapping fills composite once inside a group');
  assert.deepEqual(result.pixels.clipInside,[0,255,0,255],JSON.stringify({pixels:result.pixels,fanBounds:result.fanBounds}));assert.deepEqual(result.pixels.clipOutside,[0,0,255,255],JSON.stringify({pixels:result.pixels,fanBounds:result.fanBounds}));
  assert.ok(result.pixels.dash[0]>240&&result.pixels.dash[1]>240,'dashed path paints in its on interval');assert.deepEqual(result.pixels.dashGap,[0,0,255,255]);assert.ok(result.pixels.roundCap[0]>240,'round line cap extends beyond the endpoint');
  assert.ok(result.pixels.primitive[0]>240&&result.pixels.primitive[1]>240,`public primitive painter emits WebGL fan geometry: ${JSON.stringify(result.pixels)}`);
  assert.ok(result.pixels.glyph[0]>240,'text keeps the caller-provided prebaked glyph atlas');assert.deepEqual(result.pixels.staticMesh,[255,0,0,255]);assert.equal(result.error,0);
  assert.equal(result.textureBytes,64*64*4);assert.ok(result.stats.vertices>0&&result.stats.drawCalls>0);
  assert.equal(result.batched.drawCalls,2,'adjacent fill/stroke submits only at bounded capacity and frame end');
  assert.deepEqual(result.batchPixel,[0,0,255,255],'capacity flush preserves painter order');assert.deepEqual(result.strokePixel,[255,255,255,255]);
  result.restored=await page.evaluate(()=>{const p=vectorContextProbe;p.loss=p.device.gl.getExtension('WEBGL_lose_context');if(!p.loss)return false;p.loss.loseContext();return true;});
  if(result.restored){await page.waitForFunction(()=>vectorContextProbe.ctx.state==='lost');assert.equal(await page.evaluate(()=>vectorContextProbe.ctx.beginFrame()),false);await page.evaluate(()=>vectorContextProbe.loss.restoreContext());await page.waitForFunction(()=>vectorContextProbe.ctx.state==='ready');result.restoredPixel=await page.evaluate(()=>{const p=vectorContextProbe;p.ctx.beginFrame({clearColor:[0,0,1,1]});p.ctx.drawStaticMesh(p.mesh,{pipeline:p.pipeline});p.ctx.endFrame();return{pixel:p.ctx.device.gl.getError(),red:p.ctx.device.stats.drawCalls>0}});assert.deepEqual(result.restoredPixel,{pixel:0,red:true});}
  result.disposed=await page.evaluate(()=>{const p=vectorContextProbe;p.ctx.dispose();p.vector.dispose();p.atlas.dispose();p.device.dispose();p.canvas.remove();return p.device.state==='disposed'&&p.device.stats.gpuRenderTargetBytes===0&&p.device.stats.gpuBufferBytes===0});
  assert.equal(result.disposed,true);return result;
}

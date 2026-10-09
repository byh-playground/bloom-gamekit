import assert from 'node:assert/strict';

/** Pixel proof for the actual Budmori renderer contracts, without game code or private SDK calls. */
export async function exerciseVectorGameCoverage(page){
  const result=await page.evaluate(async()=>{
    const {WebGLDevice,VectorRenderer,VectorContext,PrimitivePainter}=await import('/dist/rendering.js');
    const canvas=document.createElement('canvas');canvas.width=canvas.height=128;document.body.append(canvas);
    const device=new WebGLDevice(canvas,{alpha:true,antialias:false,depth:false,stencil:false,preserveDrawingBuffer:true});
    const vector=new VectorRenderer(device,{initialVertices:256,maxVertices:8192});const ctx=new VectorContext(device,{vectorRenderer:vector});const gl=device.gl;
    const pixel=(x,y)=>{const out=new Uint8Array(4);gl.readPixels(x,127-y,1,1,gl.RGBA,gl.UNSIGNED_BYTE,out);return [...out]};
    const renderStarted=performance.now();ctx.beginFrame({clearColor:[0,0,0,0]});
    ctx.save();ctx.translate(24,24);ctx.fillStyle='#183fce';ctx.withSilhouette('#16e277',3,()=>{ctx.beginPath();ctx.arc(0,0,10,0,Math.PI*2);ctx.fill()},15);ctx.restore();
    ctx.save();ctx.translate(64,24);ctx.globalAlpha=.5;ctx.filter='brightness(0) invert(1)';ctx.fillStyle='#df2020';ctx.withSilhouette('#18a04a',3,()=>{ctx.beginPath();ctx.arc(0,0,10,0,Math.PI*2);ctx.fill()},15);ctx.restore();
    ctx.save();ctx.translate(100,24);const gradient=ctx.createRadialGradient(0,0,0,0,0,18);gradient.addColorStop(0,'#ff0000');ctx.fillStyle=gradient;ctx.beginPath();ctx.arc(0,0,18,0,Math.PI*2);ctx.fill();gradient.addColorStop(.5,'#00ff00');gradient.addColorStop(1,'#0000ff00');ctx.beginPath();ctx.arc(0,0,9,0,Math.PI*2);ctx.fill();ctx.restore();
    ctx.save();ctx.translate(100,64);ctx.filter='brightness(0) invert(1)';const flashGradient=ctx.createRadialGradient(0,0,0,0,0,12);flashGradient.addColorStop(0,'rgba(180,30,90,.6)');flashGradient.addColorStop(1,'rgba(0,0,0,0)');ctx.fillStyle=flashGradient;ctx.beginPath();ctx.arc(0,0,12,0,Math.PI*2);ctx.fill();ctx.restore();
    ctx.withGroupOpacity(.5,()=>{ctx.fillStyle='#ff0000';ctx.fillRect(8,76,20,20);},{x:8,y:76,width:20,height:20});
    const stats=ctx.endFrame(),renderSubmitMs=performance.now()-renderStarted;const pixels={body:pixel(24,24),outline:pixel(36,24),flashBody:pixel(64,24),flashOutline:pixel(76,24),gradientCenter:pixel(100,24),gradientMiddle:pixel(108,24),gradientOuter:pixel(118,24),whiteGradient:pixel(100,64),whiteGradientAlpha:pixel(106,64),group:pixel(16,84)};

    const uploadsBeforeNative=device.stats.textureUploads,nativeA=document.createElement('canvas'),nativeB=document.createElement('canvas');nativeA.width=nativeA.height=nativeB.width=nativeB.height=40;const target=nativeA.getContext('2d'),reference=nativeB.getContext('2d');
    const turn=(x,y)=>[20-(y-20)*.8,20+(x-20)*.8],colors=[.18,.72,.38,.8],painter=new PrimitivePainter(target,{point:turn,alphaMultiplier:.65});
    const css=c=>`rgba(${Math.round(c[0]*255)},${Math.round(c[1]*255)},${Math.round(c[2]*255)},${c[3]})`;
    const oldPoly=(ctx,points,color)=>{const alpha=ctx.globalAlpha;ctx.fillStyle=css(color);ctx.globalAlpha=alpha*.65;ctx.beginPath();const a=turn(points[0][0],points[0][1]);for(let i=1;i<points.length-1;i++){const b=turn(points[i][0],points[i][1]),c=turn(points[i+1][0],points[i+1][1]);ctx.moveTo(...a);ctx.lineTo(...b);ctx.lineTo(...c);ctx.closePath();}ctx.fill();ctx.globalAlpha=alpha;};
    const polygon=(x,y,r,n,rotation)=>Array.from({length:n},(_,i)=>[x+Math.cos(rotation+i/n*Math.PI*2)*r,y+Math.sin(rotation+i/n*Math.PI*2)*r]);
    const poly=polygon(20,20,13,7,.2),nativeStarted=performance.now();painter.regularPolygon(20,20,13,colors,7,.2);
    const dx=9,dy=-4,w=6,l=Math.hypot(dx,dy)||1,nx=-dy/l*w/2,ny=dx/l*w/2;const quad=[[9+nx,12+ny],[18+nx,8+ny],[18-nx,8-ny],[9-nx,12-ny]];painter.line(9,12,18,8,w,[.9,.35,.12,.7]);const nativePainterMs=performance.now()-nativeStarted;oldPoly(reference,poly,colors);oldPoly(reference,quad,[.9,.35,.12,.7]);
    const a=target.getImageData(0,0,40,40).data,b=reference.getImageData(0,0,40,40).data;let canvasDiff=0;for(let i=0;i<a.length;i++)if(a[i]!==b[i])canvasDiff++;
    const glError=gl.getError();window.vectorGameCoverageProbe={device,vector,ctx,canvas};
    return{pixels,stats,glError,renderSubmitMs,nativePainterMs,canvasDiff,canvasBytes:a.byteLength,canvasGpuUploads:device.stats.textureUploads-uploadsBeforeNative,gradientRampBytes:2*256*4};
  });
  assert.deepEqual(result.pixels.body,[24,63,206,255]);assert.deepEqual(result.pixels.outline,[22,226,119,255]);
  assert.deepEqual(result.pixels.flashBody,[128,128,128,128]);assert.deepEqual(result.pixels.flashOutline,[128,128,128,128]);
  assert.ok(result.pixels.gradientCenter[0]>225&&result.pixels.gradientCenter[1]<30,`radial gradient center uses first stop: ${JSON.stringify(result.pixels)}`);
  assert.ok(result.pixels.gradientMiddle[1]>220&&result.pixels.gradientMiddle[1]>result.pixels.gradientMiddle[0]&&result.pixels.gradientMiddle[1]>result.pixels.gradientMiddle[2],'radial gradient ramp refreshes after adding a stop');
  assert.deepEqual(result.pixels.gradientOuter,[0,0,0,0],'transparent gradient stop preserves zero alpha');
  assert.ok(result.pixels.whiteGradient.every(c=>Math.abs(c-144)<=5),'white flash turns RGB white while preserving gradient alpha');
  assert.ok(result.pixels.whiteGradientAlpha[0]>result.pixels.whiteGradient[0]/2-8&&result.pixels.whiteGradientAlpha[0]<result.pixels.whiteGradient[0]/2+8,'gradient alpha ramps smoothly toward the transparent stop');
  assert.deepEqual(result.pixels.group,[128,0,0,128]);assert.equal(result.glError,0);
  assert.equal(result.canvasDiff,0,'native Canvas2D primitive target matches the authored fan reference pixel-for-pixel');
  assert.equal(result.canvasGpuUploads,0,'native UI paint target does not upload or rasterize through WebGL');
  result.disposed=await page.evaluate(()=>{const p=vectorGameCoverageProbe;p.ctx.dispose();p.vector.dispose();p.device.dispose();p.canvas.remove();return p.device.state==='disposed'&&p.device.stats.gpuBufferBytes===0&&p.device.stats.textureCount===0&&p.device.stats.gpuRenderTargetBytes===0});
  assert.equal(result.disposed,true);return result;
}

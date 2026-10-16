import assert from 'node:assert/strict';

export async function exerciseNonScalingStroke(browser, moduleURL, compiledGeometry, screenshotPath) {
  const page=await browser.newPage({viewport:{width:420,height:290},deviceScaleFactor:2});
  const pageErrors=[];
  page.on('pageerror',error=>pageErrors.push(error.message));
  try {
    await page.setContent(`<!doctype html><meta charset="utf-8"><style>
      *{box-sizing:border-box}body{margin:0;padding:28px;background:#101820;color:#e8f0f3;font:16px/1.5 system-ui,sans-serif}
      h1{font-size:18px;font-weight:600;margin:0 0 14px}p{font-size:13px;color:#9fb0bb;margin:0 0 16px}
      canvas{display:block;background:#26343d;border:1px solid #6b7d87;image-rendering:auto}
    </style><h1>GameKit WebGL • SVG non-scaling-stroke</h1>
    <p>1.5 CSS px · retained SVG line · DPR 2 · non-uniform part transform</p><canvas></canvas>`);
    const result=await page.evaluate(async({moduleURL,geometry,screenshotPath})=>{
      const {WebGLDevice,MeshRenderer}=await import(moduleURL);
      const canvas=document.querySelector('canvas');
      const device=new WebGLDevice(canvas,{alpha:true,antialias:true,depth:true});
      const renderer=new MeshRenderer(device);
      const mesh=renderer.createMesh({...geometry,vertices:Float32Array.from(geometry.vertices),indices:Uint16Array.from(geometry.indices)});
      const geometryUploadsAtCreation=renderer.stats().geometryUploads;
      const identity=[1,0,0,1,0,0];
      const projectionFor=(width,height,zoom=1)=>[2*zoom/width,0,0,0,-2*zoom/height,0,-zoom,zoom,1];
      const transformed=(x,y,part)=>({x:part[0]*x+part[2]*y+part[4],y:part[1]*x+part[3]*y+part[5]});
      const screen=(point,projection,width,height)=>{
        const x=projection[0]*point.x+projection[3]*point.y+projection[6];
        const y=projection[1]*point.x+projection[4]*point.y+projection[7];
        const w=projection[2]*point.x+projection[5]*point.y+projection[8];
        return {x:(x/w+1)*width/2,y:(1-y/w)*height/2};
      };
      const measure=(pixels,width,height,dpr,start,end)=>{
        const dx=end.x-start.x,dy=end.y-start.y,length=Math.hypot(dx,dy),windowStart=0.2,windowEnd=0.8;
        let alpha=0,maximum=0,highestY=-Infinity;
        for(let py=0;py<height*dpr;py++)for(let px=0;px<width*dpr;px++){
          const at=(py*width*dpr+px)*4+3,value=pixels[at]/255;
          if(!value)continue;
          maximum=Math.max(maximum,pixels[at]);
          const x=(px+0.5)/dpr,y=height-(py+0.5)/dpr;
          highestY=Math.max(highestY,y);
          const t=((x-start.x)*dx+(y-start.y)*dy)/(length*length);
          const distance=Math.abs(dx*(start.y-y)-(start.x-x)*dy)/length;
          if(t>=windowStart&&t<=windowEnd&&distance<=4)alpha+=value;
        }
        return {cssWidth:alpha/(dpr*dpr)/(length*(windowEnd-windowStart)),maximumAlpha:maximum,highestY,length};
      };
      const render=(name,{width=160,height=100,dpr=1,zoom=1,part=identity,alpha=1,clips=[]}={})=>{
        canvas.style.width=`${width}px`;canvas.style.height=`${height}px`;
        const backingWidth=width*dpr,backingHeight=height*dpr;
        device.beginFrame({width:backingWidth,height:backingHeight,clearColor:[0,0,0,0]});renderer.beginFrame();
        const projection=projectionFor(width,height,zoom);
        const partPose=[{transform:part}];
        renderer.drawMesh(mesh,{projection,parts:partPose,alpha,clips,depthTest:true,depthWrite:false});
        renderer.flush();
        const gl=device.gl,pixels=new Uint8Array(backingWidth*backingHeight*4);
        gl.readPixels(0,0,backingWidth,backingHeight,gl.RGBA,gl.UNSIGNED_BYTE,pixels);
        device.endFrame();
        const startLocal=transformed(20,50,part),endLocal=transformed(80,50,part);
        return {name,width,height,dpr,pixels,measure:measure(pixels,width,height,dpr,screen(startLocal,projection,width,height),screen(endLocal,projection,width,height)),draws:renderer.stats().draws};
      };
      const identityPart=[1,0,0,1,40,0];
      const base=render('css-160-dpr1',{part:identityPart,dpr:1});
      const dpr2=render('css-160-dpr2',{part:identityPart,dpr:2});
      const zoomed=render('camera-zoom-1_5',{part:identityPart,dpr:2,zoom:1.5});
      const animatedPart=[1,0.35,-0.55,0.65,35,20];
      const animated=render('part-nonuniform-rotation',{part:animatedPart,dpr:2});
      const larger=render('css-320-dpr1',{width:320,height:200,part:[1,0,0,1,80,0],dpr:1});
      const renderTarget=device.createRenderTarget(320,200);
      let renderTargetRequiresViewport=false;
      device.beginFrame({width:320,height:200,clearColor:[0,0,0,0]});renderer.beginFrame();device.bindRenderTarget(renderTarget);device.clear({color:[0,0,0,0]});
      try { renderer.drawMesh(mesh,{projection:projectionFor(160,100),parts:[{transform:identityPart}]}); }
      catch(error) { renderTargetRequiresViewport=/strokeViewport/.test(error.message); }
      renderer.drawMesh(mesh,{projection:projectionFor(160,100),matrix:identity,parts:[{transform:identityPart}],strokeViewport:[160,100]});renderer.flush();
      const targetPixels=new Uint8Array(320*200*4);device.gl.readPixels(0,0,320,200,device.gl.RGBA,device.gl.UNSIGNED_BYTE,targetPixels);device.unbindRenderTarget(renderTarget);device.endFrame();
      const offscreen={cssWidth:measure(targetPixels,160,100,2,screen(transformed(20,50,identityPart),projectionFor(160,100),160,100),screen(transformed(80,50,identityPart),projectionFor(160,100),160,100)).cssWidth};
      const clipped=render('clipped-expanded-edge',{part:identityPart,dpr:2,clips:[[
        {x:0,y:0},{x:160,y:0},{x:160,y:50.5},{x:0,y:50.5},
      ]]});
      const halfAlpha=render('half-alpha-depth',{part:identityPart,dpr:2,alpha:0.5});
      const baseAlpha=base.pixels.filter((_,i)=>i%4===3);
      if(!baseAlpha.some(value=>value>0))throw new Error('WebGL stroke produced no pixels');
      const clippedPixels=[];
      for(let py=0;py<clipped.height*clipped.dpr;py++)for(let px=0;px<clipped.width*clipped.dpr;px++){
        if(clipped.pixels[(py*clipped.width*clipped.dpr+px)*4+3])clippedPixels.push(clipped.height-(py+0.5)/clipped.dpr);
      }
      const restored=await (async()=>{
        const extension=device.gl.getExtension('WEBGL_lose_context');
        if(!extension)return {supported:false};
        const waitForState=state=>new Promise((resolve,reject)=>{
          const deadline=performance.now()+10000;
          const poll=()=>{if(renderer.stats().state===state)return resolve();if(renderer.stats().state==='failed')return reject(new Error('MeshRenderer failed during WebGL restore'));if(performance.now()>deadline)return reject(new Error('WebGL context '+state+' timed out'));requestAnimationFrame(poll);};poll();
        });
        extension.loseContext();await waitForState('lost');
        extension.restoreContext();await waitForState('ready');
        const after=render('context-restored',{part:identityPart,dpr:2});
        return {supported:true,state:renderer.stats().state,width:after.measure.cssWidth};
      })();
      const screenshotCase=render('evidence',{width:320,height:200,part:[1.3,0.4,-0.8,0.5,65,-20],dpr:2});
      await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
      await document.fonts.ready;
      // The enclosing Playwright call saves the canvas and caption as one reviewable image.
      const report={base:base.measure,dpr2:dpr2.measure,zoomed:zoomed.measure,animated: { ...animated.measure,draws:animated.draws },larger:larger.measure,offscreen,renderTargetRequiresViewport,
        clippedPixelCount:clippedPixels.length,clippedMaxY:Math.max(...clippedPixels),halfAlphaMaximum:halfAlpha.measure.maximumAlpha,restored,geometryUploadsAtCreation,geometryUploadsAfterFrames:renderer.stats().geometryUploads,
        screenshot:{cssWidth:320,cssHeight:200,dpr:2,nonScalingWidth:screenshotCase.measure.cssWidth}};
      window.__nonScalingStrokeTest={dispose(){renderer.deleteMesh(mesh);const disposed=renderer.stats().meshCount;const targetDisposed=device.deleteRenderTarget(renderTarget);renderer.dispose();device.dispose();return {disposed,targetDisposed};}};
      return report;
    },{moduleURL,geometry:compiledGeometry});
    assert.ok(Math.abs(result.base.cssWidth-1.5)<0.42,`DPR1 rendered ${result.base.cssWidth.toFixed(3)} CSS px, expected 1.5`);
    for(const key of ['dpr2','zoomed','animated','larger'])assert.ok(Math.abs(result[key].cssWidth-1.5)<0.42,`${key} rendered ${result[key].cssWidth.toFixed(3)} CSS px`);
    assert.ok(Math.abs(result.base.cssWidth-result.dpr2.cssWidth)<0.28,'CSS stroke width is invariant across device-pixel ratios');
    assert.ok(Math.abs(result.base.cssWidth-result.zoomed.cssWidth)<0.28,'camera zoom does not scale stroke width');
    assert.ok(Math.abs(result.base.cssWidth-result.animated.cssWidth)<0.28,'part rotation and non-uniform scale do not scale stroke width');
    assert.ok(Math.abs(result.base.cssWidth-result.larger.cssWidth)<0.28,'the same scene keeps its CSS-pixel width in a larger viewport');
    assert.ok(Math.abs(result.offscreen.cssWidth-1.5)<0.42,'offscreen render targets preserve CSS-pixel width when the host supplies the logical viewport');
    assert.equal(result.renderTargetRequiresViewport,true,'offscreen targets fail clearly when their CSS viewport is not supplied');
    assert.ok(result.clippedMaxY<=50.75,`expanded stroke pixels must still obey the clip polygon (max y=${result.clippedMaxY})`);
    assert.ok(result.clippedPixelCount>0,'the clipped stroke keeps its portion inside the clip polygon');
    assert.ok(result.halfAlphaMaximum<=129&&result.halfAlphaMaximum>=120,'stroke alpha remains part of the normal premultiplied blend path');
    assert.equal(result.geometryUploadsAtCreation,1,'the retained line uploads its static geometry once');
    assert.equal(result.geometryUploadsAfterFrames,0,'ordinary frames do not upload or tessellate stroke geometry');
    assert.equal(result.restored.supported,true,'the browser provides WEBGL_lose_context for the retained-mesh restore check');
    assert.equal(result.restored.state,'ready');
    assert.ok(Math.abs(result.restored.width-1.5)<0.28,'restored mesh keeps its screen-space stroke width');
    if(pageErrors.length)throw new Error('WebGL non-scaling stroke page errors: '+pageErrors.join('; '));
    await page.screenshot({path:screenshotPath,fullPage:true});
    const disposed=await page.evaluate(()=>window.__nonScalingStrokeTest.dispose());
    result.disposedMeshCount=disposed.disposed;
    assert.equal(result.disposedMeshCount,0,'the retained mesh disposes normally');
    assert.equal(disposed.targetDisposed,true,'the offscreen target disposes normally');
    return result;
  } finally {
    await page.close();
  }
}

import assert from 'node:assert/strict';

export async function exerciseYarnShader(browser, moduleURL, screenshotPath) {
  const page = await browser.newPage({ viewport: { width: 420, height: 260 }, deviceScaleFactor: 1 });
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  try {
    await page.setContent(`<!doctype html><meta charset="utf-8"><style>
      *{box-sizing:border-box}body{margin:0;padding:18px;background:#f1f0e8;color:#293e36;font:14px/1.4 system-ui,sans-serif}
      h1{font-size:17px;margin:0 0 12px}.row{display:flex;align-items:flex-start;gap:22px}.card{padding:10px;background:#fffdf4;border:1px solid #d5dec2;border-radius:8px}
      canvas{display:block;background:repeating-conic-gradient(#cfdbb8 0 25%,#dfe8cb 0 50%) 0/16px 16px}small{display:block;margin-top:6px}
    </style><h1>GameKit yarn shader · retained fill + fixed contour strip</h1>
    <div class="row"><div class="card"><canvas id="mobile"></canvas><small>47 CSS px</small></div><div class="card"><canvas id="desktop"></canvas><small>74 CSS px</small></div></div>`);
    const result = await page.evaluate(async ({ moduleURL }) => {
      const { WebGLDevice, VectorRenderer, VectorContext, YarnSurfaceRenderer } = await import(moduleURL);
      const makeCanvas = id => document.getElementById(id);
      const outline = [];
      for (let i = 0; i < 72; i++) {
        const angle = i / 72 * Math.PI * 2;
        outline.push(80 + Math.cos(angle) * 56, 90 + Math.sin(angle) * 68);
      }
      const fillVertices = [];
      for (let i = 0; i < 72; i++) {
        const a = i / 72 * Math.PI * 2, b = (i + 1) / 72 * Math.PI * 2;
        fillVertices.push(80,90,0.84,0.49,0.29,1,
          80+Math.cos(a)*56,90+Math.sin(a)*68,0.84,0.49,0.29,1,
          80+Math.cos(b)*56,90+Math.sin(b)*68,0.84,0.49,0.29,1);
      }
      const style = { kind:'yarn',seed:41,stitchWidth:14.4,stitchHeight:15.6,thickness:0.4102564103,irregularity:0.13,contrast:0.23,
        edgeSpacing:10,edgeRelief:3.04,edgeWidth:3.92,fiberLength:8.8,fiberWidth:0.88,fiberOpacity:0.65,fiberSpacing:4,fiberMax:155,
        curved:true,pattern:true,detail:false,fiber:true };
      const outlineData = Float32Array.from(outline), fillData = Float32Array.from(fillVertices);
      const colorData = Float32Array.from(Array.from({length:72},(_,i)=>{const t=i/72;return [0.82-t*0.12,0.48-t*0.08,0.28-t*0.06,1]}).flat());
      const samples = {};
      for (const [id,size] of [['mobile',47],['desktop',74]]) {
        const canvas=makeCanvas(id), dpr=2;
        canvas.style.width=`${size+24}px`;canvas.style.height=`${size+24}px`;
        canvas.width=(size+24)*dpr;canvas.height=(size+24)*dpr;
        const device=new WebGLDevice(canvas,{alpha:true,antialias:true,depth:true,preserveDrawingBuffer:true});
        const surfaces=new YarnSurfaceRenderer(device);
        const surface=surfaces.createSurface({fillVertices:fillData,outline:outlineData,edgeColors:colorData,style});
        const render=()=>{
          if(!device.beginFrame({width:canvas.width,height:canvas.height,clearColor:[0,0,0,0]})) throw new Error('WebGL context did not begin');
          const scale=size/150, left=12+(size+24)/2-80*scale, top=12+(size+24)/2-90*scale;
          const transform=[scale,0,0,scale,left,top];
          const projection=[2/(size+24),0,0,0,-2/(size+24),0,-1,1,1];
          surfaces.drawSurface(surface,{projection,transform,clips:[[ {x:1,y:1},{x:size+23,y:1},{x:size+23,y:size+23},{x:1,y:size+23} ]],alpha:0.8,z:0.25,depth:true});
          device.endFrame();
          const pixels=new Uint8Array(canvas.width*canvas.height*4);device.gl.readPixels(0,0,canvas.width,canvas.height,device.gl.RGBA,device.gl.UNSIGNED_BYTE,pixels);
          let covered=0, varied=0, dark=0, outside=0;
          for(let i=0;i<pixels.length;i+=4){if(pixels[i+3]){covered++; const pixel=i/4,x=pixel%canvas.width,y=Math.floor(pixel/canvas.width); const interior=Math.abs(x-canvas.width/2)<size*0.30*dpr&&Math.abs(y-canvas.height/2)<size*0.30*dpr; if(interior&&(Math.abs(pixels[i]-171)+Math.abs(pixels[i+1]-100)+Math.abs(pixels[i+2]-59)>24))varied++; if(interior&&pixels[i+3]>200&&pixels[i]<150)dark++;}}
          const outsideAt=(canvas.height-2)*canvas.width*4+(canvas.width-2)*4;outside=pixels[outsideAt+3];
          return {size,dpr,covered,varied,dark,outside,drawCalls:device.stats.drawCalls,vertexCount:device.stats.vertices,meshVertices:surface.vertices.length/9};
        };
        samples[id]=render();
        if(id==='mobile'){
          const ext=device.gl.getExtension('WEBGL_lose_context');
          if(!ext) throw new Error('WEBGL_lose_context extension unavailable');
          const lost=new Promise(resolve=>canvas.addEventListener('webglcontextlost',()=>resolve(true),{once:true}));
          ext.loseContext(); await lost;
          await new Promise(resolve=>setTimeout(resolve,100));
          const restored=new Promise(resolve=>canvas.addEventListener('webglcontextrestored',()=>resolve(true),{once:true}));
          ext.restoreContext(); await restored;
          samples.mobileRestored={...render(),state:surfaces.stats().state};
          if (!surfaces.deleteSurface(surface) || surfaces.stats().surfaceCount !== 0) throw new Error('Surface disposal failed');
          surfaces.dispose(); if (surfaces.dispose() !== false) throw new Error('Renderer disposal must be idempotent'); device.dispose();
        } else {
          if (!surfaces.deleteSurface(surface) || surfaces.stats().surfaceCount !== 0) throw new Error('Surface disposal failed');
          surfaces.dispose(); device.dispose();
        }
      }
      {
        const canvas=document.createElement('canvas');canvas.width=220;canvas.height=140;canvas.style.cssText='display:block;margin:12px auto;background:#fffdf4;border:1px solid #b9c3aa';document.body.append(canvas);
        const device=new WebGLDevice(canvas,{alpha:true,antialias:false,depth:false,stencil:true,preserveDrawingBuffer:true});
        const vector=new VectorRenderer(device,{initialVertices:128,maxVertices:4096}),ctx=new VectorContext(device,{vectorRenderer:vector}),surfaces=new YarnSurfaceRenderer(device);
        const quad=Float32Array.from([5,5,.82,.48,.28,1,105,5,.82,.48,.28,1,105,105,.82,.48,.28,1,5,5,.82,.48,.28,1,105,105,.82,.48,.28,1,5,105,.82,.48,.28,1]);
        const outline=Float32Array.from([5,5,105,5,105,105,5,105]),edgeColors=Float32Array.from([.86,.57,.34,1,.78,.43,.25,1,.70,.36,.20,1,.82,.49,.29,1]);
        const style={kind:'yarn',seed:13,stitchWidth:14,stitchHeight:16,thickness:.41,irregularity:.13,contrast:.23,edgeSpacing:10,edgeRelief:3,edgeWidth:4,fiberLength:8,fiberWidth:.8,fiberOpacity:.65,fiberSpacing:4,fiberMax:155,curved:true,pattern:true,detail:false,fiber:true};
        const surface=surfaces.createSurface({fillVertices:quad,outline,edgeColors,style});
        const clip=ctx.createClipPath(new Float32Array([10,10,100,10,100,30,30,30,30,100,10,100]));
        const projection=[2/220,0,0,0,-2/140,0,-1,1,1],pixel=(x,y)=>{const p=new Uint8Array(4);device.gl.readPixels(x,139-y,1,1,device.gl.RGBA,device.gl.UNSIGNED_BYTE,p);return[...p]};
        const drawClipped=()=>{ctx.save();ctx.clipPath(clip);const ref=ctx.stencilRef;if(ref!==1)throw new Error(`expected active stencil ref 1, got ${ref}`);surfaces.drawSurface(surface,{projection,stencilRef:ref,alpha:.9,z:.2});return ref;};
        ctx.beginFrame({clearColor:[0,0,0,0]});drawClipped();ctx.restore();
        surfaces.drawSurface(surface,{projection,transform:[.42,0,0,.42,125,62],alpha:.9,z:.2});ctx.endFrame();
        const first={upperArm:pixel(60,20),leftArm:pixel(20,75),notch:pixel(80,75),unclippedAfter:pixel(155,90),drawCalls:device.stats.drawCalls,glError:device.gl.getError()};
        let restored=false,restoredPixels=null;
        const loss=device.gl.getExtension('WEBGL_lose_context');
        if(loss){
          const event=(name,trigger)=>new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error(`Timed out waiting for ${name}`)),20000);canvas.addEventListener(name,()=>{clearTimeout(timer);resolve(true)},{once:true});trigger();});
          ctx.beginFrame({clearColor:[0,0,0,0]});drawClipped();ctx.endFrame();
          await event('webglcontextlost',()=>loss.loseContext());await new Promise(resolve=>setTimeout(resolve,100));
          await event('webglcontextrestored',()=>loss.restoreContext());await new Promise(resolve=>setTimeout(resolve,80));
          ctx.beginFrame({clearColor:[0,0,0,0]});if(ctx.stencilRef!==1)throw new Error('retained stencil ref did not survive context restoration');
          surfaces.drawSurface(surface,{projection,stencilRef:ctx.stencilRef,alpha:.9,z:.2});ctx.restore();ctx.endFrame();
          restoredPixels={upperArm:pixel(60,20),notch:pixel(80,75),state:surfaces.stats().state};restored=true;
        }
        let missingStencilRejected=false,invalidStencilRefRejected=false;
        const noStencilCanvas=document.createElement('canvas');noStencilCanvas.width=noStencilCanvas.height=32;
        const noStencil=new WebGLDevice(noStencilCanvas,{stencil:false,depth:false}),noStencilSurfaces=new YarnSurfaceRenderer(noStencil);
        const tinyFill=Float32Array.from([0,0,.5,.5,.5,1,10,0,.5,.5,.5,1,10,10,.5,.5,.5,1]),tinyOutline=Float32Array.from([0,0,10,0,10,10,0,10]),tinyColors=Float32Array.from([1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1]);
        const tiny=noStencilSurfaces.createSurface({fillVertices:tinyFill,outline:tinyOutline,edgeColors:tinyColors,style});
        noStencil.beginFrame();try{noStencilSurfaces.drawSurface(tiny,{projection:[2/32,0,0,0,-2/32,0,-1,1,1],stencilRef:256});}catch(error){invalidStencilRefRejected=/\[0,255\]/.test(error.message);}try{noStencilSurfaces.drawSurface(tiny,{projection:[2/32,0,0,0,-2/32,0,-1,1,1],stencilRef:1});}catch(error){missingStencilRejected=/active stencil attachment/.test(error.message);}noStencil.endFrame();
        noStencilSurfaces.deleteSurface(tiny);noStencilSurfaces.dispose();noStencil.dispose();
        if(!surfaces.deleteSurface(surface)||surfaces.stats().surfaceCount!==0)throw new Error('stencil surface disposal failed');
        surfaces.dispose();ctx.dispose();vector.dispose();device.dispose();
        samples.stencil={...first,restored,restoredPixels,missingStencilRejected,invalidStencilRefRejected,disposed:device.stats.gpuBufferBytes===0&&device.stats.textureCount===0};
      }
      return samples;
    }, { moduleURL });
    assert.deepEqual(pageErrors, []);
    for (const name of ['mobile','desktop','mobileRestored']) {
      const sample=result[name];
      assert.ok(sample.covered > 120, `${name}: surface pixels should be visible`);
      assert.ok(sample.varied > 40, `${name}: shader should produce multiple yarn colors`);
      assert.ok(sample.dark > 0, `${name}: dark yarn grooves should render (observed ${sample.dark})`);
      assert.equal(sample.outside, 0, `${name}: clip should leave outside pixels transparent`);
      assert.equal(sample.drawCalls, 2, `${name}: fill and contour strip draw once each`);
      assert.ok(sample.meshVertices < 1000, `${name}: retained vertices must stay bounded`);
    }
    assert.equal(result.mobileRestored.state,'ready');
    assert.ok(result.stencil.upperArm[3]>0&&result.stencil.leftArm[3]>0,`concave stencil keeps both Yarn arms: ${JSON.stringify(result.stencil)}`);
    assert.equal(result.stencil.notch[3],0,'Yarn fill and contour stay inside the concave stencil notch');
    assert.ok(result.stencil.unclippedAfter[3]>0,'stencilRef null explicitly disables the previous stencil state');
    assert.equal(result.stencil.drawCalls,5,'stencil mask, two Yarn passes, then two unclipped Yarn passes preserve draw ordering');
    assert.equal(result.stencil.glError,0);
    assert.equal(result.stencil.missingStencilRejected,true,'stencil clipping without an attachment fails explicitly');
    assert.equal(result.stencil.invalidStencilRefRejected,true,'stencil refs outside [0,255] fail explicitly');
    assert.equal(result.stencil.disposed,true);
    if(result.stencil.restored){assert.ok(result.stencil.restoredPixels.upperArm[3]>0);assert.equal(result.stencil.restoredPixels.notch[3],0);assert.equal(result.stencil.restoredPixels.state,'ready');}
    await page.screenshot({path:screenshotPath,fullPage:true});
    return { samples: result, screenshotPath };
  } finally { await page.close(); }
}

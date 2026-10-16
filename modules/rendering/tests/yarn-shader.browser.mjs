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
      const { WebGLDevice, YarnSurfaceRenderer } = await import(moduleURL);
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
    await page.screenshot({path:screenshotPath,fullPage:true});
    return { samples: result, screenshotPath };
  } finally { await page.close(); }
}

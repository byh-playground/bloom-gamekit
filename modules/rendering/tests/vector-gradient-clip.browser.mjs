import assert from 'node:assert/strict';

export async function exerciseVectorGradientClip(browser, moduleURL, screenshotPath) {
  const page = await browser.newPage({ viewport: { width: 640, height: 360 }, deviceScaleFactor: 1 });
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('console', message => { if (message.type() === 'log') console.log(`[browser] ${message.text()}`); });
  try {
    await page.setContent(`<!doctype html><meta charset="utf-8"><style>
      *{box-sizing:border-box}body{margin:0;padding:16px;background:#f1f0e8;color:#293e36;font:14px/1.4 system-ui,sans-serif}
      h1{font-size:18px;margin:0 0 10px}.row{display:flex;align-items:flex-start;gap:14px}.card{padding:9px;background:#fffdf4;border:1px solid #d5dec2;border-radius:8px}
      canvas{display:block;background:#fff;margin:auto}small{display:block;margin-top:6px;text-align:center}
    </style><h1>GameKit linear gradients and retained concave clipping</h1>
    <div class="row"><div class="card"><canvas id="mobile"></canvas><small>47 CSS px · DPR 1 / 2</small></div>
    <div class="card"><canvas id="desktop"></canvas><small>74 CSS px · DPR 1 / 2</small></div>
    <div class="card"><canvas id="clip"></canvas><small>160-point retained C clip · vector, mesh, group</small></div></div>`);
    const result = await page.evaluate(async ({ moduleURL }) => {
      const checkpoint = name => console.log(`checkpoint: ${name}`);
      const { WebGLDevice, VectorRenderer, VectorContext } = await import(moduleURL);
      checkpoint('module imported');
      const gradientSamples = {};
      const gradientCanvases = [];
      let gradientStopLimitRejected = false;
      const readPixel = (gl, canvas, x, y, dpr) => {
        const pixels = new Uint8Array(4);
        gl.readPixels(Math.floor(x * dpr), canvas.height - 1 - Math.floor(y * dpr), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
        return [...pixels];
      };
      for (const [id, size] of [['mobile', 47], ['desktop', 74]]) {
        const canvas = document.getElementById(id), dpr = 1;
        canvas.style.width = `${size + 16}px`; canvas.style.height = `${size + 34}px`;
        canvas.width = (size + 16) * dpr; canvas.height = (size + 34) * dpr;
        const device = new WebGLDevice(canvas, { alpha: true, antialias: false, depth: false, stencil: true, preserveDrawingBuffer: true });
        const vector = new VectorRenderer(device, { initialVertices: 128, maxVertices: 8192 });
        const ctx = new VectorContext(device, { vectorRenderer: vector });
        ctx.beginFrame({ clearColor: [0, 0, 0, 0] });
        ctx.scale(dpr, dpr);
        const gradient = ctx.createLinearGradient(8, 8, 8 + size, 8);
        gradient.addColorStop(0, '#ff0000'); gradient.addColorStop(0.25, '#00ff00');
        gradient.addColorStop(0.75, '#0000ff'); gradient.addColorStop(1, '#ffffff');
        ctx.fillStyle = gradient; ctx.fillRect(8, 8, size, 20);
        const alphaGradient = ctx.createLinearGradient(8, 35, 8 + size, 35);
        alphaGradient.addColorStop(0, 'rgba(255,0,0,0)'); alphaGradient.addColorStop(1, 'rgba(0,0,255,1)');
        ctx.fillStyle = alphaGradient; ctx.fillRect(8, 32, size, 10);
        const strokeGradient = ctx.createLinearGradient(8, 46, 8 + size, 46);
        strokeGradient.addColorStop(0, '#ffcc00'); strokeGradient.addColorStop(1, '#cc00ff');
        ctx.strokeStyle = strokeGradient; ctx.lineWidth = 3; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
        ctx.beginPath(); ctx.moveTo(10, 49); ctx.lineTo(8 + size * 0.5, 46); ctx.lineTo(6 + size, 49); ctx.stroke();
        ctx.save(); ctx.translate(10, 57); ctx.rotate(0.32); ctx.scale(1.5, 0.65);
        const transformed = ctx.createLinearGradient(0, 0, 20, 0); transformed.addColorStop(0, 'red'); transformed.addColorStop(1, 'blue');
        ctx.fillStyle = transformed; ctx.fillRect(0, 0, 20, 8); ctx.restore();
        ctx.endFrame();
        if (id === 'mobile') {
          const capped = ctx.createLinearGradient(0,0,1,0);
          try { for (let i=0;i<33;i++) capped.addColorStop(i/32,'#123456'); } catch (error) { gradientStopLimitRejected = /32 color stops/.test(error.message); }
        }
        checkpoint(`${id} gradient frame rendered`);
        gradientSamples[id] = {
          cssSize: size, dpr, stops: [readPixel(device.gl, canvas, 8 + size * 0.08, 18, dpr), readPixel(device.gl, canvas, 8 + size * 0.5, 18, dpr), readPixel(device.gl, canvas, 8 + size * 0.92, 18, dpr)],
          alphaMid: readPixel(device.gl, canvas, 8 + size * 0.5, 37, dpr), strokeMid: readPixel(device.gl, canvas, 8 + size * 0.5, 47, dpr), transformedCoverage: readPixel(device.gl, canvas, 20, 62, dpr), error: device.gl.getError(), drawCalls: device.stats.drawCalls,
        };
        gradientCanvases.push({ canvas, device, vector, ctx });
      }

      const radialComparisons={};
      for(const [id,size,dpr] of [['radial-mobile',47,1],['radial-desktop',74,2]]){
        const canvas=document.createElement('canvas'),card=document.createElement('div'),label=document.createElement('small');
        card.className='card';label.textContent=`Two-circle radial gradient · ${size} CSS px · DPR ${dpr}`;canvas.style.cssText='display:block;background:white';card.append(canvas,label);document.querySelector('body').append(card);
        canvas.width=(size+16)*dpr;canvas.height=(size+16)*dpr;canvas.style.width=`${size+16}px`;canvas.style.height=`${size+16}px`;
        const reference=document.createElement('canvas');reference.width=canvas.width;reference.height=canvas.height;
        const device=new WebGLDevice(canvas,{alpha:true,antialias:false,depth:false,stencil:false,preserveDrawingBuffer:true});
        const vector=new VectorRenderer(device,{initialVertices:128,maxVertices:8192}),ctx=new VectorContext(device,{vectorRenderer:vector});
        ctx.beginFrame({clearColor:[0,0,0,0]});ctx.scale(dpr,dpr);ctx.translate((size+16)/2,(size+16)/2);ctx.scale(size/120,size/120);
        ctx.fillStyle='#304860';ctx.fillRect(-80,-80,160,160);
        const gradient=ctx.createRadialGradient(-18,-22,4,0,0,70);gradient.addColorStop(0,'#fff1cf');gradient.addColorStop(.58,'#d9b995');gradient.addColorStop(1,'#b78f75');
        ctx.fillStyle=gradient;ctx.beginPath();ctx.ellipse(0,0,50,44,0,0,Math.PI*2);ctx.fill();ctx.save();ctx.translate(60,0);ctx.fillStyle='#00ff00';ctx.fillRect(-8,-8,16,16);
        const identical=ctx.createRadialGradient(-18,-22,4,-18,-22,4);identical.addColorStop(0,'#fff1cf');identical.addColorStop(1,'#b78f75');ctx.fillStyle=identical;ctx.fillRect(-8,-8,16,16);ctx.restore();ctx.endFrame();
        const ref=reference.getContext('2d');ref.scale(dpr,dpr);ref.translate((size+16)/2,(size+16)/2);ref.scale(size/120,size/120);ref.fillStyle='#304860';ref.fillRect(-80,-80,160,160);
        const nativeGradient=ref.createRadialGradient(-18,-22,4,0,0,70);nativeGradient.addColorStop(0,'#fff1cf');nativeGradient.addColorStop(.58,'#d9b995');nativeGradient.addColorStop(1,'#b78f75');
        ref.fillStyle=nativeGradient;ref.beginPath();ref.ellipse(0,0,50,44,0,0,Math.PI*2);ref.fill();
        ref.save();ref.translate(60,0);ref.fillStyle='#00ff00';ref.fillRect(-8,-8,16,16);const nativeIdentical=ref.createRadialGradient(-18,-22,4,-18,-22,4);nativeIdentical.addColorStop(0,'#fff1cf');nativeIdentical.addColorStop(1,'#b78f75');ref.fillStyle=nativeIdentical;ref.fillRect(-8,-8,16,16);ref.restore();
        const glPixels=new Uint8Array(canvas.width*canvas.height*4);device.gl.readPixels(0,0,canvas.width,canvas.height,device.gl.RGBA,device.gl.UNSIGNED_BYTE,glPixels);
        const nativePixels=ref.getImageData(0,0,reference.width,reference.height).data;let compared=0,maxDiff=0,totalDiff=0,notchOrBackgroundMismatch=0;
        const scale=size/120,center=(size+16)/2;
        for(let y=1;y<canvas.height-1;y++)for(let x=1;x<canvas.width-1;x++){
          const cssX=(x+.5)/dpr-center,cssY=(y+.5)/dpr-center,localX=cssX/scale,localY=cssY/scale,ellipseEdge=Math.hypot(localX/50,localY/44);
          if(ellipseEdge>.90)continue;const glAt=((canvas.height-1-y)*canvas.width+x)*4,refAt=(y*canvas.width+x)*4;
          for(let k=0;k<4;k++){const diff=Math.abs(glPixels[glAt+k]-nativePixels[refAt+k]);maxDiff=Math.max(maxDiff,diff);totalDiff+=diff;compared++;}
          if(ellipseEdge<.8&&nativePixels[refAt+3]===255&&glPixels[glAt+3]===0)notchOrBackgroundMismatch++;
        }
        const identicalX=Math.floor((center+60*scale)*dpr),identicalY=Math.floor(center*dpr),identicalPixel=new Uint8Array(4);device.gl.readPixels(identicalX,canvas.height-1-identicalY,1,1,device.gl.RGBA,device.gl.UNSIGNED_BYTE,identicalPixel);
        radialComparisons[id]={size,dpr,compared,maxDiff,meanDiff:totalDiff/compared,notchOrBackgroundMismatch,identicalCirclePixel:[...identicalPixel],glError:device.gl.getError()};
        ctx.dispose();vector.dispose();device.dispose();
      }

      const canvas = document.getElementById('clip'); canvas.style.width = '160px'; canvas.style.height = '130px'; canvas.width = 160; canvas.height = 130;
      const device = new WebGLDevice(canvas, { alpha: true, antialias: false, depth: false, stencil: true, preserveDrawingBuffer: true });
      const vector = new VectorRenderer(device, { initialVertices: 128, maxVertices: 8192 });
      const ctx = new VectorContext(device, { vectorRenderer: vector });
      const corners = [[20,20],[100,20],[100,100],[20,100],[20,75],[75,75],[75,45],[20,45]];
      const authored = [];
      for (let i = 0; i < corners.length; i++) {
        const a = corners[i], b = corners[(i + 1) % corners.length];
        for (let j = 0; j < 20; j++) { const t = j / 20; authored.push(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t); }
      }
      const clip160 = ctx.createClipPath(Float32Array.from(authored), { rule: 'evenodd' });
      const inner = ctx.createClipPath(new Float32Array([30,25,55,25,55,40,30,40]));
      const meshVertices = [];
      for (const [x, y] of [[5,5],[115,5],[115,115],[5,5],[115,115],[5,115]]) meshVertices.push(x,y,1,0,0,1,0,0,0,0,0);
      const mesh = ctx.createMesh({ vertices: Float32Array.from(meshVertices), strideFloats: 11, partCount: 1, morphCount: 0 });
      const pixel = (x, y) => readPixel(device.gl, canvas, x, y, 1);
      ctx.beginFrame({ width: 160, height: 130, clearColor: [0,0,1,1] });
      ctx.save(); ctx.clipPath(clip160); ctx.drawMesh(mesh);
      ctx.save(); ctx.clipPath(inner); ctx.fillStyle = '#ffffff'; ctx.fillRect(0,0,130,120); ctx.restore();
      ctx.beginGroup(0.5, { x:0, y:0, width:130, height:120 }); ctx.fillStyle = '#00ff00'; ctx.fillRect(0,0,130,120); ctx.endGroup();
      ctx.endFrame();
      checkpoint('retained clip, mesh and group rendered');
      const clipPixels = { innerAndGroup: pixel(40,30), rightArm: pixel(85,60), openNotch: pixel(40,60), outside: pixel(120,60), error: device.gl.getError(), draws: device.stats.drawCalls };
      let savedClipDeletionRejected = false; try { ctx.deleteClipPath(clip160); } catch (error) { savedClipDeletionRejected = /every saved clip stack/.test(error.message); }

      const badSelfCrossing = new Float32Array([0,0,10,10,0,10,10,0]);
      let selfIntersectionRejected = false; try { ctx.createClipPath(badSelfCrossing); } catch (error) { selfIntersectionRejected = /simple|self-intersecting/.test(error.message); }
      let dynamicConcaveRejected = false;
      ctx.beginFrame({ width:160, height:130, clearColor:[0,0,1,1] });
      ctx.restore();
      ctx.beginPath(); for (let i=0;i<corners.length;i++) i ? ctx.lineTo(...corners[i]) : ctx.moveTo(...corners[i]); ctx.closePath();
      try { ctx.clip(); } catch (error) { dynamicConcaveRejected = /convex|retained ClipPath/.test(error.message); }
      const convex160 = [];
      for (let i=0;i<160;i++){const a=i/160*Math.PI*2;convex160.push(80+30*Math.cos(a),65+30*Math.sin(a));}
      ctx.save();ctx.beginPath(); for(let i=0;i<160;i++) i?ctx.lineTo(convex160[i*2],convex160[i*2+1]):ctx.moveTo(convex160[0],convex160[1]);ctx.closePath();ctx.clip();
      const dynamicClip = vector.stencilClips.at(-1);
      const authoredConvexCount = dynamicClip.triangles.length / 6 + 2;
      ctx.restore();
      ctx.endFrame();
      checkpoint('dynamic contour limits checked');

      let clipPointLimitRejected = false;
      try { ctx.createClipPath(new Float32Array(257 * 2)); } catch (error) { clipPointLimitRejected = /256 authored points/.test(error.message); }
      const colorOnlyTarget = device.createRenderTarget(16,16,{stencil:false}); let missingStencilRejected = false;
      ctx.beginFrame({width:160,height:130,clearColor:[0,0,1,1]}); device.bindRenderTarget(colorOnlyTarget);
      try { ctx.clipPath(clip160); } catch (error) { missingStencilRejected = /active stencil attachment/.test(error.message); }
      device.unbindRenderTarget(); ctx.endFrame(); device.deleteRenderTarget(colorOnlyTarget);

      ctx.beginFrame({ width:160, height:130, clearColor:[0,0,1,1] }); ctx.save(); ctx.clipPath(clip160); ctx.endFrame();

      const loss = device.gl.getExtension('WEBGL_lose_context'); let restored = false, restorePixel = null, restoreNotch = null;
      if (loss) {
        const eventWithin = (type, trigger) => new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${type}`)), 20000);
          canvas.addEventListener(type, () => { clearTimeout(timer); resolve(true); }, { once:true });
          trigger();
        });
        await eventWithin('webglcontextlost', () => loss.loseContext()); restored = ctx.beginFrame() === false;
        await new Promise(resolve => setTimeout(resolve, 100));
        await eventWithin('webglcontextrestored', () => loss.restoreContext());
        await new Promise(resolve => setTimeout(resolve, 80));
        ctx.beginFrame({ width:160,height:130,clearColor:[0,0,1,1] });ctx.drawMesh(mesh);ctx.restore();ctx.endFrame();restorePixel=pixel(85,60);
        restoreNotch = pixel(40,60);
        checkpoint('context restored and retained mesh rendered');
      }
      const glError=device.gl.getError();
      ctx.deleteMesh(mesh); ctx.deleteClipPath(inner); ctx.deleteClipPath(clip160);
      ctx.dispose(); for(const sample of gradientCanvases){sample.ctx.dispose();sample.vector.dispose();sample.device.dispose();sample.canvas.remove();}
      vector.dispose();device.dispose();canvas.remove();
      const disposed = device.stats.bufferCount===0&&device.stats.pipelineCount===0&&device.stats.textureCount===0&&device.stats.renderTargetCount===0&&device.stats.gpuBufferBytes===0&&device.stats.gpuRenderTargetBytes===0;
      return { gradientSamples, radialComparisons, clipPixels, gradientStopLimitRejected, clipPointLimitRejected, missingStencilRejected, selfIntersectionRejected, dynamicConcaveRejected, savedClipDeletionRejected, authoredConvexCount, restored, restorePixel, restoreNotch, glError, disposed };
    }, { moduleURL });

    for (const [name, sample] of Object.entries(result.gradientSamples)) {
      assert.equal(sample.cssSize, name === 'mobile' ? 47 : 74);
      assert.ok(sample.stops[0][0] > sample.stops[0][1] && sample.stops[0][3] === 255, `${name}: gradient start ${sample.stops[0]}`);
      assert.ok(Math.abs(sample.stops[1][0]) <= 10 && Math.abs(sample.stops[1][1] - 128) <= 12 && Math.abs(sample.stops[1][2] - 128) <= 12, `${name}: gradient middle ${sample.stops[1]}`);
      assert.ok(sample.stops[2][2] > sample.stops[2][0] && sample.stops[2][3] === 255, `${name}: gradient end ${sample.stops[2]}`);
      assert.ok(Math.abs(sample.alphaMid[0] - 64) <= 12 && Math.abs(sample.alphaMid[2] - 64) <= 12 && Math.abs(sample.alphaMid[3] - 128) <= 12, `${name}: premultiplied alpha stop ${sample.alphaMid}`);
      assert.ok(sample.strokeMid[3] > 0, `${name}: gradient stroke has covered pixels`);
      assert.ok(sample.transformedCoverage[3] > 0, `${name}: transformed fill has covered pixels`);
      assert.equal(sample.error, 0);
    }
    for(const [name,sample] of Object.entries(result.radialComparisons)){
      assert.equal(sample.size,name==='radial-mobile'?47:74);
      assert.ok(sample.compared>1000,`${name}: compare actual rendered pixels against native Canvas2D`);
      assert.ok(sample.maxDiff<=10&&sample.meanDiff<=2.5,`${name}: two-circle gradient pixel parity ${JSON.stringify(sample)}`);
      assert.equal(sample.notchOrBackgroundMismatch,0,`${name}: transparent area outside the radial cone leaves prior paint intact`);
      assert.deepEqual(sample.identicalCirclePixel,[0,255,0,255],`${name}: identical circles paint nothing per the Canvas radial-gradient algorithm`);
      assert.equal(sample.glError,0);
    }
    assert.ok(result.clipPixels.innerAndGroup[0] > 100 && result.clipPixels.innerAndGroup[1] > 240, `nested clip + group ${result.clipPixels.innerAndGroup}`);
    assert.ok(result.clipPixels.rightArm[0] > 100 && result.clipPixels.rightArm[1] > 100, `retained mesh/clip and group ${result.clipPixels.rightArm}`);
    assert.deepEqual(result.clipPixels.openNotch, [0,0,255,255]);
    assert.deepEqual(result.clipPixels.outside, [0,0,255,255]);
    assert.equal(result.clipPixels.error, 0);
    assert.equal(result.selfIntersectionRejected, true);
    assert.equal(result.dynamicConcaveRejected, true);
    assert.equal(result.savedClipDeletionRejected, true);
    assert.equal(result.gradientStopLimitRejected, true);
    assert.equal(result.clipPointLimitRejected, true);
    assert.equal(result.missingStencilRejected, true);
    assert.equal(result.authoredConvexCount, 160, 'dynamic convex clip preserves all 160 authored points');
    if (result.restored) {
      assert.ok(result.restorePixel[0] > 240 && result.restorePixel[1] < 8, `restored retained-mesh clip ${result.restorePixel}`);
      assert.deepEqual(result.restoreNotch, [0,0,255,255], `restored concave clip keeps the notch clear ${result.restoreNotch}`);
    }
    assert.equal(result.glError, 0);
    assert.equal(result.disposed, true);
    assert.equal(pageErrors.length, 0, pageErrors.join('\n'));
    await page.screenshot({ path: screenshotPath, fullPage: true });
    return result;
  } finally { await page.close(); }
}

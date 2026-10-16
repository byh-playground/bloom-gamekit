import assert from 'node:assert/strict';

export async function exerciseAlphaRunBatching(browser, moduleURL, screenshotPath) {
  const page = await browser.newPage({ viewport: { width: 720, height: 380 }, deviceScaleFactor: 1 });
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  try {
    await page.setContent(`<!doctype html><meta charset="utf-8"><style>
      *{box-sizing:border-box}body{margin:0;padding:18px;background:#eef2ee;color:#233c35;font:14px/1.4 system-ui,sans-serif}
      h1{font-size:18px;margin:0 0 10px}.grid{display:grid;grid-template-columns:repeat(2,1fr);gap:14px}.card{padding:10px;background:white;border:1px solid #cdd8ce;border-radius:8px}
      canvas{display:block;width:256px;height:256px;image-rendering:pixelated;background:#131923}small{display:block;margin:4px 0 0}
    </style><h1>Safe mixed-alpha instance batching</h1><div class="grid">
      <div class="card"><canvas id="overlapReference"></canvas><small>Overlapping units · painter-order reference</small></div>
      <div class="card"><canvas id="overlapCandidate"></canvas><small>Overlapping units · same order retained</small></div>
      <div class="card"><canvas id="disjointReference"></canvas><small>Disjoint units · painter-order reference</small></div>
      <div class="card"><canvas id="disjointCandidate"></canvas><small>Disjoint units · two run draws shared safely</small></div>
    </div>`);
    const result = await page.evaluate(async ({ moduleURL }) => {
      const { WebGLDevice, MeshRenderer } = await import(moduleURL);
      const canvasMap = Object.fromEntries(['overlapReference','overlapCandidate','nonAdjacentReference','nonAdjacentCandidate','disjointReference','disjointCandidate'].map(id => {
        const canvas=document.getElementById(id)??document.createElement('canvas');
        if(!canvas.id){canvas.id=id;canvas.style.display='none';document.body.appendChild(canvas);}
        return [id,canvas];
      }));
      const output = {};
      const geometry = new Float32Array(9 * 11);
      const colors = [[1,0.15,0.05,1],[0.1,0.25,1,1],[1,0.85,0.05,0.5]];
      const points = [[8,8],[28,8],[18,28]];
      for (let triangle=0;triangle<3;triangle++) for (let corner=0;corner<3;corner++) {
        const at=(triangle*3+corner)*11; geometry.set([points[corner][0],points[corner][1],...colors[triangle],0,0,0,0,0],at);
      }
      for (const [id, canvas] of Object.entries(canvasMap)) {
        canvas.width=canvas.height=64;
        const device=new WebGLDevice(canvas,{alpha:false,antialias:false,depth:true,stencil:true,preserveDrawingBuffer:true,checkGLErrors:true});
        const meshes=new MeshRenderer(device,{maxInstances:8,safeAlphaRunBatching:id.endsWith('Reference')?false:true});
        const mesh=meshes.createMesh({vertices:geometry,strideFloats:11,partCount:1,morphCount:0});
        const overlap=id.startsWith('overlap'), nonAdjacent=id.startsWith('nonAdjacent');
        const matrices=nonAdjacent?[[1,0,0,1,0,0],[1,0,0,1,35,0],[1,0,0,1,0,0]]:overlap?[[1,0,0,1,0,0],[1,0,0,1,0,0]]:[[1,0,0,1,0,0],[1,0,0,1,32,0]];
        const colorsByUnit=[[1,1,1,1],[0.5,0.8,1,1],[0.7,1,0.5,1]];
        device.beginFrame({width:64,height:64,clearColor:[0.04,0.06,0.09,1],clearDepth:1}); meshes.beginFrame();
        for(let i=0;i<matrices.length;i++) meshes.drawMesh(mesh,{matrix:matrices[i],projection:[2/64,0,0,0,-2/64,0,-1,1,1],color:colorsByUnit[i],depthTest:true,depthWrite:true,depthWriteAlphaThreshold:0.999});
        meshes.flush('frameEnd'); device.gl.finish();
        const pixels=new Uint8Array(64*64*4); device.gl.readPixels(0,0,64,64,device.gl.RGBA,device.gl.UNSIGNED_BYTE,pixels);
        output[id]={pixels:[...pixels],draws:meshes.stats().draws,deviceDrawCalls:device.stats.drawCalls,instancedDrawCalls:device.stats.instancedDrawCalls,
          instances:meshes.stats().instances,safeBatches:meshes.stats().alphaRunSafeBatches,batchedInstances:meshes.stats().alphaRunBatchedInstances,
          drawsSaved:meshes.stats().alphaRunDrawsSaved,overlapBoundaries:meshes.stats().alphaRunOverlapBoundaries,flushReasons:meshes.stats().flushReasons,drawDispatchReasons:meshes.stats().drawDispatchReasons,
          glError:device.gl.getError(),instanced:meshes.stats().instanced};
        device.endFrame(); meshes.dispose(); device.dispose();
      }
      const pixelAt=(pixels,x,y)=>{const at=((63-y)*64+x)*4;return pixels.slice(at,at+4);};
      const mismatch=(a,b)=>a.reduce((sum,value,i)=>sum+Number(value!==b[i]),0);
      return {
        overlap:{referencePixel:pixelAt(output.overlapReference.pixels,18,12),candidatePixel:pixelAt(output.overlapCandidate.pixels,18,12),pixelMismatch:mismatch(output.overlapReference.pixels,output.overlapCandidate.pixels),referenceDraws:output.overlapReference.draws,candidateDraws:output.overlapCandidate.draws,overlapBoundaries:output.overlapCandidate.overlapBoundaries,flushReasons:output.overlapCandidate.flushReasons,drawDispatchReasons:output.overlapCandidate.drawDispatchReasons},
        nonAdjacent:{pixelMismatch:mismatch(output.nonAdjacentReference.pixels,output.nonAdjacentCandidate.pixels),referenceDraws:output.nonAdjacentReference.draws,candidateDraws:output.nonAdjacentCandidate.draws,overlapBoundaries:output.nonAdjacentCandidate.overlapBoundaries,flushReasons:output.nonAdjacentCandidate.flushReasons,drawDispatchReasons:output.nonAdjacentCandidate.drawDispatchReasons},
        disjoint:{referenceDraws:output.disjointReference.draws,candidateDraws:output.disjointCandidate.draws,deviceDrawCalls:output.disjointCandidate.deviceDrawCalls,
          safeBatches:output.disjointCandidate.safeBatches,batchedInstances:output.disjointCandidate.batchedInstances,drawsSaved:output.disjointCandidate.drawsSaved,
          pixelMismatch:mismatch(output.disjointReference.pixels,output.disjointCandidate.pixels),leftPixel:pixelAt(output.disjointCandidate.pixels,18,12),rightPixel:pixelAt(output.disjointCandidate.pixels,50,12),flushReasons:output.disjointCandidate.flushReasons,drawDispatchReasons:output.disjointCandidate.drawDispatchReasons},
        allGLClean:Object.values(output).every(sample=>sample.glError===0),instanced:Object.values(output).every(sample=>sample.instanced),output,
      };
    }, { moduleURL });
    assert.equal(result.overlap.pixelMismatch,0,`overlap pixels differ: ${JSON.stringify(result.overlap)}`);
    assert.equal(result.overlap.referenceDraws,4);
    assert.equal(result.overlap.candidateDraws,4,'overlapping mixed-alpha units keep their original per-unit run order');
    assert.ok(result.overlap.overlapBoundaries>=1,'overlap is reported as a safe batch boundary');
    assert.equal(result.overlap.flushReasons.alphaOverlap,1,'overlap is a reported batch boundary reason');
    assert.equal(Object.values(result.overlap.drawDispatchReasons).reduce((sum,count)=>sum+count,0),result.overlap.candidateDraws,'dispatch reasons classify every actual device.draw call');
    assert.equal(result.nonAdjacent.pixelMismatch,0,'every queued bound is checked, including earlier non-adjacent units');
    assert.equal(result.nonAdjacent.referenceDraws,6);
    assert.equal(result.nonAdjacent.candidateDraws,4,'first disjoint pair may batch, but the later unit overlapping the first must start a new ordered group');
    assert.equal(result.nonAdjacent.overlapBoundaries,1);
    assert.equal(result.nonAdjacent.flushReasons.alphaOverlap,1);
    assert.equal(Object.values(result.nonAdjacent.drawDispatchReasons).reduce((sum,count)=>sum+count,0),result.nonAdjacent.candidateDraws);
    assert.equal(result.disjoint.pixelMismatch,0,`disjoint pixels differ: ${JSON.stringify(result.disjoint)}`);
    assert.equal(result.disjoint.referenceDraws,4);
    if(result.instanced){
      assert.equal(result.disjoint.candidateDraws,2,'two authored alpha runs batch across two proven-disjoint instances');
      assert.equal(result.disjoint.deviceDrawCalls,2);
      assert.equal(result.disjoint.safeBatches,1);
      assert.equal(result.disjoint.batchedInstances,2);
      assert.equal(result.disjoint.drawsSaved,2);
      assert.equal(Object.values(result.disjoint.drawDispatchReasons).reduce((sum,count)=>sum+count,0),result.disjoint.candidateDraws);
      assert.equal(result.disjoint.flushReasons.frameEnd,1);
    }else{
      assert.equal(result.disjoint.candidateDraws,result.disjoint.referenceDraws,'non-instanced devices keep ordered fallback');
    }
    assert.equal(result.allGLClean,true);
    assert.equal(pageErrors.length,0,pageErrors.join('\n'));
    await page.screenshot({path:screenshotPath,fullPage:true});
    delete result.output;
    return result;
  } finally { await page.close(); }
}

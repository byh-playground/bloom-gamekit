# SVG raster and sprite comparison

This is a module example, not a game migration or a whole-game FPS claim. The three paths use the same Seed Scout geometry, clock, camera and independent actor phases: retained vector mesh with GPU pose, part atlas with the same GPU pose, and coarsely sampled whole-frame sprite animation. The explicit `transform-repeat` fixture adds a repeat clip using the original bounce transforms; it does not change the original once clip. Whole-frame sprites select held images at 100ms intervals, so their geometry is intentionally time-quantized.

## Reproduction and evidence

Run `npm run build`, `npm run build:previews`, then `node modules/vector-assets/tests/benchmark-raster-comparison.mjs --loop-only`. Set `CHROMIUM_EXECUTABLE_PATH` to the full hardware Chromium executable when the default headless shell uses a software renderer. The benchmark rejects SwiftShader. Each path receives 30 warmup frames and 60 measured frames, in forward and reverse path order. The fixed render surface is 1100×360 at DPR 1, with 500 actors, 256px raster resolution and 100ms sampling. Raw CPU snapshots and asynchronous GPU query samples are written to `test-results/raster-comparison-benchmark-loop.json`, with source and bundle hashes. Disjoint query results are discarded. CPU time is the example render interval, excluding DOM metric writes; GPU time covers pose preparation and draw submission, excluding initial atlas preparation.

The local hardware is Chromium 153.0.8010.12, ANGLE D3D11, NVIDIA GeForce GTX 1660 Ti. Physical mobile hardware has not been tested. Touch emulation only checks the example controls and layout.

## Shared-quad change

Before the sprite submission fix (`1e484bae61478a1c14b6695cc6efcd201036771c`), changing frame index ranges broke compatible batches into 183–184 draws. CPU p50 was 5.6/5.5ms and GPU p50 was 4.496/4.264ms in the forward/reverse runs. Those adverse samples remain preserved; this was a submission structure problem, not evidence that texture sampling is intrinsically slower.

At `d7ffed43dac4d9daee3968e731dff772ec4dc21c`, before the later full-manifest prewarm change, shared quad plus per-instance UV/local rectangles produced the following results. Each cell gives forward/reverse runs separately, not a pooled average.

| Path                        | CPU p50 ms | CPU p95 ms | GPU p50 ms    | GPU p95 ms    | Draws |
| --------------------------- | ---------- | ---------- | ------------- | ------------- | ----- |
| Pure vector                 | 3.5 / 4.0  | 3.8 / 5.6  | 0.143 / 1.142 | 0.166 / 1.161 | 2     |
| Vector + part texture       | 4.7 / 5.2  | 6.5 / 6.5  | 0.478 / 0.794 | 0.488 / 0.816 | 2     |
| Texture, whole-frame sprite | 2.6 / 2.8  | 5.1 / 3.6  | 0.226 / 0.226 | 0.231 / 0.231 | 1     |

All three actual backends rendered 500 actors with zero fallback in that representative repeat case. The vector GPU time changed substantially with run order; the cause was not established, so this does not establish a universal GPU ranking. Part textures did not improve CPU cost for this small 346-triangle visible expression. The whole-frame sprite saved pose work and submission time while introducing temporal quantization and fixed-resolution sampling.

Per-frame instance buffer bytes were 34,000 / 50,000 / 48,000. Numeric pose texture uploads were 16,032 / 16,032 / 0 bytes. Image storage for the active part atlas was 235,736 bytes, and the active five-frame sprite atlas was 688,880 bytes. These are not the memory cost of prewarming every selectable clip and expression.

An independent single-path logical GPU allocation probe recorded 770,720 / 1,007,996 / 828,140 bytes respectively (buffer plus texture storage, excluding default framebuffer and driver overhead). Render-target color bytes are already included in texture bytes and must not be added twice. This probe used the same shared-quad bundle hashes, before the full-manifest cache change. Resource counts and allocated bytes returned to zero after disposal.

Initial bake cost must be reported separately from warmed playback. Earlier cold 128px initialization measured 16.7ms caller time for the part atlas and 248.7ms for the sprite path, including first-use shader/module work. A later warmed 256px five-frame bake was much cheaper; it must not replace the cold-start number. Setup wall time including `gl.finish()` is CPU plus GPU completion time, not GPU timer time.

## Correctness and limits

The browser fixtures compare black, white and checker backgrounds at 0.5×, 1× and 4×; expression visibility, excluded parts, alpha ordering, UV direction, linear filtering, gutters, clipping/stencil, large-atlas highp coordinates, trim/pivot, differently sized and rotated frames, uniform fallback, context restoration and disposal. Different sprite frames in a compatible painter-order run must submit in one draw without sorting actors. The textured instance layout uses 96 bytes; existing untextured instances retain 64 bytes.

Part atlases explicitly fall back for unsupported morphs, time-dependent shader surfaces, non-scaling strokes, partial paint-run expression selection and alpha contracts that would change compositing. Sampled sprite baking reports unsupported absolute-time sketch morph behavior rather than presenting a matching first frame as a complete implementation. Inter-image crossfade is not implemented. The combined nonidentity local rectangle, GPU pose and 3D clip configuration has no dedicated validation; this example validates its 2D use.

The integrated disposal regression initially exposed a shared VAO retaining another MeshRenderer's instance attributes when that instance buffer was deleted. The minimal device fix binds the owned VAO while deleting an array buffer, then restores the previous VAO. The reproducing integrated fixture passes with the fix; no GPU-driver defect is claimed.

# Test suite selection

`npm test` and `npm run test:browser` keep the 100/400 actor draw, unique-pose, retained-geometry, and rollback correctness checks, but omit their CPU/GPU timing fields and the path tessellation timing sample. Those diagnostics remain available through `npm run benchmark:vector-assets-population`; this command is opt-in and is not part of correctness verification.

Safe alpha-run batching is covered independently by `npm run test:rendering:alpha-run-batching`. It compares reference and candidate pixels for overlapping and disjoint runs, checks the draw-dispatch reduction for disjoint instances, and verifies a clean WebGL state. The core alpha-depth test continues to check per-instance painter order and opacity using readPixels cases.

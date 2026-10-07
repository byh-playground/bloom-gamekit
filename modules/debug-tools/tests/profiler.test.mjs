import assert from 'node:assert/strict';
import test from 'node:test';
import {PerformanceProfiler} from '../index.js';

test('PerformanceProfiler is opt-in and does not read its clock while disabled', () => {
  let reads = 0;
  const profiler = new PerformanceProfiler({now: () => { reads++; return reads; }});
  assert.equal(profiler.measure('disabled', () => 7), 7);
  assert.equal(reads, 0);
  assert.deepEqual(profiler.snapshot(), { enabled: false, capacity: 120, retainedFrames: 0, frames: [], summary: { frames: { count: 0, totalMs: 0, minMs: 0, maxMs: 0, p50Ms: 0, p95Ms: 0 }, stages: {} } });
});

test('PerformanceProfiler records bounded frame stages, counts and primitive metadata', () => {
  let clock = 0;
  const profiler = new PerformanceProfiler({capacity: 2, now: () => clock});
  profiler.setEnabled(true);
  assert.equal(profiler.beginFrame({frame: 4, tick: 12, mode: 'online'}), true);
  clock = 3; profiler.stage('simulation.advance', 2, {ticks: 1}); profiler.count('texture.upload', 2);
  clock = 8; assert.equal(profiler.measure('render.flush', () => { clock = 11; return 'done'; }, {bytes: 4096}), 'done');
  clock = 14; const frame = profiler.endFrame({backend: 'webgl'});
  assert.equal(frame.durationMs, 14); assert.equal(frame.stages['simulation.advance'].ms, 2); assert.equal(frame.stages['render.flush'].ms, 3); assert.equal(frame.stages['render.flush'].metadata.bytes, 4096); assert.equal(frame.counts['texture.upload'], 2);
  const report = profiler.snapshot();
  assert.equal(report.retainedFrames, 1); assert.equal(report.summary.frames.p50Ms, 14); assert.equal(report.summary.stages['render.flush'].maxMs, 3);
});

test('PerformanceProfiler keeps only the configured number of frames and records thrown operations', () => {
  let clock = 0;
  const profiler = new PerformanceProfiler({capacity: 2, now: () => clock}); profiler.setEnabled(true);
  for (let frame = 0; frame < 3; frame++) {
    profiler.beginFrame({frame}); clock += 1;
    assert.throws(() => profiler.measure('render', () => { clock += 2; throw new Error('expected'); }), /expected/);
    profiler.endFrame();
  }
  assert.equal(profiler.snapshot().retainedFrames, 2); assert.deepEqual(profiler.snapshot({limit: 1}).frames.map(row => row.meta.frame), [2]);
});

test('PerformanceProfiler rejects unbounded or non-primitive diagnostic data', () => {
  const profiler = new PerformanceProfiler(); profiler.setEnabled(true); profiler.beginFrame();
  assert.throws(() => profiler.stage('stage', -1), /non-negative/);
  assert.throws(() => profiler.count('count', Infinity), /finite/);
  assert.throws(() => profiler.stage('stage', 1, {object: {secret: true}}), /primitive/);
  profiler.endFrame();
});

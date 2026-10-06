import assert from 'node:assert/strict';
import test from 'node:test';
import { WebGLDevice } from '../dist/rendering.js';

// Constructor boundary only: intentionally unavailable context, not a fake GPU pass.
function request(options) {
  const calls = [];
  const canvas = { addEventListener() {}, getContext(kind, attributes) { calls.push({ kind, attributes }); return null; } };
  assert.throws(() => new WebGLDevice(canvas, options), /WebGL 1 required/);
  assert.equal(calls.length, 1);
  return calls[0];
}
test('WebGLDevice preserves defaults and forwards each standard GPU preference without coercion', () => {
  const original = { alpha: false, antialias: true, depth: true, stencil: true, premultipliedAlpha: true, preserveDrawingBuffer: false };
  assert.deepEqual(request(), { kind: 'webgl', attributes: { ...original, powerPreference: 'default', failIfMajorPerformanceCaveat: false } });
  for (const powerPreference of ['default', 'low-power', 'high-performance']) {
    for (const failIfMajorPerformanceCaveat of [false, true]) {
      assert.deepEqual(request({ powerPreference, failIfMajorPerformanceCaveat }), {
        kind: 'webgl', attributes: { ...original, powerPreference, failIfMajorPerformanceCaveat },
      });
    }
  }
});
test('invalid GPU preferences are rejected before context creation or listeners', () => {
  let touched = false;
  const canvas = { addEventListener() { touched = true; }, getContext() { touched = true; } };
  for (const powerPreference of ['', 'fast', null, 1, {}, true]) assert.throws(() => new WebGLDevice(canvas, { powerPreference }), TypeError);
  for (const failIfMajorPerformanceCaveat of [null, 0, 1, 'false', {}]) assert.throws(() => new WebGLDevice(canvas, { failIfMajorPerformanceCaveat }), TypeError);
  assert.equal(touched, false);
});

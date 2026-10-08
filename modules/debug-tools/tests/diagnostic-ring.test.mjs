import assert from 'node:assert/strict';
import test from 'node:test';
import { DiagnosticRing } from '../index.js';

test('DiagnosticRing keeps legacy reports visible as blockers and preserves fatal reports', () => {
  let now = 0;
  const ring = new DiagnosticRing({ now: () => now++ });

  const blocking = ring.report('stalled');
  const fatal = ring.report('cannot recover', { kind: 'renderer', fatal: true });
  const snapshot = ring.snapshot();

  assert.equal(blocking.visibility, 'blocking');
  assert.equal(blocking.fatal, false);
  assert.equal(fatal.visibility, 'fatal');
  assert.equal(fatal.fatal, true);
  assert.equal(snapshot.format, 'bloom-gamekit diagnostics v2');
  assert.deepEqual(snapshot.counts, { total: 2, retained: 2, log: 0, notice: 0, blocking: 1, fatal: 1 });
  assert.equal(snapshot.blockerCount, 2);
  assert.equal(snapshot.errors[0].kind, 'exception');
});

test('DiagnosticRing records all visibility classes while counting only blockers and fatal state', () => {
  const ring = new DiagnosticRing({ now: () => 1 });
  ring.report('trace details', { kind: 'trace', visibility: 'log' });
  ring.report('save recovered', { kind: 'save.load', visibility: 'notice' });
  ring.report('input unavailable', { kind: 'input', visibility: 'blocking' });
  ring.report('sdk stopped', { kind: 'sdk', visibility: 'fatal' });

  const snapshot = ring.snapshot();
  assert.deepEqual(snapshot.counts, { total: 4, retained: 4, log: 1, notice: 1, blocking: 1, fatal: 1 });
  assert.equal(snapshot.blockerCount, 2);
  assert.deepEqual(snapshot.errors.map(({ visibility, fatal }) => [visibility, fatal]), [
    ['log', false], ['notice', false], ['blocking', false], ['fatal', true],
  ]);
  assert.deepEqual(JSON.parse(ring.format()), snapshot);
});

test('DiagnosticRing deduplicates within one visibility and keeps differently classified reports separate', () => {
  const ring = new DiagnosticRing({ now: () => 2 });
  ring.report('same message', { visibility: 'notice' });
  ring.report('same message');
  ring.report('same message', { visibility: 'blocking' });

  const snapshot = ring.snapshot();
  assert.equal(snapshot.total, 3);
  assert.equal(snapshot.errors.length, 2);
  assert.deepEqual(snapshot.errors.map(({ visibility, count }) => [visibility, count]), [['notice', 1], ['blocking', 2]]);
  assert.deepEqual(snapshot.counts, { total: 3, retained: 3, log: 0, notice: 1, blocking: 2, fatal: 0 });
  assert.equal(snapshot.blockerCount, 2);
});

test('DiagnosticRing counts retained classifications after capacity evicts old records', () => {
  const ring = new DiagnosticRing({ capacity: 2, now: () => 0 });
  ring.report('recovered', { visibility: 'notice' });
  ring.report('blocked', { visibility: 'blocking' });
  ring.report('fatal', { fatal: true });

  const snapshot = ring.snapshot();
  assert.equal(snapshot.total, 3);
  assert.equal(snapshot.dropped, 1);
  assert.deepEqual(snapshot.counts, { total: 3, retained: 2, log: 0, notice: 0, blocking: 1, fatal: 1 });
  assert.equal(snapshot.blockerCount, 2);
});

test('DiagnosticRing rejects unknown visibility without changing its counts', () => {
  const ring = new DiagnosticRing({ now: () => 0 });
  assert.throws(() => ring.report('bad classification', { visibility: 'warning' }), /visibility/);
  assert.equal(ring.snapshot().total, 0);
  const legacyFatal = ring.report('fatal takes precedence', { visibility: 'notice', fatal: true });
  assert.equal(legacyFatal.visibility, 'fatal');
  assert.equal(legacyFatal.fatal, true);
});

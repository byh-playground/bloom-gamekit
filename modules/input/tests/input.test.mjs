import test from 'node:test';
import assert from 'node:assert/strict';
import { ActionState, createDOMInput, pointerPositionInto } from '../../../dist/input.js';

const empty = { held: false, pressed: false, released: false };

test('pure ActionState loads without DOM, unknown action and repeated sample do not consume', () => {
  const state = new ActionState();
  const out = {};
  assert.equal(state.sampleInto('left', out), out);
  assert.deepEqual(out, empty);
  state.set('left', 'key:KeyA', true);
  for (let frame = 0; frame < 6; frame++) {
    state.sampleInto('left', out);
    assert.deepEqual(out, { held: true, pressed: true, released: false });
  }
  state.consume();
  assert.deepEqual(state.sample('left'), { held: true, pressed: false, released: false });
});

test('60 Hz rendering preserves a complete short click for the next 10 Hz simulation tick', () => {
  const state = new ActionState();
  state.set('fire', 'mouse', true);
  state.set('fire', 'mouse', false);
  for (let frame = 0; frame < 6; frame++) {
    assert.deepEqual(state.sample('fire'), { held: false, pressed: true, released: true });
  }
  state.consume();
  assert.deepEqual(state.sample('fire'), empty);
});

test('multiple sources OR held state; only final source release creates an edge', () => {
  const state = new ActionState();
  state.set('up', 'W', true); state.set('up', 'ArrowUp', true);
  state.consume();
  state.set('up', 'W', false);
  assert.deepEqual(state.sample('up'), { held: true, pressed: false, released: false });
  state.set('up', 'ArrowUp', true);
  state.set('up', 'ArrowUp', false);
  assert.deepEqual(state.sample('up'), { held: false, pressed: false, released: true });
});

test('one source can own multiple actions, releaseSource does not touch other sources', () => {
  const state = new ActionState();
  const shared = Symbol('shared');
  state.set('left', shared, true); state.set('jump', shared, true);
  state.set('jump', 'second', true); state.consume();
  state.releaseSource(shared);
  assert.deepEqual(state.sample('left'), { held: false, pressed: false, released: true });
  assert.deepEqual(state.sample('jump'), { held: true, pressed: false, released: false });
  state.releaseAll();
  assert.deepEqual(state.sample('jump'), { held: false, pressed: false, released: true });
});

test('release-repress between ticks and a pulse retain both edges without losing hold', () => {
  const state = new ActionState();
  state.set('roll', 'Space', true); state.consume();
  state.set('roll', 'Space', false); state.set('roll', 'Space', true);
  assert.deepEqual(state.sample('roll'), { held: true, pressed: true, released: true });
  state.consume(); state.pulse('roll');
  assert.deepEqual(state.sample('roll'), { held: true, pressed: true, released: true });
  state.consume();
  assert.deepEqual(state.sample('roll'), { held: true, pressed: false, released: false });
});

test('invalid action/source/down inputs throw without changing prior action state', () => {
  const state = new ActionState();
  state.set('a', 'source', true);
  assert.throws(() => state.set('', 'source', true), TypeError);
  assert.throws(() => state.set('a', 1, true), TypeError);
  assert.throws(() => state.set('a', 'source', 1), TypeError);
  assert.throws(() => state.sampleInto('a', null), TypeError);
  assert.deepEqual(state.sample('a'), { held: true, pressed: true, released: false });
});

// 아래 fake DOM은 listener 소유권/정리와 이벤트 순서를 검사합니다.
// 실제 PointerEvent capture·브라우저 전파·물리 터치 기기 검증을 대신하지 않습니다.
class Hub {
  listeners = new Map();
  addEventListener(type, callback, options) {
    let list = this.listeners.get(type);
    if (!list) this.listeners.set(type, list = []);
    list.push({ callback, options });
  }
  removeEventListener(type, callback, options) {
    const list = this.listeners.get(type) ?? [];
    this.listeners.set(type, list.filter(item => item.callback !== callback || item.options !== options));
  }
  emit(type, event = {}) {
    for (const { callback } of [...(this.listeners.get(type) ?? [])]) callback(event);
  }
  get listenerCount() { return [...this.listeners.values()].reduce((sum, value) => sum + value.length, 0); }
}
function fixture(options = {}) {
  const win = new Hub();
  const doc = new Hub(); doc.defaultView = win; doc.hidden = false;
  const target = new Hub(); target.ownerDocument = doc;
  target.style = { touchAction: 'pan-y' };
  target.rect = { left: 100, top: 50, width: 400, height: 200 };
  target.getBoundingClientRect = () => target.rect;
  target.matches = () => false;
  target.contains = node => node === target || node?.parent === target;
  target.closest = () => null;
  const captured = new Set();
  target.setPointerCapture = id => captured.add(id);
  target.hasPointerCapture = id => captured.has(id);
  target.releasePointerCapture = id => { captured.delete(id); target.emit('lostpointercapture', { pointerId: id }); };
  const state = options.state ?? new ActionState();
  const gestures = [];
  const input = createDOMInput({ target, state, keys: { KeyW: 'up', ArrowUp: 'up', Space: 'roll' }, pointerButtons: { 0: 'point' }, onGesture: event => gestures.push(event), ...options });
  function event(values = {}) {
    const result = { target, cancelable: true, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...values };
    result.composedPath = () => [result.target, ...(result.target === target ? [] : [result.target?.parent].filter(Boolean)), doc, win];
    return result;
  }
  function pointer(type, values = {}) {
    const e = event({ pointerId: 1, pointerType: 'mouse', button: 0, buttons: type === 'pointerup' || type === 'pointercancel' ? 0 : 1, clientX: 200, clientY: 100, timeStamp: 10, ...values });
    doc.emit(type, e);
    if (type === 'pointerdown' || type === 'lostpointercapture') target.emit(type, e);
    return e;
  }
  function key(type, code, values = {}) {
    const e = event({ code, repeat: false, ...values });
    if (type === 'keyup') doc.emit(type, e);
    else (options.keyboardTarget ?? doc).emit(type, e);
    return e;
  }
  const ui = { closest: () => ui };
  return { input, target, doc, win, state, pointer, key, ui, gestures, captured };
}

test('DOM keyboard multi-source and repeat avoid early release or new edges', () => {
  const f = fixture();
  assert.equal(f.key('keydown', 'KeyW').defaultPrevented, true);
  f.key('keydown', 'ArrowUp'); f.state.consume();
  f.key('keydown', 'KeyW', { repeat: true }); f.key('keyup', 'KeyW');
  assert.deepEqual(f.state.sample('up'), { held: true, pressed: false, released: false });
  f.key('keyup', 'ArrowUp');
  assert.deepEqual(f.state.sample('up'), { held: false, pressed: false, released: true });
  f.input.dispose();
});

test('UI starts and unbound keys are untouched; keyup in UI still releases owned key', () => {
  const f = fixture();
  assert.equal(f.key('keydown', 'KeyW', { target: f.ui }).defaultPrevented, false);
  assert.deepEqual(f.state.sample('up'), empty);
  assert.equal(f.key('keydown', 'KeyQ').defaultPrevented, false);
  f.key('keydown', 'KeyW'); f.state.consume();
  assert.equal(f.key('keyup', 'KeyW', { target: f.ui }).defaultPrevented, false);
  assert.equal(f.state.sample('up').released, true);
  assert.equal(f.pointer('pointerdown', { target: f.ui }).defaultPrevented, false);
  assert.equal(f.state.sample('point').held, false);
  f.input.dispose();
});

test('UI exclusion predicate and preventDefault false remain caller-controlled', () => {
  const f = fixture({ excludeTarget: (node, event) => event.blockGame === true, preventDefault: false });
  f.key('keydown', 'KeyW', { blockGame: true });
  assert.equal(f.state.sample('up').held, false);
  assert.equal(f.key('keydown', 'KeyW').defaultPrevented, false);
  assert.equal(f.state.sample('up').held, true);
  assert.equal(f.pointer('pointerdown').defaultPrevented, false);
  f.input.dispose();
});

test('CSS rect mapping is independent of drawing buffer/DPR, unclamped and rejects zero rect', () => {
  const f = fixture();
  f.target.width = 1600; f.target.height = 800;
  const out = {};
  assert.equal(pointerPositionInto({ clientX: 200, clientY: 100 }, f.target, out), true);
  assert.deepEqual(out, { x: 100, y: 50, u: 0.25, v: 0.25 });
  pointerPositionInto({ clientX: 50, clientY: 300 }, f.target, out);
  assert.deepEqual(out, { x: -50, y: 250, u: -0.125, v: 1.25 });
  f.target.rect.width = 0;
  assert.equal(pointerPositionInto({ clientX: 0, clientY: 0 }, f.target, out), false);
  assert.deepEqual(out, { x: -50, y: 250, u: -0.125, v: 1.25 });
  f.input.dispose();
});

test('pointer identity and independent touch sources preserve aggregate hold', () => {
  const f = fixture();
  f.pointer('pointerdown', { pointerId: 7, pointerType: 'touch' });
  f.pointer('pointerdown', { pointerId: 8, pointerType: 'touch', clientX: 300 });
  assert.deepEqual([...f.captured], [7, 8]);
  f.state.consume();
  f.pointer('pointerup', { pointerId: 999 });
  f.pointer('pointerup', { pointerId: 7, pointerType: 'touch' });
  assert.deepEqual(f.state.sample('point'), { held: true, pressed: false, released: false });
  const out = {};
  assert.equal(f.input.samplePointerInto(8, out), true);
  assert.equal(out.x, 200); assert.equal(out.active, true);
  assert.equal(f.input.samplePointerInto(7, out), false);
  f.pointer('pointerup', { pointerId: 8, pointerType: 'touch' });
  assert.equal(f.state.sample('point').released, true);
  assert.equal(f.captured.size, 0);
  f.input.dispose();
});

test('pointer capture failure still releases from document up outside target', () => {
  const f = fixture();
  f.target.setPointerCapture = () => { throw new Error('detached target'); };
  f.pointer('pointerdown'); f.state.consume();
  f.pointer('pointerup', { target: f.doc, clientX: 900 });
  assert.deepEqual(f.state.sample('point'), { held: false, pressed: false, released: true });
  assert.equal(f.input.sampleLatestPointerInto({}), true);
  f.input.dispose();
});

test('chorded mouse buttons synchronize from buttons mask without an early release', () => {
  const f = fixture({ pointerButtons: { 0: 'fire', 2: 'fire' } });
  f.pointer('pointerdown'); f.state.consume();
  f.pointer('pointermove', { button: 2, buttons: 3 });
  f.pointer('pointermove', { button: 0, buttons: 2 });
  assert.deepEqual(f.state.sample('fire'), { held: true, pressed: false, released: false });
  f.pointer('pointerup', { button: 2 });
  assert.deepEqual(f.state.sample('fire'), { held: false, pressed: false, released: true });
  f.input.dispose();
});

test('pointercancel and unexpected lostcapture release held actions without gesture', () => {
  for (const end of ['pointercancel', 'lostpointercapture']) {
    const f = fixture({ gestures: { tap: 'move', doubleTap: 'roll' } });
    f.pointer('pointerdown'); f.state.consume(); f.pointer(end);
    assert.deepEqual(f.state.sample('point'), { held: false, pressed: false, released: true });
    assert.equal(f.state.sample('move').pressed, false);
    assert.equal(f.gestures.length, 0);
    f.input.dispose();
  }
});

test('blur/hidden release only adapter sources, reset gesture/positions, and ignore orphan repeat', () => {
  for (const lifecycle of ['blur', 'hidden']) {
    const f = fixture({ gestures: { tap: 'move', doubleTap: 'roll' } });
    f.state.set('up', 'external', true);
    f.key('keydown', 'KeyW'); f.key('keydown', 'Space'); f.pointer('pointerdown'); f.state.consume();
    if (lifecycle === 'blur') f.win.emit('blur');
    else { f.doc.hidden = true; f.doc.emit('visibilitychange'); f.doc.hidden = false; }
    assert.equal(f.state.sample('up').held, true);
    assert.deepEqual(f.state.sample('roll'), { held: false, pressed: false, released: true });
    assert.deepEqual(f.state.sample('point'), { held: false, pressed: false, released: true });
    assert.equal(f.input.sampleLatestPointerInto({}), false);
    f.key('keydown', 'Space', { repeat: true });
    assert.equal(f.state.sample('roll').held, false);
    f.pointer('pointerup'); assert.equal(f.gestures.length, 0);
    f.input.dispose();
  }
});

test('tap then doubleTap maps actions once and keeps completed tap through normal capture loss', () => {
  const f = fixture({ gestures: { tap: 'move', doubleTap: 'roll', doubleTapMs: 300, doubleTapSlop: 20 } });
  f.pointer('pointerdown', { timeStamp: 0 });
  f.pointer('pointerup', { timeStamp: 80 });
  assert.deepEqual(f.state.sample('move'), { held: false, pressed: true, released: true });
  assert.equal(f.gestures[0].x, 100); assert.equal(f.gestures[0].u, 0.25);
  f.state.consume();
  f.pointer('lostpointercapture', { timeStamp: 81 });
  f.pointer('pointerdown', { timeStamp: 150, clientX: 208 });
  f.pointer('pointerup', { timeStamp: 200, clientX: 208 });
  assert.equal(f.state.sample('roll').pressed, true);
  assert.equal(f.state.sample('move').pressed, false);
  assert.deepEqual(f.gestures.map(value => value.type), ['tap', 'doubleTap']);
  f.input.dispose();
});

test('drag remains canceled after returning to start and cannot seed a double tap', () => {
  const f = fixture({ gestures: { tap: 'move', doubleTap: 'roll', dragSlop: 12 } });
  f.pointer('pointerdown', { timeStamp: 0 });
  f.pointer('pointermove', { timeStamp: 20, clientX: 220 });
  f.pointer('pointermove', { timeStamp: 30, clientX: 200 });
  f.pointer('pointerup', { timeStamp: 40 });
  assert.equal(f.gestures.length, 0);
  f.pointer('pointerdown', { timeStamp: 60 }); f.pointer('pointerup', { timeStamp: 80 });
  assert.deepEqual(f.gestures.map(value => value.type), ['tap']);
  f.input.dispose();
});

test('long press, release outside, backward time and multi-pointer interaction are not taps', () => {
  const f = fixture({ gestures: { tap: 'move', doubleTap: 'roll', tapMs: 100 } });
  f.pointer('pointerdown', { timeStamp: 0 }); f.pointer('pointerup', { timeStamp: 101 });
  f.pointer('pointerdown', { timeStamp: 200, clientX: 499 }); f.pointer('pointerup', { timeStamp: 210, clientX: 501 });
  f.pointer('pointerdown', { timeStamp: 300 }); f.pointer('pointerup', { timeStamp: 299 });
  f.pointer('pointerdown', { pointerId: 1, pointerType: 'touch', timeStamp: 400 });
  f.pointer('pointerdown', { pointerId: 2, pointerType: 'touch', timeStamp: 410 });
  f.pointer('pointerup', { pointerId: 1, pointerType: 'touch', timeStamp: 420 });
  f.pointer('pointerup', { pointerId: 2, pointerType: 'touch', timeStamp: 430 });
  assert.equal(f.gestures.length, 0);
  assert.equal(f.state.sample('move').pressed, false);
  f.input.dispose();
});

test('double tap requires matching device, configured time/distance and no intervening UI action', () => {
  const f = fixture({ gestures: { tap: 'move', doubleTap: 'roll', doubleTapMs: 100, doubleTapSlop: 5 } });
  const tap = (time, extra = {}) => {
    f.pointer('pointerdown', { timeStamp: time, ...extra });
    f.pointer('pointerup', { timeStamp: time + 10, ...extra });
  };
  tap(0); tap(150); // 시간 초과
  tap(170, { clientX: 210 }); // 거리 초과
  tap(190, { clientX: 210, pointerType: 'touch' }); // 장치 유형 차이
  f.pointer('pointerdown', { target: f.ui, pointerId: 9, timeStamp: 210 });
  tap(220, { clientX: 210, pointerType: 'touch' });
  assert.equal(f.gestures.every(value => value.type === 'tap'), true);
  assert.equal(f.state.sample('roll').pressed, false);
  f.input.dispose();
});

test('dispose is idempotent, removes listeners/capture and restores only its own style change', () => {
  const f = fixture({ touchAction: 'none' });
  assert.equal(f.target.style.touchAction, 'none');
  f.key('keydown', 'KeyW'); f.pointer('pointerdown'); f.state.consume();
  f.input.dispose(); f.input.dispose();
  assert.equal(f.input.disposed, true);
  assert.equal(f.target.listenerCount + f.doc.listenerCount + f.win.listenerCount, 0);
  assert.equal(f.captured.size, 0);
  assert.equal(f.target.style.touchAction, 'pan-y');
  assert.deepEqual(f.state.sample('up'), { held: false, pressed: false, released: true });
  assert.equal(f.input.sampleLatestPointerInto({}), false);
  f.state.consume(); f.key('keydown', 'KeyW'); f.pointer('pointerdown');
  assert.deepEqual(f.state.sample('up'), empty);
  const another = fixture({ touchAction: 'none' });
  another.target.style.touchAction = 'manipulation'; another.input.dispose();
  assert.equal(another.target.style.touchAction, 'manipulation');
});

test('two adapters share one state safely and disposal preserves the other adapter', () => {
  const state = new ActionState();
  const a = fixture({ state }), b = fixture({ state });
  a.key('keydown', 'KeyW'); b.key('keydown', 'KeyW'); state.consume();
  a.input.dispose();
  assert.deepEqual(state.sample('up'), { held: true, pressed: false, released: false });
  b.input.dispose();
  assert.deepEqual(state.sample('up'), { held: false, pressed: false, released: true });
});

test('invalid binding/gesture options fail before installing listeners or modifying styles', () => {
  const f = fixture(); f.input.dispose();
  for (const invalid of [
    { keys: { KeyW: '' } }, { pointerButtons: { 7: 'bad' } },
    { gestures: {} }, { gestures: { tap: 'move', dragSlop: -1 } },
    { gestures: { tap: 'move', tapMs: Infinity } }, { onGesture: true },
  ]) {
    assert.throws(() => createDOMInput({ target: f.target, touchAction: 'none', ...invalid }));
    assert.equal(f.target.listenerCount + f.doc.listenerCount + f.win.listenerCount, 0);
    assert.equal(f.target.style.touchAction, 'pan-y');
  }
});


test('scoped keyboard down still releases when keyup moves outside keyboardTarget', () => {
  const keyboardTarget = new Hub();
  const f = fixture({ keyboardTarget });
  f.key('keydown', 'KeyW'); f.state.consume();
  f.key('keyup', 'KeyW', { target: f.ui });
  assert.deepEqual(f.state.sample('up'), { held: false, pressed: false, released: true });
  f.input.dispose();
  assert.equal(keyboardTarget.listenerCount, 0);
});

test('pagehide releases state before a page enters the back-forward cache', () => {
  const f = fixture();
  f.key('keydown', 'KeyW'); f.pointer('pointerdown'); f.state.consume();
  f.win.emit('pagehide');
  assert.deepEqual(f.state.sample('up'), { held: false, pressed: false, released: true });
  assert.deepEqual(f.state.sample('point'), { held: false, pressed: false, released: true });
  f.input.dispose();
});

test('owned pointer callbacks retain raw event and normalized coordinates through document fallback',()=>{
  const events=[],f=fixture({onPointer:e=>events.push(e)});f.target.setPointerCapture=()=>{throw Error('unavailable')};
  const raw=f.pointer('pointerdown');f.pointer('pointermove',{target:f.doc,clientX:540});f.pointer('pointerup',{target:f.doc,clientX:540});
  assert.deepEqual(events.map(e=>e.type),['down','move','up']);assert.equal(events[0].originalEvent,raw);assert.equal(events[1].u,1.1);assert.equal(events[2].active,false);assert.equal(f.state.sample('point').held,false);
  f.input.dispose();
});
test('blur cancels all owned pointers once after releasing captures and preserves UI isolation',()=>{
  const events=[],releases=[],f=fixture({onPointer:e=>events.push(e),onRelease:e=>releases.push(e)});
  f.pointer('pointerdown',{pointerId:1});f.pointer('pointerdown',{pointerId:2});f.pointer('pointerdown',{pointerId:3,target:f.ui});
  f.win.emit('blur',{type:'blur'});assert.deepEqual(events.map(e=>[e.type,e.pointerId]),[['down',1],['down',2],['cancel',1],['cancel',2]]);
  assert.equal(f.captured.size,0);assert.equal(f.state.sample('point').held,false);assert.equal(releases[0].reason,'blur');f.input.dispose();
});
test('release callbacks cannot prevent remaining pointer ownership cleanup',()=>{
  const f=fixture({onPointer:e=>{if(e.type==='cancel')throw Error('consumer failure')}});
  f.pointer('pointerdown',{pointerId:1});f.pointer('pointerdown',{pointerId:2});assert.throws(()=>f.input.dispose(),AggregateError);
  assert.equal(f.captured.size,0);assert.equal(f.state.sample('point').held,false);assert.equal(f.target.listenerCount,0);assert.equal(f.input.disposed,true);
});

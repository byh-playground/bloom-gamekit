import assert from 'node:assert/strict';
import test from 'node:test';
import { RenderObject, PresentationRuntime, snapshotRenderModel } from '../index.js';

// 게임 경로나 권위 상태 이름에 의존하지 않는 공개 정책 계약 검사입니다.
const close = (actual, expected) => assert.ok(
  Number.isFinite(actual) && Math.abs(actual - expected) < 1e-9,
  `${actual} != ${expected}`,
);
const runtime = options => new PresentationRuntime({ stepMs: 100, ...options });
const entity = (source, options = {}) => ({ id: 'a', generation: 0, source, ...options });
const packet = (sequence, entities, options = {}) => ({
  revision: 0, sequence, timeMs: sequence * 100, entities, ...options,
});
const capture = (view, sequence, source, nowMs, entityOptions = {}, packetOptions = {}) =>
  view.capture(packet(sequence, [entity(source, entityOptions)], packetOptions), nowMs);
const sample = (view, nowMs, generation = 0) => view.sample('a', generation, nowMs);
function typeWith(schema) {
  return class Generic extends RenderObject {
    static renderSchema = schema;
    render(context, model) { context.push(model); }
  };
}
const sourceOf = (Type, values) => Object.assign(new Type(), values);

test('공개 필드 정책은 기존 상수를 보존한 숫자 enum이다', () => {
  const names = [
    'LINEAR', 'ANGLE', 'STEP', 'DECAY', 'CYCLE', 'COUNTDOWN_MS',
    'COUNTDOWN_SECONDS', 'STATE_KEY', 'POSITION_X', 'POSITION_Y',
    'POSITION_Z', 'ORIGIN_X', 'ORIGIN_Y', 'ORIGIN_Z', 'SPAWN_LINEAR',
  ];
  assert.deepEqual(names.map(name => RenderObject[name]), names.map((_, index) => index));
  const Generic = typeWith({ 'nodes.a.b.value': RenderObject.COUNTDOWN_MS });
  assert.equal(Generic.COUNTDOWN_MS, 5);
  assert.equal(Generic.SPAWN_LINEAR, 14);
});

for (const [name, policy, first, second, third] of [
  ['ms', 5, 1000, 900, 750],
  ['seconds', 6, 1, 0.9, 0.75],
]) {
  test(`COUNTDOWN_${name}은 simulation delta로 정상 감소를 판단하고 수신 곡선을 잇는다`, () => {
    const Generic = typeWith({
      x: RenderObject.LINEAR,
      'nodes.a.b.value': policy,
      'nodes.a.b.other': RenderObject.LINEAR,
    });
    const make = (x, value, other) => sourceOf(Generic, { x, nodes: { a: { b: { value, other } } } });
    const view = runtime();
    capture(view, 0, make(0, first, 0), 0);
    // receipt 간격 25ms와 simulation 간격 100ms를 의도적으로 다르게 둡니다.
    capture(view, 1, make(10, second, 10), 25);
    close(sample(view, 75).nodes.a.b.value, (first + second) / 2);
    capture(view, 2, make(20, third, 20), 75, {}, { timeMs: 250 });
    close(sample(view, 75).nodes.a.b.value, (first + second) / 2);
    close(sample(view, 75).nodes.a.b.other, 5);
    close(sample(view, 125).nodes.a.b.value, ((first + second) / 2 + third) / 2);
    close(sample(view, 125).nodes.a.b.other, 12.5);
    close(sample(view, 125).x, 12.5);
  });

  for (const [label, restart] of [['증가', first * 2], ['감소량 불일치', second / 2], ['정지', second]]) {
    test(`COUNTDOWN_${name} ${label}는 부모 범위만 새 구간으로 맞춘다`, () => {
      const Generic = typeWith({
        x: RenderObject.LINEAR,
        'nodes.a.b.value': policy,
        'nodes.a.b.other': RenderObject.LINEAR,
        'nodes.a.b.inner.value': RenderObject.LINEAR,
        'nodes.a.bb.value': RenderObject.LINEAR,
        'nodes.a.c.value': RenderObject.LINEAR,
      });
      const make = (value, n) => sourceOf(Generic, {
        x: n, nodes: { a: { b: { value, other: n, inner: { value: n } }, bb: { value: n }, c: { value: n } } },
      });
      const view = runtime();
      capture(view, 0, make(first, 0), 0);
      capture(view, 1, make(second, 10), 100);
      capture(view, 2, make(restart, 20), 150);
      const model = sample(view, 150);
      assert.equal(model.nodes.a.b.value, restart);
      assert.equal(model.nodes.a.b.other, 20);
      assert.equal(model.nodes.a.b.inner.value, 20);
      close(model.x, 5);
      close(model.nodes.a.bb.value, 5);
      close(model.nodes.a.c.value, 5);
      close(sample(view, 200).x, 12.5);
    });
  }

  test(`COUNTDOWN_${name}의 0 도달은 정상 감소이며 이웃 필드를 reset하지 않는다`, () => {
    const Generic = typeWith({ 'nodes.a.value': policy, 'nodes.a.other': RenderObject.LINEAR });
    const make = (value, other) => sourceOf(Generic, { nodes: { a: { value, other } } });
    const view = runtime();
    capture(view, 0, make(first / 20, 0), 0);
    capture(view, 1, make(0, 10), 100);
    close(sample(view, 150).nodes.a.value, first / 40);
    close(sample(view, 150).nodes.a.other, 5);
    capture(view, 2, make(0, 20), 150);
    close(sample(view, 150).nodes.a.other, 5);
    close(sample(view, 200).nodes.a.other, 12.5);
  });
}

test('STATE_KEY 변경은 같은 부모 범위만 맞추며 기존 API로 render한다', () => {
  const Generic = typeWith({
    x: RenderObject.LINEAR,
    'nodes.a.b.key': RenderObject.STATE_KEY,
    'nodes.a.b.value': RenderObject.LINEAR,
    'nodes.a.b.inner.value': RenderObject.LINEAR,
    'nodes.a.bb.value': RenderObject.LINEAR,
    'nodes.a.c.value': RenderObject.LINEAR,
  });
  const make = (key, n) => sourceOf(Generic, {
    x: n, nodes: { a: { b: { key, value: n, inner: { value: n } }, bb: { value: n }, c: { value: n } } },
  });
  const first = make('a', 0), second = make('a', 10), third = make('b', 20);
  const view = runtime();
  capture(view, 0, first, 0);
  capture(view, 1, second, 100);
  close(sample(view, 125).nodes.a.b.value, 2.5);
  capture(view, 2, third, 150);
  const model = sample(view, 150);
  assert.equal(model.nodes.a.b.key, 'b');
  assert.equal(model.nodes.a.b.value, 20);
  assert.equal(model.nodes.a.b.inner.value, 20);
  close(model.x, 5);
  close(model.nodes.a.bb.value, 5);
  close(model.nodes.a.c.value, 5);
  assert.equal(view.modelFor(third, 150), model);
  const context = [];
  view.render(third, context, 150);
  assert.deepEqual(context, [model]);
  assert.equal(view.size, 1);
});

test('STATE_KEY primitive 교체는 STEP과 부모 reset을 적용한다', () => {
  for (const [before, after] of [['a', 'b'], [0, 1], [false, true], [1, '1'], ['a', null], [null, 'a']]) {
    const Generic = typeWith({ 'nodes.a.key': RenderObject.STATE_KEY, 'nodes.a.value': RenderObject.LINEAR });
    const view = runtime();
    capture(view, 0, sourceOf(Generic, { nodes: { a: { key: before, value: 0 } } }), 0);
    capture(view, 1, sourceOf(Generic, { nodes: { a: { key: after, value: 10 } } }), 100);
    assert.deepEqual(sample(view, 100), { nodes: { a: { key: after, value: 10 } } });
  }
});

for (const policy of [5, 6, 7]) {
  test(`정책 ${policy}의 null/없는 부모와 재등장은 기존 snap 계약을 따른다`, () => {
    const Generic = typeWith({ 'nodes.a.b.value': policy, 'nodes.a.b.other': RenderObject.LINEAR });
    const view = runtime();
    const present = sourceOf(Generic, { nodes: { a: { b: { value: policy === 7 ? 'a' : 1, other: 10 } } } });
    capture(view, 0, present, 0);
    capture(view, 1, sourceOf(Generic, { nodes: { a: { b: null } } }), 100);
    assert.deepEqual(sample(view, 100), { nodes: { a: { b: null } } });
    capture(view, 2, present, 150);
    assert.equal(sample(view, 150).nodes.a.b.other, 10);
    capture(view, 3, sourceOf(Generic, { nodes: { a: {} } }), 200);
    assert.equal(Object.hasOwn(sample(view, 200).nodes.a, 'b'), false);
    capture(view, 4, present, 250);
    assert.equal(sample(view, 250).nodes.a.b.other, 10);
  });
}

test('같은 STATE_KEY는 primitive 종류와 값 이름에 관계없이 이웃 곡선을 잇는다', () => {
  for (const key of ['임의값', '', 0, false, null]) {
    const Generic = typeWith({ 'nodes.a.b.key': RenderObject.STATE_KEY, 'nodes.a.b.value': RenderObject.LINEAR });
    const make = value => sourceOf(Generic, { nodes: { a: { b: { key, value } } } });
    const view = runtime();
    capture(view, 0, make(0), 0);
    capture(view, 1, make(10), 100);
    capture(view, 2, make(20), 150);
    close(sample(view, 150).nodes.a.b.value, 5);
    close(sample(view, 200).nodes.a.b.value, 12.5);
  }
});

for (const [name, policy] of [['countdown', 5], ['key', 7]]) {
  test(`${name}의 fixed-array 부모 reset은 슬롯 1과 슬롯 10을 구분한다`, () => {
    const Generic = typeWith({
      x: RenderObject.LINEAR,
      'nodes.1.b.value': policy, 'nodes.1.b.other': RenderObject.LINEAR,
      'nodes.1.bb.other': RenderObject.LINEAR, 'nodes.10.b.other': RenderObject.LINEAR,
    });
    const make = (value, n) => {
      const nodes = new Array(11);
      nodes[1] = { b: { value, other: n }, bb: { other: n } };
      nodes[10] = { b: { other: n } };
      return sourceOf(Generic, { x: n, nodes });
    };
    const view = runtime();
    capture(view, 0, make(policy === 7 ? 'a' : 1000, 0), 0);
    capture(view, 1, make(policy === 7 ? 'a' : 900, 10), 100);
    capture(view, 2, make(policy === 7 ? 'b' : 2000, 20), 150);
    const model = sample(view, 150);
    assert.ok(Array.isArray(model.nodes));
    assert.equal(model.nodes.length, 11);
    assert.equal(0 in model.nodes, false);
    assert.equal(model.nodes[1].b.other, 20);
    close(model.nodes[1].bb.other, 5);
    close(model.nodes[10].b.other, 5);
    close(model.x, 5);
  });
}

const roleSchema = () => ({
  'nodes.a.b.u': RenderObject.POSITION_X,
  'nodes.a.b.v': RenderObject.POSITION_Y,
  'nodes.a.b.w': RenderObject.POSITION_Z,
  'nodes.c.d.u': RenderObject.ORIGIN_X,
  'nodes.c.d.v': RenderObject.ORIGIN_Y,
  'nodes.c.d.w': RenderObject.ORIGIN_Z,
  'nodes.e.f.value': RenderObject.SPAWN_LINEAR,
  'nodes.g.value': RenderObject.LINEAR,
});
function roleSource(Type, position, origin = [0, 0, 0], value = 1, other = 0) {
  const [u, v, w] = position, [ou, ov, ow] = origin;
  return sourceOf(Type, { nodes: {
    a: { b: { u, v, w } }, c: { d: { u: ou, v: ov, w: ow } },
    e: { f: { value } }, g: { value: other },
  } });
}

test('축 역할과 SPAWN_LINEAR는 기존 곡선에서 LINEAR로 이어진다', () => {
  const Generic = typeWith(roleSchema()), view = runtime();
  capture(view, 0, roleSource(Generic, [0, 0, 0], [0, 0, 0], 0, 0), 0);
  capture(view, 1, roleSource(Generic, [10, 20, 30], [40, 50, 60], 1, 10), 100);
  const model = sample(view, 150);
  assert.deepEqual(model.nodes.a.b, { u: 5, v: 10, w: 15 });
  assert.deepEqual(model.nodes.c.d, { u: 20, v: 25, w: 30 });
  close(model.nodes.e.f.value, 0.5);
  capture(view, 2, roleSource(Generic, [20, 40, 60], [80, 100, 120], 0, 20), 150);
  close(sample(view, 150).nodes.e.f.value, 0.5);
  const later = sample(view, 200);
  assert.deepEqual(later.nodes.a.b, { u: 12.5, v: 25, w: 37.5 });
  assert.deepEqual(later.nodes.c.d, { u: 50, v: 62.5, w: 75 });
  close(later.nodes.e.f.value, 0.25);
});

test('새 identity는 임의 경로의 ORIGIN에서 같은 축 POSITION과 SPAWN_LINEAR 0을 seed한다', () => {
  const Generic = typeWith(roleSchema()), view = runtime();
  const source = roleSource(Generic, [30, 50, 70], [10, 20, 30], 0.8, 7);
  for (const key of ['x', 'y', 'z', 'startX', 'startY', 'startZ', 'origin', 'position']) {
    Object.defineProperty(source, key, { get() { throw new Error(`미등록 필드를 읽음: ${key}`); } });
  }
  capture(view, 0, source, 0);
  assert.deepEqual(sample(view, 0).nodes.a.b, { u: 10, v: 20, w: 30 });
  close(sample(view, 0).nodes.e.f.value, 0);
  const midpoint = sample(view, 50);
  assert.deepEqual(midpoint.nodes.a.b, { u: 20, v: 35, w: 50 });
  assert.deepEqual(midpoint.nodes.c.d, { u: 10, v: 20, w: 30 });
  close(midpoint.nodes.e.f.value, 0.4);
  close(midpoint.nodes.g.value, 7);
  assert.deepEqual(sample(view, 100).nodes.a.b, { u: 30, v: 50, w: 70 });
  assert.equal(Object.hasOwn(midpoint, 'x'), false);
});

test('같은 generation의 수신은 변경된 ORIGIN과 SPAWN_LINEAR 0으로 다시 seed하지 않는다', () => {
  const Generic = typeWith(roleSchema()), view = runtime();
  capture(view, 0, roleSource(Generic, [20, 40, 60], [0, 0, 0], 1), 0);
  capture(view, 1, roleSource(Generic, [40, 80, 120], [100, 200, 300], 1), 50);
  assert.deepEqual(sample(view, 50).nodes.a.b, { u: 10, v: 20, w: 30 });
  close(sample(view, 50).nodes.e.f.value, 0.5);
  const midpoint = sample(view, 100);
  assert.deepEqual(midpoint.nodes.a.b, { u: 25, v: 50, w: 75 });
  close(midpoint.nodes.e.f.value, 0.75);
});

test('generation 교체와 삭제 뒤 새 identity는 자동 seed를 적용하고 이전 모델을 폐기한다', () => {
  const Generic = typeWith(roleSchema()), view = runtime();
  capture(view, 0, roleSource(Generic, [20, 40, 60], [0, 0, 0]), 0);
  const old = sample(view, 100);
  capture(view, 1, roleSource(Generic, [40, 60, 80], [10, 20, 30]), 150, { generation: 1 });
  assert.equal(sample(view, 150, 0), null);
  assert.equal(view.isModel(old), false);
  assert.deepEqual(sample(view, 150, 1).nodes.a.b, { u: 10, v: 20, w: 30 });
  view.capture(packet(2, []), 200);
  assert.equal(sample(view, 200, 1), null);
  capture(view, 3, roleSource(Generic, [60, 80, 100], [30, 40, 50]), 250, { generation: 2 });
  assert.deepEqual(sample(view, 250, 2).nodes.a.b, { u: 30, v: 40, w: 50 });
  close(sample(view, 250, 2).nodes.e.f.value, 0);
});

test('대응 ORIGIN이 없는 POSITION과 nullable 축은 자동 0으로 대체하지 않는다', () => {
  const Generic = typeWith({
    'nodes.a.u': RenderObject.POSITION_X, 'nodes.a.v': RenderObject.POSITION_Y,
    'nodes.a.w': RenderObject.POSITION_Z, 'nodes.b.u': RenderObject.ORIGIN_X,
  });
  for (const origin of [null, undefined]) {
    const view = runtime();
    const source = sourceOf(Generic, { nodes: { a: { u: 20, v: 30, w: null }, b: { u: origin } } });
    capture(view, 0, source, 0);
    assert.deepEqual(sample(view, 0).nodes.a, { u: 20, v: 30, w: null });
  }
});

test('명시적 initialSource 전체 표본이 ORIGIN 및 SPAWN_LINEAR 자동 seed보다 우선한다', () => {
  const Generic = typeWith(roleSchema()), view = runtime();
  const source = roleSource(Generic, [30, 50, 70], [10, 20, 30], 1, 10);
  const initialSource = roleSource(Generic, [3, 5, 7], [-10, -20, -30], 0.6, 2);
  capture(view, 0, source, 0, { initialSource });
  assert.deepEqual(sample(view, 0).nodes.a.b, { u: 3, v: 5, w: 7 });
  assert.deepEqual(sample(view, 0).nodes.c.d, { u: -10, v: -20, w: -30 });
  close(sample(view, 0).nodes.e.f.value, 0.6);
  close(sample(view, 50).nodes.e.f.value, 0.8);
  initialSource.nodes.a.b.u = 999;
  source.nodes.a.b.u = 999;
  close(sample(view, 75).nodes.a.b.u, 23.25);
});

test('기존 identity의 initialSource는 검증하되 진행 중 곡선을 바꾸지 않는다', () => {
  const Generic = typeWith(roleSchema()), view = runtime();
  capture(view, 0, roleSource(Generic, [20, 40, 60], [0, 0, 0], 1), 0);
  capture(view, 1, roleSource(Generic, [40, 80, 120], [100, 200, 300], 1), 50, {
    initialSource: roleSource(Generic, [999, 999, 999], [999, 999, 999], 0.1),
  });
  assert.deepEqual(sample(view, 50).nodes.a.b, { u: 10, v: 20, w: 30 });
  close(sample(view, 50).nodes.e.f.value, 0.5);
});

for (const mode of ['teleport', 'reset', 'load', 'rollback']) {
  test(`${mode}은 명시적 및 자동 seed보다 우선해 전체 목표로 snap한다`, () => {
    const Generic = typeWith(roleSchema()), view = runtime();
    capture(view, 0, roleSource(Generic, [0, 0, 0], [0, 0, 0], 0), 0);
    const source = roleSource(Generic, [30, 50, 70], [10, 20, 30], 1, 10);
    const entityOptions = { initialSource: roleSource(Generic, [-1, -2, -3], [-4, -5, -6], 0.6) };
    const packetOptions = mode === 'teleport' ? {} : { revision: 1, mode, timeMs: -100 };
    if (mode === 'teleport') entityOptions.teleport = true;
    capture(view, mode === 'teleport' ? 1 : 0, source, 50, entityOptions, packetOptions);
    assert.deepEqual(sample(view, 50), snapshotRenderModel(Generic, source));
    assert.deepEqual(sample(view, 100), snapshotRenderModel(Generic, source));
    // 초기 packet에도 강제 불연속이 자동 seed를 억제합니다.
    const fresh = runtime();
    capture(fresh, 0, source, 0, entityOptions, mode === 'teleport' ? {} : { mode });
    assert.deepEqual(sample(fresh, 0), snapshotRenderModel(Generic, source));
  });
}

test('명시적 resetFields는 자동/명시적 seed 중 선택된 필드만 목표로 맞춘다', () => {
  const Generic = typeWith(roleSchema());
  for (const initialSource of [undefined, roleSource(Generic, [3, 5, 7], [0, 0, 0], 0.6)]) {
    const view = runtime();
    capture(view, 0, roleSource(Generic, [30, 50, 70], [10, 20, 30], 1), 0, {
      initialSource, resetFields: ['nodes.a.b.u', 'nodes.e.f.value'],
    });
    const model = sample(view, 0);
    assert.equal(model.nodes.a.b.u, 30);
    assert.equal(model.nodes.a.b.v, initialSource ? 5 : 20);
    assert.equal(model.nodes.e.f.value, 1);
  }
});

test('snapDistance는 역할 축의 Euclidean 거리로 root entity 전체를 snap한다', () => {
  const Generic = typeWith({
    'nodes.a.u': RenderObject.POSITION_X, 'nodes.a.v': RenderObject.POSITION_Y,
    'nodes.a.w': RenderObject.POSITION_Z, 'nodes.b.value': RenderObject.LINEAR,
  });
  const make = (u, v, w, value) => sourceOf(Generic, { nodes: { a: { u, v, w }, b: { value } } });
  const view = runtime({ snapDistance: 160 });
  capture(view, 0, make(0, 0, 0, 0), 0);
  // 각 축은 160보다 작지만 3D 거리 sqrt(3 * 100²)는 160을 넘습니다.
  capture(view, 1, make(100, 100, 100, 10), 100);
  assert.deepEqual(sample(view, 100), { nodes: { a: { u: 100, v: 100, w: 100 }, b: { value: 10 } } });
  capture(view, 2, make(110, 120, 130, 20), 150);
  close(sample(view, 150).nodes.b.value, 10);
  close(sample(view, 200).nodes.b.value, 15);
});

test('snapDistance를 생략하면 먼 역할 위치도 기존 LINEAR로 연결한다', () => {
  const Generic = typeWith({ 'nodes.a.u': RenderObject.POSITION_X, 'nodes.b.value': RenderObject.LINEAR });
  const view = runtime();
  capture(view, 0, sourceOf(Generic, { nodes: { a: { u: 0 }, b: { value: 0 } } }), 0);
  capture(view, 1, sourceOf(Generic, { nodes: { a: { u: 1000 }, b: { value: 10 } } }), 100);
  close(sample(view, 100).nodes.a.u, 0);
  close(sample(view, 150).nodes.a.u, 500);
  close(sample(view, 150).nodes.b.value, 5);
});

test('snapDistance는 미등록 축과 대응 값이 없는 축을 무시한다', () => {
  const Generic = typeWith({
    'nodes.a.u': RenderObject.POSITION_X, 'nodes.a.v': RenderObject.POSITION_Y,
    'nodes.a.w': RenderObject.POSITION_Z, 'nodes.b.value': RenderObject.LINEAR,
  });
  const view = runtime({ snapDistance: 160 });
  const first = sourceOf(Generic, { nodes: { a: { u: 0, v: null }, b: { value: 0 } }, x: 0, y: 0 });
  const second = sourceOf(Generic, { nodes: { a: { u: 10, v: 1000 }, b: { value: 10 } }, x: 10000, y: 10000 });
  capture(view, 0, first, 0);
  capture(view, 1, second, 100);
  close(sample(view, 100).nodes.a.u, 0);
  assert.equal(sample(view, 100).nodes.a.v, 1000);
  assert.equal(Object.hasOwn(sample(view, 100).nodes.a, 'w'), false);
  close(sample(view, 150).nodes.b.value, 5);
});

test('역할 선언 없이 snapDistance를 설정해도 보통 LINEAR 위치를 추측하지 않는다', () => {
  const Generic = typeWith({ x: RenderObject.LINEAR, y: RenderObject.LINEAR });
  const view = runtime({ snapDistance: 160 });
  capture(view, 0, sourceOf(Generic, { x: 0, y: 0 }), 0);
  capture(view, 1, sourceOf(Generic, { x: 1000, y: 1000 }), 100);
  assert.deepEqual(sample(view, 150), { x: 500, y: 500 });
});

for (const policy of [5, 7]) {
  test(`중첩 정책 ${policy}의 reset은 entity root XYZ 역할을 포함하지 않는다`, () => {
    const Generic = typeWith({
      x: RenderObject.POSITION_X, y: RenderObject.POSITION_Y, z: RenderObject.POSITION_Z,
      'nodes.a.b.value': policy, 'nodes.a.b.other': RenderObject.LINEAR,
    });
    const make = (value, n) => sourceOf(Generic, { x: n, y: n * 2, z: n * 3, nodes: { a: { b: { value, other: n } } } });
    const view = runtime({ snapDistance: 160 });
    capture(view, 0, make(policy === 7 ? 'a' : 1000, 0), 0);
    capture(view, 1, make(policy === 7 ? 'a' : 900, 10), 100);
    capture(view, 2, make(policy === 7 ? 'b' : 2000, 20), 150);
    const model = sample(view, 150);
    assert.equal(model.nodes.a.b.other, 20);
    close(model.x, 5); close(model.y, 10); close(model.z, 15);
    const later = sample(view, 200);
    close(later.x, 12.5); close(later.y, 25); close(later.z, 37.5);
  });
}

for (const [name, policy] of [['COUNTDOWN_MS', 5], ['COUNTDOWN_SECONDS', 6]]) {
  test(`${name}의 nonnegative finite 검증은 target/initialSource/projection에 적용한다`, () => {
    for (const value of [-1, -Number.EPSILON, NaN, Infinity, -Infinity, '1', {}, []]) {
      const Generic = typeWith({ 'nodes.a.b.value': policy, x: RenderObject.LINEAR });
      const make = (value, x = 0) => sourceOf(Generic, { x, nodes: { a: { b: { value } } } });
      const source = make(1000), view = runtime();
      capture(view, 0, source, 0);
      const model = sample(view, 0);
      assert.throws(() => capture(view, 1, make(value, 10), 100));
      assert.throws(() => capture(view, 1, make(900, 10), 100, { teleport: true, initialSource: make(value) }));
      assert.throws(() => snapshotRenderModel(Generic, make(value)));
      assert.equal(view.size, 1);
      assert.equal(view.modelFor(source, 1), model);
      assert.equal(model.nodes.a.b.value, 1000);
      assert.equal(capture(view, 1, make(900, 10), 50), true);
      close(sample(view, 100).x, 5);
    }
  });
}

test('STATE_KEY는 finite primitive를 허용하고 DTO/함수/symbol/bigint를 거부한다', () => {
  for (const value of [{}, [], NaN, Infinity, -Infinity, Symbol('a'), 1n, () => 1]) {
    const Generic = typeWith({ 'nodes.a.b.key': RenderObject.STATE_KEY });
    const make = key => sourceOf(Generic, { nodes: { a: { b: { key } } } });
    const source = make('a'), view = runtime();
    capture(view, 0, source, 0);
    const model = sample(view, 0);
    assert.throws(() => capture(view, 1, make(value), 100));
    assert.throws(() => capture(view, 1, make('b'), 100, { initialSource: make(value), teleport: true }));
    assert.throws(() => snapshotRenderModel(Generic, make(value)));
    assert.equal(view.modelFor(source, 1), model);
    assert.equal(model.nodes.a.b.key, 'a');
    assert.equal(capture(view, 1, make('b'), 50), true);
  }
});

test('POSITION/ORIGIN의 같은 축 중복은 타입 validation error이며 capture를 반영하지 않는다', () => {
  for (const policy of [8, 9, 10, 11, 12, 13]) {
    const Invalid = typeWith({ 'nodes.a.b.value': policy, 'nodes.c.d.value': policy });
    const invalid = sourceOf(Invalid, { nodes: { a: { b: { value: 1 } }, c: { d: { value: 2 } } } });
    const view = runtime();
    assert.throws(() => capture(view, 0, invalid, 100));
    assert.throws(() => snapshotRenderModel(Invalid, invalid));
    assert.equal(view.size, 0);
    const Valid = typeWith({ 'nodes.a.b.value': policy });
    assert.equal(capture(view, 0, sourceOf(Valid, { nodes: { a: { b: { value: 1 } } } }), 0), true);
  }
});

test('다른 entity는 각 타입의 같은 축 역할을 독립적으로 사용할 수 있다', () => {
  const A = typeWith({ 'nodes.a.value': RenderObject.POSITION_X });
  const B = typeWith({ 'nodes.b.value': RenderObject.POSITION_X });
  const view = runtime({ snapDistance: 160 });
  view.capture(packet(0, [entity(sourceOf(A, { nodes: { a: { value: 0 } } })),
    entity(sourceOf(B, { nodes: { b: { value: 10 } } }), { id: 'b' })]), 0);
  view.capture(packet(1, [entity(sourceOf(A, { nodes: { a: { value: 1000 } } })),
    entity(sourceOf(B, { nodes: { b: { value: 20 } } }), { id: 'b' })]), 100);
  assert.equal(sample(view, 100).nodes.a.value, 1000);
  close(view.sample('b', 0, 150).nodes.b.value, 15);
});

test('상속한 같은 경로 override를 적용한 뒤 축 역할 중복을 검사한다', () => {
  class Base extends RenderObject {
    static renderSchema = { 'nodes.a.u': this.POSITION_X, 'nodes.a.key': this.STATE_KEY };
  }
  class Derived extends Base {
    static renderSchema = {
      'nodes.a.u': this.LINEAR, 'nodes.b.u': this.POSITION_X,
      'nodes.c.u': this.ORIGIN_X, 'nodes.d.value': this.SPAWN_LINEAR,
    };
  }
  const source = sourceOf(Derived, { nodes: {
    a: { u: 99, key: 'a' }, b: { u: 20 }, c: { u: 10 }, d: { value: 1 },
  } });
  const view = runtime();
  capture(view, 0, source, 0);
  assert.deepEqual(sample(view, 0), { nodes: { a: { u: 99, key: 'a' }, b: { u: 10 }, c: { u: 10 }, d: { value: 0 } } });
  class Invalid extends Base { static renderSchema = { 'nodes.b.u': this.POSITION_X }; }
  assert.throws(() => snapshotRenderModel(Invalid, { nodes: { a: { u: 1, key: 'a' }, b: { u: 2 } } }));
});

test('서브타입은 부모 countdown 경로를 LINEAR로 override하고 다른 필드는 상속한다', () => {
  class Base extends RenderObject {
    static renderSchema = { 'nodes.a.b.value': this.COUNTDOWN_MS, 'nodes.a.b.other': this.LINEAR };
  }
  class Derived extends Base { static renderSchema = { 'nodes.a.b.value': this.LINEAR }; }
  const make = (value, other) => sourceOf(Derived, { nodes: { a: { b: { value, other } } } });
  const view = runtime();
  capture(view, 0, make(1000, 0), 0);
  capture(view, 1, make(500, 10), 100);
  close(sample(view, 150).nodes.a.b.value, 750);
  close(sample(view, 150).nodes.a.b.other, 5);
  assert.equal(snapshotRenderModel(Derived, make(-1, 1)).nodes.a.b.value, -1);
});

test('snapDistance는 양의 finite number만 허용한다', () => {
  for (const snapDistance of [0, -1, NaN, Infinity, -Infinity, '160', null]) {
    assert.throws(() => runtime({ snapDistance }));
  }
});

test('수치 역할은 target/initialSource/projection의 비유한 값을 원자적으로 거부한다', () => {
  for (const policy of [8, 9, 10, 11, 12, 13, 14]) {
    const Generic = typeWith({ 'nodes.a.b.value': policy });
    const make = value => sourceOf(Generic, { nodes: { a: { b: { value } } } });
    const source = make(1), view = runtime();
    capture(view, 0, source, 0);
    const model = sample(view, 0);
    for (const value of [NaN, Infinity, -Infinity, '1']) {
      assert.throws(() => capture(view, 1, make(value), 100));
      assert.throws(() => capture(view, 1, make(2), 100, { initialSource: make(value), teleport: true }));
      assert.throws(() => snapshotRenderModel(Generic, make(value)));
    }
    assert.equal(view.modelFor(source, 1), model);
    assert.equal(capture(view, 1, make(2), 50), true);
  }
});

test('geometry DTO와 참조 ID는 source/capture/model/projection 사이에서 alias하지 않는다', () => {
  const Generic = typeWith({
    'nodes.a.b.u': RenderObject.POSITION_X,
    'nodes.c.d.u': RenderObject.ORIGIN_X,
    'nodes.e.value': RenderObject.SPAWN_LINEAR,
    'nodes.f.geometry': RenderObject.STEP,
    'nodes.f.reference': RenderObject.STEP,
  });
  const source = sourceOf(Generic, { nodes: {
    a: { b: { u: 20 } }, c: { d: { u: 10 } }, e: { value: 1 },
    f: { geometry: { points: [[1, 2], [3, 4]], bounds: { value: 5 } }, reference: 'b' },
  }, authorityOnly: { value: 99 } });
  const before = structuredClone(source), view = runtime();
  capture(view, 0, source, 0, { type: Generic });
  const model = sample(view, 0), projection = snapshotRenderModel(Generic, source);
  assert.deepEqual(structuredClone(source), before);
  assert.notEqual(model.nodes, source.nodes);
  assert.notEqual(model.nodes.f.geometry, source.nodes.f.geometry);
  assert.notEqual(model.nodes.f.geometry.points[0], source.nodes.f.geometry.points[0]);
  assert.notEqual(projection.nodes.f.geometry, model.nodes.f.geometry);
  assert.equal(model.nodes.f.reference, 'b');
  assert.equal(Object.hasOwn(model, 'authorityOnly'), false);
  assert.equal(Object.getPrototypeOf(model), Object.prototype);
  source.nodes.a.b.u = 999;
  source.nodes.c.d.u = 999;
  source.nodes.f.geometry.points[0][0] = 999;
  source.nodes.f.reference = 'changed';
  model.nodes.f.geometry.points[1][0] = 777;
  projection.nodes.f.geometry.points[0][0] = 888;
  const later = sample(view, 50);
  close(later.nodes.a.b.u, 15);
  assert.deepEqual(later.nodes.f.geometry.points, [[1, 2], [3, 4]]);
  assert.equal(later.nodes.f.reference, 'b');
  assert.equal(source.nodes.f.geometry.points[1][0], 3);
  assert.equal(projection.nodes.f.geometry.points[1][0], 3);
});

test('같은 스키마를 명시한 plain source도 변경 없는 공개 API로 capture한다', () => {
  const Generic = typeWith(roleSchema()), view = runtime();
  const source = structuredClone(roleSource(Generic, [20, 40, 60], [10, 20, 30], 1));
  const before = structuredClone(source);
  capture(view, 0, source, 0, { type: Generic });
  assert.deepEqual(sample(view, 0).nodes.a.b, { u: 10, v: 20, w: 30 });
  assert.equal(view.modelFor(source, 0), sample(view, 0));
  assert.deepEqual(source, before);
});

test('늦은 entity validation 오류는 앞선 scoped reset/자동 seed/삭제를 원자적으로 취소한다', () => {
  const Generic = typeWith({
    'nodes.a.key': RenderObject.STATE_KEY, 'nodes.a.value': RenderObject.LINEAR,
    'nodes.b.value': RenderObject.COUNTDOWN_MS,
    'nodes.c.u': RenderObject.POSITION_X, 'nodes.d.u': RenderObject.ORIGIN_X,
    'nodes.e.value': RenderObject.SPAWN_LINEAR,
  });
  const make = (key, n, countdown = 1000) => sourceOf(Generic, { nodes: {
    a: { key, value: n }, b: { value: countdown }, c: { u: n }, d: { u: 0 }, e: { value: 1 },
  } });
  const first = make('a', 0), second = make('a', 10), view = runtime();
  view.capture(packet(0, [entity(first), entity(second, { id: 'b' })]), 0);
  const model = sample(view, 0), other = view.sample('b', 0, 0);
  const replacement = make('b', 20, 900), fresh = make('a', 50, 900);
  assert.throws(() => view.capture(packet(1, [
    entity(replacement), entity(fresh, { id: 'fresh' }), entity(make('a', 10, -1), { id: 'invalid' }),
  ]), 100));
  assert.equal(view.size, 2);
  assert.equal(view.modelFor(first, 1), model);
  assert.equal(view.modelFor(second, 1), other);
  assert.equal(view.modelFor(replacement, 1), null);
  assert.equal(view.modelFor(fresh, 1), null);
  assert.equal(model.nodes.a.key, 'a');
  assert.equal(model.nodes.a.value, 0);
  assert.equal(view.capture(packet(1, [entity(replacement), entity(make('a', 20, 900), { id: 'b' })]), 50), true);
  assert.equal(sample(view, 50).nodes.a.key, 'b');
  assert.equal(sample(view, 50).nodes.a.value, 20);
});

for (const [label, options, now] of [
  ['simulation NaN', { timeMs: NaN }, 100],
  ['simulation Infinity', { timeMs: Infinity }, 100],
  ['receipt NaN', {}, NaN], ['receipt Infinity', {}, Infinity], ['receipt backwards', {}, -1],
]) {
  test(`시간 validation 오류는 정책 값과 성공 clock/sequence를 유지한다: ${label}`, () => {
    const Generic = typeWith({ 'nodes.a.key': RenderObject.STATE_KEY, 'nodes.a.value': RenderObject.COUNTDOWN_MS });
    const make = (key, value) => sourceOf(Generic, { nodes: { a: { key, value } } });
    const source = make('a', 1000), view = runtime();
    capture(view, 0, source, 0);
    const model = sample(view, 0);
    assert.throws(() => capture(view, 1, make('b', 900), now, {}, options));
    assert.equal(view.modelFor(source, 1), model);
    assert.equal(model.nodes.a.key, 'a');
    assert.equal(model.nodes.a.value, 1000);
    assert.equal(capture(view, 1, make('a', 900), 50), true);
    close(sample(view, 100).nodes.a.value, 950);
  });
}

test('거부된 packet은 countdown의 simulation 기준과 scoped reset 이력을 바꾸지 않는다', () => {
  const Generic = typeWith({ 'nodes.a.value': RenderObject.COUNTDOWN_MS, 'nodes.a.other': RenderObject.LINEAR });
  const make = (value, other) => sourceOf(Generic, { nodes: { a: { value, other } } });
  const view = runtime();
  capture(view, 0, make(1000, 0), 0);
  capture(view, 1, make(900, 10), 100);
  assert.equal(capture(view, 1, make(2000, 999), 300), false);
  assert.equal(capture(view, 2, make(2000, 999), 300, {}, { timeMs: 50 }), false);
  assert.equal(capture(view, 2, make(800, 20), 150), true);
  close(sample(view, 150).nodes.a.value, 950);
  close(sample(view, 150).nodes.a.other, 5);
  close(sample(view, 200).nodes.a.value, 875);
});

test('같은 simulation timeMs의 동일 countdown은 정상 연속이며 변경 countdown은 부모 reset이다', () => {
  const Generic = typeWith({ 'nodes.a.value': RenderObject.COUNTDOWN_MS, 'nodes.a.other': RenderObject.LINEAR });
  const make = (value, other) => sourceOf(Generic, { nodes: { a: { value, other } } });
  const view = runtime();
  capture(view, 0, make(1000, 0), 0);
  capture(view, 1, make(1000, 10), 100, {}, { timeMs: 0 });
  close(sample(view, 150).nodes.a.other, 5);
  capture(view, 2, make(999, 20), 150, {}, { timeMs: 0 });
  assert.equal(sample(view, 150).nodes.a.other, 20);
  assert.equal(sample(view, 150).nodes.a.value, 999);
});

test('COUNTDOWN_SECONDS는 유한 simulation 시각 차의 overflow에도 정상 감소를 잇는다', () => {
  const Generic = typeWith({ 'nodes.a.b.value': RenderObject.COUNTDOWN_SECONDS, 'nodes.a.b.other': RenderObject.LINEAR });
  const make = (value, other) => sourceOf(Generic, { nodes: { a: { b: { value, other } } } });
  const view = runtime();
  capture(view, 0, make(1e306, 0), 0, {}, { timeMs: -1e308 });
  // 두 시각은 유한하며 실제 초 단위 감소량 2e305도 유한합니다.
  capture(view, 1, make(8e305, 10), 100, {}, { timeMs: 1e308 });
  close(sample(view, 100).nodes.a.b.other, 0);
  close(sample(view, 100).nodes.a.b.value / 1e306, 1);
  close(sample(view, 150).nodes.a.b.other, 5);
  close(sample(view, 150).nodes.a.b.value / 1e306, 0.9);
});

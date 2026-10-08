import assert from 'node:assert/strict';
import test from 'node:test';
import { RenderObject, PresentationRuntime, snapshotRenderModel } from '../index.js';

const close = (actual, expected) => assert.ok(
  Math.abs(actual - expected) < 1e-9,
  `${actual} != ${expected}`,
);
const radians = degrees => degrees * Math.PI / 180;

class Actor extends RenderObject {
  static renderSchema = Object.freeze({
    'position.x': RenderObject.LINEAR,
    'position.y': RenderObject.LINEAR,
    angle: RenderObject.ANGLE,
    state: RenderObject.STEP,
    flash: RenderObject.DECAY,
  });

  constructor(x = 0) {
    super();
    this.position = { x, y: x * 2 };
    this.angle = 0;
    this.state = 'idle';
    this.flash = 0;
    this.authorityOnly = { health: 100 };
  }

  render(context, model) {
    context.push({ source: this, model });
  }
}

const entity = (source, options = {}) => ({ id: 'actor', generation: 0, source, ...options });
const packet = (sequence, entities, options = {}) => ({
  revision: 0, sequence, timeMs: sequence * 100, entities, ...options,
});
const snapshot = (sequence, source, entityOptions = {}, packetOptions = {}) =>
  packet(sequence, [entity(source, entityOptions)], packetOptions);
const runtime = options => new PresentationRuntime({ stepMs: 100, ...options });

test('독립 리뷰: 짧은 외삽 한도·배열 length·primitive seed는 원자적으로 거부한다', () => {
  assert.throws(() => runtime({ extrapolation: { fields: ['position.x'], maxMs: 25 } }), /stepMs/);
  class Arrays extends RenderObject { static renderSchema = { 'items.length': this.LINEAR }; }
  const arrays = new Arrays(); arrays.items = [1]; const view = runtime();
  assert.throws(() => view.capture({ revision: 0, sequence: 0, timeMs: 0, entities: [{ id: 'a', generation: 0, source: arrays }] }, 100), /length/);
  assert.equal(view.size, 0);
  const source = new Actor();
  assert.throws(() => view.capture({ revision: 0, sequence: 0, timeMs: 0, entities: [{ id: 'a', generation: 0, source, initialSource: 123 }] }, 100), /object/);
  view.capture({ revision: 0, sequence: 0, timeMs: 0, entities: [{ id: 'a', generation: 0, source }] }, 0);
  assert.equal(view.sample('a', 0, 0).position.x, 0);
});

test('독립 리뷰: plain source render 타입 오류는 모델과 clock을 진행시키지 않는다', () => {
  const view = runtime(), source = { position: { x: 0, y: 0 }, angle: 0, state: 'idle', flash: 0 };
  view.capture({ revision: 0, sequence: 0, timeMs: 0, entities: [{ id: 'a', generation: 0, source, type: Actor }] }, 0);
  assert.throws(() => view.render(source, [], 100), /RenderObject/);
  assert.equal(view.sample('a', 0, 1).position.x, 0);
});

test('RenderObject 공개 상수와 추상 render 계약', () => {
  assert.deepEqual(
    [RenderObject.LINEAR, RenderObject.ANGLE, RenderObject.STEP, RenderObject.DECAY, RenderObject.CYCLE],
    [0, 1, 2, 3, 4],
  );
  assert.deepEqual(RenderObject.renderSchema, {});
  assert.throws(() => new RenderObject().render({}, {}), /render/);
});

class CyclicActor extends Actor {
  static renderSchema = { phase: RenderObject.CYCLE };
  constructor(phase = 0, x = 0) { super(x); this.phase = phase; }
}

test('CYCLE은 0.75→0을 앞으로 감아 중간 0.875, 완료 0으로 표현한다', () => {
  const view = runtime();
  view.capture(snapshot(0, new CyclicActor(0.75)), 0);
  view.capture(snapshot(1, new CyclicActor(0)), 100);
  close(view.sample('actor', 0, 100).phase, 0.75);
  close(view.sample('actor', 0, 150).phase, 0.875);
  assert.equal(view.sample('actor', 0, 200).phase, 0);
  assert.equal(view.sample('actor', 0, 1000).phase, 0);
});

test('CYCLE은 증가/동일 값과 경계 통과 및 수신 시각 retarget을 처리한다', () => {
  const view = runtime();
  view.capture(snapshot(0, new CyclicActor(0.9)), 0);
  view.capture(snapshot(1, new CyclicActor(0.1)), 100);
  close(view.sample('actor', 0, 125).phase, 0.95);
  close(view.sample('actor', 0, 175).phase, 0.05);
  view.capture(snapshot(2, new CyclicActor(0.25)), 175);
  close(view.sample('actor', 0, 175).phase, 0.05);
  close(view.sample('actor', 0, 225).phase, 0.15);
  assert.equal(view.sample('actor', 0, 275).phase, 0.25);
  view.capture(snapshot(3, new CyclicActor(0.25)), 300);
  assert.equal(view.sample('actor', 0, 350).phase, 0.25);
});

test('CYCLE의 seed/reset/teleport와 nullable 값도 다른 필드 생명주기를 따른다', () => {
  const view = runtime();
  view.capture(snapshot(0, new CyclicActor(0), { initialSource: new CyclicActor(0.75) }), 0);
  close(view.sample('actor', 0, 50).phase, 0.875);
  view.capture(snapshot(1, new CyclicActor(0.2, 10), { resetFields: ['phase'] }), 50);
  assert.equal(view.sample('actor', 0, 50).phase, 0.2);
  close(view.sample('actor', 0, 100).position.x, 5);
  view.capture(snapshot(2, new CyclicActor(1, 20), { teleport: true }), 100);
  assert.equal(view.sample('actor', 0, 100).phase, 1);
  view.capture(snapshot(3, new CyclicActor(null, 20)), 150);
  assert.equal(view.sample('actor', 0, 150).phase, null);
  view.capture(snapshot(4, new CyclicActor(0, 20)), 200);
  assert.equal(view.sample('actor', 0, 200).phase, 0);
  const missing = new CyclicActor(); delete missing.phase;
  view.capture(snapshot(5, missing), 250);
  assert.equal(Object.hasOwn(view.sample('actor', 0, 250), 'phase'), false);
});

for (const value of [-Number.EPSILON, 1 + Number.EPSILON, -1, 2, NaN, Infinity, '0.5']) {
  test(`CYCLE의 범위/숫자 검증은 target/seed/projection에 적용한다: ${String(value)}`, () => {
    const source = new CyclicActor(0.5), view = runtime();
    view.capture(snapshot(0, source), 0);
    const error = typeof value === 'number' && Number.isFinite(value) ? RangeError : TypeError;
    assert.throws(() => view.capture(snapshot(1, new CyclicActor(value)), 100), error);
    assert.throws(() => view.capture(snapshot(1, new CyclicActor(0), {
      teleport: true, initialSource: new CyclicActor(value),
    }), 100), error);
    assert.throws(() => snapshotRenderModel(CyclicActor, new CyclicActor(value)), error);
    assert.equal(view.modelFor(source, 1).phase, 0.5);
    assert.equal(view.capture(snapshot(1, new CyclicActor(1)), 2), true);
  });
}

test('snapshotRenderModel은 명시적 타입으로 고정 이벤트 anchor를 분리해 투영한다', () => {
  const source = new CyclicActor(0.75, 10);
  source.state = { list: [{ id: 'target', offset: [1, 2] }] };
  const anchor = snapshotRenderModel(CyclicActor, source);
  assert.deepEqual(anchor, {
    position: { x: 10, y: 20 }, angle: 0,
    state: { list: [{ id: 'target', offset: [1, 2] }] }, flash: 0, phase: 0.75,
  });
  assert.equal(Object.getPrototypeOf(anchor), Object.prototype);
  assert.equal('authorityOnly' in anchor, false);
  assert.equal('render' in anchor, false);
  assert.notEqual(anchor.position, source.position);
  assert.notEqual(anchor.state, source.state);
  assert.notEqual(anchor.state.list, source.state.list);
  assert.notEqual(anchor.state.list[0], source.state.list[0]);
  assert.notEqual(anchor.state.list[0].offset, source.state.list[0].offset);
  source.position.x = 99; source.state.list[0].offset[0] = 99; source.phase = 0;
  assert.equal(anchor.position.x, 10);
  assert.equal(anchor.state.list[0].offset[0], 1);
  assert.equal(anchor.phase, 0.75);
  anchor.state.list[0].offset[1] = 88;
  assert.equal(source.state.list[0].offset[1], 2);
  const fresh = snapshotRenderModel(CyclicActor, source);
  assert.notEqual(fresh, anchor);
  assert.notEqual(fresh.position, anchor.position);
  assert.equal(fresh.position.x, 99);
  const view = runtime();
  assert.equal(view.isModel(anchor), false);
  assert.equal(view.modelFor(anchor, 0), null);
  assert.equal(view.modelFor(source, 0), null);
  assert.throws(() => view.render(source, [], 0), /captured/);
  view.capture(snapshot(0, source), 0);
  view.capture(packet(1, []), 100);
  assert.equal(anchor.position.x, 10);
  assert.equal(view.modelFor(anchor, 100), null);
});

test('snapshotRenderModel은 plain source/nullable/fixed array slot을 타입 schema로 투영한다', () => {
  class Anchor extends RenderObject {
    static renderSchema = {
      'position.x': RenderObject.LINEAR, 'position.y': RenderObject.LINEAR,
      'attachments.0.angle': RenderObject.ANGLE, 'attachments.2.id': RenderObject.STEP,
      target: RenderObject.STEP,
    };
  }
  const source = {
    position: null, attachments: [{ angle: 0, hidden: 9 }, { secret: 8 }, { id: { value: 't' } }],
    target: undefined, unrelated: 'authority',
  };
  const anchor = snapshotRenderModel(Anchor, source);
  assert.deepEqual(anchor.position, null);
  assert.equal(Object.hasOwn(anchor, 'target'), false);
  assert.equal(anchor.attachments.length, 3);
  assert.equal(1 in anchor.attachments, false);
  assert.deepEqual(anchor.attachments[0], { angle: 0 });
  assert.deepEqual(anchor.attachments[2], { id: { value: 't' } });
  assert.notEqual(anchor.attachments, source.attachments);
  assert.notEqual(anchor.attachments[2].id, source.attachments[2].id);
  assert.throws(() => snapshotRenderModel(Object, source), TypeError);
  const invalid = { position: { x: Infinity } };
  assert.throws(() => snapshotRenderModel(Anchor, invalid), TypeError);
  let reads = 0;
  Object.defineProperty(invalid.position, 'x', { get() { reads++; return 1; } });
  assert.throws(() => snapshotRenderModel(Anchor, invalid), TypeError);
  assert.equal(reads, 0);
});

test('첫 표본은 선언한 중첩 필드만 가진 plain model로 snap하고 재사용한다', () => {
  const view = runtime();
  const source = new Actor(10);
  Object.freeze(source.position);
  Object.freeze(source);
  const input = snapshot(0, source);
  Object.freeze(input.entities[0]);
  Object.freeze(input.entities);
  Object.freeze(input);
  assert.equal(view.capture(input, 0), true);
  assert.equal(view.size, 1);
  const model = view.sample('actor', 0, 0);
  assert.deepEqual(model, { position: { x: 10, y: 20 }, angle: 0, state: 'idle', flash: 0 });
  assert.equal(Object.getPrototypeOf(model), Object.prototype);
  assert.equal(Object.getPrototypeOf(model.position), Object.prototype);
  assert.notEqual(model, source);
  assert.notEqual(model.position, source.position);
  assert.equal('render' in model, false);
  assert.equal('authorityOnly' in model, false);
  assert.equal(view.isModel(model), true);
  assert.equal(view.isModel(source), false);
  assert.equal(view.modelFor(source, 0), model);
  assert.equal(view.modelFor(model, 0), model);
  const position = model.position;
  assert.equal(view.sample('actor', 0, 0), model);
  assert.equal(view.sample('actor', 0, 100), model);
  assert.equal(model.position, position);
});

test('동일 identity의 source 교체는 model을 재사용하고 이전 source 등록은 제거한다', () => {
  const view = runtime();
  const oldSource = new Actor(0);
  view.capture(snapshot(0, oldSource), 0);
  const model = view.sample('actor', 0, 0);
  const position = model.position;
  const source = new Actor(10);
  view.capture(snapshot(1, source), 100);
  assert.equal(view.modelFor(oldSource, 100), null);
  assert.equal(view.modelFor(source, 150), model);
  assert.equal(model.position, position);
  close(model.position.x, 5);
  const context = [];
  assert.equal(view.render(source, context, 150), model);
  assert.deepEqual(context, [{ source, model }]);
  assert.throws(() => view.render(oldSource, context, 150), /captured/);
});

test('동일 프레임의 여러 entity 모델은 독립적이며 modelFor(model)도 현재 곡선을 평가한다', () => {
  const view = runtime(); const left = new Actor(0), right = new Actor(100);
  view.capture(packet(0, [entity(left), entity(right, { id: 'other', generation: 2 })]), 0);
  const leftModel = view.sample('actor', 0, 0), rightModel = view.sample('other', 2, 0);
  assert.notEqual(leftModel, rightModel);
  assert.notEqual(leftModel.position, rightModel.position);
  const nextLeft = new Actor(10), nextRight = new Actor(120);
  view.capture(packet(1, [entity(nextLeft), entity(nextRight, { id: 'other', generation: 2 })]), 100);
  assert.equal(view.modelFor(leftModel, 150), leftModel);
  assert.equal(view.modelFor(rightModel, 150), rightModel);
  close(leftModel.position.x, 5); close(rightModel.position.x, 110);
  assert.equal(view.sample('other', 0, 150), null);
  view.capture(packet(2, [entity(nextRight, { id: 'other', generation: 2 })]), 200);
  assert.equal(view.size, 1);
  assert.equal(view.modelFor(leftModel, 200), null);
  assert.equal(view.modelFor(nextLeft, 200), null);
  assert.equal(view.modelFor(nextRight, 200), rightModel);
});

test('마지막 렌더가 아닌 새 표본 수신 시각의 곡선에서 retarget한다', () => {
  const view = runtime();
  view.capture(snapshot(0, new Actor(0)), 0);
  view.capture(snapshot(1, new Actor(10)), 100);
  const model = view.sample('actor', 0, 120);
  close(model.position.x, 2);
  view.capture(snapshot(2, new Actor(20)), 150);
  assert.equal(view.sample('actor', 0, 150), model);
  close(model.position.x, 5);
  close(view.sample('actor', 0, 200).position.x, 12.5);
  close(view.sample('actor', 0, 250).position.x, 20);
  close(view.sample('actor', 0, 1000).position.x, 20);
});

test('now=0과 같은 수신 시각의 coalesced 표본도 마지막 목표로 연속 연결한다', () => {
  const view = runtime();
  view.capture(snapshot(0, new Actor(0)), 0);
  view.capture(snapshot(1, new Actor(10), {}, { timeMs: 0 }), 0);
  const model = view.sample('actor', 0, 0);
  close(model.position.x, 0);
  view.capture(snapshot(2, new Actor(20), {}, { timeMs: 0 }), 0);
  assert.equal(view.sample('actor', 0, 0), model);
  close(model.position.x, 0);
  close(view.sample('actor', 0, 50).position.x, 10);
});

test('ANGLE은 경계를 최단 회전하고 반 바퀴 동률은 음의 방향이다', () => {
  const view = runtime();
  const start = new Actor(); start.angle = radians(350);
  const target = new Actor(); target.angle = radians(10);
  view.capture(snapshot(0, start), 0);
  view.capture(snapshot(1, target), 100);
  close(view.sample('actor', 0, 150).angle, 0);
  close(view.sample('actor', 0, 200).angle, radians(10));
  const tie = new Actor(); tie.angle = 1.72;
  view.capture(snapshot(2, tie, { teleport: true }), 200);
  const halfTurn = new Actor(); halfTurn.angle = 1.72 + Math.PI;
  view.capture(snapshot(3, halfTurn), 200);
  close(view.sample('actor', 0, 250).angle, 1.72 - Math.PI / 2);
  const negative = new Actor(); negative.angle = -1e-16;
  view.capture(snapshot(4, negative, { teleport: true }), 300);
  const angle = view.sample('actor', 0, 300).angle;
  assert.ok(angle >= 0 && angle < Math.PI * 2);
});

test('LINEAR의 유한 반대 부호 극값은 중간 계산에서도 overflow하지 않는다', () => {
  const view = runtime();
  const start = new Actor(); start.position.x = -Number.MAX_VALUE;
  const target = new Actor(); target.position.x = Number.MAX_VALUE;
  view.capture(snapshot(0, start), 0);
  view.capture(snapshot(1, target), 0);
  close(view.sample('actor', 0, 50).position.x, 0);
});

test('STEP은 수신 즉시 전환하고 DECAY 감소는 보간, 증가는 즉시 재시작한다', () => {
  const view = runtime();
  const start = new Actor(); start.flash = 1;
  view.capture(snapshot(0, start), 0);
  const target = new Actor(10); target.state = 'moving';
  view.capture(snapshot(1, target), 100);
  assert.equal(view.sample('actor', 0, 100).state, 'moving');
  close(view.sample('actor', 0, 150).flash, 0.5);
  const hit = new Actor(20); hit.flash = 0.8;
  view.capture(snapshot(2, hit), 150);
  const model = view.sample('actor', 0, 150);
  close(model.flash, 0.8);
  close(model.position.x, 5);
  view.capture(snapshot(3, new Actor(30)), 200);
  close(view.sample('actor', 0, 250).flash, 0.4);
  close(view.sample('actor', 0, 300).flash, 0);
});

test('null과 undefined 부모/leaf는 0으로 바꾸지 않고 삭제 후 복원한다', () => {
  class Nullable extends RenderObject {
    static renderSchema = {
      'target.position.x': RenderObject.LINEAR,
      'target.position.y': RenderObject.LINEAR,
      value: RenderObject.LINEAR,
      'items.0.x': RenderObject.LINEAR,
      'items.1.x': RenderObject.LINEAR,
    };
  }
  const view = runtime();
  const source = new Nullable();
  source.target = null; source.value = null; source.items = null;
  view.capture(snapshot(0, source), 0);
  const model = view.sample('actor', 0, 0);
  assert.deepEqual(model, { target: null, value: null, items: null });
  source.target = { position: { x: 10, y: undefined } };
  source.value = undefined; source.items = [{ x: 7 }, { x: null }];
  view.capture(snapshot(1, source), 100);
  assert.equal(view.sample('actor', 0, 100), model);
  assert.deepEqual(model, { target: { position: { x: 10 } }, items: [{ x: 7 }, { x: null }] });
  assert.equal(Object.hasOwn(model, 'value'), false);
  assert.equal(Object.hasOwn(model.target.position, 'y'), false);
  const target = model.target, position = model.target.position, items = model.items;
  source.target.position = null; source.items.length = 1;
  view.capture(snapshot(2, source), 200);
  view.sample('actor', 0, 200);
  assert.equal(model.target, target);
  assert.equal(model.target.position, null);
  assert.equal(model.items, items);
  assert.equal(model.items.length, 1);
  assert.equal(1 in model.items, false);
  delete source.target; delete source.items;
  view.capture(snapshot(3, source), 300);
  assert.deepEqual(view.sample('actor', 0, 300), {});
  source.target = { position: { x: 0, y: 0 } }; source.items = [];
  view.capture(snapshot(4, source), 400);
  assert.deepEqual(view.sample('actor', 0, 400), { target: { position: { x: 0, y: 0 } }, items: [] });
  assert.notEqual(model.target.position, position);
});

test('nullable 숫자 leaf는 등장/삭제를 snap하고 다른 숫자는 계속 보간한다', () => {
  const view = runtime();
  const source = new Actor(); source.position.x = null;
  view.capture(snapshot(0, source), 0);
  const target = new Actor(10);
  view.capture(snapshot(1, target), 100);
  const model = view.sample('actor', 0, 100);
  assert.equal(model.position.x, 10);
  assert.equal(model.position.y, 0);
  target.position.x = undefined; target.position.y = 40;
  view.capture(snapshot(2, target), 150);
  view.sample('actor', 0, 150);
  assert.equal(Object.hasOwn(model.position, 'x'), false);
  close(model.position.y, 10);
});

test('deep STEP/배열은 capture와 model 양쪽에서 원본 alias가 없고 중첩 output을 재사용한다', () => {
  class Data extends RenderObject {
    static renderSchema = { data: RenderObject.STEP, 'points.0.x': RenderObject.LINEAR };
  }
  const source = new Data();
  const sparse = new Array(3); sparse[1] = { name: 'middle' };
  source.data = { list: [{ nested: { n: 1 } }, null, undefined], sparse };
  source.points = [{ x: 2, secret: { n: 9 } }];
  const view = runtime();
  view.capture(snapshot(0, source), 0);
  source.data.list[0].nested.n = 999;
  source.data.sparse[1].name = 'mutated';
  source.points[0].x = 999;
  const model = view.sample('actor', 0, 0);
  assert.equal(model.data.list[0].nested.n, 1);
  assert.equal(model.data.sparse[1].name, 'middle');
  assert.equal(model.points[0].x, 2);
  assert.equal('secret' in model.points[0], false);
  assert.equal(0 in model.data.sparse, false);
  assert.equal(2 in model.data.sparse, false);
  for (const [output, original] of [
    [model.data, source.data], [model.data.list, source.data.list],
    [model.data.list[0], source.data.list[0]],
    [model.data.list[0].nested, source.data.list[0].nested],
    [model.data.sparse, source.data.sparse], [model.data.sparse[1], source.data.sparse[1]],
    [model.points, source.points], [model.points[0], source.points[0]],
  ]) assert.notEqual(output, original);
  const data = model.data, list = data.list, first = list[0], nested = first.nested;
  nested.n = 123;
  assert.equal(source.data.list[0].nested.n, 999);
  view.sample('actor', 0, 1);
  assert.equal(nested.n, 1, 'model도 private capture 데이터의 alias가 아니어야 한다');
  source.data = { list: [{ nested: { n: 2 } }] };
  view.capture(snapshot(1, source), 100);
  view.sample('actor', 0, 100);
  assert.equal(model.data, data);
  assert.equal(model.data.list, list);
  assert.equal(model.data.list[0], first);
  assert.equal(model.data.list[0].nested, nested);
  assert.equal(nested.n, 2);
  assert.equal(list.length, 1);
  assert.equal('sparse' in data, false);
});

test('중첩 부모의 object/array 전환과 sparse array 길이를 그대로 표현한다', () => {
  class Points extends RenderObject {
    static renderSchema = { 'points.0.x': RenderObject.LINEAR, 'points.2.x': RenderObject.LINEAR };
  }
  const view = runtime(), source = new Points();
  source.points = { 0: { x: 1 }, 2: { x: 3 } };
  view.capture(snapshot(0, source), 0);
  const model = view.sample('actor', 0, 0), object = model.points;
  assert.equal(Array.isArray(object), false);
  source.points = new Array(3); source.points[0] = { x: 1 }; source.points[2] = { x: 3 };
  view.capture(snapshot(1, source), 100); view.sample('actor', 0, 100);
  assert.equal(Array.isArray(model.points), true);
  assert.notEqual(model.points, object);
  assert.equal(model.points.length, 3); assert.equal(1 in model.points, false);
  source.points = { 0: { x: 1 } };
  view.capture(snapshot(2, source), 200); view.sample('actor', 0, 200);
  assert.equal(Array.isArray(model.points), false);
  assert.equal(Object.hasOwn(model.points, '2'), false);
});

test('STEP은 null-prototype data와 순환하지 않는 공유 하위 객체를 안전하게 분리한다', () => {
  const source = new Actor();
  const shared = Object.assign(Object.create(null), { ok: true });
  source.state = { left: shared, right: shared };
  const view = runtime(); view.capture(snapshot(0, source), 0);
  const model = view.sample('actor', 0, 0);
  assert.deepEqual(model.state, { left: { ok: true }, right: { ok: true } });
  assert.notEqual(model.state.left, shared);
  assert.notEqual(model.state.right, shared);
});

test('상속 schema를 합치고 동일 경로는 가장 하위 타입의 코드가 우선한다', () => {
  class Base extends RenderObject {
    static renderSchema = { x: RenderObject.LINEAR, 'pose.y': RenderObject.LINEAR };
  }
  class Middle extends Base {
    static renderSchema = { x: RenderObject.STEP, 'pose.angle': RenderObject.ANGLE };
  }
  class Leaf extends Middle {
    static renderSchema = { value: RenderObject.LINEAR };
  }
  class Inherited extends Leaf {}
  const source = new Inherited();
  source.x = 0; source.pose = { y: 0, angle: radians(350) }; source.value = 0;
  const view = runtime(); view.capture(snapshot(0, source), 0);
  source.x = 10; source.pose = { y: 20, angle: radians(10) }; source.value = 30;
  view.capture(snapshot(1, source), 100);
  const model = view.sample('actor', 0, 150);
  assert.equal(model.x, 10); close(model.pose.y, 10);
  close(model.pose.angle, 0); close(model.value, 15);
});

test('명시적 RenderObject type으로 plain source도 수집하되 render는 실제 인스턴스를 요구한다', () => {
  const source = { position: { x: 4, y: 8 }, angle: 0, state: 'plain', flash: 0 };
  const view = runtime();
  view.capture(snapshot(0, source, { type: Actor }), 0);
  assert.equal(view.modelFor(source, 0).position.x, 4);
  assert.throws(() => view.render(source, [], 0), TypeError);
});

for (const [name, schema] of [
  ['빈 schema', {}], ['배열 schema', []], ['null schema', null],
  ['잘못된 코드', { x: 5 }], ['문자열 코드', { x: 'LINEAR' }],
  ['소수 코드', { x: 0.5 }], ['음수 코드', { x: -1 }],
  ['빈 경로', { '': 0 }], ['빈 중간 경로', { 'position..x': 0 }],
  ['선행 점', { '.x': 0 }], ['후행 점', { 'x.': 0 }],
  ['부모 이후 자식', { position: 2, 'position.x': 0 }],
  ['자식 이후 부모', { 'position.x': 0, position: 2 }],
  ...['__proto__', 'constructor', 'prototype'].flatMap(key => [
    [`unsafe root ${key}`, JSON.parse(`{"${key}":0}`)],
    [`unsafe nested ${key}`, { [`position.${key}.x`]: 0 }],
  ]),
]) {
  test(`schema 검증: ${name}`, () => {
    class Invalid extends RenderObject { static renderSchema = schema; }
    const view = runtime();
    assert.throws(() => view.capture(snapshot(0, new Invalid()), 0), TypeError);
    assert.equal(view.size, 0);
    assert.equal(Object.prototype.x, undefined);
  });
}

test('상속으로 생긴 부모/자식 경로 충돌도 거부한다', () => {
  class Base extends RenderObject { static renderSchema = { position: RenderObject.STEP }; }
  class Child extends Base { static renderSchema = { 'position.x': RenderObject.LINEAR }; }
  assert.throws(() => runtime().capture(snapshot(0, new Child()), 0), /[Oo]verlap/);
});

test('RenderObject를 상속하지 않는 명시적 type은 거부한다', () => {
  for (const type of [class Other {}, Object, {}, 'Actor']) {
    assert.throws(() => runtime().capture(snapshot(0, new Actor(), { type }), 0), TypeError);
  }
});

test('schema map accessor는 실행하지 않고 거부한다', () => {
  let reads = 0;
  class Accessor extends RenderObject { static renderSchema = {}; }
  Object.defineProperty(Accessor.renderSchema, 'x', {
    enumerable: true, get() { reads++; return RenderObject.LINEAR; },
  });
  assert.throws(() => runtime().capture(snapshot(0, new Accessor()), 0), TypeError);
  assert.equal(reads, 0);
});

test('static renderSchema accessor도 실행하지 않고 거부한다', () => {
  let reads = 0;
  class Accessor extends RenderObject {
    static get renderSchema() { reads++; return { x: RenderObject.LINEAR }; }
  }
  const source = new Accessor(); source.x = 1;
  assert.throws(() => runtime().capture(snapshot(0, source), 0), TypeError);
  assert.equal(reads, 0);
});

for (const location of ['parent', 'leaf', 'STEP', 'STEP array']) {
  test(`선언 데이터 accessor는 호출하지 않는다: ${location}`, () => {
    let reads = 0;
    const source = new Actor();
    const getter = { enumerable: true, get() { reads++; return 1; } };
    if (location === 'parent') Object.defineProperty(source, 'position', getter);
    if (location === 'leaf') Object.defineProperty(source.position, 'x', getter);
    if (location === 'STEP') {
      source.state = {}; Object.defineProperty(source.state, 'nested', getter);
    }
    if (location === 'STEP array') {
      source.state = [0]; Object.defineProperty(source.state, '0', getter);
    }
    assert.throws(() => runtime().capture(snapshot(0, source), 0), TypeError);
    assert.equal(reads, 0);
  });
}

test('schema 외 accessor와 메서드/순환 권위 상태는 읽거나 복사하지 않는다', () => {
  const source = new Actor();
  let reads = 0;
  Object.defineProperty(source, 'unrelated', { enumerable: true, get() { reads++; throw Error('authority'); } });
  source.authorityOnly.self = source;
  const view = runtime(); view.capture(snapshot(0, source), 0);
  assert.equal(reads, 0);
  assert.equal('unrelated' in view.sample('actor', 0, 0), false);
});

for (const [name, makeValue] of [
  ['cycle', () => { const value = {}; value.self = value; return value; }],
  ['Date', () => new Date(0)], ['class', () => new Actor()],
  ['function', () => () => {}], ['symbol', () => Symbol('state')],
  ['bigint', () => 1n], ['NaN', () => NaN], ['Infinity', () => Infinity],
  ...['__proto__', 'constructor', 'prototype'].map(key => [
    `unsafe ${key}`, () => ({ nested: JSON.parse(`{"${key}":1}`) }),
  ]),
]) {
  test(`STEP의 plain-data 계약을 위반한 값 거부: ${name}`, () => {
    const source = new Actor(); source.state = makeValue();
    assert.throws(() => runtime().capture(snapshot(0, source), 0), TypeError);
  });
}

for (const [name, makeInvalid] of [
  ['중복 id', () => [entity(new Actor(20)), entity(new Actor(30))]],
  ['빈 id', () => [entity(new Actor(20)), entity(new Actor(), { id: '' })]],
  ['중복 source', () => { const source = new Actor(20); return [entity(source), entity(source, { id: 'other' })]; }],
  ['잘못된 generation', () => [entity(new Actor(20)), entity(new Actor(), { id: 'bad', generation: -1 })]],
  ['숫자 NaN', () => { const source = new Actor(); source.position.x = NaN; return [entity(new Actor(20)), entity(source, { id: 'bad' })]; }],
  ['숫자 문자열', () => { const source = new Actor(); source.position.x = '1'; return [entity(new Actor(20)), entity(source, { id: 'bad' })]; }],
  ['숫자 Infinity', () => { const source = new Actor(); source.flash = Infinity; return [entity(new Actor(20)), entity(source, { id: 'bad' })]; }],
  ['부모 scalar', () => { const source = new Actor(); source.position = 1; return [entity(new Actor(20)), entity(source, { id: 'bad' })]; }],
  ['teleport 형식', () => [entity(new Actor(20)), entity(new Actor(), { id: 'bad', teleport: 1 })]],
  ['unknown resetFields', () => [entity(new Actor(20)), entity(new Actor(), { id: 'bad', resetFields: ['unknown'] })]],
  ['중복 resetFields', () => [entity(new Actor(20)), entity(new Actor(), { id: 'bad', resetFields: ['position.x', 'position.x'] })]],
  ['resetFields 형식', () => [entity(new Actor(20)), entity(new Actor(), { id: 'bad', resetFields: 'position.x' })]],
  ['invalid initialSource', () => [entity(new Actor(20)), entity(new Actor(), { id: 'bad', initialSource: { position: { x: Infinity } } })]],
  ['source 없음', () => [entity(new Actor(20)), entity(null, { id: 'bad' })]],
]) {
  test(`malformed 전체 snapshot은 모델/source/시계/순서를 원자적으로 유지: ${name}`, () => {
    const view = runtime();
    const first = new Actor(); view.capture(snapshot(0, first), 0);
    const source = new Actor(10); view.capture(snapshot(1, source), 100);
    const model = view.sample('actor', 0, 120);
    close(model.position.x, 2);
    const invalid = packet(2, makeInvalid());
    assert.throws(() => view.capture(invalid, 500));
    assert.equal(view.size, 1);
    assert.equal(model.position.x, 2);
    assert.equal(view.modelFor(source, 125), model);
    close(model.position.x, 2.5);
    assert.equal(view.modelFor(invalid.entities[0].source, 125), null);
    assert.equal(view.capture(snapshot(2, new Actor(20)), 130), true);
    close(view.sample('actor', 0, 130).position.x, 3);
  });
}

for (const [name, options] of [
  ['revision', { revision: -1 }], ['sequence', { sequence: Number.MAX_SAFE_INTEGER + 1 }],
  ['timeMs', { timeMs: Infinity }], ['mode', { mode: 'unknown' }],
  ['entities', { entities: {} }],
]) {
  test(`packet metadata 검증도 원자적이다: ${name}`, () => {
    const view = runtime(); const source = new Actor(4);
    view.capture(snapshot(0, source), 0);
    assert.throws(() => view.capture(snapshot(1, new Actor(99), {}, options), 100));
    assert.equal(view.modelFor(source, 1).position.x, 4);
    assert.equal(view.capture(snapshot(1, new Actor(8)), 2), true);
  });
}

test('늦은 revision/sequence/timeMs 거부는 기존 track과 presentation clock을 유지한다', () => {
  const view = runtime(); const source = new Actor(10);
  view.capture(snapshot(4, source, {}, { revision: 2, mode: 'load', timeMs: 100 }), 10);
  for (const input of [
    snapshot(99, new Actor(999), {}, { revision: 1 }),
    snapshot(4, new Actor(999), {}, { revision: 2, timeMs: 100 }),
    snapshot(3, new Actor(999), {}, { revision: 2, timeMs: 100 }),
    snapshot(5, new Actor(999), {}, { revision: 2, timeMs: 99 }),
  ]) {
    assert.equal(view.capture(input, 1000), false);
    assert.equal(view.modelFor(source, 10).position.x, 10);
  }
  assert.equal(view.capture(snapshot(5, new Actor(20), {}, { revision: 2, timeMs: 100 }), 10), true);
  close(view.sample('actor', 0, 60).position.x, 15);
});

test('새 revision은 명시적 reset/load/rollback을 요구하고 뒤로 간 simulation time은 허용한다', () => {
  for (const mode of ['reset', 'load', 'rollback']) {
    const view = runtime(); view.capture(snapshot(0, new Actor(0)), 0);
    view.capture(snapshot(1, new Actor(10)), 100);
    assert.throws(() => view.capture(snapshot(0, new Actor(50), {}, { revision: 1 }), 200), RangeError);
    assert.throws(() => view.capture(snapshot(2, new Actor(50), {}, { mode }), 200), RangeError);
    assert.equal(view.capture(snapshot(0, new Actor(50), {
      initialSource: new Actor(-100), resetFields: ['position.y'],
    }, { revision: 1, mode, timeMs: -100 }), 150), true);
    const model = view.sample('actor', 0, 150);
    assert.equal(model.position.x, 50); assert.equal(model.position.y, 100);
    assert.equal(view.capture(snapshot(99, new Actor(999)), 1000), false);
    assert.equal(view.sample('actor', 0, 151), model);
  }
});

for (const mode of ['reset', 'load', 'rollback']) {
  test(`noncontinuous 세계 교체는 같은 id/generation의 이전 model도 폐기한다: ${mode}`, () => {
    const view = runtime(); view.capture(snapshot(0, new Actor()), 0);
    const previous = view.sample('actor', 0, 0);
    view.capture(snapshot(0, new Actor(50), {}, { revision: 1, mode, timeMs: -100 }), 100);
    assert.equal(view.modelFor(previous, 100), null);
    assert.equal(view.isModel(previous), false);
    const current = view.sample('actor', 0, 100);
    assert.notEqual(current, previous);
    assert.equal(current.position.x, 50);
  });
}

test('capture/sample/modelFor는 동일한 유한 단조 presentation clock을 사용한다', () => {
  const view = runtime(); const source = new Actor();
  view.capture(snapshot(0, source), 0);
  const model = view.sample('actor', 0, 10);
  assert.equal(view.sample('actor', 0, 10), model);
  assert.throws(() => view.capture(snapshot(1, new Actor(10)), 9), RangeError);
  assert.throws(() => view.sample('actor', 0, 9), RangeError);
  assert.throws(() => view.modelFor(source, 9), RangeError);
  assert.throws(() => view.modelFor(model, 9), RangeError);
  for (const now of [NaN, Infinity, -Infinity, '10']) {
    assert.throws(() => view.capture(snapshot(1, new Actor()), now), TypeError);
    assert.throws(() => view.sample('actor', 0, now), TypeError);
    assert.throws(() => view.modelFor(source, now), TypeError);
  }
  assert.equal(view.capture(snapshot(1, new Actor(10)), 10), true);
  close(view.sample('actor', 0, 60).position.x, 5);
});

test('generation과 schema type 변경은 이전 곡선을 버리고 새 model로 snap한다', () => {
  const view = runtime(); const old = new Actor();
  view.capture(snapshot(0, old), 0);
  const previous = view.sample('actor', 0, 0);
  view.capture(snapshot(1, new Actor(10)), 100);
  const current = new Actor(100);
  view.capture(snapshot(2, current, { generation: 1 }), 150);
  assert.equal(view.sample('actor', 0, 150), null);
  const model = view.sample('actor', 1, 150);
  assert.notEqual(model, previous); assert.equal(model.position.x, 100);
  assert.equal(view.modelFor(old, 150), null);
  class Other extends RenderObject { static renderSchema = { x: RenderObject.LINEAR }; }
  const replacement = new Other(); replacement.x = 9;
  view.capture(snapshot(3, replacement, { generation: 1 }), 200);
  const next = view.sample('actor', 1, 200);
  assert.notEqual(next, model); assert.deepEqual(next, { x: 9 });
});

test('전체 생존 목록에서 제거된 identity/source는 lookup과 render에서 사라진다', () => {
  const view = runtime(); const source = new Actor();
  view.capture(snapshot(0, source), 0);
  view.sample('actor', 0, 0);
  view.capture(packet(1, []), 100);
  assert.equal(view.size, 0);
  assert.equal(view.sample('actor', 0, 100), null);
  assert.equal(view.sample('missing', 0, 100), null);
  assert.equal(view.modelFor(source, 100), null);
  assert.throws(() => view.render(source, [], 100), /captured/);
  view.capture(snapshot(2, source, { generation: 1 }), 200);
  assert.equal(view.sample('actor', 0, 200), null);
  assert.equal(view.sample('actor', 1, 200).position.x, 0);
});

test('삭제된 model도 modelFor로 다시 렌더 모델로 사용할 수 없다', () => {
  const view = runtime(); const source = new Actor();
  view.capture(snapshot(0, source), 0);
  const model = view.sample('actor', 0, 0);
  view.capture(packet(1, []), 100);
  assert.equal(view.modelFor(model, 100), null);
  assert.equal(view.isModel(model), false);
});

test('generation 교체로 무효화된 model은 새 identity를 우회하지 않는다', () => {
  const view = runtime(); view.capture(snapshot(0, new Actor()), 0);
  const model = view.sample('actor', 0, 0);
  view.capture(snapshot(1, new Actor(10), { generation: 1 }), 100);
  assert.equal(view.modelFor(model, 100), null);
  assert.equal(view.isModel(model), false);
});

test('schema type 교체로 폐기된 model과 다른 runtime의 model은 등록되지 않는다', () => {
  const view = runtime(); view.capture(snapshot(0, new Actor()), 0);
  const model = view.sample('actor', 0, 0);
  class Other extends RenderObject { static renderSchema = { x: RenderObject.LINEAR }; }
  const source = new Other(); source.x = 2;
  view.capture(snapshot(1, source), 100);
  assert.equal(view.modelFor(model, 100), null);
  assert.equal(view.isModel(model), false);
  const foreign = runtime(); foreign.capture(snapshot(0, new Actor()), 0);
  const foreignModel = foreign.sample('actor', 0, 0);
  assert.equal(view.modelFor(foreignModel, 100), null);
  assert.equal(view.isModel(foreignModel), false);
});

test('선택 필드 reset은 위치 retarget을 유지하고 teleport는 initialSource보다 우선한다', () => {
  const view = runtime(); const source = new Actor(); source.flash = 1;
  view.capture(snapshot(0, source), 0);
  view.capture(snapshot(1, new Actor(10)), 100);
  const target = new Actor(20); target.angle = Math.PI;
  const resetFields = Object.freeze(['position.y', 'angle']);
  view.capture(snapshot(2, target, { resetFields }), 150);
  const model = view.sample('actor', 0, 150);
  close(model.position.x, 5); close(model.position.y, 40);
  close(model.angle, Math.PI); close(model.flash, 0.5);
  close(view.sample('actor', 0, 200).position.x, 12.5);
  view.capture(snapshot(3, new Actor(100), { teleport: true, initialSource: new Actor(-100) }), 200);
  assert.equal(view.sample('actor', 0, 200).position.x, 100);
  assert.deepEqual(resetFields, ['position.y', 'angle']);
});

test('새 identity initialSource는 private seed이고 STEP은 처음부터 최신 목표이다', () => {
  const view = runtime(); const source = new Actor(10), initialSource = new Actor();
  source.state = 'new'; initialSource.state = 'old';
  view.capture(snapshot(0, source, { initialSource }), 0);
  initialSource.position.x = 999; source.position.x = 999;
  const model = view.sample('actor', 0, 0);
  assert.equal(model.position.x, 0); assert.equal(model.state, 'new');
  close(view.sample('actor', 0, 50).position.x, 5);
  view.capture(snapshot(1, new Actor(20), { initialSource: new Actor(-100) }), 50);
  close(view.sample('actor', 0, 50).position.x, 5);
  view.capture(snapshot(2, new Actor(40), { generation: 1, initialSource: new Actor(30) }), 100);
  close(view.sample('actor', 1, 150).position.x, 35);
});

test('새 identity seed에도 resetFields를 적용해 선택 필드는 즉시 목표가 된다', () => {
  const view = runtime();
  view.capture(snapshot(0, new Actor(10), {
    initialSource: new Actor(), resetFields: ['position.y'],
  }), 0);
  const model = view.sample('actor', 0, 0);
  assert.equal(model.position.x, 0);
  assert.equal(model.position.y, 20);
  close(view.sample('actor', 0, 50).position.x, 5);
  assert.equal(model.position.y, 20);
});

test('snap이나 기존 identity에서 무시되는 seed/reset도 반드시 검증한다', () => {
  const view = runtime(); const source = new Actor(4);
  view.capture(snapshot(0, source), 0);
  for (const options of [
    { teleport: true, initialSource: { position: { x: NaN } } },
    { initialSource: { position: { x: Infinity } } },
    { teleport: true, resetFields: ['undeclared'] },
  ]) assert.throws(() => view.capture(snapshot(1, new Actor(10), options), 100));
  assert.equal(view.modelFor(source, 1).position.x, 4);
});

test('미등록/복사 원본은 fallback 없이 거부하며 render의 this와 #private를 보존한다', () => {
  class PrivateActor extends Actor {
    #label = 'private';
    render(context, model) {
      context.push({ label: this.#label, receiver: this, model });
    }
  }
  const view = runtime(); const source = new PrivateActor(3), context = [];
  assert.equal(view.modelFor(source, 0), null);
  assert.throws(() => view.render(source, context, 0), /captured/);
  assert.deepEqual(context, []);
  view.capture(snapshot(0, source), 0);
  const model = view.render(source, context, 0);
  assert.deepEqual(context, [{ label: 'private', receiver: source, model }]);
  const copied = Object.assign(Object.create(PrivateActor.prototype), source);
  assert.equal(view.modelFor(copied, 0), null);
  assert.equal(view.modelFor({ ...model }, 0), null);
  assert.throws(() => view.render(copied, context, 0), /captured/);
  assert.equal(context.length, 1);
});

test('arrow render도 실제 인스턴스의 #private와 중첩 plain model을 받는다', () => {
  class ArrowActor extends Actor {
    #offset = 7;
    render = (context, model) => { context.push([this, model.position.x + this.#offset]); };
  }
  const source = new ArrowActor(3), context = [], view = runtime();
  view.capture(snapshot(0, source), 0);
  const model = view.render(source, context, 0);
  assert.deepEqual(context, [[source, 10]]);
  assert.equal(model.position.x, 3);
  assert.equal(Object.hasOwn(model, 'render'), false);
});

for (const stepMs of [0, -1, NaN, Infinity, -Infinity, '100', undefined]) {
  test(`stepMs는 양의 유한 숫자: ${String(stepMs)}`, () => {
    assert.throws(() => new PresentationRuntime({ stepMs }));
  });
}

const predicted = (maxMs = 150, fields = ['position.x']) =>
  runtime({ extrapolation: { fields, maxMs } });
const linearSource = x => {
  const source = new Actor(); source.position.x = x; return source;
};

test('선택 LINEAR 외삽만 시뮬 표본 속도로 진행하고 maxMs 이후에는 유지한다', () => {
  const view = predicted();
  view.capture(snapshot(0, new Actor()), 0);
  view.capture(snapshot(1, new Actor(10)), 100);
  const model = view.sample('actor', 0, 100);
  for (const [now, x, y] of [[100, 0, 0], [150, 10, 10], [200, 20, 20], [250, 25, 20], [1000, 25, 20]]) {
    assert.equal(view.sample('actor', 0, now), model);
    close(model.position.x, x); close(model.position.y, y);
  }
});

test('외삽 속도는 receipt 간격 대신 simulation timeMs 차이로 계산한다', () => {
  const view = predicted(150);
  view.capture(snapshot(0, new Actor(), {}, { timeMs: 0 }), 1000);
  view.capture(snapshot(1, new Actor(10), {}, { timeMs: 50 }), 1200);
  for (const [now, x] of [[1200, 0], [1250, 15], [1300, 30], [1400, 40]]) {
    close(view.sample('actor', 0, now).position.x, x);
  }
});

test('외삽 retarget 보정은 수신 시각의 기존 예측에서 시작해 한 step 동안 줄어든다', () => {
  const view = predicted();
  view.capture(snapshot(0, new Actor()), 0);
  view.capture(snapshot(1, new Actor(10)), 100);
  close(view.sample('actor', 0, 150).position.x, 10);
  view.capture(snapshot(2, new Actor(18)), 175);
  for (const [now, x] of [[175, 15], [225, 20.5], [275, 26], [375, 30]]) {
    close(view.sample('actor', 0, now).position.x, x);
  }
});

test('timeMs가 0/반복이면 새 속도를 0으로 나누지 않고 이전 유효 속도를 유지한다', () => {
  const still = predicted();
  still.capture(snapshot(0, new Actor(), {}, { timeMs: 0 }), 0);
  still.capture(snapshot(1, new Actor(10), {}, { timeMs: 0 }), 50);
  for (const [now, x] of [[50, 0], [100, 5], [150, 10], [500, 10]]) {
    close(still.sample('actor', 0, now).position.x, x);
  }
  const moving = predicted();
  moving.capture(snapshot(0, new Actor()), 0);
  moving.capture(snapshot(1, new Actor(10)), 100);
  moving.capture(snapshot(2, new Actor(12), {}, { timeMs: 100 }), 150);
  for (const [now, x] of [[150, 10], [200, 16], [250, 22], [350, 27]]) {
    close(moving.sample('actor', 0, now).position.x, x);
  }
});

test('외삽 첫 표본은 속도가 없으며 nullable 재등장은 이전 속도를 잇지 않는다', () => {
  const view = predicted();
  const source = new Actor(10);
  view.capture(snapshot(0, source), 0);
  assert.equal(view.sample('actor', 0, 1000).position.x, 10);
  const empty = new Actor(); empty.position.x = null;
  view.capture(snapshot(1, empty), 1100);
  assert.equal(view.sample('actor', 0, 1100).position.x, null);
  view.capture(snapshot(2, new Actor(20)), 1200);
  assert.equal(view.sample('actor', 0, 1200).position.x, 20);
  assert.equal(view.sample('actor', 0, 2000).position.x, 20);
});

test('외삽 선택 필드도 새 identity의 initialSource에서 목표로 연결한다', () => {
  const view = predicted();
  view.capture(snapshot(0, new Actor(10), { initialSource: new Actor() }), 0);
  for (const [now, x] of [[0, 0], [50, 5], [100, 10], [500, 10]]) {
    close(view.sample('actor', 0, now).position.x, x);
  }
});

for (const [name, entityOptions, packetOptions] of [
  ['teleport', { teleport: true }, {}],
  ['generation', { generation: 1 }, {}],
  ['resetFields', { resetFields: ['position.x'] }, {}],
  ...['reset', 'load', 'rollback'].map(mode => [mode, {}, { revision: 1, mode, timeMs: -100 }]),
]) {
  test(`외삽의 속도/보정 이력을 초기화한다: ${name}`, () => {
    const view = predicted();
    view.capture(snapshot(0, new Actor()), 0);
    view.capture(snapshot(1, new Actor(10)), 100);
    const sequence = packetOptions.revision ? 0 : 2;
    view.capture(snapshot(sequence, new Actor(100), entityOptions, packetOptions), 150);
    const generation = entityOptions.generation ?? 0;
    for (const now of [150, 200, 500]) {
      assert.equal(view.sample('actor', generation, now).position.x, 100);
    }
    const revision = packetOptions.revision ?? 0;
    const timeMs = packetOptions.revision ? 0 : 300;
    view.capture(snapshot(sequence + 1, new Actor(110), { generation }, { revision, timeMs }), 550);
    for (const [now, x] of [[550, 100], [600, 110], [650, 120]]) {
      close(view.sample('actor', generation, now).position.x, x);
    }
    if (generation === 1) assert.equal(view.sample('actor', 0, 650), null);
  });
}

test('외삽 필드만 reset해도 선택되지 않은 위치는 수신 곡선부터 계속 연결한다', () => {
  const view = predicted();
  view.capture(snapshot(0, new Actor()), 0);
  view.capture(snapshot(1, new Actor(10)), 100);
  view.capture(snapshot(2, new Actor(100), { resetFields: ['position.x'] }), 150);
  const model = view.sample('actor', 0, 150);
  close(model.position.x, 100); close(model.position.y, 10);
  view.sample('actor', 0, 200);
  close(model.position.x, 100); close(model.position.y, 105);
  view.sample('actor', 0, 250);
  close(model.position.x, 100); close(model.position.y, 200);
});

for (const [name, code] of [
  ['ANGLE', RenderObject.ANGLE], ['STEP', RenderObject.STEP],
  ['DECAY', RenderObject.DECAY], ['CYCLE', RenderObject.CYCLE],
]) {
  test(`비 LINEAR 외삽은 첫 표본/nullable 값부터 원자적으로 거부한다: ${name}`, () => {
    class Invalid extends RenderObject { static renderSchema = { x: code }; }
    class Linear extends RenderObject { static renderSchema = { x: RenderObject.LINEAR }; }
    for (const x of [null, 1]) {
      const view = predicted(100, ['x']);
      const source = new Invalid(); source.x = x;
      assert.throws(() => view.capture(snapshot(0, source), 1000), /LINEAR/);
      assert.equal(view.size, 0);
      const valid = new Linear(); valid.x = 0;
      assert.equal(view.capture(snapshot(0, valid), 0), true);
    }
  });
}

test('상속 LINEAR override와 복사한 외삽 fields 설정을 사용한다', () => {
  class Base extends RenderObject { static renderSchema = { x: RenderObject.ANGLE }; }
  class Linear extends Base { static renderSchema = { x: RenderObject.LINEAR }; }
  const fields = ['x'], view = predicted(150, fields);
  fields[0] = 'angle'; fields.push('position.y');
  const first = new Linear(); first.x = 0;
  const second = new Linear(); second.x = 10;
  view.capture(snapshot(0, first), 0);
  view.capture(snapshot(1, second), 100);
  close(view.sample('actor', 0, 250).x, 25);
});

for (const [name, options] of [
  ['fields 형식', { fields: 'position.x', maxMs: 100 }],
  ['fields 중복', { fields: ['position.x', 'position.x'], maxMs: 100 }],
  ['fields 숫자', { fields: [1], maxMs: 100 }],
  ['fields sparse', { fields: new Array(1), maxMs: 100 }],
  ...[0, -1, NaN, Infinity, -Infinity, '100', undefined].map(maxMs => [
    `maxMs ${String(maxMs)}`, { fields: ['position.x'], maxMs },
  ]),
]) {
  test(`외삽 설정 검증: ${name}`, () => {
    assert.throws(() => runtime({ extrapolation: options }));
  });
}

test('외삽 velocity overflow snapshot을 거부해 이전 source/순서/시계를 유지한다', () => {
  const view = predicted(), source = linearSource(0);
  view.capture(snapshot(0, source, {}, { timeMs: 0 }), 0);
  const model = view.sample('actor', 0, 0);
  assert.throws(() => view.capture(snapshot(1, linearSource(1), {}, { timeMs: Number.MIN_VALUE }), 100), /overflow/);
  assert.equal(view.modelFor(source, 50), model);
  assert.equal(model.position.x, 0);
  assert.equal(view.capture(snapshot(1, linearSource(1)), 50), true);
});

test('외삽 correction overflow도 원자적으로 거부한다', () => {
  const view = predicted(), source = linearSource(-1e308);
  view.capture(snapshot(0, source, {}, { timeMs: 0 }), 0);
  const model = view.sample('actor', 0, 0);
  assert.throws(() => view.capture(snapshot(1, linearSource(1e308), {}, { timeMs: 0 }), 100), /overflow/);
  assert.equal(view.modelFor(source, 50), model);
  assert.equal(model.position.x, -1e308);
  assert.equal(view.capture(snapshot(1, linearSource(-1e308), {}, { timeMs: 0 }), 50), true);
});

test('두 번째 entity의 외삽 overflow는 첫 entity 교체도 반영하지 않는다', () => {
  const view = predicted(), first = linearSource(0), second = linearSource(0);
  view.capture(packet(0, [entity(first), entity(second, { id: 'other' })]), 0);
  const model = view.sample('actor', 0, 0), otherModel = view.sample('other', 0, 0);
  const replacement = linearSource(0);
  assert.throws(() => view.capture(packet(1, [
    entity(replacement), entity(linearSource(1), { id: 'other' }),
  ], { timeMs: Number.MIN_VALUE }), 100), /overflow/);
  assert.equal(view.size, 2);
  assert.equal(view.modelFor(first, 50), model);
  assert.equal(view.modelFor(second, 50), otherModel);
  assert.equal(view.modelFor(replacement, 50), null);
  assert.equal(view.capture(packet(1, [entity(linearSource(1)), entity(linearSource(2), { id: 'other' })]), 50), true);
});

for (const method of ['sample', 'modelFor', 'render']) {
  test(`외삽 평가 overflow는 모델/성공 호출 clock을 유지한다: ${method}`, () => {
    const view = predicted(), source = linearSource(1e308);
    view.capture(snapshot(0, linearSource(0)), 0);
    view.capture(snapshot(1, source, {}, { timeMs: 1 }), 1);
    const model = view.sample('actor', 0, 1);
    assert.equal(model.position.x, 0);
    const context = [];
    const evaluate = now => method === 'sample' ? view.sample('actor', 0, now)
      : method === 'modelFor' ? view.modelFor(source, now) : view.render(source, context, now);
    assert.throws(() => evaluate(3), /overflow/);
    assert.equal(model.position.x, 0);
    assert.deepEqual(context, []);
    assert.equal(view.sample('actor', 0, 1), model);
    assert.ok(Number.isFinite(view.sample('actor', 0, 1.5).position.x));
  });
}

test('capture 중 이전 외삽 곡선의 overflow도 snapshot과 clock을 유지한다', () => {
  const view = predicted(), source = linearSource(1e308);
  view.capture(snapshot(0, linearSource(0)), 0);
  view.capture(snapshot(1, source, {}, { timeMs: 1 }), 1);
  const model = view.sample('actor', 0, 1);
  assert.throws(() => view.capture(snapshot(2, linearSource(1), {}, { timeMs: 2 }), 3), /overflow/);
  assert.equal(view.modelFor(source, 1), model);
  assert.equal(model.position.x, 0);
  assert.equal(view.capture(snapshot(2, linearSource(1), {}, { timeMs: 2 }), 1), true);
});

test('큰 유한 목표의 외삽 보정도 수신 순간 기존 표시값을 정확히 유지한다', () => {
  const view = predicted();
  view.capture(snapshot(0, linearSource(1)), 0);
  view.capture(snapshot(1, linearSource(1e20)), 100);
  assert.equal(view.sample('actor', 0, 100).position.x, 1);
});

test('유한 simulation timeMs 극값의 차가 overflow해도 유한 속도를 잃지 않는다', () => {
  const view = predicted(1e308);
  view.capture(snapshot(0, linearSource(0), {}, { timeMs: -1e308 }), 0);
  view.capture(snapshot(1, linearSource(1e308), {}, { timeMs: 1e308 }), 100);
  const x = view.sample('actor', 0, 1e308).position.x;
  assert.ok(Number.isFinite(x));
  close(x / 1e308, 1.5);
});

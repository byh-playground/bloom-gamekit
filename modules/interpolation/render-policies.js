import { RenderObject as R } from './render-object.js';

const kinds = ['number', 'angle', 'discrete', 'number', 'cycle', 'number', 'number', 'discrete',
  'number', 'number', 'number', 'number', 'number', 'number', 'number'];

export function fieldKind(code) { return kinds[code]; }
export function isLinearField(code) {
  return code === R.LINEAR || code >= R.POSITION_X && code <= R.SPAWN_LINEAR;
}

/** 필드 이름을 검사하지 않습니다. 선언된 코드와 부모 경로만 컴파일합니다. */
export function compileFieldPolicies(root, fields) {
  function descendants(node) {
    node.fields = node.field === undefined ? [] : [node.field];
    for (const child of node.children.values()) node.fields.push(...descendants(child));
    return node.fields;
  }
  descendants(root);
  const keys = [], clocks = [], positions = new Array(3), origins = new Array(3), births = [];
  for (let index = 0; index < fields.length; index++) {
    const field = fields[index];
    if (field.code === R.STATE_KEY) keys.push({ index, scope: field.owner.fields });
    if (field.code === R.COUNTDOWN_MS || field.code === R.COUNTDOWN_SECONDS) clocks.push({
      index, scope: field.owner.fields, unitsPerMs: field.code === R.COUNTDOWN_MS ? 1 : .001,
    });
    if (field.code >= R.POSITION_X && field.code <= R.POSITION_Z) {
      const axis = field.code - R.POSITION_X;
      if (positions[axis] !== undefined) throw new TypeError('Duplicate render position axis');
      positions[axis] = index;
    }
    if (field.code >= R.ORIGIN_X && field.code <= R.ORIGIN_Z) {
      const axis = field.code - R.ORIGIN_X;
      if (origins[axis] !== undefined) throw new TypeError('Duplicate render origin axis');
      origins[axis] = index;
    }
    if (field.code === R.SPAWN_LINEAR) births.push(index);
  }
  return { keys, clocks, positions, origins, births };
}

/** STATE_KEY 전환과 countdown 재시작은 부모 범위만 새 표본으로 연결합니다. */
export function inferFieldResets(policies, previous, target, timeMs, reset) {
  for (const key of policies.keys) if (!Object.is(previous.target.values[key.index], target.values[key.index])) {
    for (const index of key.scope) reset.add(index);
  }
  const elapsed = timeMs - previous.timeMs;
  for (const clock of policies.clocks) {
    const from = previous.target.values[clock.index], to = target.values[clock.index];
    if (typeof from !== 'number' || typeof to !== 'number') continue;
    const passed = Number.isFinite(elapsed) ? elapsed * clock.unitsPerMs
      : timeMs * clock.unitsPerMs - previous.timeMs * clock.unitsPerMs;
    const expected = Math.max(0, from - passed);
    const tolerance = 1e-6 * clock.unitsPerMs
      + Number.EPSILON * 16 * Math.max(1, from, to)
      + Number.EPSILON * 16 * Math.max(Math.abs(timeMs), Math.abs(previous.timeMs)) * clock.unitsPerMs;
    if (Math.abs(to - expected) > tolerance) for (const index of clock.scope) reset.add(index);
  }
}

/** 설정한 위치 축만 사용합니다. x/y/z 같은 소스 필드명을 추측하지 않습니다. */
export function positionDiscontinuity(policies, previous, target, distance) {
  if (distance === undefined) return false;
  let count = 0, a = 0, b = 0, c = 0;
  for (let axis = 0; axis < 3; axis++) {
    const index = policies.positions[axis];
    if (index === undefined) continue;
    const from = previous.target.values[index], to = target.values[index];
    if (typeof from !== 'number' || typeof to !== 'number') continue;
    const delta = to - from;
    if (axis === 0) a = delta; else if (axis === 1) b = delta; else c = delta;
    count++;
  }
  return count > 0 && Math.hypot(a, b, c) > distance;
}

/** 새 identity의 시작점/0 seed도 필드 역할로만 결정합니다. */
export function seedFieldValues(policies, values) {
  const from = values.slice();
  for (let axis = 0; axis < 3; axis++) {
    const position = policies.positions[axis], origin = policies.origins[axis];
    if (position !== undefined && origin !== undefined && typeof values[position] === 'number' && typeof values[origin] === 'number') from[position] = values[origin];
  }
  for (const index of policies.births) if (typeof values[index] === 'number') from[index] = 0;
  return from;
}

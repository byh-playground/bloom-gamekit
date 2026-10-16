// modules/interpolation/intervals.js
function bufferInterval(track, old, { origin, timeMs, previousTimeMs, stepMs, delayMs, continuous, seeded, initialTimeMs, reset }) {
  const start = continuous ? previousTimeMs : seeded ? initialTimeMs ?? timeMs - stepMs : timeMs;
  if (!Number.isFinite(start) || start > timeMs) throw new RangeError("initialTimeMs must be finite and <= timeMs");
  track.startedAt = track.at = origin + start;
  track.durationMs = timeMs - start;
  track.bornAt = continuous ? old.bornAt : reset ? origin + timeMs - delayMs : origin + start;
  track.removedAt = Infinity;
  track.buffered = true;
  const history = continuous ? [...old.history ?? [], old] : [];
  track.history = history.slice(-Math.ceil(delayMs / stepMs) - 2).map(({ history: history2, ...item }) => item);
  return start;
}
function intervalAt(track, at) {
  if (!track || at < track.bornAt || at >= track.removedAt) return null;
  if (at >= track.startedAt) return track;
  return track.history.find((item) => at <= item.startedAt + item.durationMs) ?? track.history.at(-1) ?? track;
}
function retainRemoved(next, previous, { origin, timeMs, nowMs, delayMs }) {
  if (!delayMs) return;
  for (const [id, old] of previous) if (!next.has(id)) {
    const removedAt = Number.isFinite(old.removedAt) ? old.removedAt : origin + timeMs;
    if (nowMs - delayMs < removedAt) next.set(id, { ...old, removedAt });
  }
}

// modules/interpolation/schema.js
function compileSchema(schema) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) throw new TypeError("schema must be an object");
  const fields = Object.entries(schema);
  if (!fields.length) throw new TypeError("schema must declare at least one field");
  for (const [name, kind] of fields) {
    if (["__proto__", "prototype", "constructor"].includes(name)) throw new TypeError("unsafe field name");
    if (!["number", "angle", "discrete"].includes(kind)) throw new TypeError(`unknown kind: ${kind}`);
  }
  return fields;
}
function finite(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new TypeError(`${label} must be finite`);
  return value;
}
function ordinal(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${label} must be a nonnegative safe integer`);
  return value;
}
function readValues(fields, values) {
  if (!values || typeof values !== "object" || Array.isArray(values)) throw new TypeError("values must be an object");
  return fields.map(([name, kind]) => {
    if (!Object.hasOwn(values, name)) throw new TypeError(`missing field: ${name}; sparse patches are not supported`);
    const value = values[name];
    if (kind !== "discrete") return finite(value, name);
    if (value !== null && !["string", "boolean", "number"].includes(typeof value)) throw new TypeError(`${name} must be a scalar`);
    if (typeof value === "number") finite(value, name);
    return value;
  });
}
function readResetFields(indices, names) {
  if (names === void 0) return null;
  if (!Array.isArray(names)) throw new TypeError("resetFields must be an array");
  const reset = /* @__PURE__ */ new Set();
  for (const name of names) {
    if (typeof name !== "string" || !indices.has(name)) throw new TypeError("resetFields must name declared fields");
    const index = indices.get(name);
    if (reset.has(index)) throw new TypeError("duplicate resetFields field");
    reset.add(index);
  }
  return reset;
}

// modules/interpolation/tracks.js
var TAU = Math.PI * 2;
function wrap(angle) {
  const value = angle % TAU;
  const positive = value < 0 ? value + TAU : value;
  return positive >= TAU || positive === 0 ? 0 : positive;
}
function evaluate(kind, from, to, alpha) {
  if (kind === "discrete") return to;
  if (alpha === 1) return kind === "angle" ? wrap(to) : to;
  if (alpha === 0) return kind === "angle" ? wrap(from) : from;
  if (kind === "angle") {
    const start = wrap(from);
    let delta = wrap(to) - start;
    if (Math.abs(Math.abs(delta) - Math.PI) <= Number.EPSILON * TAU) delta = -Math.PI;
    else if (delta > Math.PI) delta -= TAU;
    else if (delta < -Math.PI) delta += TAU;
    return wrap(start + delta * alpha);
  }
  return Math.sign(from) === Math.sign(to) ? from + (to - from) * alpha : from * (1 - alpha) + to * alpha;
}
function fraction(track, now, stepMs) {
  return Math.min(1, Math.max(0, (now - track.startedAt) / stepMs));
}
function retarget(fields, old, target, generation, now, stepMs, snap, initial, resetFields) {
  const continued = old && old.generation === generation;
  const from = !continued && !snap && initial ? initial : target.slice();
  if (continued && !snap) {
    const alpha = fraction(old, now, stepMs);
    for (let i = 0; i < fields.length; i++) from[i] = evaluate(fields[i][1], old.from[i], old.target[i], alpha);
  }
  if (resetFields) for (const index of resetFields) from[index] = target[index];
  return { generation, from, target, startedAt: now };
}

// modules/interpolation/timeline.js
var InterpolationTimeline = class {
  #fields;
  #fieldIndices;
  #stepMs;
  #tracks = /* @__PURE__ */ new Map();
  #now = -Infinity;
  #delayMs;
  #origin = 0;
  #revision = -1;
  #sequence = -1;
  #timeMs = -Infinity;
  /** @param {{schema:import('./schema.js').Schema, stepMs:number,delayMs?:number}} options */
  constructor({ schema, stepMs, delayMs = 0 }) {
    this.#fields = compileSchema(schema);
    this.#fieldIndices = new Map(this.#fields.map((field, index) => [field[0], index]));
    this.#stepMs = finite(stepMs, "stepMs");
    if (stepMs <= 0) throw new RangeError("stepMs must be positive");
    this.#delayMs = finite(delayMs, "delayMs");
    if (delayMs < 0 || delayMs > stepMs * 16) throw new RangeError("delayMs must be between 0 and 16 steps");
  }
  get size() {
    return this.#tracks.size;
  }
  #checkClock(nowMs) {
    finite(nowMs, "nowMs");
    if (nowMs < this.#now) throw new RangeError("presentation clock must not go backwards");
  }
  /**
   * Accept one complete authoritative snapshot. Returns false for obsolete packets.
   * Invalid packets throw without changing tracks, revision, or presentation time.
   * timeMs is simulation time; nowMs is local receipt time. delayMs establishes a per-revision clock mapping.
   * resetFields snaps only named fields. initialValues seeds new identities in continuous mode.
   * Explicit teleport/reset/load/rollback overrides seeds; all supplied options are validated.
   * @param {Snapshot} packet @param {number} nowMs @returns {boolean}
   */
  accept(packet, nowMs) {
    this.#checkClock(nowMs);
    if (!packet || typeof packet !== "object") throw new TypeError("packet must be an object");
    const revision = ordinal(packet.revision, "revision");
    const sequence = ordinal(packet.sequence, "sequence");
    const timeMs = finite(packet.timeMs, "timeMs");
    const mode = packet.mode ?? "continuous";
    if (!["continuous", "reset", "load", "rollback"].includes(mode)) throw new TypeError("unknown snapshot mode");
    if (revision < this.#revision || revision === this.#revision && sequence <= this.#sequence) return false;
    const changedRevision = revision !== this.#revision;
    if (this.#revision !== -1 && changedRevision && mode === "continuous") throw new RangeError("new revision requires reset, load or rollback");
    if (!changedRevision && mode !== "continuous") throw new RangeError("reset, load and rollback require a newer revision");
    if (!changedRevision && timeMs < this.#timeMs) return false;
    if (!Array.isArray(packet.entities)) throw new TypeError("entities must be an array");
    const next = /* @__PURE__ */ new Map();
    const origin = changedRevision ? nowMs - timeMs : this.#origin;
    for (const entity of packet.entities) {
      if (!entity || typeof entity.id !== "string" || !entity.id.length) throw new TypeError("id must be a nonempty string");
      if (next.has(entity.id)) throw new TypeError("duplicate entity id");
      const generation = ordinal(entity.generation, "generation");
      if (entity.teleport !== void 0 && typeof entity.teleport !== "boolean") throw new TypeError("teleport must be boolean");
      const target = readValues(this.#fields, entity.values);
      const initial = entity.initialValues === void 0 ? null : readValues(this.#fields, entity.initialValues);
      const resetFields = readResetFields(this.#fieldIndices, entity.resetFields);
      const old = this.#tracks.get(entity.id);
      const snap = mode !== "continuous" || entity.teleport === true;
      const track = retarget(this.#fields, old, target, generation, nowMs, this.#stepMs, snap, initial, resetFields);
      if (this.#delayMs > 0) {
        const continued = old && old.generation === generation && !snap && !changedRevision && !Number.isFinite(old.removedAt);
        if (continued) {
          track.from = old.target.slice();
          if (resetFields) for (const i of resetFields) track.from[i] = target[i];
        }
        bufferInterval(track, old, {
          origin,
          timeMs,
          previousTimeMs: this.#timeMs,
          stepMs: this.#stepMs,
          delayMs: this.#delayMs,
          continuous: continued,
          reset: snap,
          seeded: !!initial && !snap,
          initialTimeMs: entity.initialTimeMs
        });
      }
      next.set(entity.id, track);
    }
    if (!changedRevision && mode === "continuous") retainRemoved(next, this.#tracks, { origin, timeMs, nowMs, delayMs: this.#delayMs });
    this.#tracks = next;
    this.#origin = origin;
    this.#revision = revision;
    this.#sequence = sequence;
    this.#timeMs = timeMs;
    this.#now = nowMs;
    return true;
  }
  /**
   * Write declared fields into a caller-owned reusable object; no pose allocation.
   * Returns false for absent identities and leaves out untouched.
   * Supply the same nowMs for camera, body, shadow, and every entity in a frame.
   * @param {string} id @param {number} generation @param {number} nowMs
   * @param {Record<string,number|string|boolean|null>} out @returns {boolean}
   */
  sampleInto(id, generation, nowMs, out) {
    this.#checkClock(nowMs);
    if (!out || typeof out !== "object") throw new TypeError("out must be a writable object");
    let track = this.#tracks.get(id);
    this.#now = nowMs;
    if (!track || track.generation !== generation) return false;
    const sampleAt = nowMs - this.#delayMs;
    if (this.#delayMs > 0) {
      track = intervalAt(track, sampleAt);
      if (!track) return false;
    }
    const alpha = track.durationMs === 0 ? 1 : fraction(track, sampleAt, track.durationMs ?? this.#stepMs);
    for (let i = 0; i < this.#fields.length; i++) {
      const field = this.#fields[i];
      out[field[0]] = this.#delayMs > 0 && field[1] === "discrete" && alpha < 1 ? track.from[i] : evaluate(field[1], track.from[i], track.target[i], alpha);
    }
    return true;
  }
};

// modules/interpolation/render-object.js
var RenderObject = class {
  static LINEAR = 0;
  static ANGLE = 1;
  static STEP = 2;
  // 타격 flash처럼 값이 증가하면 새 표현으로 즉시 시작합니다.
  static DECAY = 3;
  // 0..1 진행률이 1에서 0으로 순환하는 필드. 종료 때 역방향 보간하지 않습니다.
  static CYCLE = 4;
  static COUNTDOWN_MS = 5;
  static COUNTDOWN_SECONDS = 6;
  // 해당 필드의 부모 객체가 어떤 표시 상태인지 구분하는 scalar 키입니다.
  static STATE_KEY = 7;
  static POSITION_X = 8;
  static POSITION_Y = 9;
  static POSITION_Z = 10;
  static ORIGIN_X = 11;
  static ORIGIN_Y = 12;
  static ORIGIN_Z = 13;
  static SPAWN_LINEAR = 14;
  /** Optional bounded world-space path: {x:'x',y:'y',durationMs:400,maxPoints:64}.
   * Position fields must be declared. Shape/attachments remain game-owned. */
  static renderPath = null;
  static renderSchema = Object.freeze({});
  /** @param {unknown} context @param {object} model */
  render(context, model) {
    throw new Error("RenderObject 하위 타입은 render(context, model)을 구현해야 합니다.");
  }
};

// modules/interpolation/path.js
function pathPlan(declaration, indices) {
  if (!declaration) return null;
  const x = indices.get(declaration.x), y = indices.get(declaration.y), durationMs = finite(declaration.durationMs, "renderPath.durationMs");
  const maxPoints = declaration.maxPoints ?? 64;
  if (x === void 0 || y === void 0 || durationMs <= 0 || !Number.isSafeInteger(maxPoints) || maxPoints < 2 || maxPoints > 4096) throw new TypeError("invalid renderPath");
  return { x, y, durationMs, maxPoints };
}
function capturePath(plan, old, from, target, startMs, timeMs, points, reset, delayMs, stepMs) {
  if (!plan) return null;
  const path = reset ? [] : (old ?? []).slice();
  const add = (timeMs2, x, y) => {
    finite(timeMs2, "path timeMs");
    finite(x, "path x");
    finite(y, "path y");
    if (path.length && timeMs2 < path.at(-1).timeMs) throw new RangeError("path points must be ordered");
    if (path.length && timeMs2 === path.at(-1).timeMs) path[path.length - 1] = { timeMs: timeMs2, x, y };
    else path.push({ timeMs: timeMs2, x, y });
  };
  if (!path.length) add(startMs, from[plan.x], from[plan.y]);
  if (points !== void 0) {
    if (!Array.isArray(points)) throw new TypeError("pathPoints must be an array");
    for (const point of points) {
      if (point.timeMs < startMs || point.timeMs > timeMs) throw new RangeError("pathPoints must be inside this capture interval");
      add(point.timeMs, point.x, point.y);
    }
  }
  add(timeMs, target[plan.x], target[plan.y]);
  const floor = timeMs - plan.durationMs - delayMs - stepMs;
  while (path.length > 2 && path[1].timeMs < floor) path.shift();
  return path.slice(-plan.maxPoints);
}
function pointAt(path, timeMs, out) {
  if (!path?.length) return false;
  let a = path[0], b = a;
  for (let i = 1; i < path.length; i++) {
    b = path[i];
    if (timeMs <= b.timeMs) break;
    a = b;
  }
  const t = b.timeMs === a.timeMs ? 1 : Math.max(0, Math.min(1, (timeMs - a.timeMs) / (b.timeMs - a.timeMs)));
  out.timeMs = Math.max(path[0].timeMs, Math.min(timeMs, path.at(-1).timeMs));
  out.x = a.x + (b.x - a.x) * t;
  out.y = a.y + (b.y - a.y) * t;
  return true;
}
function samplePath(path, timeMs, durationMs, out) {
  let count = 0;
  const write = (point) => {
    const item = out[count] ?? (out[count] = {});
    Object.assign(item, point);
    count++;
  };
  const head = {};
  if (!pointAt(path, timeMs, head)) {
    out.length = 0;
    return out;
  }
  const floor = Math.max(path[0].timeMs, head.timeMs - durationMs), tail = {};
  pointAt(path, floor, tail);
  write(tail);
  for (const point of path) if (point.timeMs > floor && point.timeMs < head.timeMs) write(point);
  if (head.timeMs > floor) write(head);
  out.length = count;
  return out;
}

// modules/interpolation/render-policies.js
var kinds = [
  "number",
  "angle",
  "discrete",
  "number",
  "cycle",
  "number",
  "number",
  "discrete",
  "number",
  "number",
  "number",
  "number",
  "number",
  "number",
  "number"
];
function fieldKind(code) {
  return kinds[code];
}
function isLinearField(code) {
  return code === RenderObject.LINEAR || code >= RenderObject.POSITION_X && code <= RenderObject.SPAWN_LINEAR;
}
function compileFieldPolicies(root, fields) {
  function descendants(node) {
    node.fields = node.field === void 0 ? [] : [node.field];
    for (const child of node.children.values()) node.fields.push(...descendants(child));
    return node.fields;
  }
  descendants(root);
  const keys = [], clocks = [], positions = new Array(3), origins = new Array(3), births = [];
  for (let index = 0; index < fields.length; index++) {
    const field = fields[index];
    if (field.code === RenderObject.STATE_KEY) keys.push({ index, scope: field.owner.fields });
    if (field.code === RenderObject.COUNTDOWN_MS || field.code === RenderObject.COUNTDOWN_SECONDS) clocks.push({
      index,
      scope: field.owner.fields,
      unitsPerMs: field.code === RenderObject.COUNTDOWN_MS ? 1 : 1e-3
    });
    if (field.code >= RenderObject.POSITION_X && field.code <= RenderObject.POSITION_Z) {
      const axis = field.code - RenderObject.POSITION_X;
      if (positions[axis] !== void 0) throw new TypeError("Duplicate render position axis");
      positions[axis] = index;
    }
    if (field.code >= RenderObject.ORIGIN_X && field.code <= RenderObject.ORIGIN_Z) {
      const axis = field.code - RenderObject.ORIGIN_X;
      if (origins[axis] !== void 0) throw new TypeError("Duplicate render origin axis");
      origins[axis] = index;
    }
    if (field.code === RenderObject.SPAWN_LINEAR) births.push(index);
  }
  return { keys, clocks, positions, origins, births };
}
function inferStateResets(policies, previous, target, reset) {
  for (const key of policies.keys) if (!Object.is(previous.values[key.index], target.values[key.index])) {
    for (const index of key.scope) reset.add(index);
  }
}
function inferFieldResets(policies, previous, target, timeMs, reset) {
  inferStateResets(policies, previous.target, target, reset);
  const elapsed = timeMs - previous.timeMs;
  for (const clock of policies.clocks) {
    const from = previous.target.values[clock.index], to = target.values[clock.index];
    if (typeof from !== "number" || typeof to !== "number") continue;
    const passed = Number.isFinite(elapsed) ? elapsed * clock.unitsPerMs : timeMs * clock.unitsPerMs - previous.timeMs * clock.unitsPerMs;
    const expected = Math.max(0, from - passed);
    const tolerance = 1e-6 * clock.unitsPerMs + Number.EPSILON * 16 * Math.max(1, from, to) + Number.EPSILON * 16 * Math.max(Math.abs(timeMs), Math.abs(previous.timeMs)) * clock.unitsPerMs;
    if (Math.abs(to - expected) > tolerance) for (const index of clock.scope) reset.add(index);
  }
}
function positionDiscontinuity(policies, previous, target, distance) {
  if (distance === void 0) return false;
  let count = 0, a = 0, b = 0, c = 0;
  for (let axis = 0; axis < 3; axis++) {
    const index = policies.positions[axis];
    if (index === void 0) continue;
    const from = previous.target.values[index], to = target.values[index];
    if (typeof from !== "number" || typeof to !== "number") continue;
    const delta = to - from;
    if (axis === 0) a = delta;
    else if (axis === 1) b = delta;
    else c = delta;
    count++;
  }
  return count > 0 && Math.hypot(a, b, c) > distance;
}
function seedFieldValues(policies, values) {
  const from = values.slice();
  for (let axis = 0; axis < 3; axis++) {
    const position = policies.positions[axis], origin = policies.origins[axis];
    if (position !== void 0 && origin !== void 0 && typeof values[position] === "number" && typeof values[origin] === "number") from[position] = values[origin];
  }
  for (const index of policies.births) if (typeof values[index] === "number") from[index] = 0;
  return from;
}

// modules/interpolation/render-schema.js
var unsafe = /* @__PURE__ */ new Set(["__proto__", "prototype", "constructor"]);
var cache = /* @__PURE__ */ new WeakMap();
var arrayKey = /^(0|[1-9][0-9]*)$/;
function copyRenderData(value, seen = /* @__PURE__ */ new Set()) {
  if (value === null || value === void 0 || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "object" || !Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    throw new TypeError("Render STEP requires finite scalar or plain data");
  }
  if (seen.has(value)) throw new TypeError("Render STEP cannot contain cycles; use an entity ID");
  seen.add(value);
  const result = Array.isArray(value) ? new Array(value.length) : {};
  for (const key of Object.keys(value)) {
    if (unsafe.has(key)) throw new TypeError("Unsafe render data key: " + key);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!Object.hasOwn(descriptor, "value")) throw new TypeError("Render data accessors are not supported");
    result[key] = copyRenderData(descriptor.value, seen);
  }
  seen.delete(value);
  return result;
}
function dataAt(source, key) {
  const descriptor = Object.getOwnPropertyDescriptor(source, key);
  if (!descriptor) return void 0;
  if (!Object.hasOwn(descriptor, "value")) throw new TypeError("Render fields must be data properties: " + key);
  return descriptor.value;
}
function compileRenderSchema(type) {
  if (typeof type !== "function" || type !== RenderObject && !(type.prototype instanceof RenderObject)) {
    throw new TypeError("Render type must extend RenderObject");
  }
  if (cache.has(type)) return cache.get(type);
  const merged = {};
  const chain = [];
  for (let current = type; current && current !== Function.prototype; current = Object.getPrototypeOf(current)) chain.unshift(current);
  for (const current of chain) {
    if (!Object.hasOwn(current, "renderSchema")) continue;
    const declaration = Object.getOwnPropertyDescriptor(current, "renderSchema");
    if (!Object.hasOwn(declaration, "value")) throw new TypeError("renderSchema cannot be an accessor");
    const schema = declaration.value;
    if (!schema || typeof schema !== "object" || Array.isArray(schema)) throw new TypeError("renderSchema must be a field-path map");
    for (const name of Object.keys(schema)) {
      const descriptor = Object.getOwnPropertyDescriptor(schema, name);
      if (!Object.hasOwn(descriptor, "value")) throw new TypeError("renderSchema cannot contain accessors");
      Object.defineProperty(merged, name, { value: descriptor.value, enumerable: true, configurable: true });
    }
  }
  const fields = [], nodes = [], indices = /* @__PURE__ */ new Map(), root = { children: /* @__PURE__ */ new Map() };
  for (const [name, code] of Object.entries(merged)) {
    const path2 = name.split(".");
    if (path2.some((key) => !key || unsafe.has(key))) throw new TypeError("Unsafe or empty render path: " + name);
    if (!Number.isInteger(code) || !fieldKind(code)) throw new TypeError("Unknown render interpolation: " + name);
    let node = root;
    for (const key of path2) {
      if (node.field !== void 0) throw new TypeError("Overlapping render paths: " + name);
      if (!node.children.has(key)) {
        const child = { key, children: /* @__PURE__ */ new Map(), index: nodes.length, parent: node };
        node.children.set(key, child);
        nodes.push(child);
      }
      node = node.children.get(key);
    }
    if (node.children.size) throw new TypeError("Overlapping render paths: " + name);
    node.field = fields.length;
    indices.set(name, fields.length);
    fields.push(Object.freeze({ name, code, kind: fieldKind(code), path: Object.freeze(path2), owner: node.parent }));
  }
  if (!fields.length) throw new TypeError("renderSchema must declare at least one field");
  const policies = compileFieldPolicies(root, fields);
  const path = pathPlan(type.renderPath, indices);
  const plan = { path, fields: Object.freeze(fields), indices, root, nodes, policies };
  cache.set(type, plan);
  return plan;
}
function captureRenderData(plan, source) {
  if (!source || typeof source !== "object") throw new TypeError("Render source must be an object");
  const values = new Array(plan.fields.length), shapes = new Array(plan.nodes.length);
  function visit(node, value) {
    if (node.field !== void 0) {
      const field = plan.fields[node.field];
      if (value == null) values[node.field] = value;
      else if (field.kind === "discrete") {
        if (field.code === RenderObject.STATE_KEY && !["number", "boolean", "string"].includes(typeof value)) throw new TypeError("STATE_KEY requires a scalar: " + field.name);
        values[node.field] = copyRenderData(value);
      } else {
        if (typeof value !== "number" || !Number.isFinite(value)) throw new TypeError("Render field must be finite: " + field.name);
        if (field.code === RenderObject.CYCLE && (value < 0 || value > 1)) throw new RangeError("Render CYCLE requires 0..1: " + field.name);
        if ((field.code === RenderObject.COUNTDOWN_MS || field.code === RenderObject.COUNTDOWN_SECONDS) && value < 0) throw new RangeError("Render countdown must be nonnegative: " + field.name);
        values[node.field] = value;
      }
      return;
    }
    if (value == null) {
      shapes[node.index] = value;
      return;
    }
    if (typeof value !== "object") throw new TypeError("Render parent must be an object: " + node.key);
    shapes[node.index] = Array.isArray(value) ? value.length : -1;
    for (const child of node.children.values()) {
      if (Array.isArray(value) && child.key === "length") throw new TypeError("Array length belongs to render structure, not a field");
      visit(child, dataAt(value, child.key));
    }
  }
  for (const node of plan.root.children.values()) visit(node, dataAt(source, node.key));
  return { values, shapes };
}
function snapshotRenderModel(type, source) {
  const plan = compileRenderSchema(type), data = captureRenderData(plan, source);
  return writeRenderModel(plan, {}, data.values, data.shapes);
}
function writeRenderModel(plan, model, values, shapes) {
  function visit(parent, node) {
    const { key } = node;
    if (node.field !== void 0) {
      const value = values[node.field];
      if (value === void 0) delete parent[key];
      else parent[key] = plan.fields[node.field].kind === "discrete" ? reuseData(parent[key], value) : value;
      return;
    }
    const shape = shapes[node.index];
    if (shape === void 0) {
      delete parent[key];
      return;
    }
    if (shape === null) {
      parent[key] = null;
      return;
    }
    const array = shape >= 0;
    let target = parent[key];
    if (!target || typeof target !== "object" || Array.isArray(target) !== array) target = parent[key] = array ? [] : {};
    if (array) target.length = shape;
    for (const child of node.children.values()) {
      if (!array || !arrayKey.test(child.key) || Number(child.key) < shape) visit(target, child);
    }
  }
  for (const node of plan.root.children.values()) visit(model, node);
  return model;
}
function reuseData(out, value) {
  if (value === null || typeof value !== "object") return value;
  const array = Array.isArray(value);
  if (!out || typeof out !== "object" || Array.isArray(out) !== array) out = array ? [] : {};
  for (const key of Object.keys(out)) if (!Object.hasOwn(value, key)) delete out[key];
  if (array) out.length = value.length;
  for (const key of Object.keys(value)) out[key] = reuseData(out[key], value[key]);
  return out;
}

// modules/interpolation/presentation.js
function fraction2(track, now, stepMs) {
  return stepMs === 0 ? 1 : Math.min(1, Math.max(0, (now - track.at) / stepMs));
}
var PresentationRuntime = class {
  #stepMs;
  #tracks = /* @__PURE__ */ new Map();
  #sources = /* @__PURE__ */ new WeakMap();
  #models = /* @__PURE__ */ new WeakMap();
  #preview = /* @__PURE__ */ new Map();
  #previewSelection = /* @__PURE__ */ new Map();
  #previewSources = /* @__PURE__ */ new WeakMap();
  #now = -Infinity;
  #revision = -1;
  #sequence = -1;
  #timeMs = -Infinity;
  #previewRevision = -1;
  #previewSequence = -1;
  #previewTimeMs = -Infinity;
  #previewMetrics = { captureMs: 0, captureBytes: 0, captures: 0 };
  #extrapolation;
  #snapDistance;
  #delayMs;
  #origin = 0;
  #frameSerial = 0;
  /** @param {{stepMs:number, delayMs?:number, snapDistance?:number, extrapolation?:{fields:string[],maxMs:number}}} options */
  constructor({ stepMs, snapDistance, extrapolation, delayMs = 0 } = {}) {
    this.#stepMs = finite(stepMs, "stepMs");
    this.#delayMs = finite(delayMs, "delayMs");
    if (delayMs < 0 || delayMs > stepMs * 16) throw new RangeError("delayMs must be between 0 and 16 steps");
    if (delayMs && extrapolation) throw new TypeError("delayed authority cannot also extrapolate");
    if (stepMs <= 0) throw new RangeError("stepMs must be positive");
    if (snapDistance !== void 0 && finite(snapDistance, "snapDistance") <= 0) throw new RangeError("snapDistance must be positive");
    this.#snapDistance = snapDistance;
    if (extrapolation) {
      if (!Array.isArray(extrapolation.fields) || new Set(extrapolation.fields).size !== extrapolation.fields.length || Array.from(extrapolation.fields).some((x) => typeof x !== "string")) throw new TypeError("extrapolation.fields must be unique paths");
      if (finite(extrapolation.maxMs, "maxMs") <= 0) throw new RangeError("maxMs must be positive");
      if (extrapolation.maxMs < stepMs) throw new RangeError("maxMs must cover the correction stepMs");
      this.#extrapolation = { fields: new Set(extrapolation.fields), maxMs: extrapolation.maxMs };
    }
  }
  get size() {
    return this.#tracks.size;
  }
  get previewMetrics() {
    return { ...this.#previewMetrics };
  }
  /** Select game-owned local identities only; remote authoritative tracks remain unchanged. */
  selectPreview(identities) {
    if (!Array.isArray(identities)) throw new TypeError("preview identities must be an array");
    const next = /* @__PURE__ */ new Map();
    for (const identity of identities) {
      if (!identity || typeof identity.id !== "string" || !identity.id || !Number.isSafeInteger(identity.generation) || identity.generation < 0 || next.has(identity.id)) throw new TypeError("invalid preview identity");
      next.set(identity.id, identity.generation);
    }
    this.#frameSerial++;
    this.#previewSelection = next;
    for (const id of this.#preview.keys()) if (!next.has(id) || next.get(id) !== this.#preview.get(id).generation) this.#preview.delete(id);
  }
  clearPreview() {
    this.#frameSerial++;
    this.#preview.clear();
    this.#previewSelection.clear();
    this.#previewSources = /* @__PURE__ */ new WeakMap();
  }
  releasePreview(nowMs) {
    this.#checkClock(nowMs);
    if (this.#delayMs) {
      for (const [id, preview] of this.#preview) {
        if (preview.releaseAt !== void 0) continue;
        const track = this.#tracks.get(id);
        if (!track || track.generation !== preview.generation) continue;
        const from = preview.plan.fields.map((_, i) => this.#value(preview, i, nowMs)), reset = /* @__PURE__ */ new Set();
        inferStateResets(preview.plan.policies, preview.target, track.target, reset);
        for (const i of reset) from[i] = track.target.values[i];
        const releaseAt = Math.max(nowMs, this.#origin + track.timeMs + this.#delayMs);
        this.#preview.set(id, { ...preview, from, target: track.target, at: nowMs, durationMs: releaseAt - nowMs, releaseAt, sampledAt: -Infinity });
      }
      this.#frameSerial++;
      this.#now = nowMs;
      return;
    }
    for (const [id, preview] of this.#preview) {
      const track = this.#tracks.get(id);
      if (!track || track.generation !== preview.generation) continue;
      track.from = track.plan.fields.map((_, i) => this.#value(preview, i, nowMs));
      track.at = nowMs;
      track.sampledAt = -Infinity;
    }
    this.clearPreview();
    this.#now = nowMs;
  }
  /** Detached declared-field baselines for the next fork step; no source references retained. */
  snapshotPreview(entities) {
    return entities.map((entity) => {
      const type = entity.type ?? entity.source.constructor, plan = compileRenderSchema(type), data = captureRenderData(plan, entity.source);
      return { id: entity.id, generation: entity.generation, type, source: writeRenderModel(plan, {}, data.values, data.shapes) };
    });
  }
  /** Publish immediate schema-only local fork models. This never replaces authoritative tracks. */
  capturePreview(packet, nowMs) {
    const started = performance.now();
    let bytes = 0;
    this.#checkClock(nowMs);
    if (!packet || !Array.isArray(packet.entities)) throw new TypeError("preview packet entities");
    const revision = ordinal(packet.revision, "preview revision"), sequence = ordinal(packet.sequence, "preview sequence"), timeMs = finite(packet.timeMs, "preview timeMs");
    if (revision !== this.#revision || revision < this.#previewRevision || revision === this.#previewRevision && sequence <= this.#previewSequence || timeMs < this.#previewTimeMs) return false;
    if (timeMs < this.#now) return false;
    const next = /* @__PURE__ */ new Map(), sources = /* @__PURE__ */ new WeakMap();
    for (const entity of packet.entities) {
      if (!entity || typeof entity.id !== "string" || !entity.id || !Number.isSafeInteger(entity.generation) || entity.generation < 0 || next.has(entity.id)) throw new TypeError("invalid preview entity");
      if (this.#previewSelection.get(entity.id) !== entity.generation) continue;
      if (!entity.source || typeof entity.source !== "object") throw new TypeError("preview source required");
      const plan = compileRenderSchema(entity.type ?? entity.source.constructor), authority = this.#tracks.get(entity.id);
      if (!authority || authority.generation !== entity.generation || authority.plan !== plan) throw new TypeError("preview must match a live authoritative render identity and schema");
      const data = captureRenderData(plan, entity.source), old = this.#preview.get(entity.id);
      const initial = entity.initialSource ? captureRenderData(plan, entity.initialSource) : authority.target;
      const same = old && old.generation === entity.generation && old.plan === plan;
      const from = same ? plan.fields.map((_, i) => this.#value(old, i, nowMs)) : plan.fields.map((_, i) => this.#value(authority, i, nowMs));
      const reset = /* @__PURE__ */ new Set();
      inferStateResets(plan.policies, same ? old.target : initial, data, reset);
      for (const index of reset) from[index] = data.values[index];
      const at = same ? nowMs : Math.min(nowMs, finite(packet.phaseStartMs ?? nowMs, "phaseStartMs"));
      const end = Math.max(nowMs + 1, finite(packet.phaseStartMs ?? nowMs, "phaseStartMs") + (packet.stepMs ?? this.#stepMs));
      const model = same ? old.model : {};
      bytes += data.values.length * 8 + data.shapes.length * 4;
      writeRenderModel(plan, model, data.values, data.shapes);
      const entry = {
        id: entity.id,
        generation: entity.generation,
        plan,
        data,
        target: data,
        from,
        at,
        durationMs: end - at,
        preview: true,
        model,
        source: entity.source,
        sequence,
        sampledAt: -Infinity,
        sampleValues: same ? old.sampleValues : void 0
      };
      next.set(entity.id, entry);
      sources.set(entity.source, entry);
    }
    this.#frameSerial++;
    this.#preview = next;
    this.#previewSources = sources;
    this.#previewRevision = revision;
    this.#previewSequence = sequence;
    this.#previewTimeMs = timeMs;
    this.#now = nowMs;
    this.#previewMetrics.captureMs += performance.now() - started;
    this.#previewMetrics.captureBytes += bytes;
    this.#previewMetrics.captures++;
    return true;
  }
  isModel(value) {
    const owner = value && this.#models.get(value);
    const preview = owner && this.#preview.get(owner.id);
    if (preview?.model === value && this.#previewSelection.get(owner.id) === owner.generation) return true;
    const current = owner && this.#tracks.get(owner.id);
    return !!current && current.generation === owner.generation && current.model === value;
  }
  #checkClock(now) {
    finite(now, "nowMs");
    if (now < this.#now) throw new RangeError("presentation clock must not go backwards");
  }
  /**
   * Full authoritative snapshot. timeMs/initialTimeMs/pathPoints use simulation milliseconds.
   * delayMs buffers intervals and removal; a continuous new identity may seed its first interval
   * with initialSource at initialTimeMs (default timeMs-stepMs). Reset/rollback/teleport discard history.
   * renderPath captures endpoints automatically. Supply within-tick bends as ordered pathPoints;
   * the module cannot infer a collision/orbit curve between simulation endpoints.
   * An entity born and removed between captures is unobservable here: the game must emit
   * its timed visual event/anchors through presentation-events, not expect snapshot inference.
   * @param {{revision:number,sequence:number,timeMs:number,mode?:string,entities:Array<{id:string,generation:number,source:object,type?:typeof RenderObject,teleport?:boolean,resetFields?:string[],initialSource?:object,initialTimeMs?:number,pathPoints?:Array<{timeMs:number,x:number,y:number}>}>}} packet
   * @param {number} nowMs
   */
  capture(packet, nowMs) {
    this.#checkClock(nowMs);
    if (!packet || typeof packet !== "object") throw new TypeError("packet must be an object");
    const revision = ordinal(packet.revision, "revision"), sequence = ordinal(packet.sequence, "sequence"), timeMs = finite(packet.timeMs, "timeMs");
    const mode = packet.mode ?? "continuous";
    if (!["continuous", "reset", "load", "rollback"].includes(mode)) throw new TypeError("unknown capture mode");
    if (revision < this.#revision || revision === this.#revision && sequence <= this.#sequence) return false;
    const changed = revision !== this.#revision;
    if (this.#revision >= 0 && changed && mode === "continuous") throw new RangeError("new revision requires reset, load or rollback");
    if (!changed && mode !== "continuous") throw new RangeError("reset, load and rollback require a newer revision");
    if (!changed && timeMs < this.#timeMs) return false;
    if (!Array.isArray(packet.entities)) throw new TypeError("entities must be an array");
    const origin = changed ? nowMs - timeMs : this.#origin;
    const next = /* @__PURE__ */ new Map(), sources = /* @__PURE__ */ new WeakMap(), previews = /* @__PURE__ */ new Map(), previewSources = /* @__PURE__ */ new WeakMap();
    for (const entity of packet.entities) {
      if (!entity || typeof entity.id !== "string" || !entity.id || next.has(entity.id)) throw new TypeError("entity IDs must be nonempty and unique");
      const generation = ordinal(entity.generation, "generation"), source = entity.source;
      if (!source || typeof source !== "object" || sources.has(source)) throw new TypeError("entity sources must be unique objects");
      if (entity.teleport !== void 0 && typeof entity.teleport !== "boolean") throw new TypeError("teleport must be boolean");
      const plan = compileRenderSchema(entity.type ?? source.constructor);
      if (this.#extrapolation) for (const field of plan.fields) {
        if (this.#extrapolation.fields.has(field.name) && !isLinearField(field.code)) throw new TypeError("extrapolation requires LINEAR: " + field.name);
      }
      const target = captureRenderData(plan, source);
      const initial = entity.initialSource === void 0 ? null : captureRenderData(plan, entity.initialSource);
      const reset = /* @__PURE__ */ new Set();
      if (entity.resetFields !== void 0) {
        if (!Array.isArray(entity.resetFields)) throw new TypeError("resetFields must be an array");
        for (const name of entity.resetFields) {
          const index = plan.indices.get(name);
          if (index === void 0 || reset.has(index)) throw new TypeError("resetFields must contain unique declared paths");
          reset.add(index);
        }
      }
      const old = this.#tracks.get(entity.id), preview = this.#preview.get(entity.id);
      const same = mode === "continuous" && old && old.generation === generation && old.plan === plan && !Number.isFinite(old.removedAt);
      const snap = mode !== "continuous" || entity.teleport === true || !!same && positionDiscontinuity(plan.policies, old, target, this.#snapDistance);
      if (this.#delayMs && same && !snap && preview?.generation === generation && preview.plan === plan) {
        previews.set(entity.id, preview);
        previewSources.set(preview.source, preview);
      }
      if (same && !snap) inferFieldResets(plan.policies, old, target, timeMs, reset);
      const from = same && !snap && preview?.generation === generation && this.#previewSelection.get(entity.id) === generation ? plan.fields.map((_, i) => this.#value(preview, i, nowMs)) : !same && !snap ? initial ? initial.values.slice() : seedFieldValues(plan.policies, target.values) : target.values.slice();
      if (this.#delayMs && same && !snap) for (let i = 0; i < from.length; i++) from[i] = old.target.values[i];
      const velocity = this.#extrapolation ? new Array(plan.fields.length).fill(0) : null;
      for (let i = 0; i < plan.fields.length; i++) {
        const field = plan.fields[i], value = target.values[i];
        if (reset.has(i) && !this.#delayMs) from[i] = value;
        if (!same && !snap && initial && this.#extrapolation?.fields.has(field.name) && typeof from[i] === "number" && typeof value === "number") {
          if (!Number.isFinite(from[i] - value)) throw new RangeError("extrapolation correction overflow: " + field.name);
        }
        if (same && !snap && !reset.has(i) && typeof value === "number" && typeof old.target.values[i] === "number") {
          if (this.#delayMs) from[i] = old.target.values[i];
          else if (!preview || preview.generation !== generation) from[i] = this.#value(old, i, nowMs);
          if (field.code === RenderObject.DECAY && value > old.target.values[i]) from[i] = value;
          if (this.#extrapolation?.fields.has(field.name)) {
            if (!isLinearField(field.code)) throw new TypeError("extrapolation requires LINEAR: " + field.name);
            const delta = timeMs - old.timeMs;
            if (delta > 0) {
              const distance = value - old.target.values[i];
              velocity[i] = !Number.isFinite(delta) ? (value / 2 - old.target.values[i] / 2) / (timeMs / 2 - old.timeMs / 2) : !Number.isFinite(distance) ? (value / 2 - old.target.values[i] / 2) / delta * 2 : distance / delta;
            } else velocity[i] = old.velocity[i];
            if (!Number.isFinite(velocity[i])) throw new RangeError("extrapolation velocity overflow: " + field.name);
            if (!Number.isFinite(from[i] - value)) throw new RangeError("extrapolation correction overflow: " + field.name);
          }
        }
      }
      const track = {
        id: entity.id,
        generation,
        source,
        plan,
        target,
        from,
        velocity,
        at: nowMs,
        timeMs,
        model: same ? old.model : {},
        sampleValues: same ? old.sampleValues : void 0,
        sampledAt: -Infinity
      };
      let intervalStart;
      if (this.#delayMs) {
        intervalStart = bufferInterval(track, old, {
          origin,
          timeMs,
          previousTimeMs: this.#timeMs,
          stepMs: this.#stepMs,
          continuous: same && !snap,
          reset: snap,
          seeded: !snap && (!!initial || plan.policies.origins.some((i) => i !== void 0)),
          initialTimeMs: entity.initialTimeMs
        });
        track.initialShapes = same && !snap ? old.target.shapes : !snap && initial ? initial.shapes : target.shapes;
        track.heldFields = reset;
        for (const node of plan.nodes) if (node.field === void 0 && !Object.is(track.initialShapes[node.index], target.shapes[node.index])) {
          for (const index of node.fields) track.heldFields.add(index);
        }
        const prior = same && !snap ? old.target.values : !snap && initial ? initial.values : target.values;
        for (const index of track.heldFields) from[index] = prior[index];
      }
      const pathStart = this.#delayMs ? intervalStart : same && !snap ? old.timeMs : !snap && initial ? entity.initialTimeMs ?? timeMs - this.#stepMs : timeMs;
      track.path = capturePath(plan.path, old?.path, from, target.values, pathStart, timeMs, entity.pathPoints, !same || snap, this.#delayMs, this.#stepMs);
      next.set(entity.id, track);
      sources.set(source, track);
    }
    if (!changed && mode === "continuous") retainRemoved(next, this.#tracks, { origin, timeMs, nowMs, delayMs: this.#delayMs });
    this.#origin = origin;
    this.#frameSerial++;
    this.#tracks = next;
    this.#sources = sources;
    this.#preview = previews;
    this.#previewSources = previewSources;
    this.#revision = revision;
    this.#sequence = sequence;
    this.#timeMs = timeMs;
    this.#now = nowMs;
    return true;
  }
  #value(track, index, now) {
    const field = track.plan.fields[index], from = track.from[index], to = track.target.values[index];
    if (from == null || to == null || field.kind === "discrete" || track.heldFields?.has(index)) return track.buffered && now < track.at + track.durationMs ? from : to;
    const alpha = fraction2(track, now, track.durationMs ?? this.#stepMs);
    if (!track.preview && this.#extrapolation?.fields.has(field.name)) {
      const age = Math.min(this.#extrapolation.maxMs, Math.max(0, now - track.at));
      const value = evaluate("number", from, to, alpha) + track.velocity[index] * age;
      if (!Number.isFinite(value)) throw new RangeError("extrapolated render value overflow: " + field.name);
      return value;
    }
    if (field.code === RenderObject.CYCLE) {
      if (alpha === 1) return to;
      const value = evaluate("number", from, to < from ? to + 1 : to, alpha);
      return value > 1 ? value - 1 : value;
    }
    return evaluate(field.kind, from, to, alpha);
  }
  /** 유효 identity가 아니면 null. 원본 fallback은 없습니다. 모델은 프레임 간 재사용됩니다. */
  sample(id, generation, nowMs) {
    this.#checkClock(nowMs);
    let preview = this.#preview.get(id);
    if (preview?.releaseAt !== void 0 && nowMs >= preview.releaseAt) {
      this.#preview.delete(id);
      preview = null;
    }
    if (preview && preview.generation === generation && this.#previewSelection.get(id) === generation) {
      if (preview.sampledAt !== nowMs) {
        const values = preview.sampleValues ??= new Array(preview.plan.fields.length);
        for (let i = 0; i < values.length; i++) values[i] = this.#value(preview, i, nowMs);
        writeRenderModel(preview.plan, preview.model, values, preview.target.shapes);
        preview.sampledAt = nowMs;
        this.#models.set(preview.model, preview);
      }
      this.#now = nowMs;
      return preview.model;
    }
    const track = this.#tracks.get(id);
    const at = nowMs - this.#delayMs;
    const interval = this.#delayMs ? intervalAt(track, at) : track;
    if (!interval || !track || track.generation !== generation) {
      this.#now = nowMs;
      return null;
    }
    if (track.sampledAt !== nowMs) {
      const values = track.sampleValues ??= new Array(track.plan.fields.length);
      for (let i = 0; i < values.length; i++) values[i] = this.#value(interval, i, at);
      if (track.plan.path) {
        const point = track.pathHead ?? (track.pathHead = {});
        pointAt(track.path, at - this.#origin, point);
        values[track.plan.path.x] = point.x;
        values[track.plan.path.y] = point.y;
      }
      writeRenderModel(track.plan, track.model, values, interval.buffered && at < interval.at + interval.durationMs ? interval.initialShapes : interval.target.shapes);
      track.sampledAt = nowMs;
      this.#models.set(track.model, track);
    }
    this.#now = nowMs;
    return track.model;
  }
  /** 등록된 원본 객체나 유효한 모델만 받습니다. 삭제·세대 변경된 모델은 다시 그리지 않습니다. */
  modelFor(source, nowMs) {
    this.#checkClock(nowMs);
    if (this.isModel(source)) {
      const owner = this.#models.get(source);
      return this.sample(owner.id, owner.generation, nowMs);
    }
    const preview = source && typeof source === "object" ? this.#previewSources.get(source) : null;
    if (preview && this.#previewSelection.get(preview.id) === preview.generation) return this.sample(preview.id, preview.generation, nowMs);
    const track = this.#sources.get(source);
    if (track) return this.sample(track.id, track.generation, nowMs);
    this.#now = nowMs;
    return null;
  }
  /**
   * One synchronous display frame. All reads share one nowMs and preview selection.
   * Enumerate this frame, not the current simulation collection: delayed removals stay visible.
   * Models are reused, declared data only; do not retain/mutate them or read raw simulation in draw code.
   * A new frame/capture invalidates this handle. No per-field proxy or deep copy on RAF.
   */
  frame(nowMs) {
    this.#checkClock(nowMs);
    this.#now = nowMs;
    const serial = ++this.#frameSerial, check = () => {
      if (serial !== this.#frameSerial) throw new Error("Presentation frame expired");
    };
    return Object.freeze({
      nowMs,
      timeMs: nowMs - this.#delayMs - this.#origin,
      sample: (id, generation) => {
        check();
        return this.sample(id, generation, nowMs);
      },
      modelFor: (source) => {
        check();
        return this.modelFor(source, nowMs);
      },
      forEach: (visit) => {
        check();
        for (const [id, track] of this.#tracks) {
          const model = this.sample(id, track.generation, nowMs);
          if (model) visit(model, id, track.generation);
        }
      },
      pathInto: (id, generation, out) => {
        check();
        if (!Array.isArray(out)) throw new TypeError("path output must be an array");
        const track = this.#tracks.get(id);
        if (!track || track.generation !== generation || !this.sample(id, generation, nowMs)) {
          out.length = 0;
          return out;
        }
        if (!track.plan.path) throw new Error("Declare renderPath before reading a path");
        if (this.#preview.has(id) && this.#previewSelection.get(id) === generation) throw new Error("Preview path is not supported; attach visuals to the selected model");
        return samplePath(track.path, nowMs - this.#delayMs - this.#origin, track.plan.path.durationMs, out);
      }
    });
  }
  /** 정상적인 객체 메서드 호출입니다. this/프로토타입을 바꾸지 않습니다. */
  render(source, context, nowMs) {
    if (!(source instanceof RenderObject)) throw new TypeError("render() requires a RenderObject");
    const model = this.modelFor(source, nowMs);
    if (!model) throw new Error("Render object has not been captured");
    source.render(context, model);
    return model;
  }
};
export {
  InterpolationTimeline,
  PresentationRuntime,
  RenderObject,
  snapshotRenderModel
};

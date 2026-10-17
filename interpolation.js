// modules/interpolation/intervals.js
function bufferInterval(track, old, { origin, timeMs, previousTimeMs, stepMs, delayMs, continuous, seeded, initialTimeMs, reset }) {
  const START = continuous ? previousTimeMs : seeded ? initialTimeMs ?? timeMs - stepMs : timeMs;
  if (!Number.isFinite(START) || START > timeMs) {
    throw new RangeError("initialTimeMs must be finite and <= timeMs");
  }
  track.startedAt = track.at = origin + START;
  track.durationMs = timeMs - START;
  track.bornAt = continuous ? old.bornAt : reset ? origin + timeMs - delayMs : origin + START;
  track.removedAt = Infinity;
  track.buffered = true;
  const HISTORY = continuous ? [...old.history ?? [], old] : [];
  track.history = HISTORY.slice(-Math.ceil(delayMs / stepMs) - 2).map(({ history, ...item }) => item);
  return START;
}
function intervalAt(track, at) {
  if (!track || at < track.bornAt || at >= track.removedAt) {
    return null;
  }
  if (at >= track.startedAt) {
    return track;
  }
  return track.history.find((item) => at <= item.startedAt + item.durationMs) ?? track.history.at(-1) ?? track;
}
function retainRemoved(next, previous, { origin, timeMs, nowMs, delayMs }) {
  if (!delayMs) {
    return;
  }
  for (const [ID, OLD] of previous) {
    if (!next.has(ID)) {
      const REMOVED_AT = Number.isFinite(OLD.removedAt) ? OLD.removedAt : origin + timeMs;
      if (nowMs - delayMs < REMOVED_AT) {
        next.set(ID, {
          ...OLD,
          removedAt: REMOVED_AT
        });
      }
    }
  }
}

// modules/interpolation/schema.js
function compileSchema(schema) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    throw new TypeError("schema must be an object");
  }
  const FIELDS = Object.entries(schema);
  if (!FIELDS.length) {
    throw new TypeError("schema must declare at least one field");
  }
  for (const [NAME, KIND] of FIELDS) {
    if (["__proto__", "prototype", "constructor"].includes(NAME)) {
      throw new TypeError("unsafe field name");
    }
    if (!["number", "angle", "discrete"].includes(KIND)) {
      throw new TypeError(`unknown kind: ${KIND}`);
    }
  }
  return FIELDS;
}
function finite(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`${label} must be finite`);
  }
  return value;
}
function ordinal(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a nonnegative safe integer`);
  }
  return value;
}
function readValues(fields, values) {
  if (!values || typeof values !== "object" || Array.isArray(values)) {
    throw new TypeError("values must be an object");
  }
  return fields.map(([name, kind]) => {
    if (!Object.hasOwn(values, name)) {
      throw new TypeError(`missing field: ${name}; sparse patches are not supported`);
    }
    const VALUE = values[name];
    if (kind !== "discrete") {
      return finite(VALUE, name);
    }
    if (VALUE !== null && !["string", "boolean", "number"].includes(typeof VALUE)) {
      throw new TypeError(`${name} must be a scalar`);
    }
    if (typeof VALUE === "number") {
      finite(VALUE, name);
    }
    return VALUE;
  });
}
function readResetFields(indices, names) {
  if (names === void 0) {
    return null;
  }
  if (!Array.isArray(names)) {
    throw new TypeError("resetFields must be an array");
  }
  const RESET = /* @__PURE__ */ new Set();
  for (const NAME of names) {
    if (typeof NAME !== "string" || !indices.has(NAME)) {
      throw new TypeError("resetFields must name declared fields");
    }
    const INDEX = indices.get(NAME);
    if (RESET.has(INDEX)) {
      throw new TypeError("duplicate resetFields field");
    }
    RESET.add(INDEX);
  }
  return RESET;
}

// modules/interpolation/tracks.js
var TAU = Math.PI * 2;
function wrap(angle) {
  const VALUE = angle % TAU;
  const POSITIVE = VALUE < 0 ? VALUE + TAU : VALUE;
  return POSITIVE >= TAU || POSITIVE === 0 ? 0 : POSITIVE;
}
function evaluate(kind, from, to, alpha) {
  if (kind === "discrete") {
    return to;
  }
  if (alpha === 1) {
    return kind === "angle" ? wrap(to) : to;
  }
  if (alpha === 0) {
    return kind === "angle" ? wrap(from) : from;
  }
  if (kind === "angle") {
    const START = wrap(from);
    let delta = wrap(to) - START;
    if (Math.abs(Math.abs(delta) - Math.PI) <= Number.EPSILON * TAU) {
      delta = -Math.PI;
    } else if (delta > Math.PI) {
      delta -= TAU;
    } else if (delta < -Math.PI) {
      delta += TAU;
    }
    return wrap(START + delta * alpha);
  }
  return Math.sign(from) === Math.sign(to) ? from + (to - from) * alpha : from * (1 - alpha) + to * alpha;
}
function fraction(track, now, stepMs) {
  return Math.min(1, Math.max(0, (now - track.startedAt) / stepMs));
}
function retarget(fields, old, target, generation, now, stepMs, snap, initial, resetFields) {
  const CONTINUED = old && old.generation === generation;
  const FROM = !CONTINUED && !snap && initial ? initial : target.slice();
  if (CONTINUED && !snap) {
    const ALPHA = fraction(old, now, stepMs);
    for (let i = 0; i < fields.length; i++) {
      FROM[i] = evaluate(fields[i][1], old.from[i], old.target[i], ALPHA);
    }
  }
  if (resetFields) {
    for (const INDEX of resetFields) {
      FROM[INDEX] = target[INDEX];
    }
  }
  return {
    generation,
    from: FROM,
    target,
    startedAt: now
  };
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
    if (stepMs <= 0) {
      throw new RangeError("stepMs must be positive");
    }
    this.#delayMs = finite(delayMs, "delayMs");
    if (delayMs < 0 || delayMs > stepMs * 16) {
      throw new RangeError("delayMs must be between 0 and 16 steps");
    }
  }
  get size() {
    return this.#tracks.size;
  }
  #checkClock(nowMs) {
    finite(nowMs, "nowMs");
    if (nowMs < this.#now) {
      throw new RangeError("presentation clock must not go backwards");
    }
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
    if (!packet || typeof packet !== "object") {
      throw new TypeError("packet must be an object");
    }
    const REVISION = ordinal(packet.revision, "revision");
    const SEQUENCE = ordinal(packet.sequence, "sequence");
    const TIME_MS = finite(packet.timeMs, "timeMs");
    const MODE = packet.mode ?? "continuous";
    if (!["continuous", "reset", "load", "rollback"].includes(MODE)) {
      throw new TypeError("unknown snapshot mode");
    }
    if (REVISION < this.#revision || REVISION === this.#revision && SEQUENCE <= this.#sequence) {
      return false;
    }
    const CHANGED_REVISION = REVISION !== this.#revision;
    if (this.#revision !== -1 && CHANGED_REVISION && MODE === "continuous") {
      throw new RangeError("new revision requires reset, load or rollback");
    }
    if (!CHANGED_REVISION && MODE !== "continuous") {
      throw new RangeError("reset, load and rollback require a newer revision");
    }
    if (!CHANGED_REVISION && TIME_MS < this.#timeMs) {
      return false;
    }
    if (!Array.isArray(packet.entities)) {
      throw new TypeError("entities must be an array");
    }
    const NEXT = /* @__PURE__ */ new Map();
    const ORIGIN = CHANGED_REVISION ? nowMs - TIME_MS : this.#origin;
    for (const ENTITY of packet.entities) {
      if (!ENTITY || typeof ENTITY.id !== "string" || !ENTITY.id.length) {
        throw new TypeError("id must be a nonempty string");
      }
      if (NEXT.has(ENTITY.id)) {
        throw new TypeError("duplicate entity id");
      }
      const GENERATION = ordinal(ENTITY.generation, "generation");
      if (ENTITY.teleport !== void 0 && typeof ENTITY.teleport !== "boolean") {
        throw new TypeError("teleport must be boolean");
      }
      const TARGET = readValues(this.#fields, ENTITY.values);
      const INITIAL = ENTITY.initialValues === void 0 ? null : readValues(this.#fields, ENTITY.initialValues);
      const RESET_FIELDS = readResetFields(this.#fieldIndices, ENTITY.resetFields);
      const OLD = this.#tracks.get(ENTITY.id);
      const SNAP = MODE !== "continuous" || ENTITY.teleport === true;
      const TRACK = retarget(
        this.#fields,
        OLD,
        TARGET,
        GENERATION,
        nowMs,
        this.#stepMs,
        SNAP,
        INITIAL,
        RESET_FIELDS
      );
      if (this.#delayMs > 0) {
        const CONTINUED = OLD && OLD.generation === GENERATION && !SNAP && !CHANGED_REVISION && !Number.isFinite(OLD.removedAt);
        if (CONTINUED) {
          TRACK.from = OLD.target.slice();
          if (RESET_FIELDS) {
            for (const I of RESET_FIELDS) {
              TRACK.from[I] = TARGET[I];
            }
          }
        }
        bufferInterval(TRACK, OLD, {
          origin: ORIGIN,
          timeMs: TIME_MS,
          previousTimeMs: this.#timeMs,
          stepMs: this.#stepMs,
          delayMs: this.#delayMs,
          continuous: CONTINUED,
          reset: SNAP,
          seeded: !!INITIAL && !SNAP,
          initialTimeMs: ENTITY.initialTimeMs
        });
      }
      NEXT.set(ENTITY.id, TRACK);
    }
    if (!CHANGED_REVISION && MODE === "continuous") {
      retainRemoved(NEXT, this.#tracks, {
        origin: ORIGIN,
        timeMs: TIME_MS,
        nowMs,
        delayMs: this.#delayMs
      });
    }
    this.#tracks = NEXT;
    this.#origin = ORIGIN;
    this.#revision = REVISION;
    this.#sequence = SEQUENCE;
    this.#timeMs = TIME_MS;
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
    if (!out || typeof out !== "object") {
      throw new TypeError("out must be a writable object");
    }
    let track = this.#tracks.get(id);
    this.#now = nowMs;
    if (!track || track.generation !== generation) {
      return false;
    }
    const SAMPLE_AT = nowMs - this.#delayMs;
    if (this.#delayMs > 0) {
      track = intervalAt(track, SAMPLE_AT);
      if (!track) {
        return false;
      }
    }
    const ALPHA = track.durationMs === 0 ? 1 : fraction(track, SAMPLE_AT, track.durationMs ?? this.#stepMs);
    for (let i = 0; i < this.#fields.length; i++) {
      const FIELD = this.#fields[i];
      out[FIELD[0]] = this.#delayMs > 0 && FIELD[1] === "discrete" && ALPHA < 1 ? track.from[i] : evaluate(FIELD[1], track.from[i], track.target[i], ALPHA);
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
  render(_context, _model) {
    throw new Error("RenderObject 하위 타입은 render(context, model)을 구현해야 합니다.");
  }
};

// modules/interpolation/path.js
function pathPlan(declaration, indices) {
  if (!declaration) {
    return null;
  }
  const X = indices.get(declaration.x), Y = indices.get(declaration.y), DURATION_MS = finite(declaration.durationMs, "renderPath.durationMs");
  const MAX_POINTS = declaration.maxPoints ?? 64;
  if (X === void 0 || Y === void 0 || DURATION_MS <= 0 || !Number.isSafeInteger(MAX_POINTS) || MAX_POINTS < 2 || MAX_POINTS > 4096) {
    throw new TypeError("invalid renderPath");
  }
  return {
    x: X,
    y: Y,
    durationMs: DURATION_MS,
    maxPoints: MAX_POINTS
  };
}
function capturePath(plan, old, from, target, startMs, timeMs, points, reset, delayMs, stepMs) {
  if (!plan) {
    return null;
  }
  const PATH = reset ? [] : (old ?? []).slice();
  const ADD = (timeMs2, x, y) => {
    finite(timeMs2, "path timeMs");
    finite(x, "path x");
    finite(y, "path y");
    if (PATH.length && timeMs2 < PATH.at(-1).timeMs) {
      throw new RangeError("path points must be ordered");
    }
    if (PATH.length && timeMs2 === PATH.at(-1).timeMs) {
      PATH[PATH.length - 1] = {
        timeMs: timeMs2,
        x,
        y
      };
    } else {
      PATH.push({
        timeMs: timeMs2,
        x,
        y
      });
    }
  };
  if (!PATH.length) {
    ADD(startMs, from[plan.x], from[plan.y]);
  }
  if (points !== void 0) {
    if (!Array.isArray(points)) {
      throw new TypeError("pathPoints must be an array");
    }
    for (const POINT of points) {
      if (POINT.timeMs < startMs || POINT.timeMs > timeMs) {
        throw new RangeError("pathPoints must be inside this capture interval");
      }
      ADD(POINT.timeMs, POINT.x, POINT.y);
    }
  }
  ADD(timeMs, target[plan.x], target[plan.y]);
  const FLOOR = timeMs - plan.durationMs - delayMs - stepMs;
  while (PATH.length > 2 && PATH[1].timeMs < FLOOR) {
    PATH.shift();
  }
  return PATH.slice(-plan.maxPoints);
}
function pointAt(path, timeMs, out) {
  if (!path?.length) {
    return false;
  }
  let a = path[0];
  let b = a;
  for (let i = 1; i < path.length; i++) {
    b = path[i];
    if (timeMs <= b.timeMs) {
      break;
    }
    a = b;
  }
  const T = b.timeMs === a.timeMs ? 1 : Math.max(0, Math.min(1, (timeMs - a.timeMs) / (b.timeMs - a.timeMs)));
  out.timeMs = Math.max(path[0].timeMs, Math.min(timeMs, path.at(-1).timeMs));
  out.x = a.x + (b.x - a.x) * T;
  out.y = a.y + (b.y - a.y) * T;
  return true;
}
function samplePath(path, timeMs, durationMs, out) {
  let count = 0;
  const WRITE = (point) => {
    const ITEM = out[count] ?? (out[count] = {});
    Object.assign(ITEM, point);
    count++;
  };
  const HEAD = {};
  if (!pointAt(path, timeMs, HEAD)) {
    out.length = 0;
    return out;
  }
  const FLOOR = Math.max(path[0].timeMs, HEAD.timeMs - durationMs), TAIL = {};
  pointAt(path, FLOOR, TAIL);
  WRITE(TAIL);
  for (const POINT of path) {
    if (POINT.timeMs > FLOOR && POINT.timeMs < HEAD.timeMs) {
      WRITE(POINT);
    }
  }
  if (HEAD.timeMs > FLOOR) {
    WRITE(HEAD);
  }
  out.length = count;
  return out;
}

// modules/interpolation/render-policies.js
var KINDS = [
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
  return KINDS[code];
}
function isLinearField(code) {
  return code === RenderObject.LINEAR || code >= RenderObject.POSITION_X && code <= RenderObject.SPAWN_LINEAR;
}
function compileFieldPolicies(root, fields) {
  function descendants(node) {
    node.fields = node.field === void 0 ? [] : [node.field];
    for (const CHILD of node.children.values()) {
      node.fields.push(...descendants(CHILD));
    }
    return node.fields;
  }
  descendants(root);
  const KEYS = [], CLOCKS = [], POSITIONS = new Array(3), ORIGINS = new Array(3), BIRTHS = [];
  for (let index = 0; index < fields.length; index++) {
    const FIELD = fields[index];
    if (FIELD.code === RenderObject.STATE_KEY) {
      KEYS.push({
        index,
        scope: FIELD.owner.fields
      });
    }
    if (FIELD.code === RenderObject.COUNTDOWN_MS || FIELD.code === RenderObject.COUNTDOWN_SECONDS) {
      CLOCKS.push({
        index,
        scope: FIELD.owner.fields,
        unitsPerMs: FIELD.code === RenderObject.COUNTDOWN_MS ? 1 : 1e-3
      });
    }
    if (FIELD.code >= RenderObject.POSITION_X && FIELD.code <= RenderObject.POSITION_Z) {
      const AXIS = FIELD.code - RenderObject.POSITION_X;
      if (POSITIONS[AXIS] !== void 0) {
        throw new TypeError("Duplicate render position axis");
      }
      POSITIONS[AXIS] = index;
    }
    if (FIELD.code >= RenderObject.ORIGIN_X && FIELD.code <= RenderObject.ORIGIN_Z) {
      const AXIS = FIELD.code - RenderObject.ORIGIN_X;
      if (ORIGINS[AXIS] !== void 0) {
        throw new TypeError("Duplicate render origin axis");
      }
      ORIGINS[AXIS] = index;
    }
    if (FIELD.code === RenderObject.SPAWN_LINEAR) {
      BIRTHS.push(index);
    }
  }
  return {
    keys: KEYS,
    clocks: CLOCKS,
    positions: POSITIONS,
    origins: ORIGINS,
    births: BIRTHS
  };
}
function inferStateResets(policies, previous, target, reset) {
  for (const KEY of policies.keys) {
    if (!Object.is(previous.values[KEY.index], target.values[KEY.index])) {
      for (const INDEX of KEY.scope) {
        reset.add(INDEX);
      }
    }
  }
}
function inferFieldResets(policies, previous, target, timeMs, reset) {
  inferStateResets(policies, previous.target, target, reset);
  const ELAPSED = timeMs - previous.timeMs;
  for (const CLOCK of policies.clocks) {
    const FROM = previous.target.values[CLOCK.index], TO = target.values[CLOCK.index];
    if (typeof FROM !== "number" || typeof TO !== "number") {
      continue;
    }
    const PASSED = Number.isFinite(ELAPSED) ? ELAPSED * CLOCK.unitsPerMs : timeMs * CLOCK.unitsPerMs - previous.timeMs * CLOCK.unitsPerMs;
    const EXPECTED = Math.max(0, FROM - PASSED);
    const TOLERANCE = 1e-6 * CLOCK.unitsPerMs + Number.EPSILON * 16 * Math.max(1, FROM, TO) + Number.EPSILON * 16 * Math.max(Math.abs(timeMs), Math.abs(previous.timeMs)) * CLOCK.unitsPerMs;
    if (Math.abs(TO - EXPECTED) > TOLERANCE) {
      for (const INDEX of CLOCK.scope) {
        reset.add(INDEX);
      }
    }
  }
}
function positionDiscontinuity(policies, previous, target, distance) {
  if (distance === void 0) {
    return false;
  }
  let count = 0;
  let a = 0;
  let b = 0;
  let c = 0;
  for (let axis = 0; axis < 3; axis++) {
    const INDEX = policies.positions[axis];
    if (INDEX === void 0) {
      continue;
    }
    const FROM = previous.target.values[INDEX], TO = target.values[INDEX];
    if (typeof FROM !== "number" || typeof TO !== "number") {
      continue;
    }
    const DELTA = TO - FROM;
    if (axis === 0) {
      a = DELTA;
    } else if (axis === 1) {
      b = DELTA;
    } else {
      c = DELTA;
    }
    count++;
  }
  return count > 0 && Math.hypot(a, b, c) > distance;
}
function seedFieldValues(policies, values) {
  const FROM = values.slice();
  for (let axis = 0; axis < 3; axis++) {
    const POSITION = policies.positions[axis], ORIGIN = policies.origins[axis];
    if (POSITION !== void 0 && ORIGIN !== void 0 && typeof values[POSITION] === "number" && typeof values[ORIGIN] === "number") {
      FROM[POSITION] = values[ORIGIN];
    }
  }
  for (const INDEX of policies.births) {
    if (typeof values[INDEX] === "number") {
      FROM[INDEX] = 0;
    }
  }
  return FROM;
}

// modules/interpolation/render-schema.js
var UNSAFE = /* @__PURE__ */ new Set(["__proto__", "prototype", "constructor"]);
var CACHE = /* @__PURE__ */ new WeakMap();
var ARRAY_KEY = /^(0|[1-9][0-9]*)$/;
function copyRenderData(value, seen = /* @__PURE__ */ new Set()) {
  if (value === null || value === void 0 || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value !== "object" || !Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    throw new TypeError("Render STEP requires finite scalar or plain data");
  }
  if (seen.has(value)) {
    throw new TypeError("Render STEP cannot contain cycles; use an entity ID");
  }
  seen.add(value);
  const RESULT = Array.isArray(value) ? new Array(value.length) : {};
  for (const KEY of Object.keys(value)) {
    if (UNSAFE.has(KEY)) {
      throw new TypeError("Unsafe render data key: " + KEY);
    }
    const DESCRIPTOR = Object.getOwnPropertyDescriptor(value, KEY);
    if (!Object.hasOwn(DESCRIPTOR, "value")) {
      throw new TypeError("Render data accessors are not supported");
    }
    RESULT[KEY] = copyRenderData(DESCRIPTOR.value, seen);
  }
  seen.delete(value);
  return RESULT;
}
function dataAt(source, key) {
  const DESCRIPTOR = Object.getOwnPropertyDescriptor(source, key);
  if (!DESCRIPTOR) {
    return void 0;
  }
  if (!Object.hasOwn(DESCRIPTOR, "value")) {
    throw new TypeError("Render fields must be data properties: " + key);
  }
  return DESCRIPTOR.value;
}
function compileRenderSchema(type) {
  if (typeof type !== "function" || type !== RenderObject && !(type.prototype instanceof RenderObject)) {
    throw new TypeError("Render type must extend RenderObject");
  }
  if (CACHE.has(type)) {
    return CACHE.get(type);
  }
  const MERGED = {};
  const CHAIN = [];
  for (let current = type; current && current !== Function.prototype; current = Object.getPrototypeOf(current)) {
    CHAIN.unshift(current);
  }
  for (const CURRENT of CHAIN) {
    if (!Object.hasOwn(CURRENT, "renderSchema")) {
      continue;
    }
    const DECLARATION = Object.getOwnPropertyDescriptor(CURRENT, "renderSchema");
    if (!Object.hasOwn(DECLARATION, "value")) {
      throw new TypeError("renderSchema cannot be an accessor");
    }
    const SCHEMA = DECLARATION.value;
    if (!SCHEMA || typeof SCHEMA !== "object" || Array.isArray(SCHEMA)) {
      throw new TypeError("renderSchema must be a field-path map");
    }
    for (const NAME of Object.keys(SCHEMA)) {
      const DESCRIPTOR = Object.getOwnPropertyDescriptor(SCHEMA, NAME);
      if (!Object.hasOwn(DESCRIPTOR, "value")) {
        throw new TypeError("renderSchema cannot contain accessors");
      }
      Object.defineProperty(MERGED, NAME, {
        value: DESCRIPTOR.value,
        enumerable: true,
        configurable: true
      });
    }
  }
  const FIELDS = [], NODES = [], INDICES = /* @__PURE__ */ new Map(), ROOT = {
    children: /* @__PURE__ */ new Map()
  };
  for (const [NAME, CODE] of Object.entries(MERGED)) {
    const PATH2 = NAME.split(".");
    if (PATH2.some((key) => !key || UNSAFE.has(key))) {
      throw new TypeError("Unsafe or empty render path: " + NAME);
    }
    if (!Number.isInteger(CODE) || !fieldKind(CODE)) {
      throw new TypeError("Unknown render interpolation: " + NAME);
    }
    let node = ROOT;
    for (const KEY of PATH2) {
      if (node.field !== void 0) {
        throw new TypeError("Overlapping render paths: " + NAME);
      }
      if (!node.children.has(KEY)) {
        const CHILD = {
          key: KEY,
          children: /* @__PURE__ */ new Map(),
          index: NODES.length,
          parent: node
        };
        node.children.set(KEY, CHILD);
        NODES.push(CHILD);
      }
      node = node.children.get(KEY);
    }
    if (node.children.size) {
      throw new TypeError("Overlapping render paths: " + NAME);
    }
    node.field = FIELDS.length;
    INDICES.set(NAME, FIELDS.length);
    FIELDS.push(
      Object.freeze({
        name: NAME,
        code: CODE,
        kind: fieldKind(CODE),
        path: Object.freeze(PATH2),
        owner: node.parent
      })
    );
  }
  if (!FIELDS.length) {
    throw new TypeError("renderSchema must declare at least one field");
  }
  const POLICIES = compileFieldPolicies(ROOT, FIELDS);
  const PATH = pathPlan(type.renderPath, INDICES);
  const PLAN = {
    path: PATH,
    fields: Object.freeze(FIELDS),
    indices: INDICES,
    root: ROOT,
    nodes: NODES,
    policies: POLICIES
  };
  CACHE.set(type, PLAN);
  return PLAN;
}
function captureRenderData(plan, source) {
  if (!source || typeof source !== "object") {
    throw new TypeError("Render source must be an object");
  }
  const VALUES = new Array(plan.fields.length), SHAPES = new Array(plan.nodes.length);
  function visit(node, value) {
    if (node.field !== void 0) {
      const FIELD = plan.fields[node.field];
      if (value == null) {
        VALUES[node.field] = value;
      } else if (FIELD.kind === "discrete") {
        if (FIELD.code === RenderObject.STATE_KEY && !["number", "boolean", "string"].includes(typeof value)) {
          throw new TypeError("STATE_KEY requires a scalar: " + FIELD.name);
        }
        VALUES[node.field] = copyRenderData(value);
      } else {
        if (typeof value !== "number" || !Number.isFinite(value)) {
          throw new TypeError("Render field must be finite: " + FIELD.name);
        }
        if (FIELD.code === RenderObject.CYCLE && (value < 0 || value > 1)) {
          throw new RangeError("Render CYCLE requires 0..1: " + FIELD.name);
        }
        if ((FIELD.code === RenderObject.COUNTDOWN_MS || FIELD.code === RenderObject.COUNTDOWN_SECONDS) && value < 0) {
          throw new RangeError("Render countdown must be nonnegative: " + FIELD.name);
        }
        VALUES[node.field] = value;
      }
      return;
    }
    if (value == null) {
      SHAPES[node.index] = value;
      return;
    }
    if (typeof value !== "object") {
      throw new TypeError("Render parent must be an object: " + node.key);
    }
    SHAPES[node.index] = Array.isArray(value) ? value.length : -1;
    for (const CHILD of node.children.values()) {
      if (Array.isArray(value) && CHILD.key === "length") {
        throw new TypeError("Array length belongs to render structure, not a field");
      }
      visit(CHILD, dataAt(value, CHILD.key));
    }
  }
  for (const NODE of plan.root.children.values()) {
    visit(NODE, dataAt(source, NODE.key));
  }
  return {
    values: VALUES,
    shapes: SHAPES
  };
}
function snapshotRenderModel(type, source) {
  const PLAN = compileRenderSchema(type), DATA = captureRenderData(PLAN, source);
  return writeRenderModel(PLAN, {}, DATA.values, DATA.shapes);
}
function writeRenderModel(plan, model, values, shapes) {
  function visit(parent, node) {
    const { key: KEY } = node;
    if (node.field !== void 0) {
      const VALUE = values[node.field];
      if (VALUE === void 0) {
        delete parent[KEY];
      } else {
        parent[KEY] = plan.fields[node.field].kind === "discrete" ? reuseData(parent[KEY], VALUE) : VALUE;
      }
      return;
    }
    const SHAPE = shapes[node.index];
    if (SHAPE === void 0) {
      delete parent[KEY];
      return;
    }
    if (SHAPE === null) {
      parent[KEY] = null;
      return;
    }
    const ARRAY = SHAPE >= 0;
    let target = parent[KEY];
    if (!target || typeof target !== "object" || Array.isArray(target) !== ARRAY) {
      target = parent[KEY] = ARRAY ? [] : {};
    }
    if (ARRAY) {
      target.length = SHAPE;
    }
    for (const CHILD of node.children.values()) {
      if (!ARRAY || !ARRAY_KEY.test(CHILD.key) || Number(CHILD.key) < SHAPE) {
        visit(target, CHILD);
      }
    }
  }
  for (const NODE of plan.root.children.values()) {
    visit(model, NODE);
  }
  return model;
}
function reuseData(out, value) {
  if (value === null || typeof value !== "object") {
    return value;
  }
  const ARRAY = Array.isArray(value);
  if (!out || typeof out !== "object" || Array.isArray(out) !== ARRAY) {
    out = ARRAY ? [] : {};
  }
  for (const KEY of Object.keys(out)) {
    if (!Object.hasOwn(value, KEY)) {
      delete out[KEY];
    }
  }
  if (ARRAY) {
    out.length = value.length;
  }
  for (const KEY of Object.keys(value)) {
    out[KEY] = reuseData(out[KEY], value[KEY]);
  }
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
  #previewMetrics = {
    captureMs: 0,
    captureBytes: 0,
    captures: 0
  };
  #extrapolation;
  #snapDistance;
  #delayMs;
  #origin = 0;
  #frameSerial = 0;
  /** @param {{stepMs:number, delayMs?:number, snapDistance?:number, extrapolation?:{fields:string[],maxMs:number}}} options */
  constructor({ stepMs, snapDistance, extrapolation, delayMs = 0 } = {}) {
    this.#stepMs = finite(stepMs, "stepMs");
    this.#delayMs = finite(delayMs, "delayMs");
    if (delayMs < 0 || delayMs > stepMs * 16) {
      throw new RangeError("delayMs must be between 0 and 16 steps");
    }
    if (delayMs && extrapolation) {
      throw new TypeError("delayed authority cannot also extrapolate");
    }
    if (stepMs <= 0) {
      throw new RangeError("stepMs must be positive");
    }
    if (snapDistance !== void 0 && finite(snapDistance, "snapDistance") <= 0) {
      throw new RangeError("snapDistance must be positive");
    }
    this.#snapDistance = snapDistance;
    if (extrapolation) {
      if (!Array.isArray(extrapolation.fields) || new Set(extrapolation.fields).size !== extrapolation.fields.length || Array.from(extrapolation.fields).some((x) => typeof x !== "string")) {
        throw new TypeError("extrapolation.fields must be unique paths");
      }
      if (finite(extrapolation.maxMs, "maxMs") <= 0) {
        throw new RangeError("maxMs must be positive");
      }
      if (extrapolation.maxMs < stepMs) {
        throw new RangeError("maxMs must cover the correction stepMs");
      }
      this.#extrapolation = {
        fields: new Set(extrapolation.fields),
        maxMs: extrapolation.maxMs
      };
    }
  }
  get size() {
    return this.#tracks.size;
  }
  get previewMetrics() {
    return {
      ...this.#previewMetrics
    };
  }
  /** Select game-owned local identities only; remote authoritative tracks remain unchanged. */
  selectPreview(identities) {
    if (!Array.isArray(identities)) {
      throw new TypeError("preview identities must be an array");
    }
    const NEXT = /* @__PURE__ */ new Map();
    for (const IDENTITY of identities) {
      if (!IDENTITY || typeof IDENTITY.id !== "string" || !IDENTITY.id || !Number.isSafeInteger(IDENTITY.generation) || IDENTITY.generation < 0 || NEXT.has(IDENTITY.id)) {
        throw new TypeError("invalid preview identity");
      }
      NEXT.set(IDENTITY.id, IDENTITY.generation);
    }
    this.#frameSerial++;
    this.#previewSelection = NEXT;
    for (const ID of this.#preview.keys()) {
      if (!NEXT.has(ID) || NEXT.get(ID) !== this.#preview.get(ID).generation) {
        this.#preview.delete(ID);
      }
    }
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
      for (const [ID, PREVIEW] of this.#preview) {
        if (PREVIEW.releaseAt !== void 0) {
          continue;
        }
        const TRACK = this.#tracks.get(ID);
        if (!TRACK || TRACK.generation !== PREVIEW.generation) {
          continue;
        }
        const FROM = PREVIEW.plan.fields.map((_, i) => this.#value(PREVIEW, i, nowMs)), RESET = /* @__PURE__ */ new Set();
        inferStateResets(PREVIEW.plan.policies, PREVIEW.target, TRACK.target, RESET);
        for (const I of RESET) {
          FROM[I] = TRACK.target.values[I];
        }
        const RELEASE_AT = Math.max(nowMs, this.#origin + TRACK.timeMs + this.#delayMs);
        this.#preview.set(ID, {
          ...PREVIEW,
          from: FROM,
          target: TRACK.target,
          at: nowMs,
          durationMs: RELEASE_AT - nowMs,
          releaseAt: RELEASE_AT,
          sampledAt: -Infinity
        });
      }
      this.#frameSerial++;
      this.#now = nowMs;
      return;
    }
    for (const [ID, PREVIEW] of this.#preview) {
      const TRACK = this.#tracks.get(ID);
      if (!TRACK || TRACK.generation !== PREVIEW.generation) {
        continue;
      }
      TRACK.from = TRACK.plan.fields.map((_, i) => this.#value(PREVIEW, i, nowMs));
      TRACK.at = nowMs;
      TRACK.sampledAt = -Infinity;
    }
    this.clearPreview();
    this.#now = nowMs;
  }
  /** Detached declared-field baselines for the next fork step; no source references retained. */
  snapshotPreview(entities) {
    return entities.map((entity) => {
      const TYPE = entity.type ?? entity.source.constructor, PLAN = compileRenderSchema(TYPE), DATA = captureRenderData(PLAN, entity.source);
      return {
        id: entity.id,
        generation: entity.generation,
        type: TYPE,
        source: writeRenderModel(PLAN, {}, DATA.values, DATA.shapes)
      };
    });
  }
  /** Publish immediate schema-only local fork models. This never replaces authoritative tracks. */
  capturePreview(packet, nowMs) {
    const STARTED = performance.now();
    let bytes = 0;
    this.#checkClock(nowMs);
    if (!packet || !Array.isArray(packet.entities)) {
      throw new TypeError("preview packet entities");
    }
    const REVISION = ordinal(packet.revision, "preview revision"), SEQUENCE = ordinal(packet.sequence, "preview sequence"), TIME_MS = finite(packet.timeMs, "preview timeMs");
    if (REVISION !== this.#revision || REVISION < this.#previewRevision || REVISION === this.#previewRevision && SEQUENCE <= this.#previewSequence || TIME_MS < this.#previewTimeMs) {
      return false;
    }
    if (TIME_MS < this.#now) {
      return false;
    }
    const NEXT = /* @__PURE__ */ new Map(), SOURCES = /* @__PURE__ */ new WeakMap();
    for (const ENTITY of packet.entities) {
      if (!ENTITY || typeof ENTITY.id !== "string" || !ENTITY.id || !Number.isSafeInteger(ENTITY.generation) || ENTITY.generation < 0 || NEXT.has(ENTITY.id)) {
        throw new TypeError("invalid preview entity");
      }
      if (this.#previewSelection.get(ENTITY.id) !== ENTITY.generation) {
        continue;
      }
      if (!ENTITY.source || typeof ENTITY.source !== "object") {
        throw new TypeError("preview source required");
      }
      const PLAN = compileRenderSchema(ENTITY.type ?? ENTITY.source.constructor), AUTHORITY = this.#tracks.get(ENTITY.id);
      if (!AUTHORITY || AUTHORITY.generation !== ENTITY.generation || AUTHORITY.plan !== PLAN) {
        throw new TypeError("preview must match a live authoritative render identity and schema");
      }
      const DATA = captureRenderData(PLAN, ENTITY.source), OLD = this.#preview.get(ENTITY.id);
      const INITIAL = ENTITY.initialSource ? captureRenderData(PLAN, ENTITY.initialSource) : AUTHORITY.target;
      const SAME = OLD && OLD.generation === ENTITY.generation && OLD.plan === PLAN;
      const FROM = SAME ? PLAN.fields.map((_, i) => this.#value(OLD, i, nowMs)) : PLAN.fields.map((_, i) => this.#value(AUTHORITY, i, nowMs));
      const RESET = /* @__PURE__ */ new Set();
      inferStateResets(PLAN.policies, SAME ? OLD.target : INITIAL, DATA, RESET);
      for (const INDEX of RESET) {
        FROM[INDEX] = DATA.values[INDEX];
      }
      const AT = SAME ? nowMs : Math.min(nowMs, finite(packet.phaseStartMs ?? nowMs, "phaseStartMs"));
      const END = Math.max(
        nowMs + 1,
        finite(packet.phaseStartMs ?? nowMs, "phaseStartMs") + (packet.stepMs ?? this.#stepMs)
      );
      const MODEL = SAME ? OLD.model : {};
      bytes += DATA.values.length * 8 + DATA.shapes.length * 4;
      writeRenderModel(PLAN, MODEL, DATA.values, DATA.shapes);
      const ENTRY = {
        id: ENTITY.id,
        generation: ENTITY.generation,
        plan: PLAN,
        data: DATA,
        target: DATA,
        from: FROM,
        at: AT,
        durationMs: END - AT,
        preview: true,
        model: MODEL,
        source: ENTITY.source,
        sequence: SEQUENCE,
        sampledAt: -Infinity,
        sampleValues: SAME ? OLD.sampleValues : void 0
      };
      NEXT.set(ENTITY.id, ENTRY);
      SOURCES.set(ENTITY.source, ENTRY);
    }
    this.#frameSerial++;
    this.#preview = NEXT;
    this.#previewSources = SOURCES;
    this.#previewRevision = REVISION;
    this.#previewSequence = SEQUENCE;
    this.#previewTimeMs = TIME_MS;
    this.#now = nowMs;
    this.#previewMetrics.captureMs += performance.now() - STARTED;
    this.#previewMetrics.captureBytes += bytes;
    this.#previewMetrics.captures++;
    return true;
  }
  isModel(value) {
    const OWNER = value && this.#models.get(value);
    const PREVIEW = OWNER && this.#preview.get(OWNER.id);
    if (PREVIEW?.model === value && this.#previewSelection.get(OWNER.id) === OWNER.generation) {
      return true;
    }
    const CURRENT = OWNER && this.#tracks.get(OWNER.id);
    return !!CURRENT && CURRENT.generation === OWNER.generation && CURRENT.model === value;
  }
  #checkClock(now) {
    finite(now, "nowMs");
    if (now < this.#now) {
      throw new RangeError("presentation clock must not go backwards");
    }
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
    if (!packet || typeof packet !== "object") {
      throw new TypeError("packet must be an object");
    }
    const REVISION = ordinal(packet.revision, "revision"), SEQUENCE = ordinal(packet.sequence, "sequence"), TIME_MS = finite(packet.timeMs, "timeMs");
    const MODE = packet.mode ?? "continuous";
    if (!["continuous", "reset", "load", "rollback"].includes(MODE)) {
      throw new TypeError("unknown capture mode");
    }
    if (REVISION < this.#revision || REVISION === this.#revision && SEQUENCE <= this.#sequence) {
      return false;
    }
    const CHANGED = REVISION !== this.#revision;
    if (this.#revision >= 0 && CHANGED && MODE === "continuous") {
      throw new RangeError("new revision requires reset, load or rollback");
    }
    if (!CHANGED && MODE !== "continuous") {
      throw new RangeError("reset, load and rollback require a newer revision");
    }
    if (!CHANGED && TIME_MS < this.#timeMs) {
      return false;
    }
    if (!Array.isArray(packet.entities)) {
      throw new TypeError("entities must be an array");
    }
    const ORIGIN = CHANGED ? nowMs - TIME_MS : this.#origin;
    const NEXT = /* @__PURE__ */ new Map(), SOURCES = /* @__PURE__ */ new WeakMap(), PREVIEWS = /* @__PURE__ */ new Map(), PREVIEW_SOURCES = /* @__PURE__ */ new WeakMap();
    for (const ENTITY of packet.entities) {
      if (!ENTITY || typeof ENTITY.id !== "string" || !ENTITY.id || NEXT.has(ENTITY.id)) {
        throw new TypeError("entity IDs must be nonempty and unique");
      }
      const GENERATION = ordinal(ENTITY.generation, "generation"), SOURCE = ENTITY.source;
      if (!SOURCE || typeof SOURCE !== "object" || SOURCES.has(SOURCE)) {
        throw new TypeError("entity sources must be unique objects");
      }
      if (ENTITY.teleport !== void 0 && typeof ENTITY.teleport !== "boolean") {
        throw new TypeError("teleport must be boolean");
      }
      const PLAN = compileRenderSchema(ENTITY.type ?? SOURCE.constructor);
      if (this.#extrapolation) {
        for (const FIELD of PLAN.fields) {
          if (this.#extrapolation.fields.has(FIELD.name) && !isLinearField(FIELD.code)) {
            throw new TypeError("extrapolation requires LINEAR: " + FIELD.name);
          }
        }
      }
      const TARGET = captureRenderData(PLAN, SOURCE);
      const INITIAL = ENTITY.initialSource === void 0 ? null : captureRenderData(PLAN, ENTITY.initialSource);
      const RESET = /* @__PURE__ */ new Set();
      if (ENTITY.resetFields !== void 0) {
        if (!Array.isArray(ENTITY.resetFields)) {
          throw new TypeError("resetFields must be an array");
        }
        for (const NAME of ENTITY.resetFields) {
          const INDEX = PLAN.indices.get(NAME);
          if (INDEX === void 0 || RESET.has(INDEX)) {
            throw new TypeError("resetFields must contain unique declared paths");
          }
          RESET.add(INDEX);
        }
      }
      const OLD = this.#tracks.get(ENTITY.id), PREVIEW = this.#preview.get(ENTITY.id);
      const SAME = MODE === "continuous" && OLD && OLD.generation === GENERATION && OLD.plan === PLAN && !Number.isFinite(OLD.removedAt);
      const SNAP = MODE !== "continuous" || ENTITY.teleport === true || !!SAME && positionDiscontinuity(PLAN.policies, OLD, TARGET, this.#snapDistance);
      if (this.#delayMs && SAME && !SNAP && PREVIEW?.generation === GENERATION && PREVIEW.plan === PLAN) {
        PREVIEWS.set(ENTITY.id, PREVIEW);
        PREVIEW_SOURCES.set(PREVIEW.source, PREVIEW);
      }
      if (SAME && !SNAP) {
        inferFieldResets(PLAN.policies, OLD, TARGET, TIME_MS, RESET);
      }
      const FROM = SAME && !SNAP && PREVIEW?.generation === GENERATION && this.#previewSelection.get(ENTITY.id) === GENERATION ? PLAN.fields.map((_, i) => this.#value(PREVIEW, i, nowMs)) : !SAME && !SNAP ? INITIAL ? INITIAL.values.slice() : seedFieldValues(PLAN.policies, TARGET.values) : TARGET.values.slice();
      if (this.#delayMs && SAME && !SNAP) {
        for (let i = 0; i < FROM.length; i++) {
          FROM[i] = OLD.target.values[i];
        }
      }
      const VELOCITY = this.#extrapolation ? new Array(PLAN.fields.length).fill(0) : null;
      for (let i = 0; i < PLAN.fields.length; i++) {
        const FIELD = PLAN.fields[i], VALUE = TARGET.values[i];
        if (RESET.has(i) && !this.#delayMs) {
          FROM[i] = VALUE;
        }
        if (!SAME && !SNAP && INITIAL && this.#extrapolation?.fields.has(FIELD.name) && typeof FROM[i] === "number" && typeof VALUE === "number") {
          if (!Number.isFinite(FROM[i] - VALUE)) {
            throw new RangeError("extrapolation correction overflow: " + FIELD.name);
          }
        }
        if (SAME && !SNAP && !RESET.has(i) && typeof VALUE === "number" && typeof OLD.target.values[i] === "number") {
          if (this.#delayMs) {
            FROM[i] = OLD.target.values[i];
          } else if (!PREVIEW || PREVIEW.generation !== GENERATION) {
            FROM[i] = this.#value(OLD, i, nowMs);
          }
          if (FIELD.code === RenderObject.DECAY && VALUE > OLD.target.values[i]) {
            FROM[i] = VALUE;
          }
          if (this.#extrapolation?.fields.has(FIELD.name)) {
            if (!isLinearField(FIELD.code)) {
              throw new TypeError("extrapolation requires LINEAR: " + FIELD.name);
            }
            const DELTA = TIME_MS - OLD.timeMs;
            if (DELTA > 0) {
              const DISTANCE = VALUE - OLD.target.values[i];
              VELOCITY[i] = !Number.isFinite(DELTA) ? (VALUE / 2 - OLD.target.values[i] / 2) / (TIME_MS / 2 - OLD.timeMs / 2) : !Number.isFinite(DISTANCE) ? (VALUE / 2 - OLD.target.values[i] / 2) / DELTA * 2 : DISTANCE / DELTA;
            } else {
              VELOCITY[i] = OLD.velocity[i];
            }
            if (!Number.isFinite(VELOCITY[i])) {
              throw new RangeError("extrapolation velocity overflow: " + FIELD.name);
            }
            if (!Number.isFinite(FROM[i] - VALUE)) {
              throw new RangeError("extrapolation correction overflow: " + FIELD.name);
            }
          }
        }
      }
      const TRACK = {
        id: ENTITY.id,
        generation: GENERATION,
        source: SOURCE,
        plan: PLAN,
        target: TARGET,
        from: FROM,
        velocity: VELOCITY,
        at: nowMs,
        timeMs: TIME_MS,
        model: SAME ? OLD.model : {},
        sampleValues: SAME ? OLD.sampleValues : void 0,
        sampledAt: -Infinity
      };
      let intervalStart;
      if (this.#delayMs) {
        intervalStart = bufferInterval(TRACK, OLD, {
          origin: ORIGIN,
          timeMs: TIME_MS,
          previousTimeMs: this.#timeMs,
          stepMs: this.#stepMs,
          continuous: SAME && !SNAP,
          reset: SNAP,
          seeded: !SNAP && (!!INITIAL || PLAN.policies.origins.some((i) => i !== void 0)),
          initialTimeMs: ENTITY.initialTimeMs
        });
        TRACK.initialShapes = SAME && !SNAP ? OLD.target.shapes : !SNAP && INITIAL ? INITIAL.shapes : TARGET.shapes;
        TRACK.heldFields = RESET;
        for (const NODE of PLAN.nodes) {
          if (NODE.field === void 0 && !Object.is(TRACK.initialShapes[NODE.index], TARGET.shapes[NODE.index])) {
            for (const INDEX of NODE.fields) {
              TRACK.heldFields.add(INDEX);
            }
          }
        }
        const PRIOR = SAME && !SNAP ? OLD.target.values : !SNAP && INITIAL ? INITIAL.values : TARGET.values;
        for (const INDEX of TRACK.heldFields) {
          FROM[INDEX] = PRIOR[INDEX];
        }
      }
      const PATH_START = this.#delayMs ? intervalStart : SAME && !SNAP ? OLD.timeMs : !SNAP && INITIAL ? ENTITY.initialTimeMs ?? TIME_MS - this.#stepMs : TIME_MS;
      TRACK.path = capturePath(
        PLAN.path,
        OLD?.path,
        FROM,
        TARGET.values,
        PATH_START,
        TIME_MS,
        ENTITY.pathPoints,
        !SAME || SNAP,
        this.#delayMs,
        this.#stepMs
      );
      NEXT.set(ENTITY.id, TRACK);
      SOURCES.set(SOURCE, TRACK);
    }
    if (!CHANGED && MODE === "continuous") {
      retainRemoved(NEXT, this.#tracks, {
        origin: ORIGIN,
        timeMs: TIME_MS,
        nowMs,
        delayMs: this.#delayMs
      });
    }
    this.#origin = ORIGIN;
    this.#frameSerial++;
    this.#tracks = NEXT;
    this.#sources = SOURCES;
    this.#preview = PREVIEWS;
    this.#previewSources = PREVIEW_SOURCES;
    this.#revision = REVISION;
    this.#sequence = SEQUENCE;
    this.#timeMs = TIME_MS;
    this.#now = nowMs;
    return true;
  }
  #value(track, index, now) {
    const FIELD = track.plan.fields[index], FROM = track.from[index], TO = track.target.values[index];
    if (FROM == null || TO == null || FIELD.kind === "discrete" || track.heldFields?.has(index)) {
      return track.buffered && now < track.at + track.durationMs ? FROM : TO;
    }
    const ALPHA = fraction2(track, now, track.durationMs ?? this.#stepMs);
    if (!track.preview && this.#extrapolation?.fields.has(FIELD.name)) {
      const AGE = Math.min(this.#extrapolation.maxMs, Math.max(0, now - track.at));
      const VALUE = evaluate("number", FROM, TO, ALPHA) + track.velocity[index] * AGE;
      if (!Number.isFinite(VALUE)) {
        throw new RangeError("extrapolated render value overflow: " + FIELD.name);
      }
      return VALUE;
    }
    if (FIELD.code === RenderObject.CYCLE) {
      if (ALPHA === 1) {
        return TO;
      }
      const VALUE = evaluate("number", FROM, TO < FROM ? TO + 1 : TO, ALPHA);
      return VALUE > 1 ? VALUE - 1 : VALUE;
    }
    return evaluate(FIELD.kind, FROM, TO, ALPHA);
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
        const VALUES = preview.sampleValues ??= new Array(preview.plan.fields.length);
        for (let i = 0; i < VALUES.length; i++) {
          VALUES[i] = this.#value(preview, i, nowMs);
        }
        writeRenderModel(preview.plan, preview.model, VALUES, preview.target.shapes);
        preview.sampledAt = nowMs;
        this.#models.set(preview.model, preview);
      }
      this.#now = nowMs;
      return preview.model;
    }
    const TRACK = this.#tracks.get(id);
    const AT = nowMs - this.#delayMs;
    const INTERVAL = this.#delayMs ? intervalAt(TRACK, AT) : TRACK;
    if (!INTERVAL || !TRACK || TRACK.generation !== generation) {
      this.#now = nowMs;
      return null;
    }
    if (TRACK.sampledAt !== nowMs) {
      const VALUES = TRACK.sampleValues ??= new Array(TRACK.plan.fields.length);
      for (let i = 0; i < VALUES.length; i++) {
        VALUES[i] = this.#value(INTERVAL, i, AT);
      }
      if (TRACK.plan.path) {
        const POINT = TRACK.pathHead ?? (TRACK.pathHead = {});
        pointAt(TRACK.path, AT - this.#origin, POINT);
        VALUES[TRACK.plan.path.x] = POINT.x;
        VALUES[TRACK.plan.path.y] = POINT.y;
      }
      writeRenderModel(
        TRACK.plan,
        TRACK.model,
        VALUES,
        INTERVAL.buffered && AT < INTERVAL.at + INTERVAL.durationMs ? INTERVAL.initialShapes : INTERVAL.target.shapes
      );
      TRACK.sampledAt = nowMs;
      this.#models.set(TRACK.model, TRACK);
    }
    this.#now = nowMs;
    return TRACK.model;
  }
  /** 등록된 원본 객체나 유효한 모델만 받습니다. 삭제·세대 변경된 모델은 다시 그리지 않습니다. */
  modelFor(source, nowMs) {
    this.#checkClock(nowMs);
    if (this.isModel(source)) {
      const OWNER = this.#models.get(source);
      return this.sample(OWNER.id, OWNER.generation, nowMs);
    }
    const PREVIEW = source && typeof source === "object" ? this.#previewSources.get(source) : null;
    if (PREVIEW && this.#previewSelection.get(PREVIEW.id) === PREVIEW.generation) {
      return this.sample(PREVIEW.id, PREVIEW.generation, nowMs);
    }
    const TRACK = this.#sources.get(source);
    if (TRACK) {
      return this.sample(TRACK.id, TRACK.generation, nowMs);
    }
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
    const SERIAL = ++this.#frameSerial, CHECK = () => {
      if (SERIAL !== this.#frameSerial) {
        throw new Error("Presentation frame expired");
      }
    };
    return Object.freeze({
      nowMs,
      timeMs: nowMs - this.#delayMs - this.#origin,
      sample: (id, generation) => {
        CHECK();
        return this.sample(id, generation, nowMs);
      },
      modelFor: (source) => {
        CHECK();
        return this.modelFor(source, nowMs);
      },
      forEach: (visit) => {
        CHECK();
        for (const [ID, TRACK] of this.#tracks) {
          const MODEL = this.sample(ID, TRACK.generation, nowMs);
          if (MODEL) {
            visit(MODEL, ID, TRACK.generation);
          }
        }
      },
      pathInto: (id, generation, out) => {
        CHECK();
        if (!Array.isArray(out)) {
          throw new TypeError("path output must be an array");
        }
        const TRACK = this.#tracks.get(id);
        if (!TRACK || TRACK.generation !== generation || !this.sample(id, generation, nowMs)) {
          out.length = 0;
          return out;
        }
        if (!TRACK.plan.path) {
          throw new Error("Declare renderPath before reading a path");
        }
        if (this.#preview.has(id) && this.#previewSelection.get(id) === generation) {
          throw new Error("Preview path is not supported; attach visuals to the selected model");
        }
        return samplePath(TRACK.path, nowMs - this.#delayMs - this.#origin, TRACK.plan.path.durationMs, out);
      }
    });
  }
  /** 정상적인 객체 메서드 호출입니다. this/프로토타입을 바꾸지 않습니다. */
  render(source, context, nowMs) {
    if (!(source instanceof RenderObject)) {
      throw new TypeError("render() requires a RenderObject");
    }
    const MODEL = this.modelFor(source, nowMs);
    if (!MODEL) {
      throw new Error("Render object has not been captured");
    }
    source.render(context, MODEL);
    return MODEL;
  }
};
export {
  InterpolationTimeline,
  PresentationRuntime,
  RenderObject,
  snapshotRenderModel
};

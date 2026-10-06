// packages/interpolation/src/schema.js
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

// packages/interpolation/src/tracks.js
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
function retarget(fields, old, target, generation, now, stepMs, snap) {
  const from = target.slice();
  if (old && old.generation === generation && !snap) {
    const alpha = fraction(old, now, stepMs);
    for (let i = 0; i < fields.length; i++) from[i] = evaluate(fields[i][1], old.from[i], old.target[i], alpha);
  }
  return { generation, from, target, startedAt: now };
}

// packages/interpolation/src/timeline.js
var InterpolationTimeline = class {
  #fields;
  #stepMs;
  #tracks = /* @__PURE__ */ new Map();
  #now = -Infinity;
  #revision = -1;
  #sequence = -1;
  #timeMs = -Infinity;
  /** @param {{schema:import('./schema.js').Schema, stepMs:number}} options */
  constructor({ schema, stepMs }) {
    this.#fields = compileSchema(schema);
    this.#stepMs = finite(stepMs, "stepMs");
    if (stepMs <= 0) throw new RangeError("stepMs must be positive");
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
   * timeMs is simulation time; nowMs is local receipt time. They are never subtracted.
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
    for (const entity of packet.entities) {
      if (!entity || typeof entity.id !== "string" || !entity.id.length) throw new TypeError("id must be a nonempty string");
      if (next.has(entity.id)) throw new TypeError("duplicate entity id");
      const generation = ordinal(entity.generation, "generation");
      if (entity.teleport !== void 0 && typeof entity.teleport !== "boolean") throw new TypeError("teleport must be boolean");
      const target = readValues(this.#fields, entity.values);
      const old = this.#tracks.get(entity.id);
      next.set(entity.id, retarget(this.#fields, old, target, generation, nowMs, this.#stepMs, changedRevision || entity.teleport === true));
    }
    this.#tracks = next;
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
    const track = this.#tracks.get(id);
    this.#now = nowMs;
    if (!track || track.generation !== generation) return false;
    const alpha = fraction(track, nowMs, this.#stepMs);
    for (let i = 0; i < this.#fields.length; i++) {
      const field = this.#fields[i];
      out[field[0]] = evaluate(field[1], track.from[i], track.target[i], alpha);
    }
    return true;
  }
};
export {
  InterpolationTimeline
};

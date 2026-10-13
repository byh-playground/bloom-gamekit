import { compileSchema, finite, ordinal, readValues, readResetFields } from './schema.js';
import { evaluate, fraction, retarget } from './tracks.js';

/** @typedef {{id:string, generation:number, values:Record<string,number|string|boolean|null>, teleport?:boolean, resetFields?:string[], initialValues?:Record<string,number|string|boolean|null>}} EntitySample */
/** @typedef {{revision:number, sequence:number, timeMs:number, entities:EntitySample[], mode?:'continuous'|'reset'|'load'|'rollback'}} Snapshot */
/**
 * A renderer-independent, full-snapshot presentation timeline.
 * The caller owns simulation, identity generations and the monotonic receipt/sample clock.
 */
export class InterpolationTimeline {
  #fields; #fieldIndices; #stepMs; #tracks = new Map(); #now = -Infinity;
  #delayMs; #origin = 0;
  #revision = -1; #sequence = -1; #timeMs = -Infinity;
  /** @param {{schema:import('./schema.js').Schema, stepMs:number}} options */
  constructor({ schema, stepMs, delayMs = 0 }) {
    this.#fields = compileSchema(schema);
    this.#fieldIndices = new Map(this.#fields.map((field, index) => [field[0], index]));
    this.#stepMs = finite(stepMs, 'stepMs');
    if (stepMs <= 0) throw new RangeError('stepMs must be positive');
    this.#delayMs=finite(delayMs,'delayMs');
    if(delayMs<0||delayMs>stepMs*16)throw new RangeError('delayMs must be between 0 and 16 steps');
  }
  get size() { return this.#tracks.size; }
  #checkClock(nowMs) {
    finite(nowMs, 'nowMs');
    if (nowMs < this.#now) throw new RangeError('presentation clock must not go backwards');
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
    if (!packet || typeof packet !== 'object') throw new TypeError('packet must be an object');
    const revision = ordinal(packet.revision, 'revision');
    const sequence = ordinal(packet.sequence, 'sequence');
    const timeMs = finite(packet.timeMs, 'timeMs');
    const mode = packet.mode ?? 'continuous';
    if (!['continuous', 'reset', 'load', 'rollback'].includes(mode)) throw new TypeError('unknown snapshot mode');
    if (revision < this.#revision || (revision === this.#revision && sequence <= this.#sequence)) return false;
    const changedRevision = revision !== this.#revision;
    if (this.#revision !== -1 && changedRevision && mode === 'continuous') throw new RangeError('new revision requires reset, load or rollback');
    if (!changedRevision && mode !== 'continuous') throw new RangeError('reset, load and rollback require a newer revision');
    if (!changedRevision && timeMs < this.#timeMs) return false;
    if (!Array.isArray(packet.entities)) throw new TypeError('entities must be an array');
    const next = new Map();
    const origin=changedRevision?nowMs-timeMs:this.#origin;
    for (const entity of packet.entities) {
      if (!entity || typeof entity.id !== 'string' || !entity.id.length) throw new TypeError('id must be a nonempty string');
      if (next.has(entity.id)) throw new TypeError('duplicate entity id');
      const generation = ordinal(entity.generation, 'generation');
      if (entity.teleport !== undefined && typeof entity.teleport !== 'boolean') throw new TypeError('teleport must be boolean');
      const target = readValues(this.#fields, entity.values);
      const initial = entity.initialValues === undefined ? null : readValues(this.#fields, entity.initialValues);
      const resetFields = readResetFields(this.#fieldIndices, entity.resetFields);
      const old = this.#tracks.get(entity.id);
      const snap = mode !== 'continuous' || entity.teleport === true;
      const track=retarget(this.#fields, old, target, generation, nowMs, this.#stepMs, snap, initial, resetFields);
      if(this.#delayMs>0){
        const continued=old&&old.generation===generation&&!snap&&!changedRevision;
        track.startedAt=origin+(continued?this.#timeMs:timeMs);
        track.durationMs=continued?Math.max(0,timeMs-this.#timeMs):0;
        if(continued){track.from=old.target.slice();if(resetFields)for(const i of resetFields)track.from[i]=target[i];}
        // Preserve completed intervals when several ticks arrive in the same callback.
        track.history=continued?[...(old.history??[]),old].slice(-Math.ceil(this.#delayMs/this.#stepMs)-2):[];
        // History stores flat intervals, never recursively retains past histories.
        track.history=track.history.map(({history,...interval})=>interval);
      }
      next.set(entity.id,track);
    }
    // Commit only after every entity has been validated and all new tracks prepared.
    this.#tracks = next; this.#origin=origin;
    this.#revision = revision; this.#sequence = sequence; this.#timeMs = timeMs; this.#now = nowMs;
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
    if (!out || typeof out !== 'object') throw new TypeError('out must be a writable object');
    let track = this.#tracks.get(id);
    this.#now = nowMs;
    if (!track || track.generation !== generation) return false;
    const sampleAt=nowMs-this.#delayMs;
    if(this.#delayMs>0&&sampleAt<track.startedAt){
      const history=track.history;
      track=history.find(interval=>sampleAt<=interval.startedAt+interval.durationMs)??history.at(-1)??track;
    }
    const alpha=track.durationMs===0?1:fraction(track,sampleAt,track.durationMs??this.#stepMs);
    for (let i = 0; i < this.#fields.length; i++) {
      const field = this.#fields[i];
      out[field[0]] = evaluate(field[1], track.from[i], track.target[i], alpha);
    }
    return true;
  }
}

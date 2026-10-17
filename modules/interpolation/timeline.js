import { bufferInterval, intervalAt, retainRemoved } from './intervals.js';
import { compileSchema, finite, ordinal, readValues, readResetFields } from './schema.js';
import { evaluate, fraction, retarget } from './tracks.js';

/** @typedef {{id:string, generation:number, values:Record<string,number|string|boolean|null>, teleport?:boolean, resetFields?:string[], initialTimeMs?:number, initialValues?:Record<string,number|string|boolean|null>}} EntitySample */
/** @typedef {{revision:number, sequence:number, timeMs:number, entities:EntitySample[], mode?:'continuous'|'reset'|'load'|'rollback'}} Snapshot */
/**
 * A renderer-independent, full-snapshot presentation timeline.
 * The caller owns simulation, identity generations and the monotonic receipt/sample clock.
 */
export class InterpolationTimeline {
    #fields;
    #fieldIndices;
    #stepMs;
    #tracks = new Map();
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
        this.#stepMs = finite(stepMs, 'stepMs');
        if (stepMs <= 0) {
            throw new RangeError('stepMs must be positive');
        }
        this.#delayMs = finite(delayMs, 'delayMs');
        if (delayMs < 0 || delayMs > stepMs * 16) {
            throw new RangeError('delayMs must be between 0 and 16 steps');
        }
    }
    get size() {
        return this.#tracks.size;
    }
    #checkClock(nowMs) {
        finite(nowMs, 'nowMs');
        if (nowMs < this.#now) {
            throw new RangeError('presentation clock must not go backwards');
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
        if (!packet || typeof packet !== 'object') {
            throw new TypeError('packet must be an object');
        }
        const REVISION = ordinal(packet.revision, 'revision');
        const SEQUENCE = ordinal(packet.sequence, 'sequence');
        const TIME_MS = finite(packet.timeMs, 'timeMs');
        const MODE = packet.mode ?? 'continuous';
        if (!['continuous', 'reset', 'load', 'rollback'].includes(MODE)) {
            throw new TypeError('unknown snapshot mode');
        }
        if (REVISION < this.#revision || (REVISION === this.#revision && SEQUENCE <= this.#sequence)) {
            return false;
        }
        const CHANGED_REVISION = REVISION !== this.#revision;
        if (this.#revision !== -1 && CHANGED_REVISION && MODE === 'continuous') {
            throw new RangeError('new revision requires reset, load or rollback');
        }
        if (!CHANGED_REVISION && MODE !== 'continuous') {
            throw new RangeError('reset, load and rollback require a newer revision');
        }
        if (!CHANGED_REVISION && TIME_MS < this.#timeMs) {
            return false;
        }
        if (!Array.isArray(packet.entities)) {
            throw new TypeError('entities must be an array');
        }
        const NEXT = new Map();
        const ORIGIN = CHANGED_REVISION ? nowMs - TIME_MS : this.#origin;
        for (const ENTITY of packet.entities) {
            if (!ENTITY || typeof ENTITY.id !== 'string' || !ENTITY.id.length) {
                throw new TypeError('id must be a nonempty string');
            }
            if (NEXT.has(ENTITY.id)) {
                throw new TypeError('duplicate entity id');
            }
            const GENERATION = ordinal(ENTITY.generation, 'generation');
            if (ENTITY.teleport !== undefined && typeof ENTITY.teleport !== 'boolean') {
                throw new TypeError('teleport must be boolean');
            }
            const TARGET = readValues(this.#fields, ENTITY.values);
            const INITIAL = ENTITY.initialValues === undefined ? null : readValues(this.#fields, ENTITY.initialValues);
            const RESET_FIELDS = readResetFields(this.#fieldIndices, ENTITY.resetFields);
            const OLD = this.#tracks.get(ENTITY.id);
            const SNAP = MODE !== 'continuous' || ENTITY.teleport === true;
            const TRACK = retarget(
                this.#fields,
                OLD,
                TARGET,
                GENERATION,
                nowMs,
                this.#stepMs,
                SNAP,
                INITIAL,
                RESET_FIELDS,
            );
            if (this.#delayMs > 0) {
                const CONTINUED =
                    OLD &&
                    OLD.generation === GENERATION &&
                    !SNAP &&
                    !CHANGED_REVISION &&
                    !Number.isFinite(OLD.removedAt);
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
                    initialTimeMs: ENTITY.initialTimeMs,
                });
            }
            NEXT.set(ENTITY.id, TRACK);
        }
        if (!CHANGED_REVISION && MODE === 'continuous') {
            retainRemoved(NEXT, this.#tracks, {
                origin: ORIGIN,
                timeMs: TIME_MS,
                nowMs,
                delayMs: this.#delayMs,
            });
        }
        // Commit only after every entity has been validated and all new tracks prepared.
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
        if (!out || typeof out !== 'object') {
            throw new TypeError('out must be a writable object');
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
            out[FIELD[0]] =
                this.#delayMs > 0 && FIELD[1] === 'discrete' && ALPHA < 1
                    ? track.from[i]
                    : evaluate(FIELD[1], track.from[i], track.target[i], ALPHA);
        }
        return true;
    }
}

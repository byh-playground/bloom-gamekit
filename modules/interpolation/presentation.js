import { bufferInterval, intervalAt, retainRemoved } from './intervals.js';
import { capturePath, pointAt, samplePath } from './path.js';
import { RenderObject } from './render-object.js';
import { compileRenderSchema, captureRenderData, writeRenderModel } from './render-schema.js';
import { finite, ordinal } from './schema.js';
import { evaluate } from './tracks.js';
import {
    isLinearField,
    inferFieldResets,
    inferStateResets,
    positionDiscontinuity,
    seedFieldValues,
} from './render-policies.js';
function fraction(track, now, stepMs) {
    return stepMs === 0 ? 1 : Math.min(1, Math.max(0, (now - track.at) / stepMs));
}

/**
 * 선언 필드만 소유하는 표시 계층. 시뮬/입력/자체 타이머 없이 일반 중첩 모델을 제공합니다.
 * capture packet은 전체 생존 목록이며 기존 timeline과 같은 revision/sequence 계약입니다.
 */
export class PresentationRuntime {
    #stepMs;
    #tracks = new Map();
    #sources = new WeakMap();
    #models = new WeakMap();
    #preview = new Map();
    #previewSelection = new Map();
    #previewSources = new WeakMap();
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
        captures: 0,
    };
    #extrapolation;
    #snapDistance;
    #delayMs;
    #origin = 0;
    #frameSerial = 0;

    /** @param {{stepMs:number, delayMs?:number, snapDistance?:number, extrapolation?:{fields:string[],maxMs:number}}} options */
    constructor({ stepMs, snapDistance, extrapolation, delayMs = 0 } = {}) {
        this.#stepMs = finite(stepMs, 'stepMs');
        this.#delayMs = finite(delayMs, 'delayMs');
        if (delayMs < 0 || delayMs > stepMs * 16) {
            throw new RangeError('delayMs must be between 0 and 16 steps');
        }
        if (delayMs && extrapolation) {
            throw new TypeError('delayed authority cannot also extrapolate');
        }
        if (stepMs <= 0) {
            throw new RangeError('stepMs must be positive');
        }
        if (snapDistance !== undefined && finite(snapDistance, 'snapDistance') <= 0) {
            throw new RangeError('snapDistance must be positive');
        }
        this.#snapDistance = snapDistance;
        if (extrapolation) {
            if (
                !Array.isArray(extrapolation.fields) ||
                new Set(extrapolation.fields).size !== extrapolation.fields.length ||
                Array.from(extrapolation.fields).some((x) => typeof x !== 'string')
            ) {
                throw new TypeError('extrapolation.fields must be unique paths');
            }
            if (finite(extrapolation.maxMs, 'maxMs') <= 0) {
                throw new RangeError('maxMs must be positive');
            }
            if (extrapolation.maxMs < stepMs) {
                throw new RangeError('maxMs must cover the correction stepMs');
            }
            this.#extrapolation = {
                fields: new Set(extrapolation.fields),
                maxMs: extrapolation.maxMs,
            };
        }
    }
    get size() {
        return this.#tracks.size;
    }
    get previewMetrics() {
        return {
            ...this.#previewMetrics,
        };
    }
    /** Select game-owned local identities only; remote authoritative tracks remain unchanged. */
    selectPreview(identities) {
        if (!Array.isArray(identities)) {
            throw new TypeError('preview identities must be an array');
        }
        const NEXT = new Map();
        for (const IDENTITY of identities) {
            if (
                !IDENTITY ||
                typeof IDENTITY.id !== 'string' ||
                !IDENTITY.id ||
                !Number.isSafeInteger(IDENTITY.generation) ||
                IDENTITY.generation < 0 ||
                NEXT.has(IDENTITY.id)
            ) {
                throw new TypeError('invalid preview identity');
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
        this.#previewSources = new WeakMap();
    }
    releasePreview(nowMs) {
        this.#checkClock(nowMs);
        if (this.#delayMs) {
            // Keep a separate local handoff until the buffered clock reaches this
            // checkpoint. Rewriting its historical interval would also corrupt remote
            // shapes/paths; immediately exposing it would rewind the local body.
            for (const [ID, PREVIEW] of this.#preview) {
                if (PREVIEW.releaseAt !== undefined) {
                    continue;
                }
                const TRACK = this.#tracks.get(ID);
                if (!TRACK || TRACK.generation !== PREVIEW.generation) {
                    continue;
                }
                const FROM = PREVIEW.plan.fields.map((_, i) => this.#value(PREVIEW, i, nowMs)),
                    RESET = new Set();
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
                    sampledAt: -Infinity,
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
            const TYPE = entity.type ?? entity.source.constructor,
                PLAN = compileRenderSchema(TYPE),
                DATA = captureRenderData(PLAN, entity.source);
            return {
                id: entity.id,
                generation: entity.generation,
                type: TYPE,
                source: writeRenderModel(PLAN, {}, DATA.values, DATA.shapes),
            };
        });
    }
    /** Publish immediate schema-only local fork models. This never replaces authoritative tracks. */
    capturePreview(packet, nowMs) {
        const STARTED = performance.now();
        let bytes = 0;
        this.#checkClock(nowMs);
        if (!packet || !Array.isArray(packet.entities)) {
            throw new TypeError('preview packet entities');
        }
        const REVISION = ordinal(packet.revision, 'preview revision'),
            SEQUENCE = ordinal(packet.sequence, 'preview sequence'),
            TIME_MS = finite(packet.timeMs, 'preview timeMs');
        if (
            REVISION !== this.#revision ||
            REVISION < this.#previewRevision ||
            (REVISION === this.#previewRevision && SEQUENCE <= this.#previewSequence) ||
            TIME_MS < this.#previewTimeMs
        ) {
            return false;
        }
        if (TIME_MS < this.#now) {
            return false;
        }
        const NEXT = new Map(),
            SOURCES = new WeakMap();
        for (const ENTITY of packet.entities) {
            if (
                !ENTITY ||
                typeof ENTITY.id !== 'string' ||
                !ENTITY.id ||
                !Number.isSafeInteger(ENTITY.generation) ||
                ENTITY.generation < 0 ||
                NEXT.has(ENTITY.id)
            ) {
                throw new TypeError('invalid preview entity');
            }
            if (this.#previewSelection.get(ENTITY.id) !== ENTITY.generation) {
                continue;
            }
            if (!ENTITY.source || typeof ENTITY.source !== 'object') {
                throw new TypeError('preview source required');
            }
            const PLAN = compileRenderSchema(ENTITY.type ?? ENTITY.source.constructor),
                AUTHORITY = this.#tracks.get(ENTITY.id);
            if (!AUTHORITY || AUTHORITY.generation !== ENTITY.generation || AUTHORITY.plan !== PLAN) {
                throw new TypeError('preview must match a live authoritative render identity and schema');
            }
            const DATA = captureRenderData(PLAN, ENTITY.source),
                OLD = this.#preview.get(ENTITY.id);
            const INITIAL = ENTITY.initialSource ? captureRenderData(PLAN, ENTITY.initialSource) : AUTHORITY.target;
            const SAME = OLD && OLD.generation === ENTITY.generation && OLD.plan === PLAN;
            const FROM = SAME
                ? PLAN.fields.map((_, i) => this.#value(OLD, i, nowMs))
                : PLAN.fields.map((_, i) => this.#value(AUTHORITY, i, nowMs));
            // Preview uses receipt time, but STATE_KEY still marks a semantic boundary.
            // Do not connect a prior displayed pose across that boundary on fork replay.
            const RESET = new Set();
            inferStateResets(PLAN.policies, SAME ? OLD.target : INITIAL, DATA, RESET);
            for (const INDEX of RESET) {
                FROM[INDEX] = DATA.values[INDEX];
            }
            const AT = SAME ? nowMs : Math.min(nowMs, finite(packet.phaseStartMs ?? nowMs, 'phaseStartMs'));
            const END = Math.max(
                nowMs + 1,
                finite(packet.phaseStartMs ?? nowMs, 'phaseStartMs') + (packet.stepMs ?? this.#stepMs),
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
                sampleValues: SAME ? OLD.sampleValues : undefined,
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
        finite(now, 'nowMs');
        if (now < this.#now) {
            throw new RangeError('presentation clock must not go backwards');
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
        if (!packet || typeof packet !== 'object') {
            throw new TypeError('packet must be an object');
        }
        const REVISION = ordinal(packet.revision, 'revision'),
            SEQUENCE = ordinal(packet.sequence, 'sequence'),
            TIME_MS = finite(packet.timeMs, 'timeMs');
        const MODE = packet.mode ?? 'continuous';
        if (!['continuous', 'reset', 'load', 'rollback'].includes(MODE)) {
            throw new TypeError('unknown capture mode');
        }
        if (REVISION < this.#revision || (REVISION === this.#revision && SEQUENCE <= this.#sequence)) {
            return false;
        }
        const CHANGED = REVISION !== this.#revision;
        if (this.#revision >= 0 && CHANGED && MODE === 'continuous') {
            throw new RangeError('new revision requires reset, load or rollback');
        }
        if (!CHANGED && MODE !== 'continuous') {
            throw new RangeError('reset, load and rollback require a newer revision');
        }
        if (!CHANGED && TIME_MS < this.#timeMs) {
            return false;
        }
        if (!Array.isArray(packet.entities)) {
            throw new TypeError('entities must be an array');
        }
        const ORIGIN = CHANGED ? nowMs - TIME_MS : this.#origin;
        const NEXT = new Map(),
            SOURCES = new WeakMap(),
            PREVIEWS = new Map(),
            PREVIEW_SOURCES = new WeakMap();
        for (const ENTITY of packet.entities) {
            if (!ENTITY || typeof ENTITY.id !== 'string' || !ENTITY.id || NEXT.has(ENTITY.id)) {
                throw new TypeError('entity IDs must be nonempty and unique');
            }
            const GENERATION = ordinal(ENTITY.generation, 'generation'),
                SOURCE = ENTITY.source;
            if (!SOURCE || typeof SOURCE !== 'object' || SOURCES.has(SOURCE)) {
                throw new TypeError('entity sources must be unique objects');
            }
            if (ENTITY.teleport !== undefined && typeof ENTITY.teleport !== 'boolean') {
                throw new TypeError('teleport must be boolean');
            }
            const PLAN = compileRenderSchema(ENTITY.type ?? SOURCE.constructor);
            if (this.#extrapolation) {
                for (const FIELD of PLAN.fields) {
                    if (this.#extrapolation.fields.has(FIELD.name) && !isLinearField(FIELD.code)) {
                        throw new TypeError('extrapolation requires LINEAR: ' + FIELD.name);
                    }
                }
            }
            const TARGET = captureRenderData(PLAN, SOURCE);
            const INITIAL = ENTITY.initialSource === undefined ? null : captureRenderData(PLAN, ENTITY.initialSource);
            const RESET = new Set();
            if (ENTITY.resetFields !== undefined) {
                if (!Array.isArray(ENTITY.resetFields)) {
                    throw new TypeError('resetFields must be an array');
                }
                for (const NAME of ENTITY.resetFields) {
                    const INDEX = PLAN.indices.get(NAME);
                    if (INDEX === undefined || RESET.has(INDEX)) {
                        throw new TypeError('resetFields must contain unique declared paths');
                    }
                    RESET.add(INDEX);
                }
            }
            const OLD = this.#tracks.get(ENTITY.id),
                PREVIEW = this.#preview.get(ENTITY.id);
            const SAME =
                MODE === 'continuous' &&
                OLD &&
                OLD.generation === GENERATION &&
                OLD.plan === PLAN &&
                !Number.isFinite(OLD.removedAt);
            const SNAP =
                MODE !== 'continuous' ||
                ENTITY.teleport === true ||
                (!!SAME && positionDiscontinuity(PLAN.policies, OLD, TARGET, this.#snapDistance));
            if (this.#delayMs && SAME && !SNAP && PREVIEW?.generation === GENERATION && PREVIEW.plan === PLAN) {
                PREVIEWS.set(ENTITY.id, PREVIEW);
                PREVIEW_SOURCES.set(PREVIEW.source, PREVIEW);
            }
            if (SAME && !SNAP) {
                inferFieldResets(PLAN.policies, OLD, TARGET, TIME_MS, RESET);
            }
            const FROM =
                SAME &&
                !SNAP &&
                PREVIEW?.generation === GENERATION &&
                this.#previewSelection.get(ENTITY.id) === GENERATION
                    ? PLAN.fields.map((_, i) => this.#value(PREVIEW, i, nowMs))
                    : !SAME && !SNAP
                      ? INITIAL
                          ? INITIAL.values.slice()
                          : seedFieldValues(PLAN.policies, TARGET.values)
                      : TARGET.values.slice();
            if (this.#delayMs && SAME && !SNAP) {
                for (let i = 0; i < FROM.length; i++) {
                    FROM[i] = OLD.target.values[i];
                }
            }
            const VELOCITY = this.#extrapolation ? new Array(PLAN.fields.length).fill(0) : null;
            for (let i = 0; i < PLAN.fields.length; i++) {
                const FIELD = PLAN.fields[i],
                    VALUE = TARGET.values[i];
                // Buffered state changes occur at the target simulation time, not receipt time.
                if (RESET.has(i) && !this.#delayMs) {
                    FROM[i] = VALUE;
                }
                if (
                    !SAME &&
                    !SNAP &&
                    INITIAL &&
                    this.#extrapolation?.fields.has(FIELD.name) &&
                    typeof FROM[i] === 'number' &&
                    typeof VALUE === 'number'
                ) {
                    if (!Number.isFinite(FROM[i] - VALUE)) {
                        throw new RangeError('extrapolation correction overflow: ' + FIELD.name);
                    }
                }
                if (
                    SAME &&
                    !SNAP &&
                    !RESET.has(i) &&
                    typeof VALUE === 'number' &&
                    typeof OLD.target.values[i] === 'number'
                ) {
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
                            throw new TypeError('extrapolation requires LINEAR: ' + FIELD.name);
                        }
                        const DELTA = TIME_MS - OLD.timeMs;
                        if (DELTA > 0) {
                            const DISTANCE = VALUE - OLD.target.values[i];
                            VELOCITY[i] = !Number.isFinite(DELTA)
                                ? (VALUE / 2 - OLD.target.values[i] / 2) / (TIME_MS / 2 - OLD.timeMs / 2)
                                : !Number.isFinite(DISTANCE)
                                  ? ((VALUE / 2 - OLD.target.values[i] / 2) / DELTA) * 2
                                  : DISTANCE / DELTA;
                        } else {
                            VELOCITY[i] = OLD.velocity[i];
                        }
                        if (!Number.isFinite(VELOCITY[i])) {
                            throw new RangeError('extrapolation velocity overflow: ' + FIELD.name);
                        }
                        if (!Number.isFinite(FROM[i] - VALUE)) {
                            throw new RangeError('extrapolation correction overflow: ' + FIELD.name);
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
                sampleValues: SAME ? OLD.sampleValues : undefined,
                sampledAt: -Infinity,
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
                    seeded: !SNAP && (!!INITIAL || PLAN.policies.origins.some((i) => i !== undefined)),
                    initialTimeMs: ENTITY.initialTimeMs,
                });
                TRACK.initialShapes =
                    SAME && !SNAP ? OLD.target.shapes : !SNAP && INITIAL ? INITIAL.shapes : TARGET.shapes;
                // Shape and descendants are one state. Holding only the old shape with reset
                // target fields can expose {}, or interpolate fields from different phases.
                TRACK.heldFields = RESET;
                for (const NODE of PLAN.nodes) {
                    if (
                        NODE.field === undefined &&
                        !Object.is(TRACK.initialShapes[NODE.index], TARGET.shapes[NODE.index])
                    ) {
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
            const PATH_START = this.#delayMs
                ? intervalStart
                : SAME && !SNAP
                  ? OLD.timeMs
                  : !SNAP && INITIAL
                    ? (ENTITY.initialTimeMs ?? TIME_MS - this.#stepMs)
                    : TIME_MS;
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
                this.#stepMs,
            );
            NEXT.set(ENTITY.id, TRACK);
            SOURCES.set(SOURCE, TRACK);
        }
        if (!CHANGED && MODE === 'continuous') {
            retainRemoved(NEXT, this.#tracks, {
                origin: ORIGIN,
                timeMs: TIME_MS,
                nowMs,
                delayMs: this.#delayMs,
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
        const FIELD = track.plan.fields[index],
            FROM = track.from[index],
            TO = track.target.values[index];
        if (FROM == null || TO == null || FIELD.kind === 'discrete' || track.heldFields?.has(index)) {
            return track.buffered && now < track.at + track.durationMs ? FROM : TO;
        }
        const ALPHA = fraction(track, now, track.durationMs ?? this.#stepMs);
        if (!track.preview && this.#extrapolation?.fields.has(FIELD.name)) {
            const AGE = Math.min(this.#extrapolation.maxMs, Math.max(0, now - track.at));
            // 같은 표현이지만 to + (from-to)는 큰 목표에서 작은 from을 잃습니다.
            const VALUE = evaluate('number', FROM, TO, ALPHA) + track.velocity[index] * AGE;
            if (!Number.isFinite(VALUE)) {
                throw new RangeError('extrapolated render value overflow: ' + FIELD.name);
            }
            return VALUE;
        }
        if (FIELD.code === RenderObject.CYCLE) {
            if (ALPHA === 1) {
                return TO;
            }
            const VALUE = evaluate('number', FROM, TO < FROM ? TO + 1 : TO, ALPHA);
            return VALUE > 1 ? VALUE - 1 : VALUE;
        }
        return evaluate(FIELD.kind, FROM, TO, ALPHA);
    }

    /** 유효 identity가 아니면 null. 원본 fallback은 없습니다. 모델은 프레임 간 재사용됩니다. */
    sample(id, generation, nowMs) {
        this.#checkClock(nowMs);
        let preview = this.#preview.get(id);
        if (preview?.releaseAt !== undefined && nowMs >= preview.releaseAt) {
            this.#preview.delete(id);
            preview = null;
        }
        if (preview && preview.generation === generation && this.#previewSelection.get(id) === generation) {
            if (preview.sampledAt !== nowMs) {
                const VALUES = (preview.sampleValues ??= new Array(preview.plan.fields.length));
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
            const VALUES = (TRACK.sampleValues ??= new Array(TRACK.plan.fields.length));
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
                INTERVAL.buffered && AT < INTERVAL.at + INTERVAL.durationMs
                    ? INTERVAL.initialShapes
                    : INTERVAL.target.shapes,
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
        const PREVIEW = source && typeof source === 'object' ? this.#previewSources.get(source) : null;
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
        const SERIAL = ++this.#frameSerial,
            CHECK = () => {
                if (SERIAL !== this.#frameSerial) {
                    throw new Error('Presentation frame expired');
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
                    throw new TypeError('path output must be an array');
                }
                const TRACK = this.#tracks.get(id);
                if (!TRACK || TRACK.generation !== generation || !this.sample(id, generation, nowMs)) {
                    out.length = 0;
                    return out;
                }
                if (!TRACK.plan.path) {
                    throw new Error('Declare renderPath before reading a path');
                }
                if (this.#preview.has(id) && this.#previewSelection.get(id) === generation) {
                    throw new Error('Preview path is not supported; attach visuals to the selected model');
                }
                return samplePath(TRACK.path, nowMs - this.#delayMs - this.#origin, TRACK.plan.path.durationMs, out);
            },
        });
    }

    /** 정상적인 객체 메서드 호출입니다. this/프로토타입을 바꾸지 않습니다. */
    render(source, context, nowMs) {
        if (!(source instanceof RenderObject)) {
            throw new TypeError('render() requires a RenderObject');
        }
        const MODEL = this.modelFor(source, nowMs);
        if (!MODEL) {
            throw new Error('Render object has not been captured');
        }
        source.render(context, MODEL);
        return MODEL;
    }
}

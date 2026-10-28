const MAX_PARTS = 16;
const POSE_WIDTH = MAX_PARTS * 3;
const OVERRIDE_WIDTH = MAX_PARTS * 2;
const PROGRAM_WIDTH = 256;
const OWNERS = new WeakMap();
/** The PoseRenderer that issued a pose handle, so any renderer can resolve and submit it. */
export function poseRendererOf(handle) {
    return OWNERS.get(handle) ?? null;
}
/** Numeric animation data and stable player rows. Visible draws keep caller order. */
export class PoseRenderer {
    constructor(device, { backend = 'auto', onBoundary = () => {} } = {}) {
        if (!['auto', 'cpu', 'uniform'].includes(backend)) {
            throw new TypeError('poseBackend must be auto, cpu or uniform');
        }
        this.device = device;
        this.backend = backend;
        this.onBoundary = onBoundary;
        this.sources = new Map();
        this.instances = new Map();
        this.rows = [];
        this.freeRows = [];
        this.capacity = 0;
        this.programTexture = null;
        this.stateTexture = null;
        this.overrideTexture = null;
        this.cpuTexture = null;
        this.frameMetrics = {};
        this.pendingUpdates = false;
        this.disposed = false;
        // Keyframes are evaluated inside the mesh vertex shader, so no float render target is required.
        this.gpuUnavailableReason = backend !== 'auto' ? 'cpuRequested' : null;
        this.onRestored = () => {
            for (const RECORD of this.instances.values()) {
                RECORD.stateDirty = true;
                RECORD.overrideDirty = true;
                RECORD.cpuDirty = RECORD.mode === 'cpu';
                RECORD.usedFrame = -1;
            }
            this.pendingUpdates = true;
        };
        device.canvas.addEventListener('webglcontextrestored', this.onRestored);
        this.beginFrame();
    }
    _ready() {
        if (this.disposed) {
            throw new Error('Pose renderer is disposed');
        }
    }
    beginFrame() {
        this.frameMetrics = {
            gpuDrawInstances: 0,
            cpuDrawInstances: 0,
            uniformDrawInstances: 0,
            cpuPoseUploadBytes: 0,
            stateUploadBytes: 0,
            overrideUploadBytes: 0,
            fallbackReasons: Object.create(null),
            flushCalls: 0,
            flushRecordVisits: 0,
            cleanFlushSkips: 0,
        };
    }
    _boundary() {
        if (this.device.active) {
            this.onBoundary();
        }
    }
    createSource(program) {
        this._ready();
        if (this.backend === 'uniform') {
            return null;
        }
        if (
            !program ||
            !(program.data instanceof Float32Array) ||
            !Number.isSafeInteger(program.partCount) ||
            program.partCount < 1 ||
            program.partCount > MAX_PARTS ||
            program.data.length % 4
        ) {
            throw new TypeError('A compiled pose channel program with 1..16 parts is required');
        }
        this._boundary();
        const HANDLE = Object.freeze({});
        this.sources.set(HANDLE, { program, offset: 0 });
        try {
            this._rebuildPrograms();
        } catch (error) {
            this.sources.delete(HANDLE);
            throw error;
        }
        return HANDLE;
    }
    _rebuildPrograms() {
        let length = 0;
        const OFFSETS = new Map();
        for (const SOURCE of this.sources.values()) {
            OFFSETS.set(SOURCE, length / 4);
            length += SOURCE.program.data.length;
        }
        if (!length) {
            if (this.programTexture) {
                this.device.deleteTexture(this.programTexture);
                this.programTexture = null;
            }
            return;
        }
        const WIDTH = Math.min(PROGRAM_WIDTH, this.device.maxTextureSize);
        const HEIGHT = Math.ceil(length / (WIDTH * 4));
        if (HEIGHT > this.device.maxTextureSize) {
            throw new RangeError('Pose programs exceed data texture capacity');
        }
        const DATA = new Float32Array(WIDTH * HEIGHT * 4);
        for (const SOURCE of this.sources.values()) {
            DATA.set(SOURCE.program.data, OFFSETS.get(SOURCE) * 4);
        }
        const TEXTURE = this.device.createDataTexture(WIDTH, HEIGHT, { data: DATA });
        // Commit offsets only after the replacement texture owns the matching bytes.
        for (const [SOURCE, OFFSET] of OFFSETS) {
            SOURCE.offset = OFFSET;
        }
        if (this.programTexture) {
            this.device.deleteTexture(this.programTexture);
        }
        this.programTexture = TEXTURE;
        // Rows carry their source offset, so a compacted program texture must refresh them.
        for (const RECORD of this.instances.values()) {
            if (this.stateData) {
                this.stateData[RECORD.row * 8 + 7] = this.sources.get(RECORD.source).offset;
            }
            RECORD.stateDirty = true;
        }
        this.pendingUpdates = true;
    }
    deleteSource(handle) {
        if (!this.sources.has(handle)) {
            return false;
        }
        if ([...this.instances.values()].some((record) => record.source === handle)) {
            throw new Error('Dispose pose instances before their source');
        }
        this._boundary();
        this.sources.delete(handle);
        // Releasing an asset must not allocate a replacement texture. Live offsets
        // remain valid; the next registration compacts holes transactionally.
        if (!this.sources.size && this.programTexture) {
            this.device.deleteTexture(this.programTexture);
            this.programTexture = null;
        }
        return true;
    }
    _releaseAtlas() {
        for (const KEY of ['stateTexture', 'overrideTexture', 'cpuTexture']) {
            if (this[KEY]) {
                this.device.deleteTexture(this[KEY]);
                this[KEY] = null;
            }
        }
        this.stateData = null;
        this.overrideData = null;
        this.cpuData = null;
    }
    _ensureCapacity(required) {
        if (required <= this.capacity) {
            return;
        }
        if (required > this.device.maxTextureSize) {
            throw new RangeError('Pose instance rows exceed GPU texture capacity');
        }
        this._boundary();
        const CAPACITY = Math.min(this.device.maxTextureSize, Math.max(32, this.capacity * 2, required));
        const STATE = new Float32Array(CAPACITY * 8);
        const OVERRIDES = new Float32Array(CAPACITY * OVERRIDE_WIDTH * 4);
        const CPU = new Float32Array(CAPACITY * POSE_WIDTH * 4);
        if (this.capacity) {
            STATE.set(this.stateData);
            OVERRIDES.set(this.overrideData);
            CPU.set(this.cpuData);
        }
        let stateTexture = null;
        let overrideTexture = null;
        try {
            stateTexture = this.device.createDataTexture(2, CAPACITY, { data: STATE });
            overrideTexture = this.device.createDataTexture(OVERRIDE_WIDTH, CAPACITY, { data: OVERRIDES });
        } catch (error) {
            for (const TEXTURE of [stateTexture, overrideTexture]) {
                if (TEXTURE) {
                    this.device.deleteTexture(TEXTURE);
                }
            }
            throw error;
        }
        this._releaseAtlas();
        this.capacity = CAPACITY;
        this.stateData = STATE;
        this.overrideData = OVERRIDES;
        this.cpuData = CPU;
        this.stateTexture = stateTexture;
        this.overrideTexture = overrideTexture;
        for (const RECORD of this.instances.values()) {
            RECORD.stateDirty = true;
            RECORD.overrideDirty = true;
            RECORD.cpuDirty = RECORD.mode === 'cpu';
        }
        this.pendingUpdates = true;
    }
    createInstance(source) {
        this._ready();
        const SOURCE = this.sources.get(source);
        if (!SOURCE) {
            throw new TypeError('A pose source owned by this renderer is required');
        }
        const ROW = this.freeRows.length ? this.freeRows.pop() : this.rows.length;
        this._ensureCapacity(ROW + 1);
        const HANDLE = Object.freeze({});
        const RECORD = {
            source,
            row: ROW,
            mode: null,
            stateDirty: true,
            overrideDirty: true,
            cpuDirty: false,
            usedFrame: -1,
            reason: null,
            baseScratch: new Float32Array(OVERRIDE_WIDTH * 4),
        };
        this.instances.set(HANDLE, RECORD);
        OWNERS.set(HANDLE, this);
        this.rows[ROW] = RECORD;
        this.pendingUpdates = true;
        return HANDLE;
    }
    deleteInstance(handle) {
        const RECORD = this.instances.get(handle);
        if (!RECORD) {
            return false;
        }
        this._boundary();
        this.instances.delete(handle);
        this.rows[RECORD.row] = null;
        this.freeRows.push(RECORD.row);
        if (!this.instances.size) {
            this._releaseAtlas();
            this.capacity = 0;
            this.rows = [];
            this.freeRows = [];
        }
        return true;
    }
    _instance(handle) {
        this._ready();
        const RECORD = this.instances.get(handle);
        if (!RECORD) {
            throw new TypeError('A live pose instance owned by this renderer is required');
        }
        return RECORD;
    }
    prepare(handle, { clipName, elapsedMs, basePoses, visible, excluded = [], morph }) {
        const RECORD = this._instance(handle);
        const SOURCE = this.sources.get(RECORD.source);
        const CLIP = SOURCE.program.clips[clipName];
        if (this.gpuUnavailableReason || !CLIP?.supported) {
            return null;
        }
        if (
            !Number.isFinite(elapsedMs) ||
            basePoses.length !== SOURCE.program.partCount ||
            visible.length !== basePoses.length ||
            !morph ||
            morph.length !== 2 ||
            !morph.every(Number.isFinite)
        ) {
            throw new TypeError('Finite pose time, matching part overrides and two morph values required');
        }
        // Reduce only the display clock before Float32 storage, never CPU-evaluate a pose.
        // This keeps long-running sessions from losing sub-frame time precision.
        const CYCLE = CLIP.durationMs * (CLIP.loop === 'alternate' ? 2 : 1);
        const LOCAL_TIME =
            CLIP.loop === 'once'
                ? Math.min(CLIP.durationMs, Math.max(0, elapsedMs))
                : ((elapsedMs % CYCLE) + CYCLE) % CYCLE;
        const EXCLUDED = excluded.reduce((mask, value, index) => (value ? mask | (1 << index) : mask), 0);
        const STATE = [
            CLIP.headerBase,
            LOCAL_TIME,
            CLIP.loop === 'once' ? 0 : CLIP.loop === 'repeat' ? 1 : 2,
            CLIP.durationMs,
            morph[0],
            morph[1],
            EXCLUDED,
            // Slot 7: where this source's keyframes start in the shared program texture.
            SOURCE.offset,
        ];
        const BASE = RECORD.baseScratch;
        for (let i = 0; i < basePoses.length; i++) {
            const POSE = basePoses[i];
            const OFFSET_LOCAL = i * 8;
            BASE[OFFSET_LOCAL] = POSE.x;
            BASE[OFFSET_LOCAL + 1] = POSE.y;
            BASE[OFFSET_LOCAL + 2] = POSE.rotation;
            BASE[OFFSET_LOCAL + 3] = POSE.scaleX;
            BASE[OFFSET_LOCAL + 4] = POSE.scaleY;
            BASE[OFFSET_LOCAL + 5] = POSE.opacity;
            BASE[OFFSET_LOCAL + 6] = visible[i] ? 1 : 0;
            BASE[OFFSET_LOCAL + 7] = 0;
        }
        const OFFSET = RECORD.row * 8;
        const BASE_OFFSET = RECORD.row * OVERRIDE_WIDTH * 4;
        const STATE_CHANGED = STATE.some((value, index) => Math.fround(value) !== this.stateData[OFFSET + index]);
        const BASE_CHANGED = BASE.some((value, index) => value !== this.overrideData[BASE_OFFSET + index]);
        if ((STATE_CHANGED || BASE_CHANGED || RECORD.mode !== 'gpu') && RECORD.usedFrame === this.device.stats.frame) {
            this._boundary();
        }
        if (STATE_CHANGED) {
            this.stateData.set(STATE, OFFSET);
            RECORD.stateDirty = true;
        }
        if (BASE_CHANGED) {
            this.overrideData.set(BASE, BASE_OFFSET);
            RECORD.overrideDirty = true;
        }
        this.pendingUpdates ||= STATE_CHANGED || BASE_CHANGED;
        RECORD.mode = 'gpu';
        RECORD.reason = null;
        return handle;
    }
    prepareCpu(handle, parts, morph, reason) {
        const RECORD = this._instance(handle);
        const PART_COUNT = this.sources.get(RECORD.source).program.partCount;
        if (!Array.isArray(parts) || parts.length !== PART_COUNT || !morph || morph.length !== 2) {
            throw new TypeError('Matching CPU part poses and morph weights required');
        }
        if (RECORD.usedFrame === this.device.stats.frame) {
            this._boundary();
        }
        const OFFSET = RECORD.row * POSE_WIDTH * 4;
        for (let i = 0; i < PART_COUNT; i++) {
            const POSE = parts[i];
            const MATRIX = POSE.transform;
            this.cpuData.set(
                [
                    MATRIX[0],
                    MATRIX[2],
                    MATRIX[4],
                    0,
                    MATRIX[1],
                    MATRIX[3],
                    MATRIX[5],
                    0,
                    morph[0] + (POSE.morph?.[0] ?? 0),
                    morph[1] + (POSE.morph?.[1] ?? 0),
                    POSE.visible === false ? 0 : (POSE.opacity ?? 1),
                    POSE.depth ?? 0,
                ],
                OFFSET + i * 12,
            );
        }
        RECORD.mode = 'cpu';
        RECORD.reason = reason;
        RECORD.cpuDirty = true;
        this.pendingUpdates = true;
        return handle;
    }
    resolve(handle) {
        const RECORD = this._instance(handle);
        if (!RECORD.mode) {
            throw new Error('Prepare a player pose before drawing');
        }
        if (RECORD.mode === 'cpu' && !this.cpuTexture) {
            this.cpuTexture = this.device.createDataTexture(POSE_WIDTH, this.capacity, { data: this.cpuData });
            for (const ROW of this.instances.values()) {
                ROW.cpuDirty = false;
            }
        }
        const PART_COUNT = this.sources.get(RECORD.source).program.partCount;
        if (RECORD.mode === 'gpu') {
            // The vertex shader reads keyframes (program), playback state and per-part overrides directly.
            return {
                row: RECORD.row,
                kind: 'program',
                texture: this.programTexture,
                textures: [this.programTexture, this.stateTexture, this.overrideTexture],
                programWidth: this.programTexture.width,
                partCount: PART_COUNT,
            };
        }
        return {
            row: RECORD.row,
            kind: 'matrix',
            texture: this.cpuTexture,
            textures: [this.cpuTexture],
            programWidth: 0,
            partCount: PART_COUNT,
        };
    }
    noteDraw(handle) {
        const RECORD = this._instance(handle);
        RECORD.usedFrame = this.device.stats.frame;
        if (RECORD.mode === 'gpu') {
            this.frameMetrics.gpuDrawInstances++;
        } else {
            this.frameMetrics.cpuDrawInstances++;
            this._fallback(RECORD.reason ?? 'cpuPose');
        }
    }
    _fallback(reason) {
        this.frameMetrics.fallbackReasons[reason] = (this.frameMetrics.fallbackReasons[reason] ?? 0) + 1;
    }
    recordFallback(reason) {
        this.frameMetrics.uniformDrawInstances++;
        this._fallback(reason);
    }
    _uploadRows(key, dirtyKey, texture, width, metric) {
        let first = Infinity;
        let last = -1;
        const UPLOADING = [];
        for (const RECORD of this.instances.values()) {
            this.frameMetrics.flushRecordVisits++;
            if (RECORD[dirtyKey]) {
                first = Math.min(first, RECORD.row);
                last = Math.max(last, RECORD.row);
                UPLOADING.push(RECORD);
            }
        }
        if (last < 0) {
            return;
        }
        const DATA = this[key].subarray(first * width * 4, (last + 1) * width * 4);
        this.device.updateDataTexture(texture, DATA, { y: first, width, height: last - first + 1 });
        for (const RECORD of UPLOADING) {
            RECORD[dirtyKey] = false;
        }
        this.frameMetrics[metric] += DATA.byteLength;
    }
    flushUpdates() {
        this._ready();
        this.frameMetrics.flushCalls++;
        if (!this.instances.size) {
            this.pendingUpdates = false;
            return;
        }
        if (!this.pendingUpdates) {
            this.frameMetrics.cleanFlushSkips++;
            return;
        }
        if (this.cpuTexture) {
            this._uploadRows('cpuData', 'cpuDirty', this.cpuTexture, POSE_WIDTH, 'cpuPoseUploadBytes');
        }
        this._uploadRows('stateData', 'stateDirty', this.stateTexture, 2, 'stateUploadBytes');
        this._uploadRows('overrideData', 'overrideDirty', this.overrideTexture, OVERRIDE_WIDTH, 'overrideUploadBytes');
        this.pendingUpdates = false;
    }
    stats() {
        const TOTAL =
            this.frameMetrics.gpuDrawInstances +
            this.frameMetrics.cpuDrawInstances +
            this.frameMetrics.uniformDrawInstances;
        return {
            ...this.frameMetrics,
            fallbackReasons: { ...this.frameMetrics.fallbackReasons },
            totalDrawInstances: TOTAL,
            cpuFallbackRatio: TOTAL
                ? (this.frameMetrics.cpuDrawInstances + this.frameMetrics.uniformDrawInstances) / TOTAL
                : 0,
            liveInstances: this.instances.size,
            sources: this.sources.size,
            capacity: this.capacity,
            gpuUnavailableReason: this.gpuUnavailableReason,
            stateBytes: this.capacity * (8 + OVERRIDE_WIDTH * 4) * 4,
            cpuPoseBytes: this.cpuTexture ? POSE_WIDTH * this.capacity * 16 : 0,
            programBytes: this.programTexture ? this.programTexture.width * this.programTexture.height * 16 : 0,
        };
    }
    dispose() {
        if (this.disposed) {
            return;
        }
        this._boundary();
        this._releaseAtlas();
        if (this.programTexture) {
            this.device.deleteTexture(this.programTexture);
        }
        this.instances.clear();
        this.sources.clear();
        this.device.canvas.removeEventListener('webglcontextrestored', this.onRestored);
        this.disposed = true;
    }
}

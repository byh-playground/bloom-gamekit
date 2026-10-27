const MAX_PARTS = 16;
const POSE_WIDTH = MAX_PARTS * 3;
const OVERRIDE_WIDTH = MAX_PARTS * 2;
const PROGRAM_WIDTH = 256;
const QUAD = new Float32Array([0, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1, 1]);
const VERTEX = `#version 300 es
precision highp float;
in vec2 a_position;in float i_row;uniform float u_capacity;
void main(){gl_Position=vec4(a_position.x*2.0-1.0,(i_row+a_position.y)*2.0/u_capacity-1.0,0,1);}`;
const FRAGMENT = `#version 300 es
precision highp float;precision highp int;
uniform sampler2D u_program;uniform sampler2D u_state;uniform sampler2D u_overrides;
uniform int u_programBase;uniform int u_partCount;uniform int u_programWidth;
out vec4 outPose;
vec4 data(int at){int i=at+u_programBase;return texelFetch(u_program,ivec2(i%u_programWidth,i/u_programWidth),0);}
float channel(int header,float time){vec4 h=data(header);float value=h.z;
 for(int i=0;i<64;i++){if(i>=int(h.y))break;vec4 s=data(int(h.x)+i*2);if(time<s.z)break;
 if(time>=s.w){value=s.y;continue;}float t=clamp((time-s.z)/(s.w-s.z),0.0,1.0),ease=data(int(h.x)+i*2+1).x;
 if(ease>1.5)t=1.0-(1.0-t)*(1.0-t);else if(ease>0.5)t=0.5-0.5*cos(3.141592653589793*t);
 value=mix(s.x,s.y,t);break;}return value;}
mat3 local(int part,int header,float time,int row,out float opacity){
 vec4 b0=texelFetch(u_overrides,ivec2(part*2,row),0),b1=texelFetch(u_overrides,ivec2(part*2+1,row),0);
 int at=header+part*6;vec2 translation=b0.xy+vec2(channel(at,time),channel(at+1,time));
 float rotation=b0.z+channel(at+2,time),sx=b0.w*channel(at+3,time),sy=b1.x*channel(at+4,time);
 float c=cos(rotation),s=sin(rotation);vec2 x=vec2(c,s)*sx,y=vec2(-s,c)*sy,pivot=data(part).xy;
 opacity=b1.y*b1.z*channel(at+5,time);return mat3(vec3(x,0),vec3(y,0),vec3(pivot+translation-x*pivot.x-y*pivot.y,1));}
void main(){int col=int(gl_FragCoord.x),row=int(gl_FragCoord.y),part=col/3,component=col%3;
 if(part>=u_partCount){outPose=component==0?vec4(1,0,0,0):component==1?vec4(0,1,0,0):vec4(0);return;}
 vec4 playback=texelFetch(u_state,ivec2(0,row),0),morph=texelFetch(u_state,ivec2(1,row),0);
 float time;if(playback.z<0.5)time=clamp(playback.y,0.0,playback.w);
 else if(playback.z<1.5)time=mod(playback.y,playback.w);
 else{float point=mod(playback.y,playback.w*2.0);time=point<=playback.w?point:playback.w*2.0-point;}
 mat3 matrix=mat3(1);float alpha=1.0;int current=part;
 for(int depth=0;depth<16;depth++){if(current<0)break;float opacity;mat3 m=local(current,int(playback.x),time,row,opacity);matrix=m*matrix;alpha*=opacity;current=int(data(current).z);}
 if((int(morph.z)&(1<<part))!=0)alpha=0.0;
 outPose=component==0?vec4(matrix[0][0],matrix[1][0],matrix[2][0],0):component==1?vec4(matrix[0][1],matrix[1][1],matrix[2][1],0):vec4(morph.xy,alpha,0);
}`;

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
        this.gpuTarget = null;
        this.pipeline = null;
        this.quadBuffer = null;
        this.rowBuffer = null;
        this.frameMetrics = {};
        this.disposed = false;
        this.gpuUnavailableReason =
            backend !== 'auto' ? 'cpuRequested' : !device.floatRenderTargetsSupported ? 'floatRenderTargets' : null;
        this.onRestored = () => {
            this.gpuUnavailableReason =
                this.backend !== 'auto'
                    ? 'cpuRequested'
                    : !device.floatRenderTargetsSupported
                      ? 'floatRenderTargets'
                      : null;
            if (this.gpuTarget && !device.isRenderTargetAvailable(this.gpuTarget)) {
                device.deleteRenderTarget(this.gpuTarget);
                this.gpuTarget = null;
                this.gpuUnavailableReason = 'floatRenderTargetRestore';
            }
            if (this.quadBuffer) {
                device.uploadVertices(this.quadBuffer, QUAD);
            }
            if (!this.gpuTarget && !this.gpuUnavailableReason && this.capacity) {
                try {
                    this.gpuTarget = device.createRenderTarget(POSE_WIDTH, this.capacity, {
                        format: 'rgba32f',
                        filter: 'nearest',
                    });
                } catch (error) {
                    // Sampling data still restores when the driver cannot restore a float FBO.
                    this.gpuUnavailableReason = `floatRenderTargetRestore:${error.message}`;
                }
            }
            for (const RECORD of this.instances.values()) {
                RECORD.dirty = true;
                RECORD.stateDirty = true;
                RECORD.overrideDirty = true;
                RECORD.cpuDirty = RECORD.mode === 'cpu';
                RECORD.usedFrame = -1;
            }
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
            gpuPoseRows: 0,
            gpuPoseDraws: 0,
            cpuPoseUploadBytes: 0,
            stateUploadBytes: 0,
            overrideUploadBytes: 0,
            fallbackReasons: Object.create(null),
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
        for (const RECORD of this.instances.values()) {
            RECORD.dirty = true;
        }
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
        if (this.gpuTarget) {
            this.device.deleteRenderTarget(this.gpuTarget);
            this.gpuTarget = null;
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
        let gpuTarget = null;
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
        if (!this.gpuUnavailableReason) {
            try {
                gpuTarget = this.device.createRenderTarget(POSE_WIDTH, CAPACITY, {
                    format: 'rgba32f',
                    filter: 'nearest',
                });
            } catch (error) {
                // A driver may expose the extension but reject this float framebuffer.
                // Keep the CPU numeric texture path and expose the exact fallback cause.
                this.gpuUnavailableReason = `floatRenderTarget:${error.message}`;
            }
        }
        this._releaseAtlas();
        this.capacity = CAPACITY;
        this.stateData = STATE;
        this.overrideData = OVERRIDES;
        this.cpuData = CPU;
        this.stateTexture = stateTexture;
        this.overrideTexture = overrideTexture;
        this.gpuTarget = gpuTarget;
        for (const RECORD of this.instances.values()) {
            RECORD.dirty = true;
            RECORD.stateDirty = true;
            RECORD.overrideDirty = true;
            RECORD.cpuDirty = RECORD.mode === 'cpu';
        }
        if (this.rowBuffer) {
            this.device.deleteVertexBuffer(this.rowBuffer);
            this.rowBuffer = null;
        }
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
            dirty: true,
            stateDirty: true,
            overrideDirty: true,
            cpuDirty: false,
            usedFrame: -1,
            reason: null,
            baseScratch: new Float32Array(OVERRIDE_WIDTH * 4),
        };
        this.instances.set(HANDLE, RECORD);
        this.rows[ROW] = RECORD;
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
            if (this.rowBuffer) {
                this.device.deleteVertexBuffer(this.rowBuffer);
                this.rowBuffer = null;
            }
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
        if (this.gpuUnavailableReason || !this.gpuTarget || !CLIP?.supported) {
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
            0,
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
        RECORD.dirty ||= STATE_CHANGED || BASE_CHANGED || RECORD.mode !== 'gpu';
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
        RECORD.dirty = false;
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
        return {
            row: RECORD.row,
            texture: RECORD.mode === 'gpu' ? this.gpuTarget : this.cpuTexture,
            partCount: this.sources.get(RECORD.source).program.partCount,
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
        if (!this.instances.size) {
            return;
        }
        if (this.cpuTexture) {
            this._uploadRows('cpuData', 'cpuDirty', this.cpuTexture, POSE_WIDTH, 'cpuPoseUploadBytes');
        }
        const GROUPS = new Map();
        for (const RECORD of this.instances.values()) {
            if (RECORD.dirty && RECORD.mode === 'gpu') {
                if (!GROUPS.has(RECORD.source)) {
                    GROUPS.set(RECORD.source, []);
                }
                GROUPS.get(RECORD.source).push(RECORD.row);
            }
        }
        if (!GROUPS.size) {
            return;
        }
        this._uploadRows('stateData', 'stateDirty', this.stateTexture, 2, 'stateUploadBytes');
        this._uploadRows('overrideData', 'overrideDirty', this.overrideTexture, OVERRIDE_WIDTH, 'overrideUploadBytes');
        if (!this.pipeline) {
            this.pipeline = this.device.createPipeline({
                vertex: VERTEX,
                fragment: FRAGMENT,
                stride: 8,
                instanceStride: 4,
                attributes: [
                    { name: 'a_position', size: 2, offset: 0 },
                    { name: 'i_row', size: 1, offset: 0, source: 'instance' },
                ],
                uniforms: {
                    u_capacity: '1f',
                    u_program: '1i',
                    u_state: '1i',
                    u_overrides: '1i',
                    u_programBase: '1i',
                    u_programWidth: '1i',
                    u_partCount: '1i',
                },
            });
            this.quadBuffer = this.device.createVertexBuffer({ capacityBytes: QUAD.byteLength });
            this.device.uploadVertices(this.quadBuffer, QUAD);
        }
        if (!this.rowBuffer) {
            this.rowBuffer = this.device.createVertexBuffer({ capacityBytes: this.capacity * 4 });
        }
        this.device.bindRenderTarget(this.gpuTarget);
        try {
            for (const [HANDLE, ROWS] of GROUPS) {
                const SOURCE = this.sources.get(HANDLE);
                this.device.uploadVertices(this.rowBuffer, Float32Array.from(ROWS));
                this.device.draw({
                    pipeline: this.pipeline,
                    buffer: this.quadBuffer,
                    instanceBuffer: this.rowBuffer,
                    instances: ROWS.length,
                    count: 6,
                    blend: false,
                    uniforms: {
                        u_capacity: this.capacity,
                        u_program: 0,
                        u_state: 1,
                        u_overrides: 2,
                        u_programBase: SOURCE.offset,
                        u_programWidth: this.programTexture.width,
                        u_partCount: SOURCE.program.partCount,
                    },
                    textures: [this.programTexture, this.stateTexture, this.overrideTexture],
                });
                this.frameMetrics.gpuPoseRows += ROWS.length;
                this.frameMetrics.gpuPoseDraws++;
                for (const ROW of ROWS) {
                    this.rows[ROW].dirty = false;
                }
            }
        } finally {
            this.device.unbindRenderTarget(this.gpuTarget);
        }
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
            gpuPoseBytes: this.gpuTarget ? POSE_WIDTH * this.capacity * 16 : 0,
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
        for (const BUFFER of [this.quadBuffer, this.rowBuffer]) {
            if (BUFFER) {
                this.device.deleteVertexBuffer(BUFFER);
            }
        }
        if (this.pipeline) {
            this.device.deletePipeline(this.pipeline);
        }
        if (this.programTexture) {
            this.device.deleteTexture(this.programTexture);
        }
        this.instances.clear();
        this.sources.clear();
        this.device.canvas.removeEventListener('webglcontextrestored', this.onRestored);
        this.disposed = true;
    }
}

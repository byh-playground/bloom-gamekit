import { POSE_PROGRAM_FUNCTIONS } from './pose-shader.js';

const CORNERS = Float32Array.of(0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1);
const VERTEX = `attribute vec2 a_corner;attribute vec2 i_row;uniform vec2 u_size;
void main(){vec2 pixel=vec2(a_corner.x*i_row.y*3.0,i_row.x+a_corner.y);
gl_Position=vec4(pixel/u_size*2.0-1.0,0.0,1.0);}`;
const FRAGMENT = `precision highp float;precision highp int;precision highp sampler2D;
${POSE_PROGRAM_FUNCTIONS}
void main(){int column=int(gl_FragCoord.x);int row=int(gl_FragCoord.y);
vec4 row0;vec4 row1;vec4 pose;poseEval(column/3,row,row0,row1,pose);
int channel=column%3;gl_FragColor=channel==0?row0:channel==1?row1:pose;}`;

/** Optional GPU keyframe results; one small float row per player, with no CPU pose evaluation or readback. */
export class PoseMatrixCache {
    constructor(device, width) {
        this.device = device;
        this.width = width;
        this.target = null;
        this.pipeline = null;
        this.cornerBuffer = null;
        this.instanceBuffer = null;
        this.cornerGeneration = -1;
        this.instances = new Float32Array(0);
        this.dirty = new Map();
        this.disposed = false;
        this.onRestored = () => {
            this.cornerGeneration = -1;
            // The producer marks every live GPU row again after the device restores its empty target.
            this.dirty.clear();
        };
        device.canvas.addEventListener('webglcontextrestored', this.onRestored);
        this.beginFrame();
    }
    get available() {
        return (
            !this.disposed &&
            this.device.state === 'ready' &&
            this.device.floatRenderTargetsSupported &&
            (!this.target || this.device.isRenderTargetAvailable(this.target))
        );
    }
    get pending() {
        return this.dirty.size > 0;
    }
    beginFrame() {
        this.metrics = { rows: 0, parts: 0, passes: 0 };
    }
    markDirty(row, partCount) {
        if (this.available) {
            this.dirty.set(row, partCount);
        }
    }
    forget(row) {
        this.dirty.delete(row);
    }
    _ensureResources() {
        let pipeline = this.pipeline;
        let corners = this.cornerBuffer;
        let instances = this.instanceBuffer;
        try {
            pipeline ??= this.device.createPipeline({
                vertex: VERTEX,
                fragment: FRAGMENT,
                stride: 8,
                instanceStride: 8,
                attributes: [
                    { name: 'a_corner', size: 2, offset: 0 },
                    { name: 'i_row', size: 2, offset: 0, source: 'instance' },
                ],
                uniforms: {
                    u_size: '2f',
                    u_program: '1i',
                    u_state: '1i',
                    u_overrides: '1i',
                    u_programWidth: '1i',
                },
            });
            corners ??= this.device.createVertexBuffer({ capacityBytes: CORNERS.byteLength });
            instances ??= this.device.createVertexBuffer({ capacityBytes: 0 });
            if (this.cornerGeneration !== (this.device.stats.restores ?? 0)) {
                this.device.uploadVertices(corners, CORNERS);
            }
        } catch (error) {
            if (pipeline && pipeline !== this.pipeline) {
                this.device.deletePipeline(pipeline);
            }
            if (corners && corners !== this.cornerBuffer) {
                this.device.deleteVertexBuffer(corners);
            }
            if (instances && instances !== this.instanceBuffer) {
                this.device.deleteVertexBuffer(instances);
            }
            throw error;
        }
        this.pipeline = pipeline;
        this.cornerBuffer = corners;
        this.instanceBuffer = instances;
        this.cornerGeneration = this.device.stats.restores ?? 0;
    }
    ensure(capacity) {
        if (!this.available || !capacity) {
            return null;
        }
        this._ensureResources();
        if (!this.target || this.target.height < capacity) {
            const TARGET = this.device.createRenderTarget(this.width, capacity, {
                format: 'rgba32f',
                filter: 'nearest',
            });
            const PREVIOUS = this.target;
            this.target = TARGET;
            if (PREVIOUS) {
                this.device.deleteRenderTarget(PREVIOUS);
            }
            const ROWS = Math.min(capacity, Math.floor(this.device.maxBufferBytes / 8));
            this.instances = new Float32Array(ROWS * 2);
        }
        return this.target;
    }
    flush(textures, programWidth, capacity) {
        if (!this.device.active || !this.pending) {
            return;
        }
        const TARGET = this.ensure(capacity);
        if (!TARGET) {
            return;
        }
        const DEVICE = this.device;
        let count = 0;
        let parts = 0;
        const SUBMIT = () => {
            DEVICE.uploadVertices(this.instanceBuffer, this.instances.subarray(0, count * 2));
            DEVICE.draw({
                pipeline: this.pipeline,
                buffer: this.cornerBuffer,
                instanceBuffer: this.instanceBuffer,
                count: 6,
                instances: count,
                uniforms: {
                    u_size: [TARGET.width, TARGET.height],
                    u_program: 0,
                    u_state: 1,
                    u_overrides: 2,
                    u_programWidth: programWidth,
                },
                textures,
                blend: false,
                depth: false,
            });
            this.metrics.rows += count;
            this.metrics.parts += parts;
            this.metrics.passes++;
            for (let index = 0; index < count; index++) {
                this.dirty.delete(this.instances[index * 2]);
            }
            count = 0;
            parts = 0;
        };
        DEVICE.bindRenderTarget(TARGET);
        try {
            for (const [ROW, PART_COUNT] of this.dirty) {
                this.instances[count * 2] = ROW;
                this.instances[count * 2 + 1] = PART_COUNT;
                count++;
                parts += PART_COUNT;
                if (count * 2 === this.instances.length) {
                    SUBMIT();
                }
            }
            if (count) {
                SUBMIT();
            }
        } finally {
            DEVICE.unbindRenderTarget(TARGET);
        }
    }
    clear() {
        if (this.target) {
            this.device.deleteRenderTarget(this.target);
        }
        if (this.pipeline) {
            this.device.deletePipeline(this.pipeline);
        }
        if (this.cornerBuffer) {
            this.device.deleteVertexBuffer(this.cornerBuffer);
        }
        if (this.instanceBuffer) {
            this.device.deleteVertexBuffer(this.instanceBuffer);
        }
        this.target = this.pipeline = this.cornerBuffer = this.instanceBuffer = null;
        this.cornerGeneration = -1;
        this.instances = new Float32Array(0);
        this.dirty.clear();
    }
    stats() {
        return {
            ...this.metrics,
            targetBytes: this.target ? this.target.width * this.target.height * 16 : 0,
            dirtyRows: this.dirty.size,
            available: this.available,
        };
    }
    dispose() {
        if (this.disposed) {
            return;
        }
        this.clear();
        this.device.canvas.removeEventListener('webglcontextrestored', this.onRestored);
        this.disposed = true;
    }
}

const MAX_INSTANCES = 2048;
const MAX_CLIP_PLANES = 32;
const INSTANCE_STRIDE_FLOATS = 16;
const INSTANCE_STRIDE_BYTES = INSTANCE_STRIDE_FLOATS * Float32Array.BYTES_PER_ELEMENT;
const QUAD_VERTICES = new Float32Array([-1, -1, 1, -1, 1, 1, -1, -1, 1, 1, -1, 1]);
const INSTANCE_VERTEX =
    'attribute vec2 a_position;attribute vec4 i_row0;attribute vec4 i_row1;attribute vec4 i_color;' +
    'attribute vec4 i_params;' +
    'uniform mat3 u_projection;varying vec2 v_local;varying vec2 v_world;varying vec4 v_row0;varying vec4 v_row1;' +
    'varying vec4 v_color;varying vec4 v_params;void main(){' +
    'vec2 p=vec2(i_row0.x*a_position.x+i_row0.y*a_position.y+i_row0.z,' +
    'i_row1.x*a_position.x+i_row1.y*a_position.y+i_row1.z);' +
    'vec3 q=u_projection*vec3(p,1.0);gl_Position=vec4(q.xy,0.0,1.0);' +
    'v_local=a_position;v_world=p;v_row0=i_row0;v_row1=i_row1;v_color=i_color;v_params=i_params;}';
const UNIFORM_VERTEX =
    'attribute vec2 a_position;uniform mat3 u_projection;uniform mat3 u_transform;uniform vec4 u_color;' +
    'uniform vec4 u_params;' +
    'varying vec2 v_local;varying vec2 v_world;varying vec4 v_row0;varying vec4 v_row1;varying vec4 v_color;' +
    'varying vec4 v_params;' +
    'void main(){vec3 p=u_transform*vec3(a_position,1.0);vec3 q=u_projection*p;gl_Position=vec4(q.xy,0.0,1.0);' +
    'v_local=a_position;v_world=p.xy;v_row0=vec4(u_transform[0][0],u_transform[1][0],u_transform[2][0],0.0);' +
    'v_row1=vec4(u_transform[0][1],u_transform[1][1],u_transform[2][1],0.0);v_color=u_color;v_params=u_params;}';
const FRAGMENT_SHADER =
    'precision mediump float;varying vec2 v_local;varying vec2 v_world;varying vec4 v_row0;varying vec4 v_row1;' +
    'varying vec4 v_color;varying vec4 v_params;uniform vec3 u_planes[32];uniform int u_planeCount;' +
    'void main(){for(int i=0;i<32;i++){if(i>=u_planeCount)break;if(dot(u_planes[i],vec3(v_world,1.0))<0.0)discard;}' +
    'float kind=v_params.x;float stroke=v_params.y;float width=v_params.z;float option=v_params.w;float d=1.0;' +
    'if(kind<0.5){if(stroke<0.5){if(length(v_local)>1.0)discard;}else{float ql=length(v_local);' +
    'vec2 n=ql>0.000001?v_local/ql:vec2(1.0,0.0);float det=v_row0.x*v_row1.y-v_row0.y*v_row1.x;' +
    'vec2 g=vec2(v_row1.y*n.x-v_row1.x*n.y,-v_row0.y*n.x+v_row0.x*n.y)/max(abs(det),0.000001);' +
    'd=(ql-1.0)/max(length(g),0.000001);if(abs(d)>width*0.5)discard;}}' +
    'else if(kind<1.5){if(stroke<0.5){if(max(abs(v_local.x),abs(v_local.y))>1.0)discard;}else{' +
    'float sx=length(vec2(v_row0.x,v_row1.x));float sy=length(vec2(v_row0.y,v_row1.y));' +
    'if(option>0.5){float ox=1.0+width/(2.0*max(sx,0.000001));float oy=1.0+width/(2.0*max(sy,0.000001));' +
    'float ix=max(0.0,1.0-width/(2.0*max(sx,0.000001)));float iy=max(0.0,1.0-width/(2.0*max(sy,0.000001)));' +
    'if(max(abs(v_local.x)/ox,abs(v_local.y)/oy)>1.0||max(abs(v_local.x)/max(ix,0.000001),' +
    'abs(v_local.y)/max(iy,0.000001))<1.0)discard;}else{' +
    'vec2 q=(abs(v_local)-vec2(1.0))*vec2(sx,sy);float sd=length(max(q,vec2(0.0)))+min(max(q.x,q.y),0.0);' +
    'if(abs(sd)>width*0.5)discard;}}}' +
    'else{float halfLength=length(vec2(v_row0.x,v_row1.x));float halfWidth=length(vec2(v_row0.y,v_row1.y));' +
    'float x=v_local.x*halfLength;float y=v_local.y*halfWidth;float center=halfLength-(option>0.5?halfWidth:0.0);' +
    'if(option<0.5){d=max(abs(x)-center,abs(y)-halfWidth);}else if(option<1.5){' +
    'd=max(abs(x)-center-halfWidth,abs(y)-halfWidth);}else{d=length(vec2(max(abs(x)-center,0.0),y))-halfWidth;}' +
    'if(d>0.0)discard;}' +
    'gl_FragColor=vec4(v_color.rgb*v_color.a,v_color.a);}';
function createClipState(clips) {
    const VALUES = [];
    const KEY = [];
    for (const POLYGON of clips) {
        let area = 0;
        for (let i = 0; i < POLYGON.length; i++) {
            const P = POLYGON[i];
            const Q = POLYGON[(i + 1) % POLYGON.length];
            area += P.x * Q.y - Q.x * P.y;
        }
        if (Math.abs(area) < 1e-12) {
            VALUES.push(0, 0, -1);
            KEY.push('empty');
            continue;
        }
        const SIGN = area >= 0 ? 1 : -1;
        for (let i = 0; i < POLYGON.length; i++) {
            const P = POLYGON[i];
            const Q = POLYGON[(i + 1) % POLYGON.length];
            const DX = Q.x - P.x;
            const DY = Q.y - P.y;
            const LENGTH = Math.hypot(DX, DY);
            if (!LENGTH) {
                continue;
            }
            const A = (-DY / LENGTH) * SIGN;
            const B = (DX / LENGTH) * SIGN;
            const C = -(A * P.x + B * P.y);
            VALUES.push(A, B, C);
            KEY.push(A, B, C);
        }
    }
    if (VALUES.length / 3 > MAX_CLIP_PLANES) {
        return null;
    }
    return {
        key: KEY.join(','),
        values: Float32Array.from(VALUES),
        count: VALUES.length / 3,
    };
}
function stencilState(stencilRef) {
    return stencilRef === null
        ? false
        : {
              func: 'equal',
              ref: stencilRef,
              mask: 255,
              writeMask: 0,
              pass: 'keep',
          };
}
function transformUniform(matrix) {
    return new Float32Array([matrix[0], matrix[1], 0, matrix[2], matrix[3], 0, matrix[4], matrix[5], 1]);
}

/** Shared unit-quad GPU path for analytic filled and stroked primitives. */
export class PrimitiveRenderer {
    constructor(device) {
        if (!device?.createVertexBuffer || !device?.createPipeline || !device?.draw) {
            throw new TypeError('WebGLDevice is required');
        }
        this.device = device;
        this.instanced = device.instancingSupported === true;
        this.vertexBuffer = device.createVertexBuffer({
            capacityBytes: QUAD_VERTICES.byteLength,
        });
        device.uploadVertices(this.vertexBuffer, QUAD_VERTICES);
        this.instanceBuffer = this.instanced
            ? device.createVertexBuffer({
                  capacityBytes: MAX_INSTANCES * INSTANCE_STRIDE_BYTES,
              })
            : null;
        this.instances = this.instanced ? new Float32Array(MAX_INSTANCES * INSTANCE_STRIDE_FLOATS) : null;
        this.pipeline = device.createPipeline({
            vertex: this.instanced ? INSTANCE_VERTEX : UNIFORM_VERTEX,
            fragment: FRAGMENT_SHADER,
            stride: 8,
            instanceStride: this.instanced ? INSTANCE_STRIDE_BYTES : 0,
            attributes: [
                {
                    name: 'a_position',
                    size: 2,
                    offset: 0,
                },
                ...(this.instanced
                    ? [
                          {
                              name: 'i_row0',
                              size: 4,
                              offset: 0,
                              source: 'instance',
                          },
                          {
                              name: 'i_row1',
                              size: 4,
                              offset: 16,
                              source: 'instance',
                          },
                          {
                              name: 'i_color',
                              size: 4,
                              offset: 32,
                              source: 'instance',
                          },
                          {
                              name: 'i_params',
                              size: 4,
                              offset: 48,
                              source: 'instance',
                          },
                      ]
                    : []),
            ],
            uniforms: {
                u_projection: 'matrix3fv',
                'u_planes[0]': '3fv',
                u_planeCount: '1i',
                ...(this.instanced
                    ? {}
                    : {
                          u_transform: 'matrix3fv',
                          u_color: '4f',
                          u_params: '4f',
                      }),
            },
        });
        this.pendingCount = 0;
        this.pendingState = null;
        this.frameStats = this._emptyStats();
        this.total = this._emptyStats();
        this.disposed = false;
        this.onLost = () => {
            this.pendingCount = 0;
            this.pendingState = null;
        };
        this.onRestored = () => {
            if (this.disposed) {
                return;
            }
            try {
                this.device.uploadVertices(this.vertexBuffer, QUAD_VERTICES);
            } catch {
                this.pendingCount = 0;
                this.pendingState = null;
            }
        };
        device.canvas.addEventListener('webglcontextlost', this.onLost);
        device.canvas.addEventListener('webglcontextrestored', this.onRestored);
    }
    _emptyStats() {
        return {
            instances: 0,
            instanceUploads: 0,
            instanceBytesUploaded: 0,
            draws: 0,
            instancedDraws: 0,
            flushes: 0,
        };
    }
    beginFrame() {
        this.frameStats = this._emptyStats();
    }
    _sameState(state, next) {
        if (
            state.clip.key !== next.clip.key ||
            state.stencilRef !== next.stencilRef ||
            state.blend !== next.blend ||
            state.projection.length !== next.projection.length
        ) {
            return false;
        }
        for (let i = 0; i < state.projection.length; i++) {
            if (state.projection[i] !== next.projection[i]) {
                return false;
            }
        }
        return true;
    }
    draw({ matrix, color, params, projection, clips, stencilRef = null, blend = 'source-over' }) {
        if (this.disposed) {
            throw new Error('PrimitiveRenderer is disposed');
        }
        const CLIP = createClipState(clips);
        if (!CLIP) {
            return false;
        }
        const NEXT_STATE = {
            clip: CLIP,
            projection,
            stencilRef,
            blend,
        };
        if (this.pendingCount && !this._sameState(this.pendingState, NEXT_STATE)) {
            this.flush('stateChange');
        }
        if (!this.instanced) {
            this.pendingState = NEXT_STATE;
            this._drawUniform(matrix, color, params, NEXT_STATE);
            this.frameStats.instances++;
            this.frameStats.draws++;
            this.total.instances++;
            this.total.draws++;
            return true;
        }
        if (this.pendingCount === MAX_INSTANCES) {
            this.flush('capacity');
        }
        if (!this.pendingCount) {
            this.pendingState = NEXT_STATE;
        }
        const AT = this.pendingCount++ * INSTANCE_STRIDE_FLOATS;
        this.instances.set([matrix[0], matrix[2], matrix[4], 0], AT);
        this.instances.set([matrix[1], matrix[3], matrix[5], 0], AT + 4);
        this.instances.set(color, AT + 8);
        this.instances.set(params, AT + 12);
        this.frameStats.instances++;
        this.total.instances++;
        return true;
    }
    _drawUniform(matrix, color, params, state) {
        const UNIFORMS = {
            u_projection: state.projection,
            u_transform: transformUniform(matrix),
            u_color: color,
            u_params: params,
            u_planeCount: state.clip.count,
        };
        if (state.clip.count) {
            UNIFORMS['u_planes[0]'] = state.clip.values;
        }
        this.device.draw({
            pipeline: this.pipeline,
            buffer: this.vertexBuffer,
            count: QUAD_VERTICES.length / 2,
            uniforms: UNIFORMS,
            blend: state.blend,
            stencil: stencilState(state.stencilRef),
        });
    }
    flush(reason = 'explicit') {
        if (!this.pendingCount) {
            return;
        }
        const STATE = this.pendingState;
        const BYTES = this.pendingCount * INSTANCE_STRIDE_BYTES;
        const UNIFORMS = {
            u_projection: STATE.projection,
            u_planeCount: STATE.clip.count,
        };
        if (STATE.clip.count) {
            UNIFORMS['u_planes[0]'] = STATE.clip.values;
        }
        this.device.uploadVertices(
            this.instanceBuffer,
            this.instances.subarray(0, this.pendingCount * INSTANCE_STRIDE_FLOATS),
        );
        this.frameStats.instanceUploads++;
        this.total.instanceUploads++;
        this.frameStats.instanceBytesUploaded += BYTES;
        this.total.instanceBytesUploaded += BYTES;
        this.device.draw({
            pipeline: this.pipeline,
            buffer: this.vertexBuffer,
            instanceBuffer: this.instanceBuffer,
            instances: this.pendingCount,
            count: QUAD_VERTICES.length / 2,
            uniforms: UNIFORMS,
            blend: STATE.blend,
            stencil: stencilState(STATE.stencilRef),
        });
        this.frameStats.draws++;
        this.frameStats.instancedDraws++;
        this.frameStats.flushes++;
        this.total.draws++;
        this.total.instancedDraws++;
        this.total.flushes++;
        this.pendingCount = 0;
        this.pendingState = null;
        this.frameStats.lastFlushReason = reason;
    }
    stats() {
        return {
            instanced: this.instanced,
            pendingInstances: this.pendingCount,
            frame: {
                ...this.frameStats,
            },
            total: {
                ...this.total,
            },
        };
    }
    dispose() {
        if (this.disposed) {
            return;
        }
        this.device.canvas.removeEventListener('webglcontextlost', this.onLost);
        this.device.canvas.removeEventListener('webglcontextrestored', this.onRestored);
        this.device.deleteVertexBuffer(this.vertexBuffer);
        if (this.instanceBuffer) {
            this.device.deleteVertexBuffer(this.instanceBuffer);
        }
        this.device.deletePipeline(this.pipeline);
        this.pendingCount = 0;
        this.pendingState = null;
        this.disposed = true;
    }
}

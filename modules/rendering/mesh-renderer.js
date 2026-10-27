import { PoseRenderer } from './pose-renderer.js';
import { MAX_PAINT_REGIONS, packPaintRegions, validatePaintRegionData } from './paint-regions.js';
const IDENTITY = Object.freeze([1, 0, 0, 1, 0, 0]);
const ZERO_MORPH = Object.freeze([0, 0]);
const EMPTY_CLIP = Object.freeze({
    key: '',
    values: null,
    count: 0,
});
const WHITE = Object.freeze([1, 1, 1, 1]);
const IDENTITY_RECT = Object.freeze([0, 0, 1, 1]);
const ATTRIBUTES = [
    {
        name: 'a_position',
        size: 2,
        offset: 0,
    },
    {
        name: 'a_color',
        size: 4,
        offset: 8,
    },
    {
        name: 'a_morph',
        size: 4,
        offset: 24,
    },
    {
        name: 'a_part',
        size: 1,
        offset: 40,
    },
];
const INSTANCE_ATTRIBUTES = ['i_row0', 'i_row1', 'i_color', 'i_params'].map((name, i) => ({
    name,
    size: 4,
    offset: i * 16,
    source: 'instance',
}));
const WORLD_INSTANCE_ATTRIBUTES = ['i_row0', 'i_row1', 'i_row2', 'i_params'].map((name, i) => ({
    name,
    size: 4,
    offset: i * 16,
    source: 'instance',
}));
const TEXTURE_INSTANCE_ATTRIBUTES = ['i_uvRect', 'i_localRect'].map((name, i) => ({
    name,
    size: 4,
    offset: 64 + i * 16,
    source: 'instance',
}));
function shader(
    instanced,
    partCount,
    morphCount,
    clipped,
    nonScalingStroke,
    worldMode = false,
    textured = false,
    poseTexture = false,
    paintRegionCount = 0,
) {
    const PAINT_INPUT = paintRegionCount
            ? `attribute float a_paintRegion;uniform vec4 u_paintRegions[${paintRegionCount + 1}];`
            : '',
        PAINT_COLOR = paintRegionCount
            ? 'vec4 authored=a_color;vec4 paint=u_paintRegions[int(a_paintRegion)];authored.rgb=mix(authored.rgb,paint.rgb,paint.a);'
            : '',
        BASE_COLOR = paintRegionCount ? 'authored' : 'a_color';
    const PART_POSE = partCount > 1 || poseTexture;
    const PART_INPUTS = PART_POSE
        ? `${partCount > 1 ? 'attribute float a_part;' : ''}uniform vec4 u_parts[${partCount * 3}];`
        : '';
    const PART_SETUP = PART_POSE
        ? `int index=${partCount > 1 ? 'int(a_part)*3' : '0'};vec4 row0=u_parts[index];vec4 row1=u_parts[index+1];vec4 pose=u_parts[index+2];`
        : '';
    const INPUTS = ['i_row0', 'i_row1', 'i_color', 'i_params']
        .map((name) => `${instanced ? 'attribute' : 'uniform'} vec4 ${name};`)
        .join('\n');
    const LOCAL = morphCount
        ? 'a_position+a_morph.xy*(i_params.x' +
          (PART_POSE ? '+pose.x' : '') +
          ')' +
          (morphCount > 1 ? '+a_morph.zw*(i_params.y' + (PART_POSE ? '+pose.y' : '') + ')' : '')
        : 'a_position';
    const STROKE_INPUTS = nonScalingStroke ? 'attribute vec4 a_stroke;uniform vec2 u_strokeViewportSize;' : '';
    const STROKE_VARYING = clipped && nonScalingStroke ? 'uniform mat3 u_inverseProjection;' : '';
    const TEXTURE_INPUTS = textured
        ? `attribute highp vec2 a_uv;${instanced ? 'attribute' : 'uniform'} highp vec4 i_uvRect;${instanced ? 'attribute' : 'uniform'} vec4 i_localRect;varying highp vec2 v_uv;varying float v_forceColor;varying float v_whiteFlash;`
        : '';
    const RECT_LOCAL = textured ? 'local=i_localRect.xy+local*i_localRect.zw;' : '';
    const STROKE_POSITION = nonScalingStroke
        ? `
vec2 tangentLocal=local+a_stroke.xy${textured ? '*i_localRect.zw' : ''};
vec2 tangentPart=${PART_POSE ? 'vec2(dot(row0.xyz,vec3(tangentLocal,1.0)),dot(row1.xyz,vec3(tangentLocal,1.0)))' : 'tangentLocal'};
vec2 tangentWorld=vec2(dot(i_row0.xyz,vec3(tangentPart,1.0)),dot(i_row1.xyz,vec3(tangentPart,1.0)));
vec3 tangentProjected=u_projection*vec3(tangentWorld,1.0);
vec2 tangent=(tangentProjected.xy/tangentProjected.z-projected.xy/projected.z)*u_strokeViewportSize*0.5;float tangentLength=length(tangent);
if(dot(a_stroke.xy,a_stroke.xy)>0.5){
  if(tangentLength<0.000001){projected.z=0.0;}
  else{
    tangent/=tangentLength;vec2 normal=vec2(-tangent.y,tangent.x);
    vec2 pxOffset=tangent*a_stroke.z+normal*a_stroke.w;
    vec2 clipOffset=pxOffset*2.0/u_strokeViewportSize;
    projected.xy+=clipOffset*projected.z;
    ${clipped ? 'vec3 clippedWorld=u_inverseProjection*vec3(projected.xy,projected.z);v_position=clippedWorld.xy/clippedWorld.z;' : ''}
  }
}`
        : '';
    if (worldMode) {
        const WORLD_INPUTS = ['i_row0', 'i_row1', 'i_row2', 'i_params']
            .map((name) => `${instanced ? 'attribute' : 'uniform'} vec4 ${name};`)
            .join('\n');
        const WORLD_STROKE_INPUTS = nonScalingStroke
            ? 'attribute vec4 a_stroke;uniform vec2 u_strokeViewportSize;' +
              (clipped ? 'uniform mat4 u_inverseViewProjection;' : '')
            : '';
        const WORLD_STROKE = nonScalingStroke
            ? `
vec2 tangentLocal=local+a_stroke.xy${textured ? '*i_localRect.zw' : ''};
vec2 tangentPlane=${partCount > 1 ? 'vec2(dot(row0.xyz,vec3(tangentLocal,1.0)),dot(row1.xyz,vec3(tangentLocal,1.0)))' : 'tangentLocal'};
vec3 tangentWorld=vec3(dot(i_row0.xyz,vec3(tangentPlane,1.0)),dot(i_row1.xyz,vec3(tangentPlane,1.0)),dot(i_row2.xyz,vec3(tangentPlane,1.0)));
vec4 tangentProjected=u_viewProjection*vec4(tangentWorld,1.0);vec2 tangent=(tangentProjected.xy/tangentProjected.w-projected.xy/projected.w)*u_strokeViewportSize*0.5;float tangentLength=length(tangent);
if(dot(a_stroke.xy,a_stroke.xy)>0.5){
  if(tangentLength<0.000001){projected.w=0.0;}
  else{tangent/=tangentLength;vec2 normal=vec2(-tangent.y,tangent.x);vec2 pxOffset=tangent*a_stroke.z+normal*a_stroke.w;
    projected.xy+=pxOffset*2.0/u_strokeViewportSize*projected.w;${clipped ? 'vec4 clippedWorld=u_inverseViewProjection*projected;v_position=clippedWorld.xy/clippedWorld.w;' : ''}}
}`
            : '';
        return `attribute vec2 a_position; attribute vec4 a_color; ${morphCount ? 'attribute vec4 a_morph;' : ''} ${PART_INPUTS}
${WORLD_INPUTS}${WORLD_STROKE_INPUTS}${TEXTURE_INPUTS}${PAINT_INPUT}
uniform mat4 u_viewProjection; uniform vec4 u_color; varying vec4 v_color; ${clipped ? 'varying vec2 v_position;' : ''}
void main(){${PART_SETUP}
vec2 local=${LOCAL};${RECT_LOCAL}vec2 plane=${PART_POSE ? 'vec2(dot(row0.xyz,vec3(local,1.0)),dot(row1.xyz,vec3(local,1.0)))' : 'local'};
vec3 world=vec3(dot(i_row0.xyz,vec3(plane,1.0)),dot(i_row1.xyz,vec3(plane,1.0)),dot(i_row2.xyz,vec3(plane,1.0)));
vec4 projected=u_viewProjection*vec4(world,1.0);${clipped ? 'v_position=world.xy;' : ''}${WORLD_STROKE}
projected.z+=(i_params.w+${PART_POSE ? 'pose.w' : '0.0'})*projected.w;gl_Position=projected;
${PAINT_COLOR}vec4 color=mix(${BASE_COLOR}*u_color,u_color,i_row1.w);color.a*=i_row0.w${PART_POSE ? '*pose.z' : ''};color.rgb=mix(color.rgb,vec3(1.0),i_row2.w);v_color=vec4(color.rgb*color.a,color.a);${textured ? 'v_uv=i_uvRect.xy+a_uv*i_uvRect.zw;v_forceColor=i_row1.w;v_whiteFlash=i_row2.w;' : ''}
}`;
    }
    return `attribute vec2 a_position; attribute vec4 a_color; ${morphCount ? 'attribute vec4 a_morph;' : ''} ${PART_INPUTS}
${INPUTS}${STROKE_INPUTS}${TEXTURE_INPUTS}${PAINT_INPUT}
uniform mat3 u_projection; varying vec4 v_color; ${clipped ? 'varying vec2 v_position;' : ''}${STROKE_VARYING}
void main(){${PART_SETUP}
vec2 local=${LOCAL};${RECT_LOCAL}vec2 p=${PART_POSE ? 'vec2(dot(row0.xyz,vec3(local,1.0)),dot(row1.xyz,vec3(local,1.0)))' : 'local'};
vec2 world=vec2(dot(i_row0.xyz,vec3(p,1.0)),dot(i_row1.xyz,vec3(p,1.0)));
vec3 projected=u_projection*vec3(world,1.0);${clipped ? 'v_position=world;' : ''}${STROKE_POSITION}
gl_Position=vec4(projected.xy,(i_params.w+${PART_POSE ? 'pose.w' : '0.0'})*projected.z,projected.z);
${PAINT_COLOR}vec4 color=mix(${BASE_COLOR}*i_color,i_color,i_row1.w);color.a*=i_row0.w${PART_POSE ? '*pose.z' : ''};
color.rgb=mix(color.rgb,vec3(1.0),i_params.z);v_color=vec4(color.rgb*color.a,color.a);${textured ? 'v_uv=i_uvRect.xy+a_uv*i_uvRect.zw;v_forceColor=i_row1.w;v_whiteFlash=i_params.z;' : ''}}`;
}
function fragment(maxPlanes, clipped, textured = false) {
    const TEXTURE_INPUTS = textured
        ? 'uniform sampler2D u_texture;varying highp vec2 v_uv;varying float v_forceColor;varying float v_whiteFlash;'
        : '';
    const OUTPUT = textured
        ? 'vec4 sampleColor=texture2D(u_texture,v_uv);float alpha=sampleColor.a*v_color.a;vec3 rgb=v_whiteFlash>0.5?vec3(alpha):v_forceColor>0.5?sampleColor.a*v_color.rgb:sampleColor.rgb*v_color.rgb;gl_FragColor=vec4(rgb,alpha);'
        : 'gl_FragColor=v_color;';
    if (!clipped) {
        return `precision mediump float;varying vec4 v_color;${TEXTURE_INPUTS}void main(){${OUTPUT}}`;
    }
    return `precision mediump float; varying vec4 v_color; varying vec2 v_position;
${TEXTURE_INPUTS}
uniform vec3 u_planes[${maxPlanes}]; uniform int u_planeCount;
void main(){for(int i=0;i<${maxPlanes};i++){if(i>=u_planeCount)break;if(dot(u_planes[i],vec3(v_position,1.0))<0.0)discard;}${OUTPUT}}`;
}
function poseTextureShader(source) {
    return source
        .replace(/uniform vec4 u_parts\[\d+\];/, 'uniform sampler2D u_poseTexture;')
        .replace(
            /(int index=(?:int\(a_part\)\*3|0);)vec4 row0=u_parts\[index\];vec4 row1=u_parts\[index\+1\];vec4 pose=u_parts\[index\+2\];/,
            '$1int poseRow=int(-i_params.x-1.0);vec4 row0=texelFetch(u_poseTexture,ivec2(index,poseRow),0);vec4 row1=texelFetch(u_poseTexture,ivec2(index+1,poseRow),0);vec4 pose=texelFetch(u_poseTexture,ivec2(index+2,poseRow),0);',
        )
        .replaceAll('(i_params.x+pose.x)', '(pose.x)')
        .replaceAll('(i_params.y+pose.y)', '(pose.y)');
}
// One startup/context-restore conversion, never a palette-specific geometry or per-frame upload.
function paintVertexStream(vertices, regions) {
    if (!regions) {
        return vertices;
    }
    const PACKED = new Float32Array((vertices.length / 11) * 12);
    for (let index = 0; index < regions.length; index++) {
        PACKED.set(vertices.subarray(index * 11, index * 11 + 11), index * 12);
        PACKED[index * 12 + 11] = regions[index];
    }
    return PACKED;
}
function finiteArray(value, size, name) {
    if (!value || value.length !== size) {
        throw new TypeError(`${name}: ${size} finite numbers required`);
    }
    for (let i = 0; i < size; i++) {
        if (!Number.isFinite(value[i])) {
            throw new TypeError(`${name}: ${size} finite numbers required`);
        }
    }
}
function affineMatrix4(value, name) {
    finiteArray(value, 16, name);
    if (
        Math.abs(value[3]) > 1e-7 ||
        Math.abs(value[7]) > 1e-7 ||
        Math.abs(value[11]) > 1e-7 ||
        Math.abs(value[15] - 1) > 1e-7
    ) {
        throw new TypeError(`${name} must be an affine column-major 4x4 matrix`);
    }
}
function invertMatrix4(matrix) {
    const ROWS = Array.from(
        {
            length: 4,
        },
        (_, row) => [
            matrix[row],
            matrix[4 + row],
            matrix[8 + row],
            matrix[12 + row],
            ...(row === 0 ? [1, 0, 0, 0] : row === 1 ? [0, 1, 0, 0] : row === 2 ? [0, 0, 1, 0] : [0, 0, 0, 1]),
        ],
    );
    for (let column = 0; column < 4; column++) {
        let pivot = column;
        for (let row = column + 1; row < 4; row++) {
            if (Math.abs(ROWS[row][column]) > Math.abs(ROWS[pivot][column])) {
                pivot = row;
            }
        }
        if (!Number.isFinite(ROWS[pivot][column]) || Math.abs(ROWS[pivot][column]) < 1e-12) {
            throw new RangeError('Clipped non-scaling strokes require an invertible viewProjection');
        }
        [ROWS[column], ROWS[pivot]] = [ROWS[pivot], ROWS[column]];
        const DIVISOR = ROWS[column][column];
        for (let j = 0; j < 8; j++) {
            ROWS[column][j] /= DIVISOR;
        }
        for (let row = 0; row < 4; row++) {
            if (row !== column) {
                const SCALE = ROWS[row][column];
                for (let j = 0; j < 8; j++) {
                    ROWS[row][j] -= SCALE * ROWS[column][j];
                }
            }
        }
    }
    const INVERSE = new Float32Array(16);
    for (let row = 0; row < 4; row++) {
        for (let column = 0; column < 4; column++) {
            INVERSE[column * 4 + row] = ROWS[row][column + 4];
        }
    }
    return INVERSE;
}
function invertProjection(projection) {
    const [A_LOCAL, D_LOCAL, G_LOCAL, B_LOCAL, E_LOCAL, H_LOCAL, C_LOCAL, F_LOCAL, I_LOCAL] = projection;
    const A = E_LOCAL * I_LOCAL - F_LOCAL * H_LOCAL,
        B = F_LOCAL * G_LOCAL - D_LOCAL * I_LOCAL,
        C = D_LOCAL * H_LOCAL - E_LOCAL * G_LOCAL,
        D = C_LOCAL * H_LOCAL - B_LOCAL * I_LOCAL,
        E = A_LOCAL * I_LOCAL - C_LOCAL * G_LOCAL,
        F = B_LOCAL * G_LOCAL - A_LOCAL * H_LOCAL,
        G = B_LOCAL * F_LOCAL - C_LOCAL * E_LOCAL,
        H = C_LOCAL * D_LOCAL - A_LOCAL * F_LOCAL,
        I = A_LOCAL * E_LOCAL - B_LOCAL * D_LOCAL;
    const DETERMINANT = A_LOCAL * A + B_LOCAL * B + C_LOCAL * C;
    if (!Number.isFinite(DETERMINANT) || Math.abs(DETERMINANT) < 1e-12) {
        throw new RangeError('Non-scaling strokes require an invertible projection');
    }
    return Float32Array.from([A, B, C, D, E, F, G, H, I], (value) => value / DETERMINANT);
}
function packParts(parts, count, output) {
    if (parts !== null && (!Array.isArray(parts) || parts.length !== count)) {
        throw new TypeError('One pose per authored mesh part required');
    }
    for (let i = 0; i < count; i++) {
        const PART = parts?.[i],
            M = PART?.transform ?? IDENTITY,
            MORPH = PART?.morph ?? ZERO_MORPH;
        finiteArray(M, 6, 'part transform');
        finiteArray(MORPH, 2, 'part morph');
        const OPACITY = PART?.opacity ?? 1;
        if (!Number.isFinite(OPACITY) || OPACITY < 0 || OPACITY > 1) {
            throw new RangeError('part opacity must be in [0,1]');
        }
        const AT = i * 12;
        output[AT] = M[0];
        output[AT + 1] = M[2];
        output[AT + 2] = M[4];
        output[AT + 3] = 0;
        output[AT + 4] = M[1];
        output[AT + 5] = M[3];
        output[AT + 6] = M[5];
        output[AT + 7] = 0;
        const DEPTH = PART?.depth ?? 0;
        if (!Number.isFinite(DEPTH) || DEPTH < -1 || DEPTH > 1) {
            throw new RangeError('part depth must be in [-1,1]');
        }
        output[AT + 8] = MORPH[0];
        output[AT + 9] = MORPH[1];
        output[AT + 10] = PART?.visible === false ? 0 : OPACITY;
        output[AT + 11] = DEPTH;
    }
}
function clipState(clips, maxPlanes) {
    if (!clips?.length) {
        return EMPTY_CLIP;
    }
    const VALUES = [],
        KEY = [];
    for (const POLYGON of clips) {
        if (
            !Array.isArray(POLYGON) ||
            POLYGON.length < 3 ||
            POLYGON.some((p) => !Number.isFinite(p?.x) || !Number.isFinite(p?.y))
        ) {
            throw new TypeError('Finite convex clip polygons required');
        }
        let area = 0;
        for (let i = 0; i < POLYGON.length; i++) {
            const P = POLYGON[i],
                Q = POLYGON[(i + 1) % POLYGON.length];
            area += P.x * Q.y - Q.x * P.y;
        }
        if (Math.abs(area) < 1e-12) {
            return {
                key: 'empty',
                values: [0, 0, -1],
                count: 1,
            };
        }
        const SIGN = area >= 0 ? 1 : -1;
        for (let i = 0; i < POLYGON.length; i++) {
            const P = POLYGON[i],
                Q = POLYGON[(i + 1) % POLYGON.length],
                DX = Q.x - P.x,
                DY = Q.y - P.y,
                LENGTH = Math.hypot(DX, DY);
            if (!LENGTH) {
                continue;
            }
            const A_LOCAL = (-DY / LENGTH) * SIGN,
                B_LOCAL = (DX / LENGTH) * SIGN,
                C_LOCAL = -(A_LOCAL * P.x + B_LOCAL * P.y);
            VALUES.push(A_LOCAL, B_LOCAL, C_LOCAL);
            KEY.push(A_LOCAL, B_LOCAL, C_LOCAL);
        }
    }
    if (VALUES.length / 3 > maxPlanes) {
        throw new RangeError(`Mesh clipping exceeds ${maxPlanes} edge planes`);
    }
    return {
        key: KEY.join(','),
        values: VALUES,
        count: VALUES.length / 3,
    };
}
function meshPartBounds(vertices, partCount, morphCount) {
    const BOUNDS = Array.from(
        {
            length: partCount,
        },
        () => ({
            minX: Infinity,
            minY: Infinity,
            maxX: -Infinity,
            maxY: -Infinity,
            minDx0: Infinity,
            minDy0: Infinity,
            maxDx0: -Infinity,
            maxDy0: -Infinity,
            minDx1: Infinity,
            minDy1: Infinity,
            maxDx1: -Infinity,
            maxDy1: -Infinity,
        }),
    );
    for (let at = 0; at < vertices.length; at += 11) {
        const BOUND = BOUNDS[vertices[at + 10]],
            X = vertices[at],
            Y = vertices[at + 1];
        BOUND.minX = Math.min(BOUND.minX, X);
        BOUND.maxX = Math.max(BOUND.maxX, X);
        BOUND.minY = Math.min(BOUND.minY, Y);
        BOUND.maxY = Math.max(BOUND.maxY, Y);
        const DX0 = morphCount > 0 ? vertices[at + 6] : 0,
            DY0 = morphCount > 0 ? vertices[at + 7] : 0;
        const DX1 = morphCount > 1 ? vertices[at + 8] : 0,
            DY1 = morphCount > 1 ? vertices[at + 9] : 0;
        BOUND.minDx0 = Math.min(BOUND.minDx0, DX0);
        BOUND.maxDx0 = Math.max(BOUND.maxDx0, DX0);
        BOUND.minDy0 = Math.min(BOUND.minDy0, DY0);
        BOUND.maxDy0 = Math.max(BOUND.maxDy0, DY0);
        BOUND.minDx1 = Math.min(BOUND.minDx1, DX1);
        BOUND.maxDx1 = Math.max(BOUND.maxDx1, DX1);
        BOUND.minDy1 = Math.min(BOUND.minDy1, DY1);
        BOUND.maxDy1 = Math.max(BOUND.maxDy1, DY1);
    }
    for (const BOUND of BOUNDS) {
        if (!Number.isFinite(BOUND.minX)) {
            BOUND.minX = BOUND.minY = BOUND.maxX = BOUND.maxY = 0;
        }
        for (const KEY of ['minDx0', 'minDy0', 'maxDx0', 'maxDy0', 'minDx1', 'minDy1', 'maxDx1', 'maxDy1']) {
            if (!Number.isFinite(BOUND[KEY])) {
                BOUND[KEY] = 0;
            }
        }
    }
    return BOUNDS;
}

/** Retained GPU meshes; batches only adjacent equal meshes. No game sorting or animation clock. */
export class MeshRenderer {
    constructor(
        device,
        {
            maxMeshes = 512,
            maxMeshBytes = 32 * 1024 * 1024,
            maxInstances = 2048,
            safeAlphaRunBatching = true,
            poseBackend = 'auto',
        } = {},
    ) {
        for (const [KEY, VALUE] of Object.entries({
            maxMeshes,
            maxMeshBytes,
            maxInstances,
        })) {
            if (!Number.isSafeInteger(VALUE) || VALUE < 1) {
                throw new RangeError(`${KEY} must be positive`);
            }
        }
        if (typeof safeAlphaRunBatching !== 'boolean') {
            throw new TypeError('safeAlphaRunBatching must be a boolean');
        }
        this.device = device;
        if (!['auto', 'cpu', 'uniform'].includes(poseBackend)) {
            throw new TypeError('poseBackend must be auto, cpu or uniform');
        }
        this.poseBackend = poseBackend;
        this.poseRenderer = null;
        this.maxMeshes = maxMeshes;
        this.maxMeshBytes = maxMeshBytes;
        this.maxInstances = maxInstances;
        this.safeAlphaRunBatching = safeAlphaRunBatching;
        if (maxInstances * 64 > device.maxBufferBytes) {
            throw new RangeError('Mesh instance buffer exceeds device byte limit');
        }
        this.maxPlanes = Math.max(1, Math.min(32, device.gl.getParameter(device.gl.MAX_FRAGMENT_UNIFORM_VECTORS) - 2));
        this.instanced = device.instancingSupported === true;
        this.maxTexturedInstances = this.instanced
            ? Math.min(maxInstances, Math.floor(device.maxBufferBytes / 96))
            : maxInstances;
        this.instances = new Float32Array(maxInstances * 16);
        this.texturedInstances = null;
        this.instanceBuffer = this.instanced
            ? device.createVertexBuffer({
                  capacityBytes: this.instances.byteLength,
              })
            : null;
        this.pipelines = new Map();
        this.meshes = new Set();
        this.bytes = 0;
        this.count = 0;
        this.pending = null;
        this.planes = new Float32Array(this.maxPlanes * 3);
        this.partScratch = new Float32Array(16 * 12);
        this.paintScratch = null;
        this.paintState = null;
        this.alphaRunScratch = [];
        this.alphaRunCache = new WeakMap();
        this.alphaQueue = new Array(maxInstances);
        this.alphaQueueBounds = {
            minX: 0,
            minY: 0,
            maxX: 0,
            maxY: 0,
        };
        this.alphaBoundsScratch = {
            minX: 0,
            minY: 0,
            maxX: 0,
            maxY: 0,
        };
        this.alphaQueueParts = new Float32Array(16 * 12);
        this.alphaQueueCount = 0;
        this.alphaQueueState = null;
        this.metrics = {
            draws: 0,
            instances: 0,
            geometryUploads: 0,
            geometryBytesUploaded: 0,
            instanceBytesUploaded: 0,
            partUniformBytesSubmitted: 0,
            alphaRunCacheHits: 0,
            alphaRunCacheMisses: 0,
            alphaRunSafeBatches: 0,
            alphaRunBatchedInstances: 0,
            alphaRunDrawsSaved: 0,
            alphaRunSafeRunDraws: 0,
            alphaRunImmediateRunDraws: 0,
            alphaRunOverlapBoundaries: 0,
            alphaRunSignatureBoundaries: 0,
            alphaRunUnbatchableBounds: 0,
            alphaRunImmediateInstances: 0,
            flushReasons: Object.create(null),
            drawDispatchReasons: Object.create(null),
        };
        this.state = 'ready';
        this.failure = null;
        this.onLost = () => {
            this.discard();
            this.state = 'lost';
        };
        this.onRestored = () => {
            try {
                if (this.instanced && !device.instancingSupported) {
                    throw new Error('Restored context no longer supports mesh instancing');
                }
                for (const MESH of this.meshes) {
                    device.uploadVertices(MESH.buffer, MESH.gpuVertices);
                    if (MESH.indices) {
                        device.uploadIndices(MESH.indexBuffer, MESH.indices);
                    }
                    for (const VARIANT of MESH.expressionIndices.values()) {
                        if (VARIANT.indices.length) {
                            device.uploadIndices(VARIANT.indexBuffer, VARIANT.indices);
                        }
                    }
                    for (const VARIANT of MESH.indexVariants.values()) {
                        if (VARIANT.indices.length) {
                            device.uploadIndices(VARIANT.indexBuffer, VARIANT.indices);
                        }
                    }
                }
                this.state = 'ready';
                this.failure = null;
            } catch (error) {
                this.state = 'failed';
                this.failure = error.message;
            }
        };
        device.canvas.addEventListener('webglcontextlost', this.onLost);
        device.canvas.addEventListener('webglcontextrestored', this.onRestored);
        this.disposed = false;
    }
    _poses() {
        if (!this.poseRenderer) {
            this.poseRenderer = new PoseRenderer(this.device, {
                backend: this.poseBackend,
                onBoundary: () => this.flush('poseResourceBoundary'),
            });
        }
        return this.poseRenderer;
    }
    createPoseSource(program) {
        return this._poses().createSource(program);
    }
    deletePoseSource(source) {
        return this.poseRenderer?.deleteSource(source) ?? false;
    }
    createPoseInstance(source) {
        return this._poses().createInstance(source);
    }
    deletePoseInstance(instance) {
        return this.poseRenderer?.deleteInstance(instance) ?? false;
    }
    preparePose(instance, options) {
        return this._poses().prepare(instance, options);
    }
    prepareCpuPose(instance, parts, morph, reason) {
        return this._poses().prepareCpu(instance, parts, morph, reason);
    }
    recordPoseFallback(reason) {
        this._poses().recordFallback(reason);
    }
    /** Updates all prepared numeric poses without changing visible submission order. */
    preparePoses() {
        this.poseRenderer?.flushUpdates();
    }
    poseStats() {
        return this.poseRenderer?.stats() ?? null;
    }
    _pipeline(mesh, clipped, worldMode = false, poseTexture = false) {
        const KEY =
            mesh.partCount +
            ':' +
            mesh.morphCount +
            ':' +
            Number(clipped) +
            ':' +
            Number(mesh.hasNonScalingStroke) +
            ':' +
            Number(worldMode) +
            ':' +
            Number(poseTexture) +
            ':' +
            Number(mesh.hasTextureCoordinates) + ':' + (mesh.paintRegionNames?.length ?? 0);
        let pipeline = this.pipelines.get(KEY);
        if (pipeline) {
            return pipeline;
        }
        const UNIFORMS = worldMode
            ? {
                  u_viewProjection: 'matrix4fv',
                  u_color: '4f',
              }
            : {
                  u_projection: 'matrix3fv',
              };
        if (clipped) {
            Object.assign(UNIFORMS, {
                'u_planes[0]': '3fv',
                u_planeCount: '1i',
            });
        }
        if (clipped && worldMode && mesh.hasNonScalingStroke) {
            UNIFORMS.u_inverseViewProjection = 'matrix4fv';
        }
        if (mesh.hasNonScalingStroke) {
            UNIFORMS.u_strokeViewportSize = '2f';
            if (clipped && !worldMode) {
                UNIFORMS.u_inverseProjection = 'matrix3fv';
            }
        }
        if (poseTexture) {
            UNIFORMS.u_poseTexture = '1i';
        } else if (mesh.partCount > 1) {
            UNIFORMS['u_parts[0]'] = '4fv';
        }
        if (mesh.hasTextureCoordinates) {
            UNIFORMS.u_texture = '1i';
            if (!this.instanced) {
                UNIFORMS.i_uvRect = '4f';
                UNIFORMS.i_localRect = '4f';
            }
        }
        if (mesh.paintRegionNames) {
            UNIFORMS['u_paintRegions[0]'] = '4fv';
        }
        if (!this.instanced) {
            for (const NAME of worldMode
                ? ['i_row0', 'i_row1', 'i_row2', 'i_params']
                : ['i_row0', 'i_row1', 'i_color', 'i_params']) {
                UNIFORMS[NAME] = '4f';
            }
        }
        pipeline = this.device.createPipeline({
            vertex: (poseTexture ? poseTextureShader : (source) => source)(
                shader(
                    this.instanced,
                    poseTexture ? Math.max(2, mesh.partCount) : mesh.partCount,
                    mesh.morphCount,
                    clipped,
                    mesh.hasNonScalingStroke,
                    worldMode,
                    mesh.hasTextureCoordinates,
                    poseTexture,
                    mesh.paintRegionNames?.length ?? 0,
                ),
            ),
            fragment: fragment(this.maxPlanes, clipped, mesh.hasTextureCoordinates),
            stride: mesh.bufferStrideFloats * 4,
            ...(this.instanced
                ? {
                      instanceStride: mesh.hasTextureCoordinates ? 96 : 64,
                  }
                : {}),
            attributes: [
                ...(mesh.paintRegionNames ? [{ name: 'a_paintRegion', size: 1, offset: 44 }] : []),
                ...(mesh.hasNonScalingStroke
                    ? ATTRIBUTES.filter((attribute) => attribute.name !== 'a_morph')
                    : ATTRIBUTES),
                ...(mesh.hasNonScalingStroke
                    ? [
                          {
                              name: 'a_stroke',
                              size: 4,
                              offset: 24,
                          },
                      ]
                    : []),
                ...(mesh.hasTextureCoordinates
                    ? [
                          {
                              name: 'a_uv',
                              size: 2,
                              offset: 44,
                          },
                      ]
                    : []),
                ...(this.instanced ? (worldMode ? WORLD_INSTANCE_ATTRIBUTES : INSTANCE_ATTRIBUTES) : []),
                ...(this.instanced && mesh.hasTextureCoordinates ? TEXTURE_INSTANCE_ATTRIBUTES : []),
            ],
            uniforms: UNIFORMS,
        });
        this.pipelines.set(KEY, pipeline);
        return pipeline;
    }
    createMesh(data) {
        this._ready();
        const INDICES = data?.indices;
        const UVS = data?.uvs === undefined ? null : data.uvs;
        const EXPRESSION_INDICES = data?.expressionIndices === undefined ? {} : data.expressionIndices;
        const INDEX_VARIANTS = data?.indexVariants === undefined ? {} : data.indexVariants;
        const NON_SCALING_STROKE = data?.nonScalingStroke ?? false;
        if (
            !(data?.vertices instanceof Float32Array) ||
            data.vertices.length < 33 ||
            data.vertices.length % 11 ||
            data.strideFloats !== 11 ||
            typeof NON_SCALING_STROKE !== 'boolean' ||
            !Number.isSafeInteger(data.partCount) ||
            data.partCount < 1 ||
            data.partCount > 16 ||
            !Number.isSafeInteger(data.morphCount) ||
            data.morphCount < 0 ||
            data.morphCount > 2 ||
            (INDICES !== undefined &&
                (!(INDICES instanceof Uint16Array) ||
                    INDICES.length < 3 ||
                    INDICES.length % 3 ||
                    data.vertices.length / 11 > 0x10000 ||
                    INDICES.some((index) => index >= data.vertices.length / 11))) ||
            (INDICES === undefined && data.vertices.length % 33) ||
            !EXPRESSION_INDICES ||
            typeof EXPRESSION_INDICES !== 'object' ||
            Array.isArray(EXPRESSION_INDICES) ||
            !INDEX_VARIANTS ||
            typeof INDEX_VARIANTS !== 'object' ||
            Array.isArray(INDEX_VARIANTS)
        ) {
            throw new TypeError('Mesh geometry with complete triangles and 1..16 parts required');
        }
        const EXPRESSION_ENTRIES = Object.entries(EXPRESSION_INDICES),
            INDEX_VARIANT_ENTRIES = Object.entries(INDEX_VARIANTS);
        const VARIANT_NAMES = new Set(EXPRESSION_ENTRIES.map(([name]) => name));
        if (
            EXPRESSION_ENTRIES.some(
                ([name, variant]) =>
                    !name ||
                    !(variant instanceof Uint16Array) ||
                    variant.length % 3 ||
                    variant.some((index) => index >= data.vertices.length / 11),
            ) ||
            INDEX_VARIANT_ENTRIES.some(
                ([name, variant]) =>
                    !/^[A-Za-z_][A-Za-z0-9_.:-]{0,127}$/.test(name) ||
                    VARIANT_NAMES.has(name) ||
                    !(variant instanceof Uint16Array) ||
                    variant.length % 3 ||
                    variant.some((index) => index >= data.vertices.length / 11),
            )
        ) {
            throw new TypeError('Invalid named mesh index variants or expression index variants');
        }
        if (
            UVS !== null &&
            (!(UVS instanceof Float32Array) ||
                UVS.length !== (data.vertices.length / 11) * 2 ||
                UVS.some((value) => !Number.isFinite(value)))
        ) {
            throw new TypeError('uvs must contain two finite coordinates per mesh vertex');
        }
        if (data.vertices.some((n) => !Number.isFinite(n))) {
            throw new TypeError('Mesh values must be finite');
        }
        for (let i = 0; i < data.vertices.length; i++) {
            if (i % 11 >= 2 && i % 11 < 6 && (data.vertices[i] < 0 || data.vertices[i] > 1)) {
                throw new RangeError('Mesh RGBA channels must be in [0,1]');
            }
            if (
                i % 11 === 10 &&
                (!Number.isSafeInteger(data.vertices[i]) || data.vertices[i] < 0 || data.vertices[i] >= data.partCount)
            ) {
                throw new RangeError('Mesh part index outside partCount');
            }
            if (i % 11 >= 6 + data.morphCount * 2 && i % 11 < 10 && data.vertices[i] !== 0 && !NON_SCALING_STROKE) {
                throw new RangeError('Mesh deltas exceed declared morphCount');
            }
        }
        if (NON_SCALING_STROKE && data.morphCount) {
            throw new TypeError('Non-scaling stroke meshes cannot use vertex morph targets');
        }
        const VARIANT_BYTE_LENGTH = [...EXPRESSION_ENTRIES, ...INDEX_VARIANT_ENTRIES].reduce(
            (total, [, variant]) => total + variant.byteLength,
            0,
        );
        validatePaintRegionData(data.paintRegions, data.vertices.length / 11, INDICES);
        if (data.paintRegions && UVS !== null) {
            throw new TypeError('Named fill regions require an untextured solid-fill mesh');
        }
        if (data.paintRegions) {
            for (const [, VARIANT] of [...EXPRESSION_ENTRIES, ...INDEX_VARIANT_ENTRIES]) {
                validatePaintRegionData(data.paintRegions, data.vertices.length / 11, VARIANT);
            }
        }
        const PAINT_INDICES = data.paintRegions?.indices,
            BUFFER_STRIDE = UVS !== null ? 13 : PAINT_INDICES ? 12 : 11;
        const GPU_VERTEX_BYTES = (data.vertices.length / 11) * BUFFER_STRIDE * 4;
        const UPLOAD_BYTE_LENGTH = GPU_VERTEX_BYTES + (INDICES?.byteLength ?? 0) + VARIANT_BYTE_LENGTH;
        const BYTE_LENGTH = UPLOAD_BYTE_LENGTH + (UVS !== null || PAINT_INDICES ? data.vertices.byteLength : 0);
        if (this.meshes.size >= this.maxMeshes || this.bytes + BYTE_LENGTH > this.maxMeshBytes) {
            throw new RangeError('Retained mesh budget exceeded');
        }
        const VERTICES = data.vertices.slice(),
            GPU_VERTICES = UVS === null ? paintVertexStream(VERTICES, PAINT_INDICES) : new Float32Array((VERTICES.length / 11) * 13),
            OWNED_INDICES = INDICES?.slice(),
            BUFFER = this.device.createVertexBuffer({
                capacityBytes: GPU_VERTICES.byteLength,
            });
        if (UVS !== null) {
            for (let vertex = 0; vertex < VERTICES.length / 11; vertex++) {
                GPU_VERTICES.set(VERTICES.subarray(vertex * 11, vertex * 11 + 11), vertex * 13);
                GPU_VERTICES[vertex * 13 + 11] = UVS[vertex * 2];
                GPU_VERTICES[vertex * 13 + 12] = UVS[vertex * 2 + 1];
            }
        }
        let indexBuffer;
        const OWNED_EXPRESSIONS = new Map(),
            OWNED_VARIANTS = new Map();
        try {
            this.device.uploadVertices(BUFFER, GPU_VERTICES);
            if (OWNED_INDICES) {
                indexBuffer = this.device.createIndexBuffer({
                    capacityBytes: OWNED_INDICES.byteLength,
                });
                this.device.uploadIndices(indexBuffer, OWNED_INDICES);
            }
            for (const [NAME, SOURCE] of EXPRESSION_ENTRIES) {
                const VARIANT_INDICES = SOURCE.slice();
                const VARIANT_BUFFER = VARIANT_INDICES.length
                    ? this.device.createIndexBuffer({
                          capacityBytes: VARIANT_INDICES.byteLength,
                      })
                    : null;
                const VARIANT = {
                    indices: VARIANT_INDICES,
                    indexBuffer: VARIANT_BUFFER,
                    count: VARIANT_INDICES.length,
                };
                OWNED_EXPRESSIONS.set(NAME, VARIANT);
                if (VARIANT_BUFFER) {
                    this.device.uploadIndices(VARIANT_BUFFER, VARIANT_INDICES);
                }
            }
            for (const [NAME, SOURCE] of INDEX_VARIANT_ENTRIES) {
                const VARIANT_INDICES = SOURCE.slice();
                const VARIANT_BUFFER = VARIANT_INDICES.length
                    ? this.device.createIndexBuffer({
                          capacityBytes: VARIANT_INDICES.byteLength,
                      })
                    : null;
                const VARIANT = {
                    indices: VARIANT_INDICES,
                    indexBuffer: VARIANT_BUFFER,
                    count: VARIANT_INDICES.length,
                };
                OWNED_VARIANTS.set(NAME, VARIANT);
                if (VARIANT_BUFFER) {
                    this.device.uploadIndices(VARIANT_BUFFER, VARIANT_INDICES);
                }
            }
        } catch (error) {
            for (const VARIANT of OWNED_EXPRESSIONS.values()) {
                if (VARIANT.indexBuffer) {
                    this.device.deleteIndexBuffer(VARIANT.indexBuffer);
                }
            }
            for (const VARIANT of OWNED_VARIANTS.values()) {
                if (VARIANT.indexBuffer) {
                    this.device.deleteIndexBuffer(VARIANT.indexBuffer);
                }
            }
            if (indexBuffer) {
                this.device.deleteIndexBuffer(indexBuffer);
            }
            this.device.deleteVertexBuffer(BUFFER);
            throw error;
        }
        const MESH = Object.freeze({
            renderer: this,
            buffer: BUFFER,
            indexBuffer,
            vertices: VERTICES,
            gpuVertices: GPU_VERTICES,
            indices: OWNED_INDICES,
            expressionIndices: OWNED_EXPRESSIONS,
            indexVariants: OWNED_VARIANTS,
            count: OWNED_INDICES?.length ?? VERTICES.length / 11,
            byteLength: BYTE_LENGTH,
            partCount: data.partCount,
            morphCount: data.morphCount,
            strideFloats: 11,
            bufferStrideFloats: BUFFER_STRIDE,
            paintRegionNames: data.paintRegions ? Object.freeze(data.paintRegions.names.slice()) : null,
            hasTextureCoordinates: UVS !== null,
            hasNonScalingStroke: NON_SCALING_STROKE,
            partBounds: meshPartBounds(VERTICES, data.partCount, data.morphCount),
        });
        this.meshes.add(MESH);
        this.bytes += BYTE_LENGTH;
        this.device.stats.meshCreates++;
        this.metrics.geometryUploads++;
        this.metrics.geometryBytesUploaded += UPLOAD_BYTE_LENGTH;
        return MESH;
    }
    deleteMesh(mesh) {
        if (!this.meshes.has(mesh)) {
            return false;
        }
        if (this.pending?.mesh === mesh || (this.alphaQueueCount && this.alphaQueueState.mesh === mesh)) {
            this.flush('deleteMesh');
        }
        this.alphaRunCache.delete(mesh);
        this.device.deleteVertexBuffer(mesh.buffer);
        if (mesh.indexBuffer) {
            this.device.deleteIndexBuffer(mesh.indexBuffer);
        }
        for (const VARIANT of mesh.expressionIndices.values()) {
            if (VARIANT.indexBuffer) {
                this.device.deleteIndexBuffer(VARIANT.indexBuffer);
            }
        }
        for (const VARIANT of mesh.indexVariants.values()) {
            if (VARIANT.indexBuffer) {
                this.device.deleteIndexBuffer(VARIANT.indexBuffer);
            }
        }
        this.meshes.delete(mesh);
        this.bytes -= mesh.byteLength;
        return true;
    }
    /** Captures state by value; subsequent transform/paint changes do not alter queued instances. */
    drawMesh(mesh, options = {}) {
        const {
            matrix: MATRIX = IDENTITY,
            projection: PROJECTION,
            morph: MORPH = [0, 0],
            parts: PARTS = null,
            pose: POSE = null,
            texture: TEXTURE = null,
            uvRect: UV_RECT = IDENTITY_RECT,
            localRect: LOCAL_RECT = IDENTITY_RECT,
            color: COLOR = WHITE,
            paintRegions: PAINT_REGIONS = null,
            forceColor: FORCE_COLOR = false,
            alpha: ALPHA = 1,
            whiteFlash: WHITE_FLASH = false,
            clips: CLIPS = [],
            depth: DEPTH = 0,
            depthTest: DEPTH_TEST = false,
            depthWrite: DEPTH_WRITE = false,
            depthWriteAlphaThreshold: DEPTH_WRITE_ALPHA_THRESHOLD = null,
            depthFunc: DEPTH_FUNC = 'lequal',
            indexVariant: INDEX_VARIANT = null,
            indexRange: INDEX_RANGE = null,
            strokeViewport: STROKE_VIEWPORT = null,
            stencilRef: STENCIL_REF = null,
            viewProjection: VIEW_PROJECTION,
            worldMatrix: WORLD_MATRIX,
        } = options;
        this._drawMeshInstances(mesh, {
            matrices: MATRIX,
            count: 1,
            projection: PROJECTION,
            viewProjection: VIEW_PROJECTION,
            worldMatrix: WORLD_MATRIX,
            morph: MORPH,
            parts: PARTS,
            pose: POSE,
            texture: TEXTURE,
            uvRect: UV_RECT,
            localRect: LOCAL_RECT,
            color: COLOR,
            paintRegions: PAINT_REGIONS,
            forceColor: FORCE_COLOR,
            alpha: ALPHA,
            whiteFlash: WHITE_FLASH,
            clips: CLIPS,
            indexVariant: INDEX_VARIANT,
            indexRange: INDEX_RANGE,
            depth: DEPTH,
            depthTest: DEPTH_TEST,
            depthWrite: DEPTH_WRITE,
            depthWriteAlphaThreshold: DEPTH_WRITE_ALPHA_THRESHOLD,
            depthFunc: DEPTH_FUNC,
            strokeViewport: STROKE_VIEWPORT,
            stencilRef: STENCIL_REF,
        });
    }
    _setPaintRegions(mesh, overrides) {
        const NAMES = mesh.paintRegionNames ?? [],
            SIZE = NAMES.length ? (NAMES.length + 1) * 4 : 0;
        this.paintScratch ??= new Float32Array((MAX_PAINT_REGIONS + 1) * 4);
        packPaintRegions(NAMES, overrides, this.paintScratch);
        let same = (this.paintState?.length ?? 0) === SIZE;
        for (let index = 0; same && index < SIZE; index++) {
            same = this.paintState[index] === this.paintScratch[index];
        }
        if (same) {
            return;
        }
        // Both the ordinary batch and alpha-run queue still belong to the previous palette.
        this.flush('paintRegions');
        this.paintState = SIZE ? this.paintScratch.slice(0, SIZE) : null;
    }
    _screenBounds(mesh, matrices, instanceIndex, projection, morph) {
        if (mesh.hasNonScalingStroke || projection[2] !== 0 || projection[5] !== 0 || Math.abs(projection[8]) < 1e-12) {
            return null;
        }
        const WIDTH = this.device.activeRenderTarget?.width ?? this.device.canvas.width;
        const HEIGHT = this.device.activeRenderTarget?.height ?? this.device.canvas.height;
        const MATRIX_AT = instanceIndex * 6,
            M0 = matrices[MATRIX_AT],
            M1 = matrices[MATRIX_AT + 1],
            M2 = matrices[MATRIX_AT + 2],
            M3 = matrices[MATRIX_AT + 3],
            M4 = matrices[MATRIX_AT + 4],
            M5 = matrices[MATRIX_AT + 5];
        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;
        for (let partIndex = 0; partIndex < mesh.partCount; partIndex++) {
            const BOUND = mesh.partBounds[partIndex],
                AT = partIndex * 12,
                POSE_MORPH0 = morph[0] + this.partScratch[AT + 8],
                POSE_MORPH1 = morph[1] + this.partScratch[AT + 9];
            const X0 =
                BOUND.minX +
                (POSE_MORPH0 < 0 ? BOUND.maxDx0 : BOUND.minDx0) * POSE_MORPH0 +
                (POSE_MORPH1 < 0 ? BOUND.maxDx1 : BOUND.minDx1) * POSE_MORPH1;
            const X1 =
                BOUND.maxX +
                (POSE_MORPH0 < 0 ? BOUND.minDx0 : BOUND.maxDx0) * POSE_MORPH0 +
                (POSE_MORPH1 < 0 ? BOUND.minDx1 : BOUND.maxDx1) * POSE_MORPH1;
            const Y0 =
                BOUND.minY +
                (POSE_MORPH0 < 0 ? BOUND.maxDy0 : BOUND.minDy0) * POSE_MORPH0 +
                (POSE_MORPH1 < 0 ? BOUND.maxDy1 : BOUND.minDy1) * POSE_MORPH1;
            const Y1 =
                BOUND.maxY +
                (POSE_MORPH0 < 0 ? BOUND.minDy0 : BOUND.maxDy0) * POSE_MORPH0 +
                (POSE_MORPH1 < 0 ? BOUND.minDy1 : BOUND.maxDy1) * POSE_MORPH1;
            const PA = this.partScratch[AT],
                PC = this.partScratch[AT + 1],
                PE = this.partScratch[AT + 2];
            const PB = this.partScratch[AT + 4],
                PD = this.partScratch[AT + 5],
                PF = this.partScratch[AT + 6];
            for (let xi = 0; xi < 2; xi++) {
                for (let yi = 0; yi < 2; yi++) {
                    const X = xi ? X1 : X0,
                        Y = yi ? Y1 : Y0,
                        PART_X = PA * X + PC * Y + PE,
                        PART_Y = PB * X + PD * Y + PF;
                    const WORLD_X = M0 * PART_X + M2 * PART_Y + M4,
                        WORLD_Y = M1 * PART_X + M3 * PART_Y + M5;
                    const CLIP_X = projection[0] * WORLD_X + projection[3] * WORLD_Y + projection[6],
                        CLIP_Y = projection[1] * WORLD_X + projection[4] * WORLD_Y + projection[7];
                    const PX = ((CLIP_X / projection[8] + 1) * WIDTH) / 2,
                        PY = ((1 - CLIP_Y / projection[8]) * HEIGHT) / 2;
                    if (!Number.isFinite(PX) || !Number.isFinite(PY)) {
                        return null;
                    }
                    minX = Math.min(minX, PX);
                    maxX = Math.max(maxX, PX);
                    minY = Math.min(minY, PY);
                    maxY = Math.max(maxY, PY);
                }
            }
        }
        if (!Number.isFinite(minX)) {
            return null;
        }
        const BOUNDS = this.alphaBoundsScratch;
        BOUNDS.minX = minX - 1.5;
        BOUNDS.minY = minY - 1.5;
        BOUNDS.maxX = maxX + 1.5;
        BOUNDS.maxY = maxY + 1.5;
        return BOUNDS;
    }
    _boundsOverlap(a, b) {
        return !(a.maxX < b.minX || b.maxX < a.minX || a.maxY < b.minY || b.maxY < a.minY);
    }
    _extendAlphaQueueBounds(bounds) {
        const GROUP = this.alphaQueueBounds;
        if (!this.alphaQueueCount) {
            Object.assign(GROUP, bounds);
        } else {
            GROUP.minX = Math.min(GROUP.minX, bounds.minX);
            GROUP.minY = Math.min(GROUP.minY, bounds.minY);
            GROUP.maxX = Math.max(GROUP.maxX, bounds.maxX);
            GROUP.maxY = Math.max(GROUP.maxY, bounds.maxY);
        }
    }
    _alphaQueueMatches(mesh, projection, clip, stencilRef, depthTest, depthFunc, indexVariant, runs) {
        const STATE = this.alphaQueueState;
        if (!STATE) {
            return true;
        }
        if (
            STATE.mesh !== mesh ||
            STATE.indexVariant !== indexVariant ||
            STATE.clip.key !== clip.key ||
            STATE.stencilRef !== stencilRef ||
            STATE.depthTest !== depthTest ||
            STATE.depthFunc !== depthFunc ||
            STATE.runKey !== runs.join(',') ||
            projection.some((n, i) => Math.fround(n) !== STATE.projection[i])
        ) {
            return false;
        }
        for (let i = 0; i < mesh.partCount * 12; i++) {
            if (this.partScratch[i] !== this.alphaQueueParts[i]) {
                return false;
            }
        }
        return true;
    }
    _startAlphaQueue(mesh, projection, clip, stencilRef, depthTest, depthFunc, indexVariant, runs) {
        this.alphaQueueParts.set(this.partScratch.subarray(0, mesh.partCount * 12));
        this.alphaQueueState = {
            mesh,
            projection: Float32Array.from(projection),
            clip,
            stencilRef,
            depthTest,
            depthFunc,
            indexVariant,
            runs: runs.slice(),
            runKey: runs.join(','),
        };
    }
    _flushAlphaQueue(reason) {
        if (!this.alphaQueueCount) {
            return;
        }
        const STATE = this.alphaQueueState,
            MESH = STATE.mesh,
            PARTS = this.alphaQueueParts.subarray(0, MESH.partCount * 12);
        const INDEX_BUFFER_VARIANT =
            STATE.indexVariant === null
                ? null
                : (MESH.indexVariants.get(STATE.indexVariant) ?? MESH.expressionIndices.get(STATE.indexVariant));
        const PROJECTION = STATE.projection,
            CLIP = STATE.clip,
            PIPELINE = this._pipeline(MESH, CLIP.count > 0),
            UNIFORMS = {
                u_projection: PROJECTION,
            };
        this.planes.fill(0);
        if (CLIP.values) {
            this.planes.set(CLIP.values);
        }
        if (CLIP.count) {
            Object.assign(UNIFORMS, {
                'u_planes[0]': this.planes,
                u_planeCount: CLIP.count,
            });
        }
        if (MESH.paintRegionNames) {
            UNIFORMS['u_paintRegions[0]'] = this.paintState;
        }
        if (MESH.partCount > 1) {
            UNIFORMS['u_parts[0]'] = PARTS;
        }
        const INSTANCES = this.alphaQueueCount;
        this.device.uploadVertices(this.instanceBuffer, this.instances.subarray(0, INSTANCES * 16));
        this.metrics.instanceBytesUploaded += INSTANCES * 64;
        for (let run = 0; run < STATE.runs.length; run += 3) {
            this.device.draw({
                pipeline: PIPELINE,
                buffer: MESH.buffer,
                indexBuffer: INDEX_BUFFER_VARIANT?.indexBuffer ?? MESH.indexBuffer,
                first: STATE.runs[run],
                count: STATE.runs[run + 1],
                instanceBuffer: this.instanceBuffer,
                instances: INSTANCES,
                uniforms: UNIFORMS,
                depth: {
                    test: STATE.depthTest,
                    write: STATE.runs[run + 2],
                    func: STATE.depthFunc,
                },
                stencil:
                    STATE.stencilRef === null
                        ? false
                        : {
                              func: 'equal',
                              ref: STATE.stencilRef,
                              mask: 255,
                              writeMask: 0,
                              pass: 'keep',
                          },
            });
            this.metrics.draws++;
            this.metrics.drawDispatchReasons[reason] = (this.metrics.drawDispatchReasons[reason] ?? 0) + 1;
            this.metrics.alphaRunSafeRunDraws++;
            if (MESH.partCount > 1) {
                this.metrics.partUniformBytesSubmitted += PARTS.byteLength;
            }
        }
        this.metrics.instances += INSTANCES;
        if (INSTANCES > 1) {
            this.metrics.alphaRunSafeBatches++;
            this.metrics.alphaRunBatchedInstances += INSTANCES;
            this.metrics.alphaRunDrawsSaved += (INSTANCES - 1) * (STATE.runs.length / 3);
        }
        this.metrics.flushReasons[reason] = (this.metrics.flushReasons[reason] ?? 0) + 1;
        this.alphaQueueCount = 0;
        this.alphaQueueState = null;
    }
    /** Internal ordered instance append used when one retained pose has several transforms. */
    _drawMeshInstances(
        mesh,
        {
            matrices,
            count,
            projection,
            viewProjection,
            worldMatrix,
            morph = [0, 0],
            parts = null,
            pose = null,
            texture = null,
            uvRect = IDENTITY_RECT,
            localRect = IDENTITY_RECT,
            color = WHITE,
            paintRegions = null,
            forceColor = false,
            alpha = 1,
            whiteFlash = false,
            clips = [],
            prefixColor = null,
            prefixCount = 0,
            forceColorPrefixCount = 0,
            depth = 0,
            depthTest = false,
            depthWrite = false,
            depthWriteAlphaThreshold = null,
            depthFunc = 'lequal',
            indexVariant = null,
            indexRange = null,
            strokeViewport = null,
            stencilRef = null,
        } = {},
    ) {
        this._ready();
        if (!this.meshes.has(mesh)) {
            throw new TypeError('Mesh owned by this renderer required');
        }
        if (
            mesh.hasTextureCoordinates !== (texture !== null) ||
            (texture !== null && !this.device.textures.has(texture))
        ) {
            throw new TypeError('Textured meshes require a live texture; plain meshes cannot sample one');
        }
        if (uvRect !== IDENTITY_RECT) {
            finiteArray(uvRect, 4, 'uvRect');
        }
        if (localRect !== IDENTITY_RECT) {
            finiteArray(localRect, 4, 'localRect');
        }
        if (
            !mesh.hasTextureCoordinates &&
            ((uvRect !== IDENTITY_RECT && Array.from(uvRect).some((value, index) => value !== IDENTITY_RECT[index])) ||
                (localRect !== IDENTITY_RECT &&
                    Array.from(localRect).some((value, index) => value !== IDENTITY_RECT[index])))
        ) {
            throw new TypeError('uvRect and localRect require a textured mesh');
        }
        if (mesh.hasTextureCoordinates && this.maxTexturedInstances < 1) {
            throw new RangeError('A textured instance exceeds device maxBufferBytes');
        }
        if (
            indexVariant !== null &&
            (typeof indexVariant !== 'string' ||
                (!mesh.expressionIndices.has(indexVariant) && !mesh.indexVariants.has(indexVariant)))
        ) {
            throw new TypeError('Known mesh index variant required');
        }
        if (!this.device.active) {
            throw new Error('beginFrame required');
        }
        if (stencilRef !== null && (!Number.isSafeInteger(stencilRef) || stencilRef < 0 || stencilRef > 255)) {
            throw new RangeError('stencilRef must be null or in [0,255]');
        }
        if (stencilRef !== null && !this.device.activeStencilAvailable) {
            throw new Error('A stencil-tested mesh requires an active stencil attachment');
        }
        if (!Number.isSafeInteger(count) || count < 1 || !matrices || matrices.length !== count * 6) {
            throw new TypeError('Packed mesh instance matrices required');
        }
        for (let i = 0; i < matrices.length; i++) {
            if (!Number.isFinite(matrices[i])) {
                throw new TypeError('Mesh matrix values must be finite');
            }
        }
        const WORLD_MODE = viewProjection !== undefined || worldMatrix !== undefined;
        if (WORLD_MODE) {
            if (projection !== undefined || viewProjection === undefined || worldMatrix === undefined) {
                throw new TypeError(
                    '3D mesh draws require viewProjection and worldMatrix and cannot include projection',
                );
            }
            finiteArray(viewProjection, 16, 'viewProjection');
            affineMatrix4(worldMatrix, 'worldMatrix');
        } else {
            finiteArray(projection, 9, 'projection');
        }
        finiteArray(morph, 2, 'morph');
        finiteArray(color, 4, 'color');
        let strokeSize = null;
        let inverseStrokeProjection = null;
        let inverseViewProjection = null;
        if (mesh.hasNonScalingStroke) {
            if (strokeViewport === null) {
                if (this.device.activeRenderTarget) {
                    throw new Error('A strokeViewport is required for non-scaling strokes rendered to a render target');
                }
                strokeSize = [this.device.canvas.clientWidth, this.device.canvas.clientHeight];
            } else {
                finiteArray(strokeViewport, 2, 'strokeViewport');
                strokeSize = [strokeViewport[0], strokeViewport[1]];
            }
            if (strokeSize.some((value) => !Number.isFinite(value) || value <= 0)) {
                throw new RangeError('Non-scaling strokes require a positive CSS-pixel viewport size');
            }
            if (!WORLD_MODE) {
                inverseStrokeProjection = invertProjection(projection);
            } else if (clipState(clips, this.maxPlanes).count) {
                inverseViewProjection = invertMatrix4(viewProjection);
            }
        }
        if (!Number.isFinite(alpha) || alpha < 0 || alpha > 1 || color.some((n) => n < 0 || n > 1)) {
            throw new RangeError('RGBA/alpha in [0,1] required');
        }
        if (!Number.isFinite(depth) || depth < -1 || depth > 1) {
            throw new RangeError('depth must be in [-1,1]');
        }
        if (typeof depthTest !== 'boolean' || typeof depthWrite !== 'boolean') {
            throw new TypeError('depthTest and depthWrite must be booleans');
        }
        if (
            depthWriteAlphaThreshold !== null &&
            (!Number.isFinite(depthWriteAlphaThreshold) || depthWriteAlphaThreshold < 0 || depthWriteAlphaThreshold > 1)
        ) {
            throw new RangeError('depthWriteAlphaThreshold must be in [0,1]');
        }
        if (WORLD_MODE && depthWriteAlphaThreshold !== null) {
            throw new TypeError('depthWriteAlphaThreshold is currently supported only for 2D mesh draws');
        }
        if (!['never', 'less', 'equal', 'lequal', 'greater', 'notequal', 'gequal', 'always'].includes(depthFunc)) {
            throw new TypeError('Unsupported depthFunc');
        }
        if (
            !Number.isSafeInteger(prefixCount) ||
            prefixCount < 0 ||
            prefixCount > count ||
            !Number.isSafeInteger(forceColorPrefixCount) ||
            forceColorPrefixCount < 0 ||
            forceColorPrefixCount > count
        ) {
            throw new RangeError('Instance color prefix count is invalid');
        }
        if (prefixCount && !prefixColor) {
            throw new TypeError('A prefix color is required for colored mesh instances');
        }
        if (prefixColor !== null) {
            finiteArray(prefixColor, 4, 'prefix color');
            if (prefixColor.some((n) => n < 0 || n > 1)) {
                throw new RangeError('RGBA channels must be in [0,1]');
            }
        }
        if (WORLD_MODE && (prefixCount || forceColorPrefixCount)) {
            throw new TypeError('Per-instance color prefixes are not supported for 3D mesh draws');
        }
        if (
            indexRange !== null &&
            (indexVariant !== null ||
                !Array.isArray(indexRange) ||
                indexRange.length !== 2 ||
                !Number.isSafeInteger(indexRange[0]) ||
                !Number.isSafeInteger(indexRange[1]) ||
                indexRange[0] < 0 ||
                indexRange[1] < 0 ||
                indexRange[0] % 3 ||
                indexRange[1] % 3)
        ) {
            throw new TypeError(
                'indexRange must be [firstIndex, triangleAlignedCount] and cannot be combined with indexVariant',
            );
        }
        if (indexRange !== null && depthWriteAlphaThreshold !== null) {
            throw new TypeError('indexRange is currently supported only for ordinary ordered mesh draws');
        }
        const CLIP = clipState(clips, this.maxPlanes);
        const VARIANT =
            indexVariant === null
                ? null
                : (mesh.indexVariants.get(indexVariant) ?? mesh.expressionIndices.get(indexVariant));
        const FIRST_INDEX = indexRange?.[0] ?? 0,
            INDEX_COUNT = indexRange?.[1] ?? VARIANT?.count ?? mesh.count;
        if (FIRST_INDEX + INDEX_COUNT > (VARIANT?.count ?? mesh.count)) {
            throw new RangeError('indexRange exceeds the selected mesh index data');
        }
        const POSE_DRAW = pose === null ? null : this._poses().resolve(pose);
        if (POSE_DRAW && POSE_DRAW.partCount !== mesh.partCount) {
            throw new TypeError('Pose and mesh part counts must match');
        }
        if (POSE_DRAW && depthWriteAlphaThreshold !== null) {
            throw new TypeError('Alpha depth classification requires ordinary CPU part poses');
        }
        if (texture !== null && depthWriteAlphaThreshold !== null) {
            throw new TypeError('Alpha depth classification cannot inspect raster texel alpha');
        }
        if (texture !== null && POSE_DRAW?.texture && this.device.maxTextures < 2) {
            throw new RangeError('Textured GPU poses require two texture units');
        }
        packParts(parts, mesh.partCount, this.partScratch);
        for (let i = 0; i < mesh.partCount; i++) {
            if (depth + this.partScratch[i * 12 + 11] < -1 || depth + this.partScratch[i * 12 + 11] > 1) {
                throw new RangeError('combined mesh and part depth must be in [-1,1]');
            }
        }
        if (mesh.paintRegionNames || paintRegions !== null || this.paintState) {
            this._setPaintRegions(mesh, paintRegions);
        }
        const PENDING = this.pending;
        const DEPTH_STATE_KEY = Number(depthTest) + ':' + Number(depthWrite) + ':' + depthFunc;
        const ALPHA_DEPTH_WRITE = depthWrite && depthWriteAlphaThreshold !== null;
        if (!ALPHA_DEPTH_WRITE) {
            const INSTANCE_LIMIT = mesh.hasTextureCoordinates ? this.maxTexturedInstances : this.maxInstances;
            const INSTANCE_FLOATS = mesh.hasTextureCoordinates ? 24 : 16;
            const DATA = mesh.hasTextureCoordinates
                ? (this.texturedInstances ??= new Float32Array(this.maxTexturedInstances * 24))
                : this.instances;
            if (this.alphaQueueCount) {
                this._flushAlphaQueue('alphaBoundary');
            }
            if (PENDING) {
                const MATRIX = WORLD_MODE ? viewProjection : projection;
                const PREVIOUS_COLOR = PENDING.color;
                const REASON =
                    (PENDING.poseTexture ?? null) !== (POSE_DRAW?.texture ?? null)
                        ? 'poseBackend'
                        : PENDING.texture !== texture
                          ? 'texture'
                          : PENDING.mesh !== mesh
                            ? 'mesh'
                            : PENDING.worldMode !== WORLD_MODE
                              ? 'transformMode'
                              : PENDING.indexVariant !== indexVariant
                                ? 'indexVariant'
                                : PENDING.firstIndex !== FIRST_INDEX || PENDING.indexCount !== INDEX_COUNT
                                  ? 'indexRange'
                                  : PENDING.clip.key !== CLIP.key
                                    ? 'clip'
                                    : PENDING.stencilRef !== stencilRef
                                      ? 'stencil'
                                      : PENDING.depthStateKey !== DEPTH_STATE_KEY
                                        ? 'depthState'
                                        : MATRIX.some((n, i) => Math.fround(n) !== PENDING.projection[i])
                                          ? 'projection'
                                          : strokeSize && strokeSize.some((n, i) => n !== PENDING.strokeSize?.[i])
                                            ? 'strokeViewport'
                                            : WORLD_MODE && color.some((n, i) => n !== PREVIOUS_COLOR[i])
                                              ? 'color'
                                              : !POSE_DRAW &&
                                                  mesh.partCount > 1 &&
                                                  PENDING.parts.some((n, i) => n !== this.partScratch[i])
                                                ? 'parts'
                                                : this.count === INSTANCE_LIMIT
                                                  ? 'capacity'
                                                  : null;
                if (REASON) {
                    this.flush(REASON);
                }
            }
            if (VARIANT?.count === 0) {
                return;
            }
            const PART = this.partScratch,
                SINGLE_PART = mesh.partCount === 1 && !POSE_DRAW;
            for (let i = 0; i < count; i++) {
                if (this.count === INSTANCE_LIMIT) {
                    this.flush('capacity');
                }
                if (!this.pending) {
                    this.pending = {
                        mesh,
                        poseTexture: POSE_DRAW?.texture ?? null,
                        texture,
                        projection: Float32Array.from(WORLD_MODE ? viewProjection : projection),
                        worldMode: WORLD_MODE,
                        color: Float32Array.from(color),
                        clip: CLIP,
                        stencilRef,
                        depthStateKey: DEPTH_STATE_KEY,
                        indexVariant,
                        firstIndex: FIRST_INDEX,
                        indexCount: INDEX_COUNT,
                        strokeSize,
                        inverseStrokeProjection,
                        inverseViewProjection,
                        depthState: {
                            test: depthTest,
                            write: depthWrite,
                            func: depthFunc,
                        },
                        parts: this.partScratch.slice(0, mesh.partCount > 1 ? mesh.partCount * 12 : 0),
                    };
                }
                const OFFSET = i * 6;
                let m0 = matrices[OFFSET];
                let m1 = matrices[OFFSET + 1];
                let m2 = matrices[OFFSET + 2];
                let m3 = matrices[OFFSET + 3];
                let m4 = matrices[OFFSET + 4];
                let m5 = matrices[OFFSET + 5];
                let weight0 = POSE_DRAW ? -1 - POSE_DRAW.row : morph[0];
                let weight1 = morph[1];
                let instanceAlpha = alpha;
                if (SINGLE_PART) {
                    const A_LOCAL = m0,
                        B_LOCAL = m1,
                        C_LOCAL = m2,
                        D_LOCAL = m3;
                    m0 = A_LOCAL * PART[0] + C_LOCAL * PART[4];
                    m1 = B_LOCAL * PART[0] + D_LOCAL * PART[4];
                    m2 = A_LOCAL * PART[1] + C_LOCAL * PART[5];
                    m3 = B_LOCAL * PART[1] + D_LOCAL * PART[5];
                    m4 = A_LOCAL * PART[2] + C_LOCAL * PART[6] + m4;
                    m5 = B_LOCAL * PART[2] + D_LOCAL * PART[6] + m5;
                    instanceAlpha *= PART[10];
                    weight0 += PART[8];
                    weight1 += PART[9];
                }
                const INSTANCE_COLOR = i < prefixCount ? prefixColor : color;
                const INSTANCE_FORCE_COLOR = i < forceColorPrefixCount ? true : forceColor,
                    AT = this.count++ * INSTANCE_FLOATS;
                const INSTANCE_DEPTH = depth + (SINGLE_PART ? PART[11] : 0);
                if (POSE_DRAW) {
                    this.poseRenderer.noteDraw(pose);
                }
                if (WORLD_MODE) {
                    DATA[AT] = worldMatrix[0] * m0 + worldMatrix[4] * m1;
                    DATA[AT + 1] = worldMatrix[0] * m2 + worldMatrix[4] * m3;
                    DATA[AT + 2] = worldMatrix[0] * m4 + worldMatrix[4] * m5 + worldMatrix[12];
                    DATA[AT + 3] = instanceAlpha;
                    DATA[AT + 4] = worldMatrix[1] * m0 + worldMatrix[5] * m1;
                    DATA[AT + 5] = worldMatrix[1] * m2 + worldMatrix[5] * m3;
                    DATA[AT + 6] = worldMatrix[1] * m4 + worldMatrix[5] * m5 + worldMatrix[13];
                    DATA[AT + 7] = INSTANCE_FORCE_COLOR ? 1 : 0;
                    DATA[AT + 8] = worldMatrix[2] * m0 + worldMatrix[6] * m1;
                    DATA[AT + 9] = worldMatrix[2] * m2 + worldMatrix[6] * m3;
                    DATA[AT + 10] = worldMatrix[2] * m4 + worldMatrix[6] * m5 + worldMatrix[14];
                    DATA[AT + 11] = whiteFlash ? 1 : 0;
                    DATA[AT + 12] = weight0;
                    DATA[AT + 13] = weight1;
                    DATA[AT + 14] = 0;
                    DATA[AT + 15] = INSTANCE_DEPTH;
                } else {
                    DATA[AT] = m0;
                    DATA[AT + 1] = m2;
                    DATA[AT + 2] = m4;
                    DATA[AT + 3] = instanceAlpha;
                    DATA[AT + 4] = m1;
                    DATA[AT + 5] = m3;
                    DATA[AT + 6] = m5;
                    DATA[AT + 7] = INSTANCE_FORCE_COLOR ? 1 : 0;
                    DATA[AT + 8] = INSTANCE_COLOR[0];
                    DATA[AT + 9] = INSTANCE_COLOR[1];
                    DATA[AT + 10] = INSTANCE_COLOR[2];
                    DATA[AT + 11] = INSTANCE_COLOR[3];
                    DATA[AT + 12] = weight0;
                    DATA[AT + 13] = weight1;
                    DATA[AT + 14] = whiteFlash ? 1 : 0;
                    DATA[AT + 15] = INSTANCE_DEPTH;
                }
                if (mesh.hasTextureCoordinates) {
                    DATA.set(uvRect, AT + 16);
                    DATA.set(localRect, AT + 20);
                }
            }
            return;
        }
        if (VARIANT?.count === 0) {
            return;
        }
        const INDICES = VARIANT?.indices ?? mesh.indices;
        const TRIANGLE_COUNT = (VARIANT?.count ?? mesh.count) / 3;
        const PART = this.partScratch,
            SINGLE_PART = mesh.partCount === 1;
        const WRITE_ALPHA_INSTANCE = (i, slot) => {
            const OFFSET = i * 6;
            let m0 = matrices[OFFSET];
            let m1 = matrices[OFFSET + 1];
            let m2 = matrices[OFFSET + 2];
            let m3 = matrices[OFFSET + 3];
            let m4 = matrices[OFFSET + 4];
            let m5 = matrices[OFFSET + 5];
            let weight0 = morph[0];
            let weight1 = morph[1];
            let instanceAlpha = alpha;
            if (SINGLE_PART) {
                const A_LOCAL = m0,
                    B_LOCAL = m1,
                    C_LOCAL = m2,
                    D_LOCAL = m3;
                m0 = A_LOCAL * PART[0] + C_LOCAL * PART[4];
                m1 = B_LOCAL * PART[0] + D_LOCAL * PART[4];
                m2 = A_LOCAL * PART[1] + C_LOCAL * PART[5];
                m3 = B_LOCAL * PART[1] + D_LOCAL * PART[5];
                m4 = A_LOCAL * PART[2] + C_LOCAL * PART[6] + m4;
                m5 = B_LOCAL * PART[2] + D_LOCAL * PART[6] + m5;
                instanceAlpha *= PART[10];
                weight0 += PART[8];
                weight1 += PART[9];
            }
            const INSTANCE_COLOR = i < prefixCount ? prefixColor : color;
            const INSTANCE_FORCE_COLOR = i < forceColorPrefixCount ? true : forceColor,
                AT = slot * 16,
                DATA = this.instances;
            DATA[AT] = m0;
            DATA[AT + 1] = m2;
            DATA[AT + 2] = m4;
            DATA[AT + 3] = instanceAlpha;
            DATA[AT + 4] = m1;
            DATA[AT + 5] = m3;
            DATA[AT + 6] = m5;
            DATA[AT + 7] = INSTANCE_FORCE_COLOR ? 1 : 0;
            DATA[AT + 8] = INSTANCE_COLOR[0];
            DATA[AT + 9] = INSTANCE_COLOR[1];
            DATA[AT + 10] = INSTANCE_COLOR[2];
            DATA[AT + 11] = INSTANCE_COLOR[3];
            DATA[AT + 12] = weight0;
            DATA[AT + 13] = weight1;
            DATA[AT + 14] = whiteFlash ? 1 : 0;
            DATA[AT + 15] = depth + (SINGLE_PART ? PART[11] : 0);
        };
        for (let i = 0; i < count; i++) {
            const INSTANCE_COLOR = i < prefixCount ? prefixColor : color;
            const INSTANCE_FORCE_COLOR = i < forceColorPrefixCount ? true : forceColor;
            const RUNS = this._collectAlphaDepthRuns(
                mesh,
                INDICES,
                TRIANGLE_COUNT,
                depthWriteAlphaThreshold,
                alpha * INSTANCE_COLOR[3],
                INSTANCE_FORCE_COLOR,
                indexVariant,
            );
            const TOTAL_VERTICES = TRIANGLE_COUNT * 3;
            const ONE_RUN = RUNS.length === 3 && RUNS[0] === 0 && RUNS[1] === TOTAL_VERTICES;
            if (!ONE_RUN) {
                const BOUNDS =
                    this.safeAlphaRunBatching && this.instanced
                        ? this._screenBounds(mesh, matrices, i, projection, morph)
                        : null;
                if (BOUNDS) {
                    if (this.count) {
                        this.flush('alphaDepthBoundary');
                    }
                    if (
                        this.alphaQueueCount &&
                        !this._alphaQueueMatches(
                            mesh,
                            projection,
                            CLIP,
                            stencilRef,
                            depthTest,
                            depthFunc,
                            indexVariant,
                            RUNS,
                        )
                    ) {
                        this.metrics.alphaRunSignatureBoundaries++;
                        this._flushAlphaQueue('alphaSignature');
                    }
                    if (this.alphaQueueCount && this._boundsOverlap(BOUNDS, this.alphaQueueBounds)) {
                        this.metrics.alphaRunOverlapBoundaries++;
                        this._flushAlphaQueue('alphaOverlap');
                    }
                    if (this.alphaQueueCount === this.maxInstances) {
                        this._flushAlphaQueue('capacity');
                    }
                    if (!this.alphaQueueCount) {
                        this._startAlphaQueue(
                            mesh,
                            projection,
                            CLIP,
                            stencilRef,
                            depthTest,
                            depthFunc,
                            indexVariant,
                            RUNS,
                        );
                    }
                    this._extendAlphaQueueBounds(BOUNDS);
                    const SLOT = this.alphaQueueCount;
                    WRITE_ALPHA_INSTANCE(i, SLOT);
                    this.alphaQueueCount++;
                    continue;
                }
                if (this.safeAlphaRunBatching) {
                    this.metrics.alphaRunUnbatchableBounds++;
                }
                if (this.alphaQueueCount) {
                    this._flushAlphaQueue('alphaUnsupportedBoundary');
                }
                if (this.count) {
                    this.flush('alphaImmediateBoundary');
                }
                WRITE_ALPHA_INSTANCE(i, 0);
                this._drawAlphaDepthRuns(
                    mesh,
                    VARIANT,
                    projection,
                    CLIP,
                    PART.subarray(0, mesh.partCount * 12),
                    RUNS,
                    depthTest,
                    depthFunc,
                    strokeSize,
                    inverseStrokeProjection,
                    stencilRef,
                );
                this.metrics.alphaRunImmediateInstances++;
                this.metrics.alphaRunImmediateRunDraws += RUNS.length / 3;
                continue;
            }
            if (this.alphaQueueCount) {
                this._flushAlphaQueue('singleRunBoundary');
            }
            const WRITE = RUNS[2],
                STATE_KEY = Number(depthTest) + ':' + Number(WRITE) + ':' + depthFunc;
            if (this.pending) {
                const CURRENT = this.pending,
                    REASON =
                        CURRENT.mesh !== mesh
                            ? 'mesh'
                            : CURRENT.texture !== texture
                              ? 'texture'
                              : CURRENT.worldMode
                                ? 'transformMode'
                                : CURRENT.indexVariant !== indexVariant
                                  ? 'indexVariant'
                                  : CURRENT.firstIndex !== FIRST_INDEX || CURRENT.indexCount !== INDEX_COUNT
                                    ? 'indexRange'
                                    : CURRENT.clip.key !== CLIP.key
                                      ? 'clip'
                                      : CURRENT.stencilRef !== stencilRef
                                        ? 'stencil'
                                        : CURRENT.depthStateKey !== STATE_KEY
                                          ? 'depthState'
                                          : projection.some((n, j) => Math.fround(n) !== CURRENT.projection[j])
                                            ? 'projection'
                                            : strokeSize && strokeSize.some((n, j) => n !== CURRENT.strokeSize?.[j])
                                              ? 'strokeViewport'
                                              : mesh.partCount > 1 &&
                                                  CURRENT.parts.some((n, j) => n !== this.partScratch[j])
                                                ? 'parts'
                                                : this.count === this.maxInstances
                                                  ? 'capacity'
                                                  : null;
                if (REASON) {
                    this.flush(REASON);
                }
            }
            if (!this.pending) {
                this.pending = {
                    mesh,
                    texture,
                    projection: Float32Array.from(projection),
                    worldMode: false,
                    clip: CLIP,
                    stencilRef,
                    depthStateKey: STATE_KEY,
                    indexVariant,
                    firstIndex: FIRST_INDEX,
                    indexCount: INDEX_COUNT,
                    strokeSize,
                    inverseStrokeProjection,
                    inverseViewProjection,
                    depthState: {
                        test: depthTest,
                        write: WRITE,
                        func: depthFunc,
                    },
                    parts: this.partScratch.slice(0, mesh.partCount > 1 ? mesh.partCount * 12 : 0),
                };
            }
            const OFFSET = i * 6;
            let m0 = matrices[OFFSET];
            let m1 = matrices[OFFSET + 1];
            let m2 = matrices[OFFSET + 2];
            let m3 = matrices[OFFSET + 3];
            let m4 = matrices[OFFSET + 4];
            let m5 = matrices[OFFSET + 5];
            let weight0 = morph[0];
            let weight1 = morph[1];
            let instanceAlpha = alpha;
            if (SINGLE_PART) {
                const A_LOCAL = m0,
                    B_LOCAL = m1,
                    C_LOCAL = m2,
                    D_LOCAL = m3;
                m0 = A_LOCAL * PART[0] + C_LOCAL * PART[4];
                m1 = B_LOCAL * PART[0] + D_LOCAL * PART[4];
                m2 = A_LOCAL * PART[1] + C_LOCAL * PART[5];
                m3 = B_LOCAL * PART[1] + D_LOCAL * PART[5];
                m4 = A_LOCAL * PART[2] + C_LOCAL * PART[6] + m4;
                m5 = B_LOCAL * PART[2] + D_LOCAL * PART[6] + m5;
                instanceAlpha *= PART[10];
                weight0 += PART[8];
                weight1 += PART[9];
            }
            const AT = this.count++ * 16,
                DATA = this.instances;
            DATA[AT] = m0;
            DATA[AT + 1] = m2;
            DATA[AT + 2] = m4;
            DATA[AT + 3] = instanceAlpha;
            DATA[AT + 4] = m1;
            DATA[AT + 5] = m3;
            DATA[AT + 6] = m5;
            DATA[AT + 7] = INSTANCE_FORCE_COLOR ? 1 : 0;
            DATA[AT + 8] = INSTANCE_COLOR[0];
            DATA[AT + 9] = INSTANCE_COLOR[1];
            DATA[AT + 10] = INSTANCE_COLOR[2];
            DATA[AT + 11] = INSTANCE_COLOR[3];
            DATA[AT + 12] = weight0;
            DATA[AT + 13] = weight1;
            DATA[AT + 14] = whiteFlash ? 1 : 0;
            DATA[AT + 15] = depth + (SINGLE_PART ? PART[11] : 0);
        }
    }
    _collectAlphaDepthRuns(mesh, indices, triangleCount, threshold, opacity, forceColor, indexVariant) {
        let cache = this.alphaRunCache.get(mesh);
        if (!cache) {
            cache = new Map();
            this.alphaRunCache.set(mesh, cache);
        }
        const PART_OPACITIES = [];
        for (let i = 0; i < mesh.partCount; i++) {
            PART_OPACITIES.push(this.partScratch[i * 12 + 10]);
        }
        const KEY = JSON.stringify([indexVariant, threshold, opacity, forceColor, PART_OPACITIES]);
        const CACHED = cache.get(KEY);
        if (CACHED) {
            cache.delete(KEY);
            cache.set(KEY, CACHED);
            this.metrics.alphaRunCacheHits++;
            return CACHED;
        }
        this.metrics.alphaRunCacheMisses++;
        const RUNS = this.alphaRunScratch;
        RUNS.length = 0;
        if (opacity < threshold) {
            RUNS.push(0, triangleCount * 3, false);
        } else {
            let runStart = 0;
            let runWrite = null;
            for (let triangle = 0; triangle < triangleCount; triangle++) {
                let write = true;
                for (let corner = 0; corner < 3; corner++) {
                    const INDEX_OFFSET = triangle * 3 + corner,
                        VERTEX_OFFSET = (indices ? indices[INDEX_OFFSET] : INDEX_OFFSET) * mesh.strideFloats;
                    const PART_INDEX = mesh.vertices[VERTEX_OFFSET + 10];
                    const VERTEX_ALPHA = forceColor ? 1 : mesh.vertices[VERTEX_OFFSET + 5];
                    const EFFECTIVE_ALPHA = opacity * VERTEX_ALPHA * this.partScratch[PART_INDEX * 12 + 10];
                    if (EFFECTIVE_ALPHA <= 0 || EFFECTIVE_ALPHA < threshold) {
                        write = false;
                        break;
                    }
                }
                if (runWrite === null) {
                    runStart = triangle;
                    runWrite = write;
                } else if (write !== runWrite) {
                    RUNS.push(runStart * 3, (triangle - runStart) * 3, runWrite);
                    runStart = triangle;
                    runWrite = write;
                }
            }
            if (runWrite !== null) {
                RUNS.push(runStart * 3, (triangleCount - runStart) * 3, runWrite);
            }
        }
        if (RUNS.length <= 64) {
            const STABLE_RUNS = RUNS.slice();
            if (cache.size >= 16) {
                cache.delete(cache.keys().next().value);
            }
            cache.set(KEY, STABLE_RUNS);
            return STABLE_RUNS;
        }
        this.alphaRunScratch = [];
        return RUNS;
    }
    _drawAlphaDepthRuns(
        mesh,
        variant,
        projection,
        clip,
        parts,
        runs,
        depthTest,
        depthFunc,
        strokeSize,
        inverseStrokeProjection,
        stencilRef,
    ) {
        this.planes.fill(0);
        if (clip.values) {
            this.planes.set(clip.values);
        }
        const PIPELINE = this._pipeline(mesh, clip.count > 0),
            UNIFORMS = {
                u_projection: projection,
            };
        if (clip.count) {
            Object.assign(UNIFORMS, {
                'u_planes[0]': this.planes,
                u_planeCount: clip.count,
            });
        }
        if (mesh.hasNonScalingStroke) {
            Object.assign(UNIFORMS, {
                u_strokeViewportSize: strokeSize,
                ...(clip.count
                    ? {
                          u_inverseProjection: inverseStrokeProjection,
                      }
                    : {}),
            });
        }
        if (mesh.partCount > 1) {
            UNIFORMS['u_parts[0]'] = parts;
        }
        if (mesh.paintRegionNames) {
            UNIFORMS['u_paintRegions[0]'] = this.paintState;
        }
        if (!this.instanced) {
            for (let j = 0; j < 4; j++) {
                UNIFORMS[['i_row0', 'i_row1', 'i_color', 'i_params'][j]] = this.instances.subarray(j * 4, j * 4 + 4);
            }
        } else {
            const INSTANCE = this.instances.subarray(0, 16);
            this.device.uploadVertices(this.instanceBuffer, INSTANCE);
            this.metrics.instanceBytesUploaded += INSTANCE.byteLength;
        }
        const INDEX_BUFFER = variant?.indexBuffer ?? mesh.indexBuffer;
        for (let run = 0; run < runs.length; run += 3) {
            this.device.draw({
                pipeline: PIPELINE,
                buffer: mesh.buffer,
                indexBuffer: INDEX_BUFFER,
                first: runs[run],
                count: runs[run + 1],
                instanceBuffer: this.instanceBuffer,
                instances: 1,
                uniforms: UNIFORMS,
                depth: {
                    test: depthTest,
                    write: runs[run + 2],
                    func: depthFunc,
                },
                stencil:
                    stencilRef === null
                        ? false
                        : {
                              func: 'equal',
                              ref: stencilRef,
                              mask: 255,
                              writeMask: 0,
                              pass: 'keep',
                          },
            });
            this.metrics.draws++;
            this.metrics.drawDispatchReasons.alphaImmediateRun =
                (this.metrics.drawDispatchReasons.alphaImmediateRun ?? 0) + 1;
            if (mesh.partCount > 1) {
                this.metrics.partUniformBytesSubmitted += parts.byteLength;
            }
        }
        this.metrics.instances++;
    }
    flush(reason = 'explicit') {
        if (this.alphaQueueCount) {
            this._flushAlphaQueue(reason);
        }
        if (!this.count) {
            return;
        }
        this._ready();
        const {
            mesh: MESH,
            projection: PROJECTION,
            worldMode: WORLD_MODE,
            color: COLOR,
            clip: CLIP,
            parts: PARTS,
            depthState: DEPTH_STATE,
            indexVariant: INDEX_VARIANT,
            firstIndex: FIRST_INDEX,
            indexCount: INDEX_COUNT,
            strokeSize: STROKE_SIZE,
            inverseStrokeProjection: INVERSE_STROKE_PROJECTION,
            inverseViewProjection: INVERSE_VIEW_PROJECTION,
            stencilRef: STENCIL_REF,
            poseTexture: POSE_TEXTURE,
            texture: TEXTURE,
        } = this.pending;
        const VARIANT =
            INDEX_VARIANT === null
                ? null
                : (MESH.indexVariants.get(INDEX_VARIANT) ?? MESH.expressionIndices.get(INDEX_VARIANT));
        this.planes.fill(0);
        if (CLIP.values) {
            this.planes.set(CLIP.values);
        }
        if (POSE_TEXTURE) {
            this.poseRenderer.flushUpdates();
        }
        const PIPELINE = this._pipeline(MESH, CLIP.count > 0, WORLD_MODE, !!POSE_TEXTURE),
            UNIFORMS = WORLD_MODE
                ? {
                      u_viewProjection: PROJECTION,
                      u_color: COLOR,
                  }
                : {
                      u_projection: PROJECTION,
                  };
        if (CLIP.count) {
            Object.assign(UNIFORMS, {
                'u_planes[0]': this.planes,
                u_planeCount: CLIP.count,
            });
        }
        if (MESH.hasNonScalingStroke) {
            Object.assign(UNIFORMS, {
                u_strokeViewportSize: STROKE_SIZE,
                ...(CLIP.count
                    ? WORLD_MODE
                        ? {
                              u_inverseViewProjection: INVERSE_VIEW_PROJECTION,
                          }
                        : {
                              u_inverseProjection: INVERSE_STROKE_PROJECTION,
                          }
                    : {}),
            });
        }
        if (MESH.paintRegionNames) {
            UNIFORMS['u_paintRegions[0]'] = this.paintState;
        }
        if (POSE_TEXTURE) {
            UNIFORMS.u_poseTexture = 0;
        } else if (MESH.partCount > 1) {
            UNIFORMS['u_parts[0]'] = PARTS;
        }
        if (TEXTURE) {
            UNIFORMS.u_texture = POSE_TEXTURE ? 1 : 0;
        }
        const TEXTURES = POSE_TEXTURE ? (TEXTURE ? [POSE_TEXTURE, TEXTURE] : [POSE_TEXTURE]) : TEXTURE ? [TEXTURE] : [];
        const INSTANCE_UNIFORMS = WORLD_MODE
            ? ['i_row0', 'i_row1', 'i_row2', 'i_params']
            : ['i_row0', 'i_row1', 'i_color', 'i_params'];
        const INSTANCE_FLOATS = MESH.hasTextureCoordinates ? 24 : 16;
        const INSTANCE_DATA = MESH.hasTextureCoordinates ? this.texturedInstances : this.instances;
        if (this.instanced) {
            this.device.uploadVertices(this.instanceBuffer, INSTANCE_DATA.subarray(0, this.count * INSTANCE_FLOATS));
            this.device.draw({
                pipeline: PIPELINE,
                buffer: MESH.buffer,
                indexBuffer: VARIANT?.indexBuffer ?? MESH.indexBuffer,
                first: FIRST_INDEX,
                count: INDEX_COUNT,
                instanceBuffer: this.instanceBuffer,
                instances: this.count,
                uniforms: UNIFORMS,
                textures: TEXTURES,
                depth: DEPTH_STATE,
                stencil:
                    STENCIL_REF === null
                        ? false
                        : {
                              func: 'equal',
                              ref: STENCIL_REF,
                              mask: 255,
                              writeMask: 0,
                              pass: 'keep',
                          },
            });
            this.metrics.instanceBytesUploaded += this.count * INSTANCE_FLOATS * 4;
            this.metrics.draws++;
            this.metrics.drawDispatchReasons[reason] = (this.metrics.drawDispatchReasons[reason] ?? 0) + 1;
            if (MESH.partCount > 1 && !POSE_TEXTURE) {
                this.metrics.partUniformBytesSubmitted += PARTS.byteLength;
            }
        } else {
            for (let i = 0; i < this.count; i++) {
                for (let j = 0; j < 4; j++) {
                    UNIFORMS[INSTANCE_UNIFORMS[j]] = INSTANCE_DATA.subarray(
                        i * INSTANCE_FLOATS + j * 4,
                        i * INSTANCE_FLOATS + j * 4 + 4,
                    );
                }
                if (MESH.hasTextureCoordinates) {
                    UNIFORMS.i_uvRect = INSTANCE_DATA.subarray(i * 24 + 16, i * 24 + 20);
                    UNIFORMS.i_localRect = INSTANCE_DATA.subarray(i * 24 + 20, i * 24 + 24);
                }
                this.device.draw({
                    pipeline: PIPELINE,
                    buffer: MESH.buffer,
                    indexBuffer: VARIANT?.indexBuffer ?? MESH.indexBuffer,
                    first: FIRST_INDEX,
                    count: INDEX_COUNT,
                    uniforms: UNIFORMS,
                    textures: TEXTURES,
                    depth: DEPTH_STATE,
                    stencil:
                        STENCIL_REF === null
                            ? false
                            : {
                                  func: 'equal',
                                  ref: STENCIL_REF,
                                  mask: 255,
                                  writeMask: 0,
                                  pass: 'keep',
                              },
                });
                this.metrics.draws++;
                this.metrics.drawDispatchReasons[reason] = (this.metrics.drawDispatchReasons[reason] ?? 0) + 1;
                if (MESH.partCount > 1) {
                    this.metrics.partUniformBytesSubmitted += PARTS.byteLength;
                }
            }
        }
        this.metrics.instances += this.count;
        this.metrics.flushReasons[reason] = (this.metrics.flushReasons[reason] ?? 0) + 1;
        this.discard();
    }
    discard() {
        this.count = 0;
        this.pending = null;
        this.alphaQueueCount = 0;
        this.alphaQueueState = null;
    }
    _ready() {
        if (this.state !== 'ready' || this.disposed) {
            throw new Error(`MeshRenderer is ${this.state}${this.failure ? ': ' + this.failure : ''}`);
        }
    }
    beginFrame() {
        this.discard();
        this.poseRenderer?.beginFrame();
        for (const KEY of Object.keys(this.metrics)) {
            if (KEY !== 'flushReasons' && KEY !== 'drawDispatchReasons') {
                this.metrics[KEY] = 0;
            }
        }
        this.metrics.flushReasons = Object.create(null);
        this.metrics.drawDispatchReasons = Object.create(null);
    }
    stats() {
        return {
            ...this.metrics,
            flushReasons: {
                ...this.metrics.flushReasons,
            },
            drawDispatchReasons: {
                ...this.metrics.drawDispatchReasons,
            },
            pendingAlphaRunInstances: this.alphaQueueCount,
            safeAlphaRunBatching: this.safeAlphaRunBatching,
            state: this.state,
            failure: this.failure,
            pipelineCount: this.pipelines.size,
            meshCount: this.meshes.size,
            retainedBytes: this.bytes,
            stagingBytes:
                this.instances.byteLength +
                (this.texturedInstances?.byteLength ?? 0) +
                this.planes.byteLength +
                this.partScratch.byteLength,
            instanced: this.instanced,
            maxClipPlanes: this.maxPlanes,
            poses: this.poseStats(),
        };
    }
    dispose() {
        if (this.disposed) {
            return;
        }
        this.discard();
        this.texturedInstances = null;
        this.poseRenderer?.dispose();
        this.device.canvas.removeEventListener('webglcontextlost', this.onLost);
        this.device.canvas.removeEventListener('webglcontextrestored', this.onRestored);
        for (const MESH of this.meshes) {
            this.device.deleteVertexBuffer(MESH.buffer);
            if (MESH.indexBuffer) {
                this.device.deleteIndexBuffer(MESH.indexBuffer);
            }
            for (const VARIANT of MESH.expressionIndices.values()) {
                if (VARIANT.indexBuffer) {
                    this.device.deleteIndexBuffer(VARIANT.indexBuffer);
                }
            }
            for (const VARIANT of MESH.indexVariants.values()) {
                if (VARIANT.indexBuffer) {
                    this.device.deleteIndexBuffer(VARIANT.indexBuffer);
                }
            }
        }
        this.meshes.clear();
        this.bytes = 0;
        this.alphaRunCache = new WeakMap();
        this.alphaRunScratch.length = 0;
        if (this.instanceBuffer) {
            this.device.deleteVertexBuffer(this.instanceBuffer);
        }
        for (const PIPELINE of this.pipelines.values()) {
            this.device.deletePipeline(PIPELINE);
        }
        this.pipelines.clear();
        this.disposed = true;
        this.state = 'disposed';
    }
}

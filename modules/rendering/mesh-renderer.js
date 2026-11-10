import { VECTOR_VERTEX_FLOATS } from './vector-shader.js';
import { OrderedTriangleBatch } from './ordered-triangles.js';
import { clipPlanes } from './clip-planes.js';
import {
    DEPTH_FUNCTION_CODES,
    DEPTH_POLICIES,
    depthStateCode as DEPTH_STATE_CODE,
    sameFloat32,
    sameValues,
    stencilEqual,
} from './draw-state.js';
import { PoseRenderer } from './pose-renderer.js';
import { POSE_PROGRAM_FUNCTIONS } from './pose-shader.js';
import { MAX_PAINT_REGIONS, packPaintRegions, validatePaintRegionData } from './paint-regions.js';
import { MATERIAL_KIND, MATERIAL_RECORD_FLOATS, MAX_MATERIAL_SURFACES } from './yarn-material-record.js';
import { STITCH_FIELD_SIZE, materialFragment, stitchFieldPixels } from './yarn-material.js';
const IDENTITY = Object.freeze([1, 0, 0, 1, 0, 0]);
const ZERO_MORPH = Object.freeze([0, 0]);
const WHITE = Object.freeze([1, 1, 1, 1]);
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
// Instance record: 16 floats (two matrix rows, color, params).
const PLAIN_INSTANCE_FLOATS = 16;
// A mesh with materials adds a fifth instance vec4 whose x is that instance's display time, so actors with different
// times still share one draw.
const MATERIAL_INSTANCE_FLOATS = 20;
const MATERIAL_INSTANCE_ATTRIBUTE = { name: 'i_extra', size: 4, offset: 64, source: 'instance' };
// A material vertex is four floats: kind, surface index, distance along the contour, distance across it.
const MATERIAL_VERTEX_FLOATS = 4;
const NO_TEXTURES = Object.freeze([]);
const NO_CLIPS = Object.freeze([]);
const EMPTY_OPTIONS = Object.freeze({});
const PLAIN_INSTANCE_UNIFORMS = Object.freeze(['i_row0', 'i_row1', 'i_color', 'i_params']);
const WORLD_INSTANCE_UNIFORMS = Object.freeze(['i_row0', 'i_row1', 'i_row2', 'i_params']);
const PLAIN_MATERIAL_INSTANCE_UNIFORMS = Object.freeze([...PLAIN_INSTANCE_UNIFORMS, 'i_extra']);
const WORLD_MATERIAL_INSTANCE_UNIFORMS = Object.freeze([...WORLD_INSTANCE_UNIFORMS, 'i_extra']);
function unitChannels(rgba) {
    for (let i = 0; i < rgba.length; i++) {
        if (rgba[i] < 0 || rgba[i] > 1) {
            return false;
        }
    }
    return true;
}
function shader(
    instanced,
    partCount,
    morphCount,
    clipped,
    nonScalingStroke,
    worldMode = false,
    poseTexture = false,
    paintRegionCount = 0,
    materials = false,
) {
    const MATERIAL_INPUT = materials
            ? `attribute vec4 a_material; ${instanced ? 'attribute' : 'uniform'} vec4 i_extra;
varying vec2 v_local; varying vec4 v_material; varying highp float v_time;`
            : '',
        MATERIAL_OUTPUT = materials ? 'v_local=local;v_material=a_material;v_time=i_extra.x;' : '';
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
    const STROKE_POSITION = nonScalingStroke
        ? `
vec2 tangentLocal=local+a_stroke.xy;
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
vec2 tangentLocal=local+a_stroke.xy;
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
${WORLD_INPUTS}${WORLD_STROKE_INPUTS}${PAINT_INPUT}${MATERIAL_INPUT}
uniform mat4 u_viewProjection; uniform vec4 u_color; varying vec4 v_color; ${clipped ? 'varying vec2 v_position;' : ''}
void main(){${PART_SETUP}
vec2 local=${LOCAL};${MATERIAL_OUTPUT}vec2 plane=${PART_POSE ? 'vec2(dot(row0.xyz,vec3(local,1.0)),dot(row1.xyz,vec3(local,1.0)))' : 'local'};
vec3 world=vec3(dot(i_row0.xyz,vec3(plane,1.0)),dot(i_row1.xyz,vec3(plane,1.0)),dot(i_row2.xyz,vec3(plane,1.0)));
vec4 projected=u_viewProjection*vec4(world,1.0);${clipped ? 'v_position=world.xy;' : ''}${WORLD_STROKE}
projected.z+=(i_params.w+${PART_POSE ? 'pose.w' : '0.0'})*projected.w;gl_Position=projected;
${PAINT_COLOR}vec4 color=mix(${BASE_COLOR}*u_color,u_color,i_row1.w);color.a*=i_row0.w${PART_POSE ? '*pose.z' : ''};color.rgb=mix(color.rgb,vec3(1.0),i_row2.w);v_color=vec4(color.rgb*color.a,color.a);
}`;
    }
    return `attribute vec2 a_position; attribute vec4 a_color; ${morphCount ? 'attribute vec4 a_morph;' : ''} ${PART_INPUTS}
${INPUTS}${STROKE_INPUTS}${PAINT_INPUT}${MATERIAL_INPUT}
uniform mat3 u_projection; varying vec4 v_color; ${clipped ? 'varying vec2 v_position;' : ''}${STROKE_VARYING}
void main(){${PART_SETUP}
vec2 local=${LOCAL};${MATERIAL_OUTPUT}vec2 p=${PART_POSE ? 'vec2(dot(row0.xyz,vec3(local,1.0)),dot(row1.xyz,vec3(local,1.0)))' : 'local'};
vec2 world=vec2(dot(i_row0.xyz,vec3(p,1.0)),dot(i_row1.xyz,vec3(p,1.0)));
vec3 projected=u_projection*vec3(world,1.0);${clipped ? 'v_position=world;' : ''}${STROKE_POSITION}
gl_Position=vec4(projected.xy,(i_params.w+${PART_POSE ? 'pose.w' : '0.0'})*projected.z,projected.z);
${PAINT_COLOR}vec4 color=mix(${BASE_COLOR}*i_color,i_color,i_row1.w);color.a*=i_row0.w${PART_POSE ? '*pose.z' : ''};
color.rgb=mix(color.rgb,vec3(1.0),i_params.z);v_color=vec4(color.rgb*color.a,color.a);}`;
}
function fragment(maxPlanes, clipped) {
    if (!clipped) {
        return 'precision mediump float;varying vec4 v_color;void main(){gl_FragColor=v_color;}';
    }
    return `precision mediump float; varying vec4 v_color; varying vec2 v_position;
uniform vec3 u_planes[${maxPlanes}]; uniform int u_planeCount;
void main(){for(int i=0;i<${maxPlanes};i++){if(i>=u_planeCount)break;if(dot(u_planes[i],vec3(v_position,1.0))<0.0)discard;}gl_FragColor=v_color;}`;
}
// Hidden pose parts and transparent material texels must not occlude other objects. Keep the ordinary colour
// contract unchanged when depth writes are disabled, including copy/source-in blends and shader surfaces.
function depthFragment(source) {
    return `uniform float u_depthWrite;
${source.replace(/void main\(\)\s*\{/, 'void shade(){')}
void main(){shade();if(u_depthWrite>0.5&&gl_FragColor.a<=0.0)discard;}`;
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
function poseProgramShader(source) {
    return source
        .replace(/uniform vec4 u_parts\[\d+\];/, POSE_PROGRAM_FUNCTIONS)
        .replace(
            /int index=(int\(a_part\)\*3|0);vec4 row0=u_parts\[index\];vec4 row1=u_parts\[index\+1\];vec4 pose=u_parts\[index\+2\];/,
            (_match, expression) =>
                `int poseRow=int(-i_params.x-1.0);vec4 row0;vec4 row1;vec4 pose;poseEval(${expression === '0' ? '0' : expression.slice(0, -2)},poseRow,row0,row1,pose);`,
        )
        .replaceAll('(i_params.x+pose.x)', '(pose.x)')
        .replaceAll('(i_params.y+pose.y)', '(pose.y)');
}
// One startup/context-restore conversion, never a palette-specific geometry or per-frame upload. The optional
// per-vertex streams follow the 11 authored floats: the paint region id, then the four material floats.
function gpuVertexStream(vertices, regions, materials) {
    if (!regions && !materials) {
        return vertices;
    }
    const COUNT = vertices.length / 11,
        STRIDE = 11 + (regions ? 1 : 0) + (materials ? MATERIAL_VERTEX_FLOATS : 0);
    const PACKED = new Float32Array(COUNT * STRIDE);
    for (let index = 0; index < COUNT; index++) {
        const AT = index * STRIDE;
        PACKED.set(vertices.subarray(index * 11, index * 11 + 11), AT);
        let next = AT + 11;
        if (regions) {
            PACKED[next++] = regions[index];
        }
        if (materials) {
            PACKED.set(materials.subarray(index * MATERIAL_VERTEX_FLOATS, (index + 1) * MATERIAL_VERTEX_FLOATS), next);
        }
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
            orderedMeshQuads = false,
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
        if (typeof orderedMeshQuads !== 'boolean') {
            throw new TypeError('orderedMeshQuads must be a boolean');
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
        this.ordered = orderedMeshQuads
            ? new OrderedTriangleBatch(device, { maxInstances, maxMeshBytes, maxPlanes: this.maxPlanes })
            : null;
        this.instances = new Float32Array(maxInstances * 16);
        this.instanceBuffer = this.instanced
            ? device.createVertexBuffer({
                  capacityBytes: this.instances.byteLength,
              })
            : null;
        this.pipelines = new Map();
        this.pipelineUniforms = new Map();
        // Meshes with materials: a wider instance staging array, the shared stitch distance field and the cached
        // fill/edge runs used to keep an edge's depth write off in 3D.
        this.materialInstances = null;
        this.materialRunCache = new WeakMap();
        this.stitchField = null;
        this.materialTextureSets = new WeakMap();
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
        this.unregisterBatcher = device.registerBatcher((reason) => this.flush(reason));
        this.disposed = false;
    }
    _poses() {
        if (!this.poseRenderer) {
            this.poseRenderer = new PoseRenderer(this.device, {
                backend: this.poseBackend,
                cacheMatrices: this.ordered !== null,
                onBoundary: () => this.device.flushBatchers('poseResourceBoundary'),
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
    _pipeline(mesh, clipped, worldMode = false, poseMode = 0) {
        // Mixed-radix shader key: parts 1..16 (x17), morphs 0..2 (x3), clip, non-scaling stroke and world bits (x2 each),
        // pose mode 0..2 (x3) and paint regions 0..8 (x9) stay below 2^16; the material surface count multiplies 2^16
        // and is a small mesh-validated integer, so the key is a safe integer.
        const KEY =
            (((((mesh.partCount * 3 + mesh.morphCount) * 2 + (clipped ? 1 : 0)) * 2 +
                (mesh.hasNonScalingStroke ? 1 : 0)) *
                2 +
                (worldMode ? 1 : 0)) *
                3 +
                poseMode) *
                9 +
            (mesh.paintRegionNames?.length ?? 0) +
            (mesh.materials?.count ?? 0) * 65536;
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
        UNIFORMS.u_depthWrite = '1f';
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
        if (poseMode === 1) {
            UNIFORMS.u_poseTexture = '1i';
        } else if (poseMode === 2) {
            Object.assign(UNIFORMS, { u_program: '1i', u_state: '1i', u_overrides: '1i', u_programWidth: '1i' });
        } else if (mesh.partCount > 1) {
            UNIFORMS['u_parts[0]'] = '4fv';
        }
        if (mesh.paintRegionNames) {
            UNIFORMS['u_paintRegions[0]'] = '4fv';
        }
        if (mesh.materials) {
            UNIFORMS['u_materials[0]'] = '4fv';
            UNIFORMS.u_stitchField = '1i';
        }
        if (!this.instanced) {
            for (const NAME of worldMode
                ? ['i_row0', 'i_row1', 'i_row2', 'i_params']
                : ['i_row0', 'i_row1', 'i_color', 'i_params']) {
                UNIFORMS[NAME] = '4f';
            }
            if (mesh.materials) {
                UNIFORMS.i_extra = '4f';
            }
        }
        pipeline = this.device.createPipeline({
            vertex: [(source) => source, poseTextureShader, poseProgramShader][poseMode](
                shader(
                    this.instanced,
                    poseMode ? Math.max(2, mesh.partCount) : mesh.partCount,
                    mesh.morphCount,
                    clipped,
                    mesh.hasNonScalingStroke,
                    worldMode,
                    poseMode,
                    mesh.paintRegionNames?.length ?? 0,
                    Boolean(mesh.materials),
                ),
            ),
            fragment: depthFragment(
                mesh.materials
                    ? materialFragment(this.maxPlanes, clipped, mesh.materials.count)
                    : fragment(this.maxPlanes, clipped),
            ),
            stride: mesh.bufferStrideFloats * 4,
            ...(this.instanced ? { instanceStride: mesh.instanceFloats * 4 } : {}),
            attributes: [
                ...(mesh.paintRegionNames ? [{ name: 'a_paintRegion', size: 1, offset: 44 }] : []),
                ...(mesh.materials
                    ? [{ name: 'a_material', size: 4, offset: 44 + (mesh.paintRegionNames ? 4 : 0) }]
                    : []),
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
                ...(this.instanced ? (worldMode ? WORLD_INSTANCE_ATTRIBUTES : INSTANCE_ATTRIBUTES) : []),
                ...(this.instanced && mesh.materials ? [MATERIAL_INSTANCE_ATTRIBUTE] : []),
            ],
            uniforms: UNIFORMS,
        });
        this.pipelines.set(KEY, pipeline);
        return pipeline;
    }
    createMesh(data) {
        this._ready();
        const INDICES = data?.indices;
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
        if (data.paintRegions) {
            for (const [, VARIANT] of [...EXPRESSION_ENTRIES, ...INDEX_VARIANT_ENTRIES]) {
                validatePaintRegionData(data.paintRegions, data.vertices.length / 11, VARIANT);
            }
        }
        const MATERIALS = data.materials;
        let ownedMaterials = null;
        if (MATERIALS !== undefined) {
            const SURFACES = MATERIALS?.table?.length / MATERIAL_RECORD_FLOATS;
            if (
                !(MATERIALS?.vertices instanceof Float32Array) ||
                !(MATERIALS.table instanceof Float32Array) ||
                MATERIALS.vertices.length !== (data.vertices.length / 11) * MATERIAL_VERTEX_FLOATS ||
                !Number.isSafeInteger(SURFACES) ||
                SURFACES < 1 ||
                SURFACES > MAX_MATERIAL_SURFACES ||
                MATERIALS.table.some((n) => !Number.isFinite(n))
            ) {
                throw new TypeError('Mesh materials need a per-vertex stream and a table of 1..16 surfaces');
            }
            for (let at = 0; at < MATERIALS.vertices.length; at += MATERIAL_VERTEX_FLOATS) {
                const KIND = MATERIALS.vertices[at],
                    SURFACE = MATERIALS.vertices[at + 1];
                if (
                    !Number.isInteger(KIND) ||
                    KIND < MATERIAL_KIND.none ||
                    KIND > MATERIAL_KIND.sketchEdge ||
                    !Number.isInteger(SURFACE) ||
                    SURFACE < 0 ||
                    SURFACE >= SURFACES ||
                    !Number.isFinite(MATERIALS.vertices[at + 2]) ||
                    !Number.isFinite(MATERIALS.vertices[at + 3])
                ) {
                    throw new RangeError('Mesh material kind or surface index is invalid');
                }
            }
            ownedMaterials = Object.freeze({
                vertices: MATERIALS.vertices.slice(),
                table: MATERIALS.table.slice(),
                count: SURFACES,
            });
        }
        const PAINT_INDICES = data.paintRegions?.indices,
            BUFFER_STRIDE = 11 + (PAINT_INDICES ? 1 : 0) + (ownedMaterials ? MATERIAL_VERTEX_FLOATS : 0);
        const GPU_VERTEX_BYTES = (data.vertices.length / 11) * BUFFER_STRIDE * 4;
        const UPLOAD_BYTE_LENGTH = GPU_VERTEX_BYTES + (INDICES?.byteLength ?? 0) + VARIANT_BYTE_LENGTH;
        const BYTE_LENGTH =
            UPLOAD_BYTE_LENGTH +
            (PAINT_INDICES || ownedMaterials ? data.vertices.byteLength : 0) +
            (ownedMaterials ? ownedMaterials.vertices.byteLength + ownedMaterials.table.byteLength : 0);
        if (this.meshes.size >= this.maxMeshes || this.bytes + BYTE_LENGTH > this.maxMeshBytes) {
            throw new RangeError('Retained mesh budget exceeded');
        }
        const VERTICES = data.vertices.slice(),
            GPU_VERTICES = gpuVertexStream(VERTICES, PAINT_INDICES, ownedMaterials?.vertices),
            OWNED_INDICES = INDICES?.slice(),
            BUFFER = this.device.createVertexBuffer({
                capacityBytes: GPU_VERTICES.byteLength,
            });
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
            materials: ownedMaterials,
            instanceFloats: ownedMaterials ? MATERIAL_INSTANCE_FLOATS : PLAIN_INSTANCE_FLOATS,
            hasNonScalingStroke: NON_SCALING_STROKE,
            partBounds: meshPartBounds(VERTICES, data.partCount, data.morphCount),
        });
        this.meshes.add(MESH);
        this.bytes += BYTE_LENGTH;
        try {
            if (this.ordered && !MESH.hasNonScalingStroke && !MESH.materials) {
                this.ordered.retain(MESH);
            }
        } catch (error) {
            this.deleteMesh(MESH);
            throw error;
        }
        if (ownedMaterials) {
            this._materialTextures(null);
        }
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
        this.ordered?.release(mesh);
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
    drawMesh(mesh, options = EMPTY_OPTIONS) {
        // The options object is read in place (no per-draw copy); instance prefixes belong to drawMeshInstances only.
        this._drawInstances(mesh, options, options.matrix ?? IDENTITY, 1, false);
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
            STATE.runs.length !== runs.length ||
            !sameValues(runs, STATE.runs) ||
            !sameFloat32(projection, STATE.projection)
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
        // One reused queue state record; its run list and projection are copies, compared by value.
        const STATE = (this.alphaQueueRecord ??= { projection: new Float32Array(9), runs: [] });
        STATE.mesh = mesh;
        if (STATE.projection.length !== projection.length) {
            STATE.projection = new Float32Array(projection.length);
        }
        STATE.projection.set(projection);
        STATE.clip = clip;
        STATE.stencilRef = stencilRef;
        STATE.depthTest = depthTest;
        STATE.depthFunc = depthFunc;
        STATE.indexVariant = indexVariant;
        STATE.runs.length = 0;
        for (let i = 0; i < runs.length; i++) {
            STATE.runs.push(runs[i]);
        }
        this.alphaQueueState = STATE;
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
            UNIFORMS.u_depthWrite = Number(STATE.runs[run + 2]);
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
                stencil: STATE.stencilRef === null ? false : stencilEqual(STATE.stencilRef),
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
    /**
     * Ordered instance append used when one retained pose has several transforms (silhouettes). `matrices` holds
     * six floats per instance and the first `prefixCount` instances use `prefixColor`. A mesh with materials that
     * writes depth is drawn in runs so a yarn or sketch edge, whose pixels are only partly covered, never writes depth;
     * the runs keep the triangle order, so painter order is unchanged.
     */
    drawMeshInstances(mesh, options = EMPTY_OPTIONS) {
        this._drawInstances(mesh, options, options.matrices, options.count, true);
    }
    _drawInstances(mesh, options, matrices, count, prefixes) {
        if (
            mesh?.materials &&
            options.depthWrite === true &&
            (options.depthWriteAlphaThreshold ?? null) === null &&
            (options.indexRange ?? null) === null &&
            this.meshes.has(mesh)
        ) {
            const RUNS = this._materialRuns(mesh, options.indexVariant ?? null);
            if (RUNS.length > 1) {
                for (const RUN of RUNS) {
                    this._drawMeshRange(mesh, options, matrices, count, prefixes, RUN.first, RUN.count, !RUN.edge);
                }
                return;
            }
        }
        this._drawMeshRange(mesh, options, matrices, count, prefixes, -1, 0, null);
    }
    /**
     * Writes one alpha-depth instance into queue slot `slot`. A method rather than a closure inside _drawMeshRange: the
     * closure captured the draw's parameters, which gave every draw call (alpha-depth or not) a heap context.
     */
    _writeAlphaInstance(slot, matrices, i, morph, alpha, color, forceColor, whiteFlash, depth, singlePart) {
        const PART = this.partScratch;
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
        if (singlePart) {
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
        const AT = slot * 16,
            DATA = this.instances;
        DATA[AT] = m0;
        DATA[AT + 1] = m2;
        DATA[AT + 2] = m4;
        DATA[AT + 3] = instanceAlpha;
        DATA[AT + 4] = m1;
        DATA[AT + 5] = m3;
        DATA[AT + 6] = m5;
        DATA[AT + 7] = forceColor ? 1 : 0;
        DATA[AT + 8] = color[0];
        DATA[AT + 9] = color[1];
        DATA[AT + 10] = color[2];
        DATA[AT + 11] = color[3];
        DATA[AT + 12] = weight0;
        DATA[AT + 13] = weight1;
        DATA[AT + 14] = whiteFlash ? 1 : 0;
        DATA[AT + 15] = depth + (singlePart ? PART[11] : 0);
    }
    /** Contiguous runs of fill and edge triangles of one index list, cached per mesh. */
    _materialRuns(mesh, indexVariant) {
        let cache = this.materialRunCache.get(mesh);
        if (!cache) {
            cache = new Map();
            this.materialRunCache.set(mesh, cache);
        }
        const KEY = indexVariant;
        let runs = cache.get(KEY);
        if (!runs) {
            const VARIANT =
                indexVariant === null
                    ? null
                    : (mesh.indexVariants.get(indexVariant) ?? mesh.expressionIndices.get(indexVariant));
            const INDICES = VARIANT ? VARIANT.indices : mesh.indices,
                COUNT = VARIANT ? VARIANT.count : mesh.count;
            runs = [];
            for (let at = 0; at < COUNT; at += 3) {
                const VERTEX = INDICES ? INDICES[at] : at,
                    KIND = mesh.materials.vertices[VERTEX * MATERIAL_VERTEX_FLOATS],
                    EDGE = KIND === MATERIAL_KIND.yarnEdge || KIND === MATERIAL_KIND.sketchEdge,
                    LAST = runs.at(-1);
                if (LAST && LAST.edge === EDGE) {
                    LAST.count += 3;
                } else {
                    runs.push({ first: at, count: 3, edge: EDGE });
                }
            }
            cache.set(KEY, runs);
        }
        return runs;
    }
    /**
     * The caller's draw options are destructured in place (no copy). `rangeFirst >= 0` replaces `indexRange` and a
     * boolean `depthWriteOverride` replaces `depthWrite` (material fill/edge runs); `prefixes` admits the instance
     * color prefix. The trailing parameters are the resolved values and are never passed by callers.
     */
    _drawMeshRange(
        mesh,
        {
            projection,
            viewProjection,
            worldMatrix,
            morph = ZERO_MORPH,
            parts = null,
            pose = null,
            color = WHITE,
            paintRegions = null,
            forceColor = false,
            alpha = 1,
            whiteFlash = false,
            clips = NO_CLIPS,
            prefixColor: requestedPrefixColor = null,
            prefixCount: requestedPrefixCount = 0,
            forceColorPrefixCount: requestedForceColorPrefixCount = 0,
            depth = 0,
            depthTest = false,
            depthWrite: requestedDepthWrite = false,
            depthWriteAlphaThreshold = null,
            depthFunc = 'lequal',
            indexVariant = null,
            indexRange: requestedIndexRange = null,
            strokeViewport = null,
            stencilRef = null,
            timeMs = 0,
        },
        matrices,
        count,
        prefixes,
        rangeFirst,
        rangeCount,
        depthWriteOverride,
        prefixColor = prefixes ? requestedPrefixColor : null,
        prefixCount = prefixes ? requestedPrefixCount : 0,
        forceColorPrefixCount = prefixes ? requestedForceColorPrefixCount : 0,
        depthWrite = depthWriteOverride ?? requestedDepthWrite,
        indexRange = rangeFirst >= 0 ? null : requestedIndexRange,
    ) {
        this._ready();
        if (!this.meshes.has(mesh)) {
            throw new TypeError('Mesh owned by this renderer required');
        }
        if (!Number.isFinite(timeMs)) {
            throw new TypeError('timeMs must be finite');
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
            if (!(
                Number.isFinite(strokeSize[0]) &&
                strokeSize[0] > 0 &&
                Number.isFinite(strokeSize[1]) &&
                strokeSize[1] > 0
            )) {
                throw new RangeError('Non-scaling strokes require a positive CSS-pixel viewport size');
            }
            if (!WORLD_MODE) {
                inverseStrokeProjection = invertProjection(projection);
            } else if (clipPlanes(clips, this.maxPlanes).count) {
                inverseViewProjection = invertMatrix4(viewProjection);
            }
        }
        if (!Number.isFinite(alpha) || alpha < 0 || alpha > 1 || !unitChannels(color)) {
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
        if (mesh.materials && depthWriteAlphaThreshold !== null) {
            throw new TypeError('Meshes with materials do not support depthWriteAlphaThreshold');
        }
        if (!DEPTH_FUNCTION_CODES.has(depthFunc)) {
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
            if (!unitChannels(prefixColor)) {
                throw new RangeError('RGBA channels must be in [0,1]');
            }
        }
        if (WORLD_MODE && (prefixCount || forceColorPrefixCount)) {
            throw new TypeError('Per-instance color prefixes are not supported for 3D mesh draws');
        }
        if (
            indexRange !== null &&
            (!Array.isArray(indexRange) ||
                indexRange.length !== 2 ||
                !Number.isSafeInteger(indexRange[0]) ||
                !Number.isSafeInteger(indexRange[1]) ||
                indexRange[0] < 0 ||
                indexRange[1] < 0 ||
                indexRange[0] % 3 ||
                indexRange[1] % 3)
        ) {
            throw new TypeError('indexRange must be [firstIndex, triangleAlignedCount]');
        }
        if (indexRange !== null && depthWriteAlphaThreshold !== null) {
            throw new TypeError('indexRange is currently supported only for ordinary ordered mesh draws');
        }
        const CLIP = clipPlanes(clips, this.maxPlanes);
        const VARIANT =
            indexVariant === null
                ? null
                : (mesh.indexVariants.get(indexVariant) ?? mesh.expressionIndices.get(indexVariant));
        const FIRST_INDEX = rangeFirst >= 0 ? rangeFirst : (indexRange?.[0] ?? 0),
            INDEX_COUNT = rangeFirst >= 0 ? rangeCount : (indexRange?.[1] ?? VARIANT?.count ?? mesh.count);
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
        packParts(parts, mesh.partCount, this.partScratch);
        for (let i = 0; i < mesh.partCount; i++) {
            if (depth + this.partScratch[i * 12 + 11] < -1 || depth + this.partScratch[i * 12 + 11] > 1) {
                throw new RangeError('combined mesh and part depth must be in [-1,1]');
            }
        }
        if (
            this.ordered &&
            !WORLD_MODE &&
            !mesh.hasNonScalingStroke &&
            !mesh.materials &&
            depthWriteAlphaThreshold === null &&
            !depthWrite &&
            !prefixCount &&
            !forceColorPrefixCount &&
            (POSE_DRAW?.kind === 'program' || POSE_DRAW?.gpu === true || (!POSE_DRAW && mesh.partCount === 1))
        ) {
            this._flushNative('orderedBoundary');
            // One reusable record carries the draw to the ordered batch, which reads it before returning.
            const ORDERED = (this.orderedDraw ??= {});
            ORDERED.matrices = matrices;
            ORDERED.count = count;
            ORDERED.projection = projection;
            ORDERED.morph = morph;
            ORDERED.color = color;
            ORDERED.paintRegions = paintRegions;
            ORDERED.forceColor = forceColor;
            ORDERED.alpha = alpha;
            ORDERED.whiteFlash = whiteFlash;
            ORDERED.clip = CLIP;
            ORDERED.depth = depth;
            ORDERED.depthTest = depthTest;
            ORDERED.depthWrite = depthWrite;
            ORDERED.depthFunc = depthFunc;
            ORDERED.stencilRef = stencilRef;
            ORDERED.indexVariant = indexVariant;
            ORDERED.firstIndex = FIRST_INDEX;
            ORDERED.indexCount = INDEX_COUNT;
            ORDERED.pose = pose;
            ORDERED.part = this.partScratch;
            this.ordered.drawMesh(mesh, ORDERED, POSE_DRAW ? this.poseRenderer : null, POSE_DRAW);
            ORDERED.matrices = ORDERED.projection = ORDERED.morph = ORDERED.color = null;
            ORDERED.paintRegions = ORDERED.pose = ORDERED.clip = null;
            return;
        }
        this.ordered?.flush('nativeMeshBoundary');
        if (mesh.paintRegionNames || paintRegions !== null || this.paintState) {
            this._setPaintRegions(mesh, paintRegions);
        }
        const PENDING = this.pending;
        const DEPTH_STATE_KEY = DEPTH_STATE_CODE(depthTest, depthWrite, depthFunc);
        const ALPHA_DEPTH_WRITE = depthWrite && depthWriteAlphaThreshold !== null;
        if (!ALPHA_DEPTH_WRITE) {
            const INSTANCE_LIMIT = this.maxInstances;
            const INSTANCE_FLOATS = mesh.instanceFloats;
            const DATA = this._instanceData(mesh);
            if (this.alphaQueueCount) {
                this._flushAlphaQueue('alphaBoundary');
            }
            if (PENDING) {
                const MATRIX = WORLD_MODE ? viewProjection : projection;
                const PREVIOUS_COLOR = PENDING.color;
                const REASON =
                    (PENDING.poseTexture ?? null) !== (POSE_DRAW?.texture ?? null)
                        ? 'poseBackend'
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
                                      : !sameFloat32(MATRIX, PENDING.projection)
                                        ? 'projection'
                                        : strokeSize &&
                                            (strokeSize[0] !== PENDING.strokeSize?.[0] ||
                                                strokeSize[1] !== PENDING.strokeSize?.[1])
                                          ? 'strokeViewport'
                                          : WORLD_MODE && !sameValues(color, PREVIOUS_COLOR)
                                            ? 'color'
                                            : !POSE_DRAW &&
                                                mesh.partCount > 1 &&
                                                !sameValues(PENDING.parts, this.partScratch)
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
                    const NEXT = this._openPending(
                        mesh,
                        WORLD_MODE ? viewProjection : projection,
                        WORLD_MODE,
                        CLIP,
                        stencilRef,
                        DEPTH_STATE_KEY,
                        indexVariant,
                        FIRST_INDEX,
                        INDEX_COUNT,
                        strokeSize,
                        inverseStrokeProjection,
                        inverseViewProjection,
                        mesh.partCount > 1 ? mesh.partCount * 12 : 0,
                    );
                    NEXT.poseTexture = POSE_DRAW?.texture ?? null;
                    NEXT.poseTextures = POSE_DRAW?.textures ?? null;
                    NEXT.poseKind = POSE_DRAW?.kind ?? null;
                    NEXT.poseProgramWidth = POSE_DRAW?.programWidth ?? 0;
                    NEXT.color = NEXT.colorStorage;
                    NEXT.color.set(color);
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
                if (mesh.materials) {
                    DATA[AT + 16] = timeMs;
                    DATA[AT + 17] = 0;
                    DATA[AT + 18] = 0;
                    DATA[AT + 19] = 0;
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
                    this._writeAlphaInstance(
                        SLOT,
                        matrices,
                        i,
                        morph,
                        alpha,
                        INSTANCE_COLOR,
                        INSTANCE_FORCE_COLOR,
                        whiteFlash,
                        depth,
                        SINGLE_PART,
                    );
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
                this._writeAlphaInstance(
                    0,
                    matrices,
                    i,
                    morph,
                    alpha,
                    INSTANCE_COLOR,
                    INSTANCE_FORCE_COLOR,
                    whiteFlash,
                    depth,
                    SINGLE_PART,
                );
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
                STATE_KEY = DEPTH_STATE_CODE(depthTest, WRITE, depthFunc);
            if (this.pending) {
                const CURRENT = this.pending,
                    REASON =
                        CURRENT.mesh !== mesh
                            ? 'mesh'
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
                                        : !sameFloat32(projection, CURRENT.projection)
                                          ? 'projection'
                                          : strokeSize &&
                                              (strokeSize[0] !== CURRENT.strokeSize?.[0] ||
                                                  strokeSize[1] !== CURRENT.strokeSize?.[1])
                                            ? 'strokeViewport'
                                            : mesh.partCount > 1 && !sameValues(CURRENT.parts, this.partScratch)
                                              ? 'parts'
                                              : this.count === this.maxInstances
                                                ? 'capacity'
                                                : null;
                if (REASON) {
                    this.flush(REASON);
                }
            }
            if (!this.pending) {
                this._openPending(
                    mesh,
                    projection,
                    false,
                    CLIP,
                    stencilRef,
                    STATE_KEY,
                    indexVariant,
                    FIRST_INDEX,
                    INDEX_COUNT,
                    strokeSize,
                    inverseStrokeProjection,
                    inverseViewProjection,
                    mesh.partCount > 1 ? mesh.partCount * 12 : 0,
                );
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
            UNIFORMS.u_depthWrite = Number(runs[run + 2]);
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
                stencil: stencilRef === null ? false : stencilEqual(stencilRef),
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
    /** Paint state is stored by value; only the separate native mesh pipeline must submit before it. */
    paintBoundary(reason) {
        if (this.ordered) {
            this._flushNative(reason);
        } else {
            this.flush(reason);
        }
    }
    drawOrderedTriangles(vertices, count, state) {
        if (!this.ordered?.indexCount || this.device.maxTextures < 7) {
            return false;
        }
        // Public vector paint has one style per triangle. Future per-vertex styles keep their native interpolation.
        for (let at = 0; at < count * VECTOR_VERTEX_FLOATS; at += VECTOR_VERTEX_FLOATS * 3) {
            for (let field = 4; field < VECTOR_VERTEX_FLOATS; field++) {
                if (
                    vertices[at + field] !== vertices[at + VECTOR_VERTEX_FLOATS + field] ||
                    vertices[at + field] !== vertices[at + VECTOR_VERTEX_FLOATS * 2 + field]
                ) {
                    return false;
                }
            }
        }
        this._flushNative('vectorBoundary');
        this.ordered.drawVectorTriangles(vertices, count, state);
        return true;
    }
    /** Appends validated, unclipped ordinary atlas quads after earlier native meshes. */
    drawOrderedQuads(options, state, matrix) {
        this._flushNative('quadBoundary');
        this.ordered.drawQuads(options, state, matrix);
    }
    flush(reason = 'explicit') {
        this.ordered?.flush(reason);
        this._flushNative(reason);
    }
    _flushNative(reason) {
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
            poseTextures: POSE_TEXTURES,
            poseKind: POSE_KIND,
            poseProgramWidth: POSE_PROGRAM_WIDTH,
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
        const PIPELINE = this._pipeline(
            MESH,
            CLIP.count > 0,
            WORLD_MODE,
            POSE_KIND === 'program' ? 2 : POSE_KIND === 'matrix' ? 1 : 0,
        );
        // A pipeline's uniform names follow from its key, so each pipeline keeps one uniform object whose values are
        // overwritten here instead of building a new object per flush.
        let uniforms = this.pipelineUniforms.get(PIPELINE);
        if (!uniforms) {
            uniforms = {};
            this.pipelineUniforms.set(PIPELINE, uniforms);
        }
        const UNIFORMS = uniforms;
        if (WORLD_MODE) {
            UNIFORMS.u_viewProjection = PROJECTION;
            UNIFORMS.u_color = COLOR;
        } else {
            UNIFORMS.u_projection = PROJECTION;
        }
        if (CLIP.count) {
            UNIFORMS['u_planes[0]'] = this.planes;
            UNIFORMS.u_planeCount = CLIP.count;
        }
        if (MESH.hasNonScalingStroke) {
            UNIFORMS.u_strokeViewportSize = STROKE_SIZE;
            if (CLIP.count) {
                if (WORLD_MODE) {
                    UNIFORMS.u_inverseViewProjection = INVERSE_VIEW_PROJECTION;
                } else {
                    UNIFORMS.u_inverseProjection = INVERSE_STROKE_PROJECTION;
                }
            }
        }
        if (MESH.paintRegionNames) {
            UNIFORMS['u_paintRegions[0]'] = this.paintState;
        }
        if (POSE_KIND === 'program') {
            UNIFORMS.u_program = 0;
            UNIFORMS.u_state = 1;
            UNIFORMS.u_overrides = 2;
            UNIFORMS.u_programWidth = POSE_PROGRAM_WIDTH;
        } else if (POSE_KIND === 'matrix') {
            UNIFORMS.u_poseTexture = 0;
        } else if (MESH.partCount > 1) {
            UNIFORMS['u_parts[0]'] = PARTS;
        }
        UNIFORMS.u_depthWrite = Number(DEPTH_STATE.write);
        const TEXTURES = MESH.materials ? this._materialTextures(POSE_TEXTURES) : (POSE_TEXTURES ?? NO_TEXTURES);
        if (MESH.materials) {
            UNIFORMS['u_materials[0]'] = MESH.materials.table;
            UNIFORMS.u_stitchField = TEXTURES.length - 1;
        }
        const INSTANCE_UNIFORMS = WORLD_MODE
            ? MESH.materials
                ? WORLD_MATERIAL_INSTANCE_UNIFORMS
                : WORLD_INSTANCE_UNIFORMS
            : MESH.materials
              ? PLAIN_MATERIAL_INSTANCE_UNIFORMS
              : PLAIN_INSTANCE_UNIFORMS;
        const INSTANCE_FLOATS = MESH.instanceFloats;
        const INSTANCE_DATA = this._instanceData(MESH);
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
                stencil: STENCIL_REF === null ? false : stencilEqual(STENCIL_REF),
            });
            this.metrics.instanceBytesUploaded += this.count * INSTANCE_FLOATS * 4;
            this.metrics.draws++;
            this.metrics.drawDispatchReasons[reason] = (this.metrics.drawDispatchReasons[reason] ?? 0) + 1;
            if (MESH.partCount > 1 && !POSE_TEXTURE) {
                this.metrics.partUniformBytesSubmitted += PARTS.byteLength;
            }
        } else {
            for (let i = 0; i < this.count; i++) {
                for (let j = 0; j < INSTANCE_UNIFORMS.length; j++) {
                    UNIFORMS[INSTANCE_UNIFORMS[j]] = INSTANCE_DATA.subarray(
                        i * INSTANCE_FLOATS + j * 4,
                        i * INSTANCE_FLOATS + j * 4 + 4,
                    );
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
                    stencil: STENCIL_REF === null ? false : stencilEqual(STENCIL_REF),
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
    /**
     * Starts the native batch in the one reusable pending record: its typed copies are overwritten, the part copy is a
     * cached view of the needed length, and the depth policy is the shared object of the depth state code.
     */
    _openPending(
        mesh,
        projection,
        worldMode,
        clip,
        stencilRef,
        depthStateKey,
        indexVariant,
        firstIndex,
        indexCount,
        strokeSize,
        inverseStrokeProjection,
        inverseViewProjection,
        partFloats,
    ) {
        const NEXT = (this.pendingRecord ??= {
            mesh: null,
            poseTexture: null,
            poseTextures: null,
            poseKind: null,
            poseProgramWidth: 0,
            projection: null,
            projection3: new Float32Array(9),
            projection4: new Float32Array(16),
            worldMode: false,
            color: null,
            colorStorage: new Float32Array(4),
            clip: null,
            stencilRef: null,
            depthStateKey: 0,
            indexVariant: null,
            firstIndex: 0,
            indexCount: 0,
            strokeSize: null,
            inverseStrokeProjection: null,
            inverseViewProjection: null,
            depthState: null,
            parts: null,
            partStorage: new Float32Array(16 * 12),
            partViews: [],
        });
        NEXT.mesh = mesh;
        NEXT.poseTexture = null;
        NEXT.poseTextures = null;
        NEXT.poseKind = null;
        NEXT.poseProgramWidth = 0;
        NEXT.projection = projection.length === 16 ? NEXT.projection4 : NEXT.projection3;
        NEXT.projection.set(projection);
        NEXT.worldMode = worldMode;
        NEXT.color = null;
        NEXT.clip = clip;
        NEXT.stencilRef = stencilRef;
        NEXT.depthStateKey = depthStateKey;
        NEXT.indexVariant = indexVariant;
        NEXT.firstIndex = firstIndex;
        NEXT.indexCount = indexCount;
        NEXT.strokeSize = strokeSize;
        NEXT.inverseStrokeProjection = inverseStrokeProjection;
        NEXT.inverseViewProjection = inverseViewProjection;
        NEXT.depthState = DEPTH_POLICIES[depthStateKey];
        NEXT.parts = NEXT.partViews[partFloats] ??= NEXT.partStorage.subarray(0, partFloats);
        for (let i = 0; i < partFloats; i++) {
            NEXT.parts[i] = this.partScratch[i];
        }
        this.pending = NEXT;
        return NEXT;
    }
    /** The staging array holding this mesh's instance records. */
    _instanceData(mesh) {
        if (mesh.instanceFloats === PLAIN_INSTANCE_FLOATS) {
            return this.instances;
        }
        this.materialInstances ??= new Float32Array(this.maxInstances * MATERIAL_INSTANCE_FLOATS);
        return this.materialInstances;
    }
    /** Pose textures followed by the shared stitch distance field; the field's unit is the last one. */
    _materialTextures(poseTextures) {
        this.stitchField ??= this.device.createTexture(
            { width: STITCH_FIELD_SIZE, height: STITCH_FIELD_SIZE, data: stitchFieldPixels() },
            { premultiplied: true, filter: 'linear' },
        );
        const KEY = poseTextures ?? NO_TEXTURES;
        let set = this.materialTextureSets.get(KEY);
        if (!set) {
            set = Object.freeze([...KEY, this.stitchField]);
            this.materialTextureSets.set(KEY, set);
        }
        return set;
    }
    discard() {
        this.ordered?.discard();
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
        this.ordered?.beginFrame();
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
                (this.materialInstances?.byteLength ?? 0) +
                this.planes.byteLength +
                this.partScratch.byteLength,
            instanced: this.instanced,
            maxClipPlanes: this.maxPlanes,
            poses: this.poseStats(),
            ordered: this.ordered?.stats() ?? null,
        };
    }
    dispose() {
        if (this.disposed) {
            return;
        }
        this.discard();
        this.ordered?.dispose();
        this.poseRenderer?.dispose();
        this.unregisterBatcher();
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
        if (this.stitchField) {
            this.device.deleteTexture(this.stitchField);
            this.stitchField = null;
        }
        for (const PIPELINE of this.pipelines.values()) {
            this.device.deletePipeline(PIPELINE);
        }
        this.pipelines.clear();
        this.pipelineUniforms.clear();
        this.disposed = true;
        this.state = 'disposed';
    }
}

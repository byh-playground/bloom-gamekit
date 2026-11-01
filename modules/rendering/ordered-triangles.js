import { VECTOR_FRAGMENT_VARYINGS, VECTOR_VERTEX_FLOATS, vectorFragmentShader } from './vector-shader.js';
import { POSE_PROGRAM_FUNCTIONS } from './pose-shader.js';
import { clipPlanes } from './clip-planes.js';
import { packPaintRegions } from './paint-regions.js';
import { validateQuads } from './quad-data.js';

// Retained indexed geometry and compact vertex references, never expanded posed vertices or baked body images.
// Command texels: matrix/alpha, matrix/force, color, morph/flash/depth, mode/pose, rect, UV, atlas/filter,
// then the nine optional paint-region colours. The remaining texels pad to a power-of-two row.
const COMMAND_WIDTH = 32;
const COMMAND_FLOATS = COMMAND_WIDTH * 4;
const GEOMETRY_WIDTH = 256;
const VERTEX = `attribute vec2 a_reference;
uniform sampler2D u_geometry;uniform sampler2D u_commands;uniform sampler2D u_vectors;uniform int u_geometryWidth;uniform int u_vectorWidth;
uniform mat3 u_projection;
${VECTOR_FRAGMENT_VARYINGS}varying highp vec2 v_position;
${POSE_PROGRAM_FUNCTIONS}
vec4 geometry(int at){return texelFetch(u_geometry,ivec2(at%u_geometryWidth,at/u_geometryWidth),0);}
vec4 vectorData(int at){return texelFetch(u_vectors,ivec2(at%u_vectorWidth,at/u_vectorWidth),0);}
vec4 command(int at){int i=int(a_reference.y)+at;return texelFetch(u_commands,ivec2(i%${COMMAND_WIDTH},i/${COMMAND_WIDTH}),0);}
void main(){vec4 m0=command(0);vec4 m1=command(1);vec4 tint=command(2);vec4 params=command(3);vec4 meta=command(4);
vec2 p;vec4 color;float partDepth=0.0;v_uv=vec2(0.0);v_paint=vec4(0.0,0.0,-1.0,0.0);v_radial=vec4(0.0);v_rect=vec4(0.0);
if(meta.x>1.5){int index=int(a_reference.x);vec4 g0=vectorData(index);
v_radial=command(6);v_rect=command(7);v_paint=command(5);v_color=tint;
v_uv=g0.zw;v_position=g0.xy;vec3 projected=u_projection*vec3(g0.xy,1.0);gl_Position=vec4(projected.xy,params.w,1.0);return;}
if(meta.x<0.5){
 int index=int(a_reference.x);
 vec4 g0=geometry(index);vec4 g1=geometry(index+1);vec4 g2=geometry(index+2);
 vec4 authored=vec4(g0.zw,g1.xy);vec4 paint=command(8+int(g2.w));authored.rgb=mix(authored.rgb,paint.rgb,paint.a);
 vec4 row0=vec4(1.0,0.0,0.0,0.0);vec4 row1=vec4(0.0,1.0,0.0,0.0);vec4 pose=vec4(0.0,0.0,1.0,0.0);
 if(meta.z>1.5){int part=int(g2.z)*3;int row=int(meta.y);
 row0=texelFetch(u_program,ivec2(part,row),0);row1=texelFetch(u_program,ivec2(part+1,row),0);pose=texelFetch(u_program,ivec2(part+2,row),0);}
 else if(meta.z>0.5)poseEval(int(g2.z),int(meta.y),row0,row1,pose);
 vec2 weights=meta.z>0.5?pose.xy:params.xy;
 vec2 local=g0.xy;if(meta.w>0.5)local+=g1.zw*weights.x;if(meta.w>1.5)local+=g2.xy*weights.y;
 p=vec2(dot(row0.xyz,vec3(local,1.0)),dot(row1.xyz,vec3(local,1.0)));partDepth=pose.w;
 color=mix(authored*tint,tint,m1.w);color.a*=m0.w*pose.z;color.rgb=mix(color.rgb,vec3(1.0),params.z);
 // Mesh colour is premultiplied at each vertex, before interpolation, exactly as MeshRenderer.
 color.rgb*=color.a;
}else{
 float corner=-a_reference.x-1.0;
 vec2 c=corner<0.5?vec2(0.0):corner<1.5?vec2(1.0,0.0):corner<2.5?vec2(1.0):vec2(0.0,1.0);
 vec4 rect=command(5);vec4 uv=command(6);vec4 paint=command(7);p=rect.xy+c*rect.zw;
 v_uv=uv.xy+c*uv.zw;v_paint=vec4(paint.x,params.z>0.5?1.0:m1.w>0.5?2.0:0.0,0.0,paint.y);
 color=tint;color.a*=m0.w;
}
vec2 world=vec2(dot(m0.xyz,vec3(p,1.0)),dot(m1.xyz,vec3(p,1.0)));vec3 projected=u_projection*vec3(world,1.0);
v_position=world;v_color=color;
// Ordinary atlas quads use the vector stream's affine projection contract; meshes retain homogeneous w.
float w=meta.x<0.5?projected.z:1.0;gl_Position=vec4(projected.xy,(params.w+partDepth)*w,w);
}`;
/** Internal ordered native-mesh/atlas-quad batch owned by one MeshRenderer. */
export class OrderedTriangleBatch {
    constructor(device, { maxInstances, maxMeshBytes, maxPlanes }) {
        if (device.maxTextures < 6) {
            throw new Error('Ordered mesh/quads require six texture units');
        }
        this.device = device;
        this.maxPlanes = maxPlanes;
        this.commandCapacity = Math.min(device.maxTextureSize, maxInstances * 4);
        this.triangleCapacity = Math.min(maxInstances * 128, Math.floor(device.maxBufferBytes / 8));
        this.geometryWidth = Math.min(GEOMETRY_WIDTH, device.maxTextureSize, Math.floor((maxMeshBytes * 2) / 16));
        this.maxGeometryTexels = Math.min((maxMeshBytes * 2) / 16, this.geometryWidth * device.maxTextureSize, 2 ** 24);
        this.commands = new Float32Array(this.commandCapacity * COMMAND_FLOATS);
        this.vertexCapacity = Math.min(65535, Math.floor(device.maxBufferBytes / 8));
        if (this.vertexCapacity < 4 || this.triangleCapacity < 2) {
            throw new RangeError('Ordered mesh/quads require room for four references and two triangles');
        }
        this.vectorTexels = 1;
        this.vectorWidth = Math.min(GEOMETRY_WIDTH, device.maxTextureSize);
        this.vectorCapacity = Math.min(
            this.vertexCapacity,
            Math.floor((this.vectorWidth * device.maxTextureSize) / this.vectorTexels),
        );
        this.vectorVertices = null;
        this.references = new Float32Array(this.vertexCapacity * 2);
        this.indices = new Uint16Array(this.triangleCapacity * 3);
        this.dummyTexture = device.createDataTexture(1, 1);
        this.slots = new Map();
        this.slotBytes = 0;
        this.maxSlotBytes = maxMeshBytes * 2;
        this.pipeline = device.createPipeline({
            vertex: VERTEX,
            fragment: vectorFragmentShader(maxPlanes, true),
            stride: 8,
            attributes: [{ name: 'a_reference', size: 2, offset: 0 }],
            uniforms: {
                u_projection: 'matrix3fv',
                u_geometry: '1i',
                u_commands: '1i',
                u_vectors: '1i',
                u_vectorWidth: '1i',
                u_geometryWidth: '1i',
                u_program: '1i',
                u_state: '1i',
                u_overrides: '1i',
                u_programWidth: '1i',
                u_texture: '1i',
                u_depthWrite: '1f',
                'u_planes[0]': '3fv',
                u_planeCount: '1i',
            },
        });
        this.meshes = new Map();
        this.freeGeometry = [];
        this.geometryEnd = 0;
        this.geometryData = new Float32Array(0);
        this.geometryTexture = null;
        this.planes = new Float32Array(maxPlanes * 3);
        this.onRestored = () => {
            this.discard();
            for (const SLOT of this.slots.values()) {
                SLOT.valid = false;
            }
        };
        device.canvas.addEventListener('webglcontextrestored', this.onRestored);
        this.beginFrame();
    }
    beginFrame() {
        this.discard();
        this.slotIndex = 0;
        this.metrics = {
            draws: 0,
            commands: 0,
            triangles: 0,
            vectorBytes: 0,
            vectorTriangles: 0,
            referenceBytes: 0,
            indexBytes: 0,
            reusedTopologies: 0,
            commandBytes: 0,
            geometryUploadBytes: 0,
            flushReasons: Object.create(null),
        };
    }
    retain(mesh) {
        const EXISTING = this.meshes.get(mesh);
        if (EXISTING) {
            return EXISTING;
        }
        this.flush('geometryAllocation');
        const VERTICES = mesh.vertices.length / 11;
        const SETS = new Map([
            [null, { indices: mesh.indices, count: mesh.count }],
            ...mesh.expressionIndices,
            ...mesh.indexVariants,
        ]);
        const SIZE = VERTICES * 3;
        const BLOCK = this.freeGeometry.find((block) => block.size >= SIZE);
        const START = BLOCK?.start ?? this.geometryEnd;
        if (START + SIZE > this.maxGeometryTexels) {
            throw new RangeError('Ordered retained geometry exceeds its byte/texture budget');
        }
        const NEXT_END = Math.max(this.geometryEnd, START + SIZE);
        const REQUIRED_HEIGHT = Math.ceil(NEXT_END / this.geometryWidth);
        const HEIGHT = Math.min(
            Math.floor(this.maxGeometryTexels / this.geometryWidth),
            Math.max(1, 2 ** Math.ceil(Math.log2(REQUIRED_HEIGHT))),
        );
        if (HEIGHT < REQUIRED_HEIGHT) {
            throw new RangeError('Ordered geometry texture padding exceeds its byte budget');
        }
        const GROW = this.geometryData.length < HEIGHT * this.geometryWidth * 4;
        const DATA = GROW ? new Float32Array(HEIGHT * this.geometryWidth * 4) : this.geometryData;
        if (GROW) {
            DATA.set(this.geometryData);
        }
        for (let i = 0; i < VERTICES; i++) {
            const AT = (START + i * 3) * 4;
            DATA.set(mesh.vertices.subarray(i * 11, i * 11 + 11), AT);
            DATA[AT + 11] = mesh.paintRegionNames ? mesh.gpuVertices[i * mesh.bufferStrideFloats + 11] : 0;
        }
        const OFFSETS = new Map();
        for (const [NAME, SET] of SETS) {
            // Each segment preserves index order and shares vertices just like the native indexed mesh.
            const SEGMENTS = [];
            let mapping = new Map(),
                indices = [],
                first = 0;
            const COMMIT = () => {
                if (!indices.length) {
                    return;
                }
                SEGMENTS.push({
                    first,
                    count: indices.length,
                    vertices: Float32Array.from(mapping.keys(), (index) => START + index * 3),
                    indices: Uint16Array.from(indices),
                });
                first += indices.length;
                mapping = new Map();
                indices = [];
            };
            for (let i = 0; i < SET.count; i += 3) {
                const TRIANGLE = [SET.indices?.[i] ?? i, SET.indices?.[i + 1] ?? i + 1, SET.indices?.[i + 2] ?? i + 2];
                const ADDED = new Set(TRIANGLE.filter((index) => !mapping.has(index))).size;
                if (mapping.size + ADDED > this.vertexCapacity || indices.length + 3 > this.indices.length) {
                    COMMIT();
                }
                for (const INDEX of TRIANGLE) {
                    if (!mapping.has(INDEX)) {
                        mapping.set(INDEX, mapping.size);
                    }
                    indices.push(mapping.get(INDEX));
                }
            }
            COMMIT();
            OFFSETS.set(NAME, SEGMENTS);
        }
        if (GROW || !this.geometryTexture) {
            const PREVIOUS = this.geometryTexture;
            this.geometryTexture = this.device.createDataTexture(this.geometryWidth, HEIGHT, { data: DATA });
            if (PREVIOUS) {
                this.device.deleteTexture(PREVIOUS);
            }
            this.metrics.geometryUploadBytes += DATA.byteLength;
        } else {
            const Y = Math.floor(START / this.geometryWidth),
                END = Math.ceil((START + SIZE) / this.geometryWidth);
            const REGION = DATA.subarray(Y * this.geometryWidth * 4, END * this.geometryWidth * 4);
            this.device.updateDataTexture(this.geometryTexture, REGION, {
                y: Y,
                width: this.geometryWidth,
                height: END - Y,
            });
            this.metrics.geometryUploadBytes += REGION.byteLength;
        }
        this.geometryData = DATA;
        if (BLOCK) {
            BLOCK.start += SIZE;
            BLOCK.size -= SIZE;
        }
        this.geometryEnd = NEXT_END;
        const RECORD = { start: START, size: SIZE, variants: OFFSETS };
        this.meshes.set(mesh, RECORD);
        return RECORD;
    }
    release(mesh) {
        const RECORD = this.meshes.get(mesh);
        if (!RECORD) {
            return;
        }
        this.flush('deleteGeometry');
        this.meshes.delete(mesh);
        this.freeGeometry.push({ start: RECORD.start, size: RECORD.size });
        this.freeGeometry.sort((a, b) => a.start - b.start);
        for (let i = this.freeGeometry.length - 1; i > 0; i--) {
            const A = this.freeGeometry[i - 1],
                B = this.freeGeometry[i];
            if (A.start + A.size === B.start) {
                A.size += B.size;
                this.freeGeometry.splice(i, 1);
            }
        }
        const TAIL = this.freeGeometry.at(-1);
        if (TAIL && TAIL.start + TAIL.size === this.geometryEnd) {
            this.geometryEnd = TAIL.start;
            this.freeGeometry.pop();
        }
    }
    _state(options, owner = null, pose = null) {
        const CLIP = clipPlanes(options.clips ?? [], this.maxPlanes);
        const KEY =
            CLIP.key +
            ':' +
            options.stencilRef +
            ':' +
            Number(options.depthTest) +
            ':' +
            Number(options.depthWrite) +
            ':' +
            options.depthFunc +
            ':' +
            (options.blend ?? 'source-over');
        if (
            this.pending &&
            (this.pending.key !== KEY ||
                options.projection.some((n, i) => Math.fround(n) !== this.pending.projection[i]) ||
                (owner &&
                    this.pending.owner &&
                    (owner !== this.pending.owner ||
                        pose.textures.some((texture, i) => texture !== this.pending.pose.textures[i]))))
        ) {
            this.flush('state');
        }
        if (!this.pending) {
            this.pending = {
                key: KEY,
                projection: Float32Array.from(options.projection),
                clip: CLIP,
                stencilRef: options.stencilRef ?? null,
                depth: {
                    test: options.depthTest ?? false,
                    write: options.depthWrite ?? false,
                    func: options.depthFunc ?? 'lequal',
                },
                blend: options.blend ?? 'source-over',
                owner,
                pose,
            };
        } else if (owner && !this.pending.owner) {
            this.pending.owner = owner;
            this.pending.pose = pose;
        }
    }
    _reserve(vertices, indices, commandFloats) {
        if (
            this.commandCount === this.commandCapacity ||
            this.vertexCount + vertices > this.vertexCapacity ||
            this.indexCount + indices > this.indices.length ||
            this.commandFloats + commandFloats > this.commands.length
        ) {
            this.flush('capacity');
        }
    }
    _command(options, matrix, color, morph, alpha, pose, floats = 68) {
        const AT = this.commandFloats,
            DATA = this.commands;
        this.commandCount++;
        this.commandFloats += floats;
        DATA.fill(0, AT, AT + floats);
        DATA.set(
            [
                matrix[0],
                matrix[2],
                matrix[4],
                alpha,
                matrix[1],
                matrix[3],
                matrix[5],
                Number(Boolean(options.forceColor)),
                ...color,
                ...morph,
                Number(Boolean(options.whiteFlash)),
                options.depth ?? 0,
                0,
                pose?.row ?? 0,
                pose ? (pose.kind === 'matrix' ? 2 : 1) : 0,
                0,
            ],
            AT,
        );
        return AT;
    }
    drawMesh(mesh, options, owner, pose) {
        const RECORD = this.retain(mesh),
            SEGMENTS = RECORD.variants.get(options.indexVariant);
        const END = options.firstIndex + options.indexCount;
        for (let entity = 0; entity < options.count; entity++) {
            for (const SEGMENT of SEGMENTS) {
                const FIRST = Math.max(options.firstIndex, SEGMENT.first),
                    LAST = Math.min(END, SEGMENT.first + SEGMENT.count);
                if (FIRST >= LAST) {
                    continue;
                }
                this._reserve(SEGMENT.vertices.length, LAST - FIRST, 68);
                this._state(options, owner, pose);
                let matrix = options.matrices.subarray
                    ? options.matrices.subarray(entity * 6, entity * 6 + 6)
                    : options.matrices.slice(entity * 6, entity * 6 + 6);
                let morph = options.morph,
                    alpha = options.alpha,
                    depth = options.depth;
                if (!pose) {
                    const P = options.part,
                        M = matrix;
                    matrix = [
                        M[0] * P[0] + M[2] * P[4],
                        M[1] * P[0] + M[3] * P[4],
                        M[0] * P[1] + M[2] * P[5],
                        M[1] * P[1] + M[3] * P[5],
                        M[0] * P[2] + M[2] * P[6] + M[4],
                        M[1] * P[2] + M[3] * P[6] + M[5],
                    ];
                    morph = [morph[0] + P[8], morph[1] + P[9]];
                    alpha *= P[10];
                    depth += P[11];
                }
                const AT = this._command({ ...options, depth }, matrix, options.color, morph, alpha, pose);
                this.commands[AT + 19] = mesh.morphCount;
                if (mesh.paintRegionNames || options.paintRegions !== null) {
                    packPaintRegions(
                        mesh.paintRegionNames ?? [],
                        options.paintRegions,
                        this.commands.subarray(AT + 32, AT + 68),
                    );
                }
                if (pose) {
                    owner.noteDraw(options.pose);
                }
                const BASE = this.vertexCount;
                for (let i = 0; i < SEGMENT.vertices.length; i++) {
                    const OFFSET = this.vertexCount++ * 2;
                    this.references[OFFSET] = SEGMENT.vertices[i];
                    this.references[OFFSET + 1] = AT / 4;
                }
                for (let i = FIRST - SEGMENT.first; i < LAST - SEGMENT.first; i++) {
                    this.indices[this.indexCount++] = BASE + SEGMENT.indices[i];
                }
            }
        }
    }
    drawQuads(options, state, matrix) {
        validateQuads(options);
        const COUNT = options.uvRects.length / 4;
        for (let i = 0; i < COUNT; i++) {
            this._reserve(4, 6, 32);
            this._state(state);
            const AT = this._command(
                options,
                matrix,
                options.color ?? [1, 1, 1, 1],
                [0, 0],
                options.alpha ?? 1,
                null,
                32,
            );
            this.commands[AT + 16] = 1;
            for (let j = 0; j < 4; j++) {
                this.commands[AT + 20 + j] = options.localRects[i * 4 + j];
                this.commands[AT + 24 + j] = options.uvRects[i * 4 + j];
            }
            this.commands[AT + 28] = options.layer;
            this.commands[AT + 29] = Number(options.filter === 'nearest');
            const BASE = this.vertexCount;
            for (let corner = 0; corner < 4; corner++) {
                const OFFSET = this.vertexCount++ * 2;
                this.references[OFFSET] = -1 - corner;
                this.references[OFFSET + 1] = AT / 4;
            }
            this.indices.set([BASE, BASE + 1, BASE + 2, BASE, BASE + 2, BASE + 3], this.indexCount);
            this.indexCount += 6;
        }
        this.device.stats.spriteRuns += COUNT;
    }
    /** Flat per-triangle paint is captured once per run; vertices stream only position and UV. */
    drawVectorTriangles(vertices, count, state) {
        this.vectorVertices ??= new Float32Array(
            this.vectorWidth * Math.ceil(this.vectorCapacity / this.vectorWidth) * 4,
        );
        let offset = 0;
        while (offset < count) {
            const SOURCE = offset * VECTOR_VERTEX_FLOATS;
            let end = offset + 3;
            while (end < count) {
                let same = true;
                for (let field = 4; same && field < VECTOR_VERTEX_FLOATS; field++) {
                    same = vertices[SOURCE + field] === vertices[end * VECTOR_VERTEX_FLOATS + field];
                }
                if (!same) {
                    break;
                }
                end += 3;
            }
            while (offset < end) {
                const TAKE =
                    Math.floor(
                        Math.min(
                            end - offset,
                            this.vertexCapacity - this.vertexCount,
                            this.indices.length - this.indexCount,
                            this.vectorCapacity - this.vectorCount,
                        ) / 3,
                    ) * 3;
                if (!TAKE) {
                    this.flush('capacity');
                    continue;
                }
                this._reserve(TAKE, TAKE, 32);
                this._state(state);
                const AT = this._command(
                    { depth: vertices[SOURCE + 20] },
                    [1, 0, 0, 1, 0, 0],
                    vertices.subarray(SOURCE + 4, SOURCE + 8),
                    [0, 0],
                    1,
                    null,
                    32,
                );
                this.commands[AT + 16] = 2;
                this.commands.set(vertices.subarray(SOURCE + 8, SOURCE + 20), AT + 20);
                for (let i = 0; i < TAKE; i++) {
                    const REF = this.vertexCount++;
                    const TEXEL = this.vectorCount++;
                    this.references[REF * 2] = TEXEL;
                    this.references[REF * 2 + 1] = AT / 4;
                    this.indices[this.indexCount++] = REF;
                    const FROM = (offset + i) * VECTOR_VERTEX_FLOATS;
                    this.vectorVertices[TEXEL * 4] = vertices[FROM];
                    this.vectorVertices[TEXEL * 4 + 1] = vertices[FROM + 1];
                    this.vectorVertices[TEXEL * 4 + 2] = vertices[FROM + 2];
                    this.vectorVertices[TEXEL * 4 + 3] = vertices[FROM + 3];
                }
                offset += TAKE;
                this.metrics.vectorTriangles += TAKE / 3;
            }
        }
    }
    _deleteSlot(key) {
        const SLOT = this.slots.get(key);
        if (!SLOT) {
            return;
        }
        this.device.deleteVertexBuffer(SLOT.referenceBuffer);
        this.device.deleteIndexBuffer(SLOT.indexBuffer);
        this.device.deleteTexture(SLOT.commandTexture);
        if (SLOT.vectorTexture) {
            this.device.deleteTexture(SLOT.vectorTexture);
        }
        this.slotBytes -= SLOT.bytes;
        this.slots.delete(key);
    }
    _slot(references, indices, rows, vectorRows) {
        const KEY = this.slotIndex++,
            PREVIOUS = this.slots.get(KEY);
        if (
            PREVIOUS &&
            (PREVIOUS.references.length < references.length ||
                PREVIOUS.indices.length < indices.length ||
                PREVIOUS.commandTexture.height < rows ||
                (vectorRows && (!PREVIOUS.vectorTexture || PREVIOUS.vectorTexture.height < vectorRows)))
        ) {
            this._deleteSlot(KEY);
        }
        let slot = this.slots.get(KEY);
        if (slot) {
            this.slots.delete(KEY);
            this.slots.set(KEY, slot);
            return slot;
        }
        const REFERENCE_BYTES = Math.min(
            this.device.maxBufferBytes - (this.device.maxBufferBytes % 4),
            2 ** Math.ceil(Math.log2(references.byteLength)),
        );
        const INDEX_BYTES = Math.min(
            this.device.maxBufferBytes - (this.device.maxBufferBytes % 2),
            2 ** Math.ceil(Math.log2(indices.byteLength)),
        );
        const COMMAND_ROWS = Math.min(this.device.maxTextureSize, 2 ** Math.ceil(Math.log2(rows)));
        const VECTOR_ROWS = vectorRows
            ? Math.min(this.device.maxTextureSize, 2 ** Math.ceil(Math.log2(vectorRows)))
            : 0;
        const BYTES =
            (REFERENCE_BYTES + INDEX_BYTES + COMMAND_WIDTH * COMMAND_ROWS * 16 + this.vectorWidth * VECTOR_ROWS * 16) *
            2;
        if (BYTES > this.maxSlotBytes) {
            throw new RangeError('Ordered batch topology exceeds its retained byte budget');
        }
        while (this.slotBytes + BYTES > this.maxSlotBytes && this.slots.size) {
            this._deleteSlot(this.slots.keys().next().value);
        }
        const ALLOCATED = [];
        try {
            const REFERENCE_BUFFER = this.device.createVertexBuffer({ capacityBytes: REFERENCE_BYTES });
            ALLOCATED.push(() => this.device.deleteVertexBuffer(REFERENCE_BUFFER));
            const INDEX_BUFFER = this.device.createIndexBuffer({ capacityBytes: INDEX_BYTES });
            ALLOCATED.push(() => this.device.deleteIndexBuffer(INDEX_BUFFER));
            const COMMAND_TEXTURE = this.device.createDataTexture(COMMAND_WIDTH, COMMAND_ROWS);
            ALLOCATED.push(() => this.device.deleteTexture(COMMAND_TEXTURE));
            const VECTOR_TEXTURE = VECTOR_ROWS ? this.device.createDataTexture(this.vectorWidth, VECTOR_ROWS) : null;
            if (VECTOR_TEXTURE) {
                ALLOCATED.push(() => this.device.deleteTexture(VECTOR_TEXTURE));
            }
            slot = {
                vectorTexture: VECTOR_TEXTURE,
                referenceBuffer: REFERENCE_BUFFER,
                indexBuffer: INDEX_BUFFER,
                commandTexture: COMMAND_TEXTURE,
                references: new Float32Array(REFERENCE_BYTES / 4),
                referenceCount: 0,
                indices: new Uint16Array(INDEX_BYTES / 2),
                indexCount: 0,
                bytes: BYTES,
                valid: false,
            };
            this.slots.set(KEY, slot);
            this.slotBytes += BYTES;
            return slot;
        } catch (error) {
            for (const CLEANUP of ALLOCATED.reverse()) {
                CLEANUP();
            }
            throw error;
        }
    }
    flush(reason = 'explicit') {
        if (!this.indexCount) {
            return;
        }
        const PENDING = this.pending,
            DEVICE = this.device;
        PENDING.owner?.flushUpdates();
        this.planes.fill(0);
        if (PENDING.clip.values) {
            this.planes.set(PENDING.clip.values);
        }
        const ROWS = Math.ceil(this.commandFloats / COMMAND_FLOATS);
        const COMMANDS = this.commands.subarray(0, ROWS * COMMAND_FLOATS),
            REFERENCES = this.references.subarray(0, this.vertexCount * 2),
            INDICES = this.indices.subarray(0, this.indexCount);
        const VECTOR_ROWS = Math.ceil((this.vectorCount * this.vectorTexels) / this.vectorWidth);
        const SLOT = this._slot(REFERENCES, INDICES, ROWS, VECTOR_ROWS);
        if (VECTOR_ROWS) {
            const DATA = this.vectorVertices.subarray(0, VECTOR_ROWS * this.vectorWidth * 4);
            DEVICE.updateDataTexture(SLOT.vectorTexture, DATA, { width: this.vectorWidth, height: VECTOR_ROWS });
            this.metrics.vectorBytes += DATA.byteLength;
        }
        // A frame keeps each ordered chunk's own resources: later chunks never overwrite data still in use.
        DEVICE.updateDataTexture(SLOT.commandTexture, COMMANDS, { width: COMMAND_WIDTH, height: ROWS });
        let same = SLOT.valid && SLOT.referenceCount === REFERENCES.length && SLOT.indexCount === INDICES.length;
        for (let i = 0; same && i < REFERENCES.length; i++) {
            same = REFERENCES[i] === SLOT.references[i];
        }
        for (let i = 0; same && i < INDICES.length; i++) {
            same = INDICES[i] === SLOT.indices[i];
        }
        if (!same) {
            DEVICE.uploadVertices(SLOT.referenceBuffer, REFERENCES);
            DEVICE.uploadIndices(SLOT.indexBuffer, INDICES);
            SLOT.references.set(REFERENCES);
            SLOT.indices.set(INDICES);
            SLOT.valid = true;
            SLOT.referenceCount = REFERENCES.length;
            SLOT.indexCount = INDICES.length;
            this.metrics.referenceBytes += REFERENCES.byteLength;
            this.metrics.indexBytes += INDICES.byteLength;
        } else {
            this.metrics.reusedTopologies++;
        }
        const POSE = PENDING.pose;
        const VECTOR_TEXTURE = VECTOR_ROWS ? SLOT.vectorTexture : null;
        DEVICE.draw({
            pipeline: this.pipeline,
            buffer: SLOT.referenceBuffer,
            indexBuffer: SLOT.indexBuffer,
            count: this.indexCount,
            uniforms: {
                u_projection: PENDING.projection,
                u_geometry: 0,
                u_commands: 1,
                u_vectors: VECTOR_TEXTURE ? 6 : 0,
                u_vectorWidth: this.vectorWidth,
                u_geometryWidth: this.geometryWidth,
                u_program: 2,
                u_state: 3,
                u_overrides: 4,
                u_programWidth: POSE?.programWidth ?? 1,
                u_texture: 5,
                u_depthWrite: Number(PENDING.depth.write),
                'u_planes[0]': this.planes,
                u_planeCount: PENDING.clip.count,
            },
            textures: [
                this.geometryTexture ?? this.dummyTexture,
                SLOT.commandTexture,
                ...[0, 1, 2].map((index) => POSE?.textures[index] ?? this.dummyTexture),
                DEVICE.textureAtlas.texture,
                ...(VECTOR_TEXTURE ? [VECTOR_TEXTURE] : []),
            ],
            depth: PENDING.depth,
            blend: PENDING.blend,
            stencil:
                PENDING.stencilRef === null
                    ? false
                    : { func: 'equal', ref: PENDING.stencilRef, mask: 255, writeMask: 0, pass: 'keep' },
        });
        this.metrics.draws++;
        this.metrics.commands += this.commandCount;
        this.metrics.triangles += this.indexCount / 3;
        this.metrics.commandBytes += COMMANDS.byteLength;
        this.metrics.flushReasons[reason] = (this.metrics.flushReasons[reason] ?? 0) + 1;
        this.discard();
    }
    discard() {
        this.commandCount = 0;
        this.commandFloats = 0;
        this.vertexCount = 0;
        this.indexCount = 0;
        this.vectorCount = 0;
        this.pending = null;
    }
    stats() {
        return {
            ...this.metrics,
            flushReasons: { ...this.metrics.flushReasons },
            geometryBytes: this.geometryData.byteLength,
            topologyBytes: this.slotBytes,
            maxTopologyBytes: this.maxSlotBytes,
            vertexCapacity: this.vertexCapacity,
            commandCapacity: this.commandCapacity,
            triangleCapacity: this.triangleCapacity,
        };
    }
    dispose() {
        this.discard();
        this.device.canvas.removeEventListener('webglcontextrestored', this.onRestored);
        for (const KEY of this.slots.keys()) {
            this._deleteSlot(KEY);
        }
        this.device.deletePipeline(this.pipeline);
        this.device.deleteTexture(this.dummyTexture);
        if (this.geometryTexture) {
            this.device.deleteTexture(this.geometryTexture);
        }
        this.meshes.clear();
        this.freeGeometry.length = 0;
    }
}

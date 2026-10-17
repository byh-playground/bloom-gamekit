import { createTimeline } from 'animejs/timeline';
import { validateCompiledAsset } from './schema.js';
const IDENTITY = Object.freeze([1, 0, 0, 1, 0, 0]);
const DEFAULT_POSE = Object.freeze({
    x: 0,
    y: 0,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    opacity: 1,
});
const POSE_FIELDS = Object.keys(DEFAULT_POSE);
const FINITE_TIME = (value, name) => {
    if (!Number.isFinite(value)) {
        throw new TypeError(`${name} must be a finite absolute display time in milliseconds`);
    }
    return value;
};
function localMatrix(pivot, pose) {
    const [PX, PY] = pivot,
        COSINE = Math.cos(pose.rotation),
        SINE = Math.sin(pose.rotation);
    const A = COSINE * pose.scaleX,
        B = SINE * pose.scaleX,
        C = -SINE * pose.scaleY,
        D = COSINE * pose.scaleY;
    return [A, B, C, D, PX + pose.x - A * PX - C * PY, PY + pose.y - B * PX - D * PY];
}
function multiply(a, b) {
    return [
        a[0] * b[0] + a[2] * b[1],
        a[1] * b[0] + a[3] * b[1],
        a[0] * b[2] + a[2] * b[3],
        a[1] * b[2] + a[3] * b[3],
        a[0] * b[4] + a[2] * b[5] + a[4],
        a[1] * b[4] + a[3] * b[5] + a[5],
    ];
}
function composeWorldMatrix(world, local) {
    if (
        !world ||
        world.length !== 16 ||
        local.length !== 6 ||
        Array.from(local).some((value) => !Number.isFinite(value))
    ) {
        throw new TypeError('Six finite root matrix values required');
    }
    const [A, B, C, D, E, F] = local,
        OUT = Float32Array.from(world);
    for (const VALUE of OUT) {
        if (!Number.isFinite(VALUE)) {
            throw new TypeError('worldMatrix must contain 16 finite values');
        }
    }
    if (
        Math.abs(OUT[3]) > 1e-7 ||
        Math.abs(OUT[7]) > 1e-7 ||
        Math.abs(OUT[11]) > 1e-7 ||
        Math.abs(OUT[15] - 1) > 1e-7
    ) {
        throw new TypeError('worldMatrix must be an affine column-major 4x4 matrix');
    }
    OUT[0] = world[0] * A + world[4] * B;
    OUT[1] = world[1] * A + world[5] * B;
    OUT[2] = world[2] * A + world[6] * B;
    OUT[3] = world[3] * A + world[7] * B;
    OUT[4] = world[0] * C + world[4] * D;
    OUT[5] = world[1] * C + world[5] * D;
    OUT[6] = world[2] * C + world[6] * D;
    OUT[7] = world[3] * C + world[7] * D;
    OUT[12] = world[0] * E + world[4] * F + world[12];
    OUT[13] = world[1] * E + world[5] * F + world[13];
    OUT[14] = world[2] * E + world[6] * F + world[14];
    OUT[15] = world[3] * E + world[7] * F + world[15];
    return OUT;
}
function validateShaderSurfaceClipCapacity(clips, maxPlanes) {
    if (!clips?.length) {
        return;
    }
    if (!Array.isArray(clips)) {
        throw new TypeError('clips must be an array of convex polygons');
    }
    let edgeCount = 0;
    for (const POLYGON of clips) {
        if (
            !Array.isArray(POLYGON) ||
            POLYGON.length < 3 ||
            POLYGON.some((point) => !Number.isFinite(point?.x) || !Number.isFinite(point?.y))
        ) {
            throw new TypeError('Finite convex clip polygons required');
        }
        let area = 0;
        for (let i = 0; i < POLYGON.length; i++) {
            const A = POLYGON[i],
                B = POLYGON[(i + 1) % POLYGON.length];
            area += A.x * B.y - B.x * A.y;
            if (Math.hypot(B.x - A.x, B.y - A.y) > 0) {
                edgeCount++;
            }
        }
        if (Math.abs(area) < 1e-8) {
            throw new RangeError('A clip polygon must have nonzero area');
        }
        if (edgeCount > maxPlanes) {
            throw new RangeError(`Vector asset clipping exceeds the shader surface limit of ${maxPlanes} edge planes`);
        }
    }
}
function transformPoint(matrix, point) {
    return {
        x: matrix[0] * point[0] + matrix[2] * point[1] + matrix[4],
        y: matrix[1] * point[0] + matrix[3] * point[1] + matrix[5],
    };
}
function effectivePose(base, authored) {
    return {
        x: base.x + authored.x,
        y: base.y + authored.y,
        rotation: base.rotation + authored.rotation,
        scaleX: base.scaleX * authored.scaleX,
        scaleY: base.scaleY * authored.scaleY,
        opacity: base.opacity * authored.opacity,
    };
}
function loopTime(clip, elapsed) {
    if (clip.loop === 'once') {
        return Math.min(clip.durationMs, Math.max(0, elapsed));
    }
    if (clip.loop === 'repeat') {
        return ((elapsed % clip.durationMs) + clip.durationMs) % clip.durationMs;
    }
    const CYCLE = clip.durationMs * 2,
        POINT = ((elapsed % CYCLE) + CYCLE) % CYCLE;
    return POINT <= clip.durationMs ? POINT : CYCLE - POINT;
}
function buildClipTimeline(clip, parts) {
    const TRACKS = new Map(
        parts.map((part) => [
            part.id,
            {
                ...DEFAULT_POSE,
            },
        ]),
    );
    const FIRST = clip.keyframes[0];
    for (const [PART_ID, POSE] of Object.entries(FIRST.parts)) {
        Object.assign(TRACKS.get(PART_ID), POSE);
    }
    const TIMELINE = createTimeline({
        autoplay: false,
    });
    for (let frameIndex = 1; frameIndex < clip.keyframes.length; frameIndex++) {
        const PREVIOUS = clip.keyframes[frameIndex - 1],
            FRAME = clip.keyframes[frameIndex];
        const DURATION = FRAME.timeMs - PREVIOUS.timeMs;
        for (const [PART_ID, POSE] of Object.entries(FRAME.parts)) {
            TIMELINE.add(
                TRACKS.get(PART_ID),
                {
                    ...POSE,
                    duration: DURATION,
                    ease: FRAME.easing,
                },
                PREVIOUS.timeMs,
            );
        }
    }
    if (!TIMELINE.paused) {
        TIMELINE.pause();
    }
    return {
        timeline: TIMELINE,
        tracks: TRACKS,
    };
}
function copyPose(pose) {
    return Object.fromEntries(POSE_FIELDS.map((field) => [field, pose[field]]));
}
function authoredMorph(sketch, displayTimeMs) {
    if (!sketch) {
        return [0, 0];
    }
    const PHASE = ((((displayTimeMs % sketch.periodMs) + sketch.periodMs) % sketch.periodMs) / sketch.periodMs) * 3;
    const SEGMENT = Math.floor(PHASE),
        AMOUNT = PHASE - SEGMENT;
    if (SEGMENT === 0) {
        return [AMOUNT, 0];
    }
    if (SEGMENT === 1) {
        return [1 - AMOUNT, AMOUNT];
    }
    return [0, 1 - AMOUNT];
}
function blendPoses(from, to, amount, partIds) {
    const OUTPUT = new Map();
    for (const ID of partIds) {
        const A = from.get(ID) ?? DEFAULT_POSE,
            B = to.get(ID) ?? DEFAULT_POSE;
        OUTPUT.set(
            ID,
            Object.fromEntries(POSE_FIELDS.map((field) => [field, A[field] + (B[field] - A[field]) * amount])),
        );
    }
    return OUTPUT;
}

/** Owns one retained GPU mesh; its players own only independent pose/timeline state. */
export function createVectorAsset(meshRenderer, compiledAsset, { surfaceRenderer = null } = {}) {
    if (!meshRenderer?.createMesh || !meshRenderer?.drawMesh || !meshRenderer?.deleteMesh) {
        throw new TypeError('A GameKit MeshRenderer is required');
    }
    validateCompiledAsset(compiledAsset);
    const METADATA = compiledAsset.metadata;
    const SKETCH_MORPH_STYLE = METADATA.styles?.find((style) => style.kind === 'sketch') ?? null;
    const PART_INDICES = new Map(METADATA.parts.map((part, index) => [part.id, index]));
    const CLIPS = METADATA.clips;
    const GEOMETRY = compiledAsset.geometry,
        SHADER_GEOMETRY = GEOMETRY.shaderSurfaces ?? [];
    if (
        SHADER_GEOMETRY.length &&
        (!surfaceRenderer?.createSurface || !surfaceRenderer?.drawSurface || !surfaceRenderer?.deleteSurface)
    ) {
        throw new TypeError(
            'This SVG declares backend:"shader"; pass a GameKit YarnSurfaceRenderer when creating the vector asset',
        );
    }
    const MESH = GEOMETRY.vertices.length ? meshRenderer.createMesh(GEOMETRY) : null;
    const RETAINED_SURFACES = [];
    try {
        for (const DESCRIPTOR of SHADER_GEOMETRY) {
            RETAINED_SURFACES.push(surfaceRenderer.createSurface(DESCRIPTOR));
        }
    } catch (error) {
        for (const SURFACE of RETAINED_SURFACES) {
            surfaceRenderer.deleteSurface(SURFACE);
        }
        if (MESH) {
            meshRenderer.deleteMesh(MESH);
        }
        throw error;
    }
    const PLAYERS = new Set();
    let disposed = false;
    const REQUIRE_READY = () => {
        if (disposed) {
            throw new Error('Vector asset is disposed');
        }
    };
    const CREATE_PLAYER = ({ clip = Object.keys(CLIPS)[0], startedAtMs = 0 } = {}) => {
        REQUIRE_READY();
        if (!Object.hasOwn(CLIPS, clip)) {
            throw new TypeError(`Unknown vector clip: ${clip}`);
        }
        FINITE_TIME(startedAtMs, 'startedAtMs');
        const TIMELINES = new Map();
        for (const [NAME, DEFINITION] of Object.entries(CLIPS)) {
            TIMELINES.set(NAME, buildClipTimeline(DEFINITION, METADATA.parts));
        }
        const EXPRESSION_PARTS = new Set(
            Object.values(METADATA.expressions).flatMap((expression) => [...expression.show, ...expression.hide]),
        );
        const VISIBLE = new Map(METADATA.parts.map((part) => [part.id, !EXPRESSION_PARTS.has(part.id)]));
        const BASE_POSE = new Map(
            METADATA.parts.map((part) => [
                part.id,
                {
                    ...DEFAULT_POSE,
                },
            ]),
        );
        const INITIAL = METADATA.expressions[METADATA.defaultExpression];
        for (const ID of INITIAL.show) {
            VISIBLE.set(ID, true);
        }
        for (const ID of INITIAL.hide) {
            VISIBLE.set(ID, false);
        }
        let rootPlayback = {
            kind: 'clip',
            name: clip,
            startedAtMs,
        };
        let expression = METADATA.defaultExpression;
        let visibilityOverridden = false;
        let displayTimeMs = startedAtMs;
        let currentPose = new Map(
            METADATA.parts.map((part) => [
                part.id,
                {
                    ...DEFAULT_POSE,
                },
            ]),
        );
        let playbackRevision = 0;
        let sampledPlaybackRevision = -1;
        let poseRevision = 0;
        let resolvedRevision = -1;
        let resolvedPose = null;
        let playerDisposed = false;
        const INVALIDATE_POSE = () => {
            poseRevision++;
        };
        const ASSERT_PLAYER = () => {
            REQUIRE_READY();
            if (playerDisposed) {
                throw new Error('Vector player is disposed');
            }
        };
        const SAMPLE_CLIP = (playback, timeMs) => {
            const DEFINITION = CLIPS[playback.name],
                LOCAL_TIME = loopTime(DEFINITION, timeMs - playback.startedAtMs);
            const RECORD = TIMELINES.get(playback.name);
            RECORD.timeline.seek(LOCAL_TIME, true);
            const OUTPUT = new Map();
            for (const [ID, POSE] of RECORD.tracks) {
                OUTPUT.set(ID, copyPose(POSE));
            }
            return OUTPUT;
        };
        const SAMPLE = (playback, timeMs) => {
            if (playback.kind === 'clip') {
                return SAMPLE_CLIP(playback, timeMs);
            }
            const ELAPSED_MS = timeMs - playback.atMs;
            if (ELAPSED_MS < 0) {
                return SAMPLE(playback.from, timeMs);
            }
            if (playback.durationMs === 0) {
                return SAMPLE(playback.to, timeMs);
            }
            if (ELAPSED_MS === 0) {
                return SAMPLE(playback.from, timeMs);
            }
            if (ELAPSED_MS >= playback.durationMs) {
                return SAMPLE(playback.to, timeMs);
            }
            const SOURCE = SAMPLE(playback.from, timeMs);
            const TARGET = SAMPLE(playback.to, timeMs);
            const AMOUNT = ELAPSED_MS / playback.durationMs;
            return blendPoses(
                SOURCE,
                TARGET,
                AMOUNT,
                METADATA.parts.map((part) => part.id),
            );
        };
        const SEEK = (timeMs) => {
            ASSERT_PLAYER();
            const NEXT_TIME_MS = FINITE_TIME(timeMs, 'displayTimeMs');
            if (NEXT_TIME_MS !== displayTimeMs || sampledPlaybackRevision !== playbackRevision) {
                displayTimeMs = NEXT_TIME_MS;
                currentPose = SAMPLE(rootPlayback, displayTimeMs);
                sampledPlaybackRevision = playbackRevision;
                INVALIDATE_POSE();
            }
            return PLAYER;
        };
        const SET_EXPRESSION = (name) => {
            ASSERT_PLAYER();
            const VARIANT = METADATA.expressions[name];
            if (!VARIANT) {
                throw new TypeError(`Unknown vector expression: ${name}`);
            }
            for (const ID of EXPRESSION_PARTS) {
                VISIBLE.set(ID, false);
            }
            for (const ID of VARIANT.show) {
                VISIBLE.set(ID, true);
            }
            for (const ID of VARIANT.hide) {
                VISIBLE.set(ID, false);
            }
            expression = name;
            visibilityOverridden = false;
            INVALIDATE_POSE();
            return PLAYER;
        };
        const SET_PART_VISIBLE = (id, isVisible) => {
            ASSERT_PLAYER();
            if (!PART_INDICES.has(id) || typeof isVisible !== 'boolean') {
                throw new TypeError('Known part id and boolean visibility required');
            }
            VISIBLE.set(id, isVisible);
            visibilityOverridden = true;
            INVALIDATE_POSE();
            return PLAYER;
        };
        const SET_BASE_POSE = (id, pose) => {
            ASSERT_PLAYER();
            if (!PART_INDICES.has(id) || !pose || typeof pose !== 'object' || Array.isArray(pose)) {
                throw new TypeError('Known part and pose object required');
            }
            const CURRENT = BASE_POSE.get(id);
            for (const [FIELD, VALUE] of Object.entries(pose)) {
                if (!POSE_FIELDS.includes(FIELD) || !Number.isFinite(VALUE)) {
                    throw new TypeError('Part base poses accept only finite authored numeric pose fields');
                }
                if (FIELD === 'opacity' && (VALUE < 0 || VALUE > 1)) {
                    throw new RangeError('Part opacity must be in [0,1]');
                }
                if ((FIELD === 'scaleX' || FIELD === 'scaleY') && VALUE === 0) {
                    throw new RangeError('Part scale cannot be zero');
                }
                CURRENT[FIELD] = VALUE;
            }
            INVALIDATE_POSE();
            return PLAYER;
        };
        const PLAY = (name, atMs = displayTimeMs) => {
            ASSERT_PLAYER();
            if (!Object.hasOwn(CLIPS, name)) {
                throw new TypeError(`Unknown vector clip: ${name}`);
            }
            rootPlayback = {
                kind: 'clip',
                name,
                startedAtMs: FINITE_TIME(atMs, 'atMs'),
            };
            playbackRevision++;
            return SEEK(atMs);
        };
        const TRANSITION_TO = (name, atMs = displayTimeMs, durationMs = 0) => {
            ASSERT_PLAYER();
            if (!Object.hasOwn(CLIPS, name)) {
                throw new TypeError(`Unknown vector clip: ${name}`);
            }
            FINITE_TIME(atMs, 'atMs');
            if (!Number.isFinite(durationMs) || durationMs < 0) {
                throw new RangeError('transition duration must be finite and nonnegative');
            }
            rootPlayback = {
                kind: 'transition',
                from: rootPlayback,
                to: {
                    kind: 'clip',
                    name,
                    startedAtMs: atMs,
                },
                atMs,
                durationMs,
            };
            playbackRevision++;
            return SEEK(atMs);
        };
        const WORLD_MATRICES = () => {
            if (resolvedRevision === poseRevision) {
                return resolvedPose;
            }
            const OUTPUT = new Map();
            const RESOLVE_PART = (id) => {
                if (OUTPUT.has(id)) {
                    return OUTPUT.get(id);
                }
                const DEFINITION = METADATA.parts[PART_INDICES.get(id)];
                const POSE = effectivePose(BASE_POSE.get(id), currentPose.get(id));
                const LOCAL = localMatrix(DEFINITION.pivot, POSE);
                const MATRIX = DEFINITION.parent === null ? LOCAL : multiply(RESOLVE_PART(DEFINITION.parent), LOCAL);
                OUTPUT.set(id, MATRIX);
                return MATRIX;
            };
            for (const PART of METADATA.parts) {
                RESOLVE_PART(PART.id);
            }
            const PART_POSES = METADATA.parts.map((part) => {
                const POSE = RESOLVE_PART_POSE(part, OUTPUT);
                return {
                    transform: POSE.transform,
                    opacity: POSE.opacity,
                    visible: POSE.visible,
                };
            });
            resolvedPose = {
                matrices: OUTPUT,
                parts: PART_POSES,
                morph: authoredMorph(SKETCH_MORPH_STYLE, displayTimeMs),
            };
            resolvedRevision = poseRevision;
            return resolvedPose;
        };
        const GET_SOCKET = (id) => {
            ASSERT_PLAYER();
            const SOCKET = METADATA.sockets[id];
            if (!SOCKET) {
                throw new TypeError(`Unknown vector socket: ${id}`);
            }
            return transformPoint(WORLD_MATRICES().matrices.get(SOCKET.part), SOCKET.point);
        };
        const RESOLVE_PART_POSE = (part, matrices) => {
            let parentVisible = true;
            let opacity = 1;
            let parent = part;
            while (parent) {
                parentVisible &&= VISIBLE.get(parent.id) !== false;
                opacity *= effectivePose(BASE_POSE.get(parent.id), currentPose.get(parent.id)).opacity;
                parent = parent.parent === null ? null : METADATA.parts[PART_INDICES.get(parent.parent)];
            }
            return {
                transform: matrices.get(part.id),
                opacity,
                visible: parentVisible,
            };
        };
        const PART_POSES = () => {
            ASSERT_PLAYER();
            const RESOLVED = WORLD_MATRICES();
            return RESOLVED.parts.map((pose, index) => {
                return {
                    transform: pose.transform.slice(),
                    morph: RESOLVED.morph.slice(),
                    opacity: pose.opacity,
                    visible: pose.visible,
                    index,
                };
            });
        };
        const DRAW = ({
            projection,
            viewProjection,
            worldMatrix,
            matrix = IDENTITY,
            alpha = 1,
            color = [1, 1, 1, 1],
            forceColor = false,
            whiteFlash = false,
            clips = [],
            stencilRef = null,
            depth = 0,
            depthTest = false,
            depthWrite = false,
            depthFunc = 'lequal',
            strokeViewport = null,
            excludeParts = null,
        } = {}) => {
            ASSERT_PLAYER();
            if (excludeParts !== null) {
                if (!(excludeParts instanceof Set)) {
                    throw new TypeError('excludeParts must be a Set of known part ids');
                }
                for (const PART_ID of excludeParts) {
                    if (!PART_INDICES.has(PART_ID)) {
                        throw new TypeError(`Unknown vector part: ${PART_ID}`);
                    }
                }
            }
            if (GEOMETRY.shaderSurfaces?.length) {
                validateShaderSurfaceClipCapacity(clips, surfaceRenderer.maxClipPlanes);
            }
            const RESOLVED = WORLD_MATRICES();
            const POSES = RESOLVED.parts.map((pose, index) => ({
                transform: pose.transform.slice(),
                opacity: pose.opacity,
                visible: pose.visible && !excludeParts?.has(METADATA.parts[index].id),
            }));
            if (GEOMETRY.drawOrder) {
                const WORLD_MODE = viewProjection !== undefined || worldMatrix !== undefined;
                for (const COMMAND of GEOMETRY.drawOrder) {
                    if (COMMAND.kind === 'mesh') {
                        if (!POSES[COMMAND.partIndex].visible || POSES[COMMAND.partIndex].opacity <= 0) {
                            continue;
                        }
                        if (!MESH) {
                            throw new Error('SVG draw order references mesh geometry that was not retained');
                        }
                        meshRenderer.drawMesh(MESH, {
                            ...(WORLD_MODE
                                ? {
                                      viewProjection,
                                      worldMatrix,
                                  }
                                : {
                                      projection,
                                  }),
                            matrix,
                            parts: POSES,
                            morph: RESOLVED.morph.slice(),
                            alpha,
                            color,
                            forceColor,
                            whiteFlash,
                            clips,
                            stencilRef,
                            depth,
                            depthTest,
                            depthWrite,
                            depthFunc,
                            strokeViewport,
                            indexRange: [COMMAND.firstIndex, COMMAND.indexCount],
                        });
                        continue;
                    }
                    const SURFACE = RETAINED_SURFACES[COMMAND.surfaceIndex],
                        POSE = POSES[GEOMETRY.shaderSurfaces[COMMAND.surfaceIndex].partIndex];
                    if (!POSE.visible || POSE.opacity <= 0) {
                        continue;
                    }
                    meshRenderer.flush('vectorShaderSurfaceBoundary');
                    const MATERIAL_TRANSFORM = WORLD_MODE ? POSE.transform : multiply(matrix, POSE.transform);
                    const SHADER_DEPTH =
                        depthTest || depthWrite
                            ? {
                                  test: depthTest,
                                  write: depthWrite,
                                  func: depthFunc,
                              }
                            : false;
                    surfaceRenderer.drawSurface(SURFACE, {
                        ...(WORLD_MODE
                            ? {
                                  viewProjection,
                                  worldMatrix: composeWorldMatrix(worldMatrix, matrix),
                              }
                            : {
                                  projection,
                              }),
                        transform: MATERIAL_TRANSFORM,
                        color,
                        alpha: alpha * POSE.opacity,
                        forceColor,
                        whiteFlash: whiteFlash ? 1 : 0,
                        timeMs: displayTimeMs,
                        clips,
                        stencilRef,
                        z: depth,
                        depth: SHADER_DEPTH,
                    });
                }
                return;
            }
            const INDEX_VARIANT =
                !visibilityOverridden && compiledAsset.geometry.expressionIndices?.[expression] ? expression : null;
            const WORLD_MODE = viewProjection !== undefined || worldMatrix !== undefined;
            meshRenderer.drawMesh(MESH, {
                ...(WORLD_MODE
                    ? {
                          viewProjection,
                          worldMatrix,
                      }
                    : {
                          projection,
                      }),
                matrix,
                parts: POSES,
                morph: RESOLVED.morph.slice(),
                alpha,
                color,
                forceColor,
                whiteFlash,
                clips,
                stencilRef,
                depth,
                depthTest,
                depthWrite,
                depthFunc,
                indexVariant: INDEX_VARIANT,
                strokeViewport,
            });
        };
        const GET_PART_POSE = (id) => {
            ASSERT_PLAYER();
            if (!PART_INDICES.has(id)) {
                throw new TypeError(`Unknown vector part: ${id}`);
            }
            const INDEX = PART_INDICES.get(id),
                EFFECTIVE = WORLD_MATRICES().parts[INDEX];
            return {
                ...currentPose.get(id),
                visible: EFFECTIVE.visible,
                transform: EFFECTIVE.transform.slice(),
            };
        };
        const DISPOSE_PLAYER = () => {
            if (playerDisposed) {
                return false;
            }
            for (const { timeline: TIMELINE } of TIMELINES.values()) {
                TIMELINE.pause();
            }
            TIMELINES.clear();
            PLAYERS.delete(PLAYER);
            playerDisposed = true;
            return true;
        };
        const PLAYER = Object.freeze({
            seek: SEEK,
            play: PLAY,
            transitionTo: TRANSITION_TO,
            setExpression: SET_EXPRESSION,
            setPartVisible: SET_PART_VISIBLE,
            setBasePose: SET_BASE_POSE,
            getPartPose: GET_PART_POSE,
            getSocket: GET_SOCKET,
            partPoses: PART_POSES,
            draw: DRAW,
            dispose: DISPOSE_PLAYER,
            get currentClip() {
                return rootPlayback.kind === 'clip' ? rootPlayback.name : rootPlayback.to.name;
            },
            get currentExpression() {
                return expression;
            },
            get currentTimeMs() {
                return displayTimeMs;
            },
            get disposed() {
                return playerDisposed;
            },
        });
        PLAYERS.add(PLAYER);
        SEEK(startedAtMs);
        return PLAYER;
    };
    const DISPOSE = () => {
        if (disposed) {
            return false;
        }
        for (const PLAYER of [...PLAYERS]) {
            PLAYER.dispose();
        }
        if (MESH) {
            meshRenderer.deleteMesh(MESH);
        }
        for (const SURFACE of RETAINED_SURFACES) {
            surfaceRenderer.deleteSurface(SURFACE);
        }
        disposed = true;
        return true;
    };
    return Object.freeze({
        id: METADATA.id,
        sourceSha256: compiledAsset.sourceSha256,
        schemaVersion: compiledAsset.schemaVersion,
        compilerVersion: compiledAsset.compilerVersion,
        viewBox: Object.freeze([...compiledAsset.viewBox]),
        metadata: METADATA,
        mesh: MESH,
        surfaces: Object.freeze(RETAINED_SURFACES),
        createPlayer: CREATE_PLAYER,
        dispose: DISPOSE,
        get disposed() {
            return disposed;
        },
        get playerCount() {
            return PLAYERS.size;
        },
    });
}

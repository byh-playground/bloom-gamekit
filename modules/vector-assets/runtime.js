import { createTimeline } from 'animejs/timeline';
import { validateCompiledAsset } from './schema.js';
import { compilePoseChannels, samplePartTransform, samplePoseChannels } from './pose-channels.js';
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
const NOW = () => globalThis.performance?.now?.() ?? null;
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

/** Owns one retained GPU mesh; its actors own only independent pose/timeline state. */
function retainVectorAsset(meshRenderer, compiledAsset) {
    if (!meshRenderer?.createMesh || !meshRenderer?.drawMesh || !meshRenderer?.deleteMesh) {
        throw new TypeError('A GameKit MeshRenderer is required');
    }
    validateCompiledAsset(compiledAsset);
    const METADATA = compiledAsset.metadata;
    const SKETCH_MORPH_STYLE = METADATA.styles?.find((style) => style.kind === 'sketch') ?? null;
    const PART_INDICES = new Map(METADATA.parts.map((part, index) => [part.id, index]));
    const CLIPS = METADATA.clips;
    const OPACITY_CLIPS = new Set(
        Object.entries(CLIPS)
            .filter(([, definition]) =>
                definition.keyframes.some((frame) =>
                    Object.values(frame.parts).some((pose) => Object.hasOwn(pose, 'opacity')),
                ),
            )
            .map(([name]) => name),
    );
    const POSE_API =
        typeof meshRenderer.createPoseSource === 'function' &&
        typeof meshRenderer.createPoseInstance === 'function' &&
        typeof meshRenderer.preparePose === 'function' &&
        typeof meshRenderer.prepareCpuPose === 'function' &&
        typeof meshRenderer.deletePoseInstance === 'function' &&
        typeof meshRenderer.deletePoseSource === 'function';
    const GEOMETRY = compiledAsset.geometry;
    const POSE_PROGRAM = POSE_API ? compilePoseChannels(METADATA) : null;
    let mesh = null;
    let poseSource = null;
    try {
        mesh = GEOMETRY.vertices.length ? meshRenderer.createMesh(GEOMETRY) : null;
        poseSource = POSE_PROGRAM ? meshRenderer.createPoseSource(POSE_PROGRAM) : null;
    } catch (error) {
        if (mesh) {
            meshRenderer.deleteMesh(mesh);
        }
        if (poseSource) {
            meshRenderer.deletePoseSource(poseSource);
        }
        throw error;
    }
    const ACTORS = new Set();
    let disposed = false;
    const REQUIRE_READY = () => {
        if (disposed) {
            throw new Error('Vector asset is disposed');
        }
    };
    const CREATE_ACTOR = ({ clip = Object.keys(CLIPS)[0], startedAtMs = 0 } = {}, release = null) => {
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
        let soughtPlaybackRevision = -1;
        let sampledTimeMs = NaN;
        let poseRevision = 0;
        let resolvedRevision = -1;
        let resolvedPose = null;
        let preparedPose = null;
        // The matrix cache belongs to this actor; public pose results remain detached.
        // Reuse its map instead of allocating another world-map on each lazy sample.
        const RESOLVED_MATRICES = new Map();
        let actorDisposed = false;
        const POSE_INSTANCE = poseSource ? meshRenderer.createPoseInstance(poseSource) : null;
        const POSE_METRICS = {
            fullSamples: 0,
            fullSampleMs: 0,
            partialQueries: 0,
            partialParts: 0,
            partialSampleMs: 0,
            gpuPrepares: 0,
            cpuFallbacks: 0,
            preparedPoseCacheHits: 0,
        };
        const INVALIDATE_POSE = () => {
            poseRevision++;
            preparedPose = null;
        };
        const ASSERT_ACTOR = () => {
            REQUIRE_READY();
            if (actorDisposed) {
                throw new Error('Vector actor is disposed');
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
        const ACTIVE_CLIP = (playback, timeMs) => {
            if (playback.kind === 'clip') {
                return playback;
            }
            const ELAPSED = timeMs - playback.atMs;
            if (ELAPSED < 0 || (ELAPSED === 0 && playback.durationMs !== 0)) {
                return ACTIVE_CLIP(playback.from, timeMs);
            }
            if (playback.durationMs === 0 || ELAPSED >= playback.durationMs) {
                return ACTIVE_CLIP(playback.to, timeMs);
            }
            return null;
        };
        const GPU_CLIP = () => {
            const ACTIVE = ACTIVE_CLIP(rootPlayback, displayTimeMs);
            return ACTIVE && POSE_PROGRAM?.clips[ACTIVE.name]?.supported ? ACTIVE : null;
        };
        const HAS_OPACITY_CHANNEL = (playback, timeMs) => {
            if (playback.kind === 'clip') {
                return OPACITY_CLIPS.has(playback.name);
            }
            const ELAPSED = timeMs - playback.atMs;
            if (ELAPSED <= 0 && playback.durationMs !== 0) {
                return HAS_OPACITY_CHANNEL(playback.from, timeMs);
            }
            if (playback.durationMs === 0 || ELAPSED >= playback.durationMs) {
                return HAS_OPACITY_CHANNEL(playback.to, timeMs);
            }
            return HAS_OPACITY_CHANNEL(playback.from, timeMs) || HAS_OPACITY_CHANNEL(playback.to, timeMs);
        };
        const ENSURE_CURRENT_POSE = () => {
            if (sampledTimeMs !== displayTimeMs || sampledPlaybackRevision !== playbackRevision) {
                const START = NOW();
                currentPose = SAMPLE(rootPlayback, displayTimeMs);
                if (START !== null) {
                    POSE_METRICS.fullSampleMs += NOW() - START;
                }
                sampledTimeMs = displayTimeMs;
                sampledPlaybackRevision = playbackRevision;
                POSE_METRICS.fullSamples++;
            }
        };
        const SEEK = (timeMs) => {
            ASSERT_ACTOR();
            const NEXT_TIME_MS = FINITE_TIME(timeMs, 'displayTimeMs');
            if (NEXT_TIME_MS !== displayTimeMs || soughtPlaybackRevision !== playbackRevision) {
                displayTimeMs = NEXT_TIME_MS;
                soughtPlaybackRevision = playbackRevision;
                INVALIDATE_POSE();
            }
            return ACTOR;
        };
        const SET_EXPRESSION = (name) => {
            ASSERT_ACTOR();
            const VARIANT = METADATA.expressions[name];
            if (!VARIANT) {
                throw new TypeError(`Unknown vector expression: ${name}`);
            }
            if (name === expression && !visibilityOverridden) {
                return ACTOR;
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
            return ACTOR;
        };
        const SET_PART_VISIBLE = (id, isVisible) => {
            ASSERT_ACTOR();
            if (!PART_INDICES.has(id) || typeof isVisible !== 'boolean') {
                throw new TypeError('Known part id and boolean visibility required');
            }
            VISIBLE.set(id, isVisible);
            visibilityOverridden = true;
            INVALIDATE_POSE();
            return ACTOR;
        };
        const SET_BASE_POSE = (id, pose) => {
            ASSERT_ACTOR();
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
            }
            let changed = false;
            for (const [FIELD, VALUE] of Object.entries(pose)) {
                if (CURRENT[FIELD] !== VALUE) {
                    CURRENT[FIELD] = VALUE;
                    changed = true;
                }
            }
            if (changed) {
                INVALIDATE_POSE();
            }
            return ACTOR;
        };
        const PLAY = (name, atMs = displayTimeMs) => {
            ASSERT_ACTOR();
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
            ASSERT_ACTOR();
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
            ENSURE_CURRENT_POSE();
            const OUTPUT = RESOLVED_MATRICES;
            OUTPUT.clear();
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
        const PARTIAL_POSE = (id, activeClip) => {
            const START = NOW();
            const BASE_POSES = METADATA.parts.map((part) => BASE_POSE.get(part.id));
            const ELAPSED = displayTimeMs - activeClip.startedAtMs;
            const RESULT = samplePartTransform(
                POSE_PROGRAM,
                activeClip.name,
                ELAPSED,
                PART_INDICES.get(id),
                BASE_POSES,
            );
            let partId = id;
            let visible = true;
            let sampledParts = 0;
            while (partId !== null) {
                visible &&= VISIBLE.get(partId) !== false;
                sampledParts++;
                partId = METADATA.parts[PART_INDICES.get(partId)].parent;
            }
            POSE_METRICS.partialQueries++;
            POSE_METRICS.partialParts += sampledParts;
            if (START !== null) {
                POSE_METRICS.partialSampleMs += NOW() - START;
            }
            return { ...RESULT, visible };
        };
        const GET_SOCKET = (id) => {
            ASSERT_ACTOR();
            const SOCKET = METADATA.sockets[id];
            if (!SOCKET) {
                throw new TypeError(`Unknown vector socket: ${id}`);
            }
            const ACTIVE = GPU_CLIP();
            const MATRIX = ACTIVE
                ? PARTIAL_POSE(SOCKET.part, ACTIVE).transform
                : WORLD_MATRICES().matrices.get(SOCKET.part);
            return transformPoint(MATRIX, SOCKET.point);
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
            ASSERT_ACTOR();
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
        const VALIDATE_EXCLUSIONS = (excludeParts) => {
            if (excludeParts === null) {
                return 0;
            }
            if (!(excludeParts instanceof Set)) {
                throw new TypeError('excludeParts must be a Set of known part ids');
            }
            let excludedMask = 0;
            for (const PART_ID of excludeParts) {
                if (!PART_INDICES.has(PART_ID)) {
                    throw new TypeError(`Unknown vector part: ${PART_ID}`);
                }
                excludedMask |= 1 << PART_INDICES.get(PART_ID);
            }
            return excludedMask;
        };
        const PREPARE_POSE = ({ excludeParts = null } = {}) => {
            ASSERT_ACTOR();
            const EXCLUDED_MASK = VALIDATE_EXCLUSIONS(excludeParts);
            if (!POSE_INSTANCE) {
                return null;
            }
            const DEVICE = meshRenderer.device;
            const FRAME = DEVICE?.stats?.frame;
            const RESTORES = DEVICE?.stats?.restores ?? 0;
            const GPU_UNAVAILABLE = meshRenderer.poseRenderer?.gpuUnavailableReason ?? null;
            const CACHEABLE =
                Number.isSafeInteger(FRAME) &&
                (DEVICE?.state === undefined || DEVICE.state === 'ready') &&
                (meshRenderer.state === undefined || meshRenderer.state === 'ready');
            if (
                CACHEABLE &&
                preparedPose?.revision === poseRevision &&
                preparedPose.frame === FRAME &&
                preparedPose.restores === RESTORES &&
                preparedPose.gpuUnavailable === GPU_UNAVAILABLE &&
                preparedPose.excludedMask === EXCLUDED_MASK
            ) {
                POSE_METRICS.preparedPoseCacheHits++;
                return preparedPose.handle;
            }
            const CACHE_PREPARED = (handle) => {
                preparedPose =
                    CACHEABLE && handle
                        ? {
                              revision: poseRevision,
                              frame: FRAME,
                              restores: RESTORES,
                              gpuUnavailable: meshRenderer.poseRenderer?.gpuUnavailableReason ?? null,
                              excludedMask: EXCLUDED_MASK,
                              handle,
                          }
                        : null;
                return handle;
            };
            const MORPH = authoredMorph(SKETCH_MORPH_STYLE, displayTimeMs);
            const ACTIVE = GPU_CLIP();
            if (ACTIVE) {
                const HANDLE = meshRenderer.preparePose(POSE_INSTANCE, {
                    clipName: ACTIVE.name,
                    elapsedMs: displayTimeMs - ACTIVE.startedAtMs,
                    basePoses: METADATA.parts.map((part) => BASE_POSE.get(part.id)),
                    visible: METADATA.parts.map((part) => VISIBLE.get(part.id) !== false),
                    excluded: METADATA.parts.map((part) => excludeParts?.has(part.id) ?? false),
                    morph: MORPH,
                });
                if (HANDLE) {
                    POSE_METRICS.gpuPrepares++;
                    return CACHE_PREPARED(HANDLE);
                }
            }
            const RESOLVED = WORLD_MATRICES();
            const PARTS = RESOLVED.parts.map((pose, index) => ({
                transform: pose.transform,
                opacity: pose.opacity,
                visible: pose.visible && !excludeParts?.has(METADATA.parts[index].id),
            }));
            const ACTIVE_PLAYBACK = ACTIVE_CLIP(rootPlayback, displayTimeMs);
            const REASON = ACTIVE
                ? (meshRenderer.poseRenderer?.gpuUnavailableReason ?? 'gpuUnavailable')
                : ACTIVE_PLAYBACK
                  ? (POSE_PROGRAM.clips[ACTIVE_PLAYBACK.name]?.reason ?? 'unsupportedClip')
                  : 'transitionBlend';
            POSE_METRICS.cpuFallbacks++;
            return CACHE_PREPARED(meshRenderer.prepareCpuPose(POSE_INSTANCE, PARTS, MORPH, REASON));
        };
        const DRAW = ({
            projection,
            viewProjection,
            worldMatrix,
            matrix = IDENTITY,
            alpha = 1,
            color = [1, 1, 1, 1],
            paintRegions = null,
            forceColor = false,
            whiteFlash = false,
            clips = [],
            stencilRef = null,
            depth = 0,
            depthTest = false,
            depthWrite = false,
            depthFunc = 'lequal',
            depthWriteAlphaThreshold = null,
            strokeViewport = null,
            excludeParts = null,
            instances = null,
        } = {}) => {
            ASSERT_ACTOR();
            // With `instances` (silhouettes) the retained pose is drawn once per packed matrix, in one ordered batch.
            const SUBMIT = (options) =>
                instances
                    ? meshRenderer.drawMeshInstances(mesh, {
                          ...options,
                          matrices: instances.matrices,
                          count: instances.count,
                          prefixColor: instances.prefixColor,
                          prefixCount: instances.prefixCount,
                          forceColorPrefixCount: instances.forceColorPrefixCount,
                      })
                    : meshRenderer.drawMesh(mesh, options);
            VALIDATE_EXCLUSIONS(excludeParts);
            if (!mesh && paintRegions !== null) {
                throw new TypeError('This asset has no named mesh fills');
            }
            // Classifying triangles by alpha for the depth write needs ordinary CPU part poses, never a GPU pose.
            const ALPHA_DEPTH = depthWriteAlphaThreshold !== null;
            if (POSE_INSTANCE && !ALPHA_DEPTH) {
                const POSE = PREPARE_POSE({ excludeParts });
                if (POSE) {
                    const INDEX_VARIANT =
                        !visibilityOverridden && compiledAsset.geometry.expressionIndices?.[expression]
                            ? expression
                            : null;
                    const WORLD_MODE = viewProjection !== undefined || worldMatrix !== undefined;
                    SUBMIT({
                        ...(WORLD_MODE ? { viewProjection, worldMatrix } : { projection }),
                        matrix,
                        pose: POSE,
                        alpha,
                        color,
                        forceColor,
                        paintRegions,
                        whiteFlash,
                        clips,
                        stencilRef,
                        depth,
                        depthTest,
                        depthWrite,
                        depthFunc,
                        indexVariant: INDEX_VARIANT,
                        strokeViewport,
                        timeMs: displayTimeMs,
                    });
                    return;
                }
            }
            if (!POSE_INSTANCE || ALPHA_DEPTH) {
                meshRenderer.recordPoseFallback?.(ALPHA_DEPTH ? 'alphaDepthClassification' : 'uniformPose');
            }
            const RESOLVED = WORLD_MATRICES();
            const POSES = RESOLVED.parts.map((pose, index) => ({
                transform: pose.transform.slice(),
                opacity: pose.opacity,
                visible: pose.visible && !excludeParts?.has(METADATA.parts[index].id),
            }));
            const INDEX_VARIANT =
                !visibilityOverridden && compiledAsset.geometry.expressionIndices?.[expression] ? expression : null;
            const WORLD_MODE = viewProjection !== undefined || worldMatrix !== undefined;
            SUBMIT({
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
                paintRegions,
                whiteFlash,
                clips,
                stencilRef,
                depth,
                depthTest,
                depthWrite,
                depthFunc,
                depthWriteAlphaThreshold,
                indexVariant: INDEX_VARIANT,
                strokeViewport,
                timeMs: displayTimeMs,
            });
        };
        const GET_PART_POSE = (id) => {
            ASSERT_ACTOR();
            if (!PART_INDICES.has(id)) {
                throw new TypeError(`Unknown vector part: ${id}`);
            }
            const INDEX = PART_INDICES.get(id);
            const ACTIVE = GPU_CLIP();
            const EFFECTIVE = ACTIVE ? PARTIAL_POSE(id, ACTIVE) : WORLD_MATRICES().parts[INDEX];
            const AUTHORED = ACTIVE
                ? samplePoseChannels(POSE_PROGRAM, ACTIVE.name, displayTimeMs - ACTIVE.startedAtMs, INDEX)
                : currentPose.get(id);
            return {
                ...AUTHORED,
                visible: EFFECTIVE.visible,
                transform: EFFECTIVE.transform.slice(),
            };
        };
        const DISPOSE_ACTOR = () => {
            if (actorDisposed) {
                return false;
            }
            for (const { timeline: TIMELINE } of TIMELINES.values()) {
                TIMELINE.pause();
            }
            TIMELINES.clear();
            if (POSE_INSTANCE) {
                meshRenderer.deletePoseInstance(POSE_INSTANCE);
            }
            ACTORS.delete(ACTOR);
            actorDisposed = true;
            release?.();
            return true;
        };
        const ACTOR = Object.freeze({
            seek: SEEK,
            play: PLAY,
            transitionTo: TRANSITION_TO,
            setExpression: SET_EXPRESSION,
            setPartVisible: SET_PART_VISIBLE,
            setBasePose: SET_BASE_POSE,
            getPartPose: GET_PART_POSE,
            getSocket: GET_SOCKET,
            partPoses: PART_POSES,
            preparePose: PREPARE_POSE,
            draw: DRAW,
            dispose: DISPOSE_ACTOR,
            get currentClip() {
                return rootPlayback.kind === 'clip' ? rootPlayback.name : rootPlayback.to.name;
            },
            get currentExpression() {
                return expression;
            },
            get currentTimeMs() {
                return displayTimeMs;
            },
            get hasOpacityChannel() {
                return HAS_OPACITY_CHANNEL(rootPlayback, displayTimeMs);
            },
            get hasNonUnitBaseOpacity() {
                for (const POSE of BASE_POSE.values()) {
                    if (POSE.opacity < 1) {
                        return true;
                    }
                }
                return false;
            },
            get disposed() {
                return actorDisposed;
            },
            get poseMetrics() {
                return { ...POSE_METRICS };
            },
        });
        ACTORS.add(ACTOR);
        SEEK(startedAtMs);
        return ACTOR;
    };
    const DISPOSE = () => {
        if (disposed) {
            return false;
        }
        for (const ACTOR of [...ACTORS]) {
            ACTOR.dispose();
        }
        if (mesh) {
            meshRenderer.deleteMesh(mesh);
        }
        if (poseSource) {
            meshRenderer.deletePoseSource(poseSource);
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
        mesh: mesh,
        createActor: CREATE_ACTOR,
        ownsActor(actor) {
            return ACTORS.has(actor) && !actor.disposed;
        },
        dispose: DISPOSE,
        get disposed() {
            return disposed;
        },
        get actorCount() {
            return ACTORS.size;
        },
    });
}

// Every actor of one compiled SVG on one context shares that context's GPU mesh, pose source and yarn/sketch
// surfaces. The compiled object is the identity: the caller keeps the object it loaded and passes it again.
const SHARED_ASSETS = new WeakMap();

/**
 * Acquires the context's shared GPU resources for `compiledAsset`, creating them for the first holder. `release`
 * returns this reference; the last release frees the resources. `context.dispose()` frees whatever is left.
 */
export function acquireVectorAsset(context, compiledAsset) {
    if (!context?.acquireMeshRenderer || !context?.onDispose) {
        throw new TypeError('A GameKit VectorContext is required');
    }
    let table = SHARED_ASSETS.get(context);
    if (!table) {
        table = new Map();
        SHARED_ASSETS.set(context, table);
        const TABLE = table;
        context.onDispose(() => {
            const ENTRIES = [...TABLE.values()];
            TABLE.clear();
            for (const ENTRY of ENTRIES) {
                ENTRY.asset.dispose();
            }
        });
    }
    let entry = table.get(compiledAsset);
    if (!entry) {
        entry = {
            asset: retainVectorAsset(context.acquireMeshRenderer(), compiledAsset),
            refs: 0,
        };
        table.set(compiledAsset, entry);
    }
    entry.refs++;
    const ENTRY = entry,
        TABLE = table;
    let released = false;
    return {
        asset: ENTRY.asset,
        release() {
            if (released) {
                return false;
            }
            released = true;
            if (--ENTRY.refs === 0 && TABLE.get(compiledAsset) === ENTRY) {
                TABLE.delete(compiledAsset);
                ENTRY.asset.dispose();
            }
            return true;
        },
    };
}

/** Creates an independent actor (clip, expression and part-pose state) of a compiled SVG on the context. */
export function createVectorActor(context, compiledAsset, options = {}) {
    const { asset: ASSET, release: RELEASE } = acquireVectorAsset(context, compiledAsset);
    try {
        return ASSET.createActor(options, RELEASE);
    } catch (error) {
        RELEASE();
        throw error;
    }
}

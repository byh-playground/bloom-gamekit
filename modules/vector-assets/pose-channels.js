// Numeric pose program shared by CPU sampling and the WebGL 2 pose texture.
// All offsets in data and clip headers count RGBA texels, not float components.
const FIELDS = Object.freeze(['x', 'y', 'rotation', 'scaleX', 'scaleY', 'opacity']);
const DEFAULTS = Object.freeze([0, 0, 0, 1, 1, 1]);
const EASE_CODES = Object.freeze({ linear: 0, inOutSine: 1, outQuad: 2 });
const MAX_SEGMENTS = 64;

function requireFinite(value, label) {
    if (!Number.isFinite(value)) {
        throw new TypeError(`${label} must be finite`);
    }
    return value;
}

function fitsFloat32(value) {
    return Number.isFinite(Math.fround(value));
}

function requirePartIndex(program, partIndex) {
    if (!Number.isInteger(partIndex) || partIndex < 0 || partIndex >= program.partCount) {
        throw new RangeError(`Invalid vector part index: ${partIndex}`);
    }
}

function requireClip(program, clipName) {
    const CLIP = program.clips[clipName];
    if (!CLIP) {
        throw new TypeError(`Unknown vector clip: ${clipName}`);
    }
    if (!CLIP.supported) {
        throw new Error(`Vector clip ${clipName} requires CPU timeline fallback: ${CLIP.reason}`);
    }
    return CLIP;
}

function localTime(clip, elapsedMs) {
    const ELAPSED = requireFinite(elapsedMs, 'elapsedMs');
    if (clip.loop === 'once') {
        return Math.min(clip.durationMs, Math.max(0, ELAPSED));
    }
    if (clip.loop === 'repeat') {
        return ((ELAPSED % clip.durationMs) + clip.durationMs) % clip.durationMs;
    }
    const CYCLE = clip.durationMs * 2;
    const POINT = ((ELAPSED % CYCLE) + CYCLE) % CYCLE;
    return POINT <= clip.durationMs ? POINT : CYCLE - POINT;
}

function easedAmount(code, fraction) {
    if (code === 1) {
        // Anime.js 4.5.0 composes inOutSine from its inSine and inOut functions.
        return fraction < 0.5
            ? (1 - Math.cos(fraction * 2 * (Math.PI / 2))) / 2
            : 1 - (1 - Math.cos((fraction * -2 + 2) * (Math.PI / 2))) / 2;
    }
    if (code === 2) {
        return 1 - (1 - fraction) * (1 - fraction);
    }
    return fraction;
}

function channelValue(data, headerTexel, timeMs) {
    const HEADER = headerTexel * 4;
    const FIRST = data[HEADER];
    const COUNT = data[HEADER + 1];
    let value = data[HEADER + 2];
    for (let segment = 0; segment < COUNT; segment++) {
        const OFFSET = (FIRST + segment * 2) * 4;
        const START = data[OFFSET + 2];
        const END = data[OFFSET + 3];
        if (timeMs < START) {
            break;
        }
        if (timeMs < END) {
            const FRACTION = (timeMs - START) / (END - START);
            return data[OFFSET] + (data[OFFSET + 1] - data[OFFSET]) * easedAmount(data[OFFSET + 4], FRACTION);
        }
        value = data[OFFSET + 1];
    }
    return value;
}

/** Compile SVG metadata into RGBA pose texels. Unsupported easings/long channels mark only their clip for fallback. */
export function compilePoseChannels(metadata) {
    if (
        !metadata ||
        !Array.isArray(metadata.parts) ||
        !metadata.parts.length ||
        metadata.parts.length > 16 ||
        !metadata.clips ||
        typeof metadata.clips !== 'object' ||
        Array.isArray(metadata.clips) ||
        !Object.keys(metadata.clips).length
    ) {
        throw new TypeError('Vector pose metadata requires parts and clips');
    }
    const PARTS = metadata.parts;
    const PART_COUNT = PARTS.length;
    const INDICES = new Map();
    for (let index = 0; index < PART_COUNT; index++) {
        const PART = PARTS[index];
        if (
            typeof PART?.id !== 'string' ||
            INDICES.has(PART.id) ||
            !Array.isArray(PART.pivot) ||
            PART.pivot.length !== 2
        ) {
            throw new TypeError(`Invalid vector part at index ${index}`);
        }
        requireFinite(PART.pivot[0], `part ${PART.id} pivot x`);
        requireFinite(PART.pivot[1], `part ${PART.id} pivot y`);
        if (!fitsFloat32(PART.pivot[0]) || !fitsFloat32(PART.pivot[1])) {
            throw new RangeError(`Part ${PART.id} pivot exceeds Float32 range`);
        }
        INDICES.set(PART.id, index);
    }
    const DATA = [];
    for (const PART of PARTS) {
        if (PART.parent !== null && !INDICES.has(PART.parent)) {
            throw new TypeError(`Unknown vector part parent: ${PART.parent}`);
        }
        DATA.push(PART.pivot[0], PART.pivot[1], PART.parent === null ? -1 : INDICES.get(PART.parent), 0);
    }
    for (let index = 0; index < PART_COUNT; index++) {
        const SEEN = new Set([index]);
        let parent = DATA[index * 4 + 2];
        while (parent !== -1) {
            if (SEEN.has(parent)) {
                throw new TypeError(`Vector part hierarchy contains a cycle: ${PARTS[index].id}`);
            }
            SEEN.add(parent);
            parent = DATA[parent * 4 + 2];
        }
    }

    const CLIPS = Object.create(null);
    let maxSegments = 0;
    for (const [NAME, CLIP] of Object.entries(metadata.clips)) {
        if (!CLIP || !Array.isArray(CLIP.keyframes) || CLIP.keyframes.length < 2) {
            throw new TypeError(`Clip ${NAME} requires at least two keyframes`);
        }
        const DURATION = requireFinite(CLIP.durationMs, `clip ${NAME} durationMs`);
        if (DURATION <= 0 || !['once', 'repeat', 'alternate'].includes(CLIP.loop)) {
            throw new TypeError(`Invalid clip duration or loop: ${NAME}`);
        }
        const FRAMES = CLIP.keyframes;
        let previousTime = -Infinity;
        for (const FRAME of FRAMES) {
            const TIME = requireFinite(FRAME?.timeMs, `clip ${NAME} keyframe timeMs`);
            if (TIME <= previousTime || !FRAME.parts || typeof FRAME.parts !== 'object' || Array.isArray(FRAME.parts)) {
                throw new TypeError(`Invalid clip keyframe: ${NAME}`);
            }
            for (const [PART_ID, POSE] of Object.entries(FRAME.parts)) {
                if (!INDICES.has(PART_ID) || !POSE || typeof POSE !== 'object' || Array.isArray(POSE)) {
                    throw new TypeError(`Invalid clip part pose: ${NAME}/${PART_ID}`);
                }
                if (!Object.keys(POSE).length) {
                    throw new TypeError(`Empty clip part pose: ${NAME}/${PART_ID}`);
                }
                for (const [FIELD, VALUE] of Object.entries(POSE)) {
                    if (!FIELDS.includes(FIELD)) {
                        throw new TypeError(`Unknown clip pose field: ${NAME}/${PART_ID}/${FIELD}`);
                    }
                    requireFinite(VALUE, `clip ${NAME}/${PART_ID}/${FIELD}`);
                    if (FIELD === 'opacity' && (VALUE < 0 || VALUE > 1)) {
                        throw new RangeError(`Clip part opacity must be in [0,1]: ${NAME}/${PART_ID}`);
                    }
                    if ((FIELD === 'scaleX' || FIELD === 'scaleY') && VALUE === 0) {
                        throw new RangeError(`Clip part scale cannot be zero: ${NAME}/${PART_ID}`);
                    }
                }
            }
            previousTime = TIME;
        }
        if (FRAMES[0].timeMs !== 0 || previousTime !== DURATION) {
            throw new RangeError(`Clip ${NAME} keyframes must span 0..durationMs`);
        }

        const CHANNELS = Array.from({ length: PART_COUNT * FIELDS.length }, (_, channelIndex) => ({
            initial:
                FRAMES[0].parts[PARTS[Math.floor(channelIndex / FIELDS.length)].id]?.[
                    FIELDS[channelIndex % FIELDS.length]
                ] ?? DEFAULTS[channelIndex % FIELDS.length],
            segments: [],
        }));
        let reason = null;
        if (!fitsFloat32(DURATION)) {
            reason = 'durationMs exceeds Float32 range';
        }
        for (let frameIndex = 1; frameIndex < FRAMES.length; frameIndex++) {
            const FRAME = FRAMES[frameIndex];
            const START = FRAMES[frameIndex - 1].timeMs;
            const CODE = EASE_CODES[FRAME.easing];
            for (const [PART_ID, POSE] of Object.entries(FRAME.parts)) {
                const PART_INDEX = INDICES.get(PART_ID);
                for (const [FIELD, TARGET] of Object.entries(POSE)) {
                    const CHANNEL = CHANNELS[PART_INDEX * FIELDS.length + FIELDS.indexOf(FIELD)];
                    if (CODE === undefined && reason === null) {
                        reason = `unsupported easing ${String(FRAME.easing)} at keyframe ${frameIndex}`;
                    }
                    if (CHANNEL.segments.length >= MAX_SEGMENTS && reason === null) {
                        reason = `channel ${PART_ID}.${FIELD} exceeds ${MAX_SEGMENTS} segments`;
                    }
                    const FROM = CHANNEL.segments.length ? CHANNEL.segments.at(-1)[1] : CHANNEL.initial;
                    CHANNEL.segments.push([FROM, TARGET, START, FRAME.timeMs, CODE]);
                }
            }
        }
        if (reason === null) {
            for (const CHANNEL of CHANNELS) {
                if (!fitsFloat32(CHANNEL.initial)) {
                    reason = 'initial pose value exceeds Float32 range';
                    break;
                }
                for (const [FROM, TARGET, START, END] of CHANNEL.segments) {
                    if (![FROM, TARGET, START, END].every(fitsFloat32)) {
                        reason = 'pose value or keyframe time exceeds Float32 range';
                        break;
                    }
                    if (Math.fround(END) <= Math.fround(START)) {
                        reason = 'keyframe interval collapses at Float32 precision';
                        break;
                    }
                }
                if (reason !== null) {
                    break;
                }
            }
        }
        if (reason !== null) {
            CLIPS[NAME] = { supported: false, reason, durationMs: DURATION, loop: CLIP.loop, headerBase: -1 };
            continue;
        }
        const HEADER_BASE = DATA.length / 4;
        const SEGMENT_BASE = HEADER_BASE + PART_COUNT * FIELDS.length;
        let nextSegment = SEGMENT_BASE;
        for (const CHANNEL of CHANNELS) {
            DATA.push(nextSegment, CHANNEL.segments.length, CHANNEL.initial, 0);
            nextSegment += CHANNEL.segments.length * 2;
            maxSegments = Math.max(maxSegments, CHANNEL.segments.length);
        }
        for (const CHANNEL of CHANNELS) {
            for (const [FROM, TARGET, START, END, CODE] of CHANNEL.segments) {
                DATA.push(FROM, TARGET, START, END, CODE, 0, 0, 0);
            }
        }
        CLIPS[NAME] = { supported: true, reason: null, durationMs: DURATION, loop: CLIP.loop, headerBase: HEADER_BASE };
    }
    return {
        partCount: PART_COUNT,
        partIds: PARTS.map((part) => part.id),
        data: Float32Array.from(DATA),
        cpuData: Float64Array.from(DATA),
        clips: CLIPS,
        maxSegments,
    };
}

/** Sample one part's authored local pose; elapsedMs is relative to the clip start. */
export function samplePoseChannels(program, clipName, elapsedMs, partIndex) {
    requirePartIndex(program, partIndex);
    const CLIP = requireClip(program, clipName);
    const TIME = localTime(CLIP, elapsedMs);
    const HEADER = CLIP.headerBase + partIndex * FIELDS.length;
    return Object.fromEntries(
        FIELDS.map((field, index) => [field, channelValue(program.cpuData, HEADER + index, TIME)]),
    );
}

/** Resolve only the requested part and its ancestors, including caller-owned base pose values. */
export function samplePartTransform(program, clipName, elapsedMs, partIndex, basePoses) {
    requirePartIndex(program, partIndex);
    const DATA = program.cpuData;
    const CHAIN = [];
    let index = partIndex;
    while (index !== -1) {
        CHAIN.push(index);
        index = DATA[index * 4 + 2];
    }
    let matrix = [1, 0, 0, 1, 0, 0];
    let opacity = 1;
    for (let chainIndex = CHAIN.length - 1; chainIndex >= 0; chainIndex--) {
        const PART_INDEX = CHAIN[chainIndex];
        const AUTHORED = samplePoseChannels(program, clipName, elapsedMs, PART_INDEX);
        const BASE = basePoses?.[PART_INDEX];
        const X = (BASE?.x ?? 0) + AUTHORED.x;
        const Y = (BASE?.y ?? 0) + AUTHORED.y;
        const ROTATION = (BASE?.rotation ?? 0) + AUTHORED.rotation;
        const SCALE_X = (BASE?.scaleX ?? 1) * AUTHORED.scaleX;
        const SCALE_Y = (BASE?.scaleY ?? 1) * AUTHORED.scaleY;
        const PX = DATA[PART_INDEX * 4];
        const PY = DATA[PART_INDEX * 4 + 1];
        const COSINE = Math.cos(ROTATION);
        const SINE = Math.sin(ROTATION);
        const A = COSINE * SCALE_X;
        const B = SINE * SCALE_X;
        const C = -SINE * SCALE_Y;
        const D = COSINE * SCALE_Y;
        const E = PX + X - A * PX - C * PY;
        const F = PY + Y - B * PX - D * PY;
        matrix = [
            matrix[0] * A + matrix[2] * B,
            matrix[1] * A + matrix[3] * B,
            matrix[0] * C + matrix[2] * D,
            matrix[1] * C + matrix[3] * D,
            matrix[0] * E + matrix[2] * F + matrix[4],
            matrix[1] * E + matrix[3] * F + matrix[5],
        ];
        opacity *= (BASE?.opacity ?? 1) * AUTHORED.opacity;
    }
    return { transform: matrix, opacity };
}

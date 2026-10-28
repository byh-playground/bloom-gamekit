/**
 * Frame clips over one region of the device's shared texture atlas; the region stays owned by the caller.
 * Frame x/y/width/height are top-left pixel coordinates inside the region's content rectangle.
 * sourceX/Y and sourceWidth/Height describe the trimmed image in its untrimmed
 * viewport; pivotX/Y are viewport pixels, defaulting to the top-left origin.
 * gutter is transparent padding OUTSIDE the frame rect and only validates region
 * bounds: UVs span the full content rect, without a half-texel shrink.
 * textureOrigin defaults to top-left for uploaded DOM sheets. Select
 * bottom-left for raw pixel data or GPU render targets whose first row is bottom.
 * Draws join the context's vector stream (VectorContext.drawQuads), so every sprite of any region shares
 * one draw with the shapes and text of the same blend and clip state.
 *
 * A player's timeMs is an absolute caller clock. Before startedAtMs it displays
 * the first frame. Loop clips wrap at their total duration; once clips hold their
 * final frame. seek(elapsedMs,timeMs) scrubs the clip at an absolute clock point;
 * pausing and rate changes anchor to that same clock without a phase jump.
 */
export function createSpriteAnimation(context, region, definition) {
    if (!context?.drawQuads || !context?.device?.textureAtlas) {
        throw new TypeError('A VectorContext is required');
    }
    if (!region?.atlas?.regions?.has(region) || region.atlas !== context.device.textureAtlas) {
        throw new TypeError('A live region of the device texture atlas is required');
    }
    const ATLAS_WIDTH = region.atlas.width;
    const ATLAS_HEIGHT = region.atlas.height;
    const REGION_WIDTH = region.width;
    const REGION_HEIGHT = region.height;
    const INPUT_FRAMES = definition?.frames;
    const INPUT_CLIPS = definition?.clips;
    const TEXTURE_ORIGIN = definition?.textureOrigin ?? 'top-left';
    if (TEXTURE_ORIGIN !== 'top-left' && TEXTURE_ORIGIN !== 'bottom-left') {
        throw new TypeError('textureOrigin must be top-left or bottom-left');
    }
    if (!Array.isArray(INPUT_FRAMES) || INPUT_FRAMES.length < 1 || INPUT_FRAMES.length > 4096) {
        throw new RangeError('Sprite animation requires 1..4096 atlas frames');
    }
    if (!INPUT_CLIPS || typeof INPUT_CLIPS !== 'object' || Array.isArray(INPUT_CLIPS)) {
        throw new TypeError('Named sprite clips are required');
    }
    const FRAMES = [];
    const FRAME_RECTS = [];
    const INTEGER = (value, name, minimum = 0) => {
        if (!Number.isSafeInteger(value) || value < minimum) {
            throw new TypeError(`${name} must be an integer >= ${minimum}`);
        }
    };
    for (let index = 0; index < INPUT_FRAMES.length; index++) {
        const FRAME = INPUT_FRAMES[index];
        const X = FRAME?.x;
        const Y = FRAME?.y;
        const WIDTH = FRAME?.width;
        const HEIGHT = FRAME?.height;
        const GUTTER = FRAME?.gutter ?? definition.gutter ?? 0;
        const SOURCE_WIDTH = FRAME?.sourceWidth ?? definition.sourceWidth ?? WIDTH;
        const SOURCE_HEIGHT = FRAME?.sourceHeight ?? definition.sourceHeight ?? HEIGHT;
        const SOURCE_X = FRAME?.sourceX ?? 0;
        const SOURCE_Y = FRAME?.sourceY ?? 0;
        const PIVOT_X = FRAME?.pivotX ?? definition.pivotX ?? 0;
        const PIVOT_Y = FRAME?.pivotY ?? definition.pivotY ?? 0;
        const DURATION_MS = FRAME?.durationMs;
        for (const [NAME, VALUE, MINIMUM] of [
            ['frame x', X, 0],
            ['frame y', Y, 0],
            ['frame width', WIDTH, 1],
            ['frame height', HEIGHT, 1],
            ['frame gutter', GUTTER, 0],
            ['source width', SOURCE_WIDTH, 1],
            ['source height', SOURCE_HEIGHT, 1],
            ['source x', SOURCE_X, 0],
            ['source y', SOURCE_Y, 0],
        ]) {
            INTEGER(VALUE, NAME, MINIMUM);
        }
        if (
            X - GUTTER < 0 ||
            Y - GUTTER < 0 ||
            X + WIDTH + GUTTER > REGION_WIDTH ||
            Y + HEIGHT + GUTTER > REGION_HEIGHT ||
            SOURCE_X + WIDTH > SOURCE_WIDTH ||
            SOURCE_Y + HEIGHT > SOURCE_HEIGHT
        ) {
            throw new RangeError('Sprite frame, its gutter, or its trim exceeds its region/source viewport');
        }
        if (!Number.isFinite(PIVOT_X) || !Number.isFinite(PIVOT_Y)) {
            throw new TypeError('Sprite pivot coordinates must be finite');
        }
        if (!Number.isFinite(DURATION_MS) || DURATION_MS <= 0 || DURATION_MS > 1_000_000_000) {
            throw new RangeError('Sprite frame durationMs must be positive and at most 1,000,000,000');
        }
        const LEFT = SOURCE_X - PIVOT_X;
        const TOP = SOURCE_Y - PIVOT_Y;
        // Rendered content is stored upside down: its first row is the region's bottom texture row.
        const BOTTOM_UP = TEXTURE_ORIGIN === 'bottom-left';
        const U0 = (region.x + X) / ATLAS_WIDTH;
        const V0 = BOTTOM_UP ? (region.y + REGION_HEIGHT - Y) / ATLAS_HEIGHT : (region.y + Y) / ATLAS_HEIGHT;
        const V_HEIGHT = (BOTTOM_UP ? -HEIGHT : HEIGHT) / ATLAS_HEIGHT;
        FRAME_RECTS.push(
            Object.freeze({
                localRect: Float32Array.of(LEFT, TOP, WIDTH, HEIGHT),
                uvRect: Float32Array.of(U0, V0, WIDTH / ATLAS_WIDTH, V_HEIGHT),
            }),
        );
        FRAMES.push(
            Object.freeze({
                index,
                x: X,
                y: Y,
                width: WIDTH,
                height: HEIGHT,
                sourceX: SOURCE_X,
                sourceY: SOURCE_Y,
                sourceWidth: SOURCE_WIDTH,
                sourceHeight: SOURCE_HEIGHT,
                pivotX: PIVOT_X,
                pivotY: PIVOT_Y,
                gutter: GUTTER,
                durationMs: DURATION_MS,
            }),
        );
    }
    const CLIPS = new Map();
    for (const [NAME, INPUT] of Object.entries(INPUT_CLIPS)) {
        if (!/^[A-Za-z_][A-Za-z0-9_.:-]{0,127}$/.test(NAME) || !INPUT || typeof INPUT !== 'object') {
            throw new TypeError('Valid named sprite clips are required');
        }
        if (!Array.isArray(INPUT.frames) || !INPUT.frames.length || INPUT.frames.length > 4096) {
            throw new RangeError('A sprite clip must reference 1..4096 frames');
        }
        const LOOP = INPUT.loop ?? 'loop';
        if (LOOP !== 'loop' && LOOP !== 'once') {
            throw new TypeError('Sprite clip loop must be loop or once');
        }
        let durationMs = 0;
        const ENDS = [];
        for (const INDEX of INPUT.frames) {
            INTEGER(INDEX, 'clip frame index');
            if (INDEX >= FRAMES.length) {
                throw new RangeError('Clip frame index exceeds atlas frame count');
            }
            durationMs += FRAMES[INDEX].durationMs;
            if (!Number.isFinite(durationMs) || durationMs > Number.MAX_SAFE_INTEGER) {
                throw new RangeError('Sprite clip duration exceeds safe milliseconds');
            }
            ENDS.push(durationMs);
        }
        CLIPS.set(
            NAME,
            Object.freeze({
                name: NAME,
                frames: Object.freeze([...INPUT.frames]),
                ends: Object.freeze(ENDS),
                loop: LOOP,
                durationMs,
            }),
        );
    }
    if (!CLIPS.size) {
        throw new TypeError('At least one sprite clip is required');
    }
    const PLAYERS = new Set();
    let disposed = false;
    const READY = () => {
        if (disposed) {
            throw new Error('Sprite animation disposed');
        }
    };
    const GET_CLIP = (name) => {
        const CLIP = CLIPS.get(name);
        if (!CLIP) {
            throw new TypeError('Known sprite clip required');
        }
        return CLIP;
    };
    const CLOCK = (value) => {
        if (!Number.isFinite(value)) {
            throw new TypeError('Finite absolute timeMs required');
        }
    };
    return Object.freeze({
        createPlayer({ clip = CLIPS.keys().next().value, startedAtMs = 0, rate = 1 } = {}) {
            READY();
            CLOCK(startedAtMs);
            if (!Number.isFinite(rate) || rate <= 0 || rate > 1000) {
                throw new RangeError('Sprite playback rate must be in (0,1000]');
            }
            let selectedClip = GET_CLIP(clip);
            let anchorMs = startedAtMs;
            let offsetMs = 0;
            let playbackRate = rate;
            let paused = false;
            let playerDisposed = false;
            const PLAYER_READY = () => {
                READY();
                if (playerDisposed) {
                    throw new Error('Sprite player disposed');
                }
            };
            const ELAPSED = (timeMs) => {
                PLAYER_READY();
                CLOCK(timeMs);
                const VALUE = Math.max(0, offsetMs + (paused ? 0 : (timeMs - anchorMs) * playbackRate));
                if (!Number.isFinite(VALUE)) {
                    throw new RangeError('Sprite elapsed time exceeds finite milliseconds');
                }
                return VALUE;
            };
            const PLAYER = Object.freeze({
                sample(timeMs) {
                    const ELAPSED_MS = ELAPSED(timeMs);
                    const TIME =
                        selectedClip.loop === 'loop'
                            ? ELAPSED_MS % selectedClip.durationMs
                            : Math.min(ELAPSED_MS, selectedClip.durationMs);
                    let slot = 0;
                    while (slot < selectedClip.ends.length - 1 && TIME >= selectedClip.ends[slot]) {
                        slot++;
                    }
                    const FRAME_INDEX = selectedClip.frames[slot];
                    return Object.freeze({
                        clip: selectedClip.name,
                        frameIndex: FRAME_INDEX,
                        frame: FRAMES[FRAME_INDEX],
                        elapsedMs: ELAPSED_MS,
                        finished: selectedClip.loop === 'once' && ELAPSED_MS >= selectedClip.durationMs,
                    });
                },
                /** options: matrix (composed with the context transform), color, alpha, whiteFlash, forceColor. */
                draw({ timeMs, ...options } = {}) {
                    const SAMPLE = this.sample(timeMs);
                    PLAYER_READY();
                    context.drawQuads({
                        ...options,
                        uvRects: FRAME_RECTS[SAMPLE.frameIndex].uvRect,
                        localRects: FRAME_RECTS[SAMPLE.frameIndex].localRect,
                        layer: region.layer,
                        filter: region.filter,
                    });
                    return SAMPLE;
                },
                seek(elapsedMs, timeMs) {
                    PLAYER_READY();
                    CLOCK(elapsedMs);
                    CLOCK(timeMs);
                    if (elapsedMs < 0) {
                        throw new RangeError('Sprite seek elapsedMs must be nonnegative');
                    }
                    offsetMs = elapsedMs;
                    anchorMs = timeMs;
                    return this;
                },
                setPaused(value, timeMs) {
                    PLAYER_READY();
                    if (typeof value !== 'boolean') {
                        throw new TypeError('Sprite paused state must be boolean');
                    }
                    const CURRENT = ELAPSED(timeMs);
                    offsetMs = CURRENT;
                    anchorMs = timeMs;
                    paused = value;
                    return this;
                },
                setRate(value, timeMs) {
                    PLAYER_READY();
                    if (!Number.isFinite(value) || value <= 0 || value > 1000) {
                        throw new RangeError('Sprite playback rate must be in (0,1000]');
                    }
                    const CURRENT = ELAPSED(timeMs);
                    offsetMs = CURRENT;
                    anchorMs = timeMs;
                    playbackRate = value;
                    return this;
                },
                setClip(name, timeMs) {
                    PLAYER_READY();
                    CLOCK(timeMs);
                    selectedClip = GET_CLIP(name);
                    offsetMs = 0;
                    anchorMs = timeMs;
                    return this;
                },
                dispose() {
                    if (playerDisposed) {
                        return false;
                    }
                    playerDisposed = true;
                    PLAYERS.delete(PLAYER);
                    return true;
                },
            });
            PLAYERS.add(PLAYER);
            return PLAYER;
        },
        stats() {
            return Object.freeze({
                frameCount: FRAMES.length,
                clipCount: CLIPS.size,
                playerCount: PLAYERS.size,
                retainedBytes: 0,
                textureOwned: false,
            });
        },
        dispose() {
            if (disposed) {
                return false;
            }
            disposed = true;
            PLAYERS.clear();
            return true;
        },
    });
}

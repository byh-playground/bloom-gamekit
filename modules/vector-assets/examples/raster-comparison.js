import { WebGLDevice, MeshRenderer, createSpriteAnimation } from '/dist/rendering.js';
import { createVectorRasterAtlas, createVectorSpriteAtlas } from '/dist/vector-assets.js';
import { createSeedScout, seedScout } from './seed-scout.js';

const BY_ID = (id) => document.getElementById(id);
const CANVAS = BY_ID('canvas');
const STAGE = BY_ID('stage');
const MODE_INPUT = BY_ID('mode');
const COUNT_INPUT = BY_ID('count');
const RESOLUTION_INPUT = BY_ID('resolution');
const CLIP_INPUT = BY_ID('clip');
const EXPRESSION_INPUT = BY_ID('expression');
const MIXED_INPUT = BY_ID('mixed');
const SAMPLE_INTERVAL_INPUT = BY_ID('sample-interval');
const PLAYBACK_RATE_INPUT = BY_ID('playback-rate');
const TIME_INPUT = BY_ID('time');
const ZOOM_INPUT = BY_ID('zoom');
const PLAY_BUTTON = BY_ID('play');
const STATUS = BY_ID('status');
const FRAME_METRICS = BY_ID('frame-metrics');
const BAKE_METRICS = BY_ID('bake-metrics');
const SPRITE_METRICS = BY_ID('sprite-metrics');
const PATH_METRICS = BY_ID('path-metrics');
const DEVICE = new WebGLDevice(CANVAS, { alpha: true, antialias: true });
const MESHES = new MeshRenderer(DEVICE, { maxMeshes: 4, maxInstances: 1024 });
const ASSET = createSeedScout(MESHES);
const VIEW_BOX = ASSET.viewBox;
let timer = createGpuTimer(DEVICE.gl);
let hardware = readHardware();
const STATE = {
    ready: false,
    playing: true,
    autoRender: true,
    timeMs: 0,
    previousFrameMs: null,
    atlas: null,
    atlasResolution: 0,
    bakeCpuMs: null,
    spriteSets: new Map(),
    spriteBakeCpuMs: null,
    spriteNeedsRebuild: false,
    frameOrdinal: 0,
    last: null,
    error: null,
    disposed: false,
    contextLost: false,
};
const PLAYERS = [];
let nextReadoutMs = 0;
let frameHandle = null;

function readHardware() {
    const GL = DEVICE.gl;
    const DEBUG = GL.getExtension('WEBGL_debug_renderer_info');
    return {
        backend: DEVICE.stats.backend ?? 'WebGL 2',
        renderer: GL.getParameter(DEBUG?.UNMASKED_RENDERER_WEBGL ?? GL.RENDERER),
        vendor: GL.getParameter(DEBUG?.UNMASKED_VENDOR_WEBGL ?? GL.VENDOR),
    };
}

function resetTimer() {
    if (!STATE.contextLost && !DEVICE.gl.isContextLost()) {
        timer.clearDisplay();
    }
}

function scheduleNextFrame() {
    if (STATE.autoRender && !STATE.disposed && frameHandle === null) {
        frameHandle = requestAnimationFrame(render);
    }
}

function setAutoRender(enabled) {
    STATE.autoRender = Boolean(enabled);
    STATE.previousFrameMs = null;
    if (!STATE.autoRender && frameHandle !== null) {
        cancelAnimationFrame(frameHandle);
        frameHandle = null;
    }
    scheduleNextFrame();
}

function createGpuTimer(gl) {
    const EXTENSION = gl.getExtension('EXT_disjoint_timer_query_webgl2');
    const PENDING = [];
    const COMPLETED = [];
    let lastMs = null;
    let lastLabel = null;
    let condition = EXTENSION ? '대기 중' : '지원하지 않음';
    let discardedCount = 0;
    let activeEntry = null;
    let evictedCount = 0;
    const DISCARD_DISJOINT = () => {
        discardedCount += PENDING.length + COMPLETED.length;
        COMPLETED.length = 0;
        for (const ENTRY of PENDING.splice(0)) {
            gl.deleteQuery(ENTRY.query);
        }
        lastMs = null;
        lastLabel = null;
        condition = '측정 무효 · GPU disjoint';
    };
    return {
        begin(label) {
            if (!EXTENSION || activeEntry || PENDING.length >= 6) {
                return null;
            }
            if (gl.getParameter(EXTENSION.GPU_DISJOINT_EXT)) {
                DISCARD_DISJOINT();
                return null;
            }
            const QUERY = gl.createQuery();
            if (!QUERY) {
                return null;
            }
            gl.beginQuery(EXTENSION.TIME_ELAPSED_EXT, QUERY);
            activeEntry = { query: QUERY, label };
            return activeEntry;
        },
        end(entry) {
            if (!entry) {
                return;
            }
            gl.endQuery(EXTENSION.TIME_ELAPSED_EXT);
            activeEntry = null;
            PENDING.push(entry);
        },
        poll() {
            if (!EXTENSION) {
                return this.result;
            }
            if (gl.getParameter(EXTENSION.GPU_DISJOINT_EXT)) {
                DISCARD_DISJOINT();
                return this.result;
            }
            while (PENDING.length && gl.getQueryParameter(PENDING[0].query, gl.QUERY_RESULT_AVAILABLE)) {
                const ENTRY = PENDING.shift();
                const GPU_MS = gl.getQueryParameter(ENTRY.query, gl.QUERY_RESULT) / 1e6;
                gl.deleteQuery(ENTRY.query);
                if (gl.getParameter(EXTENSION.GPU_DISJOINT_EXT)) {
                    discardedCount++;
                    DISCARD_DISJOINT();
                    return this.result;
                }
                lastMs = GPU_MS;
                lastLabel = ENTRY.label;
                COMPLETED.push({ ...ENTRY.label, gpuMs: GPU_MS });
                if (COMPLETED.length > 4096) {
                    COMPLETED.shift();
                    evictedCount++;
                }
                condition = '비동기 측정';
            }
            return this.result;
        },
        get result() {
            return {
                ms: lastMs,
                label: lastLabel,
                condition,
                pendingCount: PENDING.length,
                discardedCount,
                evictedCount,
            };
        },
        drain() {
            return COMPLETED.splice(0);
        },
        clearDisplay() {
            lastMs = null;
            lastLabel = null;
            condition = EXTENSION ? '대기 중' : '지원하지 않음';
        },
        reset() {
            if (activeEntry) {
                if (!gl.isContextLost()) {
                    gl.endQuery(EXTENSION.TIME_ELAPSED_EXT);
                }
                gl.deleteQuery(activeEntry.query);
                activeEntry = null;
            }
            for (const ENTRY of PENDING.splice(0)) {
                gl.deleteQuery(ENTRY.query);
            }
            COMPLETED.length = 0;
            lastMs = null;
            lastLabel = null;
            condition = EXTENSION ? '대기 중' : '지원하지 않음';
        },
        dispose() {
            this.reset();
        },
    };
}

function setStatus(message, error = false) {
    STATUS.textContent = message;
    STATUS.classList.toggle('error', error);
}

function phaseFor(index, clip) {
    if (index === 0) {
        return 0;
    }
    return Math.floor((((index * 73) % 997) / 997) * ASSET.metadata.clips[clip].durationMs);
}

function clipFor(index) {
    const CHOSEN = CLIP_INPUT.value;
    return MIXED_INPUT.checked && index % 2 ? (CHOSEN === 'idle' ? 'bounce' : 'idle') : CHOSEN;
}

function synchronizePlayers() {
    const COUNT = Number(COUNT_INPUT.value);
    while (PLAYERS.length > COUNT) {
        PLAYERS.pop().dispose();
    }
    while (PLAYERS.length < COUNT) {
        const INDEX = PLAYERS.length;
        const CLIP = clipFor(INDEX);
        const PLAYER = ASSET.createPlayer({ clip: CLIP, startedAtMs: -phaseFor(INDEX, CLIP) });
        PLAYER.setExpression(EXPRESSION_INPUT.value);
        PLAYERS.push(PLAYER);
    }
    for (let index = 0; index < PLAYERS.length; index++) {
        const PLAYER = PLAYERS[index];
        const CLIP = clipFor(index);
        if (PLAYER.currentClip !== CLIP) {
            PLAYER.play(CLIP, -phaseFor(index, CLIP));
        }
        if (PLAYER.currentExpression !== EXPRESSION_INPUT.value) {
            PLAYER.setExpression(EXPRESSION_INPUT.value);
        }
    }
}

function cameraLayout(side, width, height) {
    const THREE_WAY = MODE_INPUT.value === 'split3';
    const SPLIT = MODE_INPUT.value === 'split';
    const PANEL_WIDTH = THREE_WAY ? width / 3 : SPLIT ? width / 2 : width;
    const PANEL_X = THREE_WAY
        ? side === 'vector'
            ? 0
            : side === 'raster'
              ? width / 3
              : (width * 2) / 3
        : SPLIT && side === 'raster'
          ? width / 2
          : 0;
    const COUNT = PLAYERS.length;
    const COLUMNS = Math.max(1, Math.ceil(Math.sqrt((COUNT * PANEL_WIDTH) / Math.max(1, height))));
    const ROWS = Math.max(1, Math.ceil(COUNT / COLUMNS));
    const CELL = Math.min((PANEL_WIDTH - 16) / COLUMNS, (height - 16) / ROWS);
    const SIZE = Math.max(1, Math.min(CELL * 0.74, 180) * Number(ZOOM_INPUT.value));
    const SCALE = SIZE / Math.max(VIEW_BOX[2], VIEW_BOX[3]);
    const POSITIONS = new Array(COUNT);
    for (let i = 0; i < COUNT; i++) {
        const COLUMN = i % COLUMNS;
        const ROW = Math.floor(i / COLUMNS);
        const CENTER_X = PANEL_X + ((COLUMN + 0.5) * PANEL_WIDTH) / COLUMNS;
        const CENTER_Y = ((ROW + 0.5) * height) / ROWS;
        POSITIONS[i] = [
            SCALE,
            0,
            0,
            SCALE,
            CENTER_X - (VIEW_BOX[0] + VIEW_BOX[2] / 2) * SCALE,
            CENTER_Y - (VIEW_BOX[1] + VIEW_BOX[3] / 2) * SCALE,
        ];
    }
    return POSITIONS;
}

function synchronizeTimeControl() {
    const CLIP = ASSET.metadata.clips[CLIP_INPUT.value];
    const DURATION = CLIP.durationMs * (CLIP.loop === 'alternate' ? 2 : 1);
    const DISPLAY_TIME = CLIP.loop === 'once' ? Math.min(DURATION, STATE.timeMs) : STATE.timeMs % DURATION;
    TIME_INPUT.max = String(DURATION);
    TIME_INPUT.value = String(Math.max(0, Math.round(DISPLAY_TIME)));
    BY_ID('time-value').value = `${Math.round(DISPLAY_TIME)} / ${DURATION} ms`;
    BY_ID('zoom-value').value = `${Number(ZOOM_INPUT.value).toFixed(1)}×`;
    PLAY_BUTTON.textContent = STATE.playing ? '일시정지' : '재생';
    PLAY_BUTTON.setAttribute('aria-pressed', String(STATE.playing));
    STAGE.dataset.mode = MODE_INPUT.value;
}

function ensureAtlas() {
    const RESOLUTION = Number(RESOLUTION_INPUT.value);
    if (STATE.atlas && STATE.atlasResolution === RESOLUTION) {
        STATE.atlas.bake();
        return;
    }
    STATE.atlas?.dispose();
    STATE.atlas = null;
    STATE.atlasResolution = RESOLUTION;
    const STARTED = performance.now();
    let candidate = null;
    try {
        candidate = createVectorRasterAtlas(MESHES, ASSET, seedScout, {
            pixelsPerUnit: RESOLUTION / Math.max(VIEW_BOX[2], VIEW_BOX[3]),
            padding: 2,
            maxAtlasSize: Math.min(DEVICE.maxTextureSize, 8192),
            maxAtlasBytes: 128 * 1024 * 1024,
        });
        candidate.bake();
        STATE.atlas = candidate;
        STATE.bakeCpuMs = performance.now() - STARTED;
        setStatus(`같은 SVG ${ASSET.sourceSha256.slice(0, 12)} · 래스터 부위 그림 ${RESOLUTION}px`);
    } catch (error) {
        candidate?.dispose();
        STATE.bakeCpuMs = performance.now() - STARTED;
        setStatus(`래스터 굽기에 실패해 벡터로 표시합니다: ${error.message}`, true);
    }
}

function releaseSpriteSet(entry) {
    for (const PLAYER of entry.players.values()) {
        PLAYER.dispose();
    }
    entry.resource?.dispose();
    entry.baker?.dispose();
}

function clearSpriteSets() {
    for (const ENTRY of STATE.spriteSets.values()) {
        releaseSpriteSet(ENTRY);
    }
    STATE.spriteSets.clear();
}

function ensureSpriteSets() {
    if (STATE.spriteNeedsRebuild) {
        clearSpriteSets();
        STATE.spriteNeedsRebuild = false;
    }
    const REQUIRED = new Set(PLAYERS.map((player) => player.currentClip));
    for (const [KEY, ENTRY] of STATE.spriteSets) {
        if (!REQUIRED.has(ENTRY.clip) || ENTRY.key !== spriteKey(ENTRY.clip)) {
            releaseSpriteSet(ENTRY);
            STATE.spriteSets.delete(KEY);
        }
    }
    for (const CLIP of REQUIRED) {
        const KEY = spriteKey(CLIP);
        if (STATE.spriteSets.has(KEY)) {
            const ENTRY = STATE.spriteSets.get(KEY);
            if (!ENTRY.resource && ENTRY.baker) {
                try {
                    const RESULT = ENTRY.baker.bake();
                    if (ENTRY.baker.texture) {
                        ENTRY.resource = createSpriteAnimation(MESHES, ENTRY.baker.texture, ENTRY.baker.definition);
                        ENTRY.reason = null;
                    } else {
                        ENTRY.reason = RESULT?.reason ?? ENTRY.baker.stats?.reason ?? 'spriteUnavailable';
                    }
                } catch (error) {
                    ENTRY.reason = error.message;
                }
            }
            continue;
        }
        const STARTED = performance.now();
        let baker = null;
        let resource = null;
        let reason = null;
        try {
            const RESOLUTION = Number(RESOLUTION_INPUT.value);
            baker = createVectorSpriteAtlas(MESHES, ASSET, seedScout, {
                clip: CLIP,
                expression: EXPRESSION_INPUT.value,
                sampleIntervalMs: Number(SAMPLE_INTERVAL_INPUT.value),
                pixelsPerUnit: RESOLUTION / Math.max(VIEW_BOX[2], VIEW_BOX[3]),
                padding: 2,
                maxAtlasSize: Math.min(DEVICE.maxTextureSize, 8192),
                maxAtlasBytes: 128 * 1024 * 1024,
            });
            const RESULT = baker.bake();
            if (baker.texture && baker.definition) {
                resource = createSpriteAnimation(MESHES, baker.texture, baker.definition);
            } else {
                reason = RESULT?.reason ?? baker.stats?.reason ?? 'spriteUnavailable';
            }
        } catch (error) {
            reason = error.message;
            resource?.dispose();
            baker?.dispose();
            resource = null;
            baker = null;
        }
        STATE.spriteSets.set(KEY, {
            key: KEY,
            clip: CLIP,
            baker,
            resource,
            reason,
            players: new Map(),
            bakeCpuMs: performance.now() - STARTED,
        });
    }
}

function spriteKey(clip) {
    return JSON.stringify([
        ASSET.sourceSha256,
        clip,
        EXPRESSION_INPUT.value,
        Number(RESOLUTION_INPUT.value),
        Number(SAMPLE_INTERVAL_INPUT.value),
    ]);
}

function drawActors(side, positions, projection) {
    let rasterDraws = 0;
    let vectorFallbacks = 0;
    const REASONS = new Set();
    for (let i = 0; i < PLAYERS.length; i++) {
        const OPTIONS = { projection, matrix: positions[i] };
        if (side === 'vector') {
            PLAYERS[i].draw(OPTIONS);
            continue;
        }
        if (!STATE.atlas) {
            PLAYERS[i].draw(OPTIONS);
            vectorFallbacks++;
            REASONS.add('atlas unavailable');
            continue;
        }
        const RESULT = STATE.atlas.draw(PLAYERS[i], OPTIONS);
        if (RESULT.backend === 'raster') {
            rasterDraws++;
        } else {
            vectorFallbacks++;
            REASONS.add(RESULT.reason ?? 'vector fallback');
        }
    }
    return { rasterDraws, vectorFallbacks, reasons: [...REASONS] };
}

function drawSpriteActors(positions, projection) {
    let spriteDraws = 0;
    let vectorFallbacks = 0;
    const REASONS = new Set();
    const PIXELS_PER_UNIT = Number(RESOLUTION_INPUT.value) / Math.max(VIEW_BOX[2], VIEW_BOX[3]);
    for (let i = 0; i < PLAYERS.length; i++) {
        const VECTOR_PLAYER = PLAYERS[i];
        const ENTRY = STATE.spriteSets.get(spriteKey(VECTOR_PLAYER.currentClip));
        const OPTIONS = { projection, matrix: positions[i] };
        if (!ENTRY?.resource) {
            VECTOR_PLAYER.draw(OPTIONS);
            vectorFallbacks++;
            REASONS.add(ENTRY?.reason ?? 'spriteUnavailable');
            continue;
        }
        let spritePlayer = ENTRY.players.get(i);
        if (!spritePlayer) {
            spritePlayer = ENTRY.resource.createPlayer({
                clip: VECTOR_PLAYER.currentClip,
                startedAtMs: -phaseFor(i, VECTOR_PLAYER.currentClip),
            });
            ENTRY.players.set(i, spritePlayer);
        }
        const MATRIX = positions[i].slice();
        MATRIX[0] /= PIXELS_PER_UNIT;
        MATRIX[1] /= PIXELS_PER_UNIT;
        MATRIX[2] /= PIXELS_PER_UNIT;
        MATRIX[3] /= PIXELS_PER_UNIT;
        spritePlayer.draw({ timeMs: STATE.timeMs, projection, matrix: MATRIX });
        spriteDraws++;
    }
    return { spriteDraws, vectorFallbacks, reasons: [...REASONS] };
}

function writeMetrics(cpuMs, animationMs, submitMs, rasterResult, spriteResult) {
    BY_ID('part-label').textContent = rasterResult.vectorFallbacks
        ? `2 벡터 + 부위 텍스처 · 벡터 대체 ${rasterResult.vectorFallbacks}/${PLAYERS.length}`
        : '2 벡터 + 부위 텍스처';
    BY_ID('sprite-label').textContent = spriteResult.vectorFallbacks
        ? `3 텍스처 · 벡터 대체 ${spriteResult.vectorFallbacks}/${PLAYERS.length}`
        : '3 텍스처 · 전체 프레임';
    const POSES = MESHES.poseStats();
    const MESH_STATS = MESHES.stats();
    const ATLAS_STATS = STATE.atlas?.stats ?? null;
    const GPU = timer.result;
    const DEVICE_STATS = DEVICE.stats;
    const VECTOR_TRIANGLES =
        (seedScout.geometry.expressionIndices?.[EXPRESSION_INPUT.value]?.length ?? seedScout.geometry.indices.length) /
        3;
    const GPU_CURRENT =
        GPU.label?.mode === MODE_INPUT.value &&
        GPU.label?.count === PLAYERS.length &&
        GPU.label?.resolution === Number(RESOLUTION_INPUT.value) &&
        GPU.label?.sampleIntervalMs === Number(SAMPLE_INTERVAL_INPUT.value);
    const GPU_MS = GPU_CURRENT ? GPU.ms : null;
    const GPU_TEXT = GPU_MS === null ? GPU.condition : `${GPU_MS.toFixed(2)} ms (${GPU.condition})`;
    FRAME_METRICS.textContent =
        `CPU 전체 ${cpuMs.toFixed(2)} ms (동작 준비 ${animationMs.toFixed(2)} / 제출 ${submitMs.toFixed(2)} ms) · ` +
        `GPU ${GPU_TEXT} · 드로우 ${DEVICE_STATS.drawCalls}회 · ` +
        `버퍼 업로드 ${DEVICE_STATS.bufferBytes.toLocaleString()} B · 텍스처 업로드 ${DEVICE_STATS.textureBytes.toLocaleString()} B`;
    BAKE_METRICS.textContent = ATLAS_STATS
        ? `${RESOLUTION_INPUT.value}px / 큰 축 · 굽기 ${ATLAS_STATS.bakeCpuMs.toFixed(1)} ms (호출 벽시계 ${STATE.bakeCpuMs?.toFixed(1) ?? '—'} ms) · ` +
          `${ATLAS_STATS.runCount}개 부위 그림 · ${ATLAS_STATS.atlasWidth}×${ATLAS_STATS.atlasHeight} · ` +
          `${ATLAS_STATS.atlasBytes.toLocaleString()} B · 굽기 ${ATLAS_STATS.bakeCount}회`
        : `래스터 아틀라스를 사용할 수 없습니다 · 시도 ${STATE.bakeCpuMs?.toFixed(1) ?? '—'} ms`;
    const SPRITE_SETS = [...STATE.spriteSets.values()];
    const SPRITE_BYTES = SPRITE_SETS.reduce((sum, entry) => sum + (entry.baker?.stats?.atlasBytes ?? 0), 0);
    const SPRITE_FRAMES = SPRITE_SETS.reduce((sum, entry) => sum + (entry.baker?.stats?.frameCount ?? 0), 0);
    const SPRITE_BAKE_MS = SPRITE_SETS.reduce((sum, entry) => sum + entry.bakeCpuMs, 0);
    SPRITE_METRICS.textContent =
        `${SAMPLE_INTERVAL_INPUT.value}ms 간격 · ${SPRITE_FRAMES}프레임 · 처음 굽기 ${SPRITE_BAKE_MS.toFixed(1)} ms · ` +
        `아틀라스 ${SPRITE_BYTES.toLocaleString()} B · 프레임 선택 오차 최대 ${SAMPLE_INTERVAL_INPUT.value}ms · ` +
        `스프라이트 ${spriteResult.spriteDraws}개 / 벡터 대체 ${spriteResult.vectorFallbacks}개` +
        (spriteResult.reasons.length ? ` (${spriteResult.reasons.join(', ')})` : '');
    PATH_METRICS.textContent =
        `SVG SHA ${ASSET.sourceSha256.slice(0, 12)} · 래스터 ${rasterResult.rasterDraws}개 · 벡터 대체 ${rasterResult.vectorFallbacks}개` +
        (rasterResult.reasons.length ? ` (${rasterResult.reasons.join(', ')})` : '') +
        ` · GPU pose ${POSES?.gpuDrawInstances ?? 0}개 · CPU pose ${POSES?.cpuDrawInstances ?? 0}개 · ` +
        `GPU 버퍼 ${DEVICE_STATS.gpuBufferBytes.toLocaleString()} B · GPU 텍스처 ${DEVICE_STATS.gpuTextureBytes.toLocaleString()} B · ` +
        `메시 업로드 ${MESH_STATS.geometryBytesUploaded.toLocaleString()} B · ` +
        `선택 표정 벡터 ${VECTOR_TRIANGLES} 삼각형 / 부위 atlas ${ATLAS_STATS ? ATLAS_STATS.runCount * 2 : 0} 삼각형 · ` +
        `${hardware.backend} · ${hardware.renderer} · ${hardware.vendor}`;
    STATE.last = {
        frame: STATE.frameOrdinal,
        mode: MODE_INPUT.value,
        count: PLAYERS.length,
        clip: CLIP_INPUT.value,
        expression: EXPRESSION_INPUT.value,
        resolution: Number(RESOLUTION_INPUT.value),
        timeMs: STATE.timeMs,
        cpuMs,
        animationMs,
        submitMs,
        gpuMs: GPU_MS,
        gpuStatus: GPU.condition,
        gpuDiscardedCount: GPU.discardedCount,
        drawCalls: DEVICE_STATS.drawCalls,
        uploadedBytes: DEVICE_STATS.bufferBytes,
        textureBytes: DEVICE_STATS.textureBytes,
        atlas: ATLAS_STATS,
        bakeCpuMs: STATE.bakeCpuMs,
        poses: POSES,
        rasterResult,
        spriteResult,
        sprite: {
            sampleIntervalMs: Number(SAMPLE_INTERVAL_INPUT.value),
            quantizationMaxMs: Number(SAMPLE_INTERVAL_INPUT.value),
            frameCount: SPRITE_FRAMES,
            atlasBytes: SPRITE_BYTES,
            bakeCpuMs: SPRITE_BAKE_MS,
            sets: SPRITE_SETS.map((entry) => ({
                clip: entry.clip,
                reason: entry.reason,
                stats: entry.baker?.stats ?? null,
            })),
        },
        playbackRate: Number(PLAYBACK_RATE_INPUT.value),
        sourceTriangles: seedScout.geometry.indices.length / 3,
        vectorTriangles: VECTOR_TRIANGLES,
        rasterTriangles: ATLAS_STATS ? ATLAS_STATS.runCount * 2 : 0,
        backend: hardware.backend,
        renderer: hardware.renderer,
        vendor: hardware.vendor,
        canvasWidth: CANVAS.width,
        canvasHeight: CANVAS.height,
    };
}

function render(now) {
    frameHandle = null;
    if (STATE.disposed) {
        return;
    }
    if (STATE.contextLost || DEVICE.state === 'lost' || DEVICE.gl.isContextLost()) {
        STATE.contextLost = true;
        STATE.ready = false;
        STATE.previousFrameMs = null;
        setStatus('그래픽 화면을 복구하고 있습니다. 재생 시간은 멈춰 있습니다.');
        scheduleNextFrame();
        return;
    }
    if (DEVICE.state !== 'ready') {
        STATE.error = `그래픽 장치 상태: ${DEVICE.state}`;
        STATE.ready = false;
        setStatus(STATE.error, true);
        disposeComparison();
        return;
    }
    try {
        const STARTED = performance.now();
        timer.poll();
        if (STATE.previousFrameMs !== null && STATE.playing) {
            STATE.timeMs += Math.max(0, Math.min(80, now - STATE.previousFrameMs)) * Number(PLAYBACK_RATE_INPUT.value);
            const CLIP = ASSET.metadata.clips[CLIP_INPUT.value];
            if (CLIP.loop === 'once' && STATE.timeMs >= CLIP.durationMs) {
                STATE.timeMs = CLIP.durationMs;
                STATE.playing = false;
            }
        }
        STATE.previousFrameMs = now;
        synchronizePlayers();
        synchronizeTimeControl();
        const RECT = CANVAS.getBoundingClientRect();
        const DPR = Math.min(2, devicePixelRatio || 1);
        const CSS_WIDTH = Math.max(1, RECT.width);
        const CSS_HEIGHT = Math.max(1, RECT.height);
        const WIDTH = Math.max(1, Math.round(CSS_WIDTH * DPR));
        const HEIGHT = Math.max(1, Math.round(CSS_HEIGHT * DPR));
        const PROJECTION = [2 / CSS_WIDTH, 0, 0, 0, -2 / CSS_HEIGHT, 0, -1, 1, 1];
        DEVICE.beginFrame({ width: WIDTH, height: HEIGHT, clearColor: [0, 0, 0, 0] });
        MESHES.beginFrame();
        const MODE = MODE_INPUT.value;
        if (MODE === 'raster' || MODE === 'split' || MODE === 'split3') {
            ensureAtlas();
        }
        if (MODE === 'sprite' || MODE === 'split3') {
            ensureSpriteSets();
        }
        const QUERY = timer.begin({
            frame: ++STATE.frameOrdinal,
            mode: MODE_INPUT.value,
            count: PLAYERS.length,
            resolution: Number(RESOLUTION_INPUT.value),
            sampleIntervalMs: Number(SAMPLE_INTERVAL_INPUT.value),
        });
        const ANIMATION_START = performance.now();
        const VECTOR_PLAYERS =
            MODE === 'sprite'
                ? PLAYERS.filter((player) => !STATE.spriteSets.get(spriteKey(player.currentClip))?.resource)
                : PLAYERS;
        for (const PLAYER of VECTOR_PLAYERS) {
            PLAYER.seek(STATE.timeMs);
            PLAYER.preparePose();
        }
        if (VECTOR_PLAYERS.length) {
            MESHES.preparePoses();
        }
        const ANIMATION_MS = performance.now() - ANIMATION_START;
        const SUBMIT_START = performance.now();
        if (MODE === 'vector' || MODE === 'split' || MODE === 'split3') {
            drawActors('vector', cameraLayout('vector', CSS_WIDTH, CSS_HEIGHT), PROJECTION);
        }
        const RASTER_RESULT =
            MODE === 'raster' || MODE === 'split' || MODE === 'split3'
                ? drawActors('raster', cameraLayout('raster', CSS_WIDTH, CSS_HEIGHT), PROJECTION)
                : { rasterDraws: 0, vectorFallbacks: 0, reasons: [] };
        const SPRITE_RESULT =
            MODE === 'sprite' || MODE === 'split3'
                ? drawSpriteActors(cameraLayout('sprite', CSS_WIDTH, CSS_HEIGHT), PROJECTION)
                : { spriteDraws: 0, vectorFallbacks: 0, reasons: [] };
        MESHES.flush();
        const SUBMIT_MS = performance.now() - SUBMIT_START;
        timer.end(QUERY);
        DEVICE.endFrame();
        const CPU_MS = performance.now() - STARTED;
        if (!STATE.autoRender || now >= nextReadoutMs || !STATE.ready) {
            writeMetrics(CPU_MS, ANIMATION_MS, SUBMIT_MS, RASTER_RESULT, SPRITE_RESULT);
            nextReadoutMs = now + 250;
        }
        STATE.ready = true;
    } catch (error) {
        if (DEVICE.gl.isContextLost() || DEVICE.state === 'lost') {
            STATE.contextLost = true;
            STATE.ready = false;
            STATE.previousFrameMs = null;
            scheduleNextFrame();
            return;
        }
        STATE.ready = false;
        STATE.error = error.message;
        setStatus(error.message, true);
        console.error(error);
        disposeComparison();
    }
    scheduleNextFrame();
}

function disposeComparison() {
    if (STATE.disposed) {
        return false;
    }
    STATE.disposed = true;
    if (frameHandle !== null) {
        cancelAnimationFrame(frameHandle);
        frameHandle = null;
    }
    if (!STATE.contextLost && !DEVICE.gl.isContextLost()) {
        timer.dispose();
    }
    for (const PLAYER of PLAYERS.splice(0)) {
        PLAYER.dispose();
    }
    clearSpriteSets();
    STATE.atlas?.dispose();
    STATE.atlas = null;
    ASSET.dispose();
    MESHES.dispose();
    DEVICE.dispose();
    return true;
}

CANVAS.addEventListener('webglcontextlost', (event) => {
    event.preventDefault();
    STATE.contextLost = true;
    STATE.ready = false;
    STATE.previousFrameMs = null;
    setStatus('그래픽 화면을 복구하고 있습니다. 재생 시간은 멈춰 있습니다.');
});
CANVAS.addEventListener('webglcontextrestored', () => {
    setTimeout(() => {
        if (STATE.disposed || DEVICE.gl.isContextLost()) {
            return;
        }
        if (DEVICE.state !== 'ready' || MESHES.state !== 'ready') {
            STATE.error = '그래픽 화면을 복구하지 못했습니다.';
            STATE.ready = false;
            setStatus(STATE.error, true);
            disposeComparison();
            return;
        }
        timer = createGpuTimer(DEVICE.gl);
        hardware = readHardware();
        STATE.contextLost = false;
        STATE.previousFrameMs = null;
        STATE.atlasResolution = 0;
        STATE.spriteNeedsRebuild = true;
        setStatus('그래픽 화면을 복구했습니다.');
        scheduleNextFrame();
    }, 0);
});

MODE_INPUT.addEventListener('change', () => {
    resetTimer();
    synchronizeTimeControl();
});
COUNT_INPUT.addEventListener('change', () => {
    resetTimer();
    synchronizePlayers();
});
CLIP_INPUT.addEventListener('change', () => {
    resetTimer();
    STATE.timeMs = 0;
    synchronizePlayers();
    synchronizeTimeControl();
});
EXPRESSION_INPUT.addEventListener('change', () => {
    resetTimer();
    synchronizePlayers();
});
MIXED_INPUT.addEventListener('change', () => {
    resetTimer();
    synchronizePlayers();
});
RESOLUTION_INPUT.addEventListener('change', () => {
    resetTimer();
});
SAMPLE_INTERVAL_INPUT.addEventListener('change', resetTimer);
PLAYBACK_RATE_INPUT.addEventListener('change', resetTimer);
ZOOM_INPUT.addEventListener('input', () => {
    resetTimer();
    synchronizeTimeControl();
});
TIME_INPUT.addEventListener('input', () => {
    resetTimer();
    STATE.timeMs = Number(TIME_INPUT.value);
    STATE.playing = false;
    synchronizeTimeControl();
});
PLAY_BUTTON.addEventListener('click', () => {
    resetTimer();
    const CLIP = ASSET.metadata.clips[CLIP_INPUT.value];
    if (!STATE.playing && CLIP.loop === 'once' && STATE.timeMs >= CLIP.durationMs) {
        STATE.timeMs = 0;
    }
    STATE.playing = !STATE.playing;
    synchronizeTimeControl();
});
window.addEventListener('pagehide', disposeComparison, { once: true });

globalThis.__rasterComparison = {
    get ready() {
        return STATE.ready;
    },
    get error() {
        return STATE.error;
    },
    get snapshot() {
        return STATE.last;
    },
    dispose: disposeComparison,
    setAutoRender,
    pollGpuTimers() {
        return STATE.contextLost || DEVICE.gl.isContextLost() ? timer.result : timer.poll();
    },
    drainGpuSamples() {
        return timer.drain();
    },
    renderOnce({ timeMs } = {}) {
        setAutoRender(false);
        if (timeMs !== undefined) {
            if (!Number.isFinite(timeMs)) {
                throw new TypeError('Finite timeMs required');
            }
            STATE.timeMs = timeMs;
            STATE.playing = false;
        }
        render(performance.now());
        if (STATE.contextLost) {
            throw new Error('Graphics context is temporarily unavailable');
        }
        if (STATE.error) {
            throw new Error(STATE.error);
        }
        return STATE.last;
    },
    setMode(value) {
        MODE_INPUT.value = value;
        MODE_INPUT.dispatchEvent(new Event('change'));
    },
    setCount(value) {
        COUNT_INPUT.value = String(value);
        COUNT_INPUT.dispatchEvent(new Event('change'));
    },
    setTime(value) {
        TIME_INPUT.value = String(value);
        TIME_INPUT.dispatchEvent(new Event('input'));
    },
    setClip(value) {
        CLIP_INPUT.value = value;
        CLIP_INPUT.dispatchEvent(new Event('change'));
    },
    setExpression(value) {
        EXPRESSION_INPUT.value = value;
        EXPRESSION_INPUT.dispatchEvent(new Event('change'));
    },
    setResolution(value) {
        RESOLUTION_INPUT.value = String(value);
        RESOLUTION_INPUT.dispatchEvent(new Event('change'));
    },
    setSampleInterval(value) {
        SAMPLE_INTERVAL_INPUT.value = String(value);
        SAMPLE_INTERVAL_INPUT.dispatchEvent(new Event('change'));
    },
    setPlaybackRate(value) {
        PLAYBACK_RATE_INPUT.value = String(value);
        PLAYBACK_RATE_INPUT.dispatchEvent(new Event('change'));
    },
    setMixed(value) {
        MIXED_INPUT.checked = Boolean(value);
        MIXED_INPUT.dispatchEvent(new Event('change'));
    },
    setZoom(value) {
        ZOOM_INPUT.value = String(value);
        ZOOM_INPUT.dispatchEvent(new Event('input'));
    },
};
scheduleNextFrame();

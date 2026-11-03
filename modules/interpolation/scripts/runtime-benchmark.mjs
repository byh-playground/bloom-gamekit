// Informational microbenchmark for PresentationRuntime at crowd scale (not FPS): one delayed capture per 50 ms tick and
// three display frames sampling every entity, the shape a 1,000-troop farm sends (about 100 declared fields per body,
// a nested attack object, state keys). node modules/interpolation/scripts/runtime-benchmark.mjs [entities] [ticks]
// Optional: --dist <dir> to time another build (default ../../../dist); --frames <n> display frames per tick (default 3,
// 1 is a display slower than the tick rate, where every frame starts a new interval).
import { performance } from 'node:perf_hooks';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ARGS = process.argv.slice(2),
    DIST_AT = ARGS.indexOf('--dist'),
    DIST = DIST_AT >= 0 ? path.resolve(ARGS.splice(DIST_AT, 2)[1]) : null,
    FRAMES_AT = ARGS.indexOf('--frames'),
    FRAMES = FRAMES_AT >= 0 ? Number(ARGS.splice(FRAMES_AT, 2)[1]) : 3,
    [COUNT = 1000, TICKS = 120] = ARGS.map(Number);
const { PresentationRuntime: PRESENTATION_RUNTIME, RenderObject: R } = await import(
    DIST ? pathToFileURL(path.join(DIST, 'interpolation.js')).href : '../../../dist/interpolation.js'
);
const SCHEMA = {
    generation: R.STATE_KEY,
    x: R.POSITION_X,
    y: R.POSITION_Y,
    z: R.POSITION_Z,
    angle: R.ANGLE,
    flash: R.DECAY,
    phase: R.STATE_KEY,
};
for (let i = 0; i < 14; i++) {
    SCHEMA['linear' + i] = R.LINEAR;
}
for (let i = 0; i < 40; i++) {
    SCHEMA['step' + i] = R.STEP;
}
SCHEMA['ability.phase'] = R.STATE_KEY;
for (let i = 0; i < 12; i++) {
    SCHEMA['ability.progress' + i] = R.LINEAR;
    SCHEMA['ability.form' + i] = R.STEP;
}
SCHEMA.label = R.STEP;
class Body extends R {
    static renderSchema = Object.freeze(SCHEMA);
}
const SOURCES = Array.from({ length: COUNT }, () => {
    const BODY = new Body();
    BODY.ability = {};
    return BODY;
});
function update(tick) {
    for (let index = 0; index < COUNT; index++) {
        const B = SOURCES[index],
            T = tick + index * 0.01;
        B.generation = 0;
        B.x = Math.cos(T) * 10;
        B.y = Math.sin(T) * 10;
        B.z = 0;
        B.angle = T;
        B.flash = tick % 40 === index % 40 ? 0.1 : 0;
        B.phase = (tick + index) % 30 < 5 ? 'attack' : 'idle';
        for (let i = 0; i < 14; i++) {
            B['linear' + i] = T * i;
        }
        for (let i = 0; i < 40; i++) {
            B['step' + i] = i % 3 ? index + i : i % 2 === 0;
        }
        B.ability.phase = B.phase;
        for (let i = 0; i < 12; i++) {
            B.ability['progress' + i] = (T * 0.1 + i) % 1;
            B.ability['form' + i] = i;
        }
        B.label = 'body';
    }
}
const ENTITIES = SOURCES.map((source, index) => ({ id: 'u' + index, generation: 0, source }));
const RUNTIME = new PRESENTATION_RUNTIME({ stepMs: 50, delayMs: 50 });
let captureMs = 0,
    sampleMs = 0;
for (let tick = 0; tick < TICKS + 20; tick++) {
    update(tick);
    const MEASURE = tick >= 20,
        CAPTURE_START = performance.now();
    RUNTIME.capture(
        {
            revision: 0,
            sequence: tick,
            timeMs: tick * 50,
            mode: tick === 0 ? 'reset' : 'continuous',
            entities: ENTITIES,
        },
        tick * 50,
    );
    if (MEASURE) {
        captureMs += performance.now() - CAPTURE_START;
    }
    for (let frame = 0; frame < FRAMES; frame++) {
        const FRAME = RUNTIME.frame(tick * 50 + frame * Math.floor(50 / FRAMES)),
            SAMPLE_START = performance.now();
        for (const ENTITY of ENTITIES) {
            FRAME.sample(ENTITY.id, 0);
        }
        if (MEASURE) {
            sampleMs += performance.now() - SAMPLE_START;
        }
    }
}
console.log(
    JSON.stringify({
        runtime: process.version,
        entities: COUNT,
        fields: Object.keys(SCHEMA).length,
        captureMsPerTick: +(captureMs / TICKS).toFixed(3),
        framesPerTick: FRAMES,
        sampleMsPerFrame: +(sampleMs / TICKS / FRAMES).toFixed(3),
        scope: 'Node CPU only; not browser FPS, GPU, mobile, or renderer performance.',
    }),
);

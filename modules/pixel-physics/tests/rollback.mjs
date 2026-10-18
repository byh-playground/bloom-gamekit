// pixel-physics를 rollback SimulationAdapter로 감싸 deterministic의 syncTest로 검증합니다(Node, 브라우저 아님).
// 장면은 모래·물·돌기둥·강체·플레이어이며, 중간에 지형을 깎고 폭발시켜 붕괴·파편화·굳히기를 일으킵니다.
import assert from 'node:assert/strict';
import {
    Body,
    MatterBridge,
    PixelWorld,
    installDeterministicTrig,
    loadPixelWorld,
    savePixelWorld,
    validatePixelWorld,
} from '../index.js';
import { runSyncTest } from '../../deterministic/index.js';

installDeterministicTrig();
const TICKS = 400,
    CARVE_TICK = 20,
    EXPLODE_TICK = 150;

function createPlayer() {
    return new Body({ x: 20, y: 80, w: 3, h: 6 });
}

function createScene() {
    const WORLD = new PixelWorld(200, 120, { seed: 7 });
    WORLD.define({ name: 'stone', kind: 'solid', color: [110, 112, 122], strength: 50 });
    WORLD.define({ name: 'sand', kind: 'powder', density: 15, color: [222, 190, 110] });
    WORLD.define({ name: 'water', kind: 'liquid', density: 10, dispersion: 5, color: [60, 120, 220] });
    WORLD.rect(0, 100, 199, 119, 'stone');
    WORLD.rect(60, 70, 100, 74, 'stone');
    WORLD.rect(78, 74, 82, 100, 'stone');
    WORLD.paint(100, 30, 10, 'sand');
    WORLD.paint(40, 60, 8, 'water');
    // rollback은 임의 tick으로 되감으므로 접촉 쌍을 매 tick 비우는 checkpoint:1이 필요합니다.
    const BRIDGE = new MatterBridge({ checkpoint: 1 });
    WORLD.attachBridge(BRIDGE);
    const HANGING = BRIDGE.addBox({ x: 120, y: 20, w: 8, h: 8, density: 1 });
    BRIDGE.addJoint({ a: HANGING, ax: 0, ay: -4, bx: 120, by: 6, len: 10, stiff: 0.6 }); // 줄에 매달린 상자
    BRIDGE.addCircle({ x: 30, y: 10, r: 5, density: 0.5 });
    WORLD.enableCollapse({ minCells: 4, maxCells: 2000, interval: 10 });
    WORLD.addEntity(createPlayer());
    return WORLD;
}

function createAdapter(world) {
    return {
        save: () => savePixelWorld(world),
        load: (bytes) => loadPixelWorld(world, bytes, { createBody: createPlayer }),
        validateSnapshot: (bytes) => validatePixelWorld(world, bytes),
        step(context) {
            const MASK = context.inputs[0].input[0];
            world.bodies[0].input = {
                left: Boolean(MASK & 1),
                right: Boolean(MASK & 2),
                jump: Boolean(MASK & 4),
                down: false,
                up: false,
            };
            if (context.tick === CARVE_TICK) {
                world.carve(80, 88, 3);
            }
            if (context.tick === EXPLODE_TICK) {
                world.explode(120, 98, 9);
            }
            world.tick();
        },
    };
}

const WORLD = createScene(),
    EVENTS = {};
for (const TYPE of ['collapse', 'bake', 'fracture', 'explosion']) {
    WORLD.on(TYPE, () => (EVENTS[TYPE] = (EVENTS[TYPE] ?? 0) + 1));
}
const ADAPTER = createAdapter(WORLD);
const FRAMES = Array.from({ length: TICKS }, (_, tick) => ({
    tick,
    inputs: [{ playerId: 'p1', input: Uint8Array.of(tick % 90 < 40 ? 2 : tick % 90 < 50 ? 6 : 1) }],
}));

const SNAPSHOT = ADAPTER.save();
assert.ok(SNAPSHOT.length < 4 << 20, 'snapshot이 rollback 한도 4MiB 안이어야 합니다.');
assert.ok(ADAPTER.validateSnapshot(SNAPSHOT));
assert.ok(!ADAPTER.validateSnapshot(SNAPSHOT.subarray(0, 100)));
// 8틱 되감기: 모든 틱에서 저장 → 8틱 전 복원 → 재시뮬레이션 결과를 바이트로 비교합니다.
const RESULT = runSyncTest({
    adapter: ADAPTER,
    players: ['p1'],
    inputSize: 1,
    tickRate: 60,
    checkDistance: 8,
    maxSnapshotBytes: 4 << 20,
    frames: FRAMES,
});
assert.equal(RESULT.checkedTicks, TICKS);
for (const TYPE of ['collapse', 'fracture', 'bake', 'explosion']) {
    assert.ok(EVENTS[TYPE] > 0, TYPE + ' 장면이 실제로 일어나야 검증이 의미 있습니다.');
}
console.log(
    JSON.stringify({
        ticks: RESULT.tick,
        resimulated: RESULT.resimulatedTicks,
        snapshotBytes: SNAPSHOT.length,
        events: EVENTS,
    }),
);

// 다른 인스턴스 복원: 핸들·엔티티를 새로 만들어야 하는 경로(조인 중인 피어, 리플레이)를 검증합니다.
{
    const SOURCE = createScene(),
        SOURCE_ADAPTER = createAdapter(SOURCE),
        TARGET = new PixelWorld(200, 120, { seed: 7 });
    const SETUP = createScene();
    // 대상은 정의만 같고 객체는 하나도 없는 월드입니다.
    for (const NAME of ['stone', 'sand', 'water']) {
        TARGET.define(SETUP.mats[SETUP.id[NAME]]);
    }
    TARGET.attachBridge(new MatterBridge({ checkpoint: 1 }));
    TARGET.enableCollapse({ minCells: 4, maxCells: 2000, interval: 10 });
    const TARGET_ADAPTER = createAdapter(TARGET);
    for (let tick = 0; tick < 28; tick++) {
        SOURCE_ADAPTER.step({ tick, inputs: [{ input: FRAMES[tick].inputs[0].input }] });
    }
    // 복원 시점에 조인트와 마스크 강체(셀 집합)가 있어야 새 핸들 생성 경로를 지납니다.
    assert.ok(SOURCE.bridge.joints.length > 0 && SOURCE.bridge.bodies.some((h) => h.cells));
    TARGET_ADAPTER.load(SOURCE_ADAPTER.save());
    assert.deepEqual(TARGET_ADAPTER.save(), SOURCE_ADAPTER.save(), '복원 직후 바이트가 같아야 합니다.');
    for (let tick = 28; tick < 300; tick++) {
        const CONTEXT = { tick, inputs: [{ input: FRAMES[tick].inputs[0].input }] };
        SOURCE_ADAPTER.step(CONTEXT);
        TARGET_ADAPTER.step(CONTEXT);
        assert.deepEqual(
            TARGET_ADAPTER.save(),
            SOURCE_ADAPTER.save(),
            'tick ' + tick + '에서 두 인스턴스가 갈라졌습니다.',
        );
    }
    console.log('cross-instance ok, bodies:', SOURCE.bridge.bodies.length);
}

// 청크 sleep: 첫 틱에 반응 재료 유무를 확정하므로, 정지한 큰 월드는 바로 전 청크가 잠들어야 합니다.
{
    const WORLD = new PixelWorld(1280, 720, { seed: 1 });
    WORLD.define({ name: 'stone', kind: 'solid', color: [110, 112, 122] });
    WORLD.rect(0, 700, 1279, 719, 'stone');
    for (let tick = 0; tick < 30; tick++) {
        WORLD.tick();
    }
    assert.equal(WORLD.stats.active, 0, '정지한 월드의 활성 청크는 0이어야 합니다.');
    console.log('sleep warm-up ok, total chunks:', WORLD.stats.total);
}

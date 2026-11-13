import { InstanceLayer, PartList, RenderStats, RigidBatch, mergeShapes, warmUp } from '/dist/three-kit.js';

// three-kit은 three.js를 import하지 않고 받습니다. 게임처럼 예제가 고정한 버전을 불러와 넘깁니다(발배구와 같은 r180).
// 탭을 처음 열 때만 받습니다.
const THREE_URL = 'https://cdn.jsdelivr.net/npm/three@0.180.0/build/three.module.js';
const BODY_COUNT = 16;
const FEW = 48;
const MANY = 480;
const RING_RADIUS = 3.2;

// 딱딱한 물체 16개(상자·원기둥·구 섞임, 따로 움직임)는 RigidBatch 1 draw, 바닥 표시(고리·점·네모 섞임, 인스턴스마다 투명도)는
// InstanceLayer 1 draw입니다. 드로우콜은 물체·인스턴스·모양 수와 무관합니다.
function buildScene(three) {
    const SCENE = new three.Scene();
    SCENE.background = new three.Color(0x101923);
    SCENE.add(new three.HemisphereLight(0xdce8f1, 0x203040, 1.2));
    const SUN = new three.DirectionalLight(0xffffff, 1.6);
    SUN.position.set(3, 6, 4);
    SCENE.add(SUN);

    const BATCH = new RigidBatch(three);
    const PARTS = new PartList(three);
    const COLORS = [0xf2b84b, 0x8fd0ea, 0xe86f6f, 0x9fdc8a];
    for (let i = 0; i < BODY_COUNT; i++) {
        PARTS.body = BATCH.add();
        const COLOR = COLORS[i % COLORS.length];
        if (i % 3 === 0) {
            PARTS.box(0.6, 0.6, 0.6, COLOR);
            PARTS.box(0.3, 0.3, 0.3, 0xffffff, 0, 0.45, 0);
        } else if (i % 3 === 1) {
            PARTS.cylinder(0.3, 0.8, COLOR, 0, 0, 0, { top: 0.15 });
        } else {
            PARTS.sphere(0.35, COLOR);
            PARTS.box(0.5, 0.08, 0.08, 0x203040, 0, 0, 0.3);
        }
    }
    const MATERIAL = BATCH.glowMaterial(new three.MeshStandardMaterial({ vertexColors: true, roughness: 0.7 }));
    BATCH.mesh(PARTS.build(), MATERIAL);
    SCENE.add(BATCH.root);

    const MARKS = mergeShapes(three, {
        ring: new three.RingGeometry(0.16, 0.22, 24),
        dot: new three.CircleGeometry(0.1, 12),
        square: new three.PlaneGeometry(0.22, 0.22),
    });
    const LAYER = new InstanceLayer(three, { geometry: MARKS.geometry, capacity: MANY, side: three.DoubleSide });
    SCENE.add(LAYER.mesh);
    return { scene: SCENE, batch: BATCH, material: MATERIAL, marks: MARKS, layer: LAYER };
}

function countDraws(scene) {
    let draws = 0;
    scene.traverseVisible((object) => {
        if (object.isInstancedMesh) {
            draws += object.count > 0 ? 1 : 0;
        } else if (object.isMesh) {
            draws++;
        }
    });
    return draws;
}

export function startThreeKit(canvas, stats) {
    const EXAMPLE = {
        ready: false,
        drawCalls: 0,
        expectedDrawCalls: 0,
        programsAfterWarmUp: 0,
        programs: 0,
        instances: FEW,
        pause,
        resume,
        dispose,
    };
    const PLAY = document.querySelector('#three-play');
    const MORE = document.querySelector('#three-more');
    let playing = true;
    let frame = 0;
    let disposed = false;
    let world = null;
    let lastText = 0;

    PLAY.addEventListener('click', () => {
        playing = !playing;
        PLAY.setAttribute('aria-pressed', String(playing));
    });
    MORE.addEventListener('click', () => {
        EXAMPLE.instances = EXAMPLE.instances === FEW ? MANY : FEW;
        MORE.setAttribute('aria-pressed', String(EXAMPLE.instances === MANY));
    });

    import(THREE_URL).then((three) => {
        if (disposed) {
            return;
        }
        const RENDERER = new three.WebGLRenderer({ canvas, antialias: true });
        RENDERER.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
        RENDERER.setSize(canvas.width, canvas.height, false);
        const CAMERA = new three.PerspectiveCamera(45, canvas.width / canvas.height, 0.1, 50);
        CAMERA.position.set(0, 5.2, 8);
        CAMERA.lookAt(0, 0, 0);
        const PARTS = buildScene(three);
        const RENDER_STATS = new RenderStats(RENDERER);
        warmUp(RENDERER, PARTS.scene, CAMERA);
        world = {
            three,
            renderer: RENDERER,
            camera: CAMERA,
            stats: RENDER_STATS,
            ...PARTS,
            matrix: new three.Matrix4(),
            position: new three.Vector3(),
            quaternion: new three.Quaternion(),
            scale: new three.Vector3(),
            flat: new three.Quaternion().setFromAxisAngle(new three.Vector3(1, 0, 0), -Math.PI / 2),
            color: new three.Color(),
            time: 0,
            last: performance.now(),
        };
        EXAMPLE.programsAfterWarmUp = RENDERER.info.programs.length;
        EXAMPLE.renderer = RENDERER;
        EXAMPLE.ready = true;
        frame = requestAnimationFrame(tick);
    });

    function draw(w) {
        const { batch: BATCH, layer: LAYER, marks: MARKS, matrix: MATRIX, color: COLOR } = w;
        const T = w.time / 1000;
        for (let i = 0; i < BODY_COUNT; i++) {
            const ANGLE = (i / BODY_COUNT) * Math.PI * 2 + T * 0.3;
            const BONE = BATCH.bone(i);
            BONE.position.set(
                Math.cos(ANGLE) * RING_RADIUS,
                0.6 + Math.abs(Math.sin(T * 2 + i)) * 0.8,
                Math.sin(ANGLE) * RING_RADIUS,
            );
            BONE.rotation.set(T * (0.5 + (i % 4) * 0.3), T * (i % 2 ? 1 : -1), 0);
            BATCH.setGlow(i, i === Math.floor(T * 2) % BODY_COUNT ? 0.45 : 0);
        }
        const NAMES = ['ring', 'dot', 'square'];
        LAYER.begin();
        for (let i = 0; i < EXAMPLE.instances; i++) {
            const SPIRAL = i * 0.37;
            const RADIUS = 0.4 + ((i * 2.71) % 1) * (RING_RADIUS + 1.2);
            w.position.set(Math.cos(SPIRAL) * RADIUS, 0.01 + i * 0.00002, Math.sin(SPIRAL) * RADIUS);
            w.scale.setScalar(0.8 + (i % 5) * 0.15);
            MATRIX.compose(w.position, w.flat, w.scale);
            COLOR.setHSL((i * 0.061) % 1, 0.7, 0.62);
            const OPACITY = 0.15 + 0.85 * (0.5 + 0.5 * Math.sin(T * 2 + i * 0.5));
            LAYER.add(MATRIX, COLOR, OPACITY, MARKS.shapes[NAMES[i % NAMES.length]]);
        }
        LAYER.end();
    }

    function tick(now) {
        frame = requestAnimationFrame(tick);
        const W = world;
        if (playing) {
            W.time += Math.min(100, now - W.last);
        }
        W.last = now;
        draw(W);
        W.stats.begin();
        W.renderer.render(W.scene, W.camera);
        W.stats.end();
        EXAMPLE.drawCalls = W.renderer.info.render.calls;
        EXAMPLE.expectedDrawCalls = countDraws(W.scene);
        EXAMPLE.programs = W.renderer.info.programs.length;
        if (now - lastText > 250) {
            lastText = now;
            EXAMPLE.recentMaxDrawCalls = W.stats.snapshot().counts.drawCalls.max;
            stats.textContent = `드로우콜 ${EXAMPLE.drawCalls}(코드로 센 값 ${EXAMPLE.expectedDrawCalls}, 최근 최대 ${EXAMPLE.recentMaxDrawCalls}) · 물체 ${BODY_COUNT}개 · 바닥 표시 ${EXAMPLE.instances}개 · 셰이더 프로그램 ${EXAMPLE.programs}(미리 컴파일 ${EXAMPLE.programsAfterWarmUp})`;
        }
    }

    function pause() {
        cancelAnimationFrame(frame);
        frame = 0;
    }

    function resume() {
        if (world && !frame) {
            world.last = performance.now();
            frame = requestAnimationFrame(tick);
        }
    }

    function dispose() {
        disposed = true;
        pause();
        if (world) {
            world.layer.dispose();
            world.marks.geometry.dispose();
            world.batch.dispose();
            world.material.dispose();
            world.renderer.dispose();
        }
    }

    stats.textContent = 'three.js를 불러오는 중…';
    return EXAMPLE;
}

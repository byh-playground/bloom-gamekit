// three-kit 고정 시나리오(Node, GPU 없음): 게임이 만드는 그대로 배포물(dist/three-kit.js)에 저장소의 three.js(devDependencies)를
// 넘겨, (1) PartList로 물체 셋(그중 하나는 거울)을 RigidBatch에 묶은 geometry의 정점 수·물체 번호·삼각형 감김, (2) 일부 도형에만
// 물체 번호가 있으면 오류, (3) 실제 three 내장 셰이더 소스에 RigidBatch·InstanceLayer 주입이 들어가고 소비자 주입(extend)이 뒤따름,
// (4) 주입 대상이 없는 셰이더는 오류, (5) 인스턴스 레이어의 칸 넘침·빈 프레임을 확인합니다. 그리기·드로우콜은 미리보기 시나리오가 봅니다.
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { InstanceLayer, PartList, RigidBatch, mergeColored, mergeShapes, warmUp } from '../../../dist/three-kit.js';

const SHADER = (name) => ({
    uniforms: {},
    vertexShader: THREE.ShaderLib[name].vertexShader,
    fragmentShader: THREE.ShaderLib[name].fragmentShader,
});

// (1) 물체 셋: 상자(물체 0), 좌우 거울 상자(물체 1), 구(물체 2)
const BATCH = new RigidBatch(THREE);
const BODIES = [BATCH.add(), BATCH.add(), BATCH.add()];
const PARTS = new PartList(THREE);
PARTS.body = BODIES[0];
PARTS.box(1, 1, 1, 0xff0000);
PARTS.body = BODIES[1];
PARTS.box(1, 1, 1, 0x00ff00, 2, 0, 0, { scale: [-1, 1, 1] });
PARTS.body = BODIES[2];
PARTS.sphere(0.5, 0x0000ff, -2, 0, 0);
const BOX_VERTICES = new THREE.BoxGeometry(1, 1, 1).getAttribute('position').count;
const SPHERE_VERTICES = new THREE.SphereGeometry(0.5, 12, 10).getAttribute('position').count;
const GEOMETRY = PARTS.build();
const POSITION = GEOMETRY.getAttribute('position');
const NORMAL = GEOMETRY.getAttribute('normal');
const SKIN = GEOMETRY.getAttribute('skinIndex');
assert.equal(POSITION.count, BOX_VERTICES * 2 + SPHERE_VERTICES);
for (let i = 0; i < POSITION.count; i++) {
    const EXPECTED = i < BOX_VERTICES ? 0 : i < BOX_VERTICES * 2 ? 1 : 2;
    assert.equal(SKIN.getX(i), EXPECTED);
    assert.equal(GEOMETRY.getAttribute('skinWeight').getX(i), 1);
}
// 거울 상자도 삼각형 감김(반시계)이 바깥 법선과 같은 쪽이어야 앞면이 보입니다.
const [A, B, C, EDGE1, EDGE2, FACE] = Array.from({ length: 6 }, () => new THREE.Vector3());
const INDEX = GEOMETRY.index;
for (let i = 0; i < BOX_VERTICES * 3; i += 3) {
    const IA = INDEX.getX(i);
    A.fromBufferAttribute(POSITION, IA);
    B.fromBufferAttribute(POSITION, INDEX.getX(i + 1));
    C.fromBufferAttribute(POSITION, INDEX.getX(i + 2));
    FACE.crossVectors(EDGE1.subVectors(B, A), EDGE2.subVectors(C, A));
    assert.ok(FACE.dot(new THREE.Vector3().fromBufferAttribute(NORMAL, IA)) > 0, `삼각형 ${i / 3}의 감김`);
}
assert.ok(INDEX.count > BOX_VERTICES, '상자 둘 + 구의 삼각형');
const MATERIAL = BATCH.glowMaterial(new THREE.MeshStandardMaterial({ vertexColors: true }));
const MESH = BATCH.mesh(GEOMETRY, MATERIAL);
assert.ok(MESH.isSkinnedMesh && MESH.skeleton.bones.length === 3 && !MESH.frustumCulled);
assert.throws(() => BATCH.add(), /mesh\(\)를 만든 뒤/);

// (2) 일부 도형에만 물체 번호
const CUBE = new THREE.BoxGeometry(1, 1, 1);
assert.throws(() => mergeColored(THREE, [{ geometry: CUBE, body: 0 }, { geometry: CUBE }]), /body가 일부 도형에만/);

// (3) 실제 내장 셰이더에 주입
const STANDARD = SHADER('physical');
MATERIAL.onBeforeCompile(STANDARD);
assert.match(STANDARD.vertexShader, /uniform vec4 rigidGlow\[1\];[\s\S]*#include <skinbase_vertex>\n\tint rigidBody/);
assert.match(STANDARD.fragmentShader, /totalEmissiveRadiance = emissive \+ vec3\(vRigidGlow\)/);
BATCH.setGlow(BODIES[2], 0.5);
assert.equal(STANDARD.uniforms.rigidGlow.value[2], 0.5);

const MERGED = mergeShapes(THREE, {
    ring: new THREE.RingGeometry(0.3, 0.4, 16),
    dot: new THREE.CircleGeometry(0.1, 8),
});
assert.deepEqual(MERGED.shapes, { ring: 0, dot: 1 });
const INJECTED = [];
const LAYER = new InstanceLayer(THREE, {
    geometry: MERGED.geometry,
    capacity: 2,
    side: THREE.DoubleSide,
    extend: {
        key: 'mask',
        inject(shader) {
            INJECTED.push(shader.fragmentShader.includes('opacity * vInstanceOpacity'));
        },
    },
});
const BASIC = SHADER('basic');
LAYER.material.onBeforeCompile(BASIC);
assert.match(BASIC.vertexShader, /attribute float instanceShape;[\s\S]*abs\(aShape - instanceShape\) > 0\.5/);
assert.deepEqual(INJECTED, [true], '소비자 주입은 레이어 주입 뒤에 한 번');
assert.equal(LAYER.material.customProgramCacheKey(), 'three-kit-instance:shaped:blend:mask');

// (4) 주입 대상이 없으면 오류
assert.throws(
    () => LAYER.material.onBeforeCompile({ uniforms: {}, vertexShader: 'void main() {}', fragmentShader: '' }),
    /주입 대상 "#include <begin_vertex>"이 없습니다/,
);
assert.throws(
    () => MATERIAL.onBeforeCompile({ ...SHADER('basic'), uniforms: {} }),
    /주입 대상 "vec3 totalEmissiveRadiance = emissive;"이 없습니다/,
);

// (5) 칸 넘침·빈 프레임
const M = new THREE.Matrix4();
const WHITE = new THREE.Color(1, 1, 1);
LAYER.begin();
LAYER.add(M, WHITE, 0.5, MERGED.shapes.dot);
LAYER.add(M, WHITE, 1, MERGED.shapes.ring);
LAYER.add(M, WHITE, 1, MERGED.shapes.ring);
LAYER.end();
assert.equal(LAYER.mesh.count, 2);
assert.ok(LAYER.mesh.visible);
assert.deepEqual([...LAYER.fades], [0.5, 1]);
assert.deepEqual([...LAYER.shapes], [1, 0]);
LAYER.begin();
LAYER.end();
assert.equal(LAYER.mesh.count, 0);
assert.equal(LAYER.mesh.visible, false);
LAYER.dispose();
BATCH.dispose();

// (6) warmUp: 그리는 동안만 숨김·절두체 컬링·scissor를 바꾸고, 오류가 나도 렌더러 상태와 그리기 수를 되돌립니다.
const HIDDEN_MESH = new THREE.Mesh();
HIDDEN_MESH.visible = false;
const WARM_SCENE = new THREE.Scene().add(HIDDEN_MESH);
const INFO = { render: { frame: 7, calls: 3, triangles: 30, points: 0, lines: 0 } };
const SEEN = [];
const FAKE = (fail) => ({
    info: INFO,
    shadowMap: { needsUpdate: true },
    getRenderTarget: () => 'target',
    getActiveCubeFace: () => 2,
    getActiveMipmapLevel: () => 1,
    getScissor: (box) => box.copy({ x: 5, y: 6, z: 7, w: 8 }),
    getScissorTest: () => false,
    setRenderTarget: (...args) => SEEN.push(['target', ...args]),
    setScissor: (...args) => SEEN.push(['scissor', ...args]),
    setScissorTest: (on) => SEEN.push(['test', on]),
    compile: () => SEEN.push(['compile', HIDDEN_MESH.visible, HIDDEN_MESH.frustumCulled]),
    render: () => {
        SEEN.push(['render']);
        INFO.render.calls += 4;
        INFO.render.frame++;
        if (fail) {
            throw new Error('render 실패');
        }
    },
    clear: () => SEEN.push(['clear']),
});
for (const FAIL of [false, true]) {
    SEEN.length = 0;
    const CALL = () => warmUp(FAKE(FAIL), WARM_SCENE, new THREE.PerspectiveCamera());
    if (FAIL) {
        assert.throws(CALL, /render 실패/);
    } else {
        CALL();
    }
    assert.deepEqual(SEEN.slice(0, 4), [
        ['target', null],
        ['scissor', 0, 0, 1, 1],
        ['test', true],
        ['compile', true, false],
    ]);
    assert.deepEqual(SEEN.slice(-3), [
        ['scissor', 5, 6, 7, 8],
        ['test', false],
        ['target', 'target', 2, 1],
    ]);
    assert.equal(
        SEEN.some(([name]) => name === 'clear'),
        !FAIL,
        '오류가 없으면 그린 1픽셀을 지웁니다',
    );
    assert.equal(HIDDEN_MESH.visible, false);
    assert.equal(HIDDEN_MESH.frustumCulled, true);
    assert.deepEqual([INFO.render.calls, INFO.render.triangles], [3, 30], '준비용 그리기는 통계에 남지 않습니다');
}
assert.equal(INFO.render.frame, 9, '프레임 번호는 되돌리지 않습니다');
console.log(`three-kit scenario PASS (three r${THREE.REVISION})`);

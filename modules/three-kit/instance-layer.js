import { replaceShaderChunk } from './shader-chunk.js';

/**
 * 인스턴스마다 다른 투명도(instanceOpacity)를 알파에 곱하고, 모양 합본이면 인스턴스의 모양(instanceShape)이 아닌 정점을 한 점으로 접습니다.
 * three.js `InstancedMesh`에는 인스턴스 색(instanceColor)만 있고 인스턴스 투명도·모양 고르기가 없어서 이 두 가지만 기본 재질 셰이더에 더합니다.
 */
function injectInstanceData(shader, shaped) {
    shader.vertexShader = replaceShaderChunk(
        replaceShaderChunk(
            shader.vertexShader,
            'void main() {',
            `attribute float instanceOpacity;\nvarying float vInstanceOpacity;\n${
                shaped ? 'attribute float aShape;\nattribute float instanceShape;\n' : ''
            }void main() {`,
        ),
        '#include <begin_vertex>',
        `#include <begin_vertex>\n    vInstanceOpacity = instanceOpacity;${
            shaped ? '\n    if (abs(aShape - instanceShape) > 0.5) transformed = vec3(0.0);' : ''
        }`,
    );
    shader.fragmentShader = replaceShaderChunk(
        replaceShaderChunk(shader.fragmentShader, 'void main() {', 'varying float vInstanceOpacity;\nvoid main() {'),
        'vec4 diffuseColor = vec4( diffuse, opacity );',
        'vec4 diffuseColor = vec4( diffuse, opacity * vInstanceOpacity );',
    );
}

/**
 * 모양 여러 개를 한 geometry로 합칩니다(위치만). 정점마다 모양 번호(aShape)를 붙입니다.
 * 이 geometry로 만든 InstanceLayer는 add()의 shape 인자로 인스턴스마다 모양을 고르고, 모양이 몇 개든 1 draw입니다.
 * @param {object} three three.js 네임스페이스
 * @param {Record<string, object>} geometries 이름 → BufferGeometry. 입력은 바꾸지도 해제하지도 않습니다.
 * @returns {{ geometry: object, shapes: Record<string, number> }} shapes[이름]은 add()에 넘기는 모양 번호입니다.
 */
export function mergeShapes(three, geometries) {
    const POSITIONS = [],
        INDICES = [],
        SHAPE_OF = [],
        SHAPES = {};
    Object.keys(geometries).forEach((name, shape) => {
        const GEOMETRY = geometries[name],
            POSITION = GEOMETRY.getAttribute('position'),
            BASE = POSITIONS.length / 3;
        SHAPES[name] = shape;
        for (let i = 0; i < POSITION.count; i++) {
            POSITIONS.push(POSITION.getX(i), POSITION.getY(i), POSITION.getZ(i));
            SHAPE_OF.push(shape);
        }
        if (GEOMETRY.index) {
            for (let i = 0; i < GEOMETRY.index.count; i++) {
                INDICES.push(BASE + GEOMETRY.index.getX(i));
            }
        } else {
            for (let i = 0; i < POSITION.count; i++) {
                INDICES.push(BASE + i);
            }
        }
    });
    const MERGED = new three.BufferGeometry();
    MERGED.setAttribute('position', new three.Float32BufferAttribute(POSITIONS, 3));
    MERGED.setAttribute('aShape', new three.Float32BufferAttribute(SHAPE_OF, 1));
    MERGED.setIndex(INDICES);
    return { geometry: MERGED, shapes: SHAPES };
}

/**
 * 인스턴스 버퍼 한 벌을 three.js `InstancedMesh` 하나(1 draw)로 그립니다: 행렬 + 색 + 투명도(+ 모양).
 * 프레임마다 begin() → add()… → end()이고, 버퍼는 만들 때 한 번만 할당합니다.
 * 재질은 레이어가 만들어 소유하는 `MeshBasicMaterial`(흰색, 색은 인스턴스 색)입니다.
 */
export class InstanceLayer {
    /**
     * @param {object} three three.js 네임스페이스
     * @param {object} options
     * @param {object} options.geometry 그릴 모양. mergeShapes의 geometry면(aShape 속성) 인스턴스마다 모양을 고릅니다.
     *   정적 속성은 이 geometry와 공유하며, 레이어는 이 geometry를 해제하지 않습니다.
     * @param {number} options.capacity 한 프레임에 쓸 수 있는 인스턴스 수. 넘치는 add()는 그리지 않습니다.
     * @param {number} [options.side] THREE.FrontSide(기본)·DoubleSide·BackSide
     * @param {boolean} [options.opaque] 불투명(깊이를 쓰고 알파를 섞지 않음). 기본은 반투명
     * @param {boolean} [options.depthTest] false면 다른 물체에 가려지지 않는 겹쳐 그림
     * @param {number} [options.order] renderOrder
     * @param {{ key: string, inject: (shader: object) => void }} [options.extend] 소비자 셰이더 주입.
     *   inject는 이 레이어의 주입 뒤에 onBeforeCompile의 shader를 받고, key는 프로그램 캐시 키에 들어갑니다.
     */
    constructor(
        three,
        { geometry, capacity, side = three.FrontSide, opaque = false, depthTest = true, order = 0, extend } = {},
    ) {
        if (!geometry?.isBufferGeometry || !Number.isSafeInteger(capacity) || capacity < 1) {
            throw new TypeError('InstanceLayer: geometry(BufferGeometry)와 1 이상의 정수 capacity가 필요합니다');
        }
        if (extend !== undefined && (typeof extend.key !== 'string' || typeof extend.inject !== 'function')) {
            throw new TypeError('InstanceLayer: extend는 { key: string, inject(shader) }입니다');
        }
        const SHAPED = Boolean(geometry.getAttribute('aShape'));
        const MATERIAL = new three.MeshBasicMaterial({
            color: 0xffffff,
            transparent: !opaque,
            depthWrite: opaque,
            depthTest,
            side,
        });
        // 앞·뒷면이 둘 다 보이는 평면 입자는 한 번에 그립니다(그리는 순서는 인스턴스 순서).
        MATERIAL.forceSinglePass = true;
        MATERIAL.onBeforeCompile = (shader) => {
            injectInstanceData(shader, SHAPED);
            extend?.inject(shader);
        };
        MATERIAL.customProgramCacheKey = () =>
            `three-kit-instance:${SHAPED ? 'shaped' : 'plain'}:${opaque ? 'solid' : 'blend'}:${extend?.key ?? ''}`;
        // 정적 속성은 geometry와 공유하고, 인스턴스 속성은 레이어마다 따로 가집니다.
        const OWN = new three.BufferGeometry();
        for (const [NAME, ATTRIBUTE] of Object.entries(geometry.attributes)) {
            OWN.setAttribute(NAME, ATTRIBUTE);
        }
        if (geometry.index) {
            OWN.setIndex(geometry.index);
        }
        this.capacity = capacity;
        this.geometry = OWN;
        this.material = MATERIAL;
        this.mesh = new three.InstancedMesh(OWN, MATERIAL, capacity);
        this.mesh.instanceColor = new three.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
        this.opacity = new three.InstancedBufferAttribute(new Float32Array(capacity), 1);
        OWN.setAttribute('instanceOpacity', this.opacity);
        this.shape = SHAPED ? new three.InstancedBufferAttribute(new Float32Array(capacity), 1) : null;
        if (this.shape) {
            OWN.setAttribute('instanceShape', this.shape);
        }
        this.mesh.count = 0;
        this.mesh.visible = false;
        this.mesh.frustumCulled = false;
        this.mesh.renderOrder = order;
        this.matrices = this.mesh.instanceMatrix.array;
        this.colors = this.mesh.instanceColor.array;
        this.fades = this.opacity.array;
        this.shapes = this.shape?.array ?? null;
        this.count = 0;
    }

    begin() {
        this.count = 0;
    }

    /**
     * 인스턴스 하나를 씁니다. 칸이 가득 차면 넘치는 인스턴스는 그리지 않습니다.
     * @param {object} matrix THREE.Matrix4
     * @param {object} color THREE.Color
     * @param {number} opacity 0..1
     * @param {number} [shape] mergeShapes의 모양 번호(모양 합본일 때만)
     */
    add(matrix, color, opacity, shape = 0) {
        const I = this.count;
        if (I >= this.capacity) {
            return;
        }
        this.count = I + 1;
        matrix.toArray(this.matrices, I * 16);
        this.colors[I * 3] = color.r;
        this.colors[I * 3 + 1] = color.g;
        this.colors[I * 3 + 2] = color.b;
        this.fades[I] = opacity;
        if (this.shapes) {
            this.shapes[I] = shape;
        }
    }

    /** 쓴 칸까지만 GPU로 올립니다. 비어 있으면 그리지 않습니다(visible=false). */
    end() {
        const MESH = this.mesh,
            COUNT = this.count;
        MESH.count = COUNT;
        MESH.visible = COUNT > 0;
        if (COUNT === 0) {
            return;
        }
        const UPLOAD = (attribute) => {
            attribute.clearUpdateRanges();
            attribute.addUpdateRange(0, COUNT * attribute.itemSize);
            attribute.needsUpdate = true;
        };
        UPLOAD(MESH.instanceMatrix);
        UPLOAD(MESH.instanceColor);
        UPLOAD(this.opacity);
        if (this.shape) {
            UPLOAD(this.shape);
        }
    }

    /** 메시·레이어 geometry·재질을 해제하고 장면에서 뺍니다. 생성자에 넘긴 geometry는 소비자가 해제합니다. */
    dispose() {
        this.mesh.removeFromParent();
        this.mesh.dispose();
        this.geometry.dispose();
        this.material.dispose();
    }
}

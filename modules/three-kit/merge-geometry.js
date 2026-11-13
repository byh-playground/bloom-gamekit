/**
 * 같은 재질로 그릴 도형 여럿을 정점 색을 가진 geometry 하나로 합칩니다(1 draw).
 * 도형마다 변환(위치·회전·크기·부모 행렬)과 색을 받아 정점에 굽습니다. 색은 정점 색(color 속성)이므로 재질은 vertexColors 하나면 됩니다.
 * 정점 색은 재질 색과 같은 작업 색 공간(선형) 값이라 같은 hex를 재질 색으로 쓸 때와 화면이 같습니다.
 * three.js addon(BufferGeometryUtils)을 쓰지 않고 position·normal·color·index만 직접 합칩니다.
 * 선택 속성: 도형에 body(물체 번호)가 있으면 skinIndex·skinWeight를 달아 RigidBatch의 뼈 하나에 묶고,
 * uvRect가 있으면 원래 uv를 그 사각형(아틀라스 칸)으로 옮겨 uv를 만듭니다. 한 도형이라도 쓰면 모든 도형이 가져야 합니다.
 *
 * @param {object} three three.js 네임스페이스
 * @param {{ geometry: object, color?: number|object, matrix?: object, body?: number|Function, uvRect?: number[] }[]} parts
 *   geometry는 position(+normal)을 가진 BufferGeometry, color는 hex 또는 THREE.Color(기본 흰색), matrix는 THREE.Matrix4(기본 단위 행렬),
 *   body는 물체 번호 또는 (변환 전 도형 좌표 Vector3) => 물체 번호(정점마다 다른 뼈), uvRect는 [u0, v0, du, dv]
 * @returns {object} position·normal·color(+skinIndex·skinWeight, +uv) 속성과 index를 가진 BufferGeometry. 입력 geometry는 바꾸지도 해제하지도 않습니다.
 */
export function mergeColored(three, parts) {
    let vertexCount = 0,
        indexCount = 0;
    for (const { geometry: GEOMETRY } of parts) {
        const COUNT = GEOMETRY.getAttribute('position').count;
        vertexCount += COUNT;
        indexCount += GEOMETRY.index ? GEOMETRY.index.count : COUNT;
    }
    const POSITIONS = new Float32Array(vertexCount * 3),
        NORMALS = new Float32Array(vertexCount * 3),
        COLORS = new Float32Array(vertexCount * 3),
        INDICES = vertexCount > 65535 ? new Uint32Array(indexCount) : new Uint16Array(indexCount),
        SKINNED = optional(parts, 'body'),
        SKIN_INDEX = SKINNED ? new Uint16Array(vertexCount * 4) : null,
        SKIN_WEIGHT = SKINNED ? new Float32Array(vertexCount * 4) : null,
        UVS = optional(parts, 'uvRect') ? new Float32Array(vertexCount * 2) : null;
    const POINT = new three.Vector3(),
        NORMAL_MATRIX = new three.Matrix3(),
        PAINT = new three.Color();
    let vertexOffset = 0,
        indexOffset = 0;
    for (const { geometry: GEOMETRY, color: COLOR = 0xffffff, matrix: MATRIX, body: BODY, uvRect: UV_RECT } of parts) {
        const POSITION = GEOMETRY.getAttribute('position'),
            NORMAL = GEOMETRY.getAttribute('normal'),
            UV = GEOMETRY.getAttribute('uv'),
            COUNT = POSITION.count;
        PAINT.set(COLOR);
        if (MATRIX) {
            NORMAL_MATRIX.getNormalMatrix(MATRIX);
        }
        for (let i = 0; i < COUNT; i++) {
            const AT = (vertexOffset + i) * 3;
            POINT.fromBufferAttribute(POSITION, i);
            if (SKINNED) {
                SKIN_INDEX[(vertexOffset + i) * 4] = typeof BODY === 'function' ? BODY(POINT) : BODY;
                SKIN_WEIGHT[(vertexOffset + i) * 4] = 1;
            }
            if (UVS) {
                UVS[(vertexOffset + i) * 2] = UV_RECT[0] + UV.getX(i) * UV_RECT[2];
                UVS[(vertexOffset + i) * 2 + 1] = UV_RECT[1] + UV.getY(i) * UV_RECT[3];
            }
            if (MATRIX) {
                POINT.applyMatrix4(MATRIX);
            }
            POSITIONS[AT] = POINT.x;
            POSITIONS[AT + 1] = POINT.y;
            POSITIONS[AT + 2] = POINT.z;
            if (NORMAL) {
                POINT.fromBufferAttribute(NORMAL, i);
                if (MATRIX) {
                    POINT.applyMatrix3(NORMAL_MATRIX).normalize();
                }
                NORMALS[AT] = POINT.x;
                NORMALS[AT + 1] = POINT.y;
                NORMALS[AT + 2] = POINT.z;
            }
            COLORS[AT] = PAINT.r;
            COLORS[AT + 1] = PAINT.g;
            COLORS[AT + 2] = PAINT.b;
        }
        // 거울 변환(행렬식 < 0)은 삼각형 감김이 뒤집히므로 두 꼭짓점을 맞바꿔 앞면을 지킵니다.
        const MIRRORED = MATRIX ? MATRIX.determinant() < 0 : false,
            INDEX = GEOMETRY.index,
            TOTAL = INDEX ? INDEX.count : COUNT;
        for (let i = 0; i < TOTAL; i += 3) {
            const A = INDEX ? INDEX.getX(i) : i,
                B = INDEX ? INDEX.getX(i + 1) : i + 1,
                C = INDEX ? INDEX.getX(i + 2) : i + 2;
            INDICES[indexOffset + i] = vertexOffset + A;
            INDICES[indexOffset + i + 1] = vertexOffset + (MIRRORED ? C : B);
            INDICES[indexOffset + i + 2] = vertexOffset + (MIRRORED ? B : C);
        }
        vertexOffset += COUNT;
        indexOffset += TOTAL;
    }
    const MERGED = new three.BufferGeometry();
    MERGED.setAttribute('position', new three.BufferAttribute(POSITIONS, 3));
    MERGED.setAttribute('normal', new three.BufferAttribute(NORMALS, 3));
    MERGED.setAttribute('color', new three.BufferAttribute(COLORS, 3));
    if (SKINNED) {
        MERGED.setAttribute('skinIndex', new three.BufferAttribute(SKIN_INDEX, 4));
        MERGED.setAttribute('skinWeight', new three.BufferAttribute(SKIN_WEIGHT, 4));
    }
    if (UVS) {
        MERGED.setAttribute('uv', new three.BufferAttribute(UVS, 2));
    }
    MERGED.setIndex(new three.BufferAttribute(INDICES, 1));
    MERGED.computeBoundingBox();
    MERGED.computeBoundingSphere();
    return MERGED;
}

/** 선택 속성 key를 쓰는 도형이 있는지. 일부만 쓰면 빠진 정점이 엉뚱한 값을 갖게 되므로 오류를 냅니다. */
function optional(parts, key) {
    const COUNT = parts.filter((part) => part[key] !== undefined).length;
    if (COUNT > 0 && COUNT < parts.length) {
        throw new Error(`mergeColored: ${key}가 일부 도형에만 있습니다(${COUNT}/${parts.length})`);
    }
    return COUNT > 0;
}

/**
 * 합칠 도형을 모아 두었다가 build()에서 mergeColored로 합칩니다.
 * 같은 치수의 기본 geometry는 한 번만 만들고, build()가 임시 geometry를 해제합니다. 만들 때만 쓰고 프레임마다 부르지 않습니다.
 * 변환 옵션: position은 x·y·z 인자, rotation은 [x, y, z] 라디안(오일러 XYZ), scale은 [x, y, z], parent는 부모 THREE.Matrix4.
 * 선택 옵션 body·uvRect는 mergeColored와 같습니다. body를 옵션으로 주지 않으면 목록의 body 필드(지금 더하는 물체 번호)를 씁니다.
 */
export class PartList {
    /** @param {object} three three.js 네임스페이스 */
    constructor(three) {
        this.three = three;
        this.parts = [];
        this.cache = new Map();
        this.object = new three.Object3D();
        /** 이후 add하는 도형의 기본 물체 번호(RigidBatch 뼈). 쓰지 않으면 undefined. */
        this.body = undefined;
    }

    /** 같은 key의 geometry는 한 번만 만듭니다. 이 목록이 소유하며 build()에서 해제합니다. */
    geometry(key, factory) {
        if (!this.cache.has(key)) {
            this.cache.set(key, factory());
        }
        return this.cache.get(key);
    }

    /** geometry 하나를 변환과 색을 붙여 추가합니다. */
    add(geometry, color, { position, rotation, scale, parent, body = this.body, uvRect } = {}) {
        const OBJECT = this.object;
        OBJECT.position.set(...(position ?? [0, 0, 0]));
        OBJECT.rotation.set(...(rotation ?? [0, 0, 0]));
        OBJECT.scale.set(...(scale ?? [1, 1, 1]));
        OBJECT.updateMatrix();
        const MATRIX = parent
            ? new this.three.Matrix4().multiplyMatrices(parent, OBJECT.matrix)
            : OBJECT.matrix.clone();
        this.parts.push({ geometry, color, matrix: MATRIX, body, uvRect });
    }

    box(width, height, depth, color, x = 0, y = 0, z = 0, options) {
        const GEOMETRY = this.geometry(
            `box:${width}:${height}:${depth}`,
            () => new this.three.BoxGeometry(width, height, depth),
        );
        this.add(GEOMETRY, color, { ...options, position: [x, y, z] });
    }

    /** 원기둥(옆 12분할). options.top은 윗면 반지름(기본 radius). */
    cylinder(radius, height, color, x = 0, y = 0, z = 0, options = {}) {
        const TOP = options.top ?? radius,
            GEOMETRY = this.geometry(
                `cylinder:${radius}:${TOP}:${height}`,
                () => new this.three.CylinderGeometry(TOP, radius, height, 12),
            );
        this.add(GEOMETRY, color, { ...options, position: [x, y, z] });
    }

    /** 구(가로 options.segments 기본 12, 세로 10분할). */
    sphere(radius, color, x = 0, y = 0, z = 0, options = {}) {
        const SEGMENTS = options.segments ?? 12,
            GEOMETRY = this.geometry(
                `sphere:${radius}:${SEGMENTS}`,
                () => new this.three.SphereGeometry(radius, SEGMENTS, 10),
            );
        this.add(GEOMETRY, color, { ...options, position: [x, y, z] });
    }

    /** 합친 geometry를 돌려주고 임시 geometry를 해제합니다. 목록은 비워 다시 쓸 수 있습니다. */
    build() {
        const MERGED = mergeColored(this.three, this.parts);
        for (const GEOMETRY of this.cache.values()) {
            GEOMETRY.dispose();
        }
        this.cache.clear();
        this.parts.length = 0;
        return MERGED;
    }
}

import { replaceShaderChunk } from './shader-chunk.js';

const MAIN = 'void main() {';
const SKIN_BASE = '#include <skinbase_vertex>';
const EMISSIVE = 'vec3 totalEmissiveRadiance = emissive;';

/**
 * 모양이 다른 딱딱한 물체 여러 개를 three.js `SkinnedMesh` 하나(1 draw)로 그립니다.
 * 물체마다 `Bone` 하나를 계층 없이 평평하게 두고, 병합 geometry의 정점마다 자기 물체 번호를 skinIndex로, 가중치 (1, 0, 0, 0)을
 * skinWeight로 답니다(PartList·mergeColored의 body 옵션). 뼈는 Object3D라 위치·회전·크기를 그대로 넣으면 되고, 뼈 행렬 전달
 * (float 텍스처라 뼈 수 한도가 없음)·조명·그림자 깊이·안개는 three.js 기본 처리입니다. 확장(WEBGL_multi_draw)에 기대지 않습니다.
 *
 * 좌표: 뼈의 바인드 자세는 단위 행렬이므로 정점은 root 공간 좌표이고, 뼈 변환이 곧 그 물체의 root 공간 변환입니다.
 * 컬링: SkinnedMesh의 경계는 바인드 자세 기준이라 실제 위치를 따르지 않으므로 메시는 frustumCulled를 끕니다.
 * 물체별 emissive 가산(glowMaterial·setGlow)만 기본 기능에 없어 표준 재질 셰이더에 주입합니다.
 */
export class RigidBatch {
    /** @param {object} three three.js 네임스페이스 */
    constructor(three) {
        this.three = three;
        /** 뼈와 메시를 담는 묶음. 소비자가 장면에 넣습니다. */
        this.root = new three.Group();
        this.bones = [];
        this.skeleton = null;
        this.glowValues = null;
    }

    /** 물체 하나를 더하고 번호를 돌려줍니다. 뼈 수는 첫 mesh()에서 정해지므로 그 전에만 부릅니다. */
    add() {
        if (this.skeleton) {
            throw new Error('RigidBatch: mesh()를 만든 뒤에는 물체를 더할 수 없습니다');
        }
        const BONE = new this.three.Bone();
        this.root.add(BONE);
        this.bones.push(BONE);
        return this.bones.length - 1;
    }

    /** 물체 번호의 뼈(Object3D). position·quaternion·scale에 그 물체의 변환을 씁니다. 렌더러가 모든 뼈를 한 번에 올립니다. */
    bone(index) {
        return this.bones[index];
    }

    /**
     * 물체 번호가 붙은 geometry(skinIndex·skinWeight)를 이 묶음의 뼈대에 묶은 SkinnedMesh로 만들어 root에 넣습니다.
     * 메시는 몇 개든 같은 뼈대를 씁니다(재질이 다른 층마다 하나). 첫 호출에서 뼈대를 만듭니다.
     */
    mesh(geometry, material) {
        const T = this.three;
        requireSkin(geometry);
        if (!this.skeleton) {
            this.skeleton = new T.Skeleton(
                this.bones,
                this.bones.map(() => new T.Matrix4()),
            );
            this.glowValues = new Float32Array(Math.ceil(this.bones.length / 4) * 4);
        }
        const MESH = new T.SkinnedMesh(geometry, material);
        MESH.bind(this.skeleton, new T.Matrix4());
        MESH.frustumCulled = false;
        this.root.add(MESH);
        return MESH;
    }

    /** 메시의 geometry를 바꿉니다(이전 것은 해제). 뼈와 재질은 그대로입니다. */
    setGeometry(mesh, geometry) {
        requireSkin(geometry);
        mesh.geometry.dispose();
        mesh.geometry = geometry;
        mesh.boundingBox = mesh.boundingSphere = null;
    }

    /**
     * 표준 계열 재질(MeshStandardMaterial·MeshPhysicalMaterial)이 물체별 setGlow 값을 emissive에 더하게 하고 그 재질을 돌려줍니다.
     * mesh() 전에 불러도 됩니다. 값은 uniform vec4 배열(물체 4개당 1벡터)이라 바꿔도 재컴파일이 없습니다. 재질 하나는 한 묶음에만 씁니다.
     */
    glowMaterial(material) {
        material.onBeforeCompile = (shader) => {
            if (!this.glowValues) {
                throw new Error('RigidBatch: mesh()를 만들기 전에는 그릴 수 없습니다');
            }
            shader.uniforms.rigidGlow = { value: this.glowValues };
            shader.vertexShader = replaceShaderChunk(
                replaceShaderChunk(
                    shader.vertexShader,
                    MAIN,
                    `uniform vec4 rigidGlow[${this.glowValues.length / 4}];\nvarying float vRigidGlow;\n${MAIN}`,
                ),
                SKIN_BASE,
                `${SKIN_BASE}\n\tint rigidBody = int(skinIndex.x);\n\tvRigidGlow = rigidGlow[rigidBody / 4][rigidBody % 4];`,
            );
            shader.fragmentShader = replaceShaderChunk(
                replaceShaderChunk(shader.fragmentShader, MAIN, `varying float vRigidGlow;\n${MAIN}`),
                EMISSIVE,
                'vec3 totalEmissiveRadiance = emissive + vec3(vRigidGlow);',
            );
        };
        material.customProgramCacheKey = () => `rigid-glow:${this.glowValues?.length ?? 0}`;
        return material;
    }

    /** 물체 번호의 emissive 가산 값(0이면 끔). glowMaterial로 감싼 재질에만 보입니다. */
    setGlow(index, value) {
        this.glowValues[index] = value;
    }

    /** 메시 geometry와 뼈 텍스처를 해제하고 장면에서 뺍니다. 재질은 소비자가 소유합니다. */
    dispose() {
        for (const CHILD of this.root.children) {
            if (CHILD.isSkinnedMesh) {
                CHILD.geometry.dispose();
            }
        }
        this.skeleton?.dispose();
        this.root.removeFromParent();
    }
}

function requireSkin(geometry) {
    if (!geometry.getAttribute('skinIndex') || !geometry.getAttribute('skinWeight')) {
        throw new Error('RigidBatch: geometry에 물체 번호(skinIndex·skinWeight)가 없습니다');
    }
}

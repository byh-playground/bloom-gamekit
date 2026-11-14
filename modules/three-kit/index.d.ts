import type { FrameHitchRule, FrameMetrics, FrameTraceRule, NumericFrameSnapshot } from '../debug-tools/index.js';

/** three.js 네임스페이스(`import * as THREE from 'three'`). 모듈은 three를 import하지 않고 이 값을 받습니다. */
export type Three = any;
/** three.js 객체(WebGLRenderer·Scene·Camera·BufferGeometry·Material·Matrix4·Color 등). */
type ThreeObject = any;

export class RenderStats {
    /** `stages`·`counters`는 게임이 같은 프레임에 `metrics.stage`·`metrics.count`로 적을 이름입니다(counters는 기본 넷 뒤). */
    constructor(
        renderer: ThreeObject,
        options?: {
            capacity?: number;
            stages?: string[];
            counters?: string[];
            hitch?: Partial<FrameHitchRule>;
            trace?: Partial<FrameTraceRule>;
        },
    );
    readonly metrics: FrameMetrics;
    /** 프레임 시작: renderer.info를 0으로 되돌리고 시간 재기를 시작합니다. */
    begin(): void;
    /** 프레임 끝: begin() 뒤 모든 render()의 drawCalls·triangles·programs·textures 합계를 기록합니다. */
    end(): void;
    snapshot(): NumericFrameSnapshot;
    line(): string;
}

/**
 * 숨긴 객체를 켜고 화면 1픽셀에 한 번 그려 셰이더 컴파일과 버퍼·텍스처 업로드를 로딩 때 끝냅니다. 숨김·frustumCulled·렌더러 상태
 * (렌더 타깃·scissor·info.render 그리기 수)는 되돌리고 그린 1픽셀은 지웁니다(로딩 때 한 번).
 */
export function warmUp(renderer: ThreeObject, scene: ThreeObject, camera: ThreeObject): void;

export interface InstanceLayerExtension {
    /** 프로그램 캐시 키에 들어가는 이름. 주입 내용이 다르면 key도 달라야 합니다. */
    key: string;
    /** 레이어 주입 뒤 onBeforeCompile의 shader를 받습니다. replaceShaderChunk로 고치세요. */
    inject(shader: {
        uniforms: Record<string, { value: unknown }>;
        vertexShader: string;
        fragmentShader: string;
    }): void;
}

export interface InstanceLayerOptions {
    /** mergeShapes의 geometry면(aShape 속성) 인스턴스마다 모양을 고릅니다. 레이어는 이 geometry를 해제하지 않습니다. */
    geometry: ThreeObject;
    capacity: number;
    side?: number;
    opaque?: boolean;
    depthTest?: boolean;
    order?: number;
    extend?: InstanceLayerExtension;
}

export class InstanceLayer {
    constructor(three: Three, options: InstanceLayerOptions);
    readonly capacity: number;
    readonly mesh: ThreeObject;
    readonly material: ThreeObject;
    readonly count: number;
    begin(): void;
    add(matrix: ThreeObject, color: ThreeObject, opacity: number, shape?: number): void;
    end(): void;
    dispose(): void;
}

export function mergeShapes(
    three: Three,
    geometries: Record<string, ThreeObject>,
): { geometry: ThreeObject; shapes: Record<string, number> };

export class RigidBatch {
    constructor(three: Three);
    readonly root: ThreeObject;
    add(): number;
    bone(index: number): ThreeObject;
    mesh(geometry: ThreeObject, material: ThreeObject): ThreeObject;
    setGeometry(mesh: ThreeObject, geometry: ThreeObject): void;
    glowMaterial<M>(material: M): M;
    setGlow(index: number, value: number): void;
    dispose(): void;
}

export interface MergePart {
    geometry: ThreeObject;
    color?: number | ThreeObject;
    matrix?: ThreeObject;
    /** RigidBatch 물체 번호, 또는 변환 전 정점 좌표 → 물체 번호 */
    body?: number | ((point: ThreeObject) => number);
    /** [u0, v0, du, dv] */
    uvRect?: [number, number, number, number];
}

export function mergeColored(three: Three, parts: MergePart[]): ThreeObject;

export interface PartOptions {
    rotation?: [number, number, number];
    scale?: [number, number, number];
    parent?: ThreeObject;
    body?: number | ((point: ThreeObject) => number);
    uvRect?: [number, number, number, number];
}

export class PartList {
    constructor(three: Three);
    /** 이후 더하는 도형의 기본 물체 번호 */
    body: number | undefined;
    geometry(key: string, factory: () => ThreeObject): ThreeObject;
    add(
        geometry: ThreeObject,
        color: number | ThreeObject,
        options?: PartOptions & { position?: [number, number, number] },
    ): void;
    box(
        width: number,
        height: number,
        depth: number,
        color: number | ThreeObject,
        x?: number,
        y?: number,
        z?: number,
        options?: PartOptions,
    ): void;
    cylinder(
        radius: number,
        height: number,
        color: number | ThreeObject,
        x?: number,
        y?: number,
        z?: number,
        options?: PartOptions & { top?: number },
    ): void;
    sphere(
        radius: number,
        color: number | ThreeObject,
        x?: number,
        y?: number,
        z?: number,
        options?: PartOptions & { segments?: number },
    ): void;
    build(): ThreeObject;
}

/** source의 target(처음 한 번)을 replacement로 바꿉니다. target이 없으면 오류를 냅니다. */
export function replaceShaderChunk(source: string, target: string, replacement: string): string;

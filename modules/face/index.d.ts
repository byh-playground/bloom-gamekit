/** The eight state faces, in definition order. */
export type StateFaceId = 'neutral' | 'happy' | 'focused' | 'attack' | 'surprised' | 'hurt' | 'hungry' | 'dead';
/** Five idle looks of the neutral state; `temperament-N` is index N of TEMPERAMENT_FACES. */
export type TemperamentFaceId = 'temperament-0' | 'temperament-1' | 'temperament-2' | 'temperament-3' | 'temperament-4';
export type FaceId = StateFaceId | TemperamentFaceId;

export const STATE_FACES: readonly StateFaceId[];
export const TEMPERAMENT_FACES: readonly TemperamentFaceId[];
/** STATE_FACES then TEMPERAMENT_FACES. */
export const FACE_IDS: readonly FaceId[];
/** The cheek colour when a game passes none. */
export const DEFAULT_CHEEK_COLOR: string;

export type Point = readonly [x: number, y: number];
export type PathCommand =
    | readonly [command: 'M' | 'L', x: number, y: number]
    | readonly [command: 'Q', cx: number, cy: number, x: number, y: number]
    | readonly [command: 'C', c1x: number, c1y: number, c2x: number, c2y: number, x: number, y: number]
    | readonly [command: 'Z'];
export interface FillOperation {
    fill: string;
    path: PathCommand[];
    opacity: number;
}
export interface StrokeOperation {
    stroke: string;
    path: PathCommand[];
    /** Line width in the operation's own units. Strokes are drawn with round caps and joins. */
    width: number;
}
/** One painted path, in the units of the canvas it was built for. */
export type DrawOperation = FillOperation | StrokeOperation;

/** The three face points of a body, in the body's canvas. */
export interface FaceAnchor {
    readonly eyeLeft: Point;
    readonly eyeRight: Point;
    readonly mouth: Point;
}
export interface CheekLook {
    scale: number;
    opacity: number;
}
/** Part geometry in eye-gap units around the part's own point. Frozen; the same object for every call. */
export interface FaceParts {
    readonly eyes: readonly [readonly DrawOperation[], readonly DrawOperation[]];
    readonly mouth: readonly DrawOperation[];
    readonly cheeks: Readonly<CheekLook>;
}

/** Four-segment closed ellipse path. */
export function ellipsePath(cx: number, cy: number, rx: number, ry: number): PathCommand[];
/** Throws RangeError for an id outside FACE_IDS. */
export function faceParts(faceId: FaceId): FaceParts;
/** `gap` is the eye distance (one eye-gap unit); `origins` are the left eye, right eye and mouth points. */
export function facePartPlacement(anchor: FaceAnchor): { gap: number; origins: [Point, Point, Point] };
/** The two cheek ellipses as [cx, cy, rx, ry]. */
export function cheekEllipses(
    anchor: FaceAnchor,
    cheeks: CheekLook,
): [[number, number, number, number], [number, number, number, number]];
/** The whole face as draw operations in the body's canvas, one operation per colour. */
export function buildFace(faceId: FaceId, anchor: FaceAnchor, cheekColor?: string | null): DrawOperation[];
/** The same face as SVG `<path>` markup, for portraits that are plain SVG images. */
export function faceSvg(faceId: FaceId, anchor: FaceAnchor, cheekColor?: string | null): string;

/** The socket ids a body's SVG declares for its face: left eye, right eye, mouth. */
export const FACE_SOCKETS: readonly ['face-eye-left', 'face-eye-right', 'face-mouth'];
/** A compiled body asset (vector-assets `compile` result); only its sockets and name are read. */
export interface FaceBody {
    readonly metadata: { readonly sockets: Readonly<Record<string, { readonly point: Point }>> };
    readonly sourcePath?: string;
}
/** A posed actor (vector-assets `createVectorActor`); only its sockets are read. */
export interface FaceActor {
    getSocket(id: string): { x: number; y: number };
}
/** The body's face points at rest, cached per compiled body. Throws if a face socket is missing. */
export function faceAnchor(compiled: FaceBody): Readonly<FaceAnchor>;
/** Writes the transform [a, b, c, d, e, f] from the rest face triangle onto the posed one into `out`. */
export function posedFace<Out extends number[] | Float32Array | Float64Array>(
    actor: FaceActor,
    rest: FaceAnchor,
    out: Out,
): Out;

/** What drawOperations and drawFacePaths need: the Canvas path API (a 2D canvas or a rendering VectorContext). */
export interface PathContext {
    lineCap: string;
    lineJoin: string;
    globalAlpha: number;
    fillStyle: unknown;
    strokeStyle: unknown;
    lineWidth: number;
    beginPath(): void;
    moveTo(x: number, y: number): void;
    lineTo(x: number, y: number): void;
    quadraticCurveTo(cx: number, cy: number, x: number, y: number): void;
    bezierCurveTo(c1x: number, c1y: number, c2x: number, c2y: number, x: number, y: number): void;
    closePath(): void;
    fill(): void;
    stroke(): void;
}
/** A live rectangle of the device texture atlas. */
export interface AtlasRegion {
    readonly atlas: object;
}
/** The rendering `WebGLDevice` part the images use. */
export interface AtlasDevice {
    readonly state: string;
    readonly textureAtlas: {
        allocate(width: number, height: number): AtlasRegion;
        upload(region: AtlasRegion, source: unknown): void;
        release(region: AtlasRegion): unknown;
    };
}
/** What OperationImages needs from a rendering `VectorContext`. */
export interface ImageContext {
    readonly device: AtlasDevice | null;
    drawRegion(region: AtlasRegion, x: number, y: number, width: number, height: number): void;
}
/** What FaceOverlay needs from a rendering `VectorContext`. */
export interface FaceContext extends ImageContext, PathContext {
    save(): void;
    restore(): void;
    transform(a: number, b: number, c: number, d: number, e: number, f: number): void;
    withColor<T>(color: string, callback: () => T): T;
}

/** Draws operations as paths on the current transform. Sets lineCap, lineJoin, globalAlpha and the styles. */
export function drawOperations(ctx: PathContext, operations: readonly DrawOperation[], alpha?: number): void;
/** A body's face as paths on the current transform (which maps the body's canvas). Cached per body, face and colour. */
export function drawFacePaths(
    ctx: PathContext,
    compiled: FaceBody,
    faceId: FaceId,
    cheekColor?: string | null,
    alpha?: number,
): void;

export interface Picture {
    operations: readonly DrawOperation[];
    /** Raster density: image pixels per local unit. */
    pixelsPerUnit: number;
}
/** Draw operations baked into images on the device texture atlas. Restore-safe; nothing uploads after prepare(). */
export class OperationImages<Key = unknown> {
    constructor(ctx: ImageContext, pictures: Iterable<readonly [Key, Picture]>);
    /** True when prepared, the context is ready and not disposed. */
    readonly ready: boolean;
    has(key: Key): boolean;
    /** Rasterises and uploads every picture once; a no-op until the device is ready and after the first success. */
    prepare(): void;
    /** Draws a picture whose local origin goes to (x, y) with local unit (scaleX, scaleY). Call only while ready. */
    draw(key: Key, x: number, y: number, scaleX: number, scaleY: number): void;
    dispose(): void;
}

/** Face parts baked once on the device atlas and overlaid on any body that declares the face sockets. */
export class FaceOverlay {
    /** `faces`: the face ids to bake (default FACE_IDS). Other faces draw as paths. */
    constructor(ctx: FaceContext, options?: { faces?: readonly FaceId[] });
    /** True while baked images can be drawn. */
    readonly ready: boolean;
    /** Uploads the baked faces once, outside game frames. Call again after the device is up. */
    prepare(): void;
    /**
     * Draws the face over a body already submitted with `matrix`. Returns true when baked images were drawn, false
     * when paths were (not baked, not prepared, context lost, or the face would be magnified past half its image).
     */
    draw(
        compiled: FaceBody,
        actor: FaceActor,
        faceId: FaceId,
        matrix: ArrayLike<number>,
        alpha?: number,
        cheekColor?: string | null,
    ): boolean;
    dispose(): void;
}

// Drawing a face over a body: as paths on any Canvas-like context, or as images baked once into the device's texture
// atlas. The context is a rendering VectorContext (duck-typed: save, restore, transform, globalAlpha, withColor,
// drawRegion, device.textureAtlas); this file imports no other module.
import {
    DEFAULT_CHEEK_COLOR,
    FACE_IDS,
    buildFace,
    cheekEllipses,
    ellipsePath,
    facePartPlacement,
    faceParts,
    operationBox,
} from './geometry.js';
import { faceAnchor, posedFace } from './body.js';

// Pixels per eye gap for face parts and across the cheek circle. A face is drawn from images at most at half that
// size; larger draws use paths so nothing is magnified.
const FACE_PART_PIXELS = 128;
const CHEEK_PIXELS = 64;
const MAX_DISPLAY_TO_IMAGE_SCALE = 0.5;
// A unit circle squashed to each cheek when drawn; white so withColor gives it the cheek colour.
const CHEEK_OPERATIONS = Object.freeze([{ fill: '#ffffff', opacity: 1, path: ellipsePath(0, 0, 1, 1) }]);

function tracePath(target, path) {
    for (const [COMMAND, ...N] of path) {
        if (COMMAND === 'M') {
            target.moveTo(N[0], N[1]);
        } else if (COMMAND === 'L') {
            target.lineTo(N[0], N[1]);
        } else if (COMMAND === 'Q') {
            target.quadraticCurveTo(N[0], N[1], N[2], N[3]);
        } else if (COMMAND === 'C') {
            target.bezierCurveTo(N[0], N[1], N[2], N[3], N[4], N[5]);
        } else {
            target.closePath();
        }
    }
}

// Draws { fill | stroke, path, width?, opacity? } operations as paths on the context's current transform. Leaves
// lineCap, lineJoin, globalAlpha and the fill/stroke style set, so call it between save() and restore().
export function drawOperations(ctx, operations, alpha = 1) {
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const OP of operations) {
        ctx.beginPath();
        tracePath(ctx, OP.path);
        if (OP.fill) {
            ctx.globalAlpha = (OP.opacity ?? 1) * alpha;
            ctx.fillStyle = OP.fill;
            ctx.fill();
        } else {
            ctx.globalAlpha = alpha;
            ctx.strokeStyle = OP.stroke;
            ctx.lineWidth = OP.width;
            ctx.stroke();
        }
    }
}

const PATH_OPERATIONS = new WeakMap();
function faceOperations(compiled, faceId, cheekColor) {
    const ANCHOR = faceAnchor(compiled);
    let byKey = PATH_OPERATIONS.get(ANCHOR);
    if (!byKey) {
        byKey = new Map();
        PATH_OPERATIONS.set(ANCHOR, byKey);
    }
    const KEY = faceId + ':' + cheekColor;
    let operations = byKey.get(KEY);
    if (!operations) {
        operations = Object.freeze(buildFace(faceId, ANCHOR, cheekColor));
        byKey.set(KEY, operations);
    }
    return operations;
}

// Draws a body's face as paths on the context's current transform, which must map the body's canvas (a card portrait
// on a plain 2D canvas, or the posed face of FaceOverlay). The operations are built once per body, face and colour.
export function drawFacePaths(ctx, compiled, faceId, cheekColor = null, alpha = 1) {
    drawOperations(ctx, faceOperations(compiled, faceId, cheekColor), alpha);
}

// Rasterises draw operations ({ fill | stroke, path, width?, opacity? } in local units) into a canvas.
// Returns it with the local rectangle it covers.
function rasterise(operations, pixelsPerUnit) {
    const BOX = [Infinity, Infinity, -Infinity, -Infinity];
    for (const OPERATION of operations) {
        const OPERATION_BOX = operationBox(OPERATION);
        BOX[0] = Math.min(BOX[0], OPERATION_BOX[0]);
        BOX[1] = Math.min(BOX[1], OPERATION_BOX[1]);
        BOX[2] = Math.max(BOX[2], OPERATION_BOX[2]);
        BOX[3] = Math.max(BOX[3], OPERATION_BOX[3]);
    }
    if (!Number.isFinite(BOX[0])) {
        throw new RangeError('A picture needs at least one draw operation');
    }
    // One clear texel around the art keeps linear sampling from bleeding a neighbour in.
    const MARGIN = 1 / pixelsPerUnit,
        X = BOX[0] - MARGIN,
        Y = BOX[1] - MARGIN,
        WIDTH = Math.ceil((BOX[2] - BOX[0]) * pixelsPerUnit) + 2,
        HEIGHT = Math.ceil((BOX[3] - BOX[1]) * pixelsPerUnit) + 2,
        CANVAS = new OffscreenCanvas(WIDTH, HEIGHT),
        C = CANVAS.getContext('2d');
    C.setTransform(pixelsPerUnit, 0, 0, pixelsPerUnit, -X * pixelsPerUnit, -Y * pixelsPerUnit);
    C.lineCap = 'round';
    C.lineJoin = 'round';
    for (const OPERATION of operations) {
        const PATH = new Path2D();
        tracePath(PATH, OPERATION.path);
        if (OPERATION.fill) {
            C.globalAlpha = OPERATION.opacity ?? 1;
            C.fillStyle = OPERATION.fill;
            C.fill(PATH);
        } else {
            C.globalAlpha = 1;
            C.strokeStyle = OPERATION.stroke;
            C.lineWidth = OPERATION.width;
            C.stroke(PATH);
        }
    }
    return { canvas: CANVAS, x: X, y: Y, width: WIDTH / pixelsPerUnit, height: HEIGHT / pixelsPerUnit };
}

// Draw operations baked into images on the device's texture atlas, uploaded once outside game frames. The device
// keeps each uploaded rectangle and replays it after a lost context is restored, so the same regions stay valid and
// nothing is uploaded again. Before prepare(), while the context is lost and after dispose(), nothing is drawable
// (`ready` is false) and the caller draws the same operations as paths.
//
// pictures: [key, { operations, pixelsPerUnit }] entries (a Map works); a key is any value, such as a string or an
// object the caller already holds, and a lookup by object key hashes no string.
export class OperationImages {
    constructor(ctx, pictures) {
        this.ctx = ctx;
        this.pictures = new Map(pictures);
        this.images = new Map();
        this.disposed = false;
    }
    get ready() {
        return !this.disposed && this.images.size > 0 && this.ctx.device?.state === 'ready';
    }
    has(key) {
        return this.images.has(key);
    }
    // Rasterises and uploads every picture once. Does nothing while the device is not ready, so call it again after the
    // device is up. A failure (such as a full atlas) releases what was uploaded and rethrows, leaving it unprepared.
    prepare() {
        const DEVICE = this.ctx.device;
        if (this.disposed || DEVICE?.state !== 'ready' || this.images.size) {
            return;
        }
        const ATLAS = DEVICE.textureAtlas,
            IMAGES = new Map();
        try {
            for (const [KEY, PICTURE] of this.pictures) {
                const RASTER = rasterise(PICTURE.operations, PICTURE.pixelsPerUnit),
                    REGION = ATLAS.allocate(RASTER.canvas.width, RASTER.canvas.height);
                IMAGES.set(KEY, { ...RASTER, region: REGION });
                ATLAS.upload(REGION, RASTER.canvas);
            }
        } catch (error) {
            for (const IMAGE of IMAGES.values()) {
                ATLAS.release(IMAGE.region);
            }
            throw error;
        }
        this.images = IMAGES;
    }
    // Places a picture whose local origin goes to (x, y) and whose local unit is (scaleX, scaleY) on the current
    // transform. Call only while `ready`.
    draw(key, x, y, scaleX, scaleY) {
        const IMAGE = this.images.get(key);
        if (!IMAGE) {
            throw new RangeError('No such picture is prepared: ' + String(key));
        }
        this.ctx.drawRegion(
            IMAGE.region,
            x + IMAGE.x * scaleX,
            y + IMAGE.y * scaleY,
            IMAGE.width * scaleX,
            IMAGE.height * scaleY,
        );
    }
    dispose() {
        if (this.disposed) {
            return;
        }
        this.disposed = true;
        if (this.ctx.device?.state === 'ready') {
            for (const IMAGE of this.images.values()) {
                IMAGE.region.atlas.release(IMAGE.region);
            }
        }
        this.images.clear();
    }
}

// Eye and mouth parts per baked face plus one white cheek, on the device atlas. Every body shares them and only moves
// and scales them to its own face sockets, so the atlas holds the baked faces however many bodies there are.
// `faces` is the face ids to bake (default all); any other face is drawn as paths.
export class FaceOverlay {
    constructor(ctx, { faces = FACE_IDS } = {}) {
        this.ctx = ctx;
        this.posed = [0, 0, 0, 0, 0, 0];
        // A picture is keyed by its own operations, which faceParts keeps one frozen array per part.
        const PICTURES = new Map();
        for (const FACE of faces) {
            const PARTS = faceParts(FACE);
            for (const OPERATIONS of [...PARTS.eyes, PARTS.mouth]) {
                PICTURES.set(OPERATIONS, { operations: OPERATIONS, pixelsPerUnit: FACE_PART_PIXELS });
            }
        }
        PICTURES.set(CHEEK_OPERATIONS, { operations: CHEEK_OPERATIONS, pixelsPerUnit: CHEEK_PIXELS / 2 });
        this.images = new OperationImages(ctx, PICTURES);
    }
    // True while baked images can be drawn: prepared, the context ready, not disposed.
    get ready() {
        return this.images.ready;
    }
    // Uploads the baked faces once, outside game frames (see OperationImages.prepare).
    prepare() {
        this.images.prepare();
    }
    // Draws a face over a body already submitted with `matrix`, the screen transform it was drawn with. `actor` supplies
    // the posed sockets. Returns true when it drew baked images, false when it drew paths (the face is not baked, not
    // prepared, the context is lost, or the face would be magnified).
    draw(compiled, actor, faceId, matrix, alpha = 1, cheekColor = null) {
        const C = this.ctx,
            ANCHOR = faceAnchor(compiled),
            P = posedFace(actor, ANCHOR, this.posed);
        C.save();
        C.transform(matrix[0], matrix[1], matrix[2], matrix[3], matrix[4], matrix[5]);
        C.transform(P[0], P[1], P[2], P[3], P[4], P[5]);
        const PIXELS_PER_UNIT = Math.hypot(matrix[0], matrix[1]) * Math.hypot(P[0], P[1]),
            BAKED = this.drawImages(ANCHOR, faceId, alpha, cheekColor, PIXELS_PER_UNIT);
        if (!BAKED) {
            drawFacePaths(C, compiled, faceId, cheekColor, alpha);
        }
        C.restore();
        return BAKED;
    }
    drawImages(anchor, faceId, alpha, cheekColor, pixelsPerUnit) {
        const { gap: GAP, origins: ORIGINS } = facePartPlacement(anchor);
        if (GAP * pixelsPerUnit > FACE_PART_PIXELS * MAX_DISPLAY_TO_IMAGE_SCALE || !this.images.ready) {
            return false;
        }
        const PARTS = faceParts(faceId),
            IMAGES = this.images,
            C = this.ctx;
        if (!IMAGES.has(PARTS.mouth)) {
            return false;
        }
        C.globalAlpha = alpha * PARTS.cheeks.opacity;
        C.withColor(cheekColor ?? DEFAULT_CHEEK_COLOR, () => {
            for (const [CX, CY, RX, RY] of cheekEllipses(anchor, PARTS.cheeks)) {
                IMAGES.draw(CHEEK_OPERATIONS, CX, CY, RX, RY);
            }
        });
        C.globalAlpha = alpha;
        IMAGES.draw(PARTS.eyes[0], ORIGINS[0][0], ORIGINS[0][1], GAP, GAP);
        IMAGES.draw(PARTS.eyes[1], ORIGINS[1][0], ORIGINS[1][1], GAP, GAP);
        IMAGES.draw(PARTS.mouth, ORIGINS[2][0], ORIGINS[2][1], GAP, GAP);
        return true;
    }
    dispose() {
        this.images.dispose();
    }
}

// The face is not authored art: every body gets the same faces from three anchor points in its canvas.
// Geometry is built once per (anchor, face) in the canvas of the body, so a renderer can draw it with the live body
// transform and a portrait can place it into an SVG without a second description.

const EYE_COLOR = '#4a2420';
const INK_COLOR = '#2c1c18';
const GLINT_COLOR = '#fff5d8';
const TONGUE_COLOR = '#e9776b';
const ELLIPSE_KAPPA = 0.5522847498;
const CHEEK_ASPECT = 0.62;
const STROKE_WIDTH = 0.055;
// Part geometry is in eye-gap units (the distance between the eyes is 1): U is an eye's size, W the mouth's half width.
const U = 0.165;
const W = 0.19;

export const DEFAULT_CHEEK_COLOR = '#ec8070';

// Draw operations: { fill | stroke: colour, path: [[command, ...NUMBERS]], width?, opacity? }.
export function ellipsePath(cx, cy, rx, ry) {
    const KX = rx * ELLIPSE_KAPPA,
        KY = ry * ELLIPSE_KAPPA;
    return [
        ['M', cx + rx, cy],
        ['C', cx + rx, cy + KY, cx + KX, cy + ry, cx, cy + ry],
        ['C', cx - KX, cy + ry, cx - rx, cy + KY, cx - rx, cy],
        ['C', cx - rx, cy - KY, cx - KX, cy - ry, cx, cy - ry],
        ['C', cx + KX, cy - ry, cx + rx, cy - KY, cx + rx, cy],
        ['Z'],
    ];
}

// [minX, minY, maxX, maxY] of an operation's path control points, widened by half the stroke.
export function operationBox(operation) {
    const PAD = operation.width ? operation.width / 2 : 0,
        BOX = [Infinity, Infinity, -Infinity, -Infinity];
    for (const [, ...NUMBERS] of operation.path) {
        for (let index = 0; index < NUMBERS.length; index += 2) {
            BOX[0] = Math.min(BOX[0], NUMBERS[index] - PAD);
            BOX[1] = Math.min(BOX[1], NUMBERS[index + 1] - PAD);
            BOX[2] = Math.max(BOX[2], NUMBERS[index] + PAD);
            BOX[3] = Math.max(BOX[3], NUMBERS[index + 1] + PAD);
        }
    }
    return BOX;
}
const STYLE_OF = (operation) =>
    operation.fill ? 'f' + operation.fill + '/' + operation.opacity : 's' + operation.stroke + '/' + operation.width;
const OVERLAPS = (a, b) => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];

// One draw per colour: an operation joins the nearest earlier one of its style unless an operation drawn
// between them overlaps it, so the layering (glints over eyes, teeth over mouth) is unchanged.
function mergeByStyle(operations) {
    const MERGED = [];
    for (const OPERATION of operations) {
        const ENTRY = { operation: { ...OPERATION, path: [...OPERATION.path] }, box: operationBox(OPERATION) },
            STYLE = STYLE_OF(OPERATION);
        let target = null;
        for (let index = MERGED.length - 1; index >= 0; index--) {
            if (STYLE_OF(MERGED[index].operation) === STYLE) {
                target = MERGED[index];
                break;
            }
            if (OVERLAPS(MERGED[index].box, ENTRY.box)) {
                break;
            }
        }
        if (target) {
            target.operation.path.push(...OPERATION.path);
            target.box = [
                Math.min(target.box[0], ENTRY.box[0]),
                Math.min(target.box[1], ENTRY.box[1]),
                Math.max(target.box[2], ENTRY.box[2]),
                Math.max(target.box[3], ENTRY.box[3]),
            ];
        } else {
            MERGED.push(ENTRY);
        }
    }
    return MERGED.map((entry) => entry.operation);
}

// The pen a face definition draws its parts with: the left and right eye and the mouth, in eye-gap units around the
// part's own point, plus how the cheek pair looks.
class FacePen {
    constructor() {
        this.eyes = [[], []];
        this.mouth = [];
        this.cheekLook = { scale: 1, opacity: 1 };
    }
    cheeks(scale = 1, opacity = 1) {
        this.cheekLook = { scale, opacity };
    }
    fill(part, path, color, opacity = 1) {
        part.push({ fill: color, path, opacity });
    }
    stroke(part, path, scale = 1, color = INK_COLOR) {
        part.push({ stroke: color, path, width: STROKE_WIDTH * scale });
    }
    line(part, x1, y1, x2, y2, scale) {
        this.stroke(
            part,
            [
                ['M', x1, y1],
                ['L', x2, y2],
            ],
            scale,
        );
    }
    curve(part, x1, y1, cx, cy, x2, y2, scale) {
        this.stroke(
            part,
            [
                ['M', x1, y1],
                ['Q', cx, cy, x2, y2],
            ],
            scale,
        );
    }
    roundEyes(rx = 1, ry = 1, dy = 0) {
        for (const EYE of this.eyes) {
            this.fill(EYE, ellipsePath(0, dy * U, U * rx, U * ry * 1.05), EYE_COLOR);
        }
    }
    glints(rx = 1, big = 0.3, small = 0.14, dy = 0) {
        for (const EYE of this.eyes) {
            this.fill(EYE, ellipsePath(-0.3 * U * rx, dy * U - 0.35 * U, U * big, U * big), GLINT_COLOR);
            if (small) {
                this.fill(EYE, ellipsePath(0.35 * U * rx, dy * U + 0.3 * U, U * small, U * small), GLINT_COLOR, 0.8);
            }
        }
    }
    smile(half, depth, scale) {
        this.curve(this.mouth, -half, 0, 0, depth, half, 0, scale);
    }
    // A closed mouth outline that holds the open-mouth fill; optional tongue.
    openMouth(half, depth, tongue) {
        this.fill(
            this.mouth,
            [
                ['M', -half, -U * 0.1],
                ['Q', 0, -U * 0.1, half, -U * 0.1],
                ['Q', half * 0.8, depth, 0, depth + U * 0.05],
                ['Q', -half * 0.8, depth, -half, -U * 0.1],
                ['Z'],
            ],
            INK_COLOR,
        );
        if (tongue) {
            this.fill(this.mouth, ellipsePath(0, depth * 0.78, half * 0.5, U * 0.38), TONGUE_COLOR);
        }
    }
    // side < 0 is the left eye, otherwise the right one; coordinates are in eye sizes.
    brow(side, x1, y1, x2, y2, scale = 1) {
        this.line(this.eyes[side < 0 ? 0 : 1], x1 * U, y1 * U, x2 * U, y2 * U, scale);
    }
    arcUp(index, scale = 1.25) {
        this.curve(this.eyes[index], -U, U * 0.35, 0, -U, U, U * 0.35, scale);
    }
}

// The state faces, by the name a game picks them with.
const STATE_DEFINITIONS = {
    neutral(pen) {
        pen.cheeks();
        pen.roundEyes();
        pen.glints(1, 0.3, 0);
        pen.smile(W, W * 0.525, 1.15);
    },
    happy(pen) {
        pen.cheeks(1.2);
        pen.arcUp(0);
        pen.arcUp(1);
        pen.openMouth(W, U * 1.5, true);
    },
    focused(pen) {
        pen.cheeks(1, 0.55);
        for (const EYE of pen.eyes) {
            pen.fill(
                EYE,
                [
                    ['M', -U * 1.05, -U * 0.1],
                    ['Q', -U * 1.05, U * 0.85, 0, U * 0.85],
                    ['Q', U * 1.05, U * 0.85, U * 1.05, -U * 0.1],
                    ['Z'],
                ],
                EYE_COLOR,
            );
        }
        pen.brow(-1, -1.15, -1.15, 0.95, -0.8, 1.2);
        pen.brow(1, 1.15, -1.15, -0.95, -0.8, 1.2);
        pen.line(pen.mouth, -W * 0.45, U * 0.1, W * 0.45, U * 0.1, 1.2);
    },
    attack(pen) {
        pen.cheeks(1, 0.8);
        for (const EYE of pen.eyes) {
            pen.fill(EYE, ellipsePath(0, U * 0.1, U * 0.95, U * 0.84), EYE_COLOR);
        }
        pen.brow(-1, -1.3, -1.55, 1.1, -0.7, 1.5);
        pen.brow(1, 1.3, -1.55, -1.1, -0.7, 1.5);
        pen.openMouth(W * 0.85, U * 1.5, false);
        pen.fill(
            pen.mouth,
            [
                ['M', -W * 0.62, -U * 0.05],
                ['L', W * 0.62, -U * 0.05],
                ['L', W * 0.62, U * 0.4],
                ['L', -W * 0.62, U * 0.4],
                ['Z'],
            ],
            '#ffffff',
        );
    },
    surprised(pen) {
        pen.cheeks(1, 0.9);
        for (const EYE of pen.eyes) {
            pen.fill(EYE, ellipsePath(0, 0, U * 1.12, U * 1.28), EYE_COLOR);
            pen.fill(EYE, ellipsePath(-0.35 * U, -0.5 * U, U * 0.38, U * 0.38), GLINT_COLOR);
            pen.fill(EYE, ellipsePath(0.4 * U, 0.4 * U, U * 0.17, U * 0.17), GLINT_COLOR, 0.85);
            pen.curve(EYE, -U, -U * 1.85, 0, -U * 2.4, U, -U * 1.85, 0.8);
        }
        pen.fill(pen.mouth, ellipsePath(0, U * 0.55, U * 0.5, U * 0.72), INK_COLOR);
    },
    hurt(pen) {
        pen.cheeks(1, 0.8);
        pen.stroke(
            pen.eyes[0],
            [
                ['M', -U * 0.9, -U * 0.8],
                ['L', U * 0.8, 0],
                ['L', -U * 0.9, U * 0.8],
            ],
            1.3,
        );
        pen.stroke(
            pen.eyes[1],
            [
                ['M', U * 0.9, -U * 0.8],
                ['L', -U * 0.8, 0],
                ['L', U * 0.9, U * 0.8],
            ],
            1.3,
        );
        pen.stroke(
            pen.mouth,
            [
                ['M', -W * 0.8, U * 0.3],
                ['Q', -W * 0.4, -U * 0.35, 0, U * 0.3],
                ['Q', W * 0.4, U * 0.95, W * 0.8, U * 0.3],
            ],
            1.1,
        );
    },
    hungry(pen) {
        pen.cheeks(1, 0.6);
        for (const EYE of pen.eyes) {
            pen.fill(EYE, ellipsePath(0, U * 0.15, U * 0.95, U * 0.84), EYE_COLOR);
            pen.fill(EYE, ellipsePath(-0.25 * U, -0.05 * U, U * 0.3, U * 0.3), GLINT_COLOR);
        }
        pen.brow(-1, -1.1, -1.0, 1.0, -1.5, 0.9);
        pen.brow(1, 1.1, -1.0, -1.0, -1.5, 0.9);
        pen.curve(pen.mouth, -W * 0.5, U * 0.5, 0, -U * 0.2, W * 0.5, U * 0.5, 1.1);
    },
    dead(pen) {
        pen.cheeks(1, 0.5);
        for (const EYE of pen.eyes) {
            pen.line(EYE, -U * 0.8, -U * 0.8, U * 0.8, U * 0.8, 1.2);
            pen.line(EYE, U * 0.8, -U * 0.8, -U * 0.8, U * 0.8, 1.2);
        }
        pen.line(pen.mouth, -W * 0.45, U * 0.2, W * 0.45, U * 0.2, 1.1);
    },
};

// Five idle looks of the neutral state, by index; the face id of index N is `temperament-N`.
const TEMPERAMENT_DEFINITIONS = [
    // 느긋: small round eyes gazing up, relaxed shallow smile
    (pen) => {
        pen.cheeks(1.1, 0.9);
        for (const EYE of pen.eyes) {
            pen.fill(EYE, ellipsePath(0, 0, U * 0.72, U * 0.84), EYE_COLOR);
            pen.fill(EYE, ellipsePath(U * 0.1, -U * 0.3, U * 0.3, U * 0.3), GLINT_COLOR);
        }
        pen.curve(pen.mouth, -W * 0.55, U * 0.1, 0, W * 0.55 + U * 0.1, W * 0.55, U * 0.1, 1.1);
    },
    // 소심: wet eyes, worried brows, trembling mouth
    (pen) => {
        pen.cheeks(1, 0.9);
        for (const EYE of pen.eyes) {
            pen.fill(EYE, ellipsePath(0, U * 0.05, U, U * 1.15), EYE_COLOR);
            pen.fill(EYE, ellipsePath(-U * 0.3, -U * 0.35, U * 0.4, U * 0.4), GLINT_COLOR);
            pen.fill(EYE, ellipsePath(U * 0.35, U * 0.4, U * 0.2, U * 0.2), GLINT_COLOR, 0.9);
        }
        pen.brow(-1, -1.1, -1.0, 0.9, -1.7, 0.95);
        pen.brow(1, 1.1, -1.0, -0.9, -1.7, 0.95);
        pen.stroke(
            pen.mouth,
            [
                ['M', -W * 0.55, U * 0.3],
                ['Q', -W * 0.28, -U * 0.15, 0, U * 0.3],
                ['Q', W * 0.28, U * 0.75, W * 0.55, U * 0.3],
            ],
            1.0,
        );
    },
    // 발끈: slanted brows, round dark eyes, pout
    (pen) => {
        pen.cheeks(1.15);
        for (const EYE of pen.eyes) {
            pen.fill(EYE, ellipsePath(0, U * 0.1, U * 0.9, U * 0.9), EYE_COLOR);
        }
        pen.brow(-1, -1.3, -1.5, 1.0, -0.8, 1.2);
        pen.brow(1, 1.3, -1.5, -1.0, -0.8, 1.2);
        pen.curve(pen.mouth, -W * 0.5, U * 0.45, 0, -U * 0.25, W * 0.5, U * 0.45, 1.1);
    },
    // 까불: one big eye, one wink, open grin with tongue
    (pen) => {
        pen.cheeks(1.15);
        pen.fill(pen.eyes[0], ellipsePath(0, 0, U * 1.1, U * 1.26), EYE_COLOR);
        pen.fill(pen.eyes[0], ellipsePath(-U * 0.3, -U * 0.4, U * 0.4, U * 0.4), GLINT_COLOR);
        pen.fill(pen.eyes[0], ellipsePath(U * 0.35, U * 0.4, U * 0.17, U * 0.17), GLINT_COLOR, 0.85);
        pen.arcUp(1, 1.2);
        pen.openMouth(W * 0.75, U * 1.4, true);
    },
    // 다정: closed upward-arched eyes, big blush, small smile
    (pen) => {
        pen.cheeks(1.4);
        pen.arcUp(0);
        pen.arcUp(1);
        pen.smile(W * 0.6, W * 0.95, 1.15);
    },
];

const TEMPERAMENT_ID = (index) => 'temperament-' + index;
// Face id -> how to draw it. The lists below derive from this one table, in this order.
const DEFINITIONS = new Map([
    ...Object.entries(STATE_DEFINITIONS),
    ...TEMPERAMENT_DEFINITIONS.map((define, index) => [TEMPERAMENT_ID(index), define]),
]);

export const STATE_FACES = Object.freeze(Object.keys(STATE_DEFINITIONS));
export const TEMPERAMENT_FACES = Object.freeze(TEMPERAMENT_DEFINITIONS.map((_define, index) => TEMPERAMENT_ID(index)));
export const FACE_IDS = Object.freeze([...STATE_FACES, ...TEMPERAMENT_FACES]);

function buildFaceParts(faceId) {
    const DEFINE = DEFINITIONS.get(faceId);
    if (!DEFINE) {
        throw new RangeError('Unknown face: ' + faceId);
    }
    const PEN = new FacePen();
    DEFINE(PEN);
    return {
        eyes: PEN.eyes.map((operations) => Object.freeze(mergeByStyle(operations))),
        mouth: Object.freeze(mergeByStyle(PEN.mouth)),
        cheeks: Object.freeze(PEN.cheekLook),
    };
}

// A face is three parts placed on the body's anchors: the left eye and the right eye around their eye points and the
// mouth around the mouth point, plus a pair of cheeks. Part geometry is in eye-gap units (the distance between the
// eyes is 1) with the part's own point at the origin, so every body shares the same parts; a body only moves
// and scales them. Returns { eyes: [ops, ops], mouth: ops, cheeks: { scale, opacity } }, ops as in buildFace.
const PARTS_CACHE = new Map();
export function faceParts(faceId) {
    let parts = PARTS_CACHE.get(faceId);
    if (!parts) {
        parts = Object.freeze(buildFaceParts(faceId));
        PARTS_CACHE.set(faceId, parts);
    }
    return parts;
}
// Where a part's origin sits and how big one eye-gap unit is, for one body's anchors.
export function facePartPlacement(anchor) {
    const GAP = anchor.eyeRight[0] - anchor.eyeLeft[0];
    return { gap: GAP, origins: [anchor.eyeLeft, anchor.eyeRight, anchor.mouth] };
}
// The two cheek ellipses in the body's canvas: [cx, cy, rx, ry] each.
export function cheekEllipses(anchor, cheeks) {
    const GAP = anchor.eyeRight[0] - anchor.eyeLeft[0],
        RX = GAP * 0.2 * cheeks.scale,
        Y = anchor.mouth[1] + GAP * 0.05;
    return [
        [anchor.eyeLeft[0] - GAP * 0.2, Y, RX, RX * CHEEK_ASPECT],
        [anchor.eyeRight[0] + GAP * 0.2, Y, RX, RX * CHEEK_ASPECT],
    ];
}

// anchor: { eyeLeft: [x, y], eyeRight: [x, y], mouth: [x, y] } in the body's canvas.
// cheekColor: the colour of the cheeks, or null for DEFAULT_CHEEK_COLOR.
// Returns draw operations in the body's canvas: { fill | stroke: colour, path: [[command, ...NUMBERS]], width?, opacity? }.
export function buildFace(faceId, anchor, cheekColor = null) {
    const PARTS = faceParts(faceId),
        { gap: GAP, origins: ORIGINS } = facePartPlacement(anchor),
        OPS = cheekEllipses(anchor, PARTS.cheeks).map(([cx, cy, rx, ry]) => ({
            fill: cheekColor ?? DEFAULT_CHEEK_COLOR,
            path: ellipsePath(cx, cy, rx, ry),
            opacity: PARTS.cheeks.opacity,
        }));
    for (const [INDEX, PART] of [...PARTS.eyes, PARTS.mouth].entries()) {
        const [OX, OY] = ORIGINS[INDEX];
        for (const OP of PART) {
            OPS.push({
                ...OP,
                path: OP.path.map(([command, ...numbers]) => [
                    command,
                    ...numbers.map((value, index) => (index % 2 ? OY : OX) + value * GAP),
                ]),
                ...(OP.width ? { width: OP.width * GAP } : {}),
            });
        }
    }
    return mergeByStyle(OPS);
}

// SVG markup of the same face, for portraits that are plain SVG images.
export function faceSvg(faceId, anchor, cheekColor = null) {
    const D = (path) =>
        path.map(([command, ...numbers]) => command + numbers.map((n) => +n.toFixed(2)).join(' ')).join('');
    return buildFace(faceId, anchor, cheekColor)
        .map((op) =>
            op.fill
                ? `<path d="${D(op.path)}" fill="${op.fill}"${op.opacity < 1 ? ` opacity="${op.opacity}"` : ''}/>`
                : `<path d="${D(op.path)}" fill="none" stroke="${op.stroke}" stroke-width="${+op.width.toFixed(2)}" stroke-linecap="round" stroke-linejoin="round"/>`,
        )
        .join('');
}

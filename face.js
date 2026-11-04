// modules/face/geometry.js
var EYE_COLOR = "#4a2420";
var INK_COLOR = "#2c1c18";
var GLINT_COLOR = "#fff5d8";
var TONGUE_COLOR = "#e9776b";
var ELLIPSE_KAPPA = 0.5522847498;
var CHEEK_ASPECT = 0.62;
var STROKE_WIDTH = 0.055;
var U = 0.165;
var W = 0.19;
var DEFAULT_CHEEK_COLOR = "#ec8070";
function ellipsePath(cx, cy, rx, ry) {
  const KX = rx * ELLIPSE_KAPPA, KY = ry * ELLIPSE_KAPPA;
  return [
    ["M", cx + rx, cy],
    ["C", cx + rx, cy + KY, cx + KX, cy + ry, cx, cy + ry],
    ["C", cx - KX, cy + ry, cx - rx, cy + KY, cx - rx, cy],
    ["C", cx - rx, cy - KY, cx - KX, cy - ry, cx, cy - ry],
    ["C", cx + KX, cy - ry, cx + rx, cy - KY, cx + rx, cy],
    ["Z"]
  ];
}
function operationBox(operation) {
  const PAD = operation.width ? operation.width / 2 : 0, BOX = [Infinity, Infinity, -Infinity, -Infinity];
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
var STYLE_OF = (operation) => operation.fill ? "f" + operation.fill + "/" + operation.opacity : "s" + operation.stroke + "/" + operation.width;
var OVERLAPS = (a, b) => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];
function mergeByStyle(operations) {
  const MERGED = [];
  for (const OPERATION of operations) {
    const ENTRY = { operation: { ...OPERATION, path: [...OPERATION.path] }, box: operationBox(OPERATION) }, STYLE = STYLE_OF(OPERATION);
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
        Math.max(target.box[3], ENTRY.box[3])
      ];
    } else {
      MERGED.push(ENTRY);
    }
  }
  return MERGED.map((entry) => entry.operation);
}
var FacePen = class {
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
        ["M", x1, y1],
        ["L", x2, y2]
      ],
      scale
    );
  }
  curve(part, x1, y1, cx, cy, x2, y2, scale) {
    this.stroke(
      part,
      [
        ["M", x1, y1],
        ["Q", cx, cy, x2, y2]
      ],
      scale
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
        ["M", -half, -U * 0.1],
        ["Q", 0, -U * 0.1, half, -U * 0.1],
        ["Q", half * 0.8, depth, 0, depth + U * 0.05],
        ["Q", -half * 0.8, depth, -half, -U * 0.1],
        ["Z"]
      ],
      INK_COLOR
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
};
var STATE_DEFINITIONS = {
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
          ["M", -U * 1.05, -U * 0.1],
          ["Q", -U * 1.05, U * 0.85, 0, U * 0.85],
          ["Q", U * 1.05, U * 0.85, U * 1.05, -U * 0.1],
          ["Z"]
        ],
        EYE_COLOR
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
        ["M", -W * 0.62, -U * 0.05],
        ["L", W * 0.62, -U * 0.05],
        ["L", W * 0.62, U * 0.4],
        ["L", -W * 0.62, U * 0.4],
        ["Z"]
      ],
      "#ffffff"
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
        ["M", -U * 0.9, -U * 0.8],
        ["L", U * 0.8, 0],
        ["L", -U * 0.9, U * 0.8]
      ],
      1.3
    );
    pen.stroke(
      pen.eyes[1],
      [
        ["M", U * 0.9, -U * 0.8],
        ["L", -U * 0.8, 0],
        ["L", U * 0.9, U * 0.8]
      ],
      1.3
    );
    pen.stroke(
      pen.mouth,
      [
        ["M", -W * 0.8, U * 0.3],
        ["Q", -W * 0.4, -U * 0.35, 0, U * 0.3],
        ["Q", W * 0.4, U * 0.95, W * 0.8, U * 0.3]
      ],
      1.1
    );
  },
  hungry(pen) {
    pen.cheeks(1, 0.6);
    for (const EYE of pen.eyes) {
      pen.fill(EYE, ellipsePath(0, U * 0.15, U * 0.95, U * 0.84), EYE_COLOR);
      pen.fill(EYE, ellipsePath(-0.25 * U, -0.05 * U, U * 0.3, U * 0.3), GLINT_COLOR);
    }
    pen.brow(-1, -1.1, -1, 1, -1.5, 0.9);
    pen.brow(1, 1.1, -1, -1, -1.5, 0.9);
    pen.curve(pen.mouth, -W * 0.5, U * 0.5, 0, -U * 0.2, W * 0.5, U * 0.5, 1.1);
  },
  dead(pen) {
    pen.cheeks(1, 0.5);
    for (const EYE of pen.eyes) {
      pen.line(EYE, -U * 0.8, -U * 0.8, U * 0.8, U * 0.8, 1.2);
      pen.line(EYE, U * 0.8, -U * 0.8, -U * 0.8, U * 0.8, 1.2);
    }
    pen.line(pen.mouth, -W * 0.45, U * 0.2, W * 0.45, U * 0.2, 1.1);
  }
};
var TEMPERAMENT_DEFINITIONS = [
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
    pen.brow(-1, -1.1, -1, 0.9, -1.7, 0.95);
    pen.brow(1, 1.1, -1, -0.9, -1.7, 0.95);
    pen.stroke(
      pen.mouth,
      [
        ["M", -W * 0.55, U * 0.3],
        ["Q", -W * 0.28, -U * 0.15, 0, U * 0.3],
        ["Q", W * 0.28, U * 0.75, W * 0.55, U * 0.3]
      ],
      1
    );
  },
  // 발끈: slanted brows, round dark eyes, pout
  (pen) => {
    pen.cheeks(1.15);
    for (const EYE of pen.eyes) {
      pen.fill(EYE, ellipsePath(0, U * 0.1, U * 0.9, U * 0.9), EYE_COLOR);
    }
    pen.brow(-1, -1.3, -1.5, 1, -0.8, 1.2);
    pen.brow(1, 1.3, -1.5, -1, -0.8, 1.2);
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
  }
];
var TEMPERAMENT_ID = (index) => "temperament-" + index;
var DEFINITIONS = new Map([
  ...Object.entries(STATE_DEFINITIONS),
  ...TEMPERAMENT_DEFINITIONS.map((define, index) => [TEMPERAMENT_ID(index), define])
]);
var STATE_FACES = Object.freeze(Object.keys(STATE_DEFINITIONS));
var TEMPERAMENT_FACES = Object.freeze(TEMPERAMENT_DEFINITIONS.map((_define, index) => TEMPERAMENT_ID(index)));
var FACE_IDS = Object.freeze([...STATE_FACES, ...TEMPERAMENT_FACES]);
function buildFaceParts(faceId) {
  const DEFINE = DEFINITIONS.get(faceId);
  if (!DEFINE) {
    throw new RangeError("Unknown face: " + faceId);
  }
  const PEN = new FacePen();
  DEFINE(PEN);
  return {
    eyes: PEN.eyes.map((operations) => Object.freeze(mergeByStyle(operations))),
    mouth: Object.freeze(mergeByStyle(PEN.mouth)),
    cheeks: Object.freeze(PEN.cheekLook)
  };
}
var PARTS_CACHE = /* @__PURE__ */ new Map();
function faceParts(faceId) {
  let parts = PARTS_CACHE.get(faceId);
  if (!parts) {
    parts = Object.freeze(buildFaceParts(faceId));
    PARTS_CACHE.set(faceId, parts);
  }
  return parts;
}
function facePartPlacement(anchor) {
  const GAP = anchor.eyeRight[0] - anchor.eyeLeft[0];
  return { gap: GAP, origins: [anchor.eyeLeft, anchor.eyeRight, anchor.mouth] };
}
function cheekEllipses(anchor, cheeks) {
  const GAP = anchor.eyeRight[0] - anchor.eyeLeft[0], RX = GAP * 0.2 * cheeks.scale, Y = anchor.mouth[1] + GAP * 0.05;
  return [
    [anchor.eyeLeft[0] - GAP * 0.2, Y, RX, RX * CHEEK_ASPECT],
    [anchor.eyeRight[0] + GAP * 0.2, Y, RX, RX * CHEEK_ASPECT]
  ];
}
function buildFace(faceId, anchor, cheekColor = null) {
  const PARTS = faceParts(faceId), { gap: GAP, origins: ORIGINS } = facePartPlacement(anchor), OPS = cheekEllipses(anchor, PARTS.cheeks).map(([cx, cy, rx, ry]) => ({
    fill: cheekColor ?? DEFAULT_CHEEK_COLOR,
    path: ellipsePath(cx, cy, rx, ry),
    opacity: PARTS.cheeks.opacity
  }));
  for (const [INDEX, PART] of [...PARTS.eyes, PARTS.mouth].entries()) {
    const [OX, OY] = ORIGINS[INDEX];
    for (const OP of PART) {
      OPS.push({
        ...OP,
        path: OP.path.map(([command, ...numbers]) => [
          command,
          ...numbers.map((value, index) => (index % 2 ? OY : OX) + value * GAP)
        ]),
        ...OP.width ? { width: OP.width * GAP } : {}
      });
    }
  }
  return mergeByStyle(OPS);
}
function faceSvg(faceId, anchor, cheekColor = null) {
  const D = (path) => path.map(([command, ...numbers]) => command + numbers.map((n) => +n.toFixed(2)).join(" ")).join("");
  return buildFace(faceId, anchor, cheekColor).map(
    (op) => op.fill ? `<path d="${D(op.path)}" fill="${op.fill}"${op.opacity < 1 ? ` opacity="${op.opacity}"` : ""}/>` : `<path d="${D(op.path)}" fill="none" stroke="${op.stroke}" stroke-width="${+op.width.toFixed(2)}" stroke-linecap="round" stroke-linejoin="round"/>`
  ).join("");
}

// modules/face/body.js
var FACE_SOCKETS = Object.freeze(["face-eye-left", "face-eye-right", "face-mouth"]);
var ANCHORS = /* @__PURE__ */ new WeakMap();
function faceAnchor(compiled) {
  let anchor = ANCHORS.get(compiled);
  if (!anchor) {
    const SOCKETS = compiled.metadata.sockets, POINT = (id) => {
      const SOCKET = SOCKETS[id];
      if (!SOCKET) {
        throw new Error("Body is missing face socket " + id + " (" + compiled.sourcePath + ")");
      }
      return SOCKET.point;
    };
    anchor = Object.freeze({
      eyeLeft: POINT(FACE_SOCKETS[0]),
      eyeRight: POINT(FACE_SOCKETS[1]),
      mouth: POINT(FACE_SOCKETS[2])
    });
    ANCHORS.set(compiled, anchor);
  }
  return anchor;
}
function posedFace(actor, rest, out) {
  const EL = actor.getSocket(FACE_SOCKETS[0]), ER = actor.getSocket(FACE_SOCKETS[1]), MO = actor.getSocket(FACE_SOCKETS[2]);
  const U1X = rest.eyeRight[0] - rest.eyeLeft[0], U1Y = rest.eyeRight[1] - rest.eyeLeft[1], U2X = rest.mouth[0] - rest.eyeLeft[0], U2Y = rest.mouth[1] - rest.eyeLeft[1], V1X = ER.x - EL.x, V1Y = ER.y - EL.y, V2X = MO.x - EL.x, V2Y = MO.y - EL.y, DET = U1X * U2Y - U1Y * U2X;
  out[0] = (V1X * U2Y - V2X * U1Y) / DET;
  out[1] = (V1Y * U2Y - V2Y * U1Y) / DET;
  out[2] = (V2X * U1X - V1X * U2X) / DET;
  out[3] = (V2Y * U1X - V1Y * U2X) / DET;
  out[4] = EL.x - (out[0] * rest.eyeLeft[0] + out[2] * rest.eyeLeft[1]);
  out[5] = EL.y - (out[1] * rest.eyeLeft[0] + out[3] * rest.eyeLeft[1]);
  return out;
}

// modules/face/overlay.js
var FACE_PART_PIXELS = 128;
var CHEEK_PIXELS = 64;
var MAX_DISPLAY_TO_IMAGE_SCALE = 0.5;
var CHEEK_OPERATIONS = Object.freeze([{ fill: "#ffffff", opacity: 1, path: ellipsePath(0, 0, 1, 1) }]);
function tracePath(target, path) {
  for (const [COMMAND, ...N] of path) {
    if (COMMAND === "M") {
      target.moveTo(N[0], N[1]);
    } else if (COMMAND === "L") {
      target.lineTo(N[0], N[1]);
    } else if (COMMAND === "Q") {
      target.quadraticCurveTo(N[0], N[1], N[2], N[3]);
    } else if (COMMAND === "C") {
      target.bezierCurveTo(N[0], N[1], N[2], N[3], N[4], N[5]);
    } else {
      target.closePath();
    }
  }
}
function drawOperations(ctx, operations, alpha = 1) {
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
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
var PATH_OPERATIONS = /* @__PURE__ */ new WeakMap();
function faceOperations(compiled, faceId, cheekColor) {
  const ANCHOR = faceAnchor(compiled);
  let byKey = PATH_OPERATIONS.get(ANCHOR);
  if (!byKey) {
    byKey = /* @__PURE__ */ new Map();
    PATH_OPERATIONS.set(ANCHOR, byKey);
  }
  const KEY = faceId + ":" + cheekColor;
  let operations = byKey.get(KEY);
  if (!operations) {
    operations = Object.freeze(buildFace(faceId, ANCHOR, cheekColor));
    byKey.set(KEY, operations);
  }
  return operations;
}
function drawFacePaths(ctx, compiled, faceId, cheekColor = null, alpha = 1) {
  drawOperations(ctx, faceOperations(compiled, faceId, cheekColor), alpha);
}
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
    throw new RangeError("A picture needs at least one draw operation");
  }
  const MARGIN = 1 / pixelsPerUnit, X = BOX[0] - MARGIN, Y = BOX[1] - MARGIN, WIDTH = Math.ceil((BOX[2] - BOX[0]) * pixelsPerUnit) + 2, HEIGHT = Math.ceil((BOX[3] - BOX[1]) * pixelsPerUnit) + 2, CANVAS = new OffscreenCanvas(WIDTH, HEIGHT), C = CANVAS.getContext("2d");
  C.setTransform(pixelsPerUnit, 0, 0, pixelsPerUnit, -X * pixelsPerUnit, -Y * pixelsPerUnit);
  C.lineCap = "round";
  C.lineJoin = "round";
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
var OperationImages = class {
  constructor(ctx, pictures) {
    this.ctx = ctx;
    this.pictures = new Map(pictures);
    this.images = /* @__PURE__ */ new Map();
    this.disposed = false;
  }
  get ready() {
    return !this.disposed && this.images.size > 0 && this.ctx.device?.state === "ready";
  }
  has(key) {
    return this.images.has(key);
  }
  // Rasterises and uploads every picture once. Does nothing while the device is not ready, so call it again after the
  // device is up. A failure (such as a full atlas) releases what was uploaded and rethrows, leaving it unprepared.
  prepare() {
    const DEVICE = this.ctx.device;
    if (this.disposed || DEVICE?.state !== "ready" || this.images.size) {
      return;
    }
    const ATLAS = DEVICE.textureAtlas, IMAGES = /* @__PURE__ */ new Map();
    try {
      for (const [KEY, PICTURE] of this.pictures) {
        const RASTER = rasterise(PICTURE.operations, PICTURE.pixelsPerUnit), REGION = ATLAS.allocate(RASTER.canvas.width, RASTER.canvas.height);
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
      throw new RangeError("No such picture is prepared: " + String(key));
    }
    this.ctx.drawRegion(
      IMAGE.region,
      x + IMAGE.x * scaleX,
      y + IMAGE.y * scaleY,
      IMAGE.width * scaleX,
      IMAGE.height * scaleY
    );
  }
  dispose() {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    if (this.ctx.device?.state === "ready") {
      for (const IMAGE of this.images.values()) {
        IMAGE.region.atlas.release(IMAGE.region);
      }
    }
    this.images.clear();
  }
};
var FaceOverlay = class {
  constructor(ctx, { faces = FACE_IDS } = {}) {
    this.ctx = ctx;
    this.posed = [0, 0, 0, 0, 0, 0];
    const PICTURES = /* @__PURE__ */ new Map();
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
    const C = this.ctx, ANCHOR = faceAnchor(compiled), P = posedFace(actor, ANCHOR, this.posed);
    C.save();
    C.transform(matrix[0], matrix[1], matrix[2], matrix[3], matrix[4], matrix[5]);
    C.transform(P[0], P[1], P[2], P[3], P[4], P[5]);
    const PIXELS_PER_UNIT = Math.hypot(matrix[0], matrix[1]) * Math.hypot(P[0], P[1]), BAKED = this.drawImages(ANCHOR, faceId, alpha, cheekColor, PIXELS_PER_UNIT);
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
    const PARTS = faceParts(faceId), IMAGES = this.images, C = this.ctx;
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
};
export {
  DEFAULT_CHEEK_COLOR,
  FACE_IDS,
  FACE_SOCKETS,
  FaceOverlay,
  OperationImages,
  STATE_FACES,
  TEMPERAMENT_FACES,
  buildFace,
  cheekEllipses,
  drawFacePaths,
  drawOperations,
  ellipsePath,
  faceAnchor,
  facePartPlacement,
  faceParts,
  faceSvg,
  posedFace
};

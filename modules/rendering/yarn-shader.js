const STRIDE_FLOATS = 9;
const STRIDE_BYTES = STRIDE_FLOATS * 4;
const MAX_SURFACES = 512;
const DEFAULT_LIMIT_BYTES = 32 * 1024 * 1024;
const ATTRIBUTES = [
    {
        name: 'a_position',
        size: 2,
        offset: 0,
    },
    {
        name: 'a_color',
        size: 4,
        offset: 8,
    },
    {
        name: 'a_surface',
        size: 3,
        offset: 24,
    },
];
const IDENTITY = Object.freeze([1, 0, 0, 1, 0, 0]);
const WHITE = Object.freeze([1, 1, 1, 1]);
const VERTEX = `
attribute vec2 a_position;
attribute vec4 a_color;
attribute vec3 a_surface;
uniform mat3 u_projection;
uniform mat3 u_transform;
uniform float u_depth;
varying vec2 v_position;
varying vec2 v_world;
varying vec4 v_color;
varying vec3 v_surface;
void main() {
  vec3 world = u_transform * vec3(a_position, 1.0);
  vec3 projected = u_projection * world;
  gl_Position = vec4(projected.xy, u_depth * projected.z, projected.z);
  v_position = a_position;
  v_world = world.xy / world.z;
  v_color = a_color;
  v_surface = a_surface;
}`;
const VERTEX_WORLD = `
attribute vec2 a_position;
attribute vec4 a_color;
attribute vec3 a_surface;
uniform mat4 u_viewProjection;
uniform mat4 u_worldMatrix;
uniform mat3 u_transform;
uniform float u_depth;
varying vec2 v_position;
varying vec2 v_world;
varying vec4 v_color;
varying vec3 v_surface;
void main() {
  vec3 plane = u_transform * vec3(a_position, 1.0);
  vec4 world = u_worldMatrix * vec4(plane.xy / plane.z, 0.0, 1.0);
  vec4 projected = u_viewProjection * world;
  projected.z += u_depth * projected.w;
  gl_Position = projected;
  v_position = a_position;
  v_world = world.xy / world.w;
  v_color = a_color;
  v_surface = a_surface;
}`;
function fragment(kind, maxClipPlanes) {
    const CLIPS = maxClipPlanes
        ? `
uniform vec3 u_planes[${maxClipPlanes}];
void clipWorld() {
  for (int i = 0; i < ${maxClipPlanes}; i++) {
    vec3 plane = u_planes[i];
    if (dot(plane.xy, plane.xy) > 0.0000001 && dot(plane, vec3(v_world, 1.0)) < 0.0) discard;
  }
}`
        : 'void clipWorld() {}';
    const BODY = kind === 'yarn' ? YARN_FRAGMENT_BODY : SKETCH_FRAGMENT_BODY;
    return `precision mediump float;
varying vec2 v_position; varying vec2 v_world; varying vec4 v_color; varying vec3 v_surface;
uniform vec4 u_bounds; uniform vec4 u_effect0; uniform vec4 u_effect1; uniform vec4 u_effect2; uniform vec4 u_effect3;
uniform vec4 u_tint; uniform float u_flash; uniform float u_forceColor;
${kind === 'sketch' ? 'uniform float u_timeMs;' : 'uniform sampler2D u_stitchField;'}
${CLIPS}
float hashCell(vec2 cell, float salt) {
  return fract(sin(dot(cell, vec2(127.1, 311.7)) + u_effect0.x * 74.7 + salt * 19.19) * 43758.5453);
}
float segmentDistance(vec2 p, vec2 a, vec2 b) {
  vec2 delta = b - a;
  float denom = max(dot(delta, delta), 0.000001);
  float t = clamp(dot(p - a, delta) / denom, 0.0, 1.0);
  return length(p - (a + delta * t));
}
vec2 cubicPoint(float t, vec2 a, vec2 b, vec2 c, vec2 d) {
  float s = 1.0 - t;
  return s*s*s*a + 3.0*s*s*t*b + 3.0*s*t*t*c + t*t*t*d;
}
float cubicDistance(vec2 p, vec2 a, vec2 b, vec2 c, vec2 d) {
  float result = 100000.0;
  vec2 previous = a;
  for (int i = 1; i <= 5; i++) {
    vec2 next = cubicPoint(float(i) * 0.2, a, b, c, d);
    result = min(result, segmentDistance(p, previous, next));
    previous = next;
  }
  return result;
}
float lineMask(float distanceToLine, float width) {
  float aa = max(width * 0.16, 0.025);
  return 1.0 - smoothstep(max(0.0, width * 0.5 - aa), width * 0.5 + aa, distanceToLine);
}
vec3 tintTo(vec3 base, float amount) {
  return amount < 0.0 ? mix(base, vec3(0.0), -amount) : mix(base, vec3(1.0), amount);
}
${BODY}
void main() {
  clipWorld();
  float alpha = mix(v_color.a, 1.0, u_forceColor) * u_tint.a;
  if (alpha <= 0.0001) discard;
  vec3 base = mix(mix(v_color.rgb * u_tint.rgb, u_tint.rgb, u_forceColor), vec3(1.0), clamp(u_flash, 0.0, 1.0));
  vec3 rgb = base;
  float effect = v_surface.x;
  if (effect < 0.5) {
    ${kind === 'yarn' ? 'rgb = shadeYarnFill(rgb);' : 'rgb = shadeSketchFill(rgb);'}
    gl_FragColor = vec4(rgb * alpha, alpha);
    return;
  }
  ${kind === 'yarn' ? 'shadeYarnEdge(rgb, alpha);' : 'shadeSketchEdge(rgb, alpha);'}
}`;
}
// The stitch fill evaluates the same few curves for every pixel: two strands, an underside curve and two twist
// segments, each at a handful of offsets. Their distances depend only on the position inside one stitch cell, so one
// small texture shared by every yarn surface holds them. R = min(left, right strand), G = underside, B = twist
// (min of the two segments), each in cell-normalized units divided by STITCH_FIELD_MAX_DISTANCE. Strand masks are
// max(lineMask(left), lineMask(right)) = lineMask(min(left, right)), so three samples replace seven curve evaluations.
const STITCH_FIELD_SIZE = 256;
const STITCH_FIELD_EXTENT = 0.8;
const STITCH_FIELD_MAX_DISTANCE = 0.25;
const STITCH_STRANDS = {
    left: [
        [-0.34, -0.36],
        [-0.32, -0.06],
        [-0.18, 0.17],
        [-0.025, 0.34],
    ],
    right: [
        [0.34, -0.36],
        [0.32, -0.06],
        [0.18, 0.17],
        [0.025, 0.34],
    ],
    under: [
        [-0.48, -0.46],
        [-0.22, -0.57],
        [0.22, -0.57],
        [0.48, -0.46],
    ],
};
const STITCH_TWISTS = [
    [
        [-0.32, -0.12],
        [-0.16, -0.13],
    ],
    [
        [0.22, 0.18],
        [0.37, 0.08],
    ],
];
let stitchFieldCache = null;
function stitchSegmentDistance(px, py, a, b) {
    const DX = b[0] - a[0],
        DY = b[1] - a[1];
    const T = Math.max(0, Math.min(1, ((px - a[0]) * DX + (py - a[1]) * DY) / Math.max(DX * DX + DY * DY, 1e-6)));
    return Math.hypot(px - (a[0] + DX * T), py - (a[1] + DY * T));
}
// A cubic is measured as the five-segment polyline the shader used before the field.
function stitchPolyline([a, b, c, d]) {
    const POINTS = [a];
    for (let i = 1; i <= 5; i++) {
        const T = i * 0.2,
            S = 1 - T;
        POINTS.push([
            S * S * S * a[0] + 3 * S * S * T * b[0] + 3 * S * T * T * c[0] + T * T * T * d[0],
            S * S * S * a[1] + 3 * S * S * T * b[1] + 3 * S * T * T * c[1] + T * T * T * d[1],
        ]);
    }
    return POINTS;
}
function stitchPolylineDistance(points, px, py) {
    let best = Infinity;
    for (let i = 1; i < points.length; i++) {
        best = Math.min(best, stitchSegmentDistance(px, py, points[i - 1], points[i]));
    }
    return best;
}
function stitchFieldPixels() {
    if (stitchFieldCache) {
        return stitchFieldCache;
    }
    const N = STITCH_FIELD_SIZE;
    const LEFT = stitchPolyline(STITCH_STRANDS.left),
        RIGHT = stitchPolyline(STITCH_STRANDS.right),
        UNDER = stitchPolyline(STITCH_STRANDS.under);
    const PACK = (distance) => Math.round(Math.min(1, distance / STITCH_FIELD_MAX_DISTANCE) * 255);
    const DATA = new Uint8Array(N * N * 4);
    for (let j = 0; j < N; j++) {
        for (let i = 0; i < N; i++) {
            const QX = -STITCH_FIELD_EXTENT + ((i + 0.5) / N) * STITCH_FIELD_EXTENT * 2,
                QY = -STITCH_FIELD_EXTENT + ((j + 0.5) / N) * STITCH_FIELD_EXTENT * 2;
            const AT = (j * N + i) * 4;
            DATA[AT] = PACK(Math.min(stitchPolylineDistance(LEFT, QX, QY), stitchPolylineDistance(RIGHT, QX, QY)));
            DATA[AT + 1] = PACK(stitchPolylineDistance(UNDER, QX, QY));
            DATA[AT + 2] = PACK(
                Math.min(
                    stitchSegmentDistance(QX, QY, STITCH_TWISTS[0][0], STITCH_TWISTS[0][1]),
                    stitchSegmentDistance(QX, QY, STITCH_TWISTS[1][0], STITCH_TWISTS[1][1]),
                ),
            );
            DATA[AT + 3] = 255;
        }
    }
    stitchFieldCache = DATA;
    return DATA;
}
const YARN_FRAGMENT_BODY = `
vec3 shadeYarnFill(vec3 base) {
  float stitchWidth = abs(u_effect0.y), stitchHeight = u_effect0.z;
  if (u_effect0.w < 0.0 || stitchWidth <= 0.0 || stitchHeight <= 0.0) return base;
  float cols = max(2.0, ceil(u_bounds.z / stitchWidth));
  float rows = max(2.0, ceil(u_bounds.w / stitchHeight));
  float sx = u_bounds.z / cols, sy = u_bounds.w / rows;
  vec2 local = v_position;
  if (u_effect3.z > 0.5) {
    float rx = max(u_bounds.z * 0.5, 0.0001), ry = max(u_bounds.w * 0.5, 0.0001);
    float nx = clamp((local.x - (u_bounds.x + rx)) / rx, -1.35, 1.35);
    float ny = (local.y - (u_bounds.y + ry)) / ry;
    local.x += (sin(nx * 1.1) / 0.89120736 - nx) * rx;
    local.y += ry * 0.13 * nx * nx * (1.0 - ny * 0.24);
  }
  vec2 cell = (local - u_bounds.xy) / vec2(sx, sy);
  vec2 index = floor(cell);
  float jitterX = (hashCell(index, 71.0) - 0.5) * u_effect1.x;
  float jitterY = (hashCell(index, 39.0) - 0.5) * u_effect1.x;
  float scaleX = 1.0 + (hashCell(index, 57.0) - 0.5) * u_effect1.x;
  float scaleY = 1.0 + (hashCell(index, 91.0) - 0.5) * u_effect1.x;
  vec2 p = (fract(cell) - vec2(0.5 + jitterX, 0.5 + jitterY)) / vec2(scaleX, scaleY);
  p *= vec2(sx, sy);
  float stroke = min(sx, sy) * (abs(u_effect0.w) / stitchHeight);
  vec2 cellSize = vec2(sx, sy);
  float fieldScale = ${STITCH_FIELD_MAX_DISTANCE.toFixed(4)} * sqrt(sx * sy);
  vec2 qBase = p / cellSize;
  vec2 grooveShift = vec2(0.0, stroke * 0.06) / cellSize;
  vec2 lightShift = vec2(stroke * 0.14, stroke * 0.13) / cellSize;
  vec4 fieldMain = texture2D(u_stitchField, (qBase + ${STITCH_FIELD_EXTENT.toFixed(4)}) / ${(STITCH_FIELD_EXTENT * 2).toFixed(4)});
  vec4 fieldGroove = texture2D(u_stitchField, (qBase - grooveShift + ${STITCH_FIELD_EXTENT.toFixed(4)}) / ${(STITCH_FIELD_EXTENT * 2).toFixed(4)});
  vec4 fieldLight = texture2D(u_stitchField, (qBase + lightShift + ${STITCH_FIELD_EXTENT.toFixed(4)}) / ${(STITCH_FIELD_EXTENT * 2).toFixed(4)});
  float under = lineMask(fieldGroove.g * fieldScale, stroke*0.5) * 0.5;
  float groove = lineMask(fieldGroove.r * fieldScale, stroke*1.08) * 0.85;
  float yarn = lineMask(fieldMain.r * fieldScale, stroke*0.89);
  float light = lineMask(fieldLight.r * fieldScale, stroke*0.34) * 0.57;
  float twist = 0.0;
  if (mod(index.x + index.y, 2.0) < 1.0) {
    twist = lineMask(fieldMain.b * fieldScale, stroke*0.075) * 0.5;
  }
  vec3 dark = tintTo(base,-0.28), grooveColor = tintTo(base,-u_effect1.y);
  vec3 yarnColor = tintTo(base,0.10), highlight = tintTo(base,0.38);
  vec3 color = mix(base,dark,under);
  color = mix(color,grooveColor,groove);
  color = mix(color,yarnColor,yarn);
  color = mix(color,highlight,max(light*0.57,twist));
  return color;
}
void shadeYarnEdge(inout vec3 rgb, float alpha) {
  float radial = v_surface.z;
  float along = v_surface.y * u_effect3.y;
  float edgeWidth = u_effect1.w;
  float lobe = fract(along / max(u_effect1.z, 0.001));
  float relief = min(u_effect3.w, edgeWidth * 0.75);
  float wave = sin(lobe * 6.2831853) * relief * 0.35;
  float seam = lineMask(abs(radial - wave),edgeWidth*0.56);
  float seamDark = lineMask(abs(radial - wave - edgeWidth*0.06),edgeWidth*0.8)*0.7;
  float seamLight = lineMask(abs(radial - wave + edgeWidth*0.09),edgeWidth*0.17)*0.55;
  float spacing = max(u_effect2.x,0.001);
  float fiberIndex = floor(along / spacing);
  float jitter = hashCell(vec2(fiberIndex,0.0),22.0);
  float start = spacing * (fiberIndex + 0.22 + jitter * 0.48);
  float randomLength = 0.45 + hashCell(vec2(fiberIndex,0.0),5.0) * 0.95;
  float lengthLimit = min(u_effect2.y,max(u_bounds.z,u_bounds.w)*0.12)*randomLength;
  float lean = (hashCell(vec2(fiberIndex,0.0),14.0)-0.5)*lengthLimit*1.5;
  float alongDistance = abs(along - start - lean * clamp(radial/max(lengthLimit,0.001),0.0,1.0));
  float fiber = 0.0;
  if (u_effect3.x > 0.0 && fiberIndex < u_effect3.x && radial >= 0.0 && radial <= lengthLimit) {
    fiber = lineMask(alongDistance,u_effect2.z);
  }
  float coverage = max(max(seam,seamDark*0.6),max(seamLight,fiber*u_effect2.w));
  if (coverage < 0.012) discard;
  vec3 dark=tintTo(rgb,-0.28), yarn=tintTo(rgb,0.10), light=tintTo(rgb,0.38);
  rgb=mix(rgb,dark,seamDark*0.7);
  rgb=mix(rgb,yarn,seam);
  rgb=mix(rgb,light,max(seamLight,fiber*0.7));
  float outAlpha=alpha*coverage;
  gl_FragColor=vec4(rgb*outAlpha,outAlpha);
}`;
const SKETCH_FRAGMENT_BODY = `
vec3 shadeSketchFill(vec3 base) {
  float angle=u_effect2.z, spacing=max(u_effect2.w,0.001);
  vec2 direction=vec2(cos(angle),sin(angle));
  float phase=dot(v_position,direction)/spacing + hashCell(vec2(u_effect0.x,0.0),31.0);
  float distanceToHatch=abs(fract(phase)-0.5)*spacing;
  float hatch=lineMask(distanceToHatch,u_effect2.x)*u_effect2.y;
  return mix(base,tintTo(base,-0.48),hatch);
}
void shadeSketchEdge(inout vec3 rgb, float alpha) {
  float phase=mod(u_timeMs,max(u_effect0.y,16.0))/max(u_effect0.y,16.0)*6.2831853;
  float wobble=sin(v_surface.y*u_effect0.z*6.2831853+phase+u_effect0.x)*u_effect1.x;
  float offset=(u_effect1.y+wobble);
  float echo=lineMask(abs(v_surface.z-offset),u_effect1.z)*u_effect1.w;
  if(echo<0.012)discard;
  rgb=mix(rgb,tintTo(rgb,-0.52),echo);
  float outAlpha=alpha*echo;
  gl_FragColor=vec4(rgb*outAlpha,outAlpha);
}`;
function finiteArray(value, count, name) {
    if (!value || value.length !== count || Array.from(value).some((number) => !Number.isFinite(number))) {
        throw new TypeError(`${name} needs ${count} finite numbers`);
    }
}
function validateStyle(style) {
    if (!style || typeof style !== 'object' || Array.isArray(style)) {
        throw new TypeError('A complete SVG-authored yarn or sketch style is required');
    }
    const YARN_REQUIRED = [
        'seed',
        'stitchWidth',
        'stitchHeight',
        'thickness',
        'irregularity',
        'contrast',
        'edgeSpacing',
        'edgeRelief',
        'edgeWidth',
        'fiberLength',
        'fiberWidth',
        'fiberOpacity',
        'fiberMax',
    ];
    const SKETCH_REQUIRED = [
        'seed',
        'periodMs',
        'amplitude',
        'frequency',
        'echoX',
        'echoY',
        'echoWidth',
        'echoOpacity',
        'hatchAngle',
        'hatchSpacing',
        'hatchWidth',
        'hatchOpacity',
    ];
    const FIELDS = style.kind === 'yarn' ? YARN_REQUIRED : style.kind === 'sketch' ? SKETCH_REQUIRED : null;
    if (!FIELDS || FIELDS.some((key) => !Number.isFinite(style[key]))) {
        throw new TypeError('Unsupported or incomplete SVG surface style');
    }
    if (style.seed < 0 || style.seed > 0x7fffffff || !Number.isSafeInteger(style.seed)) {
        throw new RangeError('Surface seed must be a nonnegative 31-bit integer');
    }
    if (style.kind === 'yarn') {
        for (const KEY of [
            'stitchWidth',
            'stitchHeight',
            'thickness',
            'edgeSpacing',
            'edgeRelief',
            'edgeWidth',
            'fiberLength',
            'fiberWidth',
        ]) {
            if (style[KEY] <= 0) {
                throw new RangeError(`Yarn ${KEY} must be positive`);
            }
        }
        for (const KEY of ['irregularity', 'contrast', 'fiberOpacity']) {
            if (style[KEY] < 0 || style[KEY] > 1) {
                throw new RangeError(`Yarn ${KEY} must be in [0,1]`);
            }
        }
        if (!Number.isSafeInteger(style.fiberMax) || style.fiberMax < 0 || style.fiberMax > 512) {
            throw new RangeError('Yarn fiberMax must be an integer from 0 to 512');
        }
        for (const KEY of ['fiberSpacing', 'curved', 'pattern', 'detail', 'fiber']) {
            if (
                style[KEY] !== undefined &&
                (KEY === 'fiberSpacing'
                    ? !Number.isFinite(style[KEY]) || style[KEY] <= 0
                    : typeof style[KEY] !== 'boolean')
            ) {
                throw new TypeError(`Invalid Yarn ${KEY}`);
            }
        }
    } else {
        if (!Number.isSafeInteger(style.periodMs) || style.periodMs < 16 || style.periodMs > 10000) {
            throw new RangeError('Sketch periodMs must be 16..10000');
        }
        for (const KEY of ['amplitude', 'frequency', 'echoWidth', 'hatchSpacing', 'hatchWidth']) {
            if (style[KEY] <= 0) {
                throw new RangeError(`Sketch ${KEY} must be positive`);
            }
        }
        for (const KEY of ['echoOpacity', 'hatchOpacity']) {
            if (style[KEY] < 0 || style[KEY] > 1) {
                throw new RangeError(`Sketch ${KEY} must be in [0,1]`);
            }
        }
    }
}
function normalizeOutline(outline, sourceIndices) {
    if (!(outline instanceof Float32Array || Array.isArray(outline)) || outline.length < 8 || outline.length % 2) {
        throw new TypeError('Closed SVG contour must contain at least four x/y points');
    }
    const POINTS = [];
    for (let i = 0; i < outline.length; i += 2) {
        const X = outline[i],
            Y = outline[i + 1];
        if (!Number.isFinite(X) || !Number.isFinite(Y)) {
            throw new TypeError('SVG contour points must be finite');
        }
        if (!POINTS.length || Math.hypot(X - POINTS.at(-1)[0], Y - POINTS.at(-1)[1]) > 1e-6) {
            POINTS.push([X, Y]);
            sourceIndices?.push(i / 2);
        }
    }
    if (POINTS.length > 4 && Math.hypot(POINTS[0][0] - POINTS.at(-1)[0], POINTS[0][1] - POINTS.at(-1)[1]) < 1e-6) {
        POINTS.pop();
        sourceIndices?.pop();
    }
    if (POINTS.length < 3) {
        throw new TypeError('SVG contour requires at least three distinct points');
    }
    return POINTS;
}
function surfaceGeometry(fillVertices, outline, edgeColors, style) {
    if (!(fillVertices instanceof Float32Array) || fillVertices.length < 18 || fillVertices.length % 18) {
        throw new TypeError('Filled surface requires complete triangles in a six-float position/color layout');
    }
    const SOURCE_INDICES = [],
        POINTS = normalizeOutline(outline, SOURCE_INDICES);
    if (
        edgeColors !== undefined &&
        (!(edgeColors instanceof Float32Array) ||
            (edgeColors.length !== POINTS.length * 4 && edgeColors.length !== outline.length * 2))
    ) {
        throw new TypeError('edgeColors must contain one RGBA color per contour point');
    }
    if (edgeColors && edgeColors.some((value) => !Number.isFinite(value) || value < 0 || value > 1)) {
        throw new RangeError('edgeColors must contain finite RGBA values in [0,1]');
    }
    if (edgeColors && edgeColors.length !== POINTS.length * 4) {
        const ORIGINAL_COLORS = edgeColors;
        edgeColors = Float32Array.from(
            SOURCE_INDICES.flatMap((index) => Array.from(ORIGINAL_COLORS.subarray(index * 4, index * 4 + 4))),
        );
    }
    for (let i = 0; i < fillVertices.length; i++) {
        if (!Number.isFinite(fillVertices[i])) {
            throw new TypeError('Filled surface vertices must be finite');
        }
        const FIELD = i % 6;
        if (FIELD >= 2 && (fillVertices[i] < 0 || fillVertices[i] > 1)) {
            throw new RangeError('Surface colors must be in [0,1]');
        }
    }
    const LENGTHS = [],
        NORMALS = [];
    let total = 0;
    let signedArea = 0;
    for (let i = 0; i < POINTS.length; i++) {
        const A = POINTS[i],
            B = POINTS[(i + 1) % POINTS.length],
            DX = B[0] - A[0],
            DY = B[1] - A[1],
            LENGTH = Math.hypot(DX, DY);
        if (!LENGTH) {
            throw new TypeError('SVG contour cannot contain zero-length edges');
        }
        LENGTHS.push(LENGTH);
        total += LENGTH;
        signedArea += A[0] * B[1] - B[0] * A[1];
        NORMALS.push([DY / LENGTH, -DX / LENGTH]);
    }
    if (Math.abs(signedArea) < 1e-6) {
        throw new TypeError('SVG contour cannot have zero area');
    }
    const WINDING = signedArea >= 0 ? 1 : -1;
    const BOUNDS = [Infinity, Infinity, -Infinity, -Infinity];
    for (let i = 0; i < fillVertices.length; i += 6) {
        BOUNDS[0] = Math.min(BOUNDS[0], fillVertices[i]);
        BOUNDS[1] = Math.min(BOUNDS[1], fillVertices[i + 1]);
        BOUNDS[2] = Math.max(BOUNDS[2], fillVertices[i]);
        BOUNDS[3] = Math.max(BOUNDS[3], fillVertices[i + 1]);
    }
    if (!(BOUNDS[2] > BOUNDS[0] && BOUNDS[3] > BOUNDS[1])) {
        throw new TypeError('Filled surface bounds must have positive area');
    }
    const RGBA = edgeColors
        ? edgeColors
        : (() => {
              const COLOR = [0, 0, 0, 0];
              for (let i = 0; i < fillVertices.length; i += 6) {
                  for (let c = 0; c < 4; c++) {
                      COLOR[c] += fillVertices[i + 2 + c];
                  }
              }
              for (let c = 0; c < 4; c++) {
                  COLOR[c] /= fillVertices.length / 6;
              }
              return Float32Array.from(POINTS.flatMap(() => COLOR));
          })();
    const EDGE_WIDTH =
        style.kind === 'yarn'
            ? style.edgeWidth
            : Math.max(style.echoWidth, Math.hypot(style.echoX, style.echoY) + style.amplitude + style.echoWidth);
    const FIBER_LENGTH = style.kind === 'yarn' && style.fiber !== false ? style.fiberLength : EDGE_WIDTH;
    const FILL_RECORDS = new Float32Array((fillVertices.length / 6) * STRIDE_FLOATS);
    let write = 0;
    for (let i = 0; i < fillVertices.length; i += 6) {
        FILL_RECORDS.set(fillVertices.subarray(i, i + 6), write);
        FILL_RECORDS[write + 6] = 0;
        write += STRIDE_FLOATS;
    }
    const CUMULATIVE = [0];
    for (const LENGTH of LENGTHS) {
        CUMULATIVE.push(CUMULATIVE.at(-1) + LENGTH);
    }
    const RING = [];
    for (let i = 0; i < POINTS.length; i++) {
        const PREVIOUS = NORMALS[(i + POINTS.length - 1) % POINTS.length],
            CURRENT = NORMALS[i];
        let mx = (PREVIOUS[0] + CURRENT[0]) * WINDING;
        let my = (PREVIOUS[1] + CURRENT[1]) * WINDING;
        const MITER_LENGTH = Math.hypot(mx, my);
        if (MITER_LENGTH < 1e-5) {
            mx = CURRENT[0] * WINDING;
            my = CURRENT[1] * WINDING;
        } else {
            mx /= MITER_LENGTH;
            my /= MITER_LENGTH;
        }
        const DENOMINATOR = Math.max(0.25, Math.abs(mx * CURRENT[0] * WINDING + my * CURRENT[1] * WINDING));
        const SCALE = Math.min(4, 1 / DENOMINATOR);
        RING.push([mx * SCALE, my * SCALE]);
    }
    // The strip follows the source contour; stitch/fiber density is fragment-only.
    // Reorder the edge rows into a triangle list. This duplicates only contour vertices,
    // independent of stitchWidth, fiberSpacing, and fiberMax.
    const EDGE_RECORDS = [];
    const COLOR_AT = (index) => RGBA.subarray(index * 4, index * 4 + 4);
    for (let i = 0; i < POINTS.length; i++) {
        const J = (i + 1) % POINTS.length;
        const EMIT = (pointIndex, distance) => {
            const POINT = POINTS[pointIndex],
                NORMAL = RING[pointIndex],
                X = POINT[0] + NORMAL[0] * distance,
                Y = POINT[1] + NORMAL[1] * distance;
            EDGE_RECORDS.push(X, Y, ...COLOR_AT(pointIndex), 1, CUMULATIVE[pointIndex] / total, distance);
        };
        EMIT(i, -EDGE_WIDTH);
        EMIT(i, FIBER_LENGTH);
        EMIT(J, FIBER_LENGTH);
        EMIT(i, -EDGE_WIDTH);
        EMIT(J, FIBER_LENGTH);
        EMIT(J, -EDGE_WIDTH);
    }
    const EDGE_RECORD_ARRAY = Float32Array.from(EDGE_RECORDS);
    const VERTICES = new Float32Array(FILL_RECORDS.length + EDGE_RECORD_ARRAY.length);
    VERTICES.set(FILL_RECORDS);
    VERTICES.set(EDGE_RECORD_ARRAY, FILL_RECORDS.length);
    return Object.freeze({
        vertices: VERTICES,
        fillFirst: 0,
        fillCount: fillVertices.length / 6,
        edgeFirst: fillVertices.length / 6,
        edgeCount: EDGE_RECORD_ARRAY.length / STRIDE_FLOATS,
        edgeByteOffset: FILL_RECORDS.length * 4,
        bounds: Float32Array.of(BOUNDS[0], BOUNDS[1], BOUNDS[2] - BOUNDS[0], BOUNDS[3] - BOUNDS[1]),
        contourLength: total,
    });
}
function clipPlanes(clips, maxPlanes) {
    const PACKED = new Float32Array(maxPlanes * 3);
    if (!clips?.length) {
        return PACKED;
    }
    if (!Array.isArray(clips)) {
        throw new TypeError('clips must be an array of convex polygons');
    }
    let cursor = 0;
    for (const POLYGON of clips) {
        if (
            !Array.isArray(POLYGON) ||
            POLYGON.length < 3 ||
            POLYGON.some((point) => !Number.isFinite(point?.x) || !Number.isFinite(point?.y))
        ) {
            throw new TypeError('Finite convex clip polygons required');
        }
        let area = 0;
        for (let i = 0; i < POLYGON.length; i++) {
            const A = POLYGON[i],
                B = POLYGON[(i + 1) % POLYGON.length];
            area += A.x * B.y - B.x * A.y;
        }
        if (Math.abs(area) < 1e-8) {
            throw new RangeError('A clip polygon must have nonzero area');
        }
        const SIGN = area >= 0 ? 1 : -1;
        for (let i = 0; i < POLYGON.length; i++) {
            const A = POLYGON[i],
                B = POLYGON[(i + 1) % POLYGON.length],
                DX = B.x - A.x,
                DY = B.y - A.y,
                LENGTH = Math.hypot(DX, DY);
            if (!LENGTH) {
                continue;
            }
            if (cursor >= maxPlanes) {
                throw new RangeError(`Shader surface clipping exceeds the device limit of ${maxPlanes} edge planes`);
            }
            const AT = cursor++ * 3,
                NX = (-DY / LENGTH) * SIGN,
                NY = (DX / LENGTH) * SIGN;
            PACKED[AT] = NX;
            PACKED[AT + 1] = NY;
            PACKED[AT + 2] = -(NX * A.x + NY * A.y);
        }
    }
    return PACKED;
}
function toMatrix3(matrix) {
    finiteArray(matrix, 6, 'transform');
    return Float32Array.of(matrix[0], matrix[1], 0, matrix[2], matrix[3], 0, matrix[4], matrix[5], 1);
}
function affineMatrix4(matrix, name) {
    finiteArray(matrix, 16, name);
    if (
        Math.abs(matrix[3]) > 1e-7 ||
        Math.abs(matrix[7]) > 1e-7 ||
        Math.abs(matrix[11]) > 1e-7 ||
        Math.abs(matrix[15] - 1) > 1e-7
    ) {
        throw new TypeError(`${name} must be an affine column-major 4x4 matrix`);
    }
}

/**
 * WebGL 1 retained yarn/sketch surface passes. Effect density is evaluated per fragment;
 * the only generated mesh outside the authored fill is a fixed contour strip.
 */
export class YarnSurfaceRenderer {
    constructor(device, { maxSurfaces = MAX_SURFACES, maxSurfaceBytes = DEFAULT_LIMIT_BYTES } = {}) {
        if (!device?.createPipeline || !device?.uploadVertices || !device?.draw) {
            throw new TypeError('A ready GameKit WebGLDevice is required');
        }
        if (!Number.isSafeInteger(maxSurfaces) || maxSurfaces < 1 || maxSurfaces > MAX_SURFACES) {
            throw new RangeError(`maxSurfaces must be 1..${MAX_SURFACES}`);
        }
        if (
            !Number.isSafeInteger(maxSurfaceBytes) ||
            maxSurfaceBytes < STRIDE_BYTES * 3 ||
            maxSurfaceBytes > device.maxBufferBytes
        ) {
            throw new RangeError('maxSurfaceBytes must fit the device buffer limit');
        }
        this.device = device;
        this.maxSurfaces = maxSurfaces;
        this.maxSurfaceBytes = maxSurfaceBytes;
        this.maxClipPlanes = Math.max(
            1,
            Math.min(8, device.gl.getParameter(device.gl.MAX_FRAGMENT_UNIFORM_VECTORS) - 8),
        );
        this.surfaces = new Set();
        this.bytes = 0;
        this.pipelines = new Map();
        this.stitchField = null;
        this.stitchTextures = null;
        this.state = 'ready';
        this.failure = null;
        this.disposed = false;
        this.onLost = () => {
            this.state = 'lost';
        };
        this.onRestored = () => {
            try {
                for (const SURFACE of this.surfaces) {
                    device.uploadVertices(SURFACE.buffer, SURFACE.vertices);
                }
                this.state = 'ready';
                this.failure = null;
            } catch (error) {
                this.state = 'failed';
                this.failure = error.message;
            }
        };
        device.canvas.addEventListener('webglcontextlost', this.onLost);
        device.canvas.addEventListener('webglcontextrestored', this.onRestored);
    }
    // The shared stitch distance field is created with the first yarn surface; the device restores it after a lost
    // context like any other texture.
    _stitchField() {
        if (!this.stitchField) {
            this.stitchField = this.device.createTexture(
                { width: STITCH_FIELD_SIZE, height: STITCH_FIELD_SIZE, data: stitchFieldPixels() },
                { premultiplied: true, filter: 'linear' },
            );
            this.stitchTextures = Object.freeze([this.stitchField]);
        }
        return this.stitchField;
    }
    _pipeline(kind, worldMode = false) {
        const KEY = kind + ':' + Number(worldMode);
        let pipeline = this.pipelines.get(KEY);
        if (pipeline) {
            return pipeline;
        }
        const UNIFORMS = {
            ...(worldMode
                ? {
                      u_viewProjection: 'matrix4fv',
                      u_worldMatrix: 'matrix4fv',
                  }
                : {
                      u_projection: 'matrix3fv',
                  }),
            u_transform: 'matrix3fv',
            u_depth: '1f',
            u_bounds: '4f',
            u_effect0: '4f',
            u_effect1: '4f',
            u_effect2: '4f',
            u_effect3: '4f',
            u_tint: '4f',
            u_flash: '1f',
            u_forceColor: '1f',
            'u_planes[0]': '3fv',
            ...(kind === 'sketch'
                ? {
                      u_timeMs: '1f',
                  }
                : {}),
        };
        pipeline = this.device.createPipeline({
            vertex: worldMode ? VERTEX_WORLD : VERTEX,
            fragment: fragment(kind, this.maxClipPlanes),
            stride: STRIDE_BYTES,
            attributes: ATTRIBUTES,
            uniforms: UNIFORMS,
        });
        this.pipelines.set(KEY, pipeline);
        return pipeline;
    }
    createSurface({ fillVertices, outline, edgeColors, style }) {
        if (this.disposed || this.state !== 'ready') {
            throw new Error(`YarnSurfaceRenderer is ${this.state}`);
        }
        validateStyle(style);
        if (this.surfaces.size >= this.maxSurfaces) {
            throw new RangeError('Retained yarn surface count limit exceeded');
        }
        const GEOMETRY = surfaceGeometry(fillVertices, outline, edgeColors, style);
        const VERTICES = GEOMETRY.vertices.slice();
        if (this.bytes + VERTICES.byteLength > this.maxSurfaceBytes) {
            throw new RangeError('Retained yarn surface byte budget exceeded');
        }
        const PIPELINE = this._pipeline(style.kind);
        if (style.kind === 'yarn') {
            this._stitchField();
        }
        const BUFFER = this.device.createVertexBuffer({
            capacityBytes: VERTICES.byteLength,
        });
        try {
            this.device.uploadVertices(BUFFER, VERTICES);
        } catch (error) {
            this.device.deleteVertexBuffer(BUFFER);
            throw error;
        }
        const SURFACE = Object.freeze({
            renderer: this,
            buffer: BUFFER,
            vertices: VERTICES,
            byteLength: VERTICES.byteLength,
            style: Object.freeze({
                ...style,
            }),
            kind: style.kind,
            fillFirst: GEOMETRY.fillFirst,
            fillCount: GEOMETRY.fillCount,
            edgeFirst: GEOMETRY.edgeFirst,
            edgeCount: GEOMETRY.edgeCount,
            edgeByteOffset: GEOMETRY.edgeByteOffset,
            bounds: GEOMETRY.bounds,
            contourLength: GEOMETRY.contourLength,
            pipeline: PIPELINE,
        });
        this.surfaces.add(SURFACE);
        this.bytes += SURFACE.byteLength;
        return SURFACE;
    }
    drawSurface(
        surface,
        {
            projection,
            viewProjection,
            worldMatrix,
            transform = IDENTITY,
            color = WHITE,
            alpha = 1,
            forceColor = false,
            whiteFlash = 0,
            timeMs = 0,
            clips = [],
            stencilRef = null,
            z = 0,
            depth = false,
            blend = 'source-over',
        } = {},
    ) {
        if (this.disposed || this.state !== 'ready') {
            throw new Error(`YarnSurfaceRenderer is ${this.state}${this.failure ? ': ' + this.failure : ''}`);
        }
        if (!this.surfaces.has(surface)) {
            throw new TypeError('Surface must belong to this YarnSurfaceRenderer');
        }
        const WORLD_MODE = viewProjection !== undefined || worldMatrix !== undefined;
        if (WORLD_MODE) {
            if (projection !== undefined || viewProjection === undefined || worldMatrix === undefined) {
                throw new TypeError(
                    '3D surface draws require viewProjection and worldMatrix and cannot include projection',
                );
            }
            finiteArray(viewProjection, 16, 'viewProjection');
            affineMatrix4(worldMatrix, 'worldMatrix');
        } else {
            finiteArray(projection, 9, 'projection');
        }
        finiteArray(color, 4, 'color');
        if (!Number.isFinite(alpha) || alpha < 0 || alpha > 1 || color.some((value) => value < 0 || value > 1)) {
            throw new RangeError('Surface tint/alpha must be in [0,1]');
        }
        if (typeof forceColor !== 'boolean') {
            throw new TypeError('forceColor must be boolean');
        }
        if (!Number.isFinite(whiteFlash) || whiteFlash < 0 || whiteFlash > 1) {
            throw new RangeError('whiteFlash must be in [0,1]');
        }
        if (!Number.isFinite(timeMs)) {
            throw new TypeError('timeMs must be finite');
        }
        if (!Number.isFinite(z) || z < -1 || z > 1) {
            throw new RangeError('z must be in [-1,1]');
        }
        if (stencilRef !== null && (!Number.isSafeInteger(stencilRef) || stencilRef < 0 || stencilRef > 255)) {
            throw new RangeError('stencilRef must be null or in [0,255]');
        }
        if (stencilRef !== null && !this.device.activeStencilAvailable) {
            throw new Error('A stencil-tested yarn surface requires an active stencil attachment');
        }
        const PLANES = clipPlanes(clips, this.maxClipPlanes),
            STYLE = surface.style;
        const YARN = surface.kind === 'yarn';
        const STITCH_PATTERN = STYLE.pattern !== false;
        const EFFECT0 = YARN
            ? [STYLE.seed, STYLE.stitchWidth, STYLE.stitchHeight, (STITCH_PATTERN ? 1 : -1) * STYLE.thickness]
            : [STYLE.seed, STYLE.periodMs, STYLE.frequency, 0];
        const EFFECT1 = YARN
            ? [STYLE.irregularity, STYLE.contrast, STYLE.edgeSpacing, STYLE.edgeWidth]
            : [STYLE.amplitude, STYLE.echoX, STYLE.echoWidth, STYLE.echoOpacity];
        const EFFECT2 = YARN
            ? [STYLE.fiberSpacing ?? 4, STYLE.fiberLength, STYLE.fiberWidth, STYLE.fiberOpacity]
            : [STYLE.hatchWidth, STYLE.hatchOpacity, STYLE.hatchAngle, STYLE.hatchSpacing];
        const EFFECT3 = YARN
            ? [
                  STYLE.fiber === false ? 0 : STYLE.fiberMax,
                  surface.contourLength,
                  STYLE.curved === false ? 0 : 1,
                  STYLE.edgeRelief * (STYLE.detail ? 0.3 : 1),
              ]
            : [0, STYLE.echoY, 0, 0];
        const UNIFORMS = {
            ...(WORLD_MODE
                ? {
                      u_viewProjection: viewProjection,
                      u_worldMatrix: worldMatrix,
                  }
                : {
                      u_projection: projection,
                  }),
            u_transform: toMatrix3(transform),
            u_depth: z,
            u_bounds: surface.bounds,
            u_effect0: EFFECT0,
            u_effect1: EFFECT1,
            u_effect2: EFFECT2,
            u_effect3: EFFECT3,
            u_tint: [color[0], color[1], color[2], color[3] * alpha],
            u_flash: whiteFlash,
            u_forceColor: forceColor ? 1 : 0,
            'u_planes[0]': PLANES,
            ...(YARN
                ? {}
                : {
                      u_timeMs: ((timeMs % STYLE.periodMs) + STYLE.periodMs) % STYLE.periodMs,
                  }),
        };
        const COMMON = {
            pipeline: this._pipeline(surface.kind, WORLD_MODE),
            buffer: surface.buffer,
            uniforms: UNIFORMS,
            textures: YARN ? this.stitchTextures : [],
            blend,
            depth,
            stencil:
                stencilRef === null
                    ? false
                    : {
                          func: 'equal',
                          ref: stencilRef,
                          mask: 255,
                          writeMask: 0,
                          pass: 'keep',
                      },
        };
        this.device.draw({
            ...COMMON,
            first: surface.fillFirst,
            count: surface.fillCount,
        });
        if (surface.edgeCount) {
            const EDGE_DEPTH =
                depth === true
                    ? {
                          test: true,
                          write: false,
                      }
                    : depth && typeof depth === 'object'
                      ? {
                            ...depth,
                            write: false,
                        }
                      : depth;
            this.device.draw({
                ...COMMON,
                first: surface.edgeFirst,
                count: surface.edgeCount,
                depth: EDGE_DEPTH,
            });
        }
    }
    deleteSurface(surface) {
        if (!this.surfaces.has(surface)) {
            return false;
        }
        this.device.deleteVertexBuffer(surface.buffer);
        this.surfaces.delete(surface);
        this.bytes -= surface.byteLength;
        return true;
    }
    stats() {
        return Object.freeze({
            state: this.state,
            surfaceCount: this.surfaces.size,
            retainedBytes: this.bytes,
            pipelineCount: this.pipelines.size,
            maxClipPlanes: this.maxClipPlanes,
        });
    }
    dispose() {
        if (this.disposed) {
            return false;
        }
        this.device.canvas.removeEventListener('webglcontextlost', this.onLost);
        this.device.canvas.removeEventListener('webglcontextrestored', this.onRestored);
        for (const SURFACE of this.surfaces) {
            this.device.deleteVertexBuffer(SURFACE.buffer);
        }
        for (const PIPELINE of this.pipelines.values()) {
            this.device.deletePipeline(PIPELINE);
        }
        if (this.stitchField) {
            this.device.deleteTexture(this.stitchField);
            this.stitchField = null;
            this.stitchTextures = null;
        }
        this.surfaces.clear();
        this.pipelines.clear();
        this.bytes = 0;
        this.disposed = true;
        this.state = 'disposed';
        return true;
    }
}

/** Exposed for exact bounded-geometry assertions; it never creates per-stitch or per-fiber vertices. */
export function buildYarnSurfaceGeometry(options) {
    validateStyle(options?.style);
    return surfaceGeometry(options.fillVertices, options.outline, options.edgeColors, options.style);
}

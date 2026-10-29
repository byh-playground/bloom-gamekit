// The yarn and sketch shaders of the mesh renderer. The record layout they read lives in yarn-material-record.js.
// The yarn and sketch materials of the mesh renderer. A mesh that carries materials has, per vertex, a kind and the
// surface it belongs to plus the distance along and across the contour; the surface constants live in one small
// table. Both are plain data, so yarn and sketch surfaces are ordinary triangles of the mesh: they batch, pose, clip
// and depth-test like every other part, and only the fragment shader tells the kinds apart.
// The stitch fill evaluates the same few curves for every pixel: two strands, an underside curve and two twist
// segments, each at a handful of offsets. Their distances depend only on the position inside one stitch cell, so one
// small texture shared by every yarn surface holds them. R = min(left, right strand), G = underside, B = twist
// (min of the two segments), each in cell-normalized units divided by STITCH_FIELD_MAX_DISTANCE. Strand masks are
// max(lineMask(left), lineMask(right)) = lineMask(min(left, right)), so three samples replace seven curve evaluations.
export const STITCH_FIELD_SIZE = 256;
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
export function stitchFieldPixels() {
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
const HELPERS = `float hashCell(vec2 cell, float salt) {
  return fract(sin(dot(cell, vec2(127.1, 311.7)) + u_effect0.x * 74.7 + salt * 19.19) * 43758.5453);
}
float lineMask(float distanceToLine, float width) {
  float aa = max(width * 0.16, 0.025);
  return 1.0 - smoothstep(max(0.0, width * 0.5 - aa), width * 0.5 + aa, distanceToLine);
}
vec3 tintTo(vec3 base, float amount) {
  return amount < 0.0 ? mix(base, vec3(0.0), -amount) : mix(base, vec3(1.0), amount);
}`;
const YARN_FRAGMENT_BODY = `
vec3 shadeYarnFill(vec3 base) {
  float stitchWidth = abs(u_effect0.y), stitchHeight = u_effect0.z;
  if (u_effect0.w < 0.0 || stitchWidth <= 0.0 || stitchHeight <= 0.0) return base;
  float cols = max(2.0, ceil(u_bounds.z / stitchWidth));
  float rows = max(2.0, ceil(u_bounds.w / stitchHeight));
  float sx = u_bounds.z / cols, sy = u_bounds.w / rows;
  vec2 local = v_local;
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
  float radial = v_material.w;
  float along = v_material.z * u_effect3.y;
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
  float phase=dot(v_local,direction)/spacing + hashCell(vec2(u_effect0.x,0.0),31.0);
  float distanceToHatch=abs(fract(phase)-0.5)*spacing;
  float hatch=lineMask(distanceToHatch,u_effect2.x)*u_effect2.y;
  return mix(base,tintTo(base,-0.48),hatch);
}
void shadeSketchEdge(inout vec3 rgb, float alpha) {
  float phase=mod(v_time,max(u_effect0.y,16.0))/max(u_effect0.y,16.0)*6.2831853;
  float wobble=sin(v_material.z*u_effect0.z*6.2831853+phase+u_effect0.x)*u_effect1.x;
  float offset=(u_effect1.y+wobble);
  float echo=lineMask(abs(v_material.w-offset),u_effect1.z)*u_effect1.w;
  if(echo<0.012)discard;
  rgb=mix(rgb,tintTo(rgb,-0.52),echo);
  float outAlpha=alpha*echo;
  gl_FragColor=vec4(rgb*outAlpha,outAlpha);
}`;
/**
 * Fragment shader of a mesh whose vertices carry materials. v_color already holds the instance tint, alpha, flash and
 * part opacity, premultiplied, exactly as for ordinary meshes; a vertex of kind 0 outputs it unchanged.
 */
export function materialFragment(maxPlanes, clipped, surfaceCount) {
    const PLANES = clipped
        ? `varying vec2 v_position; uniform vec3 u_planes[${maxPlanes}]; uniform int u_planeCount;`
        : '';
    const CLIP = clipped
        ? `for(int i=0;i<${maxPlanes};i++){if(i>=u_planeCount)break;if(dot(u_planes[i],vec3(v_position,1.0))<0.0)discard;}`
        : '';
    return `precision mediump float;
varying vec4 v_color; varying vec2 v_local; varying vec4 v_material; varying highp float v_time;
uniform vec4 u_materials[${surfaceCount * 5}]; uniform sampler2D u_stitchField;
${PLANES}
vec4 surfaceBounds; vec4 surfaceEffect0; vec4 surfaceEffect1; vec4 surfaceEffect2; vec4 surfaceEffect3;
#define u_bounds surfaceBounds
#define u_effect0 surfaceEffect0
#define u_effect1 surfaceEffect1
#define u_effect2 surfaceEffect2
#define u_effect3 surfaceEffect3
${HELPERS}
${YARN_FRAGMENT_BODY}
${SKETCH_FRAGMENT_BODY}
void main() {
  ${CLIP}
  int kind = int(v_material.x + 0.5);
  if (kind == 0) {
    gl_FragColor = v_color;
    return;
  }
  float alpha = v_color.a;
  if (alpha <= 0.0001) discard;
  // The surface constants are read once; the shading code below uses them dozens of times.
  int base = int(v_material.y + 0.5) * 5;
  surfaceBounds = u_materials[base];
  surfaceEffect0 = u_materials[base + 1];
  surfaceEffect1 = u_materials[base + 2];
  surfaceEffect2 = u_materials[base + 3];
  surfaceEffect3 = u_materials[base + 4];
  vec3 rgb = v_color.rgb / alpha;
  if (kind == 1) {
    rgb = shadeYarnFill(rgb);
    gl_FragColor = vec4(rgb * alpha, alpha);
  } else if (kind == 2) {
    shadeYarnEdge(rgb, alpha);
  } else if (kind == 3) {
    rgb = shadeSketchFill(rgb);
    gl_FragColor = vec4(rgb * alpha, alpha);
  } else {
    shadeSketchEdge(rgb, alpha);
  }
}`;
}

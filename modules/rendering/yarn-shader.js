const STRIDE_FLOATS = 9;
const STRIDE_BYTES = STRIDE_FLOATS * 4;
const MAX_SURFACES = 512;
const DEFAULT_LIMIT_BYTES = 32 * 1024 * 1024;
const ATTRIBUTES = [
  { name: 'a_position', size: 2, offset: 0 },
  { name: 'a_color', size: 4, offset: 8 },
  { name: 'a_surface', size: 3, offset: 24 },
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

function fragment(kind, maxClipPlanes) {
  const clips = maxClipPlanes ? `
uniform vec3 u_planes[${maxClipPlanes}];
void clipWorld() {
  for (int i = 0; i < ${maxClipPlanes}; i++) {
    vec3 plane = u_planes[i];
    if (dot(plane.xy, plane.xy) > 0.0000001 && dot(plane, vec3(v_world, 1.0)) < 0.0) discard;
  }
}` : 'void clipWorld() {}';
  const body = kind === 'yarn' ? yarnFragmentBody : sketchFragmentBody;
  return `precision mediump float;
varying vec2 v_position; varying vec2 v_world; varying vec4 v_color; varying vec3 v_surface;
uniform vec4 u_bounds; uniform vec4 u_effect0; uniform vec4 u_effect1; uniform vec4 u_effect2; uniform vec4 u_effect3;
uniform vec4 u_tint; uniform float u_flash;
${kind === 'sketch' ? 'uniform float u_timeMs;' : ''}
${clips}
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
${body}
void main() {
  clipWorld();
  float alpha = v_color.a * u_tint.a;
  if (alpha <= 0.0001) discard;
  vec3 base = mix(v_color.rgb * u_tint.rgb, vec3(1.0), clamp(u_flash, 0.0, 1.0));
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

const yarnFragmentBody = `
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
  float underDistance = cubicDistance(p-vec2(0.0,stroke*0.06), vec2(-0.48,-0.46)*vec2(sx,sy), vec2(-0.22,-0.57)*vec2(sx,sy), vec2(0.22,-0.57)*vec2(sx,sy), vec2(0.48,-0.46)*vec2(sx,sy));
  vec2 leftA=vec2(-0.34,-0.36)*vec2(sx,sy), leftB=vec2(-0.32,-0.06)*vec2(sx,sy), leftC=vec2(-0.18,0.17)*vec2(sx,sy), leftD=vec2(-0.025,0.34)*vec2(sx,sy);
  vec2 rightA=vec2(0.34,-0.36)*vec2(sx,sy), rightB=vec2(0.32,-0.06)*vec2(sx,sy), rightC=vec2(0.18,0.17)*vec2(sx,sy), rightD=vec2(0.025,0.34)*vec2(sx,sy);
  float leftDistance = cubicDistance(p,leftA,leftB,leftC,leftD);
  float rightDistance = cubicDistance(p,rightA,rightB,rightC,rightD);
  float under = lineMask(underDistance, stroke*0.5) * 0.5;
  float grooveLeft = cubicDistance(p-vec2(0.0,stroke*0.06),leftA,leftB,leftC,leftD);
  float grooveRight = cubicDistance(p-vec2(0.0,stroke*0.06),rightA,rightB,rightC,rightD);
  float groove = max(lineMask(grooveLeft,stroke*1.08),lineMask(grooveRight,stroke*1.08))*0.85;
  float yarn = max(lineMask(leftDistance,stroke*0.89),lineMask(rightDistance,stroke*0.89));
  float lightLeft = cubicDistance(p+vec2(stroke*0.14,stroke*0.13),leftA,leftB,leftC,leftD);
  float lightRight = cubicDistance(p+vec2(stroke*0.14,stroke*0.13),rightA,rightB,rightC,rightD);
  float light = max(lineMask(lightLeft,stroke*0.34),lineMask(lightRight,stroke*0.34))*0.57;
  float twist = 0.0;
  if (mod(index.x + index.y, 2.0) < 1.0) {
    float a = segmentDistance(p,vec2(-0.32,-0.12)*vec2(sx,sy),vec2(-0.16,-0.13)*vec2(sx,sy));
    float b = segmentDistance(p,vec2(0.22,0.18)*vec2(sx,sy),vec2(0.37,0.08)*vec2(sx,sy));
    twist = max(lineMask(a,stroke*0.075),lineMask(b,stroke*0.075))*0.5;
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

const sketchFragmentBody = `
vec3 shadeSketchFill(vec3 base) {
  float angle=u_effect1.z, spacing=max(u_effect1.w,0.001);
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
  if (!value || value.length !== count || Array.from(value).some(number => !Number.isFinite(number))) throw new TypeError(`${name} needs ${count} finite numbers`);
}

function validateStyle(style) {
  if (!style || typeof style !== 'object' || Array.isArray(style)) throw new TypeError('A complete SVG-authored yarn or sketch style is required');
  const yarnRequired = ['seed','stitchWidth','stitchHeight','thickness','irregularity','contrast','edgeSpacing','edgeRelief','edgeWidth','fiberLength','fiberWidth','fiberOpacity','fiberMax'];
  const sketchRequired = ['seed','periodMs','amplitude','frequency','echoX','echoY','echoWidth','echoOpacity','hatchAngle','hatchSpacing','hatchWidth','hatchOpacity'];
  const fields = style.kind === 'yarn' ? yarnRequired : style.kind === 'sketch' ? sketchRequired : null;
  if (!fields || fields.some(key => !Number.isFinite(style[key]))) throw new TypeError('Unsupported or incomplete SVG surface style');
  if (style.seed < 0 || style.seed > 0x7fffffff || !Number.isSafeInteger(style.seed)) throw new RangeError('Surface seed must be a nonnegative 31-bit integer');
  if (style.kind === 'yarn') {
    for (const key of ['stitchWidth','stitchHeight','thickness','edgeSpacing','edgeRelief','edgeWidth','fiberLength','fiberWidth']) if (style[key] <= 0) throw new RangeError(`Yarn ${key} must be positive`);
    for (const key of ['irregularity','contrast','fiberOpacity']) if (style[key] < 0 || style[key] > 1) throw new RangeError(`Yarn ${key} must be in [0,1]`);
    if (!Number.isSafeInteger(style.fiberMax) || style.fiberMax < 0 || style.fiberMax > 512) throw new RangeError('Yarn fiberMax must be an integer from 0 to 512');
    for (const key of ['fiberSpacing','curved','pattern','detail','fiber']) if (style[key] !== undefined && (key === 'fiberSpacing' ? (!Number.isFinite(style[key]) || style[key] <= 0) : typeof style[key] !== 'boolean')) throw new TypeError(`Invalid Yarn ${key}`);
  } else {
    if (!Number.isSafeInteger(style.periodMs) || style.periodMs < 16 || style.periodMs > 10000) throw new RangeError('Sketch periodMs must be 16..10000');
    for (const key of ['amplitude','frequency','echoWidth','hatchSpacing','hatchWidth']) if (style[key] <= 0) throw new RangeError(`Sketch ${key} must be positive`);
    for (const key of ['echoOpacity','hatchOpacity']) if (style[key] < 0 || style[key] > 1) throw new RangeError(`Sketch ${key} must be in [0,1]`);
  }
}

function normalizeOutline(outline) {
  if (!(outline instanceof Float32Array || Array.isArray(outline)) || outline.length < 8 || outline.length % 2) throw new TypeError('Closed SVG contour must contain at least four x/y points');
  const points = [];
  for (let i = 0; i < outline.length; i += 2) {
    const x = outline[i], y = outline[i + 1];
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new TypeError('SVG contour points must be finite');
    if (!points.length || Math.hypot(x - points.at(-1)[0], y - points.at(-1)[1]) > 1e-6) points.push([x, y]);
  }
  if (points.length > 4 && Math.hypot(points[0][0] - points.at(-1)[0], points[0][1] - points.at(-1)[1]) < 1e-6) points.pop();
  if (points.length < 3) throw new TypeError('SVG contour requires at least three distinct points');
  return points;
}

function surfaceGeometry(fillVertices, outline, edgeColors, style) {
  if (!(fillVertices instanceof Float32Array) || fillVertices.length < 18 || fillVertices.length % 18) throw new TypeError('Filled surface requires complete triangles in a six-float position/color layout');
  const points = normalizeOutline(outline);
  if (edgeColors !== undefined && (!(edgeColors instanceof Float32Array) || edgeColors.length !== points.length * 4)) throw new TypeError('edgeColors must contain one RGBA color per contour point');
  if (edgeColors && edgeColors.some(value => !Number.isFinite(value) || value < 0 || value > 1)) throw new RangeError('edgeColors must contain finite RGBA values in [0,1]');
  for (let i = 0; i < fillVertices.length; i++) {
    if (!Number.isFinite(fillVertices[i])) throw new TypeError('Filled surface vertices must be finite');
    const field = i % 6;
    if (field >= 2 && (fillVertices[i] < 0 || fillVertices[i] > 1)) throw new RangeError('Surface colors must be in [0,1]');
  }
  const lengths = [], normals = [];
  let total = 0, signedArea = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i], b = points[(i + 1) % points.length], dx = b[0] - a[0], dy = b[1] - a[1], length = Math.hypot(dx, dy);
    if (!length) throw new TypeError('SVG contour cannot contain zero-length edges');
    lengths.push(length); total += length; signedArea += a[0] * b[1] - b[0] * a[1];
    normals.push([dy / length, -dx / length]);
  }
  if (Math.abs(signedArea) < 1e-6) throw new TypeError('SVG contour cannot have zero area');
  const winding = signedArea >= 0 ? 1 : -1;
  const bounds = [Infinity, Infinity, -Infinity, -Infinity];
  for (let i = 0; i < fillVertices.length; i += 6) {
    bounds[0] = Math.min(bounds[0], fillVertices[i]); bounds[1] = Math.min(bounds[1], fillVertices[i + 1]);
    bounds[2] = Math.max(bounds[2], fillVertices[i]); bounds[3] = Math.max(bounds[3], fillVertices[i + 1]);
  }
  if (!(bounds[2] > bounds[0] && bounds[3] > bounds[1])) throw new TypeError('Filled surface bounds must have positive area');
  const rgba = edgeColors ? edgeColors : (() => {
    const color = [0, 0, 0, 0];
    for (let i = 0; i < fillVertices.length; i += 6) for (let c = 0; c < 4; c++) color[c] += fillVertices[i + 2 + c];
    for (let c = 0; c < 4; c++) color[c] /= fillVertices.length / 6;
    return Float32Array.from(points.flatMap(() => color));
  })();
  const edgeWidth = style.kind === 'yarn' ? style.edgeWidth : Math.max(style.echoWidth, Math.hypot(style.echoX, style.echoY) + style.amplitude + style.echoWidth);
  const fiberLength = style.kind === 'yarn' && style.fiber !== false ? style.fiberLength : edgeWidth;
  const fillRecords = new Float32Array(fillVertices.length / 6 * STRIDE_FLOATS);
  let write = 0;
  for (let i = 0; i < fillVertices.length; i += 6) {
    fillRecords.set(fillVertices.subarray(i, i + 6), write); fillRecords[write + 6] = 0; write += STRIDE_FLOATS;
  }
  const cumulative = [0]; for (const length of lengths) cumulative.push(cumulative.at(-1) + length);
  const ring = [];
  for (let i = 0; i < points.length; i++) {
    const previous = normals[(i + points.length - 1) % points.length], current = normals[i];
    let mx = (previous[0] + current[0]) * winding, my = (previous[1] + current[1]) * winding;
    const miterLength = Math.hypot(mx, my);
    if (miterLength < 1e-5) { mx = current[0] * winding; my = current[1] * winding; }
    else { mx /= miterLength; my /= miterLength; }
    const denominator = Math.max(0.25, Math.abs(mx * current[0] * winding + my * current[1] * winding));
    const scale = Math.min(4, 1 / denominator);
    ring.push([mx * scale, my * scale]);
  }
  const edgeFirst = fillVertices.length / 6;
  // The strip follows the source contour; stitch/fiber density is fragment-only.
  // Reorder the edge rows into a triangle list. This duplicates only contour vertices,
  // independent of stitchWidth, fiberSpacing, and fiberMax.
  const edgeRecords = [];
  const colorAt = index => rgba.subarray(index * 4, index * 4 + 4);
  for (let i = 0; i < points.length; i++) {
    const j = (i + 1) % points.length;
    const emit = (pointIndex, distance) => {
      const point = points[pointIndex], normal = ring[pointIndex], x = point[0] + normal[0] * distance, y = point[1] + normal[1] * distance;
      edgeRecords.push(x, y, ...colorAt(pointIndex), 1, cumulative[pointIndex] / total, distance);
    };
    emit(i, -edgeWidth); emit(i, fiberLength); emit(j, fiberLength);
    emit(i, -edgeWidth); emit(j, fiberLength); emit(j, -edgeWidth);
  }
  const edgeRecordArray = Float32Array.from(edgeRecords);
  const vertices = new Float32Array(fillRecords.length + edgeRecordArray.length);
  vertices.set(fillRecords); vertices.set(edgeRecordArray, fillRecords.length);
  return Object.freeze({ vertices, fillFirst: 0, fillCount: fillVertices.length / 6, edgeFirst: fillVertices.length / 6,
    edgeCount: edgeRecordArray.length / STRIDE_FLOATS, edgeByteOffset: fillRecords.length * 4,
    bounds: Float32Array.of(bounds[0], bounds[1], bounds[2] - bounds[0], bounds[3] - bounds[1]), contourLength: total });
}

function clipPlanes(clips, maxPlanes) {
  const packed = new Float32Array(maxPlanes * 3);
  if (!clips?.length) return packed;
  if (!Array.isArray(clips)) throw new TypeError('clips must be an array of convex polygons');
  let cursor = 0;
  for (const polygon of clips) {
    if (!Array.isArray(polygon) || polygon.length < 3 || polygon.some(point => !Number.isFinite(point?.x) || !Number.isFinite(point?.y))) throw new TypeError('Finite convex clip polygons required');
    let area = 0;
    for (let i = 0; i < polygon.length; i++) { const a = polygon[i], b = polygon[(i + 1) % polygon.length]; area += a.x * b.y - b.x * a.y; }
    if (Math.abs(area) < 1e-8) throw new RangeError('A clip polygon must have nonzero area');
    const sign = area >= 0 ? 1 : -1;
    for (let i = 0; i < polygon.length; i++) {
      const a = polygon[i], b = polygon[(i + 1) % polygon.length], dx = b.x - a.x, dy = b.y - a.y, length = Math.hypot(dx, dy);
      if (!length) continue;
      if (cursor >= maxPlanes) throw new RangeError(`Shader surface clipping exceeds the device limit of ${maxPlanes} edge planes`);
      const at = cursor++ * 3, nx = -dy / length * sign, ny = dx / length * sign;
      packed[at] = nx; packed[at + 1] = ny; packed[at + 2] = -(nx * a.x + ny * a.y);
    }
  }
  return packed;
}

function toMatrix3(matrix) {
  finiteArray(matrix, 6, 'transform');
  return Float32Array.of(matrix[0], matrix[1], 0, matrix[2], matrix[3], 0, matrix[4], matrix[5], 1);
}

/**
 * WebGL 1 retained yarn/sketch surface passes. Effect density is evaluated per fragment;
 * the only generated mesh outside the authored fill is a fixed contour strip.
 */
export class YarnSurfaceRenderer {
  constructor(device, { maxSurfaces = MAX_SURFACES, maxSurfaceBytes = DEFAULT_LIMIT_BYTES } = {}) {
    if (!device?.createPipeline || !device?.uploadVertices || !device?.draw) throw new TypeError('A ready GameKit WebGLDevice is required');
    if (!Number.isSafeInteger(maxSurfaces) || maxSurfaces < 1 || maxSurfaces > MAX_SURFACES) throw new RangeError(`maxSurfaces must be 1..${MAX_SURFACES}`);
    if (!Number.isSafeInteger(maxSurfaceBytes) || maxSurfaceBytes < STRIDE_BYTES * 3 || maxSurfaceBytes > device.maxBufferBytes) throw new RangeError('maxSurfaceBytes must fit the device buffer limit');
    this.device = device; this.maxSurfaces = maxSurfaces; this.maxSurfaceBytes = maxSurfaceBytes;
    this.maxClipPlanes = Math.max(1, Math.min(8, device.gl.getParameter(device.gl.MAX_FRAGMENT_UNIFORM_VECTORS) - 8));
    this.surfaces = new Set(); this.bytes = 0; this.pipelines = new Map(); this.state = 'ready'; this.failure = null; this.disposed = false;
    this.onLost = () => { this.state = 'lost'; };
    this.onRestored = () => {
      try {
        for (const surface of this.surfaces) device.uploadVertices(surface.buffer, surface.vertices);
        this.state = 'ready'; this.failure = null;
      } catch (error) { this.state = 'failed'; this.failure = error.message; }
    };
    device.canvas.addEventListener('webglcontextlost', this.onLost);
    device.canvas.addEventListener('webglcontextrestored', this.onRestored);
  }
  _pipeline(kind) {
    let pipeline = this.pipelines.get(kind);
    if (pipeline) return pipeline;
    const uniforms = { u_projection: 'matrix3fv', u_transform: 'matrix3fv', u_depth: '1f', u_bounds: '4f',
      u_effect0: '4f', u_effect1: '4f', u_effect2: '4f', u_effect3: '4f', u_tint: '4f', u_flash: '1f',
      'u_planes[0]': '3fv', ...(kind === 'sketch' ? { u_timeMs: '1f' } : {}) };
    pipeline = this.device.createPipeline({ vertex: VERTEX, fragment: fragment(kind, this.maxClipPlanes), stride: STRIDE_BYTES,
      attributes: ATTRIBUTES, uniforms });
    this.pipelines.set(kind, pipeline);
    return pipeline;
  }
  createSurface({ fillVertices, outline, edgeColors, style }) {
    if (this.disposed || this.state !== 'ready') throw new Error(`YarnSurfaceRenderer is ${this.state}`);
    validateStyle(style);
    if (this.surfaces.size >= this.maxSurfaces) throw new RangeError('Retained yarn surface count limit exceeded');
    const geometry = surfaceGeometry(fillVertices, outline, edgeColors, style);
    const vertices = geometry.vertices.slice();
    if (this.bytes + vertices.byteLength > this.maxSurfaceBytes) throw new RangeError('Retained yarn surface byte budget exceeded');
    const pipeline = this._pipeline(style.kind);
    const buffer = this.device.createVertexBuffer({ capacityBytes: vertices.byteLength });
    try { this.device.uploadVertices(buffer, vertices); }
    catch (error) { this.device.deleteVertexBuffer(buffer); throw error; }
    const surface = Object.freeze({ renderer: this, buffer, vertices, byteLength: vertices.byteLength, style: Object.freeze({ ...style }),
      kind: style.kind, fillFirst: geometry.fillFirst, fillCount: geometry.fillCount, edgeFirst: geometry.edgeFirst, edgeCount: geometry.edgeCount,
      edgeByteOffset: geometry.edgeByteOffset, bounds: geometry.bounds, contourLength: geometry.contourLength, pipeline });
    this.surfaces.add(surface); this.bytes += surface.byteLength;
    return surface;
  }
  drawSurface(surface, { projection, transform = IDENTITY, color = WHITE, alpha = 1, whiteFlash = 0, timeMs = 0,
    clips = [], z = 0, depth = false, blend = 'source-over' } = {}) {
    if (this.disposed || this.state !== 'ready') throw new Error(`YarnSurfaceRenderer is ${this.state}${this.failure ? ': ' + this.failure : ''}`);
    if (!this.surfaces.has(surface)) throw new TypeError('Surface must belong to this YarnSurfaceRenderer');
    finiteArray(projection, 9, 'projection'); finiteArray(color, 4, 'color');
    if (!Number.isFinite(alpha) || alpha < 0 || alpha > 1 || color.some(value => value < 0 || value > 1)) throw new RangeError('Surface tint/alpha must be in [0,1]');
    if (!Number.isFinite(whiteFlash) || whiteFlash < 0 || whiteFlash > 1) throw new RangeError('whiteFlash must be in [0,1]');
    if (!Number.isFinite(timeMs)) throw new TypeError('timeMs must be finite');
    if (!Number.isFinite(z) || z < -1 || z > 1) throw new RangeError('z must be in [-1,1]');
    const planes = clipPlanes(clips, this.maxClipPlanes), style = surface.style;
    const yarn = surface.kind === 'yarn';
    const stitchPattern = style.pattern !== false;
    const effect0 = yarn
      ? [style.seed, style.stitchWidth, style.stitchHeight, (stitchPattern ? 1 : -1) * style.thickness]
      : [style.seed, style.periodMs, style.frequency, 0];
    const effect1 = yarn
      ? [style.irregularity, style.contrast, style.edgeSpacing, style.edgeWidth]
      : [style.amplitude, style.echoX, style.echoWidth, style.echoOpacity];
    const effect2 = yarn
      ? [style.fiberSpacing ?? 4, style.fiberLength, style.fiberWidth, style.fiberOpacity]
      : [style.hatchWidth, style.hatchOpacity, style.hatchAngle, style.hatchSpacing];
    const effect3 = yarn
      ? [style.fiber === false ? 0 : style.fiberMax, surface.contourLength, style.curved === false ? 0 : 1,
        style.edgeRelief * (style.detail ? 0.3 : 1)]
      : [0, style.echoY, 0, 0];
    const uniforms = { u_projection: projection, u_transform: toMatrix3(transform), u_depth: z, u_bounds: surface.bounds,
      u_effect0: effect0, u_effect1: effect1, u_effect2: effect2, u_effect3: effect3,
      u_tint: [color[0], color[1], color[2], color[3] * alpha], u_flash: whiteFlash, 'u_planes[0]': planes,
      ...(yarn ? {} : { u_timeMs: ((timeMs % style.periodMs) + style.periodMs) % style.periodMs }) };
    const common = { pipeline: surface.pipeline, buffer: surface.buffer, uniforms, blend, depth };
    this.device.draw({ ...common, first: surface.fillFirst, count: surface.fillCount });
    if (surface.edgeCount) {
      const edgeDepth = depth === true ? { test: true, write: false } : (depth && typeof depth === 'object' ? { ...depth, write: false } : depth);
      this.device.draw({ ...common, first: surface.edgeFirst, count: surface.edgeCount, depth: edgeDepth });
    }
  }
  deleteSurface(surface) {
    if (!this.surfaces.has(surface)) return false;
    this.device.deleteVertexBuffer(surface.buffer); this.surfaces.delete(surface); this.bytes -= surface.byteLength;
    return true;
  }
  stats() { return Object.freeze({ state: this.state, surfaceCount: this.surfaces.size, retainedBytes: this.bytes, pipelineCount: this.pipelines.size, maxClipPlanes: this.maxClipPlanes }); }
  dispose() {
    if (this.disposed) return false;
    this.device.canvas.removeEventListener('webglcontextlost', this.onLost);
    this.device.canvas.removeEventListener('webglcontextrestored', this.onRestored);
    for (const surface of this.surfaces) this.device.deleteVertexBuffer(surface.buffer);
    for (const pipeline of this.pipelines.values()) this.device.deletePipeline(pipeline);
    this.surfaces.clear(); this.pipelines.clear(); this.bytes = 0; this.disposed = true; this.state = 'disposed';
    return true;
  }
}

/** Exposed for exact bounded-geometry assertions; it never creates per-stitch or per-fiber vertices. */
export function buildYarnSurfaceGeometry(options) {
  validateStyle(options?.style);
  return surfaceGeometry(options.fillVertices, options.outline, options.edgeColors, options.style);
}

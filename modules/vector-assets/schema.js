export const VECTOR_ASSET_SCHEMA_VERSION = 1;
export const VECTOR_ASSET_COMPILER_VERSION = '0.5.0';
const ACCEPTED_COMPILER_VERSIONS = new Set(['0.2.0', '0.3.0', '0.4.0', VECTOR_ASSET_COMPILER_VERSION]);
export const NUMERIC_POSE_FIELDS = Object.freeze(['x', 'y', 'rotation', 'scaleX', 'scaleY', 'opacity']);
const EASINGS = new Set(['linear', 'inSine', 'outSine', 'inOutSine', 'inQuad', 'outQuad', 'inOutQuad', 'inCubic', 'outCubic', 'inOutCubic']);
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value, keys) => isObject(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const finite = value => typeof value === 'number' && Number.isFinite(value);

function requireId(value, name) {
  if (typeof value !== 'string' || !/^[A-Za-z_][A-Za-z0-9_.:-]{0,127}$/.test(value)) throw new TypeError(name + ' must be a stable SVG id');
}

function requirePoint(value, name) {
  if (!Array.isArray(value) || value.length !== 2 || !value.every(finite)) throw new TypeError(name + ' must be two finite numbers');
}

export function validateAssetMetadata(metadata, idNodes) {
  const metadataKeys = ['schemaVersion', 'id', 'defaultExpression', 'parts', 'expressions', 'sockets', 'clips'];
  if (!isObject(metadata) || ![metadataKeys.length, metadataKeys.length + 1].includes(Object.keys(metadata).length)
      || metadataKeys.some(key => !Object.hasOwn(metadata, key))
      || Object.keys(metadata).some(key => ![...metadataKeys, 'styles'].includes(key))
      || metadata.schemaVersion !== VECTOR_ASSET_SCHEMA_VERSION) {
    throw new TypeError('SVG metadata must use the exact vector asset schemaVersion 1 fields');
  }
  requireId(metadata.id, 'asset id');
  if (!Array.isArray(metadata.parts) || metadata.parts.length < 1 || metadata.parts.length > 16) throw new RangeError('1..16 parts are supported');
  const parts = new Map();
  for (const part of metadata.parts) {
    if (!exactKeys(part, ['id', 'parent', 'pivot'])) throw new TypeError('part fields must be id, parent, and pivot');
    requireId(part.id, 'part id');
    if (parts.has(part.id) || !idNodes.has(part.id) || idNodes.get(part.id).nodeName !== 'g') throw new TypeError('part id must uniquely target an authored SVG g element: ' + part.id);
    if (part.parent !== null) requireId(part.parent, 'part parent');
    requirePoint(part.pivot, 'part pivot');
    parts.set(part.id, part);
  }
  for (const part of metadata.parts) {
    if (part.parent !== null && !parts.has(part.parent)) throw new TypeError('unknown part parent: ' + part.parent);
    const seen = new Set([part.id]);
    let parent = part.parent;
    while (parent !== null) {
      if (seen.has(parent)) throw new TypeError('part hierarchy contains a cycle: ' + part.id);
      seen.add(parent);
      parent = parts.get(parent).parent;
    }
  }
  if (!isObject(metadata.expressions) || !Object.keys(metadata.expressions).length) throw new TypeError('at least one expression variant is required');
  if (typeof metadata.defaultExpression !== 'string' || !Object.hasOwn(metadata.expressions, metadata.defaultExpression)) throw new TypeError('defaultExpression must name an expression variant');
  for (const [name, expression] of Object.entries(metadata.expressions)) {
    requireId(name, 'expression id');
    if (!exactKeys(expression, ['show', 'hide']) || !Array.isArray(expression.show) || !Array.isArray(expression.hide)) throw new TypeError('expressions need show and hide part id arrays');
    const seen = new Set();
    for (const id of [...expression.show, ...expression.hide]) {
      requireId(id, 'expression part id');
      if (!parts.has(id) || seen.has(id)) throw new TypeError('expression references an unknown or repeated part: ' + id);
      seen.add(id);
    }
  }
  if (!isObject(metadata.sockets)) throw new TypeError('sockets must be an object keyed by socket id');
  for (const [name, socket] of Object.entries(metadata.sockets)) {
    requireId(name, 'socket id');
    if (!exactKeys(socket, ['part', 'point']) || !parts.has(socket.part)) throw new TypeError('socket must reference a known part');
    requirePoint(socket.point, 'socket point');
  }
  if (metadata.styles !== undefined) {
    if (!Array.isArray(metadata.styles) || metadata.styles.length > 128) throw new RangeError('styles must contain at most 128 SVG target declarations');
    const targets = new Set();
    let sketchPeriod = null;
    for (const style of metadata.styles) {
      if (!isObject(style) || typeof style.target !== 'string') throw new TypeError('A style target must name an SVG shape id');
      requireId(style.target, 'style target');
      if (targets.has(style.target) || !idNodes.has(style.target) || !['path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon'].includes(idNodes.get(style.target).nodeName)) {
        throw new TypeError('Style targets must uniquely reference an authored SVG shape: ' + style.target);
      }
      targets.add(style.target);
      if (style.kind === 'yarn') {
        const required = ['target', 'kind', 'seed', 'stitchWidth', 'stitchHeight', 'thickness', 'irregularity', 'contrast', 'edgeSpacing', 'edgeRelief', 'edgeWidth', 'fiberLength', 'fiberWidth', 'fiberOpacity', 'fiberMax'];
        const optional = ['fiberSpacing', 'curved', 'pattern', 'detail', 'fiber'];
        if (!isObject(style) || required.some(key => !Object.hasOwn(style, key))
            || Object.keys(style).some(key => ![...required, ...optional].includes(key))) {
          throw new TypeError('Yarn style fields are incomplete or unsupported: ' + style.target);
        }
        for (const key of ['stitchWidth', 'stitchHeight', 'thickness', 'edgeSpacing', 'edgeRelief', 'edgeWidth', 'fiberLength', 'fiberWidth', ...(style.fiberSpacing === undefined ? [] : ['fiberSpacing'])]) {
          if (!finite(style[key]) || style[key] <= 0) throw new RangeError('Yarn ' + key + ' must be positive');
        }
        for (const key of ['irregularity', 'contrast', 'fiberOpacity']) {
          if (!finite(style[key]) || style[key] < 0 || style[key] > 1) throw new RangeError('Yarn ' + key + ' must be in [0,1]');
        }
        for (const key of ['curved', 'pattern', 'detail', 'fiber']) {
          if (style[key] !== undefined && typeof style[key] !== 'boolean') throw new TypeError('Yarn ' + key + ' must be boolean');
        }
        if (!Number.isSafeInteger(style.seed) || style.seed < 0 || style.seed > 0x7fffffff
            || !Number.isSafeInteger(style.fiberMax) || style.fiberMax < 0 || style.fiberMax > 512) throw new RangeError('Yarn seed/fiberMax is outside its bound');
      } else if (style.kind === 'sketch') {
        if (!exactKeys(style, ['target', 'kind', 'seed', 'periodMs', 'amplitude', 'frequency', 'echoX', 'echoY', 'echoWidth', 'echoOpacity', 'hatchAngle', 'hatchSpacing', 'hatchWidth', 'hatchOpacity'])) {
          throw new TypeError('Sketch style fields are incomplete or unsupported: ' + style.target);
        }
        for (const key of ['amplitude', 'frequency', 'echoWidth', 'hatchSpacing', 'hatchWidth']) {
          if (!finite(style[key]) || style[key] <= 0) throw new RangeError('Sketch ' + key + ' must be positive');
        }
        for (const key of ['echoX', 'echoY', 'hatchAngle']) if (!finite(style[key])) throw new TypeError('Sketch ' + key + ' must be finite');
        for (const key of ['echoOpacity', 'hatchOpacity']) if (!finite(style[key]) || style[key] < 0 || style[key] > 1) throw new RangeError('Sketch ' + key + ' must be in [0,1]');
        if (!Number.isSafeInteger(style.seed) || style.seed < 0 || style.seed > 0x7fffffff
            || !Number.isSafeInteger(style.periodMs) || style.periodMs < 16 || style.periodMs > 10000) throw new RangeError('Sketch seed/periodMs is outside its bound');
        if (sketchPeriod !== null && sketchPeriod !== style.periodMs) throw new RangeError('All sketch targets in one SVG must share a periodMs');
        sketchPeriod = style.periodMs;
      } else throw new TypeError('Unsupported authored style kind: ' + String(style.kind));
    }
  }
  if (!isObject(metadata.clips) || !Object.keys(metadata.clips).length) throw new TypeError('at least one authored clip is required');
  for (const [name, clip] of Object.entries(metadata.clips)) {
    requireId(name, 'clip id');
    if (!exactKeys(clip, ['durationMs', 'loop', 'easing', 'keyframes']) || !finite(clip.durationMs) || clip.durationMs <= 0
        || !['once', 'repeat', 'alternate'].includes(clip.loop) || !EASINGS.has(clip.easing)
        || !Array.isArray(clip.keyframes) || clip.keyframes.length < 2) throw new TypeError('clip fields, duration, loop, easing, or keyframes are unsupported: ' + name);
    let previousTime = -1;
    for (const frame of clip.keyframes) {
      if (!exactKeys(frame, ['timeMs', 'easing', 'parts']) || !finite(frame.timeMs) || frame.timeMs <= previousTime
          || !EASINGS.has(frame.easing) || !isObject(frame.parts)) throw new TypeError('keyframe fields, time, or easing are invalid: ' + name);
      for (const [partId, pose] of Object.entries(frame.parts)) {
        if (!parts.has(partId) || !isObject(pose) || !Object.keys(pose).length) throw new TypeError('keyframe targets an unknown part or empty pose: ' + partId);
        for (const [field, value] of Object.entries(pose)) {
          if (!NUMERIC_POSE_FIELDS.includes(field) || !finite(value)) throw new TypeError('keyframe may only animate finite numeric pose fields');
          if (field === 'opacity' && (value < 0 || value > 1)) throw new RangeError('part opacity must be in [0,1]');
          if ((field === 'scaleX' || field === 'scaleY') && value === 0) throw new RangeError('part scale cannot be zero');
        }
      }
      previousTime = frame.timeMs;
    }
    if (clip.keyframes[0].timeMs !== 0 || previousTime !== clip.durationMs) throw new RangeError('clip keyframes must start at 0 and end at durationMs: ' + name);
  }
  return metadata;
}

export function validateCompiledAsset(asset) {
  if (!isObject(asset) || asset.schemaVersion !== VECTOR_ASSET_SCHEMA_VERSION || !ACCEPTED_COMPILER_VERSIONS.has(asset.compilerVersion)
      || typeof asset.sourceSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(asset.sourceSha256)
      || !isObject(asset.metadata) || !isObject(asset.geometry)
      || !(asset.geometry.vertices instanceof Float32Array) || asset.geometry.vertices.length < 33
      || asset.geometry.vertices.length % 11 || asset.geometry.strideFloats !== 11
      || asset.geometry.partCount !== asset.metadata.parts?.length || ![0, 2].includes(asset.geometry.morphCount)) {
    throw new TypeError('Invalid compiled SVG vector asset');
  }
  const vertexCount = asset.geometry.vertices.length / 11, indices = asset.geometry.indices;
  if (indices !== undefined && (!(indices instanceof Uint16Array) || indices.length < 3 || indices.length % 3
      || vertexCount > 0x10000 || indices.some(index => index >= vertexCount))) {
    throw new TypeError('Invalid compiled SVG vertex indices');
  }
  if (indices === undefined && vertexCount % 3) throw new TypeError('Non-indexed compiled SVG geometry must contain complete triangles');
  return asset;
}

export function freezeData(value) {
  if (!isObject(value) && !Array.isArray(value)) return value;
  for (const child of Object.values(value)) freezeData(child);
  return Object.freeze(value);
}

export const VECTOR_ASSET_SCHEMA_VERSION = 1;
export const VECTOR_ASSET_COMPILER_VERSION = '0.1.0';
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
  if (!exactKeys(metadata, ['schemaVersion', 'id', 'defaultExpression', 'parts', 'expressions', 'sockets', 'clips']) || metadata.schemaVersion !== VECTOR_ASSET_SCHEMA_VERSION) {
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
  if (!isObject(asset) || asset.schemaVersion !== VECTOR_ASSET_SCHEMA_VERSION || asset.compilerVersion !== VECTOR_ASSET_COMPILER_VERSION
      || typeof asset.sourceSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(asset.sourceSha256)
      || !isObject(asset.metadata) || !isObject(asset.geometry)
      || !(asset.geometry.vertices instanceof Float32Array) || asset.geometry.vertices.length < 33
      || asset.geometry.vertices.length % 33 || asset.geometry.strideFloats !== 11
      || asset.geometry.partCount !== asset.metadata.parts?.length || asset.geometry.morphCount !== 0) {
    throw new TypeError('Invalid compiled SVG vector asset');
  }
  return asset;
}

export function freezeData(value) {
  if (!isObject(value) && !Array.isArray(value)) return value;
  for (const child of Object.values(value)) freezeData(child);
  return Object.freeze(value);
}

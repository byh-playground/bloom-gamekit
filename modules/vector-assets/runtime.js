import { createTimeline } from 'animejs/timeline';
import { validateCompiledAsset } from './schema.js';

const IDENTITY = Object.freeze([1, 0, 0, 1, 0, 0]);
const DEFAULT_POSE = Object.freeze({ x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1, opacity: 1 });
const POSE_FIELDS = Object.keys(DEFAULT_POSE);

const finiteTime = (value, name) => {
  if (!Number.isFinite(value)) throw new TypeError(`${name} must be a finite absolute display time in milliseconds`);
  return value;
};

function localMatrix(pivot, pose) {
  const [px, py] = pivot, cosine = Math.cos(pose.rotation), sine = Math.sin(pose.rotation);
  const a = cosine * pose.scaleX, b = sine * pose.scaleX, c = -sine * pose.scaleY, d = cosine * pose.scaleY;
  return [a, b, c, d, px + pose.x - a * px - c * py, py + pose.y - b * px - d * py];
}

function multiply(a, b) {
  return [
    a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5],
  ];
}

function composeWorldMatrix(world, local) {
  if (!world || world.length !== 16 || local.length !== 6 || Array.from(local).some(value => !Number.isFinite(value))) throw new TypeError('Six finite root matrix values required');
  const [a, b, c, d, e, f] = local, out = Float32Array.from(world);
  for (const value of out) if (!Number.isFinite(value)) throw new TypeError('worldMatrix must contain 16 finite values');
  if (Math.abs(out[3]) > 1e-7 || Math.abs(out[7]) > 1e-7 || Math.abs(out[11]) > 1e-7 || Math.abs(out[15] - 1) > 1e-7) {
    throw new TypeError('worldMatrix must be an affine column-major 4x4 matrix');
  }
  out[0] = world[0] * a + world[4] * b; out[1] = world[1] * a + world[5] * b; out[2] = world[2] * a + world[6] * b; out[3] = world[3] * a + world[7] * b;
  out[4] = world[0] * c + world[4] * d; out[5] = world[1] * c + world[5] * d; out[6] = world[2] * c + world[6] * d; out[7] = world[3] * c + world[7] * d;
  out[12] = world[0] * e + world[4] * f + world[12]; out[13] = world[1] * e + world[5] * f + world[13];
  out[14] = world[2] * e + world[6] * f + world[14]; out[15] = world[3] * e + world[7] * f + world[15];
  return out;
}

function validateShaderSurfaceClipCapacity(clips, maxPlanes) {
  if (!clips?.length) return;
  if (!Array.isArray(clips)) throw new TypeError('clips must be an array of convex polygons');
  let edgeCount = 0;
  for (const polygon of clips) {
    if (!Array.isArray(polygon) || polygon.length < 3 || polygon.some(point => !Number.isFinite(point?.x) || !Number.isFinite(point?.y))) {
      throw new TypeError('Finite convex clip polygons required');
    }
    let area = 0;
    for (let i = 0; i < polygon.length; i++) {
      const a = polygon[i], b = polygon[(i + 1) % polygon.length];
      area += a.x * b.y - b.x * a.y;
      if (Math.hypot(b.x - a.x, b.y - a.y) > 0) edgeCount++;
    }
    if (Math.abs(area) < 1e-8) throw new RangeError('A clip polygon must have nonzero area');
    if (edgeCount > maxPlanes) throw new RangeError(`Vector asset clipping exceeds the shader surface limit of ${maxPlanes} edge planes`);
  }
}

function transformPoint(matrix, point) {
  return { x: matrix[0] * point[0] + matrix[2] * point[1] + matrix[4], y: matrix[1] * point[0] + matrix[3] * point[1] + matrix[5] };
}

function effectivePose(base, authored) {
  return {
    x: base.x + authored.x, y: base.y + authored.y, rotation: base.rotation + authored.rotation,
    scaleX: base.scaleX * authored.scaleX, scaleY: base.scaleY * authored.scaleY, opacity: base.opacity * authored.opacity,
  };
}

function loopTime(clip, elapsed) {
  if (clip.loop === 'once') return Math.min(clip.durationMs, Math.max(0, elapsed));
  if (clip.loop === 'repeat') return ((elapsed % clip.durationMs) + clip.durationMs) % clip.durationMs;
  const cycle = clip.durationMs * 2, point = ((elapsed % cycle) + cycle) % cycle;
  return point <= clip.durationMs ? point : cycle - point;
}

function buildClipTimeline(clip, parts) {
  const tracks = new Map(parts.map(part => [part.id, { ...DEFAULT_POSE }]));
  const first = clip.keyframes[0];
  for (const [partId, pose] of Object.entries(first.parts)) Object.assign(tracks.get(partId), pose);
  const timeline = createTimeline({ autoplay: false });
  for (let frameIndex = 1; frameIndex < clip.keyframes.length; frameIndex++) {
    const previous = clip.keyframes[frameIndex - 1], frame = clip.keyframes[frameIndex];
    const duration = frame.timeMs - previous.timeMs;
    for (const [partId, pose] of Object.entries(frame.parts)) {
      timeline.add(tracks.get(partId), { ...pose, duration, ease: frame.easing }, previous.timeMs);
    }
  }
  if (!timeline.paused) timeline.pause();
  return { timeline, tracks };
}

function copyPose(pose) {
  return Object.fromEntries(POSE_FIELDS.map(field => [field, pose[field]]));
}

function authoredMorph(metadata, displayTimeMs) {
  const sketch = metadata.styles?.find(style => style.kind === 'sketch');
  if (!sketch) return [0, 0];
  const phase = (((displayTimeMs % sketch.periodMs) + sketch.periodMs) % sketch.periodMs) / sketch.periodMs * 3;
  const segment = Math.floor(phase), amount = phase - segment;
  if (segment === 0) return [amount, 0];
  if (segment === 1) return [1 - amount, amount];
  return [0, 1 - amount];
}

function blendPoses(from, to, amount, partIds) {
  const output = new Map();
  for (const id of partIds) {
    const a = from.get(id) ?? DEFAULT_POSE, b = to.get(id) ?? DEFAULT_POSE;
    output.set(id, Object.fromEntries(POSE_FIELDS.map(field => [field, a[field] + (b[field] - a[field]) * amount])));
  }
  return output;
}

/** Owns one retained GPU mesh; its players own only independent pose/timeline state. */
export function createVectorAsset(meshRenderer, compiledAsset, { surfaceRenderer = null } = {}) {
  if (!meshRenderer?.createMesh || !meshRenderer?.drawMesh || !meshRenderer?.deleteMesh) throw new TypeError('A GameKit MeshRenderer is required');
  validateCompiledAsset(compiledAsset);
  const metadata = compiledAsset.metadata;
  const partIndices = new Map(metadata.parts.map((part, index) => [part.id, index]));
  const clips = metadata.clips;
  const geometry = compiledAsset.geometry, shaderGeometry = geometry.shaderSurfaces ?? [];
  if (shaderGeometry.length && (!surfaceRenderer?.createSurface || !surfaceRenderer?.drawSurface || !surfaceRenderer?.deleteSurface)) {
    throw new TypeError('This SVG declares backend:"shader"; pass a GameKit YarnSurfaceRenderer when creating the vector asset');
  }
  const mesh = geometry.vertices.length ? meshRenderer.createMesh(geometry) : null;
  const retainedSurfaces = [];
  try {
    for (const descriptor of shaderGeometry) retainedSurfaces.push(surfaceRenderer.createSurface(descriptor));
  } catch (error) {
    for (const surface of retainedSurfaces) surfaceRenderer.deleteSurface(surface);
    if (mesh) meshRenderer.deleteMesh(mesh);
    throw error;
  }
  const players = new Set();
  let disposed = false;

  const requireReady = () => { if (disposed) throw new Error('Vector asset is disposed'); };
  const createPlayer = ({ clip = Object.keys(clips)[0], startedAtMs = 0 } = {}) => {
    requireReady();
    if (!Object.hasOwn(clips, clip)) throw new TypeError(`Unknown vector clip: ${clip}`);
    finiteTime(startedAtMs, 'startedAtMs');
    const timelines = new Map();
    for (const [name, definition] of Object.entries(clips)) timelines.set(name, buildClipTimeline(definition, metadata.parts));
    const expressionParts = new Set(Object.values(metadata.expressions).flatMap(expression => [...expression.show, ...expression.hide]));
    const visible = new Map(metadata.parts.map(part => [part.id, !expressionParts.has(part.id)]));
    const basePose = new Map(metadata.parts.map(part => [part.id, { ...DEFAULT_POSE }]));
    const initial = metadata.expressions[metadata.defaultExpression];
    for (const id of initial.show) visible.set(id, true);
    for (const id of initial.hide) visible.set(id, false);

    let rootPlayback = { kind: 'clip', name: clip, startedAtMs };
    let expression = metadata.defaultExpression;
    let visibilityOverridden = false;
    let displayTimeMs = startedAtMs;
    let currentPose = new Map(metadata.parts.map(part => [part.id, { ...DEFAULT_POSE }]));
    let playerDisposed = false;

    const assertPlayer = () => { requireReady(); if (playerDisposed) throw new Error('Vector player is disposed'); };
    const sampleClip = (playback, timeMs) => {
      const definition = clips[playback.name], localTime = loopTime(definition, timeMs - playback.startedAtMs);
      const record = timelines.get(playback.name);
      record.timeline.seek(localTime, true);
      const output = new Map();
      for (const [id, pose] of record.tracks) output.set(id, copyPose(pose));
      return output;
    };
    const sample = (playback, timeMs) => {
      if (playback.kind === 'clip') return sampleClip(playback, timeMs);
      const source = sample(playback.from, timeMs);
      if (timeMs < playback.atMs) return source;
      const target = sample(playback.to, timeMs);
      const amount = playback.durationMs === 0 ? 1 : Math.min(1, Math.max(0, (timeMs - playback.atMs) / playback.durationMs));
      return blendPoses(source, target, amount, metadata.parts.map(part => part.id));
    };
    const seek = timeMs => {
      assertPlayer();
      displayTimeMs = finiteTime(timeMs, 'displayTimeMs');
      currentPose = sample(rootPlayback, displayTimeMs);
      return player;
    };
    const setExpression = name => {
      assertPlayer();
      const variant = metadata.expressions[name];
      if (!variant) throw new TypeError(`Unknown vector expression: ${name}`);
      for (const id of expressionParts) visible.set(id, false);
      for (const id of variant.show) visible.set(id, true);
      for (const id of variant.hide) visible.set(id, false);
      expression = name;
      visibilityOverridden = false;
      return player;
    };
    const setPartVisible = (id, isVisible) => {
      assertPlayer();
      if (!partIndices.has(id) || typeof isVisible !== 'boolean') throw new TypeError('Known part id and boolean visibility required');
      visible.set(id, isVisible);
      visibilityOverridden = true;
      return player;
    };
    const setBasePose = (id, pose) => {
      assertPlayer();
      if (!partIndices.has(id) || !pose || typeof pose !== 'object' || Array.isArray(pose)) throw new TypeError('Known part and pose object required');
      const current = basePose.get(id);
      for (const [field, value] of Object.entries(pose)) {
        if (!POSE_FIELDS.includes(field) || !Number.isFinite(value)) throw new TypeError('Part base poses accept only finite authored numeric pose fields');
        if (field === 'opacity' && (value < 0 || value > 1)) throw new RangeError('Part opacity must be in [0,1]');
        if ((field === 'scaleX' || field === 'scaleY') && value === 0) throw new RangeError('Part scale cannot be zero');
        current[field] = value;
      }
      return player;
    };
    const play = (name, atMs = displayTimeMs) => {
      assertPlayer();
      if (!Object.hasOwn(clips, name)) throw new TypeError(`Unknown vector clip: ${name}`);
      rootPlayback = { kind: 'clip', name, startedAtMs: finiteTime(atMs, 'atMs') };
      return seek(atMs);
    };
    const transitionTo = (name, atMs = displayTimeMs, durationMs = 0) => {
      assertPlayer();
      if (!Object.hasOwn(clips, name)) throw new TypeError(`Unknown vector clip: ${name}`);
      finiteTime(atMs, 'atMs');
      if (!Number.isFinite(durationMs) || durationMs < 0) throw new RangeError('transition duration must be finite and nonnegative');
      rootPlayback = { kind: 'transition', from: rootPlayback, to: { kind: 'clip', name, startedAtMs: atMs }, atMs, durationMs };
      return seek(atMs);
    };
    const worldMatrices = () => {
      const output = new Map();
      const resolvePart = id => {
        if (output.has(id)) return output.get(id);
        const definition = metadata.parts[partIndices.get(id)];
        const pose = effectivePose(basePose.get(id), currentPose.get(id));
        const local = localMatrix(definition.pivot, pose);
        const matrix = definition.parent === null ? local : multiply(resolvePart(definition.parent), local);
        output.set(id, matrix);
        return matrix;
      };
      for (const part of metadata.parts) resolvePart(part.id);
      return output;
    };
    const getSocket = id => {
      assertPlayer();
      const socket = metadata.sockets[id];
      if (!socket) throw new TypeError(`Unknown vector socket: ${id}`);
      return transformPoint(worldMatrices().get(socket.part), socket.point);
    };
    const partPoses = () => {
      assertPlayer();
      const matrices = worldMatrices(), output = metadata.parts.map((part, index) => {
        const morph = authoredMorph(metadata, displayTimeMs);
        let parentVisible = true, opacity = 1, parent = part;
        while (parent) {
          parentVisible &&= visible.get(parent.id) !== false;
          opacity *= effectivePose(basePose.get(parent.id), currentPose.get(parent.id)).opacity;
          parent = parent.parent === null ? null : metadata.parts[partIndices.get(parent.parent)];
        }
        return { transform: matrices.get(part.id), morph, opacity, visible: parentVisible, index };
      });
      return output;
    };
    const draw = ({ projection, viewProjection, worldMatrix, matrix = IDENTITY, alpha = 1, color = [1, 1, 1, 1], forceColor = false, whiteFlash = false,
      clips = [], stencilRef = null, depth = 0, depthTest = false, depthWrite = false, depthFunc = 'lequal', strokeViewport = null } = {}) => {
      assertPlayer();
      if (geometry.shaderSurfaces?.length) validateShaderSurfaceClipCapacity(clips, surfaceRenderer.maxClipPlanes);
      const fullPartPoses = partPoses();
      const poses = fullPartPoses.map(({ transform, opacity, visible: isVisible }) => ({ transform, opacity, visible: isVisible }));
      if (geometry.drawOrder) {
        const worldMode = viewProjection !== undefined || worldMatrix !== undefined;
        for (const command of geometry.drawOrder) {
          if (command.kind === 'mesh') {
            if (!poses[command.partIndex].visible || poses[command.partIndex].opacity <= 0) continue;
            if (!mesh) throw new Error('SVG draw order references mesh geometry that was not retained');
            meshRenderer.drawMesh(mesh, { ...(worldMode ? { viewProjection, worldMatrix } : { projection }), matrix,
              parts: poses, morph: authoredMorph(metadata, displayTimeMs), alpha, color, forceColor, whiteFlash,
              clips, stencilRef, depth, depthTest, depthWrite, depthFunc, strokeViewport,
              indexRange: [command.firstIndex, command.indexCount] });
            continue;
          }
          const surface = retainedSurfaces[command.surfaceIndex], pose = fullPartPoses[geometry.shaderSurfaces[command.surfaceIndex].partIndex];
          if (!pose.visible || pose.opacity <= 0) continue;
          meshRenderer.flush('vectorShaderSurfaceBoundary');
          const materialTransform = worldMode ? pose.transform : multiply(matrix, pose.transform);
          const shaderDepth = depthTest || depthWrite ? { test: depthTest, write: depthWrite, func: depthFunc } : false;
          surfaceRenderer.drawSurface(surface, { ...(worldMode ? { viewProjection, worldMatrix: composeWorldMatrix(worldMatrix, matrix) } : { projection }),
            transform: materialTransform, color, alpha: alpha * pose.opacity, forceColor, whiteFlash: whiteFlash ? 1 : 0,
            timeMs: displayTimeMs, clips, stencilRef, z: depth, depth: shaderDepth });
        }
        return;
      }
      const indexVariant = !visibilityOverridden && compiledAsset.geometry.expressionIndices?.[expression] ? expression : null;
      const worldMode = viewProjection !== undefined || worldMatrix !== undefined;
      meshRenderer.drawMesh(mesh, { ...(worldMode ? { viewProjection, worldMatrix } : { projection }), matrix, parts: poses, morph: authoredMorph(metadata, displayTimeMs), alpha, color, forceColor,
        whiteFlash, clips, stencilRef, depth, depthTest, depthWrite, depthFunc, indexVariant, strokeViewport });
    };
    const getPartPose = id => {
      assertPlayer();
      if (!partIndices.has(id)) throw new TypeError(`Unknown vector part: ${id}`);
      const index = partIndices.get(id), effective = partPoses()[index];
      return { ...currentPose.get(id), visible: effective.visible, transform: effective.transform };
    };
    const disposePlayer = () => {
      if (playerDisposed) return false;
      for (const { timeline } of timelines.values()) timeline.pause();
      timelines.clear(); players.delete(player); playerDisposed = true;
      return true;
    };
    const player = Object.freeze({
      seek, play, transitionTo, setExpression, setPartVisible, setBasePose, getPartPose, getSocket, partPoses, draw,
      dispose: disposePlayer,
      get currentClip() { return rootPlayback.kind === 'clip' ? rootPlayback.name : rootPlayback.to.name; },
      get currentExpression() { return expression; },
      get currentTimeMs() { return displayTimeMs; },
      get disposed() { return playerDisposed; },
    });
    players.add(player);
    seek(startedAtMs);
    return player;
  };

  const dispose = () => {
    if (disposed) return false;
    for (const player of [...players]) player.dispose();
    if (mesh) meshRenderer.deleteMesh(mesh);
    for (const surface of retainedSurfaces) surfaceRenderer.deleteSurface(surface);
    disposed = true;
    return true;
  };
  return Object.freeze({
    id: metadata.id, sourceSha256: compiledAsset.sourceSha256, schemaVersion: compiledAsset.schemaVersion,
    compilerVersion: compiledAsset.compilerVersion, viewBox: Object.freeze([...compiledAsset.viewBox]),
    metadata, mesh, surfaces: Object.freeze(retainedSurfaces), createPlayer, dispose,
    get disposed() { return disposed; },
    get playerCount() { return players.size; },
  });
}

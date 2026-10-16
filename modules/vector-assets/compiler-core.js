import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import { Color, Path, Shape, ShapeGeometry, SRGBColorSpace, Vector2 } from 'three';
import { SVGLoader } from 'three/addons/loaders/SVGLoader.js';
import { VECTOR_ASSET_COMPILER_VERSION, VECTOR_ASSET_SCHEMA_VERSION, validateAssetMetadata } from './schema.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const MAX_SOURCE_BYTES = 512 * 1024;
const MAX_ELEMENTS = 4096;
const NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;
const ATTRIBUTES = new Set([
  'id', 'xmlns', 'width', 'height', 'viewBox', 'version', 'transform',
  'd', 'x', 'y', 'width', 'height', 'cx', 'cy', 'r', 'rx', 'ry', 'x1', 'y1', 'x2', 'y2', 'points',
  'fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-opacity', 'stroke-width',
  'stroke-linecap', 'stroke-linejoin', 'stroke-miterlimit', 'vector-effect', 'opacity',
]);
const GRADIENT_ATTRIBUTES = new Set(['id', 'gradientUnits', 'spreadMethod', 'x1', 'y1', 'x2', 'y2']);
const STOP_ATTRIBUTES = new Set(['id', 'offset', 'stop-color', 'stop-opacity']);
const ELEMENTS = new Set(['svg', 'metadata', 'defs', 'linearGradient', 'stop', 'g', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon']);

function finiteList(value, count, name) {
  const values = value.trim().split(/[\s,]+/).filter(Boolean).map(Number);
  if (values.length !== count || values.some(number => !Number.isFinite(number))) throw new TypeError(name + ' must contain ' + count + ' finite numbers');
  return values;
}

function validateTransform(value) {
  let cursor = 0;
  const transform = /([A-Za-z]+)\s*\(([^()]*)\)\s*/gy;
  const lengths = { matrix: 6, translate: [1, 2], scale: [1, 2], rotate: [1, 3], skewX: 1, skewY: 1 };
  while (cursor < value.length) {
    while (/\s|,/.test(value[cursor] ?? '')) cursor++;
    if (cursor === value.length) break;
    transform.lastIndex = cursor;
    const match = transform.exec(value);
    if (!match || !Object.hasOwn(lengths, match[1])) throw new TypeError('Unsupported SVG transform syntax');
    const args = match[2].trim().split(/[\s,]+/).filter(Boolean);
    const expected = lengths[match[1]];
    const validCount = Array.isArray(expected) ? expected.includes(args.length) : args.length === expected;
    if (!validCount || args.some(argument => !NUMBER.test(argument))) throw new TypeError('Invalid SVG transform arguments');
    cursor = transform.lastIndex;
  }
}

function gradientCoordinate(value, units, name) {
  const raw = value ?? ({ x1: '0%', y1: '0%', x2: '100%', y2: '0%' }[name]);
  if (units === 'objectBoundingBox') {
    const percent = /^([+-]?(?:\d+\.?\d*|\.\d+))%$/.exec(raw);
    const number = percent ? Number(percent[1]) / 100 : NUMBER.test(raw) ? Number(raw) : NaN;
    if (!Number.isFinite(number) || number < 0 || number > 1) throw new RangeError('objectBoundingBox gradient ' + name + ' must be in [0,1]');
    return number;
  }
  if (!NUMBER.test(raw) || !Number.isFinite(Number(raw))) throw new TypeError('userSpaceOnUse gradient ' + name + ' must be a unitless CSS pixel number');
  return Number(raw);
}

function parseGradientDefinitions(root, ids) {
  const gradients = new Map();
  const candidates = [];
  const visit = node => {
    if (node.nodeType === 1 && node.nodeName === 'linearGradient') candidates.push(node);
    for (let child = node.firstChild; child; child = child.nextSibling) visit(child);
  };
  visit(root);
  for (const node of candidates) {
    if (node.parentNode?.nodeName !== 'defs' || node.parentNode.parentNode !== root) throw new TypeError('linearGradient must be a direct child of root defs');
    if (!node.getAttribute('id') || ids.get(node.getAttribute('id')) !== node) throw new TypeError('linearGradient needs a unique id');
    const units = node.getAttribute('gradientUnits') || 'objectBoundingBox';
    const spread = node.getAttribute('spreadMethod') || 'pad';
    if (!['objectBoundingBox', 'userSpaceOnUse'].includes(units) || spread !== 'pad') throw new TypeError('Only pad linearGradient with objectBoundingBox or userSpaceOnUse coordinates is supported');
    const x1 = gradientCoordinate(node.getAttribute('x1'), units, 'x1');
    const y1 = gradientCoordinate(node.getAttribute('y1'), units, 'y1');
    const x2 = gradientCoordinate(node.getAttribute('x2'), units, 'x2');
    const y2 = gradientCoordinate(node.getAttribute('y2'), units, 'y2');
    if (x1 === x2 && y1 === y2) throw new TypeError('A linearGradient needs two distinct endpoints');
    const stops = [];
    for (let child = node.firstChild; child; child = child.nextSibling) {
      if (child.nodeType !== 1) continue;
      if (child.nodeName !== 'stop') throw new TypeError('linearGradient may contain stop elements only');
      const rawOffset = child.getAttribute('offset') || '0';
      const percent = /^([+-]?(?:\d+\.?\d*|\.\d+))%$/.exec(rawOffset);
      const offset = percent ? Number(percent[1]) / 100 : NUMBER.test(rawOffset) ? Number(rawOffset) : NaN;
      const colorText = child.getAttribute('stop-color') || '#000000';
      const opacityText = child.getAttribute('stop-opacity') || '1';
      if (!Number.isFinite(offset) || offset < 0 || offset > 1 || (stops.length && offset < stops[stops.length - 1].offset)) throw new RangeError('linearGradient stop offsets must be nondecreasing in [0,1]');
      if (!NUMBER.test(opacityText) || Number(opacityText) < 0 || Number(opacityText) > 1) throw new RangeError('stop-opacity must be in [0,1]');
      let color;
      try { color = colorComponents(new Color().setStyle(colorText, SRGBColorSpace), Number(opacityText)); }
      catch { throw new TypeError('Unsupported linearGradient stop color: ' + colorText); }
      stops.push({ offset, color });
      if (stops.length > 16) throw new RangeError('linearGradient supports at most 16 stops');
    }
    if (stops.length < 2) throw new TypeError('linearGradient needs at least two explicit stop elements');
    gradients.set(node.getAttribute('id'), { id: node.getAttribute('id'), units, x1, y1, x2, y2, stops });
  }
  return gradients;
}

function parseXml(source, label) {
  const errors = [];
  const document = new DOMParser({
    onError(level, message) {
      errors.push(String(level) + ': ' + String(message));
    },
  }).parseFromString(source, 'image/svg+xml');
  if (errors.length) throw new SyntaxError('Invalid SVG ' + label + ': ' + errors.join('; '));
  if (!document?.documentElement || document.documentElement.nodeName !== 'svg') throw new TypeError('An SVG document root is required');
  return document;
}

function collectIds(root) {
  const ids = new Map();
  let elementCount = 0;
  const visit = node => {
    if (node.nodeType === 1) {
      if (++elementCount > MAX_ELEMENTS) throw new RangeError('SVG element limit exceeded');
      const name = node.nodeName;
      if (name === 'script' || name === 'foreignObject' || name === 'image') throw new TypeError('Script, foreignObject, and raster image elements are not supported');
      if (!ELEMENTS.has(name) || node.namespaceURI && node.namespaceURI !== SVG_NS) throw new TypeError('Unsupported SVG element or namespace: ' + name);
      if (name === 'metadata' && (node.parentNode !== root || node.getAttribute('id') !== 'vector-asset')) throw new TypeError('Only the direct JSON metadata#vector-asset element is supported');
      if (name === 'defs' && node.parentNode !== root) throw new TypeError('SVG defs must be a direct child of the root');
      if (name === 'linearGradient' && node.parentNode?.nodeName !== 'defs') throw new TypeError('linearGradient must be inside root defs');
      if (name === 'stop' && node.parentNode?.nodeName !== 'linearGradient') throw new TypeError('stop must be inside linearGradient');
      const allowedAttributes = name === 'linearGradient' ? GRADIENT_ATTRIBUTES : name === 'stop' ? STOP_ATTRIBUTES : ATTRIBUTES;
      for (let i = 0; i < node.attributes.length; i++) {
        const attribute = node.attributes.item(i), key = attribute.name, value = attribute.value;
        if (key === 'xmlns') {
          if (node !== root || value !== SVG_NS) throw new TypeError('Only the SVG namespace on the root is supported');
          continue;
        }
        const gradientPaint = key === 'fill' && /^url\(\s*#[A-Za-z_][A-Za-z0-9_.:-]{0,127}\s*\)$/.test(value);
        if (!allowedAttributes.has(key) || /^on/i.test(key)
            || (/url\s*\(/i.test(value) && !gradientPaint) || /(?:https?:|data:|file:|\/\/)/i.test(value)) {
          throw new TypeError('Unsupported SVG attribute or external reference: ' + key);
        }
        if (key === 'vector-effect') {
          if (!['none', 'non-scaling-stroke'].includes(value)) throw new TypeError('Unsupported SVG vector-effect: ' + value);
          if (name !== 'line') throw new TypeError('Non-scaling strokes currently support only <line> elements');
        }
        if (key === 'id') {
          if (!value || ids.has(value)) throw new TypeError('SVG ids must be nonempty and unique: ' + value);
          ids.set(value, node);
        }
        if (key === 'transform') validateTransform(value);
        if (['fill-opacity', 'stroke-opacity', 'opacity'].includes(key)) {
          if (!NUMBER.test(value) || Number(value) < 0 || Number(value) > 1) throw new RangeError(key + ' must be in [0,1]');
        }
        if (key === 'stroke-width' && (!NUMBER.test(value) || Number(value) <= 0)) throw new RangeError('stroke-width must be positive');
        if (key === 'stroke-miterlimit' && (!NUMBER.test(value) || Number(value) <= 0)) throw new RangeError('stroke-miterlimit must be positive');
        if (key === 'stroke-linecap' && !['butt', 'round', 'square'].includes(value)) throw new TypeError('Unsupported stroke-linecap: ' + value);
        if (key === 'stroke-linejoin' && !['miter', 'round', 'bevel'].includes(value)) throw new TypeError('Unsupported stroke-linejoin: ' + value);
        if (key === 'fill-rule' && value !== 'evenodd') throw new TypeError('Only evenodd compound fills are supported');
        if ((key === 'fill' || key === 'stroke') && !gradientPaint) {
          if (value !== 'none') {
            try { new Color().setStyle(value, SRGBColorSpace); }
            catch { throw new TypeError('Unsupported SVG paint color: ' + value); }
          }
        }
        if (name === 'linearGradient' && key === 'gradientUnits' && !['objectBoundingBox', 'userSpaceOnUse'].includes(value)) throw new TypeError('Unsupported SVG gradientUnits: ' + value);
        if (name === 'linearGradient' && key === 'spreadMethod' && value !== 'pad') throw new TypeError('Only linearGradient spreadMethod=pad is supported');
        if (name === 'linearGradient' && ['x1', 'y1', 'x2', 'y2'].includes(key)) gradientCoordinate(value, node.getAttribute('gradientUnits') || 'objectBoundingBox', key);
        if (name === 'stop' && key === 'offset') {
          const percent = /^([+-]?(?:\d+\.?\d*|\.\d+))%$/.exec(value);
          const offset = percent ? Number(percent[1]) / 100 : NUMBER.test(value) ? Number(value) : NaN;
          if (!Number.isFinite(offset) || offset < 0 || offset > 1) throw new RangeError('linearGradient offset must be in [0,1]');
        }
        if (name === 'stop' && key === 'stop-color') {
          try { new Color().setStyle(value, SRGBColorSpace); }
          catch { throw new TypeError('Unsupported linearGradient stop color: ' + value); }
        }
      }
    } else if (node.nodeType === 3 && node.parentNode?.nodeName !== 'metadata' && node.nodeValue.trim()) {
      throw new TypeError('SVG text outside the JSON metadata block is not supported');
    } else if (node.nodeType === 10 || node.nodeType === 7) {
      throw new TypeError('SVG doctypes and processing instructions are not supported');
    }
    for (let child = node.firstChild; child; child = child.nextSibling) visit(child);
  };
  visit(root);
  return ids;
}

function directMetadata(root) {
  const nodes = [];
  for (let child = root.firstChild; child; child = child.nextSibling) {
    if (child.nodeType === 1 && child.nodeName === 'metadata') nodes.push(child);
  }
  if (nodes.length !== 1 || nodes[0].getAttribute('id') !== 'vector-asset') throw new TypeError('Exactly one direct metadata#vector-asset JSON block is required');
  const metadata = nodes[0];
  for (let child = metadata.firstChild; child; child = child.nextSibling) {
    if (child.nodeType !== 3 && child.nodeType !== 8) throw new TypeError('SVG metadata may contain JSON text only');
  }
  let value;
  try { value = JSON.parse(metadata.textContent.trim()); }
  catch { throw new SyntaxError('SVG metadata must contain valid JSON'); }
  return { node: metadata, value, text: metadata.textContent.trim() };
}

function validateRoot(root) {
  const viewBox = finiteList(root.getAttribute('viewBox') || '', 4, 'viewBox');
  const width = root.getAttribute('width'), height = root.getAttribute('height');
  if (viewBox[0] !== 0 || viewBox[1] !== 0 || viewBox[2] <= 0 || viewBox[3] <= 0
      || !width || !height || !NUMBER.test(width) || !NUMBER.test(height)
      || Number(width) !== viewBox[2] || Number(height) !== viewBox[3]) {
    throw new TypeError('SVG viewBox must be 0 0 width height in unitless CSS pixels');
  }
  return viewBox;
}

function normalizeCenteredViewBoxInput(root, metadata) {
  const widthText = root.getAttribute('width'), heightText = root.getAttribute('height');
  const width = Number(widthText), height = Number(heightText);
  const viewBox = finiteList(root.getAttribute('viewBox') || '', 4, 'viewBox');
  if (!widthText || !heightText || !Number.isFinite(width) || !Number.isFinite(height)
      || viewBox[2] <= 0 || viewBox[3] <= 0) {
    throw new TypeError('Centered SVG normalization needs finite root width, height, and positive viewBox dimensions');
  }

  // This matches the build-time Bounko normalization without changing source
  // bytes or authored local coordinates. Three's SVGLoader compiles geometry
  // in those authored coordinates; the original viewport is returned below.
  root.setAttribute('width', String(viewBox[2]));
  root.setAttribute('height', String(viewBox[3]));
  root.setAttribute('viewBox', `0 0 ${viewBox[2]} ${viewBox[3]}`);

  for (const clip of Object.values(metadata?.clips ?? {})) {
    for (const frame of clip?.keyframes ?? []) {
      const poses = frame?.parts;
      if (!poses || typeof poses !== 'object' || Array.isArray(poses)) continue;
      for (const [part, pose] of Object.entries(poses)) {
        if (pose && typeof pose === 'object' && !Array.isArray(pose) && Object.keys(pose).length === 0) {
          delete poses[part];
        }
      }
    }
  }
  return viewBox;
}

function idList(ids) {
  return [...ids.keys()].sort();
}

function colorComponents(color, opacity) {
  const hex = color.getHex(SRGBColorSpace);
  return [((hex >>> 16) & 255) / 255, ((hex >>> 8) & 255) / 255, (hex & 255) / 255, opacity];
}

function appendTriangles(vertices, geometry, rgba, partIndex) {
  if (!geometry?.attributes?.position) return;
  const position = geometry.attributes.position;
  const index = geometry.index;
  const count = index ? index.count : position.count;
  for (let triangle = 0; triangle + 2 < count; triangle += 3) {
    for (let corner = 0; corner < 3; corner++) {
      const at = triangle + corner;
      const vertex = index ? index.getX(at) : at;
      vertices.push(position.getX(vertex), position.getY(vertex), ...rgba, 0, 0, 0, 0, partIndex);
    }
  }
}

function inverseTransformedPoint(matrix, point) {
  const e = matrix.elements, dx = point.x - e[6], dy = point.y - e[7], determinant = e[0] * e[4] - e[3] * e[1];
  if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-12) throw new TypeError('Gradient target transform must be invertible');
  return { x: (e[4] * dx - e[3] * dy) / determinant, y: (-e[1] * dx + e[0] * dy) / determinant };
}

function shapeBounds(shapes, inverseTransform = null) {
  const bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const shape of shapes) {
    const points = shape.extractPoints(24);
    for (const point of [...points.shape, ...points.holes.flat()]) {
      const local = inverseTransform ? inverseTransformedPoint(inverseTransform, point) : point;
      bounds.minX = Math.min(bounds.minX, local.x); bounds.maxX = Math.max(bounds.maxX, local.x);
      bounds.minY = Math.min(bounds.minY, local.y); bounds.maxY = Math.max(bounds.maxY, local.y);
    }
  }
  if (!Number.isFinite(bounds.minX) || bounds.maxX <= bounds.minX || bounds.maxY <= bounds.minY) throw new TypeError('Gradient paint needs a nonempty shape bounding box');
  return bounds;
}

function transformedPoint(matrix, point) {
  const e = matrix.elements;
  return { x: e[0] * point.x + e[3] * point.y + e[6], y: e[1] * point.x + e[4] * point.y + e[7] };
}

function gradientColorAtT(gradient, t) {
  if (t <= gradient.stops[0].offset) return gradient.stops[0].color;
  for (let index = 1; index < gradient.stops.length; index++) {
    const right = gradient.stops[index], left = gradient.stops[index - 1];
    if (t <= right.offset) {
      const amount = right.offset === left.offset ? 1 : (t - left.offset) / (right.offset - left.offset);
      return left.color.map((value, channel) => value + (right.color[channel] - value) * amount);
    }
  }
  return gradient.stops.at(-1).color;
}

function gradientEndpoints(gradient, bounds, transform) {
  const local = gradient.units === 'objectBoundingBox'
    ? (x, y) => ({ x: bounds.minX + x * (bounds.maxX - bounds.minX), y: bounds.minY + y * (bounds.maxY - bounds.minY) })
    : (x, y) => ({ x, y });
  return [transformedPoint(transform, local(gradient.x1, gradient.y1)), transformedPoint(transform, local(gradient.x2, gradient.y2))];
}

function gradientAtPoint(gradient, point, bounds, transform) {
  const [start, end] = gradientEndpoints(gradient, bounds, transform);
  const dx = end.x - start.x, dy = end.y - start.y;
  const t = ((point.x - start.x) * dx + (point.y - start.y) * dy) / (dx * dx + dy * dy);
  return gradientColorAtT(gradient, t);
}

function clipGradientPolygon(polygon, sampler, level, keepAbove) {
  const output = [];
  for (let index = 0; index < polygon.length; index++) {
    const a = polygon[index], b = polygon[(index + 1) % polygon.length];
    const da = sampler(a) - level, db = sampler(b) - level;
    const insideA = keepAbove ? da >= -1e-9 : da <= 1e-9;
    const insideB = keepAbove ? db >= -1e-9 : db <= 1e-9;
    if (insideA) output.push(a);
    if (insideA !== insideB) {
      const amount = da / (da - db);
      output.push({ x: a.x + (b.x - a.x) * amount, y: a.y + (b.y - a.y) * amount });
    }
  }
  return output;
}

function appendGradientShape(vertices, shape, gradient, bounds, transform, opacity, partIndex, curveSegments) {
  const geometry = new ShapeGeometry(shape, curveSegments), position = geometry.attributes.position, index = geometry.index;
  const count = index ? index.count : position.count;
  const gradientT = point => {
    const [start, end] = gradientEndpoints(gradient, bounds, transform);
    const dx = end.x - start.x, dy = end.y - start.y;
    return ((point.x - start.x) * dx + (point.y - start.y) * dy) / (dx * dx + dy * dy);
  };
  const colorAt = point => gradientAtPoint(gradient, point, bounds, transform).map((value, channel) => channel === 3 ? value * opacity : value);
  for (let triangle = 0; triangle + 2 < count; triangle += 3) {
    const points = [0, 1, 2].map(corner => {
      const at = triangle + corner, vertex = index ? index.getX(at) : at;
      return { x: position.getX(vertex), y: position.getY(vertex) };
    });
    const times = points.map(gradientT), low = Math.min(...times), high = Math.max(...times);
    const cuts = [...new Set(gradient.stops.map(stop => stop.offset).filter(offset => offset > low + 1e-9 && offset < high - 1e-9))].sort((a, b) => a - b);
    const boundaries = [low, ...cuts, high];
    for (let band = 0; band + 1 < boundaries.length; band++) {
      const lower = boundaries[band], upper = boundaries[band + 1];
      if (upper - lower < 1e-9) continue;
      let polygon = clipGradientPolygon(points, gradientT, lower, true);
      polygon = clipGradientPolygon(polygon, gradientT, upper, false);
      for (let corner = 1; corner + 1 < polygon.length; corner++) {
        for (const point of [polygon[0], polygon[corner], polygon[corner + 1]]) {
          vertices.push(point.x, point.y, ...colorAt(point), 0, 0, 0, 0, partIndex);
        }
      }
    }
  }
  geometry.dispose();
}

const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
function seeded(seed, index, salt = 0) {
  let value = Math.imul((seed ^ salt) + index * 0x9e3779b9, 0x85ebca6b);
  value = Math.imul(value ^ (value >>> 13), 0xc2b2ae35);
  return ((value ^ (value >>> 16)) >>> 0) / 0x100000000;
}
const yarnHash = value => { const result = Math.sin(value * 127.1 + 311.7) * 43758.5453; return result - Math.floor(result); };
const yarnRandom = (seed, index, salt) => yarnHash(seed * 57.13 + index * 113.71 + salt * 3.1);

function inRing(point, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if ((a.y > point.y) !== (b.y > point.y)
        && point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

function shapeInfo(shape, includeClipMesh = false) {
  const extracted = shape.extractPoints(24), contour = extracted.shape;
  if (contour.length < 3) throw new TypeError('Styled SVG fills need a closed contour');
  const bounds = shapeBounds([shape]);
  const info = {
    contour, holes: extracted.holes, ...bounds,
    width: bounds.maxX - bounds.minX, height: bounds.maxY - bounds.minY,
    center: { x: (bounds.minX + bounds.maxX) / 2, y: (bounds.minY + bounds.maxY) / 2 },
    contains(point) { return inRing(point, contour) && !extracted.holes.some(hole => inRing(point, hole)); },
  };
  if (includeClipMesh) {
    const geometry = new ShapeGeometry(shape, 24), position = geometry.attributes.position, index = geometry.index;
    const count = index ? index.count : position.count, cellSize = Math.max(4, Math.min(info.width, info.height) / 16);
    const triangles = [], cells = new Map();
    const cellKey = (x, y) => `${x},${y}`;
    for (let at = 0; at + 2 < count; at += 3) {
      const points = [0, 1, 2].map(corner => {
        const vertex = index ? index.getX(at + corner) : at + corner;
        return { x: position.getX(vertex), y: position.getY(vertex) };
      });
      const bounds = {
        minX: Math.min(...points.map(point => point.x)), maxX: Math.max(...points.map(point => point.x)),
        minY: Math.min(...points.map(point => point.y)), maxY: Math.max(...points.map(point => point.y)),
      };
      const triangle = { points, bounds }, id = triangles.push(triangle) - 1;
      const x0 = Math.floor((bounds.minX - info.minX) / cellSize), x1 = Math.floor((bounds.maxX - info.minX) / cellSize);
      const y0 = Math.floor((bounds.minY - info.minY) / cellSize), y1 = Math.floor((bounds.maxY - info.minY) / cellSize);
      for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
        const key = cellKey(x, y), list = cells.get(key) ?? [];
        list.push(id); cells.set(key, list);
      }
    }
    geometry.dispose();
    info.clipMesh = { triangles, cells, cellSize, cellKey };
  }
  return info;
}

function cross(a, b, c) { return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x); }
function triangleContains(triangle, point) {
  const [a, b, c] = triangle;
  const ab = cross(a, b, point), bc = cross(b, c, point), ca = cross(c, a, point);
  return (ab >= -1e-8 && bc >= -1e-8 && ca >= -1e-8) || (ab <= 1e-8 && bc <= 1e-8 && ca <= 1e-8);
}

function segmentIntersection(a, b, c, d) {
  const rx = b.x - a.x, ry = b.y - a.y, sx = d.x - c.x, sy = d.y - c.y;
  const denominator = rx * sy - ry * sx;
  if (Math.abs(denominator) < 1e-9) return false;
  const qx = c.x - a.x, qy = c.y - a.y;
  const t = (qx * sy - qy * sx) / denominator, u = (qx * ry - qy * rx) / denominator;
  return t > 1e-8 && t < 1 - 1e-8 && u >= -1e-8 && u <= 1 + 1e-8;
}

function triangleIsContained(points, info) {
  const centroid = { x: (points[0].x + points[1].x + points[2].x) / 3, y: (points[0].y + points[1].y + points[2].y) / 3 };
  if (!points.every(point => info.contains(point)) || !info.contains(centroid)) return false;
  const rings = [info.contour, ...info.holes];
  for (const ring of rings) {
    for (let index = 0; index < ring.length; index++) {
      const a = ring[index], b = ring[(index + 1) % ring.length];
      if (triangleContains(points, a)) return false;
      for (let edge = 0; edge < 3; edge++) if (segmentIntersection(points[edge], points[(edge + 1) % 3], a, b)) return false;
    }
  }
  return true;
}

function clipTriangleToTriangle(subject, clip) {
  let polygon = [...subject];
  const orientation = cross(clip[0], clip[1], clip[2]) >= 0 ? 1 : -1;
  for (let edge = 0; edge < 3 && polygon.length; edge++) {
    const a = clip[edge], b = clip[(edge + 1) % 3], input = polygon;
    polygon = [];
    for (let index = 0; index < input.length; index++) {
      const start = input[index], end = input[(index + 1) % input.length];
      const startSide = orientation * cross(a, b, start), endSide = orientation * cross(a, b, end);
      const startInside = startSide >= -1e-8, endInside = endSide >= -1e-8;
      if (startInside) polygon.push(start);
      if (startInside !== endInside) {
        const amount = startSide / (startSide - endSide);
        polygon.push({ x: start.x + (end.x - start.x) * amount, y: start.y + (end.y - start.y) * amount });
      }
    }
  }
  return polygon;
}

function emitClippedTriangle(vertices, points, rgba, partIndex, info, colorAt = null) {
  const emit = point => emitStyleVertex(vertices, point, colorAt ? colorAt(point) : rgba, partIndex);
  const twiceArea = Math.abs(cross(points[0], points[1], points[2]));
  if (twiceArea < 1e-8) return;
  if (triangleIsContained(points, info)) {
    for (const point of points) emit(point);
    return;
  }
  const { triangles, cells, cellSize, cellKey } = info.clipMesh;
  const bounds = {
    minX: Math.min(...points.map(point => point.x)), maxX: Math.max(...points.map(point => point.x)),
    minY: Math.min(...points.map(point => point.y)), maxY: Math.max(...points.map(point => point.y)),
  };
  const candidates = new Set();
  const x0 = Math.floor((bounds.minX - info.minX) / cellSize), x1 = Math.floor((bounds.maxX - info.minX) / cellSize);
  const y0 = Math.floor((bounds.minY - info.minY) / cellSize), y1 = Math.floor((bounds.maxY - info.minY) / cellSize);
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
    for (const id of cells.get(cellKey(x, y)) ?? []) candidates.add(id);
  }
  for (const id of candidates) {
    const clip = triangles[id];
    if (clip.bounds.maxX < bounds.minX || clip.bounds.minX > bounds.maxX || clip.bounds.maxY < bounds.minY || clip.bounds.minY > bounds.maxY) continue;
    const polygon = clipTriangleToTriangle(points, clip.points);
    for (let corner = 1; corner + 1 < polygon.length; corner++) {
      if (Math.abs(cross(polygon[0], polygon[corner], polygon[corner + 1])) < 1e-8) continue;
      emit(polygon[0]);
      emit(polygon[corner]);
      emit(polygon[corner + 1]);
    }
  }
}

function appendClippedStrokeGeometry(vertices, geometry, rgba, partIndex, info) {
  const position = geometry.attributes.position, index = geometry.index;
  const count = index ? index.count : position.count;
  for (let at = 0; at + 2 < count; at += 3) {
    const points = [0, 1, 2].map(corner => {
      const vertex = index ? index.getX(at + corner) : at + corner;
      return { x: position.getX(vertex), y: position.getY(vertex) };
    });
    emitClippedTriangle(vertices, points, rgba, partIndex, info);
  }
}

function appendYarnTriangle(vertices, points, rgba, partIndex, info, colorAt) {
  const emit = triangle => {
    if (info) emitClippedTriangle(vertices, triangle, rgba, partIndex, info, colorAt);
    else for (const point of triangle) emitStyleVertex(vertices, point, colorAt ? colorAt(point) : rgba, partIndex);
  };
  const gradientT = colorAt?.gradientT, stops = colorAt?.gradientStops;
  if (!gradientT || !stops?.length) { emit(points); return; }
  const values = points.map(gradientT), low = Math.min(...values), high = Math.max(...values);
  const cuts = [...new Set(stops.filter(offset => offset > low + 1e-9 && offset < high - 1e-9))].sort((a, b) => a - b);
  if (!cuts.length) { emit(points); return; }
  const boundaries = [low, ...cuts, high];
  for (let band = 0; band + 1 < boundaries.length; band++) {
    const lower = boundaries[band], upper = boundaries[band + 1];
    if (upper - lower < 1e-9) continue;
    let polygon = clipGradientPolygon(points, gradientT, lower, true);
    polygon = clipGradientPolygon(polygon, gradientT, upper, false);
    for (let corner = 1; corner + 1 < polygon.length; corner++) {
      if (Math.abs(cross(polygon[0], polygon[corner], polygon[corner + 1])) < 1e-8) continue;
      emit([polygon[0], polygon[corner], polygon[corner + 1]]);
    }
  }
}

function appendYarnStroke(vertices, points, width, rgba, partIndex, info = null, colorAt = null) {
  if (points.length < 2 || width <= 0) return;
  const triangle = (a, b, c) => {
    appendYarnTriangle(vertices, [a, b, c], rgba, partIndex, info, colorAt);
  };
  const radius = width / 2, segments = points.length - 1, normals = [];
  for (let index = 0; index < segments; index++) {
    const start = points[index], end = points[index + 1], dx = end.x - start.x, dy = end.y - start.y, length = Math.hypot(dx, dy);
    if (length < 1e-6) { normals.push(null); continue; }
    const nx = -dy / length * radius, ny = dx / length * radius;
    normals.push({ x: nx, y: ny });
    const a = { x: start.x + nx, y: start.y + ny }, b = { x: start.x - nx, y: start.y - ny };
    const c = { x: end.x - nx, y: end.y - ny }, d = { x: end.x + nx, y: end.y + ny };
    triangle(a, b, c); triangle(a, c, d);
  }
  for (let index = 1; index < points.length - 1; index++) {
    const before = normals[index - 1], after = normals[index];
    if (!before || !after) continue;
    const point = points[index];
    triangle(point, { x: point.x + before.x, y: point.y + before.y }, { x: point.x + after.x, y: point.y + after.y });
    triangle(point, { x: point.x - before.x, y: point.y - before.y }, { x: point.x - after.x, y: point.y - after.y });
  }
  const cap = center => {
    const slices = 8;
    for (let index = 0; index < slices; index++) {
      const a = index / slices * Math.PI * 2, b = (index + 1) / slices * Math.PI * 2;
      triangle(center, { x: center.x + Math.cos(a) * radius, y: center.y + Math.sin(a) * radius },
        { x: center.x + Math.cos(b) * radius, y: center.y + Math.sin(b) * radius });
    }
  };
  cap(points[0]); cap(points.at(-1));
}

function quadPoints(start, end, width) {
  const dx = end.x - start.x, dy = end.y - start.y, length = Math.hypot(dx, dy) || 1;
  const nx = -dy / length * width / 2, ny = dx / length * width / 2;
  return [
    { x: start.x + nx, y: start.y + ny }, { x: start.x - nx, y: start.y - ny },
    { x: end.x - nx, y: end.y - ny }, { x: start.x + nx, y: start.y + ny },
    { x: end.x - nx, y: end.y - ny }, { x: end.x + nx, y: end.y + ny },
  ];
}

function emitStyleVertex(vertices, point, rgba, partIndex, delta0 = [0, 0], delta1 = [0, 0]) {
  vertices.push(point.x, point.y, ...rgba, ...delta0, ...delta1, partIndex);
}

function appendStyleSegment(vertices, start, end, width, rgba, partIndex, morphTargets = null) {
  if (Math.hypot(end.x - start.x, end.y - start.y) < 1e-5) return;
  const base = quadPoints(start, end, width);
  if (!morphTargets) {
    for (const point of base) emitStyleVertex(vertices, point, rgba, partIndex);
    return;
  }
  const targetQuads = morphTargets.map(target => quadPoints(target[0], target[1], width));
  for (let index = 0; index < base.length; index++) {
    const point = base[index], first = targetQuads[0][index], second = targetQuads[1][index];
    emitStyleVertex(vertices, point, rgba, partIndex, [first.x - point.x, first.y - point.y], [second.x - point.x, second.y - point.y]);
  }
}

function appendClippedPolyline(vertices, points, closed, width, rgba, partIndex, info) {
  const segmentCount = closed ? points.length : points.length - 1;
  for (let index = 0; index < segmentCount; index++) {
    const start = points[index], end = points[(index + 1) % points.length];
    const length = Math.hypot(end.x - start.x, end.y - start.y);
    const pieces = Math.max(1, Math.min(8, Math.ceil(length / Math.max(width * 4, 2))));
    for (let piece = 0; piece < pieces; piece++) {
      const t0 = piece / pieces, t1 = (piece + 1) / pieces, middle = (t0 + t1) / 2;
      const sample = { x: start.x + (end.x - start.x) * middle, y: start.y + (end.y - start.y) * middle };
      if (!info.contains(sample)) continue;
      appendStyleSegment(vertices,
        { x: start.x + (end.x - start.x) * t0, y: start.y + (end.y - start.y) * t0 },
        { x: start.x + (end.x - start.x) * t1, y: start.y + (end.y - start.y) * t1 }, width, rgba, partIndex);
    }
  }
}

function colorScale(color, factor, alpha) {
  return colorComponents(color.clone().multiplyScalar(factor), alpha);
}

function curveMetric(points, closed = true) {
  const lengths = [0], segmentCount = closed ? points.length : points.length - 1;
  let area = 0;
  for (let index = 0; index < segmentCount; index++) {
    const a = points[index], b = points[(index + 1) % points.length];
    lengths.push(lengths[index] + Math.hypot(b.x - a.x, b.y - a.y));
    area += a.x * b.y - b.x * a.y;
  }
  const length = lengths[segmentCount] || 1e-5, sign = closed && area < 0 ? -1 : 1;
  return { length, at(amount) {
    const distance = (closed ? ((amount % 1) + 1) % 1 : clamp(amount, 0, 1)) * length;
    let low = 0, high = segmentCount - 1;
    while (low < high) { const middle = (low + high) >> 1; if (lengths[middle + 1] < distance) low = middle + 1; else high = middle; }
    const a = points[low], b = points[(low + 1) % points.length], segmentLength = lengths[low + 1] - lengths[low] || 1;
    const t = clamp((distance - lengths[low]) / segmentLength, 0, 1), tx = (b.x - a.x) / segmentLength, ty = (b.y - a.y) / segmentLength;
    return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, tx, ty, nx: sign * ty, ny: -sign * tx };
  } };
}

function quadraticPoints(start, control, end, divisions = 8) {
  return Array.from({ length: divisions + 1 }, (_, index) => {
    const t = index / divisions, inverse = 1 - t;
    return { x: inverse * inverse * start.x + 2 * inverse * t * control.x + t * t * end.x,
      y: inverse * inverse * start.y + 2 * inverse * t * control.y + t * t * end.y };
  });
}

function cubicPoints(start, first, second, end, divisions = 8) {
  return Array.from({ length: divisions + 1 }, (_, index) => {
    const t = index / divisions, inverse = 1 - t;
    return { x: inverse ** 3 * start.x + 3 * inverse ** 2 * t * first.x + 3 * inverse * t ** 2 * second.x + t ** 3 * end.x,
      y: inverse ** 3 * start.y + 3 * inverse ** 2 * t * first.y + 3 * inverse * t ** 2 * second.y + t ** 3 * end.y };
  });
}

function roundedOutline(points, holes) {
  const shape = new Shape(), middle = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  const first = middle(points.at(-1), points[0]);
  shape.moveTo(first.x, first.y);
  for (let index = 0; index < points.length; index++) {
    const point = points[index], next = points[(index + 1) % points.length], end = middle(point, next);
    shape.quadraticCurveTo(point.x, point.y, end.x, end.y);
  }
  shape.closePath();
  for (const ring of holes) {
    const hole = new Path();
    hole.moveTo(ring[0].x, ring[0].y);
    for (const point of ring.slice(1)) hole.lineTo(point.x, point.y);
    hole.closePath(); shape.holes.push(hole);
  }
  return shape;
}

function yarnTint(color, amount, opacity) {
  const target = amount > 0 ? 1 : 0, weight = Math.abs(amount);
  return [color[0] + (target - color[0]) * weight, color[1] + (target - color[1]) * weight,
    color[2] + (target - color[2]) * weight, color[3] * opacity];
}

function compileYarnStyle(vertices, style, shape, fillColor, opacity, partIndex, gradient, gradientBounds, transform, curveSegments) {
  const info = shapeInfo(shape, true), sourceMetric = curveMetric(info.contour);
  const lobes = Math.max(8, Math.round(sourceMetric.length / style.edgeSpacing));
  const amount = style.detail ? 0.3 : 1;
  const relief = Math.min(style.edgeRelief, Math.min(info.width, info.height) * 0.115) * amount;
  const scallops = [];
  for (let index = 0; index < lobes * 5; index++) {
    const u = index / (lobes * 5), point = sourceMetric.at(u);
    const displacement = relief * (Math.sin(Math.PI * u * lobes) ** 2 * 0.85 + 0.18 * Math.sin(u * Math.PI * 4 + style.seed) + 0.1)
      * (0.8 + 0.2 * Math.sin(u * Math.PI * 6 + style.seed * 0.7));
    scallops.push({ x: point.x + point.nx * displacement, y: point.y + point.ny * displacement });
  }
  const outline = roundedOutline(scallops, info.holes);
  const baseColor = gradient ? gradientColorAtT(gradient, 0.53) : colorComponents(fillColor, 1);
  const dark = yarnTint(baseColor, -0.28, opacity), groove = yarnTint(baseColor, -(style.contrast), opacity * 0.85);
  const yarn = yarnTint(baseColor, 0.1, opacity), light = yarnTint(baseColor, 0.38, opacity);
  const gradientT = gradient ? (() => {
    const [start, end] = gradientEndpoints(gradient, gradientBounds, transform);
    const dx = end.x - start.x, dy = end.y - start.y, denominator = dx * dx + dy * dy;
    return point => ((point.x - start.x) * dx + (point.y - start.y) * dy) / denominator;
  })() : null;
  const yarnColor = (tint, alpha = 1) => {
    if (!gradient) return null;
    const sampler = point => yarnTint(gradientColorAtT(gradient, gradientT(point)), tint, opacity * alpha);
    sampler.gradientT = gradientT;
    sampler.gradientStops = gradient.stops.map(stop => stop.offset);
    return sampler;
  };
  const edgeDarkColor = yarnColor(-0.28, 0.7), edgeMainColor = yarnColor(0.1), edgeLightColor = yarnColor(0.38, 0.55);
  const underColor = yarnColor(-0.28, 0.5), grooveColor = yarnColor(-style.contrast, 0.85);
  const stitchColor = yarnColor(0.1), stitchLightColor = yarnColor(0.38, 0.57), crossLightColor = yarnColor(0.38, 0.5);
  const fiberColor = yarnColor(0.22, style.fiberOpacity), fiberLightColor = yarnColor(0.38, style.fiberOpacity * 0.7);
  if (gradient) appendGradientShape(vertices, outline, gradient, gradientBounds, transform, opacity, partIndex, curveSegments);
  else {
    const fill = new ShapeGeometry(outline, curveSegments);
    appendTriangles(vertices, fill, yarnTint(baseColor, 0, opacity), partIndex); fill.dispose();
  }

  const edge = curveMetric(scallops), edgeWidth = style.edgeWidth;
  for (let index = 0; index < lobes; index++) {
    const a0 = edge.at((index + 0.12) / lobes), b0 = edge.at((index + 0.85) / lobes), middle = edge.at((index + 0.5) / lobes);
    const depth = edgeWidth * 0.62 * amount;
    const start = { x: a0.x - a0.nx * depth, y: a0.y - a0.ny * depth };
    const control = { x: middle.x + middle.nx * depth * 0.38, y: middle.y + middle.ny * depth * 0.38 };
    const end = { x: b0.x - b0.nx * depth, y: b0.y - b0.ny * depth };
    const loop = quadraticPoints(start, control, end, 6);
    appendYarnStroke(vertices, loop, edgeWidth * 0.8, yarnTint(dark, 0, 0.7), partIndex, null, edgeDarkColor);
    appendYarnStroke(vertices, loop, edgeWidth * 0.56, yarn, partIndex, null, edgeMainColor);
    appendYarnStroke(vertices, loop.map(point => ({ x: point.x - edgeWidth * 0.1, y: point.y - edgeWidth * 0.09 })), edgeWidth * 0.17,
      yarnTint(light, 0, 0.55), partIndex, null, edgeLightColor);
  }

  if (style.pattern !== false) {
    const curved = style.curved !== false, stitchWidth = style.stitchWidth, stitchHeight = style.stitchHeight;
    const columns = Math.min(128, Math.max(2, Math.ceil(info.width / stitchWidth)));
    const rows = Math.min(128, Math.max(2, Math.ceil(info.height / stitchHeight)));
    if (rows * columns > 16384) throw new RangeError('Yarn style tessellation exceeds the 16,384 stitch limit');
    const sx = info.width / columns, sy = info.height / rows, rx = info.width / 2, ry = info.height / 2;
    const strokeWidth = Math.min(sx, sy) * (style.thickness / stitchHeight);
    const mapPoint = (x, y, ox = 0, oy = 0) => {
      x += ox; y += oy;
      const nx = x / rx, ny = y / ry;
      return { x: info.center.x + (curved ? Math.sin(clamp(nx, -1.35, 1.35) * 1.1) / Math.sin(1.1) * rx : x),
        y: info.center.y + y + (curved ? ry * 0.13 * nx * nx * (1 - ny * 0.24) : 0) };
    };
    const drawCellCurve = (x, y, ax, ay, data, rgba, width, offsetX = 0, offsetY = 0, colorAt = null) => {
      const points = cubicPoints(
        { x: x + ax * data[0], y: y + ay * data[1] },
        { x: x + ax * data[2], y: y + ay * data[3] },
        { x: x + ax * data[4], y: y + ay * data[5] },
        { x: x + ax * data[6], y: y + ay * data[7] }, 5,
      ).map(point => mapPoint(point.x, point.y, offsetX, offsetY));
      appendYarnStroke(vertices, points, width, rgba, partIndex, info, colorAt);
    };
    let stitchCount = 0;
    for (let row = -1; row <= rows + 1; row++) for (let column = -1; column <= columns + 1; column++) {
      const jitter = style.irregularity, x = -rx + (column + 0.5) * sx + (yarnRandom(style.seed, row * columns + column, 71) - 0.5) * sx * jitter;
      const y = -ry + (row + 0.5) * sy + (yarnRandom(style.seed, row * columns + column, 39) - 0.5) * sy * jitter;
      const ax = sx * (1 + (yarnRandom(style.seed, row * columns + column, 57) - 0.5) * jitter);
      const ay = sy * (1 + (yarnRandom(style.seed, row * columns + column, 91) - 0.5) * jitter);
      const under = [-0.48, -0.46, -0.22, -0.57, 0.22, -0.57, 0.48, -0.46];
      const leftLoop = [-0.34, -0.36, -0.32, -0.06, -0.18, 0.17, -0.025, 0.34];
      const rightLoop = [0.34, -0.36, 0.32, -0.06, 0.18, 0.17, 0.025, 0.34];
      drawCellCurve(x, y, ax, ay, under, yarnTint(dark, 0, 0.5), strokeWidth * 0.5, 0, strokeWidth * 0.06, underColor);
      for (const loop of [leftLoop, rightLoop]) drawCellCurve(x, y, ax, ay, loop, groove, strokeWidth * 1.08, 0, strokeWidth * 0.06,
        grooveColor);
      for (const loop of [leftLoop, rightLoop]) drawCellCurve(x, y, ax, ay, loop, yarn, strokeWidth * 0.89, 0, 0,
        stitchColor);
      for (const loop of [leftLoop, rightLoop]) drawCellCurve(x, y, ax, ay, loop, yarnTint(light, 0, 0.57), strokeWidth * 0.34,
        -strokeWidth * 0.14, -strokeWidth * 0.13, stitchLightColor);
      if ((row + column) % 2 === 0) {
        drawCellCurve(x, y, ax, ay, [-0.32, -0.12, -0.27, -0.13, -0.20, -0.15, -0.16, -0.13], yarnTint(light, 0, 0.5), strokeWidth * 0.075,
          0, 0, crossLightColor);
        drawCellCurve(x, y, ax, ay, [0.22, 0.18, 0.28, 0.14, 0.33, 0.11, 0.37, 0.08], yarnTint(light, 0, 0.5), strokeWidth * 0.075,
          0, 0, crossLightColor);
      }
      if (++stitchCount > 16384) throw new RangeError('Yarn style tessellation exceeds the 16,384 stitch limit');
    }
  }

  if (style.fiber !== false) {
    const fiberCount = Math.min(style.fiberMax, Math.round(edge.length / (style.fiberSpacing ?? 4)));
    for (let index = 0; index < fiberCount; index++) {
      const at = edge.at((index + 0.22 + yarnRandom(style.seed, index, 22) * 0.48) / fiberCount);
      const length = Math.min(style.fiberLength, Math.min(info.width, info.height) / 2 * 0.24) * (0.45 + yarnRandom(style.seed, index, 5) * 0.95);
      const lean = (yarnRandom(style.seed, index, 14) - 0.5) * length * 1.5;
      const start = { x: at.x - at.nx * 0.008, y: at.y - at.ny * 0.008 };
      const control = { x: at.x + at.nx * length * 0.64 + at.tx * lean, y: at.y + at.ny * length * 0.64 + at.ty * lean };
      const end = { x: at.x + at.nx * length + at.tx * lean * 0.48, y: at.y + at.ny * length + at.ty * lean * 0.48 };
      appendYarnStroke(vertices, quadraticPoints(start, control, end, 3), style.fiberWidth, yarnTint(baseColor, 0.22, opacity * style.fiberOpacity), partIndex, null,
        fiberColor);
      const tipStart = { x: at.x + at.nx * length * 0.48 + at.tx * lean * 0.25, y: at.y + at.ny * length * 0.48 + at.ty * lean * 0.25 };
      appendYarnStroke(vertices, [tipStart, end], style.fiberWidth * 0.4, yarnTint(light, 0, opacity * style.fiberOpacity * 0.7), partIndex, null,
        fiberLightColor);
    }
  }
}

function resampleClosed(points, count) {
  const samples = [];
  let total = 0, lengths = [];
  for (let i = 0; i < points.length; i++) { const length = Math.hypot(points[(i + 1) % points.length].x - points[i].x, points[(i + 1) % points.length].y - points[i].y); lengths.push(length); total += length; }
  for (let sample = 0; sample < count; sample++) {
    let distance = total * sample / count, index = 0;
    while (index < lengths.length - 1 && distance > lengths[index]) distance -= lengths[index++];
    const a = points[index], b = points[(index + 1) % points.length], amount = lengths[index] ? distance / lengths[index] : 0;
    samples.push({ x: a.x + (b.x - a.x) * amount, y: a.y + (b.y - a.y) * amount });
  }
  return samples;
}

function sketchContour(info, style, phase) {
  const source = resampleClosed(info.contour, 96);
  return source.map((point, index) => {
    const amount = (seeded(style.seed, index, 0x70 + phase * 0x100) - 0.5) * 2 * style.amplitude;
    const dx = point.x - info.center.x, dy = point.y - info.center.y, length = Math.hypot(dx, dy) || 1;
    const wave = Math.sin((index / source.length) * Math.PI * 2 * style.frequency + phase * 2.0943951);
    const offset = amount * (0.55 + wave * 0.45);
    return { x: point.x + dx / length * offset, y: point.y + dy / length * offset };
  });
}

function compileSketchStyle(vertices, style, shape, fillColor, opacity, partIndex) {
  const info = shapeInfo(shape), base = sketchContour(info, style, 0), first = sketchContour(info, style, 1), second = sketchContour(info, style, 2);
  const echo = colorScale(fillColor, 0.48, opacity * style.echoOpacity), ink = colorScale(fillColor, 0.36, opacity * 0.94);
  const echoPoints = base.map(point => ({ x: point.x + style.echoX, y: point.y + style.echoY }));
  appendClippedPolyline(vertices, echoPoints, true, style.echoWidth, echo, partIndex, info);
  for (let index = 0; index < base.length; index++) {
    const next = (index + 1) % base.length;
    appendStyleSegment(vertices, base[index], base[next], style.hatchWidth, ink, partIndex, [[first[index], first[next]], [second[index], second[next]]]);
  }
  const span = Math.hypot(info.maxX - info.minX, info.maxY - info.minY), direction = style.hatchAngle;
  const steps = Math.min(256, Math.ceil(span / style.hatchSpacing));
  for (let index = -steps; index <= steps; index++) {
    const offset = index * style.hatchSpacing;
    const start = { x: info.center.x - Math.cos(direction) * span + -Math.sin(direction) * offset, y: info.center.y - Math.sin(direction) * span + Math.cos(direction) * offset };
    const end = { x: info.center.x + Math.cos(direction) * span + -Math.sin(direction) * offset, y: info.center.y + Math.sin(direction) * span + Math.cos(direction) * offset };
    appendClippedPolyline(vertices, [start, end], false, style.hatchWidth, colorScale(fillColor, 0.48, opacity * style.hatchOpacity), partIndex, info);
  }
}

function compileShaderSurface(style, shape, fillColor, opacity, partIndex, gradient, gradientBounds, transform, curveSegments) {
  const extracted = shape.extractPoints(curveSegments);
  if (extracted.shape.length < 3 || extracted.holes.length) {
    throw new TypeError('Shader-backed SVG yarn/sketch surfaces currently require one closed contour without holes: ' + style.target);
  }
  const geometry = new ShapeGeometry(shape, curveSegments), position = geometry.attributes.position, index = geometry.index;
  const count = index ? index.count : position.count, fill = new Float32Array(count * 6);
  const colorAt = point => {
    const rgba = gradient ? gradientAtPoint(gradient, point, gradientBounds, transform) : colorComponents(fillColor, 1);
    rgba[3] *= opacity;
    return rgba;
  };
  let write = 0;
  for (let at = 0; at + 2 < count; at += 3) for (let corner = 0; corner < 3; corner++) {
    const vertex = index ? index.getX(at + corner) : at + corner;
    const point = { x: position.getX(vertex), y: position.getY(vertex) };
    fill[write++] = point.x; fill[write++] = point.y; fill.set(colorAt(point), write); write += 4;
  }
  geometry.dispose();
  const outline = new Float32Array(extracted.shape.length * 2), edgeColors = new Float32Array(extracted.shape.length * 4);
  for (let point = 0; point < extracted.shape.length; point++) {
    const current = extracted.shape[point]; outline[point * 2] = current.x; outline[point * 2 + 1] = current.y;
    edgeColors.set(colorAt(current), point * 4);
  }
  return { target: style.target, partIndex, fillVertices: fill, outline, edgeColors, style: { ...style } };
}

function appendOrderedMeshRange(drawOrder, firstIndex, indexCount, partIndex) {
  if (!indexCount) return;
  const previous = drawOrder.at(-1);
  if (previous?.kind === 'mesh' && previous.partIndex === partIndex && previous.firstIndex + previous.indexCount === firstIndex) previous.indexCount += indexCount;
  else drawOrder.push({ kind: 'mesh', firstIndex, indexCount, partIndex });
}

function ownerPart(node, partIndices) {
  for (let current = node; current; current = current.parentNode) {
    if (current.nodeType !== 1) continue;
    const id = current.getAttribute('id');
    if (id && partIndices.has(id)) return partIndices.get(id);
  }
  throw new TypeError('Every painted SVG element must be inside an authored part group');
}

function resolveGradientPaint(paint, gradients) {
  const match = /^url\(\s*#([A-Za-z_][A-Za-z0-9_.:-]{0,127})\s*\)$/.exec(paint ?? '');
  if (!match) return null;
  const gradient = gradients.get(match[1]);
  if (!gradient) throw new TypeError('SVG fill references an unknown linearGradient: ' + match[1]);
  return gradient;
}

function colorFromComponents(rgba) {
  return new Color().setRGB(rgba[0], rgba[1], rgba[2], SRGBColorSpace);
}

function appendNonScalingLine(vertices, start, end, rgba, partIndex, width, lineCap, arcDivisions) {
  if (!['butt', 'square', 'round'].includes(lineCap)) throw new TypeError('Unsupported non-scaling stroke linecap: ' + lineCap);
  const dx=end.x-start.x, dy=end.y-start.y;
  const length=Math.hypot(dx,dy);
  if (length<1e-9) throw new TypeError('Zero-length non-scaling <line> elements are not supported');
  const tangentX=dx/length,tangentY=dy/length,half=width*0.5;
  const push = (along, radialAlong, radialSide) => {
    const point = along===0 ? start : end;
    vertices.push(point.x,point.y,...rgba,tangentX,tangentY,radialAlong*half,radialSide*half,partIndex);
  };
  const triangle = (a,b,c) => { for (const v of [a,b,c]) push(...v); };
  const startExtension=lineCap==='square'?-1:0, endExtension=lineCap==='square'?1:0;
  triangle([0,startExtension,1],[1,endExtension,1],[1,endExtension,-1]);
  triangle([0,startExtension,1],[1,endExtension,-1],[0,startExtension,-1]);
  if (lineCap==='round') {
    for (const [along,firstAngle] of [[0,Math.PI/2],[1,-Math.PI/2]]) {
      for (let i=0;i<arcDivisions;i++) {
        const a=firstAngle+i*Math.PI/arcDivisions, b=firstAngle+(i+1)*Math.PI/arcDivisions;
        triangle([along,0,0],[along,Math.cos(a),Math.sin(a)],[along,Math.cos(b),Math.sin(b)]);
      }
    }
  }
}

function compilePaths(paths, partIndices, parts, metadata, gradients, curveSegments, strokeArcDivisions) {
  const vertices = [], shaderSurfaces = [], drawOrder = [];
  let hasNonScalingStroke=false;
  const styled = new Map((metadata.styles ?? []).map(style => [style.target, style]));
  const shaderOrdered = metadata.styles?.some(style => style.backend === 'shader') ?? false;
  const morphCount = metadata.styles?.some(style => style.kind === 'sketch' && style.backend !== 'shader') ? 2 : 0;
  for (const path of paths) {
    const sourceNode = path.userData?.node;
    if (!sourceNode?.getAttribute?.('id')) throw new TypeError('Every painted SVG shape must keep its DOM id');
    const partIndex = ownerPart(sourceNode, partIndices);
    const style = path.userData.style;
    const overallOpacity = style.opacity ?? 1;
    const authoredStyle = styled.get(sourceNode.getAttribute('id'));
    if (authoredStyle && (style.fill === undefined || style.fill === 'none')) throw new TypeError('Authored yarn/sketch styles require an SVG fill: ' + authoredStyle.target);
    const fillGradient = style.fill !== undefined && style.fill !== 'none' ? resolveGradientPaint(style.fill, gradients) : null;
    const fillOpacity = (style.fillOpacity ?? 1) * overallOpacity;
    const shapes = style.fill !== undefined && style.fill !== 'none' ? path.toShapes() : [];
    const gradientBounds = fillGradient && shapes.length
      ? shapeBounds(shapes, fillGradient.units === 'objectBoundingBox' ? path.userData.transform : null) : null;
    const styleColor = fillGradient ? colorFromComponents(gradientColorAtT(fillGradient, 0.53)) : path.color;
    const meshFirst = vertices.length / 11;

    if (authoredStyle?.backend === 'shader') {
      if (shapes.length !== 1) throw new TypeError('Shader-backed yarn/sketch style requires one connected filled shape: ' + authoredStyle.target);
      if (fillOpacity > 0) {
        const surfaceIndex = shaderSurfaces.push(compileShaderSurface(authoredStyle, shapes[0], path.color, fillOpacity, partIndex,
          fillGradient, gradientBounds, path.userData.transform, curveSegments)) - 1;
        drawOrder.push({ kind: 'surface', surfaceIndex });
      }
    } else if (authoredStyle?.kind === 'yarn') {
      if (shapes.length !== 1) throw new TypeError('Authored yarn style currently requires one connected filled shape: ' + authoredStyle.target);
      if (fillOpacity > 0) compileYarnStyle(vertices, authoredStyle, shapes[0], path.color, fillOpacity, partIndex,
        fillGradient, gradientBounds, path.userData.transform, curveSegments);
    } else {
      if (fillOpacity > 0) for (const shape of shapes) {
        if (fillGradient) appendGradientShape(vertices, shape, fillGradient, gradientBounds, path.userData.transform, fillOpacity, partIndex, curveSegments);
        else {
          const geometry = new ShapeGeometry(shape, curveSegments);
          appendTriangles(vertices, geometry, colorComponents(path.color, fillOpacity), partIndex);
          geometry.dispose();
        }
      }
      if (authoredStyle) {
        if (shapes.length !== 1) throw new TypeError('Authored sketch style currently requires one connected filled shape: ' + authoredStyle.target);
        if (fillOpacity > 0) compileSketchStyle(vertices, authoredStyle, shapes[0], styleColor, fillOpacity, partIndex);
      }
    }
    if (style.stroke !== undefined && style.stroke !== 'none' && style.strokeWidth > 0) {
      const opacity = (style.strokeOpacity ?? 1) * overallOpacity;
      if (opacity > 0) {
        const rgba = colorComponents(new Color().setStyle(style.stroke, SRGBColorSpace), opacity);
        const vectorEffect=sourceNode.getAttribute('vector-effect') || 'none';
        if (vectorEffect==='non-scaling-stroke') {
          if (morphCount) throw new TypeError('Non-scaling strokes cannot be combined with vertex morph targets');
          if (sourceNode.nodeName!=='line' || path.subPaths.length!==1) throw new TypeError('Non-scaling strokes currently support one straight <line> per shape');
          const points=path.subPaths[0].getPoints(1);
          if (points.length!==2) throw new TypeError('Non-scaling strokes currently support straight <line> geometry only');
          appendNonScalingLine(vertices,points[0],points[1],rgba,partIndex,style.strokeWidth,style.strokeLineCap ?? 'butt', strokeArcDivisions);
          hasNonScalingStroke=true;
        } else {
        const stroke = SVGLoader.getStrokeStyle(style.strokeWidth, style.stroke, style.strokeLineJoin, style.strokeLineCap, style.strokeMiterLimit);
        for (const subPath of path.subPaths) {
          const geometry = SVGLoader.pointsToStroke(subPath.getPoints(curveSegments), stroke, strokeArcDivisions, 0.001);
          if (geometry) {
            appendTriangles(vertices, geometry, rgba, partIndex);
            geometry.dispose();
          }
        }
        }
      }
    }
    appendOrderedMeshRange(drawOrder, meshFirst, vertices.length / 11 - meshFirst, partIndex);
  }
  if ((!vertices.length && !shaderSurfaces.length) || vertices.length % 33) throw new TypeError('SVG did not produce complete painted triangles or shader surfaces');
  const expanded = new Float32Array(vertices);
  const strideFloats=11;
  const uniqueVertices = [], indices = [], vertexIds = new Map();
  const words = new Uint32Array(expanded.buffer, expanded.byteOffset, expanded.length);
  for (let offset = 0; offset < expanded.length; offset += strideFloats) {
    const key = words.subarray(offset, offset + strideFloats).join(',');
    let index = vertexIds.get(key);
    if (index === undefined) {
      index = uniqueVertices.length / strideFloats;
      if (index > 0xffff) throw new RangeError('SVG needs more than 65,536 distinct vertices; split the authored asset into bounded meshes');
      vertexIds.set(key, index);
      for (let field = 0; field < strideFloats; field++) uniqueVertices.push(expanded[offset + field]);
    }
    indices.push(index);
  }
  return { vertices: new Float32Array(uniqueVertices), indices: new Uint16Array(indices), morphCount, strideFloats,
    ...(hasNonScalingStroke ? { nonScalingStroke: true } : {}),
    ...(shaderOrdered ? { shaderSurfaces, drawOrder } : {}) };
}

function compileExpressionIndices(geometry, metadata) {
  const partIndices = new Map(metadata.parts.map((part, index) => [part.id, index]));
  const output = {};
  for (const [name, expression] of Object.entries(metadata.expressions)) {
    // An expression only hides the parts it names. Keep omitted parts in the
    // index list because their visibility can be inherited from an earlier
    // expression or the player's initial visible state.
    const visible = metadata.parts.map(() => true);
    for (const id of expression.show) visible[partIndices.get(id)] = true;
    for (const id of expression.hide) visible[partIndices.get(id)] = false;
    for (let index = 0; index < metadata.parts.length; index++) {
      let parent = metadata.parts[index].parent;
      while (parent !== null) {
        if (!visible[partIndices.get(parent)]) { visible[index] = false; break; }
        parent = metadata.parts[partIndices.get(parent)].parent;
      }
    }
    const indices = [];
    for (let offset = 0; offset < geometry.indices.length; offset += 3) {
      const a = geometry.indices[offset], b = geometry.indices[offset + 1], c = geometry.indices[offset + 2];
      const part = geometry.vertices[a * 11 + 10];
      if (geometry.vertices[b * 11 + 10] !== part || geometry.vertices[c * 11 + 10] !== part) {
        throw new TypeError('Compiled SVG triangle crosses authored part boundaries');
      }
      if (visible[part]) indices.push(a, b, c);
    }
    output[name] = new Uint16Array(indices);
  }
  return output;
}

function compileSourcePaths(paths, partIndices, parts) {
  return paths.map(path => {
    const node = path.userData?.node, id = node?.getAttribute?.('id');
    if (!id) throw new TypeError('Every reference path must keep its DOM id');
    const partIndex = ownerPart(node, partIndices), style = path.userData.style;
    return {
      id, part: parts[partIndex].id,
      fill: style.fill ?? 'none', fillOpacity: style.fillOpacity ?? 1, fillRule: style.fillRule ?? 'nonzero',
      stroke: style.stroke ?? 'none', strokeOpacity: style.strokeOpacity ?? 1, strokeWidth: style.strokeWidth ?? 1,
      strokeLineCap: style.strokeLineCap ?? 'butt', strokeLineJoin: style.strokeLineJoin ?? 'miter',
      strokeMiterLimit: style.strokeMiterLimit ?? 4, opacity: style.opacity ?? 1,
      subpaths: path.subPaths.map(subPath => ({
        closed: Boolean(subPath.autoClose),
        points: subPath.getPoints(16).map(point => [point.x, point.y]),
      })),
    };
  });
}

function withoutMetadata(document) {
  const root = document.documentElement.cloneNode(true);
  for (let child = root.firstChild; child; child = child.nextSibling) {
    if (child.nodeType === 1 && child.nodeName === 'metadata' && child.getAttribute('id') === 'vector-asset') {
      root.removeChild(child);
      break;
    }
  }
  return new XMLSerializer().serializeToString(root);
}

function withNodeDomParser(callback) {
  const oldParser = globalThis.DOMParser;
  globalThis.DOMParser = class NodeSvgDOMParser extends DOMParser {
    parseFromString(...args) {
      const document = super.parseFromString(...args);
      installSvgLoaderSelectors(document);
      return document;
    }
  };
  try { return callback(); }
  finally {
    if (oldParser === undefined) delete globalThis.DOMParser;
    else globalThis.DOMParser = oldParser;
  }
}

// SVGLoader uses only these two querySelectorAll selectors. xmldom intentionally
// keeps a small DOM surface, so provide this narrow, deterministic adapter.
function installSvgLoaderSelectors(document) {
  const allowed = new Set(['linearGradient', 'radialGradient', 'stop']);
  const querySelectorAll = function (selector) {
    const names = String(selector).split(',').map(name => name.trim());
    if (!names.length || names.some(name => !allowed.has(name))) throw new TypeError('SVGLoader requested an unsupported selector');
    const found = [];
    const visit = node => {
      for (let child = node.firstChild; child; child = child.nextSibling) {
        if (child.nodeType === 1) {
          if (names.includes(child.nodeName)) found.push(child);
          visit(child);
        }
      }
    };
    visit(this.documentElement ?? this);
    return found;
  };
  Object.defineProperty(document, 'querySelectorAll', { value: querySelectorAll });
  const install = node => {
    if (node.nodeType === 1) Object.defineProperty(node, 'querySelectorAll', { value: querySelectorAll });
    for (let child = node.firstChild; child; child = child.nextSibling) install(child);
  };
  install(document.documentElement);
}

export function compileVectorAssetCore(svgBytes, sourcePath = 'asset.svg', options = {}, sourceSha256) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)
      || Object.keys(options).some(key => !['curveSegments', 'normalizeCenteredViewBox', 'strokeArcDivisions'].includes(key))) {
    throw new TypeError('Only curveSegments, normalizeCenteredViewBox, and strokeArcDivisions compiler options are supported');
  }
  const curveSegments = options.curveSegments === undefined ? 16 : options.curveSegments;
  if (!Number.isSafeInteger(curveSegments) || curveSegments < 4 || curveSegments > 64) throw new RangeError('curveSegments must be an integer from 4 to 64');
  const strokeArcDivisions = options.strokeArcDivisions === undefined ? 12 : options.strokeArcDivisions;
  if (!Number.isSafeInteger(strokeArcDivisions) || strokeArcDivisions < 4 || strokeArcDivisions > 64) throw new RangeError('strokeArcDivisions must be an integer from 4 to 64');
  const normalizeCenteredViewBox = options.normalizeCenteredViewBox ?? false;
  if (typeof normalizeCenteredViewBox !== 'boolean') throw new TypeError('normalizeCenteredViewBox must be a boolean');
  if (!(svgBytes instanceof Uint8Array)) throw new TypeError('SVG source bytes must be a Uint8Array');
  const source = svgBytes;
  if (!source.length || source.byteLength > MAX_SOURCE_BYTES) throw new RangeError('SVG source must be 1..512 KiB');
  if (typeof sourceSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(sourceSha256)) throw new TypeError('A lowercase SHA-256 digest is required');
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(source); }
  catch { throw new TypeError('SVG source must be valid UTF-8'); }
  if (text.includes('\u0000') || /<!DOCTYPE|<!ENTITY|<\?xml-stylesheet/i.test(text)) throw new TypeError('SVG doctypes, entities, stylesheets, and non-UTF-8 input are not supported');
  const original = parseXml(text, 'source');
  const root = original.documentElement;
  const ids = collectIds(root);
  const gradients = parseGradientDefinitions(root, ids);
  const metadataBlock = directMetadata(root);
  const viewBox = normalizeCenteredViewBox
    ? normalizeCenteredViewBoxInput(root, metadataBlock.value)
    : validateRoot(root);
  const metadata = validateAssetMetadata(metadataBlock.value, ids);

  const serialized = new XMLSerializer().serializeToString(original);
  const roundTrip = parseXml(serialized, 'editor-save round trip');
  const roundTripIds = collectIds(roundTrip.documentElement);
  const savedMetadata = directMetadata(roundTrip.documentElement);
  if (JSON.stringify(idList(ids)) !== JSON.stringify(idList(roundTripIds))
      || savedMetadata.text !== metadataBlock.text
      || savedMetadata.value.schemaVersion !== metadata.schemaVersion) {
    throw new Error('SVG editor-save round trip did not preserve metadata or DOM ids');
  }

  const partIndices = new Map(metadata.parts.map((part, index) => [part.id, index]));
  const vectorText = withNodeDomParser(() => {
    const loader = new SVGLoader();
    return { clean: withoutMetadata(original), loader };
  });
  const paths = withNodeDomParser(() => vectorText.loader.parse(vectorText.clean).paths);
  const geometry = compilePaths(paths, partIndices, metadata.parts, metadata, gradients, curveSegments, strokeArcDivisions);
  geometry.expressionIndices = compileExpressionIndices(geometry, metadata);
  const sourcePaths = compileSourcePaths(paths, partIndices, metadata.parts);
  const paintedIds = new Set(paths.map(path => path.userData.node.getAttribute('id')));
  const shapeNodes = [...ids.values()].filter(node => ['path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon'].includes(node.nodeName));
  if (shapeNodes.some(node => !paintedIds.has(node.getAttribute('id')))) throw new TypeError('An authored shape id was not preserved by SVGLoader');
  return {
    schemaVersion: VECTOR_ASSET_SCHEMA_VERSION,
    compilerVersion: VECTOR_ASSET_COMPILER_VERSION,
    compilerOptions: { curveSegments, normalizeCenteredViewBox, strokeArcDivisions },
    sourceSha256,
    sourcePath,
    metadata,
    viewBox,
    sourcePaths,
    geometry: { ...geometry, partCount: metadata.parts.length },
  };
}


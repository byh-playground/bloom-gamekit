import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import { Color, ShapeGeometry, SRGBColorSpace } from 'three';
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
  'stroke-linecap', 'stroke-linejoin', 'stroke-miterlimit', 'opacity',
]);
const ELEMENTS = new Set(['svg', 'metadata', 'g', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon']);

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
      for (let i = 0; i < node.attributes.length; i++) {
        const attribute = node.attributes.item(i), key = attribute.name, value = attribute.value;
        if (key === 'xmlns') {
          if (node !== root || value !== SVG_NS) throw new TypeError('Only the SVG namespace on the root is supported');
          continue;
        }
        if (!ATTRIBUTES.has(key) || /^on/i.test(key) || /url\s*\(/i.test(value) || /(?:https?:|data:|file:|\/\/)/i.test(value)) {
          throw new TypeError('Unsupported SVG attribute or external reference: ' + key);
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
        if (key === 'fill' || key === 'stroke') {
          if (value !== 'none') {
            try { new Color().setStyle(value, SRGBColorSpace); }
            catch { throw new TypeError('Unsupported SVG paint color: ' + value); }
          }
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

const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
function seeded(seed, index, salt = 0) {
  let value = Math.imul((seed ^ salt) + index * 0x9e3779b9, 0x85ebca6b);
  value = Math.imul(value ^ (value >>> 13), 0xc2b2ae35);
  return ((value ^ (value >>> 16)) >>> 0) / 0x100000000;
}

function inRing(point, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if ((a.y > point.y) !== (b.y > point.y)
        && point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

function shapeInfo(shape) {
  const extracted = shape.extractPoints(24), contour = extracted.shape;
  if (contour.length < 3) throw new TypeError('Styled SVG fills need a closed contour');
  const xs = contour.map(point => point.x), ys = contour.map(point => point.y);
  return {
    contour, holes: extracted.holes,
    minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys),
    center: { x: (Math.min(...xs) + Math.max(...xs)) / 2, y: (Math.min(...ys) + Math.max(...ys)) / 2 },
    contains(point) { return inRing(point, contour) && !extracted.holes.some(hole => inRing(point, hole)); },
  };
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

function compileYarnStyle(vertices, style, shape, fillColor, opacity, partIndex) {
  const info = shapeInfo(shape), dark = colorScale(fillColor, clamp(0.72 - style.contrast * 1.15, 0.2, 0.8), opacity);
  const groove = colorScale(fillColor, clamp(0.91 - style.contrast * 0.75, 0.3, 0.9), opacity * 0.85);
  const yarn = colorScale(fillColor, 1 + style.contrast * 0.55, opacity);
  const highlight = colorScale(fillColor.clone().lerp(new Color(1, 1, 1), clamp(0.32 + style.contrast, 0.2, 0.85)), 1, opacity * 0.57);
  const twist = colorScale(fillColor.clone().lerp(new Color(1, 1, 1), 0.3), 1, opacity * 0.5);
  const width = style.stitchWidth, height = style.stitchHeight;
  const columns = Math.min(128, Math.max(1, Math.ceil((info.maxX - info.minX) / width)));
  const rows = Math.min(128, Math.max(1, Math.ceil((info.maxY - info.minY) / height)));
  const stitch = [
    [0.08, 0.54], [0.2, 0.22], [0.43, 0.1], [0.69, 0.18], [0.91, 0.47], [0.72, 0.78], [0.46, 0.9], [0.2, 0.78], [0.08, 0.54],
  ];
  let emitted = 0;
  for (let row = 0; row < rows; row++) for (let column = 0; column < columns; column++) {
    const cellX = info.minX + column * width, cellY = info.minY + row * height;
    const jitter = (seeded(style.seed, row * columns + column) - 0.5) * style.irregularity;
    const points = stitch.map(([x, y]) => ({ x: cellX + (x + jitter) * width, y: cellY + y * height }));
    appendClippedPolyline(vertices, points.map(point => ({ x: point.x, y: point.y + height * style.thickness * 0.06 })), false,
      Math.max(0.12, width * style.thickness * 0.5), dark, partIndex, info);
    appendClippedPolyline(vertices, points, false, Math.max(0.14, width * style.thickness * 1.08), groove, partIndex, info);
    appendClippedPolyline(vertices, points, false, Math.max(0.12, width * style.thickness * 0.82), yarn, partIndex, info);
    const hi = points.map(point => ({ x: point.x, y: point.y - height * style.thickness * 0.22 }));
    appendClippedPolyline(vertices, hi, false, Math.max(0.1, width * style.thickness * 0.34), highlight, partIndex, info);
    const tw = points.filter((_, pointIndex) => pointIndex % 2 === 0).map((point, pointIndex) => ({ x: point.x, y: point.y + (pointIndex % 2 ? 1 : -1) * height * style.thickness * 0.12 }));
    appendClippedPolyline(vertices, tw, false, Math.max(0.08, width * 0.075), twist, partIndex, info);
    if (++emitted > 16384) throw new RangeError('Yarn style tessellation exceeds the 16,384 stitch limit');
  }
  const edgeCount = Math.min(4096, Math.floor(info.contour.reduce((sum, point, index) => sum + Math.hypot(point.x - info.contour[(index + 1) % info.contour.length].x, point.y - info.contour[(index + 1) % info.contour.length].y), 0) / style.edgeSpacing));
  for (let index = 0; index < edgeCount; index++) {
    const point = info.contour[Math.floor(index * info.contour.length / edgeCount)], dx = info.center.x - point.x, dy = info.center.y - point.y, length = Math.hypot(dx, dy) || 1;
    const inward = { x: dx / length, y: dy / length }, a = { x: point.x + inward.x * style.edgeRelief, y: point.y + inward.y * style.edgeRelief };
    const b = { x: a.x + inward.x * style.edgeSpacing * 0.42, y: a.y + inward.y * style.edgeSpacing * 0.42 };
    appendStyleSegment(vertices, a, b, style.edgeWidth, dark, partIndex);
  }
  for (let index = 0; index < style.fiberMax; index++) {
    const x = info.minX + seeded(style.seed, index, 0x1839) * (info.maxX - info.minX), y = info.minY + seeded(style.seed, index, 0x8d31) * (info.maxY - info.minY);
    const start = { x, y }, angle = seeded(style.seed, index, 0x52a1) * Math.PI * 2, length = style.fiberLength * (0.45 + seeded(style.seed, index, 0xa771) * 0.55);
    const end = { x: x + Math.cos(angle) * length, y: y + Math.sin(angle) * length };
    if (info.contains(start)) appendClippedPolyline(vertices, [start, end], false, style.fiberWidth, colorScale(fillColor, 1.3, opacity * style.fiberOpacity), partIndex, info);
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

function ownerPart(node, partIndices) {
  for (let current = node; current; current = current.parentNode) {
    if (current.nodeType !== 1) continue;
    const id = current.getAttribute('id');
    if (id && partIndices.has(id)) return partIndices.get(id);
  }
  throw new TypeError('Every painted SVG element must be inside an authored part group');
}

function compilePaths(paths, partIndices, parts, metadata) {
  const vertices = [];
  const styled = new Map((metadata.styles ?? []).map(style => [style.target, style]));
  const morphCount = metadata.styles?.some(style => style.kind === 'sketch') ? 2 : 0;
  for (const path of paths) {
    const sourceNode = path.userData?.node;
    if (!sourceNode?.getAttribute?.('id')) throw new TypeError('Every painted SVG shape must keep its DOM id');
    const partIndex = ownerPart(sourceNode, partIndices);
    const style = path.userData.style;
    const overallOpacity = style.opacity ?? 1;
    if (style.fill !== undefined && style.fill !== 'none') {
      const opacity = (style.fillOpacity ?? 1) * overallOpacity;
      if (opacity > 0) {
        const rgba = colorComponents(path.color, opacity);
        for (const shape of path.toShapes()) {
          const geometry = new ShapeGeometry(shape, 16);
          appendTriangles(vertices, geometry, rgba, partIndex);
          geometry.dispose();
        }
      }
    }
    const authoredStyle = styled.get(sourceNode.getAttribute('id'));
    if (authoredStyle && (style.fill === undefined || style.fill === 'none')) throw new TypeError('Authored yarn/sketch styles require a solid SVG fill: ' + authoredStyle.target);
    if (authoredStyle) {
      const shapes = path.toShapes();
      if (shapes.length !== 1) throw new TypeError('Authored yarn/sketch styles currently require one connected filled shape: ' + authoredStyle.target);
      const paintOpacity = (style.fillOpacity ?? 1) * overallOpacity;
      if (authoredStyle.kind === 'yarn') compileYarnStyle(vertices, authoredStyle, shapes[0], path.color, paintOpacity, partIndex);
      else compileSketchStyle(vertices, authoredStyle, shapes[0], path.color, paintOpacity, partIndex);
    }
    if (style.stroke !== undefined && style.stroke !== 'none' && style.strokeWidth > 0) {
      const opacity = (style.strokeOpacity ?? 1) * overallOpacity;
      if (opacity > 0) {
        const rgba = colorComponents(new Color().setStyle(style.stroke, SRGBColorSpace), opacity);
        const stroke = SVGLoader.getStrokeStyle(style.strokeWidth, style.stroke, style.strokeLineJoin, style.strokeLineCap, style.strokeMiterLimit);
        for (const subPath of path.subPaths) {
          const geometry = SVGLoader.pointsToStroke(subPath.getPoints(16), stroke, 12, 0.001);
          if (geometry) {
            appendTriangles(vertices, geometry, rgba, partIndex);
            geometry.dispose();
          }
        }
      }
    }
  }
  if (!vertices.length || vertices.length % 33) throw new TypeError('SVG did not produce complete painted triangles');
  return { vertices: new Float32Array(vertices), morphCount };
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

export function compileVectorAsset(svgBytes, sourcePath = 'asset.svg') {
  const source = Buffer.isBuffer(svgBytes) ? svgBytes : Buffer.from(String(svgBytes), 'utf8');
  if (!source.length || source.byteLength > MAX_SOURCE_BYTES) throw new RangeError('SVG source must be 1..512 KiB');
  const text = source.toString('utf8');
  if (text.includes('\u0000') || /<!DOCTYPE|<!ENTITY|<\?xml-stylesheet/i.test(text)) throw new TypeError('SVG doctypes, entities, stylesheets, and non-UTF-8 input are not supported');
  const original = parseXml(text, 'source');
  const root = original.documentElement;
  const ids = collectIds(root);
  const metadataBlock = directMetadata(root);
  const viewBox = validateRoot(root);
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
  const geometry = compilePaths(paths, partIndices, metadata.parts, metadata);
  const sourcePaths = compileSourcePaths(paths, partIndices, metadata.parts);
  const paintedIds = new Set(paths.map(path => path.userData.node.getAttribute('id')));
  const shapeNodes = [...ids.values()].filter(node => ['path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon'].includes(node.nodeName));
  if (shapeNodes.some(node => !paintedIds.has(node.getAttribute('id')))) throw new TypeError('An authored shape id was not preserved by SVGLoader');
  return {
    schemaVersion: VECTOR_ASSET_SCHEMA_VERSION,
    compilerVersion: VECTOR_ASSET_COMPILER_VERSION,
    sourceSha256: createHash('sha256').update(source).digest('hex'),
    sourcePath,
    metadata,
    viewBox,
    sourcePaths,
    geometry: { ...geometry, strideFloats: 11, partCount: metadata.parts.length },
  };
}

export async function compileVectorAssetFile(svgPath, sourcePath = 'asset.svg') {
  const bytes = await readFile(svgPath);
  return compileVectorAsset(bytes, sourcePath);
}

function javascriptValue(value) {
  if (value instanceof Float32Array) {
    const bytes = Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('base64');
    return '(()=>{const b=atob(' + JSON.stringify(bytes) + '),u=new Uint8Array(b.length);for(let i=0;i<b.length;i++)u[i]=b.charCodeAt(i);return new Float32Array(u.buffer)})()';
  }
  if (Array.isArray(value)) return '[' + value.map(javascriptValue).join(',') + ']';
  if (value && typeof value === 'object') return 'Object.freeze({' + Object.entries(value).map(([key, child]) => JSON.stringify(key) + ':' + javascriptValue(child)).join(',') + '})';
  return JSON.stringify(value) ?? 'null';
}

export function compiledAssetModuleSource(asset, exportName = 'compiledAsset') {
  if (!/^[A-Za-z_$][\w$]*$/.test(exportName)) throw new TypeError('A JavaScript export identifier is required');
  return `export const ${exportName} = ${javascriptValue(asset)};\n`;
}

export async function bundledAssetSource(root) {
  const asset = await compileVectorAssetFile(resolve(root, 'modules/vector-assets/assets/seed-scout.svg'), 'modules/vector-assets/assets/seed-scout.svg');
  const { sourcePaths, ...runtimeAsset } = asset;
  return compiledAssetModuleSource(runtimeAsset, 'seedScout');
}

export async function bundledStyleExamplesSource(root) {
  const samples = [];
  for (const id of ['yarn-fox', 'sketch-fox']) {
    const sourcePath = `modules/vector-assets/assets/${id}.svg`;
    const bytes = await readFile(resolve(root, sourcePath));
    const asset = await compileVectorAssetFile(resolve(root, sourcePath), sourcePath);
    const { sourcePaths, ...runtimeAsset } = asset;
    samples.push(JSON.stringify(id) + ':Object.freeze({source:' + JSON.stringify(bytes.toString('utf8')) + ',asset:' + javascriptValue(runtimeAsset) + '})');
  }
  return `export const styleSamples=Object.freeze({${samples.join(',')}});\n`;
}

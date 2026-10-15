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

function ownerPart(node, partIndices) {
  for (let current = node; current; current = current.parentNode) {
    if (current.nodeType !== 1) continue;
    const id = current.getAttribute('id');
    if (id && partIndices.has(id)) return partIndices.get(id);
  }
  throw new TypeError('Every painted SVG element must be inside an authored part group');
}

function compilePaths(paths, partIndices) {
  const vertices = [];
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
  return new Float32Array(vertices);
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
  const vertices = compilePaths(paths, partIndices);
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
    geometry: { vertices, strideFloats: 11, partCount: metadata.parts.length, morphCount: 0 },
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

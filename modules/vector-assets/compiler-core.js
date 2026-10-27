import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import { Color, Path, Shape, ShapeGeometry, SRGBColorSpace } from 'three';
import { SVGLoader } from 'three/addons/loaders/SVGLoader.js';
import { VECTOR_ASSET_COMPILER_VERSION, VECTOR_ASSET_SCHEMA_VERSION, validateAssetMetadata } from './schema.js';
import { VECTOR_ASSET_QUALITY_PRESETS } from './quality-presets.js';
import { svgPaintRegion, SVG_PAINT_REGION_ATTRIBUTE } from './paint-regions.js';
import { MAX_PAINT_REGIONS } from '../rendering/paint-regions.js';
const SVG_NS = 'http://www.w3.org/2000/svg';
const MAX_SOURCE_BYTES = 512 * 1024;
const MAX_ELEMENTS = 4096;
const NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;
const ATTRIBUTES = new Set([
    'id',
    'xmlns',
    'width',
    'height',
    'viewBox',
    'version',
    'transform',
    'd',
    'x',
    'y',
    'width',
    'height',
    'cx',
    'cy',
    'r',
    'rx',
    'ry',
    'x1',
    'y1',
    'x2',
    'y2',
    'points',
    'fill',
    'fill-opacity',
    'fill-rule',
    'stroke',
    'stroke-opacity',
    'stroke-width',
    'stroke-linecap',
    'stroke-linejoin',
    'stroke-miterlimit',
    'vector-effect',
    'opacity',
    'display',
    SVG_PAINT_REGION_ATTRIBUTE,
]);
const GRADIENT_ATTRIBUTES = new Set(['id', 'gradientUnits', 'spreadMethod', 'x1', 'y1', 'x2', 'y2']);
const STOP_ATTRIBUTES = new Set(['id', 'offset', 'stop-color', 'stop-opacity']);
const ELEMENTS = new Set([
    'svg',
    'metadata',
    'defs',
    'linearGradient',
    'stop',
    'g',
    'path',
    'rect',
    'circle',
    'ellipse',
    'line',
    'polyline',
    'polygon',
]);
function finiteList(value, count, name) {
    const VALUES = value
        .trim()
        .split(/[\s,]+/)
        .filter(Boolean)
        .map(Number);
    if (VALUES.length !== count || VALUES.some((number) => !Number.isFinite(number))) {
        throw new TypeError(name + ' must contain ' + count + ' finite numbers');
    }
    return VALUES;
}
function validateTransform(value) {
    let cursor = 0;
    const TRANSFORM = /([A-Za-z]+)\s*\(([^()]*)\)\s*/gy;
    const LENGTHS = {
        matrix: 6,
        translate: [1, 2],
        scale: [1, 2],
        rotate: [1, 3],
        skewX: 1,
        skewY: 1,
    };
    while (cursor < value.length) {
        while (/\s|,/.test(value[cursor] ?? '')) {
            cursor++;
        }
        if (cursor === value.length) {
            break;
        }
        TRANSFORM.lastIndex = cursor;
        const MATCH = TRANSFORM.exec(value);
        if (!MATCH || !Object.hasOwn(LENGTHS, MATCH[1])) {
            throw new TypeError('Unsupported SVG transform syntax');
        }
        const ARGS = MATCH[2]
            .trim()
            .split(/[\s,]+/)
            .filter(Boolean);
        const EXPECTED = LENGTHS[MATCH[1]];
        const VALID_COUNT = Array.isArray(EXPECTED) ? EXPECTED.includes(ARGS.length) : ARGS.length === EXPECTED;
        if (!VALID_COUNT || ARGS.some((argument) => !NUMBER.test(argument))) {
            throw new TypeError('Invalid SVG transform arguments');
        }
        cursor = TRANSFORM.lastIndex;
    }
}
function gradientCoordinate(value, units, name) {
    const RAW =
        value ??
        {
            x1: '0%',
            y1: '0%',
            x2: '100%',
            y2: '0%',
        }[name];
    if (units === 'objectBoundingBox') {
        const PERCENT = /^([+-]?(?:\d+\.?\d*|\.\d+))%$/.exec(RAW);
        const NUMBER_LOCAL = PERCENT ? Number(PERCENT[1]) / 100 : NUMBER.test(RAW) ? Number(RAW) : NaN;
        if (!Number.isFinite(NUMBER_LOCAL) || NUMBER_LOCAL < 0 || NUMBER_LOCAL > 1) {
            throw new RangeError('objectBoundingBox gradient ' + name + ' must be in [0,1]');
        }
        return NUMBER_LOCAL;
    }
    if (!NUMBER.test(RAW) || !Number.isFinite(Number(RAW))) {
        throw new TypeError('userSpaceOnUse gradient ' + name + ' must be a unitless CSS pixel number');
    }
    return Number(RAW);
}
function parseGradientDefinitions(root, ids) {
    const GRADIENTS = new Map();
    const CANDIDATES = [];
    const VISIT = (node) => {
        if (node.nodeType === 1 && node.nodeName === 'linearGradient') {
            CANDIDATES.push(node);
        }
        for (let child = node.firstChild; child; child = child.nextSibling) {
            VISIT(child);
        }
    };
    VISIT(root);
    for (const NODE of CANDIDATES) {
        if (NODE.parentNode?.nodeName !== 'defs' || NODE.parentNode.parentNode !== root) {
            throw new TypeError('linearGradient must be a direct child of root defs');
        }
        if (!NODE.getAttribute('id') || ids.get(NODE.getAttribute('id')) !== NODE) {
            throw new TypeError('linearGradient needs a unique id');
        }
        const UNITS = NODE.getAttribute('gradientUnits') || 'objectBoundingBox';
        const SPREAD = NODE.getAttribute('spreadMethod') || 'pad';
        if (!['objectBoundingBox', 'userSpaceOnUse'].includes(UNITS) || SPREAD !== 'pad') {
            throw new TypeError(
                'Only pad linearGradient with objectBoundingBox or userSpaceOnUse coordinates is supported',
            );
        }
        const X1 = gradientCoordinate(NODE.getAttribute('x1'), UNITS, 'x1');
        const Y1 = gradientCoordinate(NODE.getAttribute('y1'), UNITS, 'y1');
        const X2 = gradientCoordinate(NODE.getAttribute('x2'), UNITS, 'x2');
        const Y2 = gradientCoordinate(NODE.getAttribute('y2'), UNITS, 'y2');
        if (X1 === X2 && Y1 === Y2) {
            throw new TypeError('A linearGradient needs two distinct endpoints');
        }
        const STOPS = [];
        for (let child = NODE.firstChild; child; child = child.nextSibling) {
            if (child.nodeType !== 1) {
                continue;
            }
            if (child.nodeName !== 'stop') {
                throw new TypeError('linearGradient may contain stop elements only');
            }
            const RAW_OFFSET = child.getAttribute('offset') || '0';
            const PERCENT = /^([+-]?(?:\d+\.?\d*|\.\d+))%$/.exec(RAW_OFFSET);
            const OFFSET = PERCENT ? Number(PERCENT[1]) / 100 : NUMBER.test(RAW_OFFSET) ? Number(RAW_OFFSET) : NaN;
            const COLOR_TEXT = child.getAttribute('stop-color') || '#000000';
            const OPACITY_TEXT = child.getAttribute('stop-opacity') || '1';
            if (
                !Number.isFinite(OFFSET) ||
                OFFSET < 0 ||
                OFFSET > 1 ||
                (STOPS.length && OFFSET < STOPS[STOPS.length - 1].offset)
            ) {
                throw new RangeError('linearGradient stop offsets must be nondecreasing in [0,1]');
            }
            if (!NUMBER.test(OPACITY_TEXT) || Number(OPACITY_TEXT) < 0 || Number(OPACITY_TEXT) > 1) {
                throw new RangeError('stop-opacity must be in [0,1]');
            }
            let color;
            try {
                color = colorComponents(new Color().setStyle(COLOR_TEXT, SRGBColorSpace), Number(OPACITY_TEXT));
            } catch {
                throw new TypeError('Unsupported linearGradient stop color: ' + COLOR_TEXT);
            }
            STOPS.push({
                offset: OFFSET,
                color,
            });
            if (STOPS.length > 16) {
                throw new RangeError('linearGradient supports at most 16 stops');
            }
        }
        if (STOPS.length < 2) {
            throw new TypeError('linearGradient needs at least two explicit stop elements');
        }
        GRADIENTS.set(NODE.getAttribute('id'), {
            id: NODE.getAttribute('id'),
            units: UNITS,
            x1: X1,
            y1: Y1,
            x2: X2,
            y2: Y2,
            stops: STOPS,
        });
    }
    return GRADIENTS;
}
function parseXml(source, label) {
    const ERRORS = [];
    const DOCUMENT = new DOMParser({
        onError(level, message) {
            ERRORS.push(String(level) + ': ' + String(message));
        },
    }).parseFromString(source, 'image/svg+xml');
    if (ERRORS.length) {
        throw new SyntaxError('Invalid SVG ' + label + ': ' + ERRORS.join('; '));
    }
    if (!DOCUMENT?.documentElement || DOCUMENT.documentElement.nodeName !== 'svg') {
        throw new TypeError('An SVG document root is required');
    }
    return DOCUMENT;
}
function collectIds(root) {
    const IDS = new Map();
    let elementCount = 0;
    const VISIT = (node) => {
        if (node.nodeType === 1) {
            if (++elementCount > MAX_ELEMENTS) {
                throw new RangeError('SVG element limit exceeded');
            }
            const NAME = node.nodeName;
            if (NAME === 'script' || NAME === 'foreignObject' || NAME === 'image') {
                throw new TypeError('Script, foreignObject, and raster image elements are not supported');
            }
            if (!ELEMENTS.has(NAME) || (node.namespaceURI && node.namespaceURI !== SVG_NS)) {
                throw new TypeError('Unsupported SVG element or namespace: ' + NAME);
            }
            if (NAME === 'metadata' && (node.parentNode !== root || node.getAttribute('id') !== 'vector-asset')) {
                throw new TypeError('Only the direct JSON metadata#vector-asset element is supported');
            }
            if (NAME === 'defs' && node.parentNode !== root) {
                throw new TypeError('SVG defs must be a direct child of the root');
            }
            if (NAME === 'linearGradient' && node.parentNode?.nodeName !== 'defs') {
                throw new TypeError('linearGradient must be inside root defs');
            }
            if (NAME === 'stop' && node.parentNode?.nodeName !== 'linearGradient') {
                throw new TypeError('stop must be inside linearGradient');
            }
            const ALLOWED_ATTRIBUTES =
                NAME === 'linearGradient' ? GRADIENT_ATTRIBUTES : NAME === 'stop' ? STOP_ATTRIBUTES : ATTRIBUTES;
            for (let i = 0; i < node.attributes.length; i++) {
                const ATTRIBUTE = node.attributes.item(i),
                    KEY = ATTRIBUTE.name,
                    VALUE = ATTRIBUTE.value;
                if (KEY === 'xmlns') {
                    if (node !== root || VALUE !== SVG_NS) {
                        throw new TypeError('Only the SVG namespace on the root is supported');
                    }
                    continue;
                }
                const GRADIENT_PAINT = KEY === 'fill' && /^url\(\s*#[A-Za-z_][A-Za-z0-9_.:-]{0,127}\s*\)$/.test(VALUE);
                if (
                    !ALLOWED_ATTRIBUTES.has(KEY) ||
                    /^on/i.test(KEY) ||
                    (/url\s*\(/i.test(VALUE) && !GRADIENT_PAINT) ||
                    /(?:https?:|data:|file:|\/\/)/i.test(VALUE)
                ) {
                    throw new TypeError('Unsupported SVG attribute or external reference: ' + KEY);
                }
                if (KEY === 'display' && VALUE !== 'none') {
                    throw new TypeError(
                        'Only display="none" is supported, on expression parts hidden by defaultExpression',
                    );
                }
                if (
                    KEY === SVG_PAINT_REGION_ATTRIBUTE &&
                    !['path', 'rect', 'circle', 'ellipse', 'polygon', 'polyline'].includes(NAME)
                ) {
                    throw new TypeError('A paint region must name an authored filled shape');
                }
                if (KEY === 'vector-effect') {
                    if (!['none', 'non-scaling-stroke'].includes(VALUE)) {
                        throw new TypeError('Unsupported SVG vector-effect: ' + VALUE);
                    }
                    if (NAME !== 'line') {
                        throw new TypeError('Non-scaling strokes currently support only <line> elements');
                    }
                }
                if (KEY === 'id') {
                    if (!VALUE || IDS.has(VALUE)) {
                        throw new TypeError('SVG ids must be nonempty and unique: ' + VALUE);
                    }
                    IDS.set(VALUE, node);
                }
                if (KEY === 'transform') {
                    validateTransform(VALUE);
                }
                if (['fill-opacity', 'stroke-opacity', 'opacity'].includes(KEY)) {
                    if (!NUMBER.test(VALUE) || Number(VALUE) < 0 || Number(VALUE) > 1) {
                        throw new RangeError(KEY + ' must be in [0,1]');
                    }
                }
                if (KEY === 'stroke-width' && (!NUMBER.test(VALUE) || Number(VALUE) <= 0)) {
                    throw new RangeError('stroke-width must be positive');
                }
                if (KEY === 'stroke-miterlimit' && (!NUMBER.test(VALUE) || Number(VALUE) <= 0)) {
                    throw new RangeError('stroke-miterlimit must be positive');
                }
                if (KEY === 'stroke-linecap' && !['butt', 'round', 'square'].includes(VALUE)) {
                    throw new TypeError('Unsupported stroke-linecap: ' + VALUE);
                }
                if (KEY === 'stroke-linejoin' && !['miter', 'round', 'bevel'].includes(VALUE)) {
                    throw new TypeError('Unsupported stroke-linejoin: ' + VALUE);
                }
                if (KEY === 'fill-rule' && VALUE !== 'evenodd') {
                    throw new TypeError('Only evenodd compound fills are supported');
                }
                if ((KEY === 'fill' || KEY === 'stroke') && !GRADIENT_PAINT) {
                    if (VALUE !== 'none') {
                        try {
                            new Color().setStyle(VALUE, SRGBColorSpace);
                        } catch {
                            throw new TypeError('Unsupported SVG paint color: ' + VALUE);
                        }
                    }
                }
                if (
                    NAME === 'linearGradient' &&
                    KEY === 'gradientUnits' &&
                    !['objectBoundingBox', 'userSpaceOnUse'].includes(VALUE)
                ) {
                    throw new TypeError('Unsupported SVG gradientUnits: ' + VALUE);
                }
                if (NAME === 'linearGradient' && KEY === 'spreadMethod' && VALUE !== 'pad') {
                    throw new TypeError('Only linearGradient spreadMethod=pad is supported');
                }
                if (NAME === 'linearGradient' && ['x1', 'y1', 'x2', 'y2'].includes(KEY)) {
                    gradientCoordinate(VALUE, node.getAttribute('gradientUnits') || 'objectBoundingBox', KEY);
                }
                if (NAME === 'stop' && KEY === 'offset') {
                    const PERCENT = /^([+-]?(?:\d+\.?\d*|\.\d+))%$/.exec(VALUE);
                    const OFFSET = PERCENT ? Number(PERCENT[1]) / 100 : NUMBER.test(VALUE) ? Number(VALUE) : NaN;
                    if (!Number.isFinite(OFFSET) || OFFSET < 0 || OFFSET > 1) {
                        throw new RangeError('linearGradient offset must be in [0,1]');
                    }
                }
                if (NAME === 'stop' && KEY === 'stop-color') {
                    try {
                        new Color().setStyle(VALUE, SRGBColorSpace);
                    } catch {
                        throw new TypeError('Unsupported linearGradient stop color: ' + VALUE);
                    }
                }
            }
        } else if (node.nodeType === 3 && node.parentNode?.nodeName !== 'metadata' && node.nodeValue.trim()) {
            throw new TypeError('SVG text outside the JSON metadata block is not supported');
        } else if (node.nodeType === 10 || node.nodeType === 7) {
            throw new TypeError('SVG doctypes and processing instructions are not supported');
        }
        for (let child = node.firstChild; child; child = child.nextSibling) {
            VISIT(child);
        }
    };
    VISIT(root);
    return IDS;
}
function directMetadata(root) {
    const NODES = [];
    for (let child = root.firstChild; child; child = child.nextSibling) {
        if (child.nodeType === 1 && child.nodeName === 'metadata') {
            NODES.push(child);
        }
    }
    if (NODES.length !== 1 || NODES[0].getAttribute('id') !== 'vector-asset') {
        throw new TypeError('Exactly one direct metadata#vector-asset JSON block is required');
    }
    const METADATA = NODES[0];
    for (let child = METADATA.firstChild; child; child = child.nextSibling) {
        if (child.nodeType !== 3 && child.nodeType !== 8) {
            throw new TypeError('SVG metadata may contain JSON text only');
        }
    }
    let value;
    try {
        value = JSON.parse(METADATA.textContent.trim());
    } catch {
        throw new SyntaxError('SVG metadata must contain valid JSON');
    }
    return {
        node: METADATA,
        value,
        text: METADATA.textContent.trim(),
    };
}
function validateRoot(root) {
    const VIEW_BOX = finiteList(root.getAttribute('viewBox') || '', 4, 'viewBox');
    const WIDTH = root.getAttribute('width'),
        HEIGHT = root.getAttribute('height');
    if (
        VIEW_BOX[0] !== 0 ||
        VIEW_BOX[1] !== 0 ||
        VIEW_BOX[2] <= 0 ||
        VIEW_BOX[3] <= 0 ||
        !WIDTH ||
        !HEIGHT ||
        !NUMBER.test(WIDTH) ||
        !NUMBER.test(HEIGHT) ||
        Number(WIDTH) !== VIEW_BOX[2] ||
        Number(HEIGHT) !== VIEW_BOX[3]
    ) {
        throw new TypeError('SVG viewBox must be 0 0 width height in unitless CSS pixels');
    }
    return VIEW_BOX;
}
function normalizeCenteredViewBoxInput(root, metadata) {
    const WIDTH_TEXT = root.getAttribute('width'),
        HEIGHT_TEXT = root.getAttribute('height');
    const WIDTH = Number(WIDTH_TEXT),
        HEIGHT = Number(HEIGHT_TEXT);
    const VIEW_BOX = finiteList(root.getAttribute('viewBox') || '', 4, 'viewBox');
    if (
        !WIDTH_TEXT ||
        !HEIGHT_TEXT ||
        !Number.isFinite(WIDTH) ||
        !Number.isFinite(HEIGHT) ||
        VIEW_BOX[2] <= 0 ||
        VIEW_BOX[3] <= 0
    ) {
        throw new TypeError(
            'Centered SVG normalization needs finite root width, height, and positive viewBox dimensions',
        );
    }

    // This matches the build-time Bounko normalization without changing source
    // bytes or authored local coordinates. Three's SVGLoader compiles geometry
    // in those authored coordinates; the original viewport is returned below.
    root.setAttribute('width', String(VIEW_BOX[2]));
    root.setAttribute('height', String(VIEW_BOX[3]));
    root.setAttribute('viewBox', `0 0 ${VIEW_BOX[2]} ${VIEW_BOX[3]}`);
    for (const CLIP of Object.values(metadata?.clips ?? {})) {
        for (const FRAME of CLIP?.keyframes ?? []) {
            const POSES = FRAME?.parts;
            if (!POSES || typeof POSES !== 'object' || Array.isArray(POSES)) {
                continue;
            }
            for (const [PART, POSE] of Object.entries(POSES)) {
                if (POSE && typeof POSE === 'object' && !Array.isArray(POSE) && Object.keys(POSE).length === 0) {
                    delete POSES[PART];
                }
            }
        }
    }
    return VIEW_BOX;
}
function idList(ids) {
    return [...ids.keys()].sort();
}
function colorComponents(color, opacity) {
    const HEX = color.getHex(SRGBColorSpace);
    return [((HEX >>> 16) & 255) / 255, ((HEX >>> 8) & 255) / 255, (HEX & 255) / 255, opacity];
}
function appendTriangles(vertices, geometry, rgba, partIndex) {
    if (!geometry?.attributes?.position) {
        return;
    }
    const POSITION = geometry.attributes.position;
    const INDEX = geometry.index;
    const COUNT = INDEX ? INDEX.count : POSITION.count;
    for (let triangle = 0; triangle + 2 < COUNT; triangle += 3) {
        for (let corner = 0; corner < 3; corner++) {
            const AT = triangle + corner;
            const VERTEX = INDEX ? INDEX.getX(AT) : AT;
            vertices.push(POSITION.getX(VERTEX), POSITION.getY(VERTEX), ...rgba, 0, 0, 0, 0, partIndex);
        }
    }
}
function inverseTransformedPoint(matrix, point) {
    const E = matrix.elements,
        DX = point.x - E[6],
        DY = point.y - E[7],
        DETERMINANT = E[0] * E[4] - E[3] * E[1];
    if (!Number.isFinite(DETERMINANT) || Math.abs(DETERMINANT) < 1e-12) {
        throw new TypeError('Gradient target transform must be invertible');
    }
    return {
        x: (E[4] * DX - E[3] * DY) / DETERMINANT,
        y: (-E[1] * DX + E[0] * DY) / DETERMINANT,
    };
}
function shapeBounds(shapes, inverseTransform = null) {
    const BOUNDS = {
        minX: Infinity,
        minY: Infinity,
        maxX: -Infinity,
        maxY: -Infinity,
    };
    for (const SHAPE of shapes) {
        const POINTS = SHAPE.extractPoints(24);
        for (const POINT of [...POINTS.shape, ...POINTS.holes.flat()]) {
            const LOCAL = inverseTransform ? inverseTransformedPoint(inverseTransform, POINT) : POINT;
            BOUNDS.minX = Math.min(BOUNDS.minX, LOCAL.x);
            BOUNDS.maxX = Math.max(BOUNDS.maxX, LOCAL.x);
            BOUNDS.minY = Math.min(BOUNDS.minY, LOCAL.y);
            BOUNDS.maxY = Math.max(BOUNDS.maxY, LOCAL.y);
        }
    }
    if (!Number.isFinite(BOUNDS.minX) || BOUNDS.maxX <= BOUNDS.minX || BOUNDS.maxY <= BOUNDS.minY) {
        throw new TypeError('Gradient paint needs a nonempty shape bounding box');
    }
    return BOUNDS;
}
function transformedPoint(matrix, point) {
    const E = matrix.elements;
    return {
        x: E[0] * point.x + E[3] * point.y + E[6],
        y: E[1] * point.x + E[4] * point.y + E[7],
    };
}
function gradientColorAtT(gradient, t) {
    if (t <= gradient.stops[0].offset) {
        return gradient.stops[0].color;
    }
    for (let index = 1; index < gradient.stops.length; index++) {
        const RIGHT = gradient.stops[index],
            LEFT = gradient.stops[index - 1];
        if (t <= RIGHT.offset) {
            const AMOUNT = RIGHT.offset === LEFT.offset ? 1 : (t - LEFT.offset) / (RIGHT.offset - LEFT.offset);
            return LEFT.color.map((value, channel) => value + (RIGHT.color[channel] - value) * AMOUNT);
        }
    }
    return gradient.stops.at(-1).color;
}
function gradientEndpoints(gradient, bounds, transform) {
    const LOCAL =
        gradient.units === 'objectBoundingBox'
            ? (x, y) => ({
                  x: bounds.minX + x * (bounds.maxX - bounds.minX),
                  y: bounds.minY + y * (bounds.maxY - bounds.minY),
              })
            : (x, y) => ({
                  x,
                  y,
              });
    return [
        transformedPoint(transform, LOCAL(gradient.x1, gradient.y1)),
        transformedPoint(transform, LOCAL(gradient.x2, gradient.y2)),
    ];
}
function gradientAtPoint(gradient, point, bounds, transform) {
    const [START, END] = gradientEndpoints(gradient, bounds, transform);
    const DX = END.x - START.x,
        DY = END.y - START.y;
    const T = ((point.x - START.x) * DX + (point.y - START.y) * DY) / (DX * DX + DY * DY);
    return gradientColorAtT(gradient, T);
}
function clipGradientPolygon(polygon, sampler, level, keepAbove) {
    const OUTPUT = [];
    for (let index = 0; index < polygon.length; index++) {
        const A = polygon[index],
            B = polygon[(index + 1) % polygon.length];
        const DA = sampler(A) - level,
            DB = sampler(B) - level;
        const INSIDE_A = keepAbove ? DA >= -1e-9 : DA <= 1e-9;
        const INSIDE_B = keepAbove ? DB >= -1e-9 : DB <= 1e-9;
        if (INSIDE_A) {
            OUTPUT.push(A);
        }
        if (INSIDE_A !== INSIDE_B) {
            const AMOUNT = DA / (DA - DB);
            OUTPUT.push({
                x: A.x + (B.x - A.x) * AMOUNT,
                y: A.y + (B.y - A.y) * AMOUNT,
            });
        }
    }
    return OUTPUT;
}
function appendGradientShape(vertices, shape, gradient, bounds, transform, opacity, partIndex, curveSegments) {
    const GEOMETRY = new ShapeGeometry(shape, curveSegments),
        POSITION = GEOMETRY.attributes.position,
        INDEX = GEOMETRY.index;
    const COUNT = INDEX ? INDEX.count : POSITION.count;
    const GRADIENT_T = (point) => {
        const [START, END] = gradientEndpoints(gradient, bounds, transform);
        const DX = END.x - START.x,
            DY = END.y - START.y;
        return ((point.x - START.x) * DX + (point.y - START.y) * DY) / (DX * DX + DY * DY);
    };
    const COLOR_AT = (point) =>
        gradientAtPoint(gradient, point, bounds, transform).map((value, channel) =>
            channel === 3 ? value * opacity : value,
        );
    for (let triangle = 0; triangle + 2 < COUNT; triangle += 3) {
        const POINTS = [0, 1, 2].map((corner) => {
            const AT = triangle + corner,
                VERTEX = INDEX ? INDEX.getX(AT) : AT;
            return {
                x: POSITION.getX(VERTEX),
                y: POSITION.getY(VERTEX),
            };
        });
        const TIMES = POINTS.map(GRADIENT_T),
            LOW = Math.min(...TIMES),
            HIGH = Math.max(...TIMES);
        const CUTS = [
            ...new Set(
                gradient.stops
                    .map((stop) => stop.offset)
                    .filter((offset) => offset > LOW + 1e-9 && offset < HIGH - 1e-9),
            ),
        ].sort((a, b) => a - b);
        const BOUNDARIES = [LOW, ...CUTS, HIGH];
        for (let band = 0; band + 1 < BOUNDARIES.length; band++) {
            const LOWER = BOUNDARIES[band],
                UPPER = BOUNDARIES[band + 1];
            if (UPPER - LOWER < 1e-9) {
                continue;
            }
            let polygon = clipGradientPolygon(POINTS, GRADIENT_T, LOWER, true);
            polygon = clipGradientPolygon(polygon, GRADIENT_T, UPPER, false);
            for (let corner = 1; corner + 1 < polygon.length; corner++) {
                for (const POINT of [polygon[0], polygon[corner], polygon[corner + 1]]) {
                    vertices.push(POINT.x, POINT.y, ...COLOR_AT(POINT), 0, 0, 0, 0, partIndex);
                }
            }
        }
    }
    GEOMETRY.dispose();
}
const CLAMP = (value, low, high) => Math.min(high, Math.max(low, value));
function seeded(seed, index, salt = 0) {
    let value = Math.imul((seed ^ salt) + index * 0x9e3779b9, 0x85ebca6b);
    value = Math.imul(value ^ (value >>> 13), 0xc2b2ae35);
    return ((value ^ (value >>> 16)) >>> 0) / 0x100000000;
}
const YARN_HASH = (value) => {
    const RESULT = Math.sin(value * 127.1 + 311.7) * 43758.5453;
    return RESULT - Math.floor(RESULT);
};
const YARN_RANDOM = (seed, index, salt) => YARN_HASH(seed * 57.13 + index * 113.71 + salt * 3.1);
function inRing(point, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const A = ring[i],
            B = ring[j];
        if (A.y > point.y !== B.y > point.y && point.x < ((B.x - A.x) * (point.y - A.y)) / (B.y - A.y) + A.x) {
            inside = !inside;
        }
    }
    return inside;
}
function shapeInfo(shape, includeClipMesh = false) {
    const EXTRACTED = shape.extractPoints(24),
        CONTOUR = EXTRACTED.shape;
    if (CONTOUR.length < 3) {
        throw new TypeError('Styled SVG fills need a closed contour');
    }
    const BOUNDS = shapeBounds([shape]);
    const INFO = {
        contour: CONTOUR,
        holes: EXTRACTED.holes,
        ...BOUNDS,
        width: BOUNDS.maxX - BOUNDS.minX,
        height: BOUNDS.maxY - BOUNDS.minY,
        center: {
            x: (BOUNDS.minX + BOUNDS.maxX) / 2,
            y: (BOUNDS.minY + BOUNDS.maxY) / 2,
        },
        contains(point) {
            return inRing(point, CONTOUR) && !EXTRACTED.holes.some((hole) => inRing(point, hole));
        },
    };
    if (includeClipMesh) {
        const GEOMETRY = new ShapeGeometry(shape, 24),
            POSITION = GEOMETRY.attributes.position,
            INDEX = GEOMETRY.index;
        const COUNT = INDEX ? INDEX.count : POSITION.count,
            CELL_SIZE = Math.max(4, Math.min(INFO.width, INFO.height) / 16);
        const TRIANGLES = [],
            CELLS = new Map();
        const CELL_KEY = (x, y) => `${x},${y}`;
        for (let at = 0; at + 2 < COUNT; at += 3) {
            const POINTS = [0, 1, 2].map((corner) => {
                const VERTEX = INDEX ? INDEX.getX(at + corner) : at + corner;
                return {
                    x: POSITION.getX(VERTEX),
                    y: POSITION.getY(VERTEX),
                };
            });
            const BOUNDS = {
                minX: Math.min(...POINTS.map((point) => point.x)),
                maxX: Math.max(...POINTS.map((point) => point.x)),
                minY: Math.min(...POINTS.map((point) => point.y)),
                maxY: Math.max(...POINTS.map((point) => point.y)),
            };
            const TRIANGLE = {
                    points: POINTS,
                    bounds: BOUNDS,
                },
                ID = TRIANGLES.push(TRIANGLE) - 1;
            const X0 = Math.floor((BOUNDS.minX - INFO.minX) / CELL_SIZE),
                X1 = Math.floor((BOUNDS.maxX - INFO.minX) / CELL_SIZE);
            const Y0 = Math.floor((BOUNDS.minY - INFO.minY) / CELL_SIZE),
                Y1 = Math.floor((BOUNDS.maxY - INFO.minY) / CELL_SIZE);
            for (let x = X0; x <= X1; x++) {
                for (let y = Y0; y <= Y1; y++) {
                    const KEY = CELL_KEY(x, y),
                        LIST = CELLS.get(KEY) ?? [];
                    LIST.push(ID);
                    CELLS.set(KEY, LIST);
                }
            }
        }
        GEOMETRY.dispose();
        INFO.clipMesh = {
            triangles: TRIANGLES,
            cells: CELLS,
            cellSize: CELL_SIZE,
            cellKey: CELL_KEY,
        };
    }
    return INFO;
}
function cross(a, b, c) {
    return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}
function triangleContains(triangle, point) {
    const [A, B, C] = triangle;
    const AB = cross(A, B, point),
        BC = cross(B, C, point),
        CA = cross(C, A, point);
    return (AB >= -1e-8 && BC >= -1e-8 && CA >= -1e-8) || (AB <= 1e-8 && BC <= 1e-8 && CA <= 1e-8);
}
function segmentIntersection(a, b, c, d) {
    const RX = b.x - a.x,
        RY = b.y - a.y,
        SX = d.x - c.x,
        SY = d.y - c.y;
    const DENOMINATOR = RX * SY - RY * SX;
    if (Math.abs(DENOMINATOR) < 1e-9) {
        return false;
    }
    const QX = c.x - a.x,
        QY = c.y - a.y;
    const T = (QX * SY - QY * SX) / DENOMINATOR,
        U = (QX * RY - QY * RX) / DENOMINATOR;
    return T > 1e-8 && T < 1 - 1e-8 && U >= -1e-8 && U <= 1 + 1e-8;
}
function triangleIsContained(points, info) {
    const CENTROID = {
        x: (points[0].x + points[1].x + points[2].x) / 3,
        y: (points[0].y + points[1].y + points[2].y) / 3,
    };
    if (!points.every((point) => info.contains(point)) || !info.contains(CENTROID)) {
        return false;
    }
    const RINGS = [info.contour, ...info.holes];
    for (const RING of RINGS) {
        for (let index = 0; index < RING.length; index++) {
            const A = RING[index],
                B = RING[(index + 1) % RING.length];
            if (triangleContains(points, A)) {
                return false;
            }
            for (let edge = 0; edge < 3; edge++) {
                if (segmentIntersection(points[edge], points[(edge + 1) % 3], A, B)) {
                    return false;
                }
            }
        }
    }
    return true;
}
function clipTriangleToTriangle(subject, clip) {
    let polygon = [...subject];
    const ORIENTATION = cross(clip[0], clip[1], clip[2]) >= 0 ? 1 : -1;
    for (let edge = 0; edge < 3 && polygon.length; edge++) {
        const A = clip[edge],
            B = clip[(edge + 1) % 3],
            INPUT = polygon;
        polygon = [];
        for (let index = 0; index < INPUT.length; index++) {
            const START = INPUT[index],
                END = INPUT[(index + 1) % INPUT.length];
            const START_SIDE = ORIENTATION * cross(A, B, START),
                END_SIDE = ORIENTATION * cross(A, B, END);
            const START_INSIDE = START_SIDE >= -1e-8,
                END_INSIDE = END_SIDE >= -1e-8;
            if (START_INSIDE) {
                polygon.push(START);
            }
            if (START_INSIDE !== END_INSIDE) {
                const AMOUNT = START_SIDE / (START_SIDE - END_SIDE);
                polygon.push({
                    x: START.x + (END.x - START.x) * AMOUNT,
                    y: START.y + (END.y - START.y) * AMOUNT,
                });
            }
        }
    }
    return polygon;
}
function emitClippedTriangle(vertices, points, rgba, partIndex, info, colorAt = null) {
    const EMIT = (point) => emitStyleVertex(vertices, point, colorAt ? colorAt(point) : rgba, partIndex);
    const TWICE_AREA = Math.abs(cross(points[0], points[1], points[2]));
    if (TWICE_AREA < 1e-8) {
        return;
    }
    if (triangleIsContained(points, info)) {
        for (const POINT of points) {
            EMIT(POINT);
        }
        return;
    }
    const { triangles: TRIANGLES, cells: CELLS, cellSize: CELL_SIZE, cellKey: CELL_KEY } = info.clipMesh;
    const BOUNDS = {
        minX: Math.min(...points.map((point) => point.x)),
        maxX: Math.max(...points.map((point) => point.x)),
        minY: Math.min(...points.map((point) => point.y)),
        maxY: Math.max(...points.map((point) => point.y)),
    };
    const CANDIDATES = new Set();
    const X0 = Math.floor((BOUNDS.minX - info.minX) / CELL_SIZE),
        X1 = Math.floor((BOUNDS.maxX - info.minX) / CELL_SIZE);
    const Y0 = Math.floor((BOUNDS.minY - info.minY) / CELL_SIZE),
        Y1 = Math.floor((BOUNDS.maxY - info.minY) / CELL_SIZE);
    for (let x = X0; x <= X1; x++) {
        for (let y = Y0; y <= Y1; y++) {
            for (const ID of CELLS.get(CELL_KEY(x, y)) ?? []) {
                CANDIDATES.add(ID);
            }
        }
    }
    for (const ID of CANDIDATES) {
        const CLIP = TRIANGLES[ID];
        if (
            CLIP.bounds.maxX < BOUNDS.minX ||
            CLIP.bounds.minX > BOUNDS.maxX ||
            CLIP.bounds.maxY < BOUNDS.minY ||
            CLIP.bounds.minY > BOUNDS.maxY
        ) {
            continue;
        }
        const POLYGON = clipTriangleToTriangle(points, CLIP.points);
        for (let corner = 1; corner + 1 < POLYGON.length; corner++) {
            if (Math.abs(cross(POLYGON[0], POLYGON[corner], POLYGON[corner + 1])) < 1e-8) {
                continue;
            }
            EMIT(POLYGON[0]);
            EMIT(POLYGON[corner]);
            EMIT(POLYGON[corner + 1]);
        }
    }
}
function appendYarnTriangle(vertices, points, rgba, partIndex, info, colorAt) {
    const EMIT = (triangle) => {
        if (info) {
            emitClippedTriangle(vertices, triangle, rgba, partIndex, info, colorAt);
        } else {
            for (const POINT of triangle) {
                emitStyleVertex(vertices, POINT, colorAt ? colorAt(POINT) : rgba, partIndex);
            }
        }
    };
    const GRADIENT_T = colorAt?.gradientT,
        STOPS = colorAt?.gradientStops;
    if (!GRADIENT_T || !STOPS?.length) {
        EMIT(points);
        return;
    }
    const VALUES = points.map(GRADIENT_T),
        LOW = Math.min(...VALUES),
        HIGH = Math.max(...VALUES);
    const CUTS = [...new Set(STOPS.filter((offset) => offset > LOW + 1e-9 && offset < HIGH - 1e-9))].sort(
        (a, b) => a - b,
    );
    if (!CUTS.length) {
        EMIT(points);
        return;
    }
    const BOUNDARIES = [LOW, ...CUTS, HIGH];
    for (let band = 0; band + 1 < BOUNDARIES.length; band++) {
        const LOWER = BOUNDARIES[band],
            UPPER = BOUNDARIES[band + 1];
        if (UPPER - LOWER < 1e-9) {
            continue;
        }
        let polygon = clipGradientPolygon(points, GRADIENT_T, LOWER, true);
        polygon = clipGradientPolygon(polygon, GRADIENT_T, UPPER, false);
        for (let corner = 1; corner + 1 < polygon.length; corner++) {
            if (Math.abs(cross(polygon[0], polygon[corner], polygon[corner + 1])) < 1e-8) {
                continue;
            }
            EMIT([polygon[0], polygon[corner], polygon[corner + 1]]);
        }
    }
}
function appendYarnStroke(vertices, points, width, rgba, partIndex, info = null, colorAt = null) {
    if (points.length < 2 || width <= 0) {
        return;
    }
    const TRIANGLE = (a, b, c) => {
        appendYarnTriangle(vertices, [a, b, c], rgba, partIndex, info, colorAt);
    };
    const RADIUS = width / 2,
        SEGMENTS = points.length - 1,
        NORMALS = [];
    for (let index = 0; index < SEGMENTS; index++) {
        const START = points[index],
            END = points[index + 1],
            DX = END.x - START.x,
            DY = END.y - START.y,
            LENGTH = Math.hypot(DX, DY);
        if (LENGTH < 1e-6) {
            NORMALS.push(null);
            continue;
        }
        const NX = (-DY / LENGTH) * RADIUS,
            NY = (DX / LENGTH) * RADIUS;
        NORMALS.push({
            x: NX,
            y: NY,
        });
        const A = {
                x: START.x + NX,
                y: START.y + NY,
            },
            B = {
                x: START.x - NX,
                y: START.y - NY,
            };
        const C = {
                x: END.x - NX,
                y: END.y - NY,
            },
            D = {
                x: END.x + NX,
                y: END.y + NY,
            };
        TRIANGLE(A, B, C);
        TRIANGLE(A, C, D);
    }
    for (let index = 1; index < points.length - 1; index++) {
        const BEFORE = NORMALS[index - 1],
            AFTER = NORMALS[index];
        if (!BEFORE || !AFTER) {
            continue;
        }
        const POINT = points[index];
        TRIANGLE(
            POINT,
            {
                x: POINT.x + BEFORE.x,
                y: POINT.y + BEFORE.y,
            },
            {
                x: POINT.x + AFTER.x,
                y: POINT.y + AFTER.y,
            },
        );
        TRIANGLE(
            POINT,
            {
                x: POINT.x - BEFORE.x,
                y: POINT.y - BEFORE.y,
            },
            {
                x: POINT.x - AFTER.x,
                y: POINT.y - AFTER.y,
            },
        );
    }
    const CAP = (center) => {
        const SLICES = 8;
        for (let index = 0; index < SLICES; index++) {
            const A = (index / SLICES) * Math.PI * 2,
                B = ((index + 1) / SLICES) * Math.PI * 2;
            TRIANGLE(
                center,
                {
                    x: center.x + Math.cos(A) * RADIUS,
                    y: center.y + Math.sin(A) * RADIUS,
                },
                {
                    x: center.x + Math.cos(B) * RADIUS,
                    y: center.y + Math.sin(B) * RADIUS,
                },
            );
        }
    };
    CAP(points[0]);
    CAP(points.at(-1));
}
function quadPoints(start, end, width) {
    const DX = end.x - start.x,
        DY = end.y - start.y,
        LENGTH = Math.hypot(DX, DY) || 1;
    const NX = ((-DY / LENGTH) * width) / 2,
        NY = ((DX / LENGTH) * width) / 2;
    return [
        {
            x: start.x + NX,
            y: start.y + NY,
        },
        {
            x: start.x - NX,
            y: start.y - NY,
        },
        {
            x: end.x - NX,
            y: end.y - NY,
        },
        {
            x: start.x + NX,
            y: start.y + NY,
        },
        {
            x: end.x - NX,
            y: end.y - NY,
        },
        {
            x: end.x + NX,
            y: end.y + NY,
        },
    ];
}
function emitStyleVertex(vertices, point, rgba, partIndex, delta0 = [0, 0], delta1 = [0, 0]) {
    vertices.push(point.x, point.y, ...rgba, ...delta0, ...delta1, partIndex);
}
function appendStyleSegment(vertices, start, end, width, rgba, partIndex, morphTargets = null) {
    if (Math.hypot(end.x - start.x, end.y - start.y) < 1e-5) {
        return;
    }
    const BASE = quadPoints(start, end, width);
    if (!morphTargets) {
        for (const POINT of BASE) {
            emitStyleVertex(vertices, POINT, rgba, partIndex);
        }
        return;
    }
    const TARGET_QUADS = morphTargets.map((target) => quadPoints(target[0], target[1], width));
    for (let index = 0; index < BASE.length; index++) {
        const POINT = BASE[index],
            FIRST = TARGET_QUADS[0][index],
            SECOND = TARGET_QUADS[1][index];
        emitStyleVertex(
            vertices,
            POINT,
            rgba,
            partIndex,
            [FIRST.x - POINT.x, FIRST.y - POINT.y],
            [SECOND.x - POINT.x, SECOND.y - POINT.y],
        );
    }
}
function appendClippedPolyline(vertices, points, closed, width, rgba, partIndex, info) {
    const SEGMENT_COUNT = closed ? points.length : points.length - 1;
    for (let index = 0; index < SEGMENT_COUNT; index++) {
        const START = points[index],
            END = points[(index + 1) % points.length];
        const LENGTH = Math.hypot(END.x - START.x, END.y - START.y);
        const PIECES = Math.max(1, Math.min(8, Math.ceil(LENGTH / Math.max(width * 4, 2))));
        for (let piece = 0; piece < PIECES; piece++) {
            const T0 = piece / PIECES,
                T1 = (piece + 1) / PIECES,
                MIDDLE = (T0 + T1) / 2;
            const SAMPLE = {
                x: START.x + (END.x - START.x) * MIDDLE,
                y: START.y + (END.y - START.y) * MIDDLE,
            };
            if (!info.contains(SAMPLE)) {
                continue;
            }
            appendStyleSegment(
                vertices,
                {
                    x: START.x + (END.x - START.x) * T0,
                    y: START.y + (END.y - START.y) * T0,
                },
                {
                    x: START.x + (END.x - START.x) * T1,
                    y: START.y + (END.y - START.y) * T1,
                },
                width,
                rgba,
                partIndex,
            );
        }
    }
}
function colorScale(color, factor, alpha) {
    return colorComponents(color.clone().multiplyScalar(factor), alpha);
}
function curveMetric(points, closed = true) {
    const LENGTHS = [0],
        SEGMENT_COUNT = closed ? points.length : points.length - 1;
    let area = 0;
    for (let index = 0; index < SEGMENT_COUNT; index++) {
        const A = points[index],
            B = points[(index + 1) % points.length];
        LENGTHS.push(LENGTHS[index] + Math.hypot(B.x - A.x, B.y - A.y));
        area += A.x * B.y - B.x * A.y;
    }
    const LENGTH = LENGTHS[SEGMENT_COUNT] || 1e-5,
        SIGN = closed && area < 0 ? -1 : 1;
    return {
        length: LENGTH,
        at(amount) {
            const DISTANCE = (closed ? ((amount % 1) + 1) % 1 : CLAMP(amount, 0, 1)) * LENGTH;
            let low = 0;
            let high = SEGMENT_COUNT - 1;
            while (low < high) {
                const MIDDLE = (low + high) >> 1;
                if (LENGTHS[MIDDLE + 1] < DISTANCE) {
                    low = MIDDLE + 1;
                } else {
                    high = MIDDLE;
                }
            }
            const A = points[low],
                B = points[(low + 1) % points.length],
                SEGMENT_LENGTH = LENGTHS[low + 1] - LENGTHS[low] || 1;
            const T = CLAMP((DISTANCE - LENGTHS[low]) / SEGMENT_LENGTH, 0, 1),
                TX = (B.x - A.x) / SEGMENT_LENGTH,
                TY = (B.y - A.y) / SEGMENT_LENGTH;
            return {
                x: A.x + (B.x - A.x) * T,
                y: A.y + (B.y - A.y) * T,
                tx: TX,
                ty: TY,
                nx: SIGN * TY,
                ny: -SIGN * TX,
            };
        },
    };
}
function quadraticPoints(start, control, end, divisions = 8) {
    return Array.from(
        {
            length: divisions + 1,
        },
        (_, index) => {
            const T = index / divisions,
                INVERSE = 1 - T;
            return {
                x: INVERSE * INVERSE * start.x + 2 * INVERSE * T * control.x + T * T * end.x,
                y: INVERSE * INVERSE * start.y + 2 * INVERSE * T * control.y + T * T * end.y,
            };
        },
    );
}
function cubicPoints(start, first, second, end, divisions = 8) {
    return Array.from(
        {
            length: divisions + 1,
        },
        (_, index) => {
            const T = index / divisions,
                INVERSE = 1 - T;
            return {
                x:
                    INVERSE ** 3 * start.x +
                    3 * INVERSE ** 2 * T * first.x +
                    3 * INVERSE * T ** 2 * second.x +
                    T ** 3 * end.x,
                y:
                    INVERSE ** 3 * start.y +
                    3 * INVERSE ** 2 * T * first.y +
                    3 * INVERSE * T ** 2 * second.y +
                    T ** 3 * end.y,
            };
        },
    );
}
function roundedOutline(points, holes) {
    const SHAPE = new Shape(),
        MIDDLE = (a, b) => ({
            x: (a.x + b.x) / 2,
            y: (a.y + b.y) / 2,
        });
    const FIRST = MIDDLE(points.at(-1), points[0]);
    SHAPE.moveTo(FIRST.x, FIRST.y);
    for (let index = 0; index < points.length; index++) {
        const POINT = points[index],
            NEXT = points[(index + 1) % points.length],
            END = MIDDLE(POINT, NEXT);
        SHAPE.quadraticCurveTo(POINT.x, POINT.y, END.x, END.y);
    }
    SHAPE.closePath();
    for (const RING of holes) {
        const HOLE = new Path();
        HOLE.moveTo(RING[0].x, RING[0].y);
        for (const POINT of RING.slice(1)) {
            HOLE.lineTo(POINT.x, POINT.y);
        }
        HOLE.closePath();
        SHAPE.holes.push(HOLE);
    }
    return SHAPE;
}
function yarnTint(color, amount, opacity) {
    const TARGET = amount > 0 ? 1 : 0,
        WEIGHT = Math.abs(amount);
    return [
        color[0] + (TARGET - color[0]) * WEIGHT,
        color[1] + (TARGET - color[1]) * WEIGHT,
        color[2] + (TARGET - color[2]) * WEIGHT,
        color[3] * opacity,
    ];
}
function compileYarnStyle(
    vertices,
    style,
    shape,
    fillColor,
    opacity,
    partIndex,
    gradient,
    gradientBounds,
    transform,
    curveSegments,
) {
    const INFO = shapeInfo(shape, true),
        SOURCE_METRIC = curveMetric(INFO.contour);
    const LOBES = Math.max(8, Math.round(SOURCE_METRIC.length / style.edgeSpacing));
    const AMOUNT = style.detail ? 0.3 : 1;
    const RELIEF = Math.min(style.edgeRelief, Math.min(INFO.width, INFO.height) * 0.115) * AMOUNT;
    const SCALLOPS = [];
    for (let index = 0; index < LOBES * 5; index++) {
        const U = index / (LOBES * 5),
            POINT = SOURCE_METRIC.at(U);
        const DISPLACEMENT =
            RELIEF *
            (Math.sin(Math.PI * U * LOBES) ** 2 * 0.85 + 0.18 * Math.sin(U * Math.PI * 4 + style.seed) + 0.1) *
            (0.8 + 0.2 * Math.sin(U * Math.PI * 6 + style.seed * 0.7));
        SCALLOPS.push({
            x: POINT.x + POINT.nx * DISPLACEMENT,
            y: POINT.y + POINT.ny * DISPLACEMENT,
        });
    }
    const OUTLINE = roundedOutline(SCALLOPS, INFO.holes);
    const BASE_COLOR = gradient ? gradientColorAtT(gradient, 0.53) : colorComponents(fillColor, 1);
    const DARK = yarnTint(BASE_COLOR, -0.28, opacity),
        GROOVE = yarnTint(BASE_COLOR, -style.contrast, opacity * 0.85);
    const YARN = yarnTint(BASE_COLOR, 0.1, opacity),
        LIGHT = yarnTint(BASE_COLOR, 0.38, opacity);
    const GRADIENT_T = gradient
        ? (() => {
              const [START, END] = gradientEndpoints(gradient, gradientBounds, transform);
              const DX = END.x - START.x,
                  DY = END.y - START.y,
                  DENOMINATOR = DX * DX + DY * DY;
              return (point) => ((point.x - START.x) * DX + (point.y - START.y) * DY) / DENOMINATOR;
          })()
        : null;
    const YARN_COLOR = (tint, alpha = 1) => {
        if (!gradient) {
            return null;
        }
        const SAMPLER = (point) => yarnTint(gradientColorAtT(gradient, GRADIENT_T(point)), tint, opacity * alpha);
        SAMPLER.gradientT = GRADIENT_T;
        SAMPLER.gradientStops = gradient.stops.map((stop) => stop.offset);
        return SAMPLER;
    };
    const EDGE_DARK_COLOR = YARN_COLOR(-0.28, 0.7),
        EDGE_MAIN_COLOR = YARN_COLOR(0.1),
        EDGE_LIGHT_COLOR = YARN_COLOR(0.38, 0.55);
    const UNDER_COLOR = YARN_COLOR(-0.28, 0.5),
        GROOVE_COLOR = YARN_COLOR(-style.contrast, 0.85);
    const STITCH_COLOR = YARN_COLOR(0.1),
        STITCH_LIGHT_COLOR = YARN_COLOR(0.38, 0.57),
        CROSS_LIGHT_COLOR = YARN_COLOR(0.38, 0.5);
    const FIBER_COLOR = YARN_COLOR(0.22, style.fiberOpacity),
        FIBER_LIGHT_COLOR = YARN_COLOR(0.38, style.fiberOpacity * 0.7);
    if (gradient) {
        appendGradientShape(vertices, OUTLINE, gradient, gradientBounds, transform, opacity, partIndex, curveSegments);
    } else {
        const FILL = new ShapeGeometry(OUTLINE, curveSegments);
        appendTriangles(vertices, FILL, yarnTint(BASE_COLOR, 0, opacity), partIndex);
        FILL.dispose();
    }
    const EDGE = curveMetric(SCALLOPS),
        EDGE_WIDTH = style.edgeWidth;
    for (let index = 0; index < LOBES; index++) {
        const A0 = EDGE.at((index + 0.12) / LOBES),
            B0 = EDGE.at((index + 0.85) / LOBES),
            MIDDLE = EDGE.at((index + 0.5) / LOBES);
        const DEPTH = EDGE_WIDTH * 0.62 * AMOUNT;
        const START = {
            x: A0.x - A0.nx * DEPTH,
            y: A0.y - A0.ny * DEPTH,
        };
        const CONTROL = {
            x: MIDDLE.x + MIDDLE.nx * DEPTH * 0.38,
            y: MIDDLE.y + MIDDLE.ny * DEPTH * 0.38,
        };
        const END = {
            x: B0.x - B0.nx * DEPTH,
            y: B0.y - B0.ny * DEPTH,
        };
        const LOOP = quadraticPoints(START, CONTROL, END, 6);
        appendYarnStroke(vertices, LOOP, EDGE_WIDTH * 0.8, yarnTint(DARK, 0, 0.7), partIndex, null, EDGE_DARK_COLOR);
        appendYarnStroke(vertices, LOOP, EDGE_WIDTH * 0.56, YARN, partIndex, null, EDGE_MAIN_COLOR);
        appendYarnStroke(
            vertices,
            LOOP.map((point) => ({
                x: point.x - EDGE_WIDTH * 0.1,
                y: point.y - EDGE_WIDTH * 0.09,
            })),
            EDGE_WIDTH * 0.17,
            yarnTint(LIGHT, 0, 0.55),
            partIndex,
            null,
            EDGE_LIGHT_COLOR,
        );
    }
    if (style.pattern !== false) {
        const CURVED = style.curved !== false,
            STITCH_WIDTH = style.stitchWidth,
            STITCH_HEIGHT = style.stitchHeight;
        const COLUMNS = Math.min(128, Math.max(2, Math.ceil(INFO.width / STITCH_WIDTH)));
        const ROWS = Math.min(128, Math.max(2, Math.ceil(INFO.height / STITCH_HEIGHT)));
        if (ROWS * COLUMNS > 16384) {
            throw new RangeError('Yarn style tessellation exceeds the 16,384 stitch limit');
        }
        const SX = INFO.width / COLUMNS,
            SY = INFO.height / ROWS,
            RX = INFO.width / 2,
            RY = INFO.height / 2;
        const STROKE_WIDTH = Math.min(SX, SY) * (style.thickness / STITCH_HEIGHT);
        const MAP_POINT = (x, y, ox = 0, oy = 0) => {
            x += ox;
            y += oy;
            const NX = x / RX,
                NY = y / RY;
            return {
                x: INFO.center.x + (CURVED ? (Math.sin(CLAMP(NX, -1.35, 1.35) * 1.1) / Math.sin(1.1)) * RX : x),
                y: INFO.center.y + y + (CURVED ? RY * 0.13 * NX * NX * (1 - NY * 0.24) : 0),
            };
        };
        const DRAW_CELL_CURVE = (x, y, ax, ay, data, rgba, width, offsetX = 0, offsetY = 0, colorAt = null) => {
            const POINTS = cubicPoints(
                {
                    x: x + ax * data[0],
                    y: y + ay * data[1],
                },
                {
                    x: x + ax * data[2],
                    y: y + ay * data[3],
                },
                {
                    x: x + ax * data[4],
                    y: y + ay * data[5],
                },
                {
                    x: x + ax * data[6],
                    y: y + ay * data[7],
                },
                5,
            ).map((point) => MAP_POINT(point.x, point.y, offsetX, offsetY));
            appendYarnStroke(vertices, POINTS, width, rgba, partIndex, INFO, colorAt);
        };
        let stitchCount = 0;
        for (let row = -1; row <= ROWS + 1; row++) {
            for (let column = -1; column <= COLUMNS + 1; column++) {
                const JITTER = style.irregularity,
                    X =
                        -RX +
                        (column + 0.5) * SX +
                        (YARN_RANDOM(style.seed, row * COLUMNS + column, 71) - 0.5) * SX * JITTER;
                const Y =
                    -RY + (row + 0.5) * SY + (YARN_RANDOM(style.seed, row * COLUMNS + column, 39) - 0.5) * SY * JITTER;
                const AX = SX * (1 + (YARN_RANDOM(style.seed, row * COLUMNS + column, 57) - 0.5) * JITTER);
                const AY = SY * (1 + (YARN_RANDOM(style.seed, row * COLUMNS + column, 91) - 0.5) * JITTER);
                const UNDER = [-0.48, -0.46, -0.22, -0.57, 0.22, -0.57, 0.48, -0.46];
                const LEFT_LOOP = [-0.34, -0.36, -0.32, -0.06, -0.18, 0.17, -0.025, 0.34];
                const RIGHT_LOOP = [0.34, -0.36, 0.32, -0.06, 0.18, 0.17, 0.025, 0.34];
                DRAW_CELL_CURVE(
                    X,
                    Y,
                    AX,
                    AY,
                    UNDER,
                    yarnTint(DARK, 0, 0.5),
                    STROKE_WIDTH * 0.5,
                    0,
                    STROKE_WIDTH * 0.06,
                    UNDER_COLOR,
                );
                for (const LOOP of [LEFT_LOOP, RIGHT_LOOP]) {
                    DRAW_CELL_CURVE(
                        X,
                        Y,
                        AX,
                        AY,
                        LOOP,
                        GROOVE,
                        STROKE_WIDTH * 1.08,
                        0,
                        STROKE_WIDTH * 0.06,
                        GROOVE_COLOR,
                    );
                }
                for (const LOOP of [LEFT_LOOP, RIGHT_LOOP]) {
                    DRAW_CELL_CURVE(X, Y, AX, AY, LOOP, YARN, STROKE_WIDTH * 0.89, 0, 0, STITCH_COLOR);
                }
                for (const LOOP of [LEFT_LOOP, RIGHT_LOOP]) {
                    DRAW_CELL_CURVE(
                        X,
                        Y,
                        AX,
                        AY,
                        LOOP,
                        yarnTint(LIGHT, 0, 0.57),
                        STROKE_WIDTH * 0.34,
                        -STROKE_WIDTH * 0.14,
                        -STROKE_WIDTH * 0.13,
                        STITCH_LIGHT_COLOR,
                    );
                }
                if ((row + column) % 2 === 0) {
                    DRAW_CELL_CURVE(
                        X,
                        Y,
                        AX,
                        AY,
                        [-0.32, -0.12, -0.27, -0.13, -0.2, -0.15, -0.16, -0.13],
                        yarnTint(LIGHT, 0, 0.5),
                        STROKE_WIDTH * 0.075,
                        0,
                        0,
                        CROSS_LIGHT_COLOR,
                    );
                    DRAW_CELL_CURVE(
                        X,
                        Y,
                        AX,
                        AY,
                        [0.22, 0.18, 0.28, 0.14, 0.33, 0.11, 0.37, 0.08],
                        yarnTint(LIGHT, 0, 0.5),
                        STROKE_WIDTH * 0.075,
                        0,
                        0,
                        CROSS_LIGHT_COLOR,
                    );
                }
                if (++stitchCount > 16384) {
                    throw new RangeError('Yarn style tessellation exceeds the 16,384 stitch limit');
                }
            }
        }
    }
    if (style.fiber !== false) {
        const FIBER_COUNT = Math.min(style.fiberMax, Math.round(EDGE.length / (style.fiberSpacing ?? 4)));
        for (let index = 0; index < FIBER_COUNT; index++) {
            const AT = EDGE.at((index + 0.22 + YARN_RANDOM(style.seed, index, 22) * 0.48) / FIBER_COUNT);
            const LENGTH =
                Math.min(style.fiberLength, (Math.min(INFO.width, INFO.height) / 2) * 0.24) *
                (0.45 + YARN_RANDOM(style.seed, index, 5) * 0.95);
            const LEAN = (YARN_RANDOM(style.seed, index, 14) - 0.5) * LENGTH * 1.5;
            const START = {
                x: AT.x - AT.nx * 0.008,
                y: AT.y - AT.ny * 0.008,
            };
            const CONTROL = {
                x: AT.x + AT.nx * LENGTH * 0.64 + AT.tx * LEAN,
                y: AT.y + AT.ny * LENGTH * 0.64 + AT.ty * LEAN,
            };
            const END = {
                x: AT.x + AT.nx * LENGTH + AT.tx * LEAN * 0.48,
                y: AT.y + AT.ny * LENGTH + AT.ty * LEAN * 0.48,
            };
            appendYarnStroke(
                vertices,
                quadraticPoints(START, CONTROL, END, 3),
                style.fiberWidth,
                yarnTint(BASE_COLOR, 0.22, opacity * style.fiberOpacity),
                partIndex,
                null,
                FIBER_COLOR,
            );
            const TIP_START = {
                x: AT.x + AT.nx * LENGTH * 0.48 + AT.tx * LEAN * 0.25,
                y: AT.y + AT.ny * LENGTH * 0.48 + AT.ty * LEAN * 0.25,
            };
            appendYarnStroke(
                vertices,
                [TIP_START, END],
                style.fiberWidth * 0.4,
                yarnTint(LIGHT, 0, opacity * style.fiberOpacity * 0.7),
                partIndex,
                null,
                FIBER_LIGHT_COLOR,
            );
        }
    }
}
function resampleClosed(points, count) {
    const SAMPLES = [];
    let total = 0;
    const LENGTHS = [];
    for (let i = 0; i < points.length; i++) {
        const LENGTH = Math.hypot(
            points[(i + 1) % points.length].x - points[i].x,
            points[(i + 1) % points.length].y - points[i].y,
        );
        LENGTHS.push(LENGTH);
        total += LENGTH;
    }
    for (let sample = 0; sample < count; sample++) {
        let distance = (total * sample) / count;
        let index = 0;
        while (index < LENGTHS.length - 1 && distance > LENGTHS[index]) {
            distance -= LENGTHS[index++];
        }
        const A = points[index],
            B = points[(index + 1) % points.length],
            AMOUNT = LENGTHS[index] ? distance / LENGTHS[index] : 0;
        SAMPLES.push({
            x: A.x + (B.x - A.x) * AMOUNT,
            y: A.y + (B.y - A.y) * AMOUNT,
        });
    }
    return SAMPLES;
}
function sketchContour(info, style, phase) {
    const SOURCE = resampleClosed(info.contour, 96);
    return SOURCE.map((point, index) => {
        const AMOUNT = (seeded(style.seed, index, 0x70 + phase * 0x100) - 0.5) * 2 * style.amplitude;
        const DX = point.x - info.center.x,
            DY = point.y - info.center.y,
            LENGTH = Math.hypot(DX, DY) || 1;
        const WAVE = Math.sin((index / SOURCE.length) * Math.PI * 2 * style.frequency + phase * 2.0943951);
        const OFFSET = AMOUNT * (0.55 + WAVE * 0.45);
        return {
            x: point.x + (DX / LENGTH) * OFFSET,
            y: point.y + (DY / LENGTH) * OFFSET,
        };
    });
}
function compileSketchStyle(vertices, style, shape, fillColor, opacity, partIndex) {
    const INFO = shapeInfo(shape),
        BASE = sketchContour(INFO, style, 0),
        FIRST = sketchContour(INFO, style, 1),
        SECOND = sketchContour(INFO, style, 2);
    const ECHO = colorScale(fillColor, 0.48, opacity * style.echoOpacity),
        INK = colorScale(fillColor, 0.36, opacity * 0.94);
    const ECHO_POINTS = BASE.map((point) => ({
        x: point.x + style.echoX,
        y: point.y + style.echoY,
    }));
    appendClippedPolyline(vertices, ECHO_POINTS, true, style.echoWidth, ECHO, partIndex, INFO);
    for (let index = 0; index < BASE.length; index++) {
        const NEXT = (index + 1) % BASE.length;
        appendStyleSegment(vertices, BASE[index], BASE[NEXT], style.hatchWidth, INK, partIndex, [
            [FIRST[index], FIRST[NEXT]],
            [SECOND[index], SECOND[NEXT]],
        ]);
    }
    const SPAN = Math.hypot(INFO.maxX - INFO.minX, INFO.maxY - INFO.minY),
        DIRECTION = style.hatchAngle;
    const STEPS = Math.min(256, Math.ceil(SPAN / style.hatchSpacing));
    for (let index = -STEPS; index <= STEPS; index++) {
        const OFFSET = index * style.hatchSpacing;
        const START = {
            x: INFO.center.x - Math.cos(DIRECTION) * SPAN + -Math.sin(DIRECTION) * OFFSET,
            y: INFO.center.y - Math.sin(DIRECTION) * SPAN + Math.cos(DIRECTION) * OFFSET,
        };
        const END = {
            x: INFO.center.x + Math.cos(DIRECTION) * SPAN + -Math.sin(DIRECTION) * OFFSET,
            y: INFO.center.y + Math.sin(DIRECTION) * SPAN + Math.cos(DIRECTION) * OFFSET,
        };
        appendClippedPolyline(
            vertices,
            [START, END],
            false,
            style.hatchWidth,
            colorScale(fillColor, 0.48, opacity * style.hatchOpacity),
            partIndex,
            INFO,
        );
    }
}
function compileShaderSurface(
    style,
    shape,
    fillColor,
    opacity,
    partIndex,
    gradient,
    gradientBounds,
    transform,
    curveSegments,
) {
    const EXTRACTED = shape.extractPoints(curveSegments);
    if (EXTRACTED.shape.length < 3 || EXTRACTED.holes.length) {
        throw new TypeError(
            'Shader-backed SVG yarn/sketch surfaces currently require one closed contour without holes: ' +
                style.target,
        );
    }
    const GEOMETRY = new ShapeGeometry(shape, curveSegments),
        POSITION = GEOMETRY.attributes.position,
        INDEX = GEOMETRY.index;
    const COUNT = INDEX ? INDEX.count : POSITION.count,
        FILL = new Float32Array(COUNT * 6);
    const COLOR_AT = (point) => {
        const RGBA = gradient
            ? gradientAtPoint(gradient, point, gradientBounds, transform)
            : colorComponents(fillColor, 1);
        RGBA[3] *= opacity;
        return RGBA;
    };
    let write = 0;
    for (let at = 0; at + 2 < COUNT; at += 3) {
        for (let corner = 0; corner < 3; corner++) {
            const VERTEX = INDEX ? INDEX.getX(at + corner) : at + corner;
            const POINT = {
                x: POSITION.getX(VERTEX),
                y: POSITION.getY(VERTEX),
            };
            FILL[write++] = POINT.x;
            FILL[write++] = POINT.y;
            FILL.set(COLOR_AT(POINT), write);
            write += 4;
        }
    }
    GEOMETRY.dispose();
    const OUTLINE = new Float32Array(EXTRACTED.shape.length * 2),
        EDGE_COLORS = new Float32Array(EXTRACTED.shape.length * 4);
    for (let point = 0; point < EXTRACTED.shape.length; point++) {
        const CURRENT = EXTRACTED.shape[point];
        OUTLINE[point * 2] = CURRENT.x;
        OUTLINE[point * 2 + 1] = CURRENT.y;
        EDGE_COLORS.set(COLOR_AT(CURRENT), point * 4);
    }
    return {
        target: style.target,
        partIndex,
        fillVertices: FILL,
        outline: OUTLINE,
        edgeColors: EDGE_COLORS,
        style: {
            ...style,
        },
    };
}
function appendOrderedMeshRange(drawOrder, firstIndex, indexCount, partIndex) {
    if (!indexCount) {
        return;
    }
    const PREVIOUS = drawOrder.at(-1);
    if (
        PREVIOUS?.kind === 'mesh' &&
        PREVIOUS.partIndex === partIndex &&
        PREVIOUS.firstIndex + PREVIOUS.indexCount === firstIndex
    ) {
        PREVIOUS.indexCount += indexCount;
    } else {
        drawOrder.push({
            kind: 'mesh',
            firstIndex,
            indexCount,
            partIndex,
        });
    }
}
function ownerPart(node, partIndices) {
    for (let current = node; current; current = current.parentNode) {
        if (current.nodeType !== 1) {
            continue;
        }
        const ID = current.getAttribute('id');
        if (ID && partIndices.has(ID)) {
            return partIndices.get(ID);
        }
    }
    throw new TypeError('Every painted SVG element must be inside an authored part group');
}
function resolveGradientPaint(paint, gradients) {
    const MATCH = /^url\(\s*#([A-Za-z_][A-Za-z0-9_.:-]{0,127})\s*\)$/.exec(paint ?? '');
    if (!MATCH) {
        return null;
    }
    const GRADIENT = gradients.get(MATCH[1]);
    if (!GRADIENT) {
        throw new TypeError('SVG fill references an unknown linearGradient: ' + MATCH[1]);
    }
    return GRADIENT;
}
function colorFromComponents(rgba) {
    return new Color().setRGB(rgba[0], rgba[1], rgba[2], SRGBColorSpace);
}
function appendNonScalingLine(vertices, start, end, rgba, partIndex, width, lineCap, arcDivisions) {
    if (!['butt', 'square', 'round'].includes(lineCap)) {
        throw new TypeError('Unsupported non-scaling stroke linecap: ' + lineCap);
    }
    const DX = end.x - start.x,
        DY = end.y - start.y;
    const LENGTH = Math.hypot(DX, DY);
    if (LENGTH < 1e-9) {
        throw new TypeError('Zero-length non-scaling <line> elements are not supported');
    }
    const TANGENT_X = DX / LENGTH,
        TANGENT_Y = DY / LENGTH,
        HALF = width * 0.5;
    const PUSH = (along, radialAlong, radialSide) => {
        const POINT = along === 0 ? start : end;
        vertices.push(
            POINT.x,
            POINT.y,
            ...rgba,
            TANGENT_X,
            TANGENT_Y,
            radialAlong * HALF,
            radialSide * HALF,
            partIndex,
        );
    };
    const TRIANGLE = (a, b, c) => {
        for (const V of [a, b, c]) {
            PUSH(...V);
        }
    };
    const START_EXTENSION = lineCap === 'square' ? -1 : 0,
        END_EXTENSION = lineCap === 'square' ? 1 : 0;
    TRIANGLE([0, START_EXTENSION, 1], [1, END_EXTENSION, 1], [1, END_EXTENSION, -1]);
    TRIANGLE([0, START_EXTENSION, 1], [1, END_EXTENSION, -1], [0, START_EXTENSION, -1]);
    if (lineCap === 'round') {
        for (const [ALONG, FIRST_ANGLE] of [
            [0, Math.PI / 2],
            [1, -Math.PI / 2],
        ]) {
            for (let i = 0; i < arcDivisions; i++) {
                const A = FIRST_ANGLE + (i * Math.PI) / arcDivisions,
                    B = FIRST_ANGLE + ((i + 1) * Math.PI) / arcDivisions;
                TRIANGLE([ALONG, 0, 0], [ALONG, Math.cos(A), Math.sin(A)], [ALONG, Math.cos(B), Math.sin(B)]);
            }
        }
    }
}
function compilePaths(paths, partIndices, _parts, metadata, gradients, curveSegments, strokeArcDivisions) {
    const VERTICES = [],
        SHADER_SURFACES = [],
        DRAW_ORDER = [],
        REGION_NAMES = [];
    let expandedRegions = null;
    let hasNonScalingStroke = false;
    const STYLED = new Map((metadata.styles ?? []).map((style) => [style.target, style]));
    const SHADER_ORDERED = metadata.styles?.some((style) => style.backend === 'shader') ?? false;
    const MORPH_COUNT = metadata.styles?.some((style) => style.kind === 'sketch' && style.backend !== 'shader') ? 2 : 0;
    for (const PATH of paths) {
        const SOURCE_NODE = PATH.userData?.node;
        if (!SOURCE_NODE?.getAttribute?.('id')) {
            throw new TypeError('Every painted SVG shape must keep its DOM id');
        }
        const PART_INDEX = ownerPart(SOURCE_NODE, partIndices);
        const STYLE = PATH.userData.style;
        const OVERALL_OPACITY = STYLE.opacity ?? 1;
        const AUTHORED_STYLE = STYLED.get(SOURCE_NODE.getAttribute('id'));
        if (AUTHORED_STYLE && (STYLE.fill === undefined || STYLE.fill === 'none')) {
            throw new TypeError('Authored yarn/sketch styles require an SVG fill: ' + AUTHORED_STYLE.target);
        }
        const FILL_GRADIENT =
            STYLE.fill !== undefined && STYLE.fill !== 'none' ? resolveGradientPaint(STYLE.fill, gradients) : null;
        const FILL_OPACITY = (STYLE.fillOpacity ?? 1) * OVERALL_OPACITY;
        const SHAPES = STYLE.fill !== undefined && STYLE.fill !== 'none' ? PATH.toShapes() : [];
        const GRADIENT_BOUNDS =
            FILL_GRADIENT && SHAPES.length
                ? shapeBounds(SHAPES, FILL_GRADIENT.units === 'objectBoundingBox' ? PATH.userData.transform : null)
                : null;
        const STYLE_COLOR = FILL_GRADIENT ? colorFromComponents(gradientColorAtT(FILL_GRADIENT, 0.53)) : PATH.color;
        const MESH_FIRST = VERTICES.length / 11;
        const REGION = svgPaintRegion(SOURCE_NODE);
        let regionIndex = 0;
        if (REGION !== null) {
            if (AUTHORED_STYLE || FILL_GRADIENT || !SHAPES.length || !SOURCE_NODE.getAttribute('fill')) {
                throw new TypeError('Paint regions require an unstyled solid fill: ' + REGION);
            }
            if (!REGION_NAMES.includes(REGION)) {
                REGION_NAMES.push(REGION);
                if (REGION_NAMES.length > MAX_PAINT_REGIONS) {
                    throw new RangeError('An SVG supports at most eight paint regions');
                }
            }
            regionIndex = REGION_NAMES.indexOf(REGION) + 1;
            expandedRegions ??= new Array(MESH_FIRST).fill(0);
        }
        if (AUTHORED_STYLE?.backend === 'shader') {
            if (SHAPES.length !== 1) {
                throw new TypeError(
                    'Shader-backed yarn/sketch style requires one connected filled shape: ' + AUTHORED_STYLE.target,
                );
            }
            if (FILL_OPACITY > 0) {
                const SURFACE_INDEX =
                    SHADER_SURFACES.push(
                        compileShaderSurface(
                            AUTHORED_STYLE,
                            SHAPES[0],
                            PATH.color,
                            FILL_OPACITY,
                            PART_INDEX,
                            FILL_GRADIENT,
                            GRADIENT_BOUNDS,
                            PATH.userData.transform,
                            curveSegments,
                        ),
                    ) - 1;
                DRAW_ORDER.push({
                    kind: 'surface',
                    surfaceIndex: SURFACE_INDEX,
                });
            }
        } else if (AUTHORED_STYLE?.kind === 'yarn') {
            if (SHAPES.length !== 1) {
                throw new TypeError(
                    'Authored yarn style currently requires one connected filled shape: ' + AUTHORED_STYLE.target,
                );
            }
            if (FILL_OPACITY > 0) {
                compileYarnStyle(
                    VERTICES,
                    AUTHORED_STYLE,
                    SHAPES[0],
                    PATH.color,
                    FILL_OPACITY,
                    PART_INDEX,
                    FILL_GRADIENT,
                    GRADIENT_BOUNDS,
                    PATH.userData.transform,
                    curveSegments,
                );
            }
        } else {
            if (FILL_OPACITY > 0) {
                for (const SHAPE of SHAPES) {
                    if (FILL_GRADIENT) {
                        appendGradientShape(
                            VERTICES,
                            SHAPE,
                            FILL_GRADIENT,
                            GRADIENT_BOUNDS,
                            PATH.userData.transform,
                            FILL_OPACITY,
                            PART_INDEX,
                            curveSegments,
                        );
                    } else {
                        const GEOMETRY = new ShapeGeometry(SHAPE, curveSegments);
                        appendTriangles(VERTICES, GEOMETRY, colorComponents(PATH.color, FILL_OPACITY), PART_INDEX);
                        GEOMETRY.dispose();
                    }
                }
            }
            if (AUTHORED_STYLE) {
                if (SHAPES.length !== 1) {
                    throw new TypeError(
                        'Authored sketch style currently requires one connected filled shape: ' + AUTHORED_STYLE.target,
                    );
                }
                if (FILL_OPACITY > 0) {
                    compileSketchStyle(VERTICES, AUTHORED_STYLE, SHAPES[0], STYLE_COLOR, FILL_OPACITY, PART_INDEX);
                }
            }
        }
        const FILL_END = VERTICES.length / 11;
        if (STYLE.stroke !== undefined && STYLE.stroke !== 'none' && STYLE.strokeWidth > 0) {
            const OPACITY = (STYLE.strokeOpacity ?? 1) * OVERALL_OPACITY;
            if (OPACITY > 0) {
                const RGBA = colorComponents(new Color().setStyle(STYLE.stroke, SRGBColorSpace), OPACITY);
                const VECTOR_EFFECT = SOURCE_NODE.getAttribute('vector-effect') || 'none';
                if (VECTOR_EFFECT === 'non-scaling-stroke') {
                    if (MORPH_COUNT) {
                        throw new TypeError('Non-scaling strokes cannot be combined with vertex morph targets');
                    }
                    if (SOURCE_NODE.nodeName !== 'line' || PATH.subPaths.length !== 1) {
                        throw new TypeError('Non-scaling strokes currently support one straight <line> per shape');
                    }
                    const POINTS = PATH.subPaths[0].getPoints(1);
                    if (POINTS.length !== 2) {
                        throw new TypeError('Non-scaling strokes currently support straight <line> geometry only');
                    }
                    appendNonScalingLine(
                        VERTICES,
                        POINTS[0],
                        POINTS[1],
                        RGBA,
                        PART_INDEX,
                        STYLE.strokeWidth,
                        STYLE.strokeLineCap ?? 'butt',
                        strokeArcDivisions,
                    );
                    hasNonScalingStroke = true;
                } else {
                    const STROKE = SVGLoader.getStrokeStyle(
                        STYLE.strokeWidth,
                        STYLE.stroke,
                        STYLE.strokeLineJoin,
                        STYLE.strokeLineCap,
                        STYLE.strokeMiterLimit,
                    );
                    for (const SUB_PATH of PATH.subPaths) {
                        const GEOMETRY = SVGLoader.pointsToStroke(
                            SUB_PATH.getPoints(curveSegments),
                            STROKE,
                            strokeArcDivisions,
                            0.001,
                        );
                        if (GEOMETRY) {
                            appendTriangles(VERTICES, GEOMETRY, RGBA, PART_INDEX);
                            GEOMETRY.dispose();
                        }
                    }
                }
            }
        }
        appendOrderedMeshRange(DRAW_ORDER, MESH_FIRST, VERTICES.length / 11 - MESH_FIRST, PART_INDEX);
        for (let vertex = MESH_FIRST; expandedRegions && vertex < VERTICES.length / 11; vertex++) {
            expandedRegions.push(vertex < FILL_END ? regionIndex : 0);
        }
    }
    if ((!VERTICES.length && !SHADER_SURFACES.length) || VERTICES.length % 33) {
        throw new TypeError(
            'SVG did not produce complete painted triangles or shader surfaces at this tessellation; increase the selected subdivision or use a non-degenerate shape',
        );
    }
    const EXPANDED = new Float32Array(VERTICES);
    const STRIDE_FLOATS = 11;
    const UNIQUE_VERTICES = [],
        UNIQUE_REGIONS = expandedRegions ? [] : null,
        INDICES = [],
        VERTEX_IDS = new Map();
    const WORDS = new Uint32Array(EXPANDED.buffer, EXPANDED.byteOffset, EXPANDED.length);
    for (let offset = 0; offset < EXPANDED.length; offset += STRIDE_FLOATS) {
        const REGION_INDEX = expandedRegions?.[offset / STRIDE_FLOATS],
            KEY =
                WORDS.subarray(offset, offset + STRIDE_FLOATS).join(',') +
                (REGION_NAMES.length ? ':' + REGION_INDEX : '');
        let index = VERTEX_IDS.get(KEY);
        if (index === undefined) {
            index = UNIQUE_VERTICES.length / STRIDE_FLOATS;
            if (index > 0xffff) {
                throw new RangeError(
                    'SVG needs more than 65,536 distinct vertices; split the authored asset into bounded meshes',
                );
            }
            VERTEX_IDS.set(KEY, index);
            UNIQUE_REGIONS?.push(REGION_INDEX);
            for (let field = 0; field < STRIDE_FLOATS; field++) {
                UNIQUE_VERTICES.push(EXPANDED[offset + field]);
            }
        }
        INDICES.push(index);
    }
    return {
        vertices: new Float32Array(UNIQUE_VERTICES),
        indices: new Uint16Array(INDICES),
        morphCount: MORPH_COUNT,
        strideFloats: STRIDE_FLOATS,
        ...(REGION_NAMES.length
            ? { paintRegions: { names: REGION_NAMES, indices: new Uint16Array(UNIQUE_REGIONS) } }
            : {}),
        ...(hasNonScalingStroke
            ? {
                  nonScalingStroke: true,
              }
            : {}),
        ...(SHADER_ORDERED
            ? {
                  shaderSurfaces: SHADER_SURFACES,
                  drawOrder: DRAW_ORDER,
              }
            : {}),
    };
}
function compileExpressionIndices(geometry, metadata) {
    const PART_INDICES = new Map(metadata.parts.map((part, index) => [part.id, index]));
    const OUTPUT = {};
    for (const [NAME, EXPRESSION] of Object.entries(metadata.expressions)) {
        // An expression only hides the parts it names. Keep omitted parts in the
        // index list because their visibility can be inherited from an earlier
        // expression or the player's initial visible state.
        const VISIBLE = metadata.parts.map(() => true);
        for (const ID of EXPRESSION.show) {
            VISIBLE[PART_INDICES.get(ID)] = true;
        }
        for (const ID of EXPRESSION.hide) {
            VISIBLE[PART_INDICES.get(ID)] = false;
        }
        for (let index = 0; index < metadata.parts.length; index++) {
            let parent = metadata.parts[index].parent;
            while (parent !== null) {
                if (!VISIBLE[PART_INDICES.get(parent)]) {
                    VISIBLE[index] = false;
                    break;
                }
                parent = metadata.parts[PART_INDICES.get(parent)].parent;
            }
        }
        const INDICES = [];
        for (let offset = 0; offset < geometry.indices.length; offset += 3) {
            const A = geometry.indices[offset],
                B = geometry.indices[offset + 1],
                C = geometry.indices[offset + 2];
            const PART = geometry.vertices[A * 11 + 10];
            if (geometry.vertices[B * 11 + 10] !== PART || geometry.vertices[C * 11 + 10] !== PART) {
                throw new TypeError('Compiled SVG triangle crosses authored part boundaries');
            }
            if (VISIBLE[PART]) {
                INDICES.push(A, B, C);
            }
        }
        OUTPUT[NAME] = new Uint16Array(INDICES);
    }
    return OUTPUT;
}
function compileSourcePaths(paths, partIndices, parts) {
    return paths.map((path) => {
        const NODE = path.userData?.node,
            ID = NODE?.getAttribute?.('id');
        if (!ID) {
            throw new TypeError('Every reference path must keep its DOM id');
        }
        const PART_INDEX = ownerPart(NODE, partIndices),
            STYLE = path.userData.style;
        return {
            id: ID,
            part: parts[PART_INDEX].id,
            fill: STYLE.fill ?? 'none',
            ...(svgPaintRegion(NODE) === null ? {} : { paintRegion: svgPaintRegion(NODE) }),
            fillOpacity: STYLE.fillOpacity ?? 1,
            fillRule: STYLE.fillRule ?? 'nonzero',
            stroke: STYLE.stroke ?? 'none',
            strokeOpacity: STYLE.strokeOpacity ?? 1,
            strokeWidth: STYLE.strokeWidth ?? 1,
            strokeLineCap: STYLE.strokeLineCap ?? 'butt',
            strokeLineJoin: STYLE.strokeLineJoin ?? 'miter',
            strokeMiterLimit: STYLE.strokeMiterLimit ?? 4,
            opacity: STYLE.opacity ?? 1,
            subpaths: path.subPaths.map((subPath) => ({
                closed: Boolean(subPath.autoClose),
                points: subPath.getPoints(16).map((point) => [point.x, point.y]),
            })),
        };
    });
}
// The SVG file itself must draw the default pose: a plain viewer, <img>, or editor shows the same
// expression the runtime starts in. Parts that defaultExpression hides carry display="none", and
// nothing else does. Parts it shows, or does not mention, stay visible like the runtime treats them.
function validateDefaultPoseSource(ids, metadata) {
    const HIDDEN = new Set(metadata.expressions[metadata.defaultExpression].hide);
    for (const [ID, NODE] of ids) {
        const IS_NONE = NODE.getAttribute('display') === 'none';
        if (HIDDEN.has(ID) && !IS_NONE) {
            throw new TypeError(
                `Part "${ID}" is hidden by defaultExpression "${metadata.defaultExpression}" but its SVG node lacks display="none", so the source file does not draw the default pose`,
            );
        }
        if (IS_NONE && !HIDDEN.has(ID)) {
            throw new TypeError(
                `display="none" on "${ID}" is only allowed for parts that defaultExpression "${metadata.defaultExpression}" hides`,
            );
        }
    }
}
function withoutMetadata(document) {
    const ROOT = document.documentElement.cloneNode(true);
    // display="none" only marks the default pose in the source file; every expression variant
    // still compiles, and the runtime chooses what is visible.
    const NODES = ROOT.getElementsByTagName('*');
    ROOT.removeAttribute('display');
    for (let i = 0; i < NODES.length; i++) {
        NODES.item(i).removeAttribute('display');
    }
    for (let child = ROOT.firstChild; child; child = child.nextSibling) {
        if (child.nodeType === 1 && child.nodeName === 'metadata' && child.getAttribute('id') === 'vector-asset') {
            ROOT.removeChild(child);
            break;
        }
    }
    return new XMLSerializer().serializeToString(ROOT);
}
function withNodeDomParser(callback) {
    const OLD_PARSER = globalThis.DOMParser;
    globalThis.DOMParser = class NodeSvgDOMParser extends DOMParser {
        parseFromString(...args) {
            const DOCUMENT = super.parseFromString(...args);
            installSvgLoaderSelectors(DOCUMENT);
            return DOCUMENT;
        }
    };
    try {
        return callback();
    } finally {
        if (OLD_PARSER === undefined) {
            delete globalThis.DOMParser;
        } else {
            globalThis.DOMParser = OLD_PARSER;
        }
    }
}

// SVGLoader uses only these two querySelectorAll selectors. xmldom intentionally
// keeps a small DOM surface, so provide this narrow, deterministic adapter.
function installSvgLoaderSelectors(document) {
    const ALLOWED = new Set(['linearGradient', 'radialGradient', 'stop']);
    const QUERY_SELECTOR_ALL = function (selector) {
        const NAMES = String(selector)
            .split(',')
            .map((name) => name.trim());
        if (!NAMES.length || NAMES.some((name) => !ALLOWED.has(name))) {
            throw new TypeError('SVGLoader requested an unsupported selector');
        }
        const FOUND = [];
        const VISIT = (node) => {
            for (let child = node.firstChild; child; child = child.nextSibling) {
                if (child.nodeType === 1) {
                    if (NAMES.includes(child.nodeName)) {
                        FOUND.push(child);
                    }
                    VISIT(child);
                }
            }
        };
        VISIT(this.documentElement ?? this);
        return FOUND;
    };
    Object.defineProperty(document, 'querySelectorAll', {
        value: QUERY_SELECTOR_ALL,
    });
    const INSTALL = (node) => {
        if (node.nodeType === 1) {
            Object.defineProperty(node, 'querySelectorAll', {
                value: QUERY_SELECTOR_ALL,
            });
        }
        for (let child = node.firstChild; child; child = child.nextSibling) {
            INSTALL(child);
        }
    };
    INSTALL(document.documentElement);
}
export function compileVectorAssetCore(svgBytes, sourcePath = 'asset.svg', options = {}, sourceSha256) {
    if (
        options === null ||
        typeof options !== 'object' ||
        Array.isArray(options) ||
        Object.keys(options).some(
            (key) => !['curveSegments', 'normalizeCenteredViewBox', 'strokeArcDivisions'].includes(key),
        )
    ) {
        throw new TypeError(
            'Only curveSegments, normalizeCenteredViewBox, and strokeArcDivisions compiler options are supported',
        );
    }
    const CURVE_SEGMENTS =
        options.curveSegments === undefined
            ? VECTOR_ASSET_QUALITY_PRESETS.standard.curveSegments
            : options.curveSegments;
    if (!Number.isSafeInteger(CURVE_SEGMENTS) || CURVE_SEGMENTS < 1 || CURVE_SEGMENTS > 64) {
        throw new RangeError('curveSegments must be an integer from 1 to 64');
    }
    const STROKE_ARC_DIVISIONS =
        options.strokeArcDivisions === undefined
            ? VECTOR_ASSET_QUALITY_PRESETS.standard.strokeArcDivisions
            : options.strokeArcDivisions;
    if (!Number.isSafeInteger(STROKE_ARC_DIVISIONS) || STROKE_ARC_DIVISIONS < 1 || STROKE_ARC_DIVISIONS > 64) {
        throw new RangeError('strokeArcDivisions must be an integer from 1 to 64');
    }
    const NORMALIZE_CENTERED_VIEW_BOX = options.normalizeCenteredViewBox ?? false;
    if (typeof NORMALIZE_CENTERED_VIEW_BOX !== 'boolean') {
        throw new TypeError('normalizeCenteredViewBox must be a boolean');
    }
    if (!(svgBytes instanceof Uint8Array)) {
        throw new TypeError('SVG source bytes must be a Uint8Array');
    }
    const SOURCE = svgBytes;
    if (!SOURCE.length || SOURCE.byteLength > MAX_SOURCE_BYTES) {
        throw new RangeError('SVG source must be 1..512 KiB');
    }
    if (typeof sourceSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(sourceSha256)) {
        throw new TypeError('A lowercase SHA-256 digest is required');
    }
    let text;
    try {
        text = new TextDecoder('utf-8', {
            fatal: true,
        }).decode(SOURCE);
    } catch {
        throw new TypeError('SVG source must be valid UTF-8');
    }
    if (text.includes('\u0000') || /<!DOCTYPE|<!ENTITY|<\?xml-stylesheet/i.test(text)) {
        throw new TypeError('SVG doctypes, entities, stylesheets, and non-UTF-8 input are not supported');
    }
    const ORIGINAL = parseXml(text, 'source');
    const ROOT = ORIGINAL.documentElement;
    const IDS = collectIds(ROOT);
    const GRADIENTS = parseGradientDefinitions(ROOT, IDS);
    const METADATA_BLOCK = directMetadata(ROOT);
    const VIEW_BOX = NORMALIZE_CENTERED_VIEW_BOX
        ? normalizeCenteredViewBoxInput(ROOT, METADATA_BLOCK.value)
        : validateRoot(ROOT);
    const METADATA = validateAssetMetadata(METADATA_BLOCK.value, IDS);
    validateDefaultPoseSource(IDS, METADATA);
    const SERIALIZED = new XMLSerializer().serializeToString(ORIGINAL);
    const ROUND_TRIP = parseXml(SERIALIZED, 'editor-save round trip');
    const ROUND_TRIP_IDS = collectIds(ROUND_TRIP.documentElement);
    const SAVED_METADATA = directMetadata(ROUND_TRIP.documentElement);
    if (
        JSON.stringify(idList(IDS)) !== JSON.stringify(idList(ROUND_TRIP_IDS)) ||
        SAVED_METADATA.text !== METADATA_BLOCK.text ||
        SAVED_METADATA.value.schemaVersion !== METADATA.schemaVersion
    ) {
        throw new Error('SVG editor-save round trip did not preserve metadata or DOM ids');
    }
    const PART_INDICES = new Map(METADATA.parts.map((part, index) => [part.id, index]));
    const VECTOR_TEXT = withNodeDomParser(() => {
        const LOADER = new SVGLoader();
        return {
            clean: withoutMetadata(ORIGINAL),
            loader: LOADER,
        };
    });
    const PATHS = withNodeDomParser(() => VECTOR_TEXT.loader.parse(VECTOR_TEXT.clean).paths);
    const GEOMETRY = compilePaths(
        PATHS,
        PART_INDICES,
        METADATA.parts,
        METADATA,
        GRADIENTS,
        CURVE_SEGMENTS,
        STROKE_ARC_DIVISIONS,
    );
    GEOMETRY.expressionIndices = compileExpressionIndices(GEOMETRY, METADATA);
    const SOURCE_PATHS = compileSourcePaths(PATHS, PART_INDICES, METADATA.parts);
    const PAINTED_IDS = new Set(PATHS.map((path) => path.userData.node.getAttribute('id')));
    const SHAPE_NODES = [...IDS.values()].filter((node) =>
        ['path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon'].includes(node.nodeName),
    );
    if (SHAPE_NODES.some((node) => !PAINTED_IDS.has(node.getAttribute('id')))) {
        throw new TypeError('An authored shape id was not preserved by SVGLoader');
    }
    return {
        schemaVersion: VECTOR_ASSET_SCHEMA_VERSION,
        compilerVersion: VECTOR_ASSET_COMPILER_VERSION,
        compilerOptions: {
            curveSegments: CURVE_SEGMENTS,
            normalizeCenteredViewBox: NORMALIZE_CENTERED_VIEW_BOX,
            strokeArcDivisions: STROKE_ARC_DIVISIONS,
        },
        sourceSha256,
        sourcePath,
        metadata: METADATA,
        viewBox: VIEW_BOX,
        sourcePaths: SOURCE_PATHS,
        geometry: {
            ...GEOMETRY,
            partCount: METADATA.parts.length,
        },
    };
}

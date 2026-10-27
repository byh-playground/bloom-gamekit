import { MAX_PAINT_REGIONS, packPaintRegions, validatePaintRegionName } from '../rendering/paint-regions.js';

export const SVG_PAINT_REGION_ATTRIBUTE = 'data-paint-region';

// Regions are explicit filled shapes, independent of rig parts and expression visibility.
export function svgPaintRegion(node) {
    if (!node.hasAttribute(SVG_PAINT_REGION_ATTRIBUTE)) {
        return null;
    }
    return validatePaintRegionName(node.getAttribute(SVG_PAINT_REGION_ATTRIBUTE));
}

/** Return a recoloured clone of an original SVG; never add geometry or change alpha/strokes. */
export function applySvgPaintRegions(root, overrides) {
    if (!root || root.nodeType !== 1 || root.localName !== 'svg') {
        throw new TypeError('An original SVG root element is required');
    }
    const OUTPUT = root.cloneNode(true),
        SHAPES = [...OUTPUT.getElementsByTagName('*')].filter((node) => svgPaintRegion(node) !== null),
        NAMES = [...new Set(SHAPES.map(svgPaintRegion))];
    if (NAMES.length > MAX_PAINT_REGIONS) {
        throw new RangeError('An SVG supports at most eight paint regions');
    }
    const PAINT = packPaintRegions(NAMES, overrides, new Float32Array((NAMES.length + 1) * 4));
    // Validate before mutating so an invalid later region cannot leave a partially edited SVG.
    for (const NODE of SHAPES) {
        if (!['path', 'rect', 'circle', 'ellipse', 'polygon', 'polyline'].includes(NODE.localName)) {
            throw new TypeError('A paint region must name an authored filled shape');
        }
        const STYLE = NODE.getAttribute('style') || '',
            INLINE_FILL = STYLE.match(/(?:^|;)\s*fill\s*:\s*([^;]+)/i)?.[1]?.trim(),
            FILL = INLINE_FILL ?? NODE.getAttribute('fill');
        if (!FILL || FILL === 'none' || /url\s*\(/i.test(FILL)) {
            throw new TypeError('Paint regions require an explicit solid fill');
        }
    }
    for (const NODE of SHAPES) {
        const INDEX = NAMES.indexOf(svgPaintRegion(NODE)) + 1,
            AT = INDEX * 4;
        if (!PAINT[AT + 3]) {
            continue;
        }
        const COLOR = `rgb(${[0, 1, 2].map((channel) => PAINT[AT + channel] * 255).join(',')})`;
        NODE.setAttribute('fill', COLOR);
        const STYLE = NODE.getAttribute('style');
        if (STYLE && /(?:^|;)\s*fill\s*:/i.test(STYLE)) {
            NODE.setAttribute('style', STYLE.replace(/(^|;)\s*fill\s*:[^;]*/gi, '$1fill:' + COLOR));
        }
    }
    return OUTPUT;
}

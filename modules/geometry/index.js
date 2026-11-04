// geometry: 2D 기하 수학과 원형 이동체의 접촉 해소. 게임 규칙·길찾기·지형 의미는 담지 않습니다. 자세한 계약은 README.md.
export {
    assignBounds,
    boundariesCross,
    catmullRomPoint,
    closestPolylineProgress,
    insetPolygonTowardCenter,
    minPairDistance,
    nearestPointDistance,
    pointDistance,
    pointInSimplePolygon,
    pointPolylineDistance,
    pointSegmentDistance,
    polygonsOverlap,
    polygonTouchesRect,
    polylineTangentAt,
    polylineToRibbonPolygon,
    roundedPointOnPolyline,
    segmentDistance,
    segmentTouchesRect,
    segmentsIntersect,
    smoothPolylineCatmull,
} from './math.js';
export { BoundsIndex } from './bounds-index.js';
export { triangulatePolygon } from './triangulation.js';
export { SurfaceContactGeometry, SweptCircleContact } from './contact.js';
export { ObstacleField, segmentBlockedBy } from './obstacle-field.js';
export { SurfaceMotion } from './surface-motion.js';

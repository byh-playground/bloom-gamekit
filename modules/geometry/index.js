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
export {
    CONTACT_CIRCLE,
    CONTACT_EDGE,
    CONTACT_END,
    CONTACT_MAX_EDGE,
    CONTACT_MAX_OBSTACLE,
    CONTACT_POLYGON,
    CONTACT_START,
    CONTACT_USER,
    CONTACT_WALL,
    ContactHit,
    ContactList,
    SurfaceContact,
    SurfaceContactGeometry,
    SweptCircleContact,
    contactKey,
    defaultTieRank,
    earlierContact,
} from './contact.js';
export { ObstacleField, segmentBlockedBy } from './obstacle-field.js';
export { MotionResult, SurfaceMotion } from './surface-motion.js';

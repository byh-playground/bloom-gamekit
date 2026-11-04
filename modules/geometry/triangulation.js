// 단순 다각형(자기 교차 없음)의 귀 자르기 삼각분할입니다.

const MESH_CACHE = new WeakMap();

function crossAt(a, b, c) {
    return (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
}

/**
 * 다각형을 삼각형으로 나눕니다. 결과는 꼭짓점 배열(`points`) 객체 단위로 캐시하므로 돌려받은 값을 고치지 않습니다.
 * 일직선 위의 중복 꼭짓점은 건너뜁니다. 나눌 수 없는 다각형(자기 교차 등)이면 오류를 던집니다.
 * @param {Array<{x: number, y: number}>} points
 * @returns {{convex: boolean, triangles: number[][]}} 볼록 여부와 꼭짓점 번호 세 개씩의 삼각형 목록
 */
export function triangulatePolygon(points) {
    let cached = MESH_CACHE.get(points);
    if (cached) {
        return cached;
    }
    const AREA = points.reduce((n, p, i) => {
        const Q = points[(i + 1) % points.length];
        return n + p.x * Q.y - Q.x * p.y;
    }, 0);
    const SIGN = AREA >= 0 ? 1 : -1;
    const CONVEX = points.every(
        (p, i) => crossAt(p, points[(i + 1) % points.length], points[(i + 2) % points.length]) * SIGN >= -1e-7,
    );
    const INDICES = points.map((_, i) => i),
        TRIANGLES = [];
    while (INDICES.length > 3) {
        let found = false;
        for (let j = 0; j < INDICES.length; j++) {
            const A = INDICES[(j + INDICES.length - 1) % INDICES.length],
                B = INDICES[j],
                C = INDICES[(j + 1) % INDICES.length],
                CR = crossAt(points[A], points[B], points[C]) * SIGN;
            if (Math.abs(CR) < 1e-7) {
                INDICES.splice(j, 1);
                found = true;
                break;
            }
            if (CR < 0) {
                continue;
            }
            const CONTAINS = INDICES.some(
                (i) =>
                    i !== A &&
                    i !== B &&
                    i !== C &&
                    crossAt(points[A], points[B], points[i]) * SIGN >= -1e-7 &&
                    crossAt(points[B], points[C], points[i]) * SIGN >= -1e-7 &&
                    crossAt(points[C], points[A], points[i]) * SIGN >= -1e-7,
            );
            if (CONTAINS) {
                continue;
            }
            TRIANGLES.push([A, B, C]);
            INDICES.splice(j, 1);
            found = true;
            break;
        }
        if (!found) {
            throw new Error('다각형을 삼각분할할 수 없습니다(자기 교차 또는 퇴화).');
        }
    }
    if (INDICES.length === 3) {
        TRIANGLES.push(INDICES.slice());
    }
    cached = { convex: CONVEX, triangles: TRIANGLES };
    MESH_CACHE.set(points, cached);
    return cached;
}

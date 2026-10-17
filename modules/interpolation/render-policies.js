import { RenderObject as R } from './render-object.js';
const KINDS = [
    'number',
    'angle',
    'discrete',
    'number',
    'cycle',
    'number',
    'number',
    'discrete',
    'number',
    'number',
    'number',
    'number',
    'number',
    'number',
    'number',
];
export function fieldKind(code) {
    return KINDS[code];
}
export function isLinearField(code) {
    return code === R.LINEAR || (code >= R.POSITION_X && code <= R.SPAWN_LINEAR);
}

/** 필드 이름을 검사하지 않습니다. 선언된 코드와 부모 경로만 컴파일합니다. */
export function compileFieldPolicies(root, fields) {
    function descendants(node) {
        node.fields = node.field === undefined ? [] : [node.field];
        for (const CHILD of node.children.values()) {
            node.fields.push(...descendants(CHILD));
        }
        return node.fields;
    }
    descendants(root);
    const KEYS = [],
        CLOCKS = [],
        POSITIONS = new Array(3),
        ORIGINS = new Array(3),
        BIRTHS = [];
    for (let index = 0; index < fields.length; index++) {
        const FIELD = fields[index];
        if (FIELD.code === R.STATE_KEY) {
            KEYS.push({
                index,
                scope: FIELD.owner.fields,
            });
        }
        if (FIELD.code === R.COUNTDOWN_MS || FIELD.code === R.COUNTDOWN_SECONDS) {
            CLOCKS.push({
                index,
                scope: FIELD.owner.fields,
                unitsPerMs: FIELD.code === R.COUNTDOWN_MS ? 1 : 0.001,
            });
        }
        if (FIELD.code >= R.POSITION_X && FIELD.code <= R.POSITION_Z) {
            const AXIS = FIELD.code - R.POSITION_X;
            if (POSITIONS[AXIS] !== undefined) {
                throw new TypeError('Duplicate render position axis');
            }
            POSITIONS[AXIS] = index;
        }
        if (FIELD.code >= R.ORIGIN_X && FIELD.code <= R.ORIGIN_Z) {
            const AXIS = FIELD.code - R.ORIGIN_X;
            if (ORIGINS[AXIS] !== undefined) {
                throw new TypeError('Duplicate render origin axis');
            }
            ORIGINS[AXIS] = index;
        }
        if (FIELD.code === R.SPAWN_LINEAR) {
            BIRTHS.push(index);
        }
    }
    return {
        keys: KEYS,
        clocks: CLOCKS,
        positions: POSITIONS,
        origins: ORIGINS,
        births: BIRTHS,
    };
}

/** Receipt-time preview에도 적용 가능한 상태 구간 경계. */
export function inferStateResets(policies, previous, target, reset) {
    for (const KEY of policies.keys) {
        if (!Object.is(previous.values[KEY.index], target.values[KEY.index])) {
            for (const INDEX of KEY.scope) {
                reset.add(INDEX);
            }
        }
    }
}

/** STATE_KEY 전환과 countdown 재시작은 부모 범위만 새 표본으로 연결합니다. */
export function inferFieldResets(policies, previous, target, timeMs, reset) {
    inferStateResets(policies, previous.target, target, reset);
    const ELAPSED = timeMs - previous.timeMs;
    for (const CLOCK of policies.clocks) {
        const FROM = previous.target.values[CLOCK.index],
            TO = target.values[CLOCK.index];
        if (typeof FROM !== 'number' || typeof TO !== 'number') {
            continue;
        }
        const PASSED = Number.isFinite(ELAPSED)
            ? ELAPSED * CLOCK.unitsPerMs
            : timeMs * CLOCK.unitsPerMs - previous.timeMs * CLOCK.unitsPerMs;
        const EXPECTED = Math.max(0, FROM - PASSED);
        const TOLERANCE =
            1e-6 * CLOCK.unitsPerMs +
            Number.EPSILON * 16 * Math.max(1, FROM, TO) +
            Number.EPSILON * 16 * Math.max(Math.abs(timeMs), Math.abs(previous.timeMs)) * CLOCK.unitsPerMs;
        if (Math.abs(TO - EXPECTED) > TOLERANCE) {
            for (const INDEX of CLOCK.scope) {
                reset.add(INDEX);
            }
        }
    }
}

/** 설정한 위치 축만 사용합니다. x/y/z 같은 소스 필드명을 추측하지 않습니다. */
export function positionDiscontinuity(policies, previous, target, distance) {
    if (distance === undefined) {
        return false;
    }
    let count = 0;
    let a = 0;
    let b = 0;
    let c = 0;
    for (let axis = 0; axis < 3; axis++) {
        const INDEX = policies.positions[axis];
        if (INDEX === undefined) {
            continue;
        }
        const FROM = previous.target.values[INDEX],
            TO = target.values[INDEX];
        if (typeof FROM !== 'number' || typeof TO !== 'number') {
            continue;
        }
        const DELTA = TO - FROM;
        if (axis === 0) {
            a = DELTA;
        } else if (axis === 1) {
            b = DELTA;
        } else {
            c = DELTA;
        }
        count++;
    }
    return count > 0 && Math.hypot(a, b, c) > distance;
}

/** 새 identity의 시작점/0 seed도 필드 역할로만 결정합니다. */
export function seedFieldValues(policies, values) {
    const FROM = values.slice();
    for (let axis = 0; axis < 3; axis++) {
        const POSITION = policies.positions[axis],
            ORIGIN = policies.origins[axis];
        if (
            POSITION !== undefined &&
            ORIGIN !== undefined &&
            typeof values[POSITION] === 'number' &&
            typeof values[ORIGIN] === 'number'
        ) {
            FROM[POSITION] = values[ORIGIN];
        }
    }
    for (const INDEX of policies.births) {
        if (typeof values[INDEX] === 'number') {
            FROM[INDEX] = 0;
        }
    }
    return FROM;
}

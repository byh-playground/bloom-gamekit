import { ActionState } from './actions.js';
const UI_TARGETS =
    'input, textarea, select, button, a[href], [contenteditable]:not([contenteditable="false"]), [data-gamekit-ui]';
const BUTTON_BITS = [1, 4, 2, 8, 16];
function bindings(value, name, pointer = false) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new TypeError(`${name} must be an object`);
    }
    const MAP = new Map();
    for (const [KEY, ACTION] of Object.entries(value)) {
        if (!KEY.length || typeof ACTION !== 'string' || !ACTION.length) {
            throw new TypeError(`${name} requires nonempty action names`);
        }
        if (pointer && !/^[0-4]$/.test(KEY)) {
            throw new RangeError('pointerButtons keys must be 0..4');
        }
        MAP.set(pointer ? Number(KEY) : KEY, ACTION);
    }
    return MAP;
}
function positive(value, name) {
    if (!Number.isFinite(value) || value < 0) {
        throw new RangeError(`${name} must be a finite nonnegative number`);
    }
    return value;
}
function gestureOptions(value) {
    if (value === undefined || value === null) {
        return null;
    }
    if (typeof value !== 'object' || Array.isArray(value)) {
        throw new TypeError('gestures must be an object');
    }
    const RESULT = {
        tap: value.tap,
        doubleTap: value.doubleTap,
        button: value.button ?? 0,
        tapMs: value.tapMs ?? 400,
        doubleTapMs: value.doubleTapMs ?? 300,
        dragSlop: value.dragSlop ?? 12,
        doubleTapSlop: value.doubleTapSlop ?? 32,
    };
    for (const NAME of ['tap', 'doubleTap']) {
        if (RESULT[NAME] !== undefined && (typeof RESULT[NAME] !== 'string' || !RESULT[NAME].length)) {
            throw new TypeError(`gestures.${NAME} must be a nonempty action name`);
        }
    }
    if (!RESULT.tap && !RESULT.doubleTap) {
        throw new TypeError('gestures needs tap or doubleTap');
    }
    if (!Number.isInteger(RESULT.button) || RESULT.button < 0 || RESULT.button > 4) {
        throw new RangeError('gestures.button must be 0..4');
    }
    for (const NAME of ['tapMs', 'doubleTapMs', 'dragSlop', 'doubleTapSlop']) {
        positive(RESULT[NAME], `gestures.${NAME}`);
    }
    return RESULT;
}

/**
 * client 좌표를 target의 CSS bounding rect 기준 x/y와 정규화 u/v로 변환합니다.
 * clamp·DPR 배율·월드/카메라 역투영은 하지 않습니다. 크기 0/비정상 좌표는 false이며 out을 보존합니다.
 * target은 회전/기울임 없는 border/padding 0 표면을 권장합니다.
 * @param {{clientX:number,clientY:number}} event
 * @param {{getBoundingClientRect:Function}} target
 * @param {{x:number,y:number,u:number,v:number}} out @returns {boolean}
 */
export function pointerPositionInto(event, target, out) {
    if (!out || typeof out !== 'object') {
        throw new TypeError('out must be a writable object');
    }
    const RECT = target.getBoundingClientRect();
    if (
        !Number.isFinite(event.clientX) ||
        !Number.isFinite(event.clientY) ||
        !Number.isFinite(RECT.left) ||
        !Number.isFinite(RECT.top) ||
        !Number.isFinite(RECT.width) ||
        !Number.isFinite(RECT.height) ||
        RECT.width <= 0 ||
        RECT.height <= 0
    ) {
        return false;
    }
    out.x = event.clientX - RECT.left;
    out.y = event.clientY - RECT.top;
    out.u = out.x / RECT.width;
    out.v = out.y / RECT.height;
    return true;
}

/**
 * 독립적인 DOM 수집 어댑터. 타이머·rAF·명령 sequence·게임 상태를 소유하지 않습니다.
 * keyboard는 event.code, mouse/touch/pen은 PointerEvents를 사용합니다.
 * @param {{target:HTMLElement,state?:ActionState,keys?:Record<string,string>,pointerButtons?:Record<number,string>,keyboardTarget?:EventTarget,excludeTarget?:string|false|((target:EventTarget,event:Event)=>boolean),preventDefault?:boolean,touchAction?:string,gestures?:{tap?:string,doubleTap?:string,button?:number,tapMs?:number,doubleTapMs?:number,dragSlop?:number,doubleTapSlop?:number},onGesture?:(gesture:Object)=>void}} options
 * @returns {{state:ActionState,readonly disposed:boolean,samplePointerInto:Function,sampleLatestPointerInto:Function,releaseAll:Function,dispose:Function}}
 */
export function createDOMInput({
    target,
    state = new ActionState(),
    keys = {},
    pointerButtons = {},
    keyboardTarget = target?.ownerDocument,
    excludeTarget = UI_TARGETS,
    preventDefault = true,
    touchAction,
    gestures,
    onGesture,
    onPointer,
    onRelease,
} = {}) {
    const DOC = target?.ownerDocument;
    if (
        !target?.addEventListener ||
        !target?.getBoundingClientRect ||
        !DOC?.addEventListener ||
        !keyboardTarget?.addEventListener
    ) {
        throw new TypeError('target needs a DOM ownerDocument; keyboardTarget must be an EventTarget');
    }
    if (!(state instanceof ActionState)) {
        throw new TypeError('state must be an ActionState');
    }
    if (typeof excludeTarget !== 'string' && typeof excludeTarget !== 'function' && excludeTarget !== false) {
        throw new TypeError('excludeTarget must be a selector, predicate or false');
    }
    if (typeof preventDefault !== 'boolean') {
        throw new TypeError('preventDefault must be boolean');
    }
    if (touchAction !== undefined && typeof touchAction !== 'string') {
        throw new TypeError('touchAction must be a string');
    }
    if (onGesture !== undefined && typeof onGesture !== 'function') {
        throw new TypeError('onGesture must be a function');
    }
    for (const [NAME, CALLBACK] of Object.entries({
        onPointer,
        onRelease,
    })) {
        if (CALLBACK !== undefined && typeof CALLBACK !== 'function') {
            throw new TypeError(`${NAME} must be a function`);
        }
    }
    const KEY_MAP = bindings(keys, 'keys');
    const BUTTON_MAP = bindings(pointerButtons, 'pointerButtons', true);
    const GESTURE = gestureOptions(gestures);
    // 선택자 오류는 listener/style을 설치하기 전에 드러냅니다.
    if (typeof excludeTarget === 'string' && excludeTarget) {
        target.matches?.(excludeTarget);
    }
    const ACTIVE_KEYS = new Map();
    const POINTERS = new Map();
    const REMOVERS = [];
    let latest = null;
    let lastTap = null;
    let disposed = false;
    const OLD_TOUCH_ACTION = target.style?.touchAction;
    const LISTEN = (owner, type, callback, options) => {
        owner.addEventListener(type, callback, options);
        REMOVERS.push(() => owner.removeEventListener(type, callback, options));
    };
    const PREVENT = (event) => {
        if (preventDefault && event.cancelable) {
            event.preventDefault();
        }
    };
    const INSIDE = (event) =>
        event.composedPath?.().includes(target) || event.target === target || target.contains?.(event.target);
    const EXCLUDED = (event) => {
        if (excludeTarget === false || excludeTarget === '') {
            return false;
        }
        if (typeof excludeTarget === 'function') {
            return !!excludeTarget(event.target, event);
        }
        const PATH = event.composedPath?.() ?? [event.target];
        return PATH.some((node) => node?.closest?.(excludeTarget));
    };
    const SAMPLE = (record, out) => {
        if (!record) {
            return false;
        }
        if (!out || typeof out !== 'object') {
            throw new TypeError('out must be a writable object');
        }
        out.pointerId = record.pointerId;
        out.pointerType = record.pointerType;
        out.x = record.x;
        out.y = record.y;
        out.u = record.u;
        out.v = record.v;
        out.buttons = record.buttons;
        out.timeMs = record.timeMs;
        out.active = record.active;
        return true;
    };
    const NOTIFY_POINTER = (type, record, originalEvent, reason) => {
        if (!onPointer) {
            return;
        }
        const VALUE = {
            type,
            originalEvent,
            reason,
        };
        SAMPLE(record, VALUE);
        onPointer(VALUE);
    };
    const UPDATE_POSITION = (record, event) => {
        if (!pointerPositionInto(event, target, record)) {
            return false;
        }
        record.buttons = event.buttons;
        record.timeMs = event.timeStamp;
        latest = record;
        return true;
    };
    const SYNC_BUTTONS = (record, event) => {
        for (const [BUTTON, ACTION] of BUTTON_MAP) {
            const DOWN = (event.buttons & BUTTON_BITS[BUTTON]) !== 0;
            let source = record.sources.get(BUTTON);
            if (DOWN && !source) {
                source = Symbol(`pointer:${event.pointerId}:${BUTTON}`);
                record.sources.set(BUTTON, source);
                state.set(ACTION, source, true);
            } else if (!DOWN && source) {
                state.releaseSource(source);
                record.sources.delete(BUTTON);
            }
        }
    };
    const RELEASE_CAPTURE = (id) => {
        // pointerup 후 UA가 먼저 capture를 풀었거나 노드가 분리되어도 정리를 계속합니다.
        try {
            if (target.hasPointerCapture?.(id)) {
                target.releasePointerCapture(id);
            }
        } catch {
            /* 이미 해제된 capture */
        }
    };
    const DROP_POINTER = (record) => {
        POINTERS.delete(record.pointerId);
        record.active = false;
        for (const SOURCE of record.sources.values()) {
            state.releaseSource(SOURCE);
        }
        record.sources.clear();
        RELEASE_CAPTURE(record.pointerId);
    };
    const RELEASE_ALL = (event) => {
        const RELEASED = onPointer ? [...POINTERS.values()] : [];
        for (const SOURCE of ACTIVE_KEYS.values()) {
            state.releaseSource(SOURCE);
        }
        ACTIVE_KEYS.clear();
        for (const RECORD of POINTERS.values()) {
            DROP_POINTER(RECORD);
        }
        lastTap = null;
        latest = null;
        const REASON = typeof event === 'string' ? event : (event?.type ?? 'releaseAll');
        const ERRORS = [];
        for (const RECORD of RELEASED) {
            try {
                NOTIFY_POINTER('cancel', RECORD, event?.type ? event : null, REASON);
            } catch (error) {
                ERRORS.push(error);
            }
        }
        try {
            onRelease?.({
                reason: REASON,
                originalEvent: event?.type ? event : null,
            });
        } catch (error) {
            ERRORS.push(error);
        }
        if (ERRORS.length) {
            throw new AggregateError(ERRORS, 'input release callbacks failed');
        }
    };
    const CANCEL_GESTURE = (record) => {
        record.gestureCanceled = true;
        lastTap = null;
    };
    const MOVED = (record, event) =>
        Math.hypot(event.clientX - record.startX, event.clientY - record.startY) > GESTURE.dragSlop;
    const CHECK_GESTURE = (record, event) => {
        if (!GESTURE || record.gestureCanceled) {
            return;
        }
        if (MOVED(record, event) || (event.buttons & ~BUTTON_BITS[GESTURE.button]) !== 0) {
            CANCEL_GESTURE(record);
        }
    };
    const KEYDOWN = (event) => {
        const ACTION = KEY_MAP.get(event.code);
        if (!ACTION || DOC.hidden || EXCLUDED(event)) {
            return;
        }
        // blur 후 재포커스 시 fresh down 없이 들어오는 OS repeat는 다시 hold하지 않습니다.
        if (!ACTIVE_KEYS.has(event.code)) {
            if (event.repeat) {
                return;
            }
            const SOURCE = Symbol(`key:${event.code}`);
            ACTIVE_KEYS.set(event.code, SOURCE);
            state.set(ACTION, SOURCE, true);
        }
        PREVENT(event);
    };
    const KEYUP = (event) => {
        const SOURCE = ACTIVE_KEYS.get(event.code);
        if (!SOURCE) {
            return;
        }
        state.releaseSource(SOURCE);
        ACTIVE_KEYS.delete(event.code);
        // UI로 포커스가 옮겨져도 해제는 하되 UI의 기본 동작은 건드리지 않습니다.
        if (!EXCLUDED(event)) {
            PREVENT(event);
        }
    };
    const POINTERDOWN = (event) => {
        if (DOC.hidden || EXCLUDED(event) || POINTERS.has(event.pointerId)) {
            return;
        }
        if (!BUTTON_MAP.has(event.button) && (!GESTURE || event.button !== GESTURE.button)) {
            return;
        }
        const RECORD = {
            pointerId: event.pointerId,
            pointerType: event.pointerType,
            active: true,
            sources: new Map(),
            startX: event.clientX,
            startY: event.clientY,
            startMs: event.timeStamp,
            gestureCanceled: !GESTURE || event.button !== GESTURE.button || POINTERS.size > 0,
        };
        if (!UPDATE_POSITION(RECORD, event)) {
            return;
        }
        if (POINTERS.size) {
            for (const OTHER of POINTERS.values()) {
                CANCEL_GESTURE(OTHER);
            }
        }
        POINTERS.set(event.pointerId, RECORD);
        SYNC_BUTTONS(RECORD, event);
        CHECK_GESTURE(RECORD, event);
        try {
            target.setPointerCapture?.(event.pointerId);
        } catch {
            /* document listener가 capture 실패를 보완합니다. */
        }
        PREVENT(event);
        NOTIFY_POINTER('down', RECORD, event);
    };
    const POINTERMOVE = (event) => {
        const RECORD = POINTERS.get(event.pointerId);
        if (!RECORD) {
            if (INSIDE(event) && !EXCLUDED(event)) {
                const HOVER =
                    latest && !latest.active && latest.pointerId === event.pointerId
                        ? latest
                        : {
                              pointerId: event.pointerId,
                              pointerType: event.pointerType,
                              active: false,
                          };
                if (UPDATE_POSITION(HOVER, event)) {
                    NOTIFY_POINTER('move', HOVER, event);
                }
            }
            return;
        }
        if (!UPDATE_POSITION(RECORD, event)) {
            CANCEL_GESTURE(RECORD);
        }
        CHECK_GESTURE(RECORD, event);
        SYNC_BUTTONS(RECORD, event);
        PREVENT(event);
        NOTIFY_POINTER('move', RECORD, event);
    };
    const POINTEREND = (event, canceled) => {
        const RECORD = POINTERS.get(event.pointerId);
        if (!RECORD) {
            return;
        }
        const VALID_POSITION = UPDATE_POSITION(RECORD, event);
        CHECK_GESTURE(RECORD, event);
        // 삭제를 먼저 해서 정상 up 이후의 lostpointercapture가 다음 tap 후보를 지우지 않게 합니다.
        DROP_POINTER(RECORD);
        if (!canceled) {
            PREVENT(event);
        }
        NOTIFY_POINTER(canceled ? 'cancel' : 'up', RECORD, event, canceled ? 'pointercancel' : undefined);
        if (!GESTURE) {
            return;
        }
        const DURATION = event.timeStamp - RECORD.startMs;
        if (
            canceled ||
            !VALID_POSITION ||
            RECORD.gestureCanceled ||
            !Number.isFinite(DURATION) ||
            DURATION < 0 ||
            DURATION > GESTURE.tapMs ||
            RECORD.u < 0 ||
            RECORD.u > 1 ||
            RECORD.v < 0 ||
            RECORD.v > 1
        ) {
            lastTap = null;
            return;
        }
        const GAP = lastTap ? event.timeStamp - lastTap.timeMs : Infinity;
        const DOUBLE =
            !!GESTURE.doubleTap &&
            !!lastTap &&
            lastTap.pointerType === RECORD.pointerType &&
            GAP >= 0 &&
            GAP <= GESTURE.doubleTapMs &&
            Math.hypot(event.clientX - lastTap.clientX, event.clientY - lastTap.clientY) <= GESTURE.doubleTapSlop;
        const TYPE = DOUBLE ? 'doubleTap' : 'tap';
        const ACTION = GESTURE[TYPE];
        lastTap = DOUBLE
            ? null
            : {
                  timeMs: event.timeStamp,
                  clientX: event.clientX,
                  clientY: event.clientY,
                  pointerType: RECORD.pointerType,
              };
        if (ACTION) {
            state.pulse(ACTION);
        }
        if (onGesture) {
            onGesture({
                type: TYPE,
                action: ACTION ?? null,
                pointerId: RECORD.pointerId,
                pointerType: RECORD.pointerType,
                x: RECORD.x,
                y: RECORD.y,
                u: RECORD.u,
                v: RECORD.v,
                timeMs: RECORD.timeMs,
            });
        }
    };
    const UNRELATED_DOWN = (event) => {
        if (
            !INSIDE(event) ||
            EXCLUDED(event) ||
            (!BUTTON_MAP.has(event.button) && GESTURE && event.button !== GESTURE.button)
        ) {
            lastTap = null;
            for (const RECORD of POINTERS.values()) {
                CANCEL_GESTURE(RECORD);
            }
        }
    };
    const LOSTCAPTURE = (event) => {
        const RECORD = POINTERS.get(event.pointerId);
        if (!RECORD) {
            return;
        }
        DROP_POINTER(RECORD);
        lastTap = null;
        NOTIFY_POINTER('cancel', RECORD, event, 'lostpointercapture');
    };
    LISTEN(keyboardTarget, 'keydown', KEYDOWN);
    // keydown 범위를 요소로 좁혀도 포커스가 UI로 옮겨진 뒤의 keyup은 놓치지 않습니다.
    LISTEN(DOC, 'keyup', KEYUP, true);
    LISTEN(target, 'pointerdown', POINTERDOWN, {
        passive: false,
    });
    LISTEN(DOC, 'pointerdown', UNRELATED_DOWN, true);
    LISTEN(DOC, 'pointermove', POINTERMOVE, {
        capture: true,
        passive: false,
    });
    LISTEN(DOC, 'pointerup', (event) => POINTEREND(event, false), {
        capture: true,
        passive: false,
    });
    LISTEN(DOC, 'pointercancel', (event) => POINTEREND(event, true), true);
    LISTEN(target, 'lostpointercapture', LOSTCAPTURE);
    LISTEN(DOC, 'visibilitychange', (event) => {
        if (DOC.hidden) {
            RELEASE_ALL(event);
        }
    });
    if (DOC.defaultView) {
        LISTEN(DOC.defaultView, 'blur', RELEASE_ALL);
        LISTEN(DOC.defaultView, 'pagehide', RELEASE_ALL);
    }
    if (preventDefault && (BUTTON_MAP.has(2) || GESTURE?.button === 2)) {
        LISTEN(target, 'contextmenu', (event) => {
            if (!EXCLUDED(event)) {
                PREVENT(event);
            }
        });
    }
    if (touchAction !== undefined && target.style) {
        target.style.touchAction = touchAction;
    }
    return {
        state,
        get disposed() {
            return disposed;
        },
        samplePointerInto(pointerId, out) {
            return SAMPLE(POINTERS.get(pointerId), out);
        },
        sampleLatestPointerInto(out) {
            return SAMPLE(latest, out);
        },
        releaseAll: RELEASE_ALL,
        dispose() {
            if (disposed) {
                return;
            }
            disposed = true;
            for (const REMOVE of REMOVERS) {
                REMOVE();
            }
            try {
                RELEASE_ALL('dispose');
            } finally {
                if (touchAction !== undefined && target.style?.touchAction === touchAction) {
                    target.style.touchAction = OLD_TOUCH_ACTION;
                }
            }
        },
    };
}

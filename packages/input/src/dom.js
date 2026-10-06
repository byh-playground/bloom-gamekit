import { ActionState } from './actions.js';

const UI_TARGETS = 'input, textarea, select, button, a[href], [contenteditable]:not([contenteditable="false"]), [data-gamekit-ui]';
const BUTTON_BITS = [1, 4, 2, 8, 16];

function bindings(value, name, pointer = false) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  const map = new Map();
  for (const [key, action] of Object.entries(value)) {
    if (!key.length || typeof action !== 'string' || !action.length) throw new TypeError(`${name} requires nonempty action names`);
    if (pointer && !/^[0-4]$/.test(key)) throw new RangeError('pointerButtons keys must be 0..4');
    map.set(pointer ? Number(key) : key, action);
  }
  return map;
}
function positive(value, name) {
  if (!Number.isFinite(value) || value < 0) throw new RangeError(`${name} must be a finite nonnegative number`);
  return value;
}
function gestureOptions(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) throw new TypeError('gestures must be an object');
  const result = {
    tap: value.tap, doubleTap: value.doubleTap,
    button: value.button ?? 0,
    tapMs: value.tapMs ?? 400, doubleTapMs: value.doubleTapMs ?? 300,
    dragSlop: value.dragSlop ?? 12, doubleTapSlop: value.doubleTapSlop ?? 32,
  };
  for (const name of ['tap', 'doubleTap']) {
    if (result[name] !== undefined && (typeof result[name] !== 'string' || !result[name].length)) throw new TypeError(`gestures.${name} must be a nonempty action name`);
  }
  if (!result.tap && !result.doubleTap) throw new TypeError('gestures needs tap or doubleTap');
  if (!Number.isInteger(result.button) || result.button < 0 || result.button > 4) throw new RangeError('gestures.button must be 0..4');
  for (const name of ['tapMs', 'doubleTapMs', 'dragSlop', 'doubleTapSlop']) positive(result[name], `gestures.${name}`);
  return result;
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
  if (!out || typeof out !== 'object') throw new TypeError('out must be a writable object');
  const rect = target.getBoundingClientRect();
  if (!Number.isFinite(event.clientX) || !Number.isFinite(event.clientY) || !Number.isFinite(rect.left) || !Number.isFinite(rect.top) || !Number.isFinite(rect.width) || !Number.isFinite(rect.height) || rect.width <= 0 || rect.height <= 0) return false;
  out.x = event.clientX - rect.left; out.y = event.clientY - rect.top;
  out.u = out.x / rect.width; out.v = out.y / rect.height;
  return true;
}

/**
 * 독립적인 DOM 수집 어댑터. 타이머·rAF·명령 sequence·게임 상태를 소유하지 않습니다.
 * keyboard는 event.code, mouse/touch/pen은 PointerEvents를 사용합니다.
 * @param {{target:HTMLElement,state?:ActionState,keys?:Record<string,string>,pointerButtons?:Record<number,string>,keyboardTarget?:EventTarget,excludeTarget?:string|false|((target:EventTarget,event:Event)=>boolean),preventDefault?:boolean,touchAction?:string,gestures?:{tap?:string,doubleTap?:string,button?:number,tapMs?:number,doubleTapMs?:number,dragSlop?:number,doubleTapSlop?:number},onGesture?:(gesture:Object)=>void}} options
 * @returns {{state:ActionState,readonly disposed:boolean,samplePointerInto:Function,sampleLatestPointerInto:Function,releaseAll:Function,dispose:Function}}
 */
export function createDOMInput({ target, state = new ActionState(), keys = {}, pointerButtons = {}, keyboardTarget = target?.ownerDocument, excludeTarget = UI_TARGETS, preventDefault = true, touchAction, gestures, onGesture, onPointer, onRelease } = {}) {
  const doc = target?.ownerDocument;
  if (!target?.addEventListener || !target?.getBoundingClientRect || !doc?.addEventListener || !keyboardTarget?.addEventListener) throw new TypeError('target needs a DOM ownerDocument; keyboardTarget must be an EventTarget');
  if (!(state instanceof ActionState)) throw new TypeError('state must be an ActionState');
  if (typeof excludeTarget !== 'string' && typeof excludeTarget !== 'function' && excludeTarget !== false) throw new TypeError('excludeTarget must be a selector, predicate or false');
  if (typeof preventDefault !== 'boolean') throw new TypeError('preventDefault must be boolean');
  if (touchAction !== undefined && typeof touchAction !== 'string') throw new TypeError('touchAction must be a string');
  if (onGesture !== undefined && typeof onGesture !== 'function') throw new TypeError('onGesture must be a function');
  for (const [name, callback] of Object.entries({onPointer,onRelease})) if (callback !== undefined && typeof callback !== 'function') throw new TypeError(`${name} must be a function`);
  const keyMap = bindings(keys, 'keys');
  const buttonMap = bindings(pointerButtons, 'pointerButtons', true);
  const gesture = gestureOptions(gestures);
  // 선택자 오류는 listener/style을 설치하기 전에 드러냅니다.
  if (typeof excludeTarget === 'string' && excludeTarget) target.matches?.(excludeTarget);
  const activeKeys = new Map();
  const pointers = new Map();
  const removers = [];
  let latest = null, lastTap = null, disposed = false;
  const oldTouchAction = target.style?.touchAction;

  const listen = (owner, type, callback, options) => {
    owner.addEventListener(type, callback, options);
    removers.push(() => owner.removeEventListener(type, callback, options));
  };
  const prevent = event => { if (preventDefault && event.cancelable) event.preventDefault(); };
  const inside = event => event.composedPath?.().includes(target) || event.target === target || target.contains?.(event.target);
  const excluded = event => {
    if (excludeTarget === false || excludeTarget === '') return false;
    if (typeof excludeTarget === 'function') return !!excludeTarget(event.target, event);
    const path = event.composedPath?.() ?? [event.target];
    return path.some(node => node?.closest?.(excludeTarget));
  };
  const sample = (record, out) => {
    if (!record) return false;
    if (!out || typeof out !== 'object') throw new TypeError('out must be a writable object');
    out.pointerId = record.pointerId; out.pointerType = record.pointerType;
    out.x = record.x; out.y = record.y; out.u = record.u; out.v = record.v;
    out.buttons = record.buttons; out.timeMs = record.timeMs; out.active = record.active;
    return true;
  };
  const notifyPointer = (type, record, originalEvent, reason) => {
    if (!onPointer) return;
    const value={type,originalEvent,reason};sample(record,value);onPointer(value);
  };
  const updatePosition = (record, event) => {
    if (!pointerPositionInto(event, target, record)) return false;
    record.buttons = event.buttons;
    record.timeMs = event.timeStamp;
    latest = record;
    return true;
  };
  const syncButtons = (record, event) => {
    for (const [button, action] of buttonMap) {
      const down = (event.buttons & BUTTON_BITS[button]) !== 0;
      let source = record.sources.get(button);
      if (down && !source) {
        source = Symbol(`pointer:${event.pointerId}:${button}`);
        record.sources.set(button, source);
        state.set(action, source, true);
      } else if (!down && source) {
        state.releaseSource(source);
        record.sources.delete(button);
      }
    }
  };
  const releaseCapture = id => {
    // pointerup 후 UA가 먼저 capture를 풀었거나 노드가 분리되어도 정리를 계속합니다.
    try { if (target.hasPointerCapture?.(id)) target.releasePointerCapture(id); } catch { /* 이미 해제된 capture */ }
  };
  const dropPointer = record => {
    pointers.delete(record.pointerId);
    record.active = false;
    for (const source of record.sources.values()) state.releaseSource(source);
    record.sources.clear();
    releaseCapture(record.pointerId);
  };
  const releaseAll = event => {
    const released = onPointer ? [...pointers.values()] : [];
    for (const source of activeKeys.values()) state.releaseSource(source);
    activeKeys.clear();
    for (const record of pointers.values()) dropPointer(record);
    lastTap = null; latest = null;
    const reason=typeof event === 'string'?event:event?.type??'releaseAll';
    const errors=[];
    for(const record of released)try{notifyPointer('cancel',record,event?.type?event:null,reason)}catch(error){errors.push(error)}
    try{onRelease?.({reason,originalEvent:event?.type?event:null})}catch(error){errors.push(error)}
    if(errors.length)throw new AggregateError(errors,'input release callbacks failed');
  };
  const cancelGesture = record => { record.gestureCanceled = true; lastTap = null; };
  const moved = (record, event) => Math.hypot(event.clientX - record.startX, event.clientY - record.startY) > gesture.dragSlop;
  const checkGesture = (record, event) => {
    if (!gesture || record.gestureCanceled) return;
    if (moved(record, event) || (event.buttons & ~BUTTON_BITS[gesture.button]) !== 0) cancelGesture(record);
  };
  const keydown = event => {
    const action = keyMap.get(event.code);
    if (!action || doc.hidden || excluded(event)) return;
    // blur 후 재포커스 시 fresh down 없이 들어오는 OS repeat는 다시 hold하지 않습니다.
    if (!activeKeys.has(event.code)) {
      if (event.repeat) return;
      const source = Symbol(`key:${event.code}`);
      activeKeys.set(event.code, source);
      state.set(action, source, true);
    }
    prevent(event);
  };
  const keyup = event => {
    const source = activeKeys.get(event.code);
    if (!source) return;
    state.releaseSource(source); activeKeys.delete(event.code);
    // UI로 포커스가 옮겨져도 해제는 하되 UI의 기본 동작은 건드리지 않습니다.
    if (!excluded(event)) prevent(event);
  };
  const pointerdown = event => {
    if (doc.hidden || excluded(event) || pointers.has(event.pointerId)) return;
    if (!buttonMap.has(event.button) && (!gesture || event.button !== gesture.button)) return;
    const record = { pointerId: event.pointerId, pointerType: event.pointerType, active: true, sources: new Map(), startX: event.clientX, startY: event.clientY, startMs: event.timeStamp, gestureCanceled: !gesture || event.button !== gesture.button || pointers.size > 0 };
    if (!updatePosition(record, event)) return;
    if (pointers.size) for (const other of pointers.values()) cancelGesture(other);
    pointers.set(event.pointerId, record);
    syncButtons(record, event);
    checkGesture(record, event);
    try { target.setPointerCapture?.(event.pointerId); } catch { /* document listener가 capture 실패를 보완합니다. */ }
    prevent(event);
    notifyPointer('down',record,event);
  };
  const pointermove = event => {
    const record = pointers.get(event.pointerId);
    if (!record) {
      if (inside(event) && !excluded(event)) {
        const hover = latest && !latest.active && latest.pointerId === event.pointerId ? latest : { pointerId: event.pointerId, pointerType: event.pointerType, active: false };
        if(updatePosition(hover, event))notifyPointer('move',hover,event);
      }
      return;
    }
    if (!updatePosition(record, event)) cancelGesture(record);
    checkGesture(record, event);
    syncButtons(record, event);
    prevent(event);
    notifyPointer('move',record,event);
  };
  const pointerend = (event, canceled) => {
    const record = pointers.get(event.pointerId);
    if (!record) return;
    const validPosition = updatePosition(record, event);
    checkGesture(record, event);
    // 삭제를 먼저 해서 정상 up 이후의 lostpointercapture가 다음 tap 후보를 지우지 않게 합니다.
    dropPointer(record);
    if (!canceled) prevent(event);
    notifyPointer(canceled?'cancel':'up',record,event,canceled?'pointercancel':undefined);
    if (!gesture) return;
    const duration = event.timeStamp - record.startMs;
    if (canceled || !validPosition || record.gestureCanceled || !Number.isFinite(duration) || duration < 0 || duration > gesture.tapMs || record.u < 0 || record.u > 1 || record.v < 0 || record.v > 1) {
      lastTap = null;
      return;
    }
    const gap = lastTap ? event.timeStamp - lastTap.timeMs : Infinity;
    const double = !!gesture.doubleTap && !!lastTap && lastTap.pointerType === record.pointerType && gap >= 0 && gap <= gesture.doubleTapMs && Math.hypot(event.clientX - lastTap.clientX, event.clientY - lastTap.clientY) <= gesture.doubleTapSlop;
    const type = double ? 'doubleTap' : 'tap';
    const action = gesture[type];
    lastTap = double ? null : { timeMs: event.timeStamp, clientX: event.clientX, clientY: event.clientY, pointerType: record.pointerType };
    if (action) state.pulse(action);
    if (onGesture) onGesture({ type, action: action ?? null, pointerId: record.pointerId, pointerType: record.pointerType, x: record.x, y: record.y, u: record.u, v: record.v, timeMs: record.timeMs });
  };
  const unrelatedDown = event => {
    if (!inside(event) || excluded(event) || (!buttonMap.has(event.button) && gesture && event.button !== gesture.button)) {
      lastTap = null;
      for (const record of pointers.values()) cancelGesture(record);
    }
  };
  const lostcapture = event => {
    const record = pointers.get(event.pointerId);
    if (!record) return;
    dropPointer(record); lastTap = null;
    notifyPointer('cancel',record,event,'lostpointercapture');
  };

  listen(keyboardTarget, 'keydown', keydown);
  // keydown 범위를 요소로 좁혀도 포커스가 UI로 옮겨진 뒤의 keyup은 놓치지 않습니다.
  listen(doc, 'keyup', keyup, true);
  listen(target, 'pointerdown', pointerdown, { passive: false });
  listen(doc, 'pointerdown', unrelatedDown, true);
  listen(doc, 'pointermove', pointermove, { capture: true, passive: false });
  listen(doc, 'pointerup', event => pointerend(event, false), { capture: true, passive: false });
  listen(doc, 'pointercancel', event => pointerend(event, true), true);
  listen(target, 'lostpointercapture', lostcapture);
  listen(doc, 'visibilitychange', event => { if (doc.hidden) releaseAll(event); });
  if (doc.defaultView) {
    listen(doc.defaultView, 'blur', releaseAll);
    listen(doc.defaultView, 'pagehide', releaseAll);
  }
  if (preventDefault && (buttonMap.has(2) || gesture?.button === 2)) {
    listen(target, 'contextmenu', event => { if (!excluded(event)) prevent(event); });
  }
  if (touchAction !== undefined && target.style) target.style.touchAction = touchAction;

  return {
    state,
    get disposed() { return disposed; },
    samplePointerInto(pointerId, out) { return sample(pointers.get(pointerId), out); },
    sampleLatestPointerInto(out) { return sample(latest, out); },
    releaseAll,
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const remove of removers) remove();
      try { releaseAll('dispose'); } finally {
      if (touchAction !== undefined && target.style?.touchAction === touchAction) target.style.touchAction = oldTouchAction;
      }
    },
  };
}

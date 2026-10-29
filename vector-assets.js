// node_modules/animejs/dist/modules/core/consts.js
/**
 * Anime.js - core - ESM
 * @version v4.5.0
 * @license MIT
 * @copyright 2026 - Julian Garnier
 */
var isBrowser = typeof window !== "undefined";
var win = isBrowser ? (
  /** @type {AnimeJSWindow} */
  /** @type {unknown} */
  window
) : null;
var doc = isBrowser ? document : null;
var tweenTypes = {
  OBJECT: 0,
  ATTRIBUTE: 1,
  CSS: 2,
  TRANSFORM: 3,
  CSS_VAR: 4
};
var valueTypes = {
  NUMBER: 0,
  UNIT: 1,
  COLOR: 2,
  COMPLEX: 3
};
var tickModes = {
  NONE: 0,
  AUTO: 1,
  FORCE: 2
};
var compositionTypes = {
  replace: 0,
  none: 1,
  blend: 2
};
var isRegisteredTargetSymbol = /* @__PURE__ */ Symbol();
var isDomSymbol = /* @__PURE__ */ Symbol();
var isSvgSymbol = /* @__PURE__ */ Symbol();
var transformsSymbol = /* @__PURE__ */ Symbol();
var proxyTargetSymbol = /* @__PURE__ */ Symbol();
var minValue = 1e-11;
var maxValue = 1e12;
var K = 1e3;
var maxFps = 240;
var emptyString = "";
var cssVarPrefix = "var(";
var emptyArray = [];
var shortTransforms = /* @__PURE__ */ (() => {
  const map = /* @__PURE__ */ new Map();
  map.set("x", "translateX");
  map.set("y", "translateY");
  map.set("z", "translateZ");
  return map;
})();
var validTransforms = [
  "perspective",
  "translateX",
  "translateY",
  "translateZ",
  "rotate",
  "rotateX",
  "rotateY",
  "rotateZ",
  "scale",
  "scaleX",
  "scaleY",
  "scaleZ",
  "skew",
  "skewX",
  "skewY"
];
var transformsFragmentStrings = /* @__PURE__ */ validTransforms.reduce((a, v) => ({ ...a, [v]: v + "(" }), {});
var noop = () => {
};
var noopModifier = (v) => v;
var validRgbHslRgx = /\)\s*[-.\d]/;
var hexTestRgx = /(^#([\da-f]{3}){1,2}$)|(^#([\da-f]{4}){1,2}$)/i;
var rgbExecRgx = /rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/i;
var rgbaExecRgx = /rgba\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(-?\d+|-?\d*.\d+)\s*\)/i;
var hslExecRgx = /hsl\(\s*(-?\d+|-?\d*.\d+)\s*,\s*(-?\d+|-?\d*.\d+)%\s*,\s*(-?\d+|-?\d*.\d+)%\s*\)/i;
var hslaExecRgx = /hsla\(\s*(-?\d+|-?\d*.\d+)\s*,\s*(-?\d+|-?\d*.\d+)%\s*,\s*(-?\d+|-?\d*.\d+)%\s*,\s*(-?\d+|-?\d*.\d+)\s*\)/i;
var digitWithExponentRgx = /[-+]?\d*\.?\d+(?:e[-+]?\d)?/gi;
var unitsExecRgx = /^([-+]?\d*\.?\d+(?:e[-+]?\d+)?)([a-z]+|%)$/i;
var lowerCaseRgx = /([a-z])([A-Z])/g;
var relativeValuesExecRgx = /(\*=|\+=|-=)/;
var cssVariableMatchRgx = /var\(\s*(--[\w-]+)(?:\s*,\s*([^)]+))?\s*\)/;

// node_modules/animejs/dist/modules/core/globals.js
/**
 * Anime.js - core - ESM
 * @version v4.5.0
 * @license MIT
 * @copyright 2026 - Julian Garnier
 */
var defaults = {
  id: null,
  keyframes: null,
  playbackEase: null,
  playbackRate: 1,
  frameRate: maxFps,
  loop: 0,
  reversed: false,
  alternate: false,
  autoplay: true,
  persist: false,
  duration: K,
  delay: 0,
  loopDelay: 0,
  ease: "out(2)",
  composition: compositionTypes.replace,
  modifier: noopModifier,
  onBegin: noop,
  onBeforeUpdate: noop,
  onUpdate: noop,
  onLoop: noop,
  onPause: noop,
  onComplete: noop,
  onRender: noop
};
var scope = {
  /** @type {Scope} */
  current: null,
  /** @type {Document|DOMTarget} */
  root: doc
};
var globals = {
  /** @type {DefaultsParams} */
  defaults,
  /** @type {Number} */
  precision: 4,
  /** @type {Number} equals 1 in ms mode, 0.001 in s mode */
  timeScale: 1,
  /** @type {Number} */
  tickThreshold: 200,
  /** @type {EditorGlobals|null} */
  editor: null
};
var globalVersions = { version: "4.5.0", engine: null };
if (isBrowser) {
  if (!win.AnimeJS) win.AnimeJS = [];
  win.AnimeJS.push(globalVersions);
}

// node_modules/animejs/dist/modules/core/helpers.js
/**
 * Anime.js - core - ESM
 * @version v4.5.0
 * @license MIT
 * @copyright 2026 - Julian Garnier
 */
var toLowerCase = (str) => str.replace(lowerCaseRgx, "$1-$2").toLowerCase();
var stringStartsWith = (str, sub) => str.indexOf(sub) === 0;
var now = Date.now;
var isArr = Array.isArray;
var isObj = (a) => a && a.constructor === Object;
var isNum = (a) => typeof a === "number" && !isNaN(a);
var isStr = (a) => typeof a === "string";
var isFnc = (a) => typeof a === "function";
var isUnd = (a) => typeof a === "undefined";
var isNil = (a) => isUnd(a) || a === null;
var isSvg = (a) => isBrowser && a instanceof SVGElement;
var isHex = (a) => hexTestRgx.test(a);
var isRgb = (a) => stringStartsWith(a, "rgb");
var isHsl = (a) => stringStartsWith(a, "hsl");
var isCol = (a) => isHex(a) || (isRgb(a) || isHsl(a)) && (a[a.length - 1] === ")" || !validRgbHslRgx.test(a));
var isKey = (a) => !globals.defaults.hasOwnProperty(a);
var svgCssReservedProperties = ["opacity", "rotate", "overflow", "color"];
var isValidSVGAttribute = (el, propertyName) => {
  if (svgCssReservedProperties.includes(propertyName)) return false;
  if (el.getAttribute(propertyName) || propertyName in el) {
    if (propertyName === "scale") {
      const elParentNode = (
        /** @type {SVGGeometryElement} */
        /** @type {DOMTarget} */
        el.parentNode
      );
      return elParentNode && elParentNode.tagName === "filter";
    }
    return true;
  }
};
var pow = Math.pow;
var sqrt = Math.sqrt;
var sin = Math.sin;
var cos = Math.cos;
var floor = Math.floor;
var asin = Math.asin;
var PI = Math.PI;
var _round = Math.round;
var clamp = (v, min, max) => v < min ? min : v > max ? max : v;
var round = (v, decimalLength) => {
  if (decimalLength < 0) return v;
  if (!decimalLength) return _round(v);
  const p = 10 ** decimalLength;
  return _round(v * p) / p;
};
var lerp = (start, end, factor) => factor === 1 ? end : factor === 0 ? start : start + (end - start) * factor;
var clampInfinity = (v) => v === Infinity ? maxValue : v === -Infinity ? -maxValue : v;
var normalizeTime = (v) => v <= minValue ? minValue : clampInfinity(round(v, 11));
var cloneArray = (a) => isArr(a) ? [...a] : a;
var mergeObjects = (o1, o2) => {
  const merged = (
    /** @type {T & U} */
    { ...o1 }
  );
  for (let p in o2) {
    const o1p = (
      /** @type {T & U} */
      o1[p]
    );
    merged[p] = isUnd(o1p) ? (
      /** @type {T & U} */
      o2[p]
    ) : o1p;
  }
  return merged;
};
var forEachChildren = (parent, callback, reverse, prevProp = "_prev", nextProp = "_next") => {
  let next = parent._head;
  let adjustedNextProp = nextProp;
  if (reverse) {
    next = parent._tail;
    adjustedNextProp = prevProp;
  }
  while (next) {
    const currentNext = next[adjustedNextProp];
    callback(next);
    next = currentNext;
  }
};
var removeChild = (parent, child, prevProp = "_prev", nextProp = "_next") => {
  const prev = child[prevProp];
  const next = child[nextProp];
  prev ? prev[nextProp] = next : parent._head = next;
  next ? next[prevProp] = prev : parent._tail = prev;
  child[prevProp] = null;
  child[nextProp] = null;
};
var addChild = (parent, child, sortMethod, prevProp = "_prev", nextProp = "_next") => {
  let prev = parent._tail;
  while (prev && sortMethod && sortMethod(prev, child)) prev = prev[prevProp];
  const next = prev ? prev[nextProp] : parent._head;
  prev ? prev[nextProp] = child : parent._head = child;
  next ? next[prevProp] = child : parent._tail = child;
  child[prevProp] = prev;
  child[nextProp] = next;
};

// node_modules/animejs/dist/modules/core/transforms.js
/**
 * Anime.js - core - ESM
 * @version v4.5.0
 * @license MIT
 * @copyright 2026 - Julian Garnier
 */
var parseInlineTransforms = (target, propName, animationInlineStyles) => {
  const inlineTransforms = target.style.transform;
  if (inlineTransforms) {
    const cachedTransforms = target[transformsSymbol];
    let pos = 0;
    const len = inlineTransforms.length;
    let fullTranslateValue;
    while (pos < len) {
      while (pos < len && inlineTransforms.charCodeAt(pos) === 32) pos++;
      if (pos >= len) break;
      const nameStart = pos;
      while (pos < len && inlineTransforms.charCodeAt(pos) !== 40) pos++;
      if (pos >= len) break;
      const name = inlineTransforms.substring(nameStart, pos);
      let depth = 1;
      const valueStart = pos + 1;
      let c1 = -1, c2 = -1;
      pos++;
      while (pos < len && depth > 0) {
        const c = inlineTransforms.charCodeAt(pos);
        if (c === 40) depth++;
        else if (c === 41) depth--;
        else if (c === 44 && depth === 1) {
          if (c1 === -1) c1 = pos;
          else if (c2 === -1) c2 = pos;
        }
        pos++;
      }
      const valueEnd = pos - 1;
      if (name === "translate" || name === "translate3d") {
        if (c1 === -1) {
          cachedTransforms.translateX = inlineTransforms.substring(valueStart, valueEnd).trim();
        } else {
          cachedTransforms.translateX = inlineTransforms.substring(valueStart, c1).trim();
          if (c2 === -1) {
            cachedTransforms.translateY = inlineTransforms.substring(c1 + 1, valueEnd).trim();
          } else {
            cachedTransforms.translateY = inlineTransforms.substring(c1 + 1, c2).trim();
            cachedTransforms.translateZ = inlineTransforms.substring(c2 + 1, valueEnd).trim();
          }
        }
        fullTranslateValue = inlineTransforms.substring(valueStart, valueEnd);
      } else if (name === "scale" || name === "scale3d") {
        if (c1 === -1) {
          cachedTransforms.scale = inlineTransforms.substring(valueStart, valueEnd).trim();
        } else {
          cachedTransforms.scaleX = inlineTransforms.substring(valueStart, c1).trim();
          if (c2 === -1) {
            cachedTransforms.scaleY = inlineTransforms.substring(c1 + 1, valueEnd).trim();
          } else {
            cachedTransforms.scaleY = inlineTransforms.substring(c1 + 1, c2).trim();
            cachedTransforms.scaleZ = inlineTransforms.substring(c2 + 1, valueEnd).trim();
          }
        }
      } else {
        cachedTransforms[name] = inlineTransforms.substring(valueStart, valueEnd);
      }
    }
    if (propName === "translate3d" && fullTranslateValue) {
      if (animationInlineStyles) animationInlineStyles[propName] = fullTranslateValue;
      return fullTranslateValue;
    }
    const cached = cachedTransforms[propName];
    if (!isUnd(cached)) {
      if (animationInlineStyles) animationInlineStyles[propName] = cached;
      return cached;
    }
  }
  return propName === "translate3d" ? "0px, 0px, 0px" : propName === "rotate3d" ? "0, 0, 0, 0deg" : stringStartsWith(propName, "scale") ? "1" : stringStartsWith(propName, "rotate") || stringStartsWith(propName, "skew") ? "0deg" : "0px";
};
var buildTransformString = (props) => {
  let str = emptyString;
  for (let i = 0, l = validTransforms.length; i < l; i++) {
    const key2 = validTransforms[i];
    const val = props[key2];
    if (val !== void 0) {
      if (key2 === "translateX") {
        const next = props.translateY;
        if (next !== void 0) {
          const next2 = props.translateZ;
          if (next2 !== void 0) {
            str += `translate3d(${val},${next},${next2}) `;
            i += 2;
          } else {
            str += `translate(${val},${next}) `;
            i += 1;
          }
          continue;
        }
      }
      if (key2 === "scaleX" && props.scale === void 0) {
        const next = props.scaleY;
        if (next !== void 0) {
          const next2 = props.scaleZ;
          if (next2 !== void 0) {
            str += `scale3d(${val},${next},${next2}) `;
            i += 2;
          } else {
            str += `scale(${val},${next}) `;
            i += 1;
          }
          continue;
        }
      }
      str += `${transformsFragmentStrings[key2]}${val}) `;
    }
    if (key2 === "rotateZ") {
      if (props.rotate3d !== void 0) str += `rotate3d(${props.rotate3d}) `;
    }
  }
  if (props.matrix !== void 0) str += `matrix(${props.matrix}) `;
  if (props.matrix3d !== void 0) str += `matrix3d(${props.matrix3d}) `;
  return str;
};

// node_modules/animejs/dist/modules/adapters/registry.js
/**
 * Anime.js - adapters - ESM
 * @version v4.5.0
 * @license MIT
 * @copyright 2026 - Julian Garnier
 */
var adapters = (
  /** @type {Adapter[]} */
  []
);
function resolveAdapterEntry(target, name) {
  if (!target) return null;
  const al = adapters.length;
  outer: for (let i = 0; i < al; i++) {
    const a = adapters[i];
    if (a.detect && !a.detect(target)) continue;
    const tas = a.targetAdapters;
    for (let j = 0, m = tas.length; j < m; j++) {
      const ta = tas[j];
      if (ta.detect(target)) {
        const entry = ta.props[name];
        if (entry && (!entry.gate || entry.gate(target))) return entry;
        break outer;
      }
    }
  }
  for (let i = 0; i < al; i++) {
    const a = adapters[i];
    if (a.detect && !a.detect(target)) continue;
    const rs = a.propertyResolvers;
    for (let j = 0, m = rs.length; j < m; j++) {
      const entry = rs[j](target, name);
      if (entry) return entry;
    }
  }
  return null;
}

// node_modules/animejs/dist/modules/core/colors.js
/**
 * Anime.js - core - ESM
 * @version v4.5.0
 * @license MIT
 * @copyright 2026 - Julian Garnier
 */
var rgbToRgba = (rgbValue) => {
  const rgba = rgbExecRgx.exec(rgbValue) || rgbaExecRgx.exec(rgbValue);
  const a = !isUnd(rgba[4]) ? +rgba[4] : 1;
  return [
    +rgba[1],
    +rgba[2],
    +rgba[3],
    a
  ];
};
var hexToRgba = (hexValue) => {
  const hexLength = hexValue.length;
  const isShort = hexLength === 4 || hexLength === 5;
  return [
    +("0x" + hexValue[1] + hexValue[isShort ? 1 : 2]),
    +("0x" + hexValue[isShort ? 2 : 3] + hexValue[isShort ? 2 : 4]),
    +("0x" + hexValue[isShort ? 3 : 5] + hexValue[isShort ? 3 : 6]),
    hexLength === 5 || hexLength === 9 ? +(+("0x" + hexValue[isShort ? 4 : 7] + hexValue[isShort ? 4 : 8]) / 255).toFixed(3) : 1
  ];
};
var hue2rgb = (p, q, t) => {
  if (t < 0) t += 1;
  if (t > 1) t -= 1;
  return t < 1 / 6 ? p + (q - p) * 6 * t : t < 1 / 2 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p;
};
var hslToRgba = (hslValue) => {
  const hsla = hslExecRgx.exec(hslValue) || hslaExecRgx.exec(hslValue);
  const h = +hsla[1] / 360;
  const s = +hsla[2] / 100;
  const l = +hsla[3] / 100;
  const a = !isUnd(hsla[4]) ? +hsla[4] : 1;
  let r, g, b;
  if (s === 0) {
    r = g = b = l;
  } else {
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = round(hue2rgb(p, q, h + 1 / 3) * 255, 0);
    g = round(hue2rgb(p, q, h) * 255, 0);
    b = round(hue2rgb(p, q, h - 1 / 3) * 255, 0);
  }
  return [r, g, b, a];
};
var convertColorStringValuesToRgbaArray = (colorString) => {
  return isRgb(colorString) ? rgbToRgba(colorString) : isHex(colorString) ? hexToRgba(colorString) : isHsl(colorString) ? hslToRgba(colorString) : [0, 0, 0, 1];
};

// node_modules/animejs/dist/modules/core/values.js
/**
 * Anime.js - core - ESM
 * @version v4.5.0
 * @license MIT
 * @copyright 2026 - Julian Garnier
 */
var setValue = (targetValue, defaultValue) => {
  return isUnd(targetValue) ? defaultValue : targetValue;
};
var resolveCssVar = (value, target) => {
  const match = value.match(cssVariableMatchRgx);
  const el = target[isDomSymbol] ? target : document.documentElement;
  let computed = getComputedStyle(
    /** @type {HTMLElement} */
    el
  )?.getPropertyValue(match[1]);
  if ((!computed || computed.trim() === emptyString) && match[2]) computed = match[2].trim();
  return computed || 0;
};
var getFunctionValue = (value, target, index, targets, store, prevTween) => {
  if (isFnc(value)) {
    if (!store) {
      const computed = (
        /** @type {Function} */
        value(target, index, targets, prevTween)
      );
      return !isNaN(+computed) ? +computed : computed || 0;
    }
    const func = () => {
      const computed = (
        /** @type {Function} */
        value(target, index, targets, prevTween)
      );
      return !isNaN(+computed) ? +computed : computed || 0;
    };
    store.func = func;
    return func();
  }
  if (isStr(value) && stringStartsWith(value, cssVarPrefix)) {
    if (!store) return resolveCssVar(
      /** @type {String} */
      value,
      target
    );
    const func = () => resolveCssVar(
      /** @type {String} */
      value,
      target
    );
    store.func = func;
    return func();
  }
  return value;
};
var getTweenType = (target, prop) => {
  return !target[isDomSymbol] ? tweenTypes.OBJECT : (
    // Handle SVG attributes
    target[isSvgSymbol] && isValidSVGAttribute(target, prop) ? tweenTypes.ATTRIBUTE : (
      // Handle CSS Transform properties differently than CSS to allow individual animations
      validTransforms.includes(prop) || shortTransforms.get(prop) ? tweenTypes.TRANSFORM : (
        // CSS variables
        stringStartsWith(prop, "--") ? tweenTypes.CSS_VAR : (
          // All other CSS properties
          prop in /** @type {DOMTarget} */
          target.style ? tweenTypes.CSS : (
            // Handle other DOM Attributes
            prop in target ? tweenTypes.OBJECT : tweenTypes.ATTRIBUTE
          )
        )
      )
    )
  );
};
var getCSSValue = (target, propName, animationInlineStyles) => {
  const inlineStyles = target.style[propName];
  if (inlineStyles && animationInlineStyles) {
    animationInlineStyles[propName] = inlineStyles;
  }
  const value = inlineStyles || getComputedStyle(target[proxyTargetSymbol] || target).getPropertyValue(propName);
  return value === "auto" ? "0" : value;
};
var getOriginalAnimatableValue = (target, propName, tweenType, animationInlineStyles) => {
  const type = !isUnd(tweenType) ? tweenType : getTweenType(target, propName);
  const adapterProp = resolveAdapterEntry(target, propName);
  if (adapterProp) {
    const value = adapterProp.get(target);
    if (value && animationInlineStyles) animationInlineStyles[propName] = value;
    return value == null ? 0 : value;
  }
  if (type === tweenTypes.OBJECT) {
    const value = target[propName];
    if (value && animationInlineStyles) animationInlineStyles[propName] = value;
    return value || 0;
  }
  if (type === tweenTypes.ATTRIBUTE) {
    const value = (
      /** @type {DOMTarget} */
      target.getAttribute(propName)
    );
    if (value && animationInlineStyles) animationInlineStyles[propName] = value;
    return value;
  }
  return type === tweenTypes.TRANSFORM ? parseInlineTransforms(
    /** @type {DOMTarget} */
    target,
    propName,
    animationInlineStyles
  ) : type === tweenTypes.CSS_VAR ? getCSSValue(
    /** @type {DOMTarget} */
    target,
    propName,
    animationInlineStyles
  ).trimStart() : getCSSValue(
    /** @type {DOMTarget} */
    target,
    propName,
    animationInlineStyles
  );
};
var getRelativeValue = (x, y, operator) => {
  return operator === "-" ? x - y : operator === "+" ? x + y : x * y;
};
var createDecomposedValueTargetObject = () => {
  return {
    /** @type {valueTypes} */
    t: valueTypes.NUMBER,
    n: 0,
    u: null,
    o: null,
    d: null,
    s: null
  };
};
var decomposeRawValue = (rawValue, targetObject) => {
  targetObject.t = valueTypes.NUMBER;
  targetObject.n = 0;
  targetObject.u = null;
  targetObject.o = null;
  targetObject.d = null;
  targetObject.s = null;
  if (!rawValue) return targetObject;
  const num = +rawValue;
  if (!isNaN(num)) {
    targetObject.n = num;
    return targetObject;
  }
  let str = (
    /** @type {String} */
    rawValue
  );
  if (str[1] === "=") {
    targetObject.o = str[0];
    str = str.slice(2);
  }
  const unitMatch = str.includes(" ") ? false : unitsExecRgx.exec(str);
  if (unitMatch) {
    targetObject.t = valueTypes.UNIT;
    targetObject.n = +unitMatch[1];
    targetObject.u = unitMatch[2];
    return targetObject;
  } else if (targetObject.o) {
    targetObject.n = +str;
    return targetObject;
  } else if (isCol(str)) {
    targetObject.t = valueTypes.COLOR;
    targetObject.d = convertColorStringValuesToRgbaArray(str);
    return targetObject;
  } else {
    const matchedNumbers = str.match(digitWithExponentRgx);
    targetObject.t = valueTypes.COMPLEX;
    targetObject.d = matchedNumbers ? matchedNumbers.map(Number) : [];
    targetObject.s = str.split(digitWithExponentRgx) || [];
    return targetObject;
  }
};
var decomposeTweenValue = (tween, targetObject) => {
  targetObject.t = tween._valueType;
  targetObject.n = tween._toNumber;
  targetObject.u = tween._unit;
  targetObject.o = null;
  targetObject.d = cloneArray(tween._toNumbers);
  targetObject.s = cloneArray(tween._strings);
  return targetObject;
};
var decomposedOriginalValue = createDecomposedValueTargetObject();
var composeComplexValue = (tween, progress, precision) => {
  const mod = tween._modifier;
  const fn = tween._fromNumbers;
  const tn = tween._toNumbers;
  const ts = tween._strings;
  let v = ts[0];
  for (let j = 0, l = tn.length; j < l; j++) {
    const n = (
      /** @type {Number} */
      mod(round(lerp(fn[j], tn[j], progress), precision))
    );
    const s = ts[j + 1];
    v += `${s ? n + s : n}`;
    tween._numbers[j] = n;
  }
  return v;
};

// node_modules/animejs/dist/modules/core/targets.js
/**
 * Anime.js - core - ESM
 * @version v4.5.0
 * @license MIT
 * @copyright 2026 - Julian Garnier
 */
function getNodeList(v) {
  const n = isStr(v) ? scope.root.querySelectorAll(v) : v;
  if (n instanceof NodeList || n instanceof HTMLCollection) return n;
}
function parseTargets(targets) {
  if (isNil(targets)) return (
    /** @type {TargetsArray} */
    []
  );
  if (!isBrowser) return (
    /** @type {JSTargetsArray} */
    isArr(targets) && targets.flat(Infinity) || [targets]
  );
  if (isArr(targets)) {
    const flattened = targets.flat(Infinity);
    const parsed = [];
    for (let i = 0, l = flattened.length; i < l; i++) {
      const item = flattened[i];
      if (!isNil(item)) {
        const nodeList2 = getNodeList(item);
        if (nodeList2) {
          for (let j = 0, jl = nodeList2.length; j < jl; j++) {
            const subItem = nodeList2[j];
            if (!isNil(subItem)) {
              let isDuplicate = false;
              for (let k = 0, kl = parsed.length; k < kl; k++) {
                if (parsed[k] === subItem) {
                  isDuplicate = true;
                  break;
                }
              }
              if (!isDuplicate) {
                parsed.push(subItem);
              }
            }
          }
        } else {
          let isDuplicate = false;
          for (let j = 0, jl = parsed.length; j < jl; j++) {
            if (parsed[j] === item) {
              isDuplicate = true;
              break;
            }
          }
          if (!isDuplicate) {
            parsed.push(item);
          }
        }
      }
    }
    return parsed;
  }
  const nodeList = getNodeList(targets);
  if (nodeList) return (
    /** @type {DOMTargetsArray} */
    Array.from(nodeList)
  );
  return (
    /** @type {TargetsArray} */
    [targets]
  );
}
function registerTargets(targets) {
  const parsedTargetsArray = parseTargets(targets);
  const parsedTargetsLength = parsedTargetsArray.length;
  for (let i = 0; i < parsedTargetsLength; i++) {
    const target = parsedTargetsArray[i];
    if (!target[isRegisteredTargetSymbol]) {
      target[isRegisteredTargetSymbol] = true;
      const isSvgType = isSvg(target);
      const isDom = (
        /** @type {DOMTarget} */
        target.nodeType || isSvgType
      );
      if (isDom) {
        target[isDomSymbol] = true;
        target[isSvgSymbol] = isSvgType;
        target[transformsSymbol] = {};
      }
    }
  }
  return parsedTargetsArray;
}

// node_modules/animejs/dist/modules/core/render.js
/**
 * Anime.js - core - ESM
 * @version v4.5.0
 * @license MIT
 * @copyright 2026 - Julian Garnier
 */
var render = (tickable, time, muteCallbacks, internalRender, tickMode) => {
  const parent = tickable.parent;
  const duration = tickable.duration;
  const completed = tickable.completed;
  const iterationDuration = tickable.iterationDuration;
  const iterationCount = tickable.iterationCount;
  const _currentIteration = tickable._currentIteration;
  const _loopDelay = tickable._loopDelay;
  const _reversed = tickable._reversed;
  const _alternate = tickable._alternate;
  const _hasChildren = tickable._hasChildren;
  const tickableDelay = tickable._delay;
  const tickablePrevAbsoluteTime = tickable._currentTime;
  const tickableEndTime = tickableDelay + iterationDuration;
  const tickableAbsoluteTime = time - tickableDelay;
  const tickablePrevTime = clamp(tickablePrevAbsoluteTime, -tickableDelay, duration);
  const tickableCurrentTime = clamp(tickableAbsoluteTime, -tickableDelay, duration);
  const deltaTime = tickableAbsoluteTime - tickablePrevAbsoluteTime;
  const isCurrentTimeAboveZero = tickableCurrentTime > 0;
  const isCurrentTimeEqualOrAboveDuration = tickableCurrentTime >= duration;
  const isSetter = duration <= minValue;
  const forcedTick = tickMode === tickModes.FORCE;
  let isOdd = 0;
  let iterationElapsedTime = tickableAbsoluteTime;
  let hasRendered = 0;
  if (iterationCount > 1) {
    const period = iterationDuration + (isCurrentTimeEqualOrAboveDuration ? 0 : _loopDelay);
    const currentIteration = ~~(tickableCurrentTime / period);
    tickable._currentIteration = clamp(currentIteration, 0, iterationCount);
    if (isCurrentTimeEqualOrAboveDuration) tickable._currentIteration--;
    isOdd = tickable._currentIteration % 2;
    iterationElapsedTime = tickableCurrentTime - currentIteration * period || 0;
  }
  const isReversed = _reversed ^ (_alternate && isOdd);
  const _ease = (
    /** @type {Renderable} */
    tickable._ease
  );
  let iterationTime = isCurrentTimeEqualOrAboveDuration ? isReversed ? 0 : duration : isReversed ? iterationDuration - iterationElapsedTime : iterationElapsedTime;
  if (_ease) iterationTime = iterationDuration * _ease(iterationTime / iterationDuration) || 0;
  const isRunningBackwards = (parent ? parent.backwards : tickableAbsoluteTime < tickablePrevAbsoluteTime) ? !isReversed : !!isReversed;
  tickable._currentTime = tickableAbsoluteTime;
  tickable._iterationTime = iterationTime;
  tickable.backwards = isRunningBackwards;
  if (isCurrentTimeAboveZero && !tickable.began) {
    tickable.began = true;
    if (!muteCallbacks && !(parent && (isRunningBackwards || !parent.began))) {
      tickable.onBegin(
        /** @type {CallbackArgument} */
        tickable
      );
    }
  } else if (tickableAbsoluteTime <= 0) {
    tickable.began = false;
  }
  if (!muteCallbacks && !_hasChildren && isCurrentTimeAboveZero && tickable._currentIteration !== _currentIteration) {
    tickable.onLoop(
      /** @type {CallbackArgument} */
      tickable
    );
  }
  if (forcedTick || tickMode === tickModes.AUTO && // Timeline children render from their offset instead of their delay so the gap left by a truncated sibling is covered on seek.
  (time >= (parent && tickableDelay > 0 ? 0 : tickableDelay) && time <= tickableEndTime || // Normal render
  time <= tickableDelay && tickablePrevTime > tickableDelay || // Playhead is before the animation start time so make sure the animation is at its initial state
  time >= tickableEndTime && tickablePrevTime !== duration) || iterationTime >= tickableEndTime && tickablePrevTime !== duration || // iterationTime is per-iteration, compared to the delay to catch a backward seek into a looped iteration's delay region. Exclude the final settled end, where iterationTime clamps to duration and would falsely match the delay region when the delay exceeds the duration.
  iterationTime <= tickableDelay && tickablePrevTime > 0 && !isCurrentTimeEqualOrAboveDuration || time <= tickablePrevTime && tickablePrevTime === duration && completed || // Force a render if a seek occurs on an completed animation
  isCurrentTimeEqualOrAboveDuration && !completed && isSetter) {
    if (isCurrentTimeAboveZero) {
      tickable.computeDeltaTime(tickablePrevTime);
      if (!muteCallbacks) tickable.onBeforeUpdate(
        /** @type {CallbackArgument} */
        tickable
      );
    }
    if (!_hasChildren) {
      const forcedRender = forcedTick || (isRunningBackwards ? deltaTime * -1 : deltaTime) >= globals.tickThreshold;
      const absoluteTime = round(tickable._offset + (parent ? parent._offset : 0) + tickableDelay + iterationTime, 12);
      let tween = (
        /** @type {Tween} */
        /** @type {JSAnimation} */
        tickable._head
      );
      let tweenTarget;
      let tweenStyle;
      let tweenTargetTransforms;
      let tweenTargetTransformsProperties;
      let tweenTransformsNeedUpdate = 0;
      while (tween) {
        const tweenComposition = tween._composition;
        const tweenCurrentTime = tween._currentTime;
        const tweenChangeDuration = tween._changeDuration;
        const tweenAbsEndTime = tween._absoluteStartTime + tween._changeDuration;
        const tweenNextRep = tween._nextRep;
        const tweenPrevRep = tween._prevRep;
        const tweenHasComposition = tweenComposition !== compositionTypes.none;
        const tweenPrevRepEndTime = tweenPrevRep ? tweenPrevRep._absoluteStartTime + tweenPrevRep._changeDuration : 0;
        const tweenPrevRepIsCrossParent = tweenPrevRep && tweenPrevRep.parent !== tween.parent;
        const tweenNextRepTakeover = !tweenNextRep || tweenNextRep._isOverridden ? tweenAbsEndTime : tweenNextRep.parent === tween.parent ? tweenAbsEndTime + tweenNextRep._delay : tweenNextRep._absoluteStartTime < tweenNextRep._absoluteUpdateStartTime ? tweenNextRep._absoluteStartTime : tweenNextRep._absoluteUpdateStartTime;
        if ((forcedRender || // Tail keyframes always re-evaluate the gate so an earlier keyframe cannot leave the target stale by writing past its own range after a backward seek.
        (tweenCurrentTime !== tweenChangeDuration || absoluteTime <= tweenNextRepTakeover || tweenPrevRep && !tweenPrevRepIsCrossParent && (!tweenNextRep || tweenNextRep.parent !== tween.parent)) && // A cross parent tween re-renders its from value from the previous sibling truncated end so the handoff gap holds.
        // A keyframe re-renders its from revert while the next keyframe time is stale so a backward jump over its range cannot leave the next value in place.
        (tweenCurrentTime !== 0 || absoluteTime >= tween._absoluteStartTime || tweenPrevRepIsCrossParent && !tween._hasFromValue && !tweenPrevRep._isOverridden && absoluteTime >= tweenPrevRepEndTime || tweenNextRep && !tweenNextRep._isOverridden && tweenNextRep.parent === tween.parent && tweenNextRep._currentTime !== 0 && iterationTime < tweenNextRep._startTime)) && // Non-first keyframes wait until the iteration reaches their own start before rendering, so the previous keyframe can handle the from-revert when scrubbed backward past this tween's range.
        (!tweenPrevRep || tweenPrevRepIsCrossParent || iterationTime >= tween._startTime) && (!tweenHasComposition || !tween._isOverridden && (!tween._isOverlapped || absoluteTime <= tweenAbsEndTime) && // The next sibling owns the value past its takeover point, so yielding there keeps writes single owner in both directions.
        (!tweenNextRep || tweenNextRep._isOverridden || absoluteTime <= tweenNextRepTakeover) && // The previous sibling owns the value up to its truncated end.
        // Cross parent tweens take over the hold from that point, explicit from values wait for their own start.
        (!tweenPrevRep || (tweenPrevRep._isOverridden || (!tweenPrevRepIsCrossParent ? absoluteTime >= tweenPrevRepEndTime + tween._delay : absoluteTime >= tween._absoluteStartTime || !tween._hasFromValue && absoluteTime >= tweenPrevRepEndTime))))) {
          const tweenNewTime = tween._currentTime = clamp(iterationTime - tween._startTime, 0, tweenChangeDuration);
          const tweenProgress = tween._ease(tweenNewTime / tween._updateDuration);
          const tweenModifier = tween._modifier;
          const tweenValueType = tween._valueType;
          const tweenType = tween._tweenType;
          const tweenIsObject = tweenType === tweenTypes.OBJECT;
          const tweenIsNumber = tweenValueType === valueTypes.NUMBER;
          const tweenPrecision = tweenIsNumber && tweenIsObject || tweenProgress === 0 || tweenProgress === 1 ? -1 : globals.precision;
          let value;
          let number;
          if (tweenIsNumber) {
            value = number = /** @type {Number} */
            tweenModifier(round(lerp(tween._fromNumber, tween._toNumber, tweenProgress), tweenPrecision));
          } else if (tweenValueType === valueTypes.UNIT) {
            number = /** @type {Number} */
            tweenModifier(round(lerp(tween._fromNumber, tween._toNumber, tweenProgress), tweenPrecision));
            value = `${number}${tween._unit}`;
          } else if (tweenValueType === valueTypes.COLOR) {
            const ns = tween._numbers;
            const fn = tween._fromNumbers;
            const tn = tween._toNumbers;
            const omt = 1 - tweenProgress;
            const fr = fn[0], fg = fn[1], fb = fn[2];
            const tr = tn[0], tg = tn[1], tb = tn[2];
            ns[0] = /** @type {Number} */
            tweenModifier(Math.sqrt(fr * fr * omt + tr * tr * tweenProgress));
            ns[1] = /** @type {Number} */
            tweenModifier(Math.sqrt(fg * fg * omt + tg * tg * tweenProgress));
            ns[2] = /** @type {Number} */
            tweenModifier(Math.sqrt(fb * fb * omt + tb * tb * tweenProgress));
            ns[3] = /** @type {Number} */
            tweenModifier(lerp(fn[3], tn[3], tweenProgress));
            if (!tween._setter || internalRender) {
              value = `rgba(${round(ns[0], 0)},${round(ns[1], 0)},${round(ns[2], 0)},${ns[3]})`;
            }
          } else if (tweenValueType === valueTypes.COMPLEX) {
            value = composeComplexValue(tween, tweenProgress, tweenPrecision);
          }
          if (tweenHasComposition) {
            tween._number = number;
          }
          if (!internalRender && tweenComposition !== compositionTypes.blend) {
            const tweenProperty = tween.property;
            tweenTarget = tween.target;
            if (tween._setter) {
              tween._setter(tweenTarget, number, tween);
            } else if (tweenIsObject) {
              tweenTarget[tweenProperty] = value;
            } else if (tweenType === tweenTypes.ATTRIBUTE) {
              tweenTarget.setAttribute(
                tweenProperty,
                /** @type {String} */
                value
              );
            } else {
              tweenStyle = /** @type {DOMTarget} */
              tweenTarget.style;
              if (tweenType === tweenTypes.TRANSFORM) {
                if (tweenTarget !== tweenTargetTransforms) {
                  tweenTargetTransforms = tweenTarget;
                  tweenTargetTransformsProperties = tweenTarget[transformsSymbol];
                }
                tweenTargetTransformsProperties[tweenProperty] = value;
                tweenTransformsNeedUpdate = 1;
              } else if (tweenType === tweenTypes.CSS) {
                tweenStyle[tweenProperty] = value;
              } else if (tweenType === tweenTypes.CSS_VAR) {
                tweenStyle.setProperty(
                  tweenProperty,
                  /** @type {String} */
                  value
                );
              }
            }
            if (isCurrentTimeAboveZero) hasRendered = 1;
          } else {
            tween._value = value;
          }
        } else if (tweenCurrentTime && tweenPrevRep && !tweenPrevRepIsCrossParent && iterationTime < tween._startTime) {
          tween._currentTime = 0;
        }
        if (tweenTransformsNeedUpdate && tween._renderTransforms) {
          tweenStyle.transform = buildTransformString(tweenTargetTransformsProperties);
          tweenTransformsNeedUpdate = 0;
        }
        tween = tween._next;
      }
      if (!muteCallbacks && hasRendered) {
        tickable.onRender(
          /** @type {JSAnimation} */
          tickable
        );
      }
    }
    if (!muteCallbacks && isCurrentTimeAboveZero) {
      tickable.onUpdate(
        /** @type {CallbackArgument} */
        tickable
      );
    }
  }
  if (parent && isSetter) {
    if (!muteCallbacks && // (tickableAbsoluteTime > 0 instead) of (tickableAbsoluteTime >= duration) to prevent floating point precision issues
    // see: https://github.com/juliangarnier/anime/issues/1088
    (parent.began && !isRunningBackwards && tickableAbsoluteTime > 0 && !completed || isRunningBackwards && tickableAbsoluteTime <= minValue && completed)) {
      tickable.onComplete(
        /** @type {CallbackArgument} */
        tickable
      );
      tickable.completed = !isRunningBackwards;
    }
  } else if (isCurrentTimeAboveZero && isCurrentTimeEqualOrAboveDuration) {
    if (iterationCount === Infinity) {
      tickable._startTime += tickable.duration;
    } else if (tickable._currentIteration >= iterationCount - 1) {
      tickable.paused = true;
      if (!completed && !_hasChildren) {
        tickable.completed = true;
        if (!muteCallbacks && !(parent && (isRunningBackwards || !parent.began))) {
          tickable.onComplete(
            /** @type {CallbackArgument} */
            tickable
          );
          tickable._resolve(
            /** @type {CallbackArgument} */
            tickable
          );
        }
      }
    }
  } else {
    tickable.completed = false;
  }
  return hasRendered;
};
var tick = (tickable, time, muteCallbacks, internalRender, tickMode) => {
  const _currentIteration = tickable._currentIteration;
  render(tickable, time, muteCallbacks, internalRender, tickMode);
  if (tickable._hasChildren) {
    const tl = (
      /** @type {Timeline} */
      tickable
    );
    const tlIsRunningBackwards = tl.backwards;
    const tlChildrenTime = internalRender ? time : tl._iterationTime;
    const tlCildrenTickTime = now();
    let tlChildrenHasRendered = 0;
    let tlChildrenHaveCompleted = true;
    if (!internalRender && tl._currentIteration !== _currentIteration) {
      const tlIterationDuration = tl.iterationDuration;
      forEachChildren(tl, (child) => {
        if (!tlIsRunningBackwards) {
          if (!child.completed && !child.backwards && child._currentTime < child.iterationDuration) {
            render(child, tlIterationDuration, muteCallbacks, 1, tickModes.FORCE);
          }
          child.began = false;
          child.completed = false;
        } else {
          const childDuration = child.duration;
          const childStartTime = child._offset + child._delay;
          const childEndTime = childStartTime + childDuration;
          if (!muteCallbacks && childDuration <= minValue && (!childStartTime || childEndTime === tlIterationDuration)) {
            child.onComplete(child);
          }
        }
      });
      if (!muteCallbacks) tl.onLoop(
        /** @type {CallbackArgument} */
        tl
      );
    }
    forEachChildren(tl, (child) => {
      const childTime = round((tlChildrenTime - child._offset) * child._speed, 12);
      if (tlIsRunningBackwards && childTime > child._delay + child.duration) return;
      const childTickMode = child._fps < tl._fps ? child.requestTick(tlCildrenTickTime) : tickMode;
      tlChildrenHasRendered += render(child, childTime, muteCallbacks, internalRender, childTickMode);
      if (!child.completed && tlChildrenHaveCompleted) tlChildrenHaveCompleted = false;
    }, tlIsRunningBackwards);
    if (!muteCallbacks && tlChildrenHasRendered) tl.onRender(
      /** @type {CallbackArgument} */
      tl
    );
    if ((tlChildrenHaveCompleted || tlIsRunningBackwards) && tl._currentTime >= tl.duration) {
      tl.paused = true;
      if (!tl.completed) {
        tl.completed = true;
        if (!muteCallbacks) {
          tl.onComplete(
            /** @type {CallbackArgument} */
            tl
          );
          tl._resolve(
            /** @type {CallbackArgument} */
            tl
          );
        }
      }
    }
  }
};

// node_modules/animejs/dist/modules/core/styles.js
/**
 * Anime.js - core - ESM
 * @version v4.5.0
 * @license MIT
 * @copyright 2026 - Julian Garnier
 */
var propertyNamesCache = {};
var sanitizePropertyName = (propertyName, target, tweenType) => {
  if (tweenType === tweenTypes.TRANSFORM) {
    const t = shortTransforms.get(propertyName);
    return t ? t : propertyName;
  } else if (tweenType === tweenTypes.CSS || // Handle special cases where properties like "strokeDashoffset" needs to be set as "stroke-dashoffset"
  // but properties like "baseFrequency" should stay in lowerCamelCase
  tweenType === tweenTypes.ATTRIBUTE && (isSvg(target) && propertyName in /** @type {DOMTarget} */
  target.style)) {
    const cachedPropertyName = propertyNamesCache[propertyName];
    if (cachedPropertyName) {
      return cachedPropertyName;
    } else {
      const lowerCaseName = propertyName ? toLowerCase(propertyName) : propertyName;
      propertyNamesCache[propertyName] = lowerCaseName;
      return lowerCaseName;
    }
  } else {
    return propertyName;
  }
};
var revertValues = (renderable, inlineStylesOnly = false) => {
  if (renderable._hasChildren) {
    forEachChildren(renderable, (child) => revertValues(child, inlineStylesOnly), true);
  } else {
    const animation = (
      /** @type {JSAnimation} */
      renderable
    );
    animation.pause();
    forEachChildren(animation, (tween) => {
      const tweenProperty = tween.property;
      const tweenTarget = tween.target;
      const tweenType = tween._tweenType;
      const originalInlinedValue = tween._inlineValue;
      const tweenHadNoInlineValue = isNil(originalInlinedValue) || originalInlinedValue === emptyString;
      if (tween._setter) {
        if (!inlineStylesOnly && !tweenHadNoInlineValue) {
          decomposeRawValue(originalInlinedValue, decomposedOriginalValue);
          if (decomposedOriginalValue.d) {
            const src = decomposedOriginalValue.d;
            const dst = tween._numbers;
            for (let i = 0, l = src.length; i < l; i++) dst[i] = src[i];
          } else {
            tween._number = decomposedOriginalValue.n;
          }
          tween._setter(tween.target, tween._number, tween);
        }
      } else if (tweenType === tweenTypes.OBJECT) {
        if (!inlineStylesOnly && !tweenHadNoInlineValue) {
          tweenTarget[tweenProperty] = originalInlinedValue;
        }
      } else if (tweenTarget[isDomSymbol]) {
        if (tweenType === tweenTypes.ATTRIBUTE) {
          if (!inlineStylesOnly) {
            if (tweenHadNoInlineValue) {
              tweenTarget.removeAttribute(tweenProperty);
            } else {
              tweenTarget.setAttribute(
                tweenProperty,
                /** @type {String} */
                originalInlinedValue
              );
            }
          }
        } else {
          const targetStyle = (
            /** @type {DOMTarget} */
            tweenTarget.style
          );
          if (tweenType === tweenTypes.TRANSFORM) {
            const cachedTransforms = tweenTarget[transformsSymbol];
            if (tweenHadNoInlineValue) {
              delete cachedTransforms[tweenProperty];
            } else {
              cachedTransforms[tweenProperty] = originalInlinedValue;
            }
            if (tween._renderTransforms) {
              if (!Object.keys(cachedTransforms).length) {
                targetStyle.removeProperty("transform");
              } else {
                targetStyle.transform = buildTransformString(cachedTransforms);
              }
            }
          } else {
            if (tweenHadNoInlineValue) {
              targetStyle.removeProperty(toLowerCase(tweenProperty));
            } else {
              targetStyle[tweenProperty] = originalInlinedValue;
            }
          }
        }
      }
      if (tweenTarget[isDomSymbol] && animation._tail === tween) {
        animation.targets.forEach((t) => {
          if (t.getAttribute && t.getAttribute("style") === emptyString) {
            t.removeAttribute("style");
          }
        });
      }
    });
  }
  return renderable;
};

// node_modules/animejs/dist/modules/core/clock.js
/**
 * Anime.js - core - ESM
 * @version v4.5.0
 * @license MIT
 * @copyright 2026 - Julian Garnier
 */
var Clock = class {
  /** @param {Number} [initTime] */
  constructor(initTime = 0) {
    this.deltaTime = 0;
    this._currentTime = initTime;
    this._lastTickTime = initTime;
    this._startTime = initTime;
    this._lastTime = initTime;
    this._frameDuration = K / maxFps;
    this._fps = maxFps;
    this._speed = 1;
    this._hasChildren = false;
    this._head = null;
    this._tail = null;
  }
  get fps() {
    return this._fps;
  }
  set fps(frameRate) {
    const fr = +frameRate;
    const fps = fr < minValue ? minValue : fr;
    const frameDuration = K / fps;
    if (fps > defaults.frameRate) defaults.frameRate = fps;
    this._fps = fps;
    this._frameDuration = frameDuration;
  }
  get speed() {
    return this._speed;
  }
  set speed(playbackRate) {
    const pbr = +playbackRate;
    this._speed = pbr < minValue ? minValue : pbr;
  }
  /**
   * @param  {Number} time
   * @return {tickModes}
   */
  requestTick(time) {
    const frameDuration = this._frameDuration;
    const elapsed = time - this._lastTickTime;
    const scaled = frameDuration * 0.25;
    const tolerance = scaled < 4 ? scaled : 4;
    if (elapsed + tolerance < frameDuration) return tickModes.NONE;
    this._lastTickTime = elapsed >= frameDuration ? time - elapsed % frameDuration : time;
    return tickModes.AUTO;
  }
  /**
   * @param  {Number} time
   * @return {Number}
   */
  computeDeltaTime(time) {
    const delta = time - this._lastTime;
    this.deltaTime = delta;
    this._lastTime = time;
    return delta;
  }
};

// node_modules/animejs/dist/modules/animation/additive.js
/**
 * Anime.js - animation - ESM
 * @version v4.5.0
 * @license MIT
 * @copyright 2026 - Julian Garnier
 */
var additive = {
  animation: null,
  update: noop
};
var addAdditiveAnimation = (lookups2) => {
  let animation = additive.animation;
  if (!animation) {
    animation = {
      duration: minValue,
      computeDeltaTime: noop,
      _offset: 0,
      _delay: 0,
      _head: null,
      _tail: null
    };
    additive.animation = animation;
    additive.update = () => {
      lookups2.forEach((propertyAnimation) => {
        for (let propertyName in propertyAnimation) {
          const tweens = propertyAnimation[propertyName];
          const lookupTween = tweens._head;
          if (lookupTween) {
            const valueType = lookupTween._valueType;
            const additiveValues = valueType === valueTypes.COMPLEX || valueType === valueTypes.COLOR ? cloneArray(lookupTween._fromNumbers) : null;
            let additiveValue = lookupTween._fromNumber;
            let tween = tweens._tail;
            while (tween && tween !== lookupTween) {
              if (additiveValues) {
                for (let i = 0, l = tween._numbers.length; i < l; i++) additiveValues[i] += tween._numbers[i];
              } else {
                additiveValue += tween._number;
              }
              tween = tween._prevAdd;
            }
            lookupTween._toNumber = additiveValue;
            lookupTween._toNumbers = additiveValues;
          }
        }
      });
      render(animation, 1, 1, 0, tickModes.FORCE);
    };
  }
  return animation;
};

// node_modules/animejs/dist/modules/engine/engine.js
/**
 * Anime.js - engine - ESM
 * @version v4.5.0
 * @license MIT
 * @copyright 2026 - Julian Garnier
 */
var engineTickMethod = /* @__PURE__ */ (() => isBrowser ? requestAnimationFrame : setImmediate)();
var engineCancelMethod = /* @__PURE__ */ (() => isBrowser ? cancelAnimationFrame : clearImmediate)();
var Engine = class extends Clock {
  /** @param {Number} [initTime] */
  constructor(initTime) {
    super(initTime);
    this.useDefaultMainLoop = true;
    this.pauseOnDocumentHidden = true;
    this.defaults = defaults;
    this.paused = true;
    this.reqId = 0;
  }
  update() {
    const time = this._currentTime = now();
    if (this.requestTick(time)) {
      this.computeDeltaTime(time);
      const engineSpeed = this._speed;
      const engineFps = this._fps;
      let activeTickable = (
        /** @type {Tickable} */
        this._head
      );
      while (activeTickable) {
        const nextTickable = activeTickable._next;
        if (!activeTickable.paused) {
          tick(
            activeTickable,
            (time - activeTickable._startTime) * activeTickable._speed * engineSpeed,
            0,
            // !muteCallbacks
            0,
            // !internalRender
            activeTickable._fps < engineFps ? activeTickable.requestTick(time) : tickModes.AUTO
          );
        } else {
          removeChild(this, activeTickable);
          this._hasChildren = !!this._tail;
          activeTickable._running = false;
          if (activeTickable.completed && !activeTickable._cancelled) {
            activeTickable.cancel();
          }
        }
        activeTickable = nextTickable;
      }
      additive.update();
    }
  }
  wake() {
    if (this.useDefaultMainLoop && !this.reqId) {
      this.requestTick(now());
      this.reqId = engineTickMethod(tickEngine);
    }
    return this;
  }
  pause() {
    if (!this.reqId) return;
    this.paused = true;
    return killEngine();
  }
  resume() {
    if (!this.paused) return;
    this.paused = false;
    forEachChildren(this, (child) => child.resetTime());
    return this.wake();
  }
  // Getter and setter for speed
  get speed() {
    return this._speed * (globals.timeScale === 1 ? 1 : K);
  }
  set speed(playbackRate) {
    const speed = playbackRate * globals.timeScale;
    if (this._speed === speed) return;
    this._speed = speed;
    forEachChildren(this, (child) => child.speed = child._speed);
  }
  // Getter and setter for timeUnit
  get timeUnit() {
    return globals.timeScale === 1 ? "ms" : "s";
  }
  set timeUnit(unit) {
    const secondsScale = 1e-3;
    const isSecond = unit === "s";
    const newScale = isSecond ? secondsScale : 1;
    if (globals.timeScale !== newScale) {
      globals.timeScale = newScale;
      globals.tickThreshold = 200 * newScale;
      const scaleFactor = isSecond ? secondsScale : K;
      this.defaults.duration *= scaleFactor;
      this._speed *= scaleFactor;
    }
  }
  // Getter and setter for precision
  get precision() {
    return globals.precision;
  }
  set precision(precision) {
    globals.precision = precision;
  }
};
var engine = /* @__PURE__ */ (() => {
  const engine2 = new Engine(now());
  if (isBrowser) {
    globalVersions.engine = engine2;
    doc.addEventListener("visibilitychange", () => {
      if (!engine2.pauseOnDocumentHidden) return;
      doc.hidden ? engine2.pause() : engine2.resume();
    });
  }
  return engine2;
})();
var tickEngine = () => {
  if (engine._head) {
    engine.reqId = engineTickMethod(tickEngine);
    engine.update();
  } else {
    engine.reqId = 0;
  }
};
var killEngine = () => {
  engineCancelMethod(
    /** @type {NodeJS.Immediate & Number} */
    engine.reqId
  );
  engine.reqId = 0;
  return engine;
};

// node_modules/animejs/dist/modules/animation/composition.js
/**
 * Anime.js - animation - ESM
 * @version v4.5.0
 * @license MIT
 * @copyright 2026 - Julian Garnier
 */
var lookups = {
  /** @type {TweenReplaceLookups} */
  _rep: /* @__PURE__ */ new WeakMap(),
  /** @type {TweenAdditiveLookups} */
  _add: /* @__PURE__ */ new Map()
};
var getTweenSiblings = (target, property, lookup = "_rep") => {
  const lookupMap = lookups[lookup];
  let targetLookup = lookupMap.get(target);
  if (!targetLookup) {
    targetLookup = {};
    lookupMap.set(target, targetLookup);
  }
  return targetLookup[property] ? targetLookup[property] : targetLookup[property] = {
    _head: null,
    _tail: null
  };
};
var addTweenSortMethod = (p, c) => {
  return p._isOverridden || p._absoluteStartTime > c._absoluteStartTime;
};
var overrideTween = (tween) => {
  tween._isOverlapped = 1;
  tween._isOverridden = 1;
  tween._changeDuration = minValue;
  tween._currentTime = minValue;
};
var composeTween = (tween, siblings) => {
  const tweenCompositionType = tween._composition;
  if (tweenCompositionType === compositionTypes.replace) {
    const tweenAbsStartTime = tween._absoluteStartTime;
    addChild(siblings, tween, addTweenSortMethod, "_prevRep", "_nextRep");
    const prevSibling = tween._prevRep;
    if (prevSibling) {
      const prevParent = prevSibling.parent;
      const prevAbsEndTime = prevSibling._absoluteEndTime;
      if (
        // Check if the previous tween is from a different animation
        tween.parent.id !== prevParent.id && // Check if the animation has loops
        prevParent.iterationCount > 1 && // Check if _absoluteChangeEndTime of last loop overlaps the current tween
        prevAbsEndTime + (prevParent.duration - prevParent.iterationDuration) > tweenAbsStartTime
      ) {
        overrideTween(prevSibling);
        let prevPrevSibling = prevSibling._prevRep;
        while (prevPrevSibling && prevPrevSibling.parent.id === prevParent.id) {
          overrideTween(prevPrevSibling);
          prevPrevSibling = prevPrevSibling._prevRep;
        }
      }
      const absoluteUpdateStartTime = tween._absoluteUpdateStartTime;
      if (prevAbsEndTime > absoluteUpdateStartTime) {
        const prevChangeStartTime = prevSibling._startTime;
        const prevTLOffset = prevAbsEndTime - (prevChangeStartTime + prevSibling._updateDuration);
        const updatedPrevChangeDuration = round(absoluteUpdateStartTime - prevTLOffset - prevChangeStartTime, 12);
        prevSibling._changeDuration = updatedPrevChangeDuration;
        prevSibling._currentTime = updatedPrevChangeDuration;
        prevSibling._isOverlapped = 1;
        if (updatedPrevChangeDuration < minValue) {
          overrideTween(prevSibling);
        }
      }
      const tweenParentTL = tween.parent.parent;
      if (!tweenParentTL || tweenParentTL !== prevParent.parent) {
        let pausePrevParentAnimation = true;
        forEachChildren(prevParent, (t) => {
          if (!t._isOverlapped) pausePrevParentAnimation = false;
        });
        if (pausePrevParentAnimation) {
          const prevParentTL = prevParent.parent;
          if (prevParentTL) {
            let pausePrevParentTL = true;
            forEachChildren(prevParentTL, (a) => {
              if (a !== prevParent) {
                forEachChildren(a, (t) => {
                  if (!t._isOverlapped) pausePrevParentTL = false;
                });
              }
            });
            if (pausePrevParentTL) {
              prevParentTL.cancel();
            }
          } else {
            prevParent.cancel();
          }
        }
      }
    }
  } else if (tweenCompositionType === compositionTypes.blend) {
    const additiveTweenSiblings = getTweenSiblings(tween.target, tween.property, "_add");
    const additiveAnimation = addAdditiveAnimation(lookups._add);
    let lookupTween = additiveTweenSiblings._head;
    if (!lookupTween) {
      lookupTween = { ...tween };
      lookupTween._composition = compositionTypes.replace;
      lookupTween._updateDuration = minValue;
      lookupTween._startTime = 0;
      lookupTween._numbers = cloneArray(tween._fromNumbers);
      lookupTween._number = 0;
      lookupTween._next = null;
      lookupTween._prev = null;
      addChild(additiveTweenSiblings, lookupTween);
      addChild(additiveAnimation, lookupTween);
    }
    const toNumber = tween._toNumber;
    tween._fromNumber = lookupTween._fromNumber - toNumber;
    tween._toNumber = 0;
    tween._numbers = cloneArray(tween._fromNumbers);
    tween._number = 0;
    lookupTween._fromNumber = toNumber;
    if (tween._toNumbers.length) {
      const toNumbers = cloneArray(tween._toNumbers);
      toNumbers.forEach((value, i) => {
        tween._fromNumbers[i] = lookupTween._fromNumbers[i] - value;
        tween._toNumbers[i] = 0;
      });
      lookupTween._fromNumbers = toNumbers;
    }
    addChild(additiveTweenSiblings, tween, null, "_prevAdd", "_nextAdd");
  }
  return tween;
};
var removeTweenSliblings = (tween) => {
  const tweenComposition = tween._composition;
  if (tweenComposition !== compositionTypes.none) {
    const tweenTarget = tween.target;
    const tweenProperty = tween.property;
    const replaceTweensLookup = lookups._rep;
    const replaceTargetProps = replaceTweensLookup.get(tweenTarget);
    const tweenReplaceSiblings = replaceTargetProps[tweenProperty];
    removeChild(tweenReplaceSiblings, tween, "_prevRep", "_nextRep");
    if (tweenComposition === compositionTypes.blend) {
      const addTweensLookup = lookups._add;
      const addTargetProps = addTweensLookup.get(tweenTarget);
      if (!addTargetProps) return;
      const additiveTweenSiblings = addTargetProps[tweenProperty];
      const additiveAnimation = additive.animation;
      removeChild(additiveTweenSiblings, tween, "_prevAdd", "_nextAdd");
      const lookupTween = additiveTweenSiblings._head;
      if (lookupTween && lookupTween === additiveTweenSiblings._tail) {
        removeChild(additiveTweenSiblings, lookupTween, "_prevAdd", "_nextAdd");
        removeChild(additiveAnimation, lookupTween);
        let shouldClean = true;
        for (let prop in addTargetProps) {
          if (addTargetProps[prop]._head) {
            shouldClean = false;
            break;
          }
        }
        if (shouldClean) {
          addTweensLookup.delete(tweenTarget);
        }
      }
    }
  }
  return tween;
};
var removeTargetsFromJSAnimation = (targetsArray, animation, propertyName) => {
  let tweensMatchesTargets = false;
  forEachChildren(animation, (tween) => {
    const tweenTarget = tween.target;
    if (targetsArray.includes(tweenTarget)) {
      const tweenName = tween.property;
      const tweenType = tween._tweenType;
      const normalizePropName = sanitizePropertyName(propertyName, tweenTarget, tweenType);
      if (!normalizePropName || normalizePropName && normalizePropName === tweenName) {
        if (tween.parent._tail === tween && tween._tweenType === tweenTypes.TRANSFORM && tween._prev && tween._prev._tweenType === tweenTypes.TRANSFORM) {
          tween._prev._renderTransforms = 1;
        }
        removeChild(animation, tween);
        removeTweenSliblings(tween);
        tweensMatchesTargets = true;
      }
    }
  }, true);
  return tweensMatchesTargets;
};
var removeTargetsFromRenderable = (targetsArray, renderable, propertyName) => {
  const parent = (
    /** @type {Renderable|typeof engine} **/
    renderable ? renderable : engine
  );
  let removeMatches;
  if (parent._hasChildren) {
    let iterationDuration = 0;
    forEachChildren(parent, (child) => {
      if (!child._hasChildren) {
        removeMatches = removeTargetsFromJSAnimation(
          targetsArray,
          /** @type {JSAnimation} */
          child,
          propertyName
        );
        if (removeMatches && !child._head) {
          child.cancel();
          removeChild(parent, child);
        } else {
          const childTLOffset = child._offset + child._delay;
          const childDur = childTLOffset + child.duration;
          if (childDur > iterationDuration) {
            iterationDuration = childDur;
          }
        }
      }
      if (child._head) {
        removeTargetsFromRenderable(targetsArray, child, propertyName);
      } else {
        child._hasChildren = false;
      }
    }, true);
    if (!isUnd(
      /** @type {Renderable} */
      parent.iterationDuration
    )) {
      parent.iterationDuration = iterationDuration;
    }
  } else {
    removeMatches = removeTargetsFromJSAnimation(
      targetsArray,
      /** @type {JSAnimation} */
      parent,
      propertyName
    );
  }
  if (removeMatches && !parent._head) {
    parent._hasChildren = false;
    if (
      /** @type {Renderable} */
      parent.cancel
    ) parent.cancel();
  }
};

// node_modules/animejs/dist/modules/timer/timer.js
/**
 * Anime.js - timer - ESM
 * @version v4.5.0
 * @license MIT
 * @copyright 2026 - Julian Garnier
 */
var resetTimerProperties = (timer) => {
  timer.paused = true;
  timer.began = false;
  timer.completed = false;
  return timer;
};
var reviveTimer = (timer) => {
  if (!timer._cancelled) return timer;
  if (timer._hasChildren) {
    forEachChildren(timer, reviveTimer);
  } else {
    forEachChildren(timer, (tween) => {
      if (tween._composition !== compositionTypes.none) {
        composeTween(tween, getTweenSiblings(tween.target, tween.property));
      }
    });
  }
  timer._cancelled = 0;
  return timer;
};
var timerId = 0;
var sortByPriority = (prev, child) => prev._priority > child._priority;
var Timer = class extends Clock {
  /**
   * @param {TimerParams} [parameters]
   * @param {Timeline} [parent]
   * @param {Number} [parentPosition]
   */
  constructor(parameters = {}, parent = null, parentPosition = 0) {
    super(0);
    ++timerId;
    const {
      id,
      delay,
      duration,
      reversed,
      alternate,
      loop,
      loopDelay,
      autoplay,
      frameRate,
      playbackRate,
      priority,
      onComplete,
      onLoop,
      onPause,
      onBegin,
      onBeforeUpdate,
      onUpdate
    } = parameters;
    if (scope.current) scope.current.register(this);
    const timerInitTime = parent ? 0 : engine._lastTickTime;
    const timerDefaults = parent ? parent.defaults : globals.defaults;
    const timerDelay = (
      /** @type {Number} */
      isFnc(delay) || isUnd(delay) ? timerDefaults.delay : +delay
    );
    const timerDuration = isFnc(duration) || isUnd(duration) ? Infinity : +duration;
    const timerLoop = setValue(loop, timerDefaults.loop);
    const timerLoopDelay = setValue(loopDelay, timerDefaults.loopDelay);
    let timerIterationCount = timerLoop === true || timerLoop === Infinity || /** @type {Number} */
    timerLoop < 0 ? Infinity : (
      /** @type {Number} */
      timerLoop + 1
    );
    let offsetPosition = 0;
    if (parent) {
      offsetPosition = parentPosition;
    } else {
      if (!engine.reqId) engine.requestTick(now());
      offsetPosition = (engine._lastTickTime - engine._startTime) * globals.timeScale;
    }
    this.id = !isUnd(id) ? id : timerId;
    this.parent = parent;
    this.duration = clampInfinity((timerDuration + timerLoopDelay) * timerIterationCount - timerLoopDelay) || minValue;
    this.backwards = false;
    this.paused = true;
    this.began = false;
    this.completed = false;
    this.onBegin = onBegin || timerDefaults.onBegin;
    this.onBeforeUpdate = onBeforeUpdate || timerDefaults.onBeforeUpdate;
    this.onUpdate = onUpdate || timerDefaults.onUpdate;
    this.onLoop = onLoop || timerDefaults.onLoop;
    this.onPause = onPause || timerDefaults.onPause;
    this.onComplete = onComplete || timerDefaults.onComplete;
    this.iterationDuration = timerDuration;
    this.iterationCount = timerIterationCount;
    this._autoplay = parent ? false : setValue(autoplay, timerDefaults.autoplay);
    this._offset = offsetPosition;
    this._delay = timerDelay;
    this._loopDelay = timerLoopDelay;
    this._iterationTime = 0;
    this._currentIteration = 0;
    this._resolve = noop;
    this._running = false;
    this._reversed = +setValue(reversed, timerDefaults.reversed);
    this._reverse = this._reversed;
    this._cancelled = 0;
    this._alternate = setValue(alternate, timerDefaults.alternate);
    this._prev = null;
    this._next = null;
    this._lastTickTime = timerInitTime;
    this._startTime = timerInitTime;
    this._lastTime = timerInitTime;
    this._fps = setValue(frameRate, timerDefaults.frameRate);
    this._speed = setValue(playbackRate, timerDefaults.playbackRate);
    this._priority = +setValue(priority, 1);
  }
  get cancelled() {
    return !!this._cancelled;
  }
  set cancelled(cancelled) {
    cancelled ? this.cancel() : this.reset(true).play();
  }
  get currentTime() {
    return clamp(round(this._currentTime, globals.precision), -this._delay, this.duration);
  }
  set currentTime(time) {
    const paused = this.paused;
    this.pause().seek(+time);
    if (!paused) this.resume();
  }
  get iterationCurrentTime() {
    return clamp(round(this._iterationTime, globals.precision), 0, this.iterationDuration);
  }
  set iterationCurrentTime(time) {
    this.currentTime = this.iterationDuration * this._currentIteration + time;
  }
  get progress() {
    return clamp(round(this._currentTime / this.duration, 10), 0, 1);
  }
  set progress(progress) {
    this.currentTime = this.duration * progress;
  }
  get iterationProgress() {
    return clamp(round(this._iterationTime / this.iterationDuration, 10), 0, 1);
  }
  set iterationProgress(progress) {
    const iterationDuration = this.iterationDuration;
    this.currentTime = iterationDuration * this._currentIteration + iterationDuration * progress;
  }
  get currentIteration() {
    return this._currentIteration;
  }
  set currentIteration(iterationCount) {
    this.currentTime = this.iterationDuration * clamp(+iterationCount, 0, this.iterationCount - 1);
  }
  get reversed() {
    return !!this._reversed;
  }
  set reversed(reverse) {
    reverse ? this.reverse() : this.play();
  }
  get speed() {
    return super.speed;
  }
  set speed(playbackRate) {
    super.speed = playbackRate;
    this.resetTime();
  }
  /**
   * @param  {Boolean} [softReset]
   * @return {this}
   */
  reset(softReset = false) {
    reviveTimer(this);
    if (this._reversed && !this._reverse) this.reversed = false;
    this._iterationTime = this.iterationDuration;
    tick(this, 0, 1, ~~softReset, tickModes.FORCE);
    resetTimerProperties(this);
    if (this._hasChildren) {
      forEachChildren(this, resetTimerProperties);
    }
    return this;
  }
  /**
   * @param  {Boolean} internalRender
   * @return {this}
   */
  init(internalRender = false) {
    this.fps = this._fps;
    this.speed = this._speed;
    if (!internalRender && this._hasChildren) {
      tick(this, this.duration, 1, ~~internalRender, tickModes.FORCE);
    }
    this.reset(internalRender);
    const autoplay = this._autoplay;
    if (autoplay === true) {
      this.resume();
    } else if (autoplay && !isUnd(
      /** @type {ScrollObserver} */
      autoplay.linked
    )) {
      autoplay.link(this);
    }
    return this;
  }
  /** @return {this} */
  resetTime() {
    const timeScale = 1 / (this._speed * engine._speed);
    this._startTime = now() - (this._currentTime + this._delay) * timeScale;
    return this;
  }
  /** @return {this} */
  pause() {
    if (this.paused) return this;
    this.paused = true;
    this.onPause(this);
    return this;
  }
  /** @return {this} */
  resume() {
    if (!this.paused) return this;
    this.paused = false;
    if (this.duration <= minValue && !this._hasChildren) {
      tick(this, minValue, 0, 0, tickModes.FORCE);
    } else {
      if (!this._running) {
        addChild(engine, this, sortByPriority);
        engine._hasChildren = true;
        this._running = true;
      }
      this.resetTime();
      this._startTime -= 12;
      engine.wake();
    }
    return this;
  }
  /** @return {this} */
  restart() {
    return this.reset().resume();
  }
  /**
   * @param  {Number} time
   * @param  {Boolean|Number} [muteCallbacks]
   * @param  {Boolean|Number} [internalRender]
   * @return {this}
   */
  seek(time, muteCallbacks = 0, internalRender = 0) {
    reviveTimer(this);
    this.completed = false;
    const isPaused = this.paused;
    this.paused = true;
    tick(this, time + this._delay, ~~muteCallbacks, ~~internalRender, tickModes.AUTO);
    return isPaused ? this : this.resume();
  }
  /** @return {this} */
  alternate() {
    const reversed = this._reversed;
    const count = this.iterationCount;
    const duration = this.iterationDuration;
    const iterations = count === Infinity ? floor(maxValue / duration) : count;
    this._reversed = +(this._alternate && !(iterations % 2) ? reversed : !reversed);
    if (count === Infinity) {
      this.iterationProgress = this._reversed ? 1 - this.iterationProgress : this.iterationProgress;
    } else {
      this.seek(duration * iterations - this._currentTime);
    }
    this.resetTime();
    return this;
  }
  /** @return {this} */
  play() {
    if (this._reversed) this.alternate();
    return this.resume();
  }
  /** @return {this} */
  reverse() {
    if (!this._reversed) this.alternate();
    return this.resume();
  }
  // TODO: Move all the animation / tweens / children related code to Animation / Timeline
  /** @return {this} */
  cancel() {
    if (this._hasChildren) {
      forEachChildren(this, (child) => child.cancel(), true);
    } else {
      forEachChildren(this, removeTweenSliblings);
    }
    this._cancelled = 1;
    return this.pause();
  }
  /**
   * @param  {Number} newDuration
   * @return {this}
   */
  stretch(newDuration) {
    const currentDuration = this.duration;
    const normlizedDuration = normalizeTime(newDuration);
    if (currentDuration === normlizedDuration) return this;
    const timeScale = newDuration / currentDuration;
    const isSetter = newDuration <= minValue;
    this.duration = isSetter ? minValue : normlizedDuration;
    this.iterationDuration = isSetter ? minValue : normalizeTime(this.iterationDuration * timeScale);
    this._offset *= timeScale;
    this._delay *= timeScale;
    this._loopDelay *= timeScale;
    return this;
  }
  /**
    * Cancels the timer by seeking it back to 0 and reverting the attached scroller if necessary
    * @return {this}
    */
  revert() {
    tick(this, 0, 1, 0, tickModes.AUTO);
    const ap = (
      /** @type {ScrollObserver} */
      this._autoplay
    );
    if (ap && ap.linked && ap.linked === this) ap.revert();
    return this.cancel();
  }
  /**
    * Imediatly completes the timer, cancels it and triggers the onComplete callback
    * @param  {Boolean|Number} [muteCallbacks]
    * @return {this}
    */
  complete(muteCallbacks = 0) {
    return this.seek(this.duration, muteCallbacks).cancel();
  }
  /**
   * @typedef {this & {then: null}} ResolvedTimer
   */
  /**
   * @param  {Callback<ResolvedTimer>} [callback]
   * @return Promise<this>
   */
  then(callback = noop) {
    const then = this.then;
    const onResolve = () => {
      this.then = null;
      callback(
        /** @type {ResolvedTimer} */
        this
      );
      this.then = then;
      this._resolve = noop;
    };
    return new Promise((r) => {
      this._resolve = () => r(onResolve());
      if (this.completed) this._resolve();
      return this;
    });
  }
};

// node_modules/animejs/dist/modules/core/units.js
/**
 * Anime.js - core - ESM
 * @version v4.5.0
 * @license MIT
 * @copyright 2026 - Julian Garnier
 */
var angleUnitsMap = { "deg": 1, "rad": 180 / PI, "turn": 360 };
var convertedValuesCache = {};
var convertValueUnit = (el, decomposedValue, unit, force = false) => {
  const currentUnit = decomposedValue.u;
  const currentNumber = decomposedValue.n;
  if (decomposedValue.t === valueTypes.UNIT && currentUnit === unit) {
    return decomposedValue;
  }
  const cachedKey = currentNumber + currentUnit + unit;
  const cached = convertedValuesCache[cachedKey];
  if (!isUnd(cached) && !force) {
    decomposedValue.n = cached;
  } else {
    let convertedValue;
    if (currentUnit in angleUnitsMap) {
      convertedValue = currentNumber * angleUnitsMap[currentUnit] / angleUnitsMap[unit];
    } else {
      const baseline = 100;
      const tempEl = (
        /** @type {DOMTarget} */
        el.cloneNode()
      );
      const parentNode = el.parentNode;
      const parentEl = parentNode && parentNode !== doc ? parentNode : doc.body;
      parentEl.appendChild(tempEl);
      const elStyle = tempEl.style;
      elStyle.width = baseline + currentUnit;
      const currentUnitWidth = (
        /** @type {HTMLElement} */
        tempEl.offsetWidth || baseline
      );
      elStyle.width = baseline + unit;
      const newUnitWidth = (
        /** @type {HTMLElement} */
        tempEl.offsetWidth || baseline
      );
      const factor = currentUnitWidth / newUnitWidth;
      parentEl.removeChild(tempEl);
      convertedValue = factor * currentNumber;
    }
    decomposedValue.n = convertedValue;
    convertedValuesCache[cachedKey] = convertedValue;
  }
  decomposedValue.t === valueTypes.UNIT;
  decomposedValue.u = unit;
  return decomposedValue;
};

// node_modules/animejs/dist/modules/easings/none.js
/**
 * Anime.js - easings - ESM
 * @version v4.5.0
 * @license MIT
 * @copyright 2026 - Julian Garnier
 */
var none = (t) => t;

// node_modules/animejs/dist/modules/easings/eases/parser.js
/**
 * Anime.js - easings - ESM
 * @version v4.5.0
 * @license MIT
 * @copyright 2026 - Julian Garnier
 */
var easeInPower = (p = 1.68) => (t) => pow(t, +p);
var easeTypes = {
  in: (easeIn) => (t) => easeIn(t),
  out: (easeIn) => (t) => 1 - easeIn(1 - t),
  inOut: (easeIn) => (t) => t < 0.5 ? easeIn(t * 2) / 2 : 1 - easeIn(t * -2 + 2) / 2,
  outIn: (easeIn) => (t) => t < 0.5 ? (1 - easeIn(1 - t * 2)) / 2 : (easeIn(t * 2 - 1) + 1) / 2
};
var halfPI = PI / 2;
var doublePI = PI * 2;
var easeInFunctions = {
  [emptyString]: easeInPower,
  Quad: easeInPower(2),
  Cubic: easeInPower(3),
  Quart: easeInPower(4),
  Quint: easeInPower(5),
  /** @type {EasingFunction} */
  Sine: (t) => 1 - cos(t * halfPI),
  /** @type {EasingFunction} */
  Circ: (t) => 1 - sqrt(1 - t * t),
  /** @type {EasingFunction} */
  Expo: (t) => t ? pow(2, 10 * t - 10) : 0,
  /** @type {EasingFunction} */
  Bounce: (t) => {
    let pow2, b = 4;
    while (t < ((pow2 = pow(2, --b)) - 1) / 11) ;
    return 1 / pow(4, 3 - b) - 7.5625 * pow((pow2 * 3 - 2) / 22 - t, 2);
  },
  /** @type {BackEasing} */
  Back: (overshoot = 1.7) => (t) => (+overshoot + 1) * t * t * t - +overshoot * t * t,
  /** @type {ElasticEasing} */
  Elastic: (amplitude = 1, period = 0.3) => {
    const a = clamp(+amplitude, 1, 10);
    const p = clamp(+period, minValue, 2);
    const s = p / doublePI * asin(1 / a);
    const e = doublePI / p;
    return (t) => t === 0 || t === 1 ? t : -a * pow(2, -10 * (1 - t)) * sin((1 - t - s) * e);
  }
};
var eases = /* @__PURE__ */ (() => {
  const list = { linear: none, none };
  for (let type in easeTypes) {
    for (let name in easeInFunctions) {
      const easeIn = easeInFunctions[name];
      const easeType = easeTypes[type];
      list[type + name] = /** @type {EasingFunctionWithParams|EasingFunction} */
      name === emptyString || name === "Back" || name === "Elastic" ? (a, b) => easeType(
        /** @type {EasingFunctionWithParams} */
        easeIn(a, b)
      ) : easeType(
        /** @type {EasingFunction} */
        easeIn
      );
    }
  }
  return (
    /** @type {EasesFunctions} */
    list
  );
})();
var easesLookups = { linear: none, none };
var parseEaseString = (string) => {
  if (easesLookups[string]) return easesLookups[string];
  if (string.indexOf("(") <= -1) {
    const hasParams = easeTypes[string] || string.includes("Back") || string.includes("Elastic");
    const parsedFn = (
      /** @type {EasingFunction} */
      hasParams ? (
        /** @type {EasingFunctionWithParams} */
        eases[string]()
      ) : eases[string]
    );
    return parsedFn ? easesLookups[string] = parsedFn : none;
  } else {
    const split = string.slice(0, -1).split("(");
    const parsedFn = (
      /** @type {EasingFunctionWithParams} */
      eases[split[0]]
    );
    return parsedFn ? easesLookups[string] = parsedFn(...split[1].split(",")) : none;
  }
};
var deprecated = ["steps(", "irregular(", "linear(", "cubicBezier("];
var parseEase = (ease) => {
  if (isStr(ease)) {
    for (let i = 0, l = deprecated.length; i < l; i++) {
      if (stringStartsWith(ease, deprecated[i])) {
        console.warn(`String syntax for \`ease: "${ease}"\` has been removed from the core and replaced by importing and passing the easing function directly: \`ease: ${ease}\``);
        return none;
      }
    }
  }
  const easeFunc = isFnc(ease) ? ease : isStr(ease) ? parseEaseString(
    /** @type {String} */
    ease
  ) : none;
  return easeFunc;
};

// node_modules/animejs/dist/modules/animation/animation.js
/**
 * Anime.js - animation - ESM
 * @version v4.5.0
 * @license MIT
 * @copyright 2026 - Julian Garnier
 */
var fromTargetObject = createDecomposedValueTargetObject();
var toTargetObject = createDecomposedValueTargetObject();
var inlineStylesStore = {};
var toFunctionStore = { func: null };
var fromFunctionStore = { func: null };
var keyframesTargetArray = [null];
var fastSetValuesArray = [null, null];
var keyObjectTarget = { to: null };
var tweenId = 0;
var JSAnimationId = 0;
var keyframes;
var key;
var generateKeyframes = (keyframes2, parameters) => {
  const properties = {};
  if (isArr(keyframes2)) {
    const propertyNames = [].concat(.../** @type {DurationKeyframes} */
    keyframes2.map((key2) => Object.keys(key2))).filter(isKey);
    for (let i = 0, l = propertyNames.length; i < l; i++) {
      const propName = propertyNames[i];
      const propArray = (
        /** @type {DurationKeyframes} */
        keyframes2.map((key2) => {
          const newKey = {};
          for (let p in key2) {
            const keyValue = (
              /** @type {TweenPropValue} */
              key2[p]
            );
            if (isKey(p)) {
              if (p === propName) {
                newKey.to = keyValue;
              }
            } else {
              newKey[p] = keyValue;
            }
          }
          return newKey;
        })
      );
      properties[propName] = /** @type {ArraySyntaxValue} */
      propArray;
    }
  } else {
    const totalDuration = (
      /** @type {Number} */
      setValue(parameters.duration, globals.defaults.duration)
    );
    const keys = Object.keys(keyframes2).map((key2) => {
      return { o: parseFloat(key2) / 100, p: keyframes2[key2] };
    }).sort((a, b) => a.o - b.o);
    keys.forEach((key2) => {
      const offset = key2.o;
      const prop = key2.p;
      for (let name in prop) {
        if (isKey(name)) {
          let propArray = (
            /** @type {Array} */
            properties[name]
          );
          if (!propArray) propArray = properties[name] = [];
          const duration = offset * totalDuration;
          let length = propArray.length;
          let prevKey = propArray[length - 1];
          const keyObj = { to: prop[name] };
          let durProgress = 0;
          for (let i = 0; i < length; i++) {
            durProgress += propArray[i].duration;
          }
          if (length === 1) {
            keyObj.from = prevKey.to;
          }
          if (prop.ease) {
            keyObj.ease = prop.ease;
          }
          keyObj.duration = duration - (length ? durProgress : 0);
          propArray.push(keyObj);
        }
      }
      return key2;
    });
    for (let name in properties) {
      const propArray = (
        /** @type {Array} */
        properties[name]
      );
      let prevEase;
      for (let i = 0, l = propArray.length; i < l; i++) {
        const prop = propArray[i];
        const currentEase = prop.ease;
        prop.ease = prevEase ? prevEase : void 0;
        prevEase = currentEase;
      }
      if (!propArray[0].duration) {
        propArray.shift();
      }
    }
  }
  return properties;
};
var JSAnimation = class extends Timer {
  /**
   * @param {TargetsParam} targets
   * @param {AnimationParams} parameters
   * @param {Timeline} [parent]
   * @param {Number} [parentPosition]
   * @param {Boolean} [fastSet=false]
   * @param {Number} [index=0]
   * @param {TargetsArray} [allTargets]
   */
  constructor(targets, parameters, parent, parentPosition, fastSet = false, index = 0, allTargets) {
    super(
      /** @type {TimerParams & AnimationParams} */
      parameters,
      parent,
      parentPosition
    );
    this._head;
    this._tail;
    ++JSAnimationId;
    const parsedTargets = registerTargets(targets);
    const targetsLength = parsedTargets.length;
    const kfParams = (
      /** @type {AnimationParams} */
      parameters.keyframes
    );
    const params = (
      /** @type {AnimationParams} */
      kfParams ? mergeObjects(generateKeyframes(
        /** @type {DurationKeyframes} */
        kfParams,
        parameters
      ), parameters) : parameters
    );
    const {
      id,
      delay,
      duration,
      ease,
      playbackEase,
      modifier,
      composition,
      onRender
    } = params;
    const animDefaults = parent ? parent.defaults : globals.defaults;
    const animEase = setValue(ease, animDefaults.ease);
    const animPlaybackEase = setValue(playbackEase, animDefaults.playbackEase);
    const parsedAnimPlaybackEase = animPlaybackEase ? parseEase(animPlaybackEase) : null;
    const hasSpring = !isUnd(
      /** @type {Spring} */
      animEase.ease
    );
    const tEasing = hasSpring ? (
      /** @type {Spring} */
      animEase.ease
    ) : setValue(ease, parsedAnimPlaybackEase ? "linear" : animDefaults.ease);
    const tDuration = hasSpring ? (
      /** @type {Spring} */
      animEase.settlingDuration
    ) : setValue(duration, animDefaults.duration);
    const tDelay = setValue(delay, animDefaults.delay);
    const tModifier = modifier || animDefaults.modifier;
    const tComposition = isUnd(composition) && targetsLength >= K ? compositionTypes.none : !isUnd(composition) ? composition : animDefaults.composition;
    const absoluteOffsetTime = this._offset + (parent ? parent._offset : 0);
    if (hasSpring) animEase.parent = this;
    let iterationDuration = NaN;
    let iterationDelay = NaN;
    let animationAnimationLength = 0;
    let shouldTriggerRender = 0;
    for (let targetIndex = 0; targetIndex < targetsLength; targetIndex++) {
      const target = parsedTargets[targetIndex];
      const ti = index || targetIndex;
      const tl = allTargets || parsedTargets;
      let lastTransformGroupIndex = NaN;
      let lastTransformGroupLength = NaN;
      for (let p in params) {
        if (isKey(p)) {
          const tweenType = getTweenType(target, p);
          const adapterProp = resolveAdapterEntry(target, p);
          const propName = sanitizePropertyName(p, target, tweenType);
          let propValue = params[p];
          const isPropValueArray = isArr(propValue);
          if (fastSet && !isPropValueArray) {
            fastSetValuesArray[0] = propValue;
            fastSetValuesArray[1] = propValue;
            propValue = fastSetValuesArray;
          }
          if (isPropValueArray) {
            const arrayLength = (
              /** @type {Array} */
              propValue.length
            );
            const isNotObjectValue = !isObj(propValue[0]);
            if (arrayLength === 2 && isNotObjectValue) {
              keyObjectTarget.to = /** @type {TweenParamValue} */
              /** @type {unknown} */
              propValue;
              keyframesTargetArray[0] = keyObjectTarget;
              keyframes = keyframesTargetArray;
            } else if (arrayLength > 2 && isNotObjectValue) {
              keyframes = [];
              propValue.forEach((v, i) => {
                if (!i) {
                  fastSetValuesArray[0] = v;
                } else if (i === 1) {
                  fastSetValuesArray[1] = v;
                  keyframes.push(fastSetValuesArray);
                } else {
                  keyframes.push(v);
                }
              });
            } else {
              keyframes = /** @type {Array.<TweenKeyValue>} */
              propValue;
            }
          } else {
            keyframesTargetArray[0] = propValue;
            keyframes = keyframesTargetArray;
          }
          let siblings = null;
          let prevTween = null;
          let firstTweenChangeStartTime = NaN;
          let lastTweenChangeEndTime = 0;
          let tweenIndex = 0;
          for (let l = keyframes.length; tweenIndex < l; tweenIndex++) {
            const keyframe = keyframes[tweenIndex];
            if (isObj(keyframe)) {
              key = keyframe;
            } else {
              keyObjectTarget.to = /** @type {TweenParamValue} */
              keyframe;
              key = keyObjectTarget;
            }
            toFunctionStore.func = null;
            fromFunctionStore.func = null;
            const computedComposition = getFunctionValue(setValue(key.composition, tComposition), target, ti, tl, null, null);
            const tweenComposition = isNum(computedComposition) ? computedComposition : compositionTypes[computedComposition];
            if (!siblings && tweenComposition !== compositionTypes.none) siblings = getTweenSiblings(target, propName);
            const tailTween = siblings ? siblings._tail : null;
            const prevSiblingTween = parent && tailTween && tailTween.parent.parent === parent ? tailTween : prevTween;
            const computedToValue = getFunctionValue(key.to, target, ti, tl, toFunctionStore, prevSiblingTween);
            let tweenToValue;
            if (isObj(computedToValue) && !isUnd(computedToValue.to)) {
              key = computedToValue;
              tweenToValue = computedToValue.to;
            } else {
              tweenToValue = computedToValue;
            }
            const tweenFromValue = getFunctionValue(key.from, target, ti, tl, fromFunctionStore, prevSiblingTween);
            const easeToParse = key.ease || tEasing;
            const easeFunctionResult = getFunctionValue(easeToParse, target, ti, tl, null, prevSiblingTween);
            const keyEasing = isFnc(easeFunctionResult) || isStr(easeFunctionResult) ? easeFunctionResult : easeToParse;
            const hasSpring2 = !isUnd(keyEasing) && !isUnd(
              /** @type {Spring} */
              keyEasing.ease
            );
            const tweenEasing = hasSpring2 ? (
              /** @type {Spring} */
              keyEasing.ease
            ) : keyEasing;
            const tweenDuration = hasSpring2 ? (
              /** @type {Spring} */
              keyEasing.settlingDuration
            ) : getFunctionValue(setValue(key.duration, l > 1 ? getFunctionValue(tDuration, target, ti, tl, null, prevSiblingTween) / l : tDuration), target, ti, tl, null, prevSiblingTween);
            const tweenDelay = getFunctionValue(setValue(key.delay, !tweenIndex ? tDelay : 0), target, ti, tl, null, prevSiblingTween);
            const tweenModifier = key.modifier || tModifier;
            const hasFromvalue = !isUnd(tweenFromValue);
            const hasToValue = !isUnd(tweenToValue);
            const isFromToArray = isArr(tweenToValue);
            const isFromToValue = isFromToArray || hasFromvalue && hasToValue;
            const tweenUpdateStartLocal = prevTween ? lastTweenChangeEndTime : 0;
            const tweenStartTime = prevTween ? lastTweenChangeEndTime + tweenDelay : tweenDelay;
            const absoluteStartTime = round(absoluteOffsetTime + tweenStartTime, 12);
            const absoluteUpdateStartTime = round(absoluteOffsetTime + tweenUpdateStartLocal, 12);
            if (!shouldTriggerRender && (hasFromvalue || isFromToArray)) shouldTriggerRender = 1;
            let prevSibling = prevTween;
            if (tweenComposition !== compositionTypes.none) {
              let nextSibling = siblings._head;
              while (nextSibling && nextSibling._absoluteStartTime <= absoluteStartTime) {
                if (!nextSibling._isOverridden) prevSibling = nextSibling;
                nextSibling = nextSibling._nextRep;
                if (nextSibling && nextSibling._absoluteStartTime >= absoluteStartTime) {
                  while (nextSibling) {
                    overrideTween(nextSibling);
                    nextSibling = nextSibling._nextRep;
                  }
                }
              }
            }
            if (isFromToValue) {
              decomposeRawValue(isFromToArray ? getFunctionValue(tweenToValue[0], target, ti, tl, fromFunctionStore, prevSiblingTween) : tweenFromValue, fromTargetObject);
              decomposeRawValue(isFromToArray ? getFunctionValue(tweenToValue[1], target, ti, tl, toFunctionStore, prevSiblingTween) : tweenToValue, toTargetObject);
              const originalValue = getOriginalAnimatableValue(target, propName, tweenType, inlineStylesStore);
              if (fromTargetObject.t === valueTypes.NUMBER) {
                if (prevSibling) {
                  if (prevSibling._valueType === valueTypes.UNIT) {
                    fromTargetObject.t = valueTypes.UNIT;
                    fromTargetObject.u = prevSibling._unit;
                  }
                } else {
                  decomposeRawValue(
                    originalValue,
                    decomposedOriginalValue
                  );
                  if (decomposedOriginalValue.t === valueTypes.UNIT) {
                    fromTargetObject.t = valueTypes.UNIT;
                    fromTargetObject.u = decomposedOriginalValue.u;
                  }
                }
              }
            } else {
              if (hasToValue) {
                decomposeRawValue(tweenToValue, toTargetObject);
              } else {
                if (prevTween) {
                  decomposeTweenValue(prevTween, toTargetObject);
                } else {
                  decomposeRawValue(parent && prevSibling && prevSibling.parent.parent === parent ? prevSibling._value : getOriginalAnimatableValue(target, propName, tweenType, inlineStylesStore), toTargetObject);
                }
              }
              if (hasFromvalue) {
                decomposeRawValue(tweenFromValue, fromTargetObject);
              } else {
                if (prevTween) {
                  decomposeTweenValue(prevTween, fromTargetObject);
                } else {
                  decomposeRawValue(parent && prevSibling && prevSibling.parent.parent === parent ? prevSibling._value : getOriginalAnimatableValue(target, propName, tweenType, inlineStylesStore), fromTargetObject);
                }
              }
            }
            if (fromTargetObject.o) {
              fromTargetObject.n = getRelativeValue(
                !prevSibling ? decomposeRawValue(
                  getOriginalAnimatableValue(target, propName, tweenType, inlineStylesStore),
                  decomposedOriginalValue
                ).n : prevSibling._toNumber,
                fromTargetObject.n,
                fromTargetObject.o
              );
            }
            if (toTargetObject.o) {
              toTargetObject.n = getRelativeValue(fromTargetObject.n, toTargetObject.n, toTargetObject.o);
            }
            if (fromTargetObject.t !== toTargetObject.t) {
              if (fromTargetObject.t === valueTypes.COMPLEX || toTargetObject.t === valueTypes.COMPLEX) {
                const complexValue = fromTargetObject.t === valueTypes.COMPLEX ? fromTargetObject : toTargetObject;
                const notComplexValue = fromTargetObject.t === valueTypes.COMPLEX ? toTargetObject : fromTargetObject;
                notComplexValue.t = valueTypes.COMPLEX;
                notComplexValue.s = cloneArray(complexValue.s);
                notComplexValue.d = complexValue.d.map(() => notComplexValue.n);
              } else if (fromTargetObject.t === valueTypes.UNIT || toTargetObject.t === valueTypes.UNIT) {
                const unitValue = fromTargetObject.t === valueTypes.UNIT ? fromTargetObject : toTargetObject;
                const notUnitValue = fromTargetObject.t === valueTypes.UNIT ? toTargetObject : fromTargetObject;
                notUnitValue.t = valueTypes.UNIT;
                notUnitValue.u = unitValue.u;
              } else if (fromTargetObject.t === valueTypes.COLOR || toTargetObject.t === valueTypes.COLOR) {
                const colorValue = fromTargetObject.t === valueTypes.COLOR ? fromTargetObject : toTargetObject;
                const notColorValue = fromTargetObject.t === valueTypes.COLOR ? toTargetObject : fromTargetObject;
                notColorValue.t = valueTypes.COLOR;
                notColorValue.d = colorValue.d.map(() => 0);
              }
            }
            if (fromTargetObject.u !== toTargetObject.u) {
              let valueToConvert = toTargetObject.u ? fromTargetObject : toTargetObject;
              valueToConvert = convertValueUnit(
                /** @type {DOMTarget} */
                target,
                valueToConvert,
                toTargetObject.u ? toTargetObject.u : fromTargetObject.u,
                false
              );
            }
            if (toTargetObject.d && fromTargetObject.d && toTargetObject.d.length !== fromTargetObject.d.length) {
              const longestValue = fromTargetObject.d.length > toTargetObject.d.length ? fromTargetObject : toTargetObject;
              const shortestValue = longestValue === fromTargetObject ? toTargetObject : fromTargetObject;
              shortestValue.d = longestValue.d.map((_, i) => isUnd(shortestValue.d[i]) ? 0 : shortestValue.d[i]);
              shortestValue.s = cloneArray(longestValue.s);
            }
            const tweenUpdateDuration = round(+tweenDuration || minValue, 12);
            let inlineValue = inlineStylesStore[propName];
            if (!isNil(inlineValue)) inlineStylesStore[propName] = null;
            const tweenSetter = adapterProp ? adapterProp.set : null;
            lastTweenChangeEndTime = round(tweenStartTime + tweenUpdateDuration, 12);
            const fromD = fromTargetObject.d;
            const toD = toTargetObject.d;
            const toS = toTargetObject.s;
            const tween = {
              parent: this,
              id: tweenId++,
              property: propName,
              target,
              _value: null,
              _toFunc: toFunctionStore.func,
              _fromFunc: fromFunctionStore.func,
              _ease: parseEase(tweenEasing),
              _fromNumbers: fromD ? cloneArray(fromD) : emptyArray,
              _toNumbers: toD ? cloneArray(toD) : emptyArray,
              _strings: toS ? cloneArray(toS) : emptyArray,
              _fromNumber: fromTargetObject.n,
              _toNumber: toTargetObject.n,
              _numbers: fromD ? cloneArray(fromD) : emptyArray,
              // For additive tween and animatables
              _number: fromTargetObject.n,
              // For additive tween and animatables
              _unit: toTargetObject.u,
              _modifier: tweenModifier,
              _currentTime: 0,
              _startTime: tweenStartTime,
              _delay: +tweenDelay,
              _updateDuration: tweenUpdateDuration,
              _changeDuration: tweenUpdateDuration,
              _absoluteStartTime: absoluteStartTime,
              _absoluteUpdateStartTime: absoluteUpdateStartTime,
              _absoluteEndTime: round(absoluteOffsetTime + lastTweenChangeEndTime, 12),
              _hasFromValue: hasFromvalue || isFromToArray ? 1 : 0,
              // NOTE: Investigate bit packing to stores ENUM / BOOL
              _tweenType: tweenType,
              _setter: tweenSetter,
              _valueType: toTargetObject.t,
              _composition: tweenComposition,
              _isOverlapped: 0,
              _isOverridden: 0,
              _renderTransforms: 0,
              _inlineValue: inlineValue,
              _prevRep: null,
              // For replaced tween
              _nextRep: null,
              // For replaced tween
              _prevAdd: null,
              // For additive tween
              _nextAdd: null,
              // For additive tween
              _prev: null,
              _next: null
            };
            if (tweenComposition !== compositionTypes.none) {
              composeTween(tween, siblings);
            }
            const vt = tween._valueType;
            if (vt === valueTypes.COMPLEX) {
              tween._value = composeComplexValue(tween, 1, -1);
            } else if (vt === valueTypes.UNIT) {
              tween._value = `${tweenModifier(tween._toNumber)}${tween._unit}`;
            } else if (vt === valueTypes.COLOR) {
              const d = toTargetObject.d;
              tween._value = `rgba(${round(d[0], 0)},${round(d[1], 0)},${round(d[2], 0)},${d[3]})`;
            } else {
              tween._value = tweenModifier(tween._toNumber);
            }
            if (isNaN(firstTweenChangeStartTime)) {
              firstTweenChangeStartTime = tween._startTime;
            }
            prevTween = tween;
            animationAnimationLength++;
            addChild(this, tween);
          }
          if (isNaN(iterationDelay) || firstTweenChangeStartTime < iterationDelay) {
            iterationDelay = firstTweenChangeStartTime;
          }
          if (isNaN(iterationDuration) || lastTweenChangeEndTime > iterationDuration) {
            iterationDuration = lastTweenChangeEndTime;
          }
          if (tweenType === tweenTypes.TRANSFORM) {
            lastTransformGroupIndex = animationAnimationLength - tweenIndex;
            lastTransformGroupLength = animationAnimationLength;
          }
        }
      }
      if (!isNaN(lastTransformGroupIndex)) {
        let i = 0;
        forEachChildren(this, (tween) => {
          if (i >= lastTransformGroupIndex && i < lastTransformGroupLength) {
            tween._renderTransforms = 1;
            if (tween._composition === compositionTypes.blend) {
              forEachChildren(additive.animation, (additiveTween) => {
                if (additiveTween.id === tween.id) {
                  additiveTween._renderTransforms = 1;
                }
              });
            }
          }
          i++;
        });
      }
    }
    if (!targetsLength) {
      console.warn(`No target found. Make sure the element you're trying to animate is accessible before creating your animation.`);
    }
    if (iterationDelay) {
      forEachChildren(this, (tween) => {
        if (!(tween._startTime - tween._delay)) {
          tween._delay -= iterationDelay;
        }
        tween._startTime -= iterationDelay;
      });
      iterationDuration -= iterationDelay;
    } else {
      iterationDelay = 0;
    }
    if (!iterationDuration) {
      iterationDuration = minValue;
      this.iterationCount = 0;
    }
    this.targets = parsedTargets;
    this.id = !isUnd(id) ? id : JSAnimationId;
    this.duration = iterationDuration === minValue ? minValue : clampInfinity((iterationDuration + this._loopDelay) * this.iterationCount - this._loopDelay) || minValue;
    this.onRender = onRender || animDefaults.onRender;
    this._ease = parsedAnimPlaybackEase;
    this._delay = iterationDelay;
    this.iterationDuration = iterationDuration;
    if (!this._autoplay && shouldTriggerRender) this.onRender(this);
  }
  /**
   * @param  {Number} newDuration
   * @return {this}
   */
  stretch(newDuration) {
    const currentDuration = this.duration;
    if (currentDuration === normalizeTime(newDuration)) return this;
    const timeScale = newDuration / currentDuration;
    forEachChildren(this, (tween) => {
      tween._updateDuration = normalizeTime(tween._updateDuration * timeScale);
      tween._changeDuration = normalizeTime(tween._changeDuration * timeScale);
      tween._currentTime *= timeScale;
      tween._delay *= timeScale;
      tween._startTime *= timeScale;
      tween._absoluteStartTime *= timeScale;
      tween._absoluteUpdateStartTime *= timeScale;
      tween._absoluteEndTime *= timeScale;
    });
    return super.stretch(newDuration);
  }
  /**
   * @return {this}
   */
  refresh() {
    forEachChildren(this, (tween) => {
      const toFunc = tween._toFunc;
      const fromFunc = tween._fromFunc;
      if (toFunc || fromFunc) {
        if (fromFunc) {
          decomposeRawValue(fromFunc(), fromTargetObject);
          if (fromTargetObject.u !== tween._unit && tween.target[isDomSymbol]) {
            convertValueUnit(
              /** @type {DOMTarget} */
              tween.target,
              fromTargetObject,
              tween._unit,
              true
            );
          }
          tween._fromNumbers = cloneArray(fromTargetObject.d);
          tween._fromNumber = fromTargetObject.n;
        } else if (toFunc) {
          decomposeRawValue(getOriginalAnimatableValue(tween.target, tween.property, tween._tweenType), decomposedOriginalValue);
          tween._fromNumbers = cloneArray(decomposedOriginalValue.d);
          tween._fromNumber = decomposedOriginalValue.n;
        }
        if (toFunc) {
          decomposeRawValue(toFunc(), toTargetObject);
          tween._toNumbers = cloneArray(toTargetObject.d);
          tween._strings = cloneArray(toTargetObject.s);
          tween._toNumber = toTargetObject.o ? getRelativeValue(tween._fromNumber, toTargetObject.n, toTargetObject.o) : toTargetObject.n;
        }
      }
    });
    if (this.duration === minValue) this.restart();
    return this;
  }
  /**
   * Cancel the animation and revert all the values affected by this animation to their original state
   * @return {this}
   */
  revert() {
    super.revert();
    return revertValues(this);
  }
  /**
   * @typedef {this & {then: null}} ResolvedJSAnimation
   */
  /**
   * @param  {Callback<ResolvedJSAnimation>} [callback]
   * @return Promise<this>
   */
  then(callback) {
    return super.then(callback);
  }
};

// node_modules/animejs/dist/modules/timeline/position.js
/**
 * Anime.js - timeline - ESM
 * @version v4.5.0
 * @license MIT
 * @copyright 2026 - Julian Garnier
 */
var getPrevChildOffset = (timeline, timePosition) => {
  if (stringStartsWith(timePosition, "<")) {
    const goToPrevAnimationOffset = timePosition[1] === "<";
    const prevAnimation = (
      /** @type {Tickable} */
      timeline._tail
    );
    const prevOffset = prevAnimation ? prevAnimation._offset + prevAnimation._delay : 0;
    return goToPrevAnimationOffset ? prevOffset : prevOffset + prevAnimation.duration;
  }
};
var parseTimelinePosition = (timeline, timePosition) => {
  let tlDuration = timeline.iterationDuration;
  if (tlDuration === minValue) tlDuration = 0;
  if (isUnd(timePosition)) return tlDuration;
  if (isNum(+timePosition)) return +timePosition;
  const timePosStr = (
    /** @type {String} */
    timePosition
  );
  const tlLabels = timeline ? timeline.labels : null;
  const hasLabels = !isNil(tlLabels);
  const prevOffset = getPrevChildOffset(timeline, timePosStr);
  const hasSibling = !isUnd(prevOffset);
  const matchedRelativeOperator = relativeValuesExecRgx.exec(timePosStr);
  if (matchedRelativeOperator) {
    const fullOperator = matchedRelativeOperator[0];
    const split = timePosStr.split(fullOperator);
    const labelOffset = hasLabels && split[0] ? tlLabels[split[0]] : tlDuration;
    const parsedOffset = hasSibling ? prevOffset : hasLabels ? labelOffset : tlDuration;
    const parsedNumericalOffset = +split[1];
    return getRelativeValue(parsedOffset, parsedNumericalOffset, fullOperator[0]);
  } else {
    return hasSibling ? prevOffset : hasLabels ? !isUnd(tlLabels[timePosStr]) ? tlLabels[timePosStr] : tlDuration : tlDuration;
  }
};

// node_modules/animejs/dist/modules/timeline/timeline.js
/**
 * Anime.js - timeline - ESM
 * @version v4.5.0
 * @license MIT
 * @copyright 2026 - Julian Garnier
 */
function getTimelineTotalDuration(tl) {
  return clampInfinity((tl.iterationDuration + tl._loopDelay) * tl.iterationCount - tl._loopDelay) || minValue;
}
function addTlChild(childParams, tl, timePosition, targets, index, allTargets) {
  const isSetter = isNum(childParams.duration) && /** @type {Number} */
  childParams.duration <= minValue;
  const adjustedPosition = isSetter ? timePosition - minValue : timePosition;
  if (tl.composition) tick(tl, adjustedPosition, 1, 1, tickModes.AUTO);
  const tlChild = targets ? new JSAnimation(
    targets,
    /** @type {AnimationParams} */
    childParams,
    tl,
    adjustedPosition,
    false,
    index,
    allTargets
  ) : new Timer(
    /** @type {TimerParams} */
    childParams,
    tl,
    adjustedPosition
  );
  if (tl.composition) tlChild.init(true);
  addChild(tl, tlChild);
  forEachChildren(tl, (child) => {
    const childTLOffset = child._offset + child._delay;
    const childDur = childTLOffset + child.duration;
    if (childDur > tl.iterationDuration) tl.iterationDuration = childDur;
  });
  tl.duration = getTimelineTotalDuration(tl);
  return tl;
}
var TLId = 0;
var Timeline = class extends Timer {
  /**
   * @param {TimelineParams} [parameters]
   */
  constructor(parameters = {}) {
    super(
      /** @type {TimerParams&TimelineParams} */
      parameters,
      null,
      0
    );
    ++TLId;
    this.id = !isUnd(parameters.id) ? parameters.id : TLId;
    this.duration = 0;
    this.labels = {};
    const defaultsParams = parameters.defaults;
    const globalDefaults = globals.defaults;
    this.defaults = defaultsParams ? mergeObjects(defaultsParams, globalDefaults) : globalDefaults;
    this.composition = setValue(parameters.composition, true);
    this.onRender = parameters.onRender || globalDefaults.onRender;
    const tlPlaybackEase = setValue(parameters.playbackEase, globalDefaults.playbackEase);
    this._ease = tlPlaybackEase ? parseEase(tlPlaybackEase) : null;
    this.iterationDuration = 0;
  }
  /**
   * @overload
   * @param {TargetsParam} a1
   * @param {AnimationParams} a2
   * @param {TimelinePosition|StaggerFunction<Number|String>|TweakRegister} [a3]
   * @return {this}
   *
   * @overload
   * @param {TimerParams} a1
   * @param {TimelinePosition} [a2]
   * @return {this}
   *
   * @param {TargetsParam|TimerParams} a1
   * @param {TimelinePosition|AnimationParams} a2
   * @param {TimelinePosition|StaggerFunction<Number|String>|TweakRegister} [a3]
   */
  add(a1, a2, a3) {
    const isAnim = isObj(a2);
    const isTimer = isObj(a1);
    if (isAnim || isTimer) {
      this._hasChildren = true;
      if (isAnim) {
        const childParams = (
          /** @type {AnimationParams} */
          a2
        );
        const editorHook = globals.editor && globals.editor.addTimelineChild;
        const isStaggerType = a3 && /** @type {TweakRegister} */
        a3.type === "Stagger" && globals.editor;
        const staggeredPosition = isFnc(a3) ? a3 : null;
        if (staggeredPosition || isStaggerType) {
          const parsedTargetsArray = parseTargets(
            /** @type {TargetsParam} */
            a1
          );
          const tlDuration = this.duration;
          const tlIterationDuration = this.iterationDuration;
          const id = childParams.id;
          let i = 0;
          const parsedLength = parsedTargetsArray.length;
          const resolvedParams = editorHook ? editorHook(
            /** @type {TargetsParam} */
            a1,
            childParams,
            this.id,
            a3,
            parsedLength
          ) : null;
          const staggerFn = staggeredPosition || globals.editor.resolveStagger(
            /** @type {TweakRegister} */
            a3.defaultValue
          );
          parsedTargetsArray.forEach((target) => {
            const staggeredChildParams = { ...resolvedParams || childParams };
            this.duration = tlDuration;
            this.iterationDuration = tlIterationDuration;
            if (!isUnd(id)) staggeredChildParams.id = id + "-" + i;
            const staggeredTimePosition = parseTimelinePosition(this, staggerFn(target, i, parsedTargetsArray, null, this));
            addTlChild(
              staggeredChildParams,
              this,
              staggeredTimePosition,
              target,
              i,
              parsedTargetsArray
            );
            i++;
          });
        } else {
          const resolvedChildParams = editorHook ? editorHook(
            /** @type {TargetsParam} */
            a1,
            childParams,
            this.id,
            a3
          ) : childParams;
          const resolvedPosition = a3 && /** @type {*} */
          a3.type ? (
            /** @type {*} */
            a3.defaultValue
          ) : a3;
          addTlChild(
            resolvedChildParams,
            this,
            parseTimelinePosition(this, resolvedPosition),
            /** @type {TargetsParam} */
            a1
          );
        }
      } else {
        addTlChild(
          /** @type TimerParams */
          a1,
          this,
          parseTimelinePosition(this, a2)
        );
      }
      if (this.composition) this.init(true);
      return this;
    }
  }
  /**
   * @overload
   * @param {Tickable} [synced]
   * @param {TimelinePosition} [position]
   * @return {this}
   *
   * @overload
   * @param {globalThis.Animation} [synced]
   * @param {TimelinePosition} [position]
   * @return {this}
   *
   * @overload
   * @param {WAAPIAnimation} [synced]
   * @param {TimelinePosition} [position]
   * @return {this}
   *
   * @param {Tickable|WAAPIAnimation|globalThis.Animation} [synced]
   * @param {TimelinePosition} [position]
   */
  sync(synced, position) {
    if (isUnd(synced) || synced && isUnd(synced.pause)) return this;
    synced.pause();
    const duration = +/** @type {globalThis.Animation} */
    (synced.effect ? (
      /** @type {globalThis.Animation} */
      synced.effect.getTiming().duration
    ) : (
      /** @type {Tickable} */
      synced.duration
    ));
    if (!isUnd(synced) && !isUnd(
      /** @type {WAAPIAnimation} */
      synced.persist
    )) {
      synced.persist = true;
    }
    const editor = globals.editor;
    const childHook = editor && editor.addTimelineChild;
    if (editor && editor.addTimelineSync) {
      position = editor.addTimelineSync(synced, position, this.id);
      editor.addTimelineChild = null;
    }
    const result = this.add(synced, { currentTime: [0, duration], duration, delay: 0, ease: "linear", playbackEase: "linear" }, position);
    if (editor) editor.addTimelineChild = childHook;
    return result;
  }
  /**
   * @param  {TargetsParam} targets
   * @param  {AnimationParams} parameters
   * @param  {TimelinePosition|StaggerFunction<Number|String>|TweakRegister} [position]
   * @return {this}
   */
  set(targets, parameters, position) {
    if (isUnd(parameters)) return this;
    parameters.duration = minValue;
    parameters.composition = compositionTypes.replace;
    return this.add(targets, parameters, position);
  }
  /**
   * @param {Callback<Timer>} callback
   * @param {TimelinePosition} [position]
   * @return {this}
   */
  call(callback, position) {
    if (isUnd(callback) || callback && !isFnc(callback)) return this;
    if (globals.editor && globals.editor.addTimelineCall) position = globals.editor.addTimelineCall(callback, position, this.id);
    return this.add({ duration: 0, delay: 0, onComplete: () => callback(this) }, position);
  }
  /**
   * @param {String} labelName
   * @param {TimelinePosition} [position]
   * @return {this}
   *
   */
  label(labelName, position) {
    if (isUnd(labelName) || labelName && !isStr(labelName)) return this;
    if (globals.editor && globals.editor.addTimelineLabel) position = globals.editor.addTimelineLabel(labelName, position, this.id);
    this.labels[labelName] = parseTimelinePosition(this, position);
    return this;
  }
  /**
   * @param  {TargetsParam} targets
   * @param  {String} [propertyName]
   * @return {this}
   */
  remove(targets, propertyName) {
    removeTargetsFromRenderable(parseTargets(targets), this, propertyName);
    return this;
  }
  /**
   * @param  {Number} newDuration
   * @return {this}
   */
  stretch(newDuration) {
    const currentDuration = this.duration;
    if (currentDuration === normalizeTime(newDuration)) return this;
    const timeScale = newDuration / currentDuration;
    const labels = this.labels;
    forEachChildren(this, (child) => child.stretch(child.duration * timeScale));
    for (let labelName in labels) labels[labelName] *= timeScale;
    return super.stretch(newDuration);
  }
  /**
   * @return {this}
   */
  refresh() {
    forEachChildren(this, (child) => {
      if (
        /** @type {JSAnimation} */
        child.refresh
      ) child.refresh();
    });
    return this;
  }
  /**
   * @return {this}
   */
  revert() {
    super.revert();
    forEachChildren(this, (child) => child.revert, true);
    return revertValues(this);
  }
  /**
   * @typedef {this & {then: null}} ResolvedTimeline
   */
  /**
   * @param  {Callback<ResolvedTimeline>} [callback]
   * @return Promise<this>
   */
  then(callback) {
    return super.then(callback);
  }
};
var createTimeline = (parameters) => {
  if (globals.editor) {
    return (
      /** @type {Timeline} */
      /** @type {unknown} */
      globals.editor.addTimeline(parameters)
    );
  }
  return new Timeline(parameters).init();
};

// node_modules/animejs/dist/modules/timeline/index.js
/**
 * Anime.js - timeline - ESM
 * @version v4.5.0
 * @license MIT
 * @copyright 2026 - Julian Garnier
 */

// modules/rendering/paint-regions.js
var MAX_PAINT_REGIONS = 8;
function validatePaintRegionName(name) {
  if (typeof name !== "string" || !/^[A-Za-z_][A-Za-z0-9_.:-]{0,127}$/.test(name)) {
    throw new TypeError("A paint region requires a stable name");
  }
  return name;
}
function validatePaintRegionData(data, vertexCount, indices) {
  if (data === void 0) {
    return;
  }
  if (!data || Object.keys(data).length !== 2 || !Array.isArray(data.names) || !data.names.length || data.names.length > MAX_PAINT_REGIONS || new Set(data.names).size !== data.names.length || !(data.indices instanceof Uint16Array) || data.indices.length !== vertexCount) {
    throw new TypeError("Named paint regions require 1..8 unique names and one Uint16 index per vertex");
  }
  data.names.forEach(validatePaintRegionName);
  if (data.indices.some((index) => index > data.names.length)) {
    throw new RangeError("Vertex paint region index exceeds its names");
  }
  for (let offset = 0; offset < (indices?.length ?? vertexCount); offset += 3) {
    const A = data.indices[indices?.[offset] ?? offset], B = data.indices[indices?.[offset + 1] ?? offset + 1], C = data.indices[indices?.[offset + 2] ?? offset + 2];
    if (A !== B || A !== C) {
      throw new TypeError("A painted triangle must belong to one region");
    }
  }
}
function packPaintRegions(names, overrides, output) {
  output.fill(0);
  if (overrides === null || overrides === void 0) {
    return output;
  }
  if (typeof overrides !== "object" || Array.isArray(overrides)) {
    throw new TypeError("paintRegions must be a name-to-RGB object or null");
  }
  for (const NAME in overrides) {
    if (!Object.hasOwn(overrides, NAME)) {
      continue;
    }
    const RGB = overrides[NAME];
    const INDEX = names.indexOf(NAME);
    if (INDEX < 0) {
      throw new TypeError("Unknown paint region: " + NAME);
    }
    if (!(Array.isArray(RGB) || RGB instanceof Float32Array) || RGB.length !== 3 || !Number.isFinite(RGB[0]) || RGB[0] < 0 || RGB[0] > 1 || !Number.isFinite(RGB[1]) || RGB[1] < 0 || RGB[1] > 1 || !Number.isFinite(RGB[2]) || RGB[2] < 0 || RGB[2] > 1) {
      throw new RangeError("Paint region RGB must contain three finite channels in [0,1]");
    }
    const AT = (INDEX + 1) * 4;
    output.set(RGB, AT);
    output[AT + 3] = 1;
  }
  return output;
}

// modules/rendering/yarn-material-record.js
var MATERIAL_KIND = Object.freeze({ none: 0, yarnFill: 1, yarnEdge: 2, sketchFill: 3, sketchEdge: 4 });
var MATERIAL_RECORD_FLOATS = 20;
var MAX_MATERIAL_SURFACES = 16;

// modules/vector-assets/schema.js
var VECTOR_ASSET_SCHEMA_VERSION = 1;
var VECTOR_ASSET_COMPILER_VERSION = "0.12.0";
var ACCEPTED_COMPILER_VERSIONS = /* @__PURE__ */ new Set([
  "0.2.0",
  "0.3.0",
  "0.4.0",
  "0.5.0",
  "0.6.0",
  "0.7.0",
  "0.8.0",
  "0.9.0",
  "0.10.0",
  "0.11.0",
  VECTOR_ASSET_COMPILER_VERSION
]);
var NUMERIC_POSE_FIELDS = Object.freeze(["x", "y", "rotation", "scaleX", "scaleY", "opacity"]);
var IS_OBJECT = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
var EXACT_KEYS = (value, keys) => IS_OBJECT(value) && Object.keys(value).length === keys.length && keys.every((key2) => Object.hasOwn(value, key2));
function validateCompiledAsset(asset) {
  if (!IS_OBJECT(asset) || asset.schemaVersion !== VECTOR_ASSET_SCHEMA_VERSION || !ACCEPTED_COMPILER_VERSIONS.has(asset.compilerVersion) || typeof asset.sourceSha256 !== "string" || !/^[a-f0-9]{64}$/.test(asset.sourceSha256) || !IS_OBJECT(asset.metadata) || !IS_OBJECT(asset.geometry) || !(asset.geometry.vertices instanceof Float32Array) || asset.geometry.vertices.length < 33 || asset.geometry.vertices.length % 11 || asset.geometry.strideFloats !== 11 || asset.geometry.nonScalingStroke !== void 0 && typeof asset.geometry.nonScalingStroke !== "boolean" || asset.geometry.nonScalingStroke && asset.geometry.morphCount !== 0 || asset.geometry.partCount !== asset.metadata.parts?.length || ![0, 2].includes(asset.geometry.morphCount)) {
    throw new TypeError("Invalid compiled SVG vector asset");
  }
  const VERTEX_COUNT = asset.geometry.vertices.length / 11, INDICES = asset.geometry.indices;
  if (INDICES !== void 0 && (!(INDICES instanceof Uint16Array) || INDICES.length < 3 || INDICES.length % 3 || VERTEX_COUNT > 65536 || INDICES.some((index) => index >= VERTEX_COUNT))) {
    throw new TypeError("Invalid compiled SVG vertex indices");
  }
  if (INDICES === void 0 && VERTEX_COUNT % 3) {
    throw new TypeError("Non-indexed compiled SVG geometry must contain complete triangles");
  }
  validatePaintRegionData(asset.geometry.paintRegions, VERTEX_COUNT, INDICES);
  if (["0.8.0", "0.9.0", "0.10.0", VECTOR_ASSET_COMPILER_VERSION].includes(asset.compilerVersion) && asset.compilerOptions === void 0) {
    throw new TypeError("Current SVG compiler options are required");
  }
  if (asset.compilerOptions !== void 0) {
    const CURRENT = asset.compilerVersion === VECTOR_ASSET_COMPILER_VERSION;
    const ROUND_STROKE_VERSION = CURRENT || asset.compilerVersion === "0.10.0";
    const CENTERED_VIEW_BOX_VERSION = ROUND_STROKE_VERSION || asset.compilerVersion === "0.9.0";
    const EXPECTED_KEYS = ROUND_STROKE_VERSION ? ["curveSegments", "normalizeCenteredViewBox", "strokeArcDivisions"] : CENTERED_VIEW_BOX_VERSION ? ["curveSegments", "normalizeCenteredViewBox"] : ["curveSegments"];
    if (!EXACT_KEYS(asset.compilerOptions, EXPECTED_KEYS) || !Number.isSafeInteger(asset.compilerOptions.curveSegments) || asset.compilerOptions.curveSegments < 1 || asset.compilerOptions.curveSegments > 64 || CENTERED_VIEW_BOX_VERSION && typeof asset.compilerOptions.normalizeCenteredViewBox !== "boolean" || ROUND_STROKE_VERSION && (!Number.isSafeInteger(asset.compilerOptions.strokeArcDivisions) || asset.compilerOptions.strokeArcDivisions < 1 || asset.compilerOptions.strokeArcDivisions > 64)) {
      throw new TypeError("Invalid SVG compiler options");
    }
  }
  const EXPRESSION_INDICES = asset.geometry.expressionIndices;
  const INDEX_VARIANTS = asset.geometry.indexVariants;
  if (INDEX_VARIANTS !== void 0 && !IS_OBJECT(INDEX_VARIANTS)) {
    throw new TypeError("Invalid compiled SVG index variants");
  }
  if (EXPRESSION_INDICES !== void 0) {
    if (!IS_OBJECT(EXPRESSION_INDICES)) {
      throw new TypeError("Invalid compiled SVG expression indices");
    }
    for (const [NAME, VARIANT] of Object.entries(EXPRESSION_INDICES)) {
      if (!Object.hasOwn(asset.metadata.expressions ?? {}, NAME) || !(VARIANT instanceof Uint16Array) || VARIANT.length % 3 || VARIANT.some((index) => index >= VERTEX_COUNT)) {
        throw new TypeError("Invalid compiled SVG expression index variant: " + NAME);
      }
    }
  }
  for (const [NAME, VARIANT] of Object.entries(INDEX_VARIANTS ?? {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_.:-]{0,127}$/.test(NAME) || Object.hasOwn(EXPRESSION_INDICES ?? {}, NAME) || !(VARIANT instanceof Uint16Array) || VARIANT.length % 3 || VARIANT.some((index) => index >= VERTEX_COUNT)) {
      throw new TypeError("Invalid compiled SVG named index variant: " + NAME);
    }
  }
  if (asset.geometry.paintRegions) {
    for (const VARIANT of [...Object.values(EXPRESSION_INDICES ?? {}), ...Object.values(INDEX_VARIANTS ?? {})]) {
      validatePaintRegionData(asset.geometry.paintRegions, VERTEX_COUNT, VARIANT);
    }
  }
  if (asset.geometry.shaderSurfaces !== void 0 || asset.geometry.drawOrder !== void 0) {
    throw new TypeError(
      "Compiled SVG assets from compiler 0.11.0 or earlier keep shader surfaces outside the mesh; compile the SVG again"
    );
  }
  const MATERIALS = asset.geometry.materials;
  if (MATERIALS !== void 0) {
    const SURFACES = MATERIALS?.table?.length / MATERIAL_RECORD_FLOATS;
    if (!IS_OBJECT(MATERIALS) || !(MATERIALS.vertices instanceof Float32Array) || !(MATERIALS.table instanceof Float32Array) || MATERIALS.vertices.length !== VERTEX_COUNT * 4 || !Number.isSafeInteger(SURFACES) || SURFACES < 1 || SURFACES > MAX_MATERIAL_SURFACES || MATERIALS.table.some((value) => !Number.isFinite(value))) {
      throw new TypeError("Invalid compiled SVG materials");
    }
    const SHADER_STYLES = (asset.metadata.styles ?? []).filter((style) => style.backend === "shader");
    if (!SHADER_STYLES.length) {
      throw new TypeError("Compiled SVG materials need a shader-backed style in the metadata");
    }
    for (let at = 0; at < MATERIALS.vertices.length; at += 4) {
      const KIND = MATERIALS.vertices[at], SURFACE = MATERIALS.vertices[at + 1];
      if (!Number.isInteger(KIND) || KIND < MATERIAL_KIND.none || KIND > MATERIAL_KIND.sketchEdge || !Number.isInteger(SURFACE) || SURFACE < 0 || SURFACE >= SURFACES || !Number.isFinite(MATERIALS.vertices[at + 2]) || !Number.isFinite(MATERIALS.vertices[at + 3])) {
        throw new TypeError("Invalid compiled SVG material vertex");
      }
    }
  }
  return asset;
}

// modules/vector-assets/pose-channels.js
var FIELDS = Object.freeze(["x", "y", "rotation", "scaleX", "scaleY", "opacity"]);
var DEFAULTS = Object.freeze([0, 0, 0, 1, 1, 1]);
var EASE_CODES = Object.freeze({ linear: 0, inOutSine: 1, outQuad: 2 });
var MAX_SEGMENTS = 64;
function requireFinite(value, label) {
  if (!Number.isFinite(value)) {
    throw new TypeError(`${label} must be finite`);
  }
  return value;
}
function fitsFloat32(value) {
  return Number.isFinite(Math.fround(value));
}
function requirePartIndex(program, partIndex) {
  if (!Number.isInteger(partIndex) || partIndex < 0 || partIndex >= program.partCount) {
    throw new RangeError(`Invalid vector part index: ${partIndex}`);
  }
}
function requireClip(program, clipName) {
  const CLIP = program.clips[clipName];
  if (!CLIP) {
    throw new TypeError(`Unknown vector clip: ${clipName}`);
  }
  if (!CLIP.supported) {
    throw new Error(`Vector clip ${clipName} requires CPU timeline fallback: ${CLIP.reason}`);
  }
  return CLIP;
}
function localTime(clip, elapsedMs) {
  const ELAPSED = requireFinite(elapsedMs, "elapsedMs");
  if (clip.loop === "once") {
    return Math.min(clip.durationMs, Math.max(0, ELAPSED));
  }
  if (clip.loop === "repeat") {
    return (ELAPSED % clip.durationMs + clip.durationMs) % clip.durationMs;
  }
  const CYCLE = clip.durationMs * 2;
  const POINT = (ELAPSED % CYCLE + CYCLE) % CYCLE;
  return POINT <= clip.durationMs ? POINT : CYCLE - POINT;
}
function easedAmount(code, fraction) {
  if (code === 1) {
    return fraction < 0.5 ? (1 - Math.cos(fraction * 2 * (Math.PI / 2))) / 2 : 1 - (1 - Math.cos((fraction * -2 + 2) * (Math.PI / 2))) / 2;
  }
  if (code === 2) {
    return 1 - (1 - fraction) * (1 - fraction);
  }
  return fraction;
}
function channelValue(data, headerTexel, timeMs) {
  const HEADER = headerTexel * 4;
  const FIRST = data[HEADER];
  const COUNT = data[HEADER + 1];
  let value = data[HEADER + 2];
  for (let segment = 0; segment < COUNT; segment++) {
    const OFFSET = (FIRST + segment * 2) * 4;
    const START = data[OFFSET + 2];
    const END = data[OFFSET + 3];
    if (timeMs < START) {
      break;
    }
    if (timeMs < END) {
      const FRACTION = (timeMs - START) / (END - START);
      return data[OFFSET] + (data[OFFSET + 1] - data[OFFSET]) * easedAmount(data[OFFSET + 4], FRACTION);
    }
    value = data[OFFSET + 1];
  }
  return value;
}
function compilePoseChannels(metadata) {
  if (!metadata || !Array.isArray(metadata.parts) || !metadata.parts.length || metadata.parts.length > 16 || !metadata.clips || typeof metadata.clips !== "object" || Array.isArray(metadata.clips) || !Object.keys(metadata.clips).length) {
    throw new TypeError("Vector pose metadata requires parts and clips");
  }
  const PARTS = metadata.parts;
  const PART_COUNT = PARTS.length;
  const INDICES = /* @__PURE__ */ new Map();
  for (let index = 0; index < PART_COUNT; index++) {
    const PART = PARTS[index];
    if (typeof PART?.id !== "string" || INDICES.has(PART.id) || !Array.isArray(PART.pivot) || PART.pivot.length !== 2) {
      throw new TypeError(`Invalid vector part at index ${index}`);
    }
    requireFinite(PART.pivot[0], `part ${PART.id} pivot x`);
    requireFinite(PART.pivot[1], `part ${PART.id} pivot y`);
    if (!fitsFloat32(PART.pivot[0]) || !fitsFloat32(PART.pivot[1])) {
      throw new RangeError(`Part ${PART.id} pivot exceeds Float32 range`);
    }
    INDICES.set(PART.id, index);
  }
  const DATA = [];
  for (const PART of PARTS) {
    if (PART.parent !== null && !INDICES.has(PART.parent)) {
      throw new TypeError(`Unknown vector part parent: ${PART.parent}`);
    }
    DATA.push(PART.pivot[0], PART.pivot[1], PART.parent === null ? -1 : INDICES.get(PART.parent), 0);
  }
  for (let index = 0; index < PART_COUNT; index++) {
    const SEEN = /* @__PURE__ */ new Set([index]);
    let parent = DATA[index * 4 + 2];
    while (parent !== -1) {
      if (SEEN.has(parent)) {
        throw new TypeError(`Vector part hierarchy contains a cycle: ${PARTS[index].id}`);
      }
      SEEN.add(parent);
      parent = DATA[parent * 4 + 2];
    }
  }
  const CLIPS = /* @__PURE__ */ Object.create(null);
  let maxSegments = 0;
  for (const [NAME, CLIP] of Object.entries(metadata.clips)) {
    if (!CLIP || !Array.isArray(CLIP.keyframes) || CLIP.keyframes.length < 2) {
      throw new TypeError(`Clip ${NAME} requires at least two keyframes`);
    }
    const DURATION = requireFinite(CLIP.durationMs, `clip ${NAME} durationMs`);
    if (DURATION <= 0 || !["once", "repeat", "alternate"].includes(CLIP.loop)) {
      throw new TypeError(`Invalid clip duration or loop: ${NAME}`);
    }
    const FRAMES = CLIP.keyframes;
    let previousTime = -Infinity;
    for (const FRAME of FRAMES) {
      const TIME = requireFinite(FRAME?.timeMs, `clip ${NAME} keyframe timeMs`);
      if (TIME <= previousTime || !FRAME.parts || typeof FRAME.parts !== "object" || Array.isArray(FRAME.parts)) {
        throw new TypeError(`Invalid clip keyframe: ${NAME}`);
      }
      for (const [PART_ID, POSE] of Object.entries(FRAME.parts)) {
        if (!INDICES.has(PART_ID) || !POSE || typeof POSE !== "object" || Array.isArray(POSE)) {
          throw new TypeError(`Invalid clip part pose: ${NAME}/${PART_ID}`);
        }
        if (!Object.keys(POSE).length) {
          throw new TypeError(`Empty clip part pose: ${NAME}/${PART_ID}`);
        }
        for (const [FIELD, VALUE] of Object.entries(POSE)) {
          if (!FIELDS.includes(FIELD)) {
            throw new TypeError(`Unknown clip pose field: ${NAME}/${PART_ID}/${FIELD}`);
          }
          requireFinite(VALUE, `clip ${NAME}/${PART_ID}/${FIELD}`);
          if (FIELD === "opacity" && (VALUE < 0 || VALUE > 1)) {
            throw new RangeError(`Clip part opacity must be in [0,1]: ${NAME}/${PART_ID}`);
          }
          if ((FIELD === "scaleX" || FIELD === "scaleY") && VALUE === 0) {
            throw new RangeError(`Clip part scale cannot be zero: ${NAME}/${PART_ID}`);
          }
        }
      }
      previousTime = TIME;
    }
    if (FRAMES[0].timeMs !== 0 || previousTime !== DURATION) {
      throw new RangeError(`Clip ${NAME} keyframes must span 0..durationMs`);
    }
    const CHANNELS = Array.from({ length: PART_COUNT * FIELDS.length }, (_, channelIndex) => ({
      initial: FRAMES[0].parts[PARTS[Math.floor(channelIndex / FIELDS.length)].id]?.[FIELDS[channelIndex % FIELDS.length]] ?? DEFAULTS[channelIndex % FIELDS.length],
      segments: []
    }));
    let reason = null;
    if (!fitsFloat32(DURATION)) {
      reason = "durationMs exceeds Float32 range";
    }
    for (let frameIndex = 1; frameIndex < FRAMES.length; frameIndex++) {
      const FRAME = FRAMES[frameIndex];
      const START = FRAMES[frameIndex - 1].timeMs;
      const CODE = EASE_CODES[FRAME.easing];
      for (const [PART_ID, POSE] of Object.entries(FRAME.parts)) {
        const PART_INDEX = INDICES.get(PART_ID);
        for (const [FIELD, TARGET] of Object.entries(POSE)) {
          const CHANNEL = CHANNELS[PART_INDEX * FIELDS.length + FIELDS.indexOf(FIELD)];
          if (CODE === void 0 && reason === null) {
            reason = `unsupported easing ${String(FRAME.easing)} at keyframe ${frameIndex}`;
          }
          if (CHANNEL.segments.length >= MAX_SEGMENTS && reason === null) {
            reason = `channel ${PART_ID}.${FIELD} exceeds ${MAX_SEGMENTS} segments`;
          }
          const FROM = CHANNEL.segments.length ? CHANNEL.segments.at(-1)[1] : CHANNEL.initial;
          CHANNEL.segments.push([FROM, TARGET, START, FRAME.timeMs, CODE]);
        }
      }
    }
    if (reason === null) {
      for (const CHANNEL of CHANNELS) {
        if (!fitsFloat32(CHANNEL.initial)) {
          reason = "initial pose value exceeds Float32 range";
          break;
        }
        for (const [FROM, TARGET, START, END] of CHANNEL.segments) {
          if (![FROM, TARGET, START, END].every(fitsFloat32)) {
            reason = "pose value or keyframe time exceeds Float32 range";
            break;
          }
          if (Math.fround(END) <= Math.fround(START)) {
            reason = "keyframe interval collapses at Float32 precision";
            break;
          }
        }
        if (reason !== null) {
          break;
        }
      }
    }
    if (reason !== null) {
      CLIPS[NAME] = { supported: false, reason, durationMs: DURATION, loop: CLIP.loop, headerBase: -1 };
      continue;
    }
    const HEADER_BASE = DATA.length / 4;
    const SEGMENT_BASE = HEADER_BASE + PART_COUNT * FIELDS.length;
    let nextSegment = SEGMENT_BASE;
    for (const CHANNEL of CHANNELS) {
      DATA.push(nextSegment, CHANNEL.segments.length, CHANNEL.initial, 0);
      nextSegment += CHANNEL.segments.length * 2;
      maxSegments = Math.max(maxSegments, CHANNEL.segments.length);
    }
    for (const CHANNEL of CHANNELS) {
      for (const [FROM, TARGET, START, END, CODE] of CHANNEL.segments) {
        DATA.push(FROM, TARGET, START, END, CODE, 0, 0, 0);
      }
    }
    CLIPS[NAME] = { supported: true, reason: null, durationMs: DURATION, loop: CLIP.loop, headerBase: HEADER_BASE };
  }
  return {
    partCount: PART_COUNT,
    partIds: PARTS.map((part) => part.id),
    data: Float32Array.from(DATA),
    cpuData: Float64Array.from(DATA),
    clips: CLIPS,
    maxSegments
  };
}
function samplePoseChannels(program, clipName, elapsedMs, partIndex) {
  requirePartIndex(program, partIndex);
  const CLIP = requireClip(program, clipName);
  const TIME = localTime(CLIP, elapsedMs);
  const HEADER = CLIP.headerBase + partIndex * FIELDS.length;
  return Object.fromEntries(
    FIELDS.map((field, index) => [field, channelValue(program.cpuData, HEADER + index, TIME)])
  );
}
function samplePartTransform(program, clipName, elapsedMs, partIndex, basePoses) {
  requirePartIndex(program, partIndex);
  const DATA = program.cpuData;
  const CHAIN = [];
  let index = partIndex;
  while (index !== -1) {
    CHAIN.push(index);
    index = DATA[index * 4 + 2];
  }
  let matrix = [1, 0, 0, 1, 0, 0];
  let opacity = 1;
  for (let chainIndex = CHAIN.length - 1; chainIndex >= 0; chainIndex--) {
    const PART_INDEX = CHAIN[chainIndex];
    const AUTHORED = samplePoseChannels(program, clipName, elapsedMs, PART_INDEX);
    const BASE = basePoses?.[PART_INDEX];
    const X = (BASE?.x ?? 0) + AUTHORED.x;
    const Y = (BASE?.y ?? 0) + AUTHORED.y;
    const ROTATION = (BASE?.rotation ?? 0) + AUTHORED.rotation;
    const SCALE_X = (BASE?.scaleX ?? 1) * AUTHORED.scaleX;
    const SCALE_Y = (BASE?.scaleY ?? 1) * AUTHORED.scaleY;
    const PX = DATA[PART_INDEX * 4];
    const PY = DATA[PART_INDEX * 4 + 1];
    const COSINE = Math.cos(ROTATION);
    const SINE = Math.sin(ROTATION);
    const A = COSINE * SCALE_X;
    const B = SINE * SCALE_X;
    const C = -SINE * SCALE_Y;
    const D = COSINE * SCALE_Y;
    const E = PX + X - A * PX - C * PY;
    const F = PY + Y - B * PX - D * PY;
    matrix = [
      matrix[0] * A + matrix[2] * B,
      matrix[1] * A + matrix[3] * B,
      matrix[0] * C + matrix[2] * D,
      matrix[1] * C + matrix[3] * D,
      matrix[0] * E + matrix[2] * F + matrix[4],
      matrix[1] * E + matrix[3] * F + matrix[5]
    ];
    opacity *= (BASE?.opacity ?? 1) * AUTHORED.opacity;
  }
  return { transform: matrix, opacity };
}

// modules/vector-assets/runtime.js
var IDENTITY = Object.freeze([1, 0, 0, 1, 0, 0]);
var DEFAULT_POSE = Object.freeze({
  x: 0,
  y: 0,
  rotation: 0,
  scaleX: 1,
  scaleY: 1,
  opacity: 1
});
var POSE_FIELDS = Object.keys(DEFAULT_POSE);
var NOW = () => globalThis.performance?.now?.() ?? null;
var FINITE_TIME = (value, name) => {
  if (!Number.isFinite(value)) {
    throw new TypeError(`${name} must be a finite absolute display time in milliseconds`);
  }
  return value;
};
function localMatrix(pivot, pose) {
  const [PX, PY] = pivot, COSINE = Math.cos(pose.rotation), SINE = Math.sin(pose.rotation);
  const A = COSINE * pose.scaleX, B = SINE * pose.scaleX, C = -SINE * pose.scaleY, D = COSINE * pose.scaleY;
  return [A, B, C, D, PX + pose.x - A * PX - C * PY, PY + pose.y - B * PX - D * PY];
}
function multiply(a, b) {
  return [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5]
  ];
}
function transformPoint(matrix, point) {
  return {
    x: matrix[0] * point[0] + matrix[2] * point[1] + matrix[4],
    y: matrix[1] * point[0] + matrix[3] * point[1] + matrix[5]
  };
}
function effectivePose(base, authored) {
  return {
    x: base.x + authored.x,
    y: base.y + authored.y,
    rotation: base.rotation + authored.rotation,
    scaleX: base.scaleX * authored.scaleX,
    scaleY: base.scaleY * authored.scaleY,
    opacity: base.opacity * authored.opacity
  };
}
function loopTime(clip, elapsed) {
  if (clip.loop === "once") {
    return Math.min(clip.durationMs, Math.max(0, elapsed));
  }
  if (clip.loop === "repeat") {
    return (elapsed % clip.durationMs + clip.durationMs) % clip.durationMs;
  }
  const CYCLE = clip.durationMs * 2, POINT = (elapsed % CYCLE + CYCLE) % CYCLE;
  return POINT <= clip.durationMs ? POINT : CYCLE - POINT;
}
function buildClipTimeline(clip, parts) {
  const TRACKS = new Map(
    parts.map((part) => [
      part.id,
      {
        ...DEFAULT_POSE
      }
    ])
  );
  const FIRST = clip.keyframes[0];
  for (const [PART_ID, POSE] of Object.entries(FIRST.parts)) {
    Object.assign(TRACKS.get(PART_ID), POSE);
  }
  const TIMELINE = createTimeline({
    autoplay: false
  });
  for (let frameIndex = 1; frameIndex < clip.keyframes.length; frameIndex++) {
    const PREVIOUS = clip.keyframes[frameIndex - 1], FRAME = clip.keyframes[frameIndex];
    const DURATION = FRAME.timeMs - PREVIOUS.timeMs;
    for (const [PART_ID, POSE] of Object.entries(FRAME.parts)) {
      TIMELINE.add(
        TRACKS.get(PART_ID),
        {
          ...POSE,
          duration: DURATION,
          ease: FRAME.easing
        },
        PREVIOUS.timeMs
      );
    }
  }
  if (!TIMELINE.paused) {
    TIMELINE.pause();
  }
  return {
    timeline: TIMELINE,
    tracks: TRACKS
  };
}
function copyPose(pose) {
  return Object.fromEntries(POSE_FIELDS.map((field) => [field, pose[field]]));
}
function authoredMorph(sketch, displayTimeMs) {
  if (!sketch) {
    return [0, 0];
  }
  const PHASE = (displayTimeMs % sketch.periodMs + sketch.periodMs) % sketch.periodMs / sketch.periodMs * 3;
  const SEGMENT = Math.floor(PHASE), AMOUNT = PHASE - SEGMENT;
  if (SEGMENT === 0) {
    return [AMOUNT, 0];
  }
  if (SEGMENT === 1) {
    return [1 - AMOUNT, AMOUNT];
  }
  return [0, 1 - AMOUNT];
}
function blendPoses(from, to, amount, partIds) {
  const OUTPUT = /* @__PURE__ */ new Map();
  for (const ID of partIds) {
    const A = from.get(ID) ?? DEFAULT_POSE, B = to.get(ID) ?? DEFAULT_POSE;
    OUTPUT.set(
      ID,
      Object.fromEntries(POSE_FIELDS.map((field) => [field, A[field] + (B[field] - A[field]) * amount]))
    );
  }
  return OUTPUT;
}
function retainVectorAsset(meshRenderer, compiledAsset) {
  if (!meshRenderer?.createMesh || !meshRenderer?.drawMesh || !meshRenderer?.deleteMesh) {
    throw new TypeError("A GameKit MeshRenderer is required");
  }
  validateCompiledAsset(compiledAsset);
  const METADATA = compiledAsset.metadata;
  const SKETCH_MORPH_STYLE = METADATA.styles?.find((style) => style.kind === "sketch") ?? null;
  const PART_INDICES = new Map(METADATA.parts.map((part, index) => [part.id, index]));
  const CLIPS = METADATA.clips;
  const OPACITY_CLIPS = new Set(
    Object.entries(CLIPS).filter(
      ([, definition]) => definition.keyframes.some(
        (frame) => Object.values(frame.parts).some((pose) => Object.hasOwn(pose, "opacity"))
      )
    ).map(([name]) => name)
  );
  const POSE_API = typeof meshRenderer.createPoseSource === "function" && typeof meshRenderer.createPoseInstance === "function" && typeof meshRenderer.preparePose === "function" && typeof meshRenderer.prepareCpuPose === "function" && typeof meshRenderer.deletePoseInstance === "function" && typeof meshRenderer.deletePoseSource === "function";
  const GEOMETRY = compiledAsset.geometry;
  const POSE_PROGRAM = POSE_API ? compilePoseChannels(METADATA) : null;
  let mesh = null;
  let poseSource = null;
  try {
    mesh = GEOMETRY.vertices.length ? meshRenderer.createMesh(GEOMETRY) : null;
    poseSource = POSE_PROGRAM ? meshRenderer.createPoseSource(POSE_PROGRAM) : null;
  } catch (error) {
    if (mesh) {
      meshRenderer.deleteMesh(mesh);
    }
    if (poseSource) {
      meshRenderer.deletePoseSource(poseSource);
    }
    throw error;
  }
  const ACTORS = /* @__PURE__ */ new Set();
  let disposed = false;
  const REQUIRE_READY = () => {
    if (disposed) {
      throw new Error("Vector asset is disposed");
    }
  };
  const CREATE_ACTOR = ({ clip = Object.keys(CLIPS)[0], startedAtMs = 0 } = {}, release = null) => {
    REQUIRE_READY();
    if (!Object.hasOwn(CLIPS, clip)) {
      throw new TypeError(`Unknown vector clip: ${clip}`);
    }
    FINITE_TIME(startedAtMs, "startedAtMs");
    const TIMELINES = /* @__PURE__ */ new Map();
    for (const [NAME, DEFINITION] of Object.entries(CLIPS)) {
      TIMELINES.set(NAME, buildClipTimeline(DEFINITION, METADATA.parts));
    }
    const EXPRESSION_PARTS = new Set(
      Object.values(METADATA.expressions).flatMap((expression2) => [...expression2.show, ...expression2.hide])
    );
    const VISIBLE = new Map(METADATA.parts.map((part) => [part.id, !EXPRESSION_PARTS.has(part.id)]));
    const BASE_POSE = new Map(
      METADATA.parts.map((part) => [
        part.id,
        {
          ...DEFAULT_POSE
        }
      ])
    );
    const INITIAL = METADATA.expressions[METADATA.defaultExpression];
    for (const ID of INITIAL.show) {
      VISIBLE.set(ID, true);
    }
    for (const ID of INITIAL.hide) {
      VISIBLE.set(ID, false);
    }
    let rootPlayback = {
      kind: "clip",
      name: clip,
      startedAtMs
    };
    let expression = METADATA.defaultExpression;
    let visibilityOverridden = false;
    let displayTimeMs = startedAtMs;
    let currentPose = new Map(
      METADATA.parts.map((part) => [
        part.id,
        {
          ...DEFAULT_POSE
        }
      ])
    );
    let playbackRevision = 0;
    let sampledPlaybackRevision = -1;
    let soughtPlaybackRevision = -1;
    let sampledTimeMs = NaN;
    let poseRevision = 0;
    let resolvedRevision = -1;
    let resolvedPose = null;
    let preparedPose = null;
    const RESOLVED_MATRICES = /* @__PURE__ */ new Map();
    let actorDisposed = false;
    const POSE_INSTANCE = poseSource ? meshRenderer.createPoseInstance(poseSource) : null;
    const POSE_METRICS = {
      fullSamples: 0,
      fullSampleMs: 0,
      partialQueries: 0,
      partialParts: 0,
      partialSampleMs: 0,
      gpuPrepares: 0,
      cpuFallbacks: 0,
      preparedPoseCacheHits: 0
    };
    const INVALIDATE_POSE = () => {
      poseRevision++;
      preparedPose = null;
    };
    const ASSERT_ACTOR = () => {
      REQUIRE_READY();
      if (actorDisposed) {
        throw new Error("Vector actor is disposed");
      }
    };
    const SAMPLE_CLIP = (playback, timeMs) => {
      const DEFINITION = CLIPS[playback.name], LOCAL_TIME = loopTime(DEFINITION, timeMs - playback.startedAtMs);
      const RECORD = TIMELINES.get(playback.name);
      RECORD.timeline.seek(LOCAL_TIME, true);
      const OUTPUT = /* @__PURE__ */ new Map();
      for (const [ID, POSE] of RECORD.tracks) {
        OUTPUT.set(ID, copyPose(POSE));
      }
      return OUTPUT;
    };
    const SAMPLE = (playback, timeMs) => {
      if (playback.kind === "clip") {
        return SAMPLE_CLIP(playback, timeMs);
      }
      const ELAPSED_MS = timeMs - playback.atMs;
      if (ELAPSED_MS < 0) {
        return SAMPLE(playback.from, timeMs);
      }
      if (playback.durationMs === 0) {
        return SAMPLE(playback.to, timeMs);
      }
      if (ELAPSED_MS === 0) {
        return SAMPLE(playback.from, timeMs);
      }
      if (ELAPSED_MS >= playback.durationMs) {
        return SAMPLE(playback.to, timeMs);
      }
      const SOURCE = SAMPLE(playback.from, timeMs);
      const TARGET = SAMPLE(playback.to, timeMs);
      const AMOUNT = ELAPSED_MS / playback.durationMs;
      return blendPoses(
        SOURCE,
        TARGET,
        AMOUNT,
        METADATA.parts.map((part) => part.id)
      );
    };
    const ACTIVE_CLIP = (playback, timeMs) => {
      if (playback.kind === "clip") {
        return playback;
      }
      const ELAPSED = timeMs - playback.atMs;
      if (ELAPSED < 0 || ELAPSED === 0 && playback.durationMs !== 0) {
        return ACTIVE_CLIP(playback.from, timeMs);
      }
      if (playback.durationMs === 0 || ELAPSED >= playback.durationMs) {
        return ACTIVE_CLIP(playback.to, timeMs);
      }
      return null;
    };
    const GPU_CLIP = () => {
      const ACTIVE = ACTIVE_CLIP(rootPlayback, displayTimeMs);
      return ACTIVE && POSE_PROGRAM?.clips[ACTIVE.name]?.supported ? ACTIVE : null;
    };
    const HAS_OPACITY_CHANNEL = (playback, timeMs) => {
      if (playback.kind === "clip") {
        return OPACITY_CLIPS.has(playback.name);
      }
      const ELAPSED = timeMs - playback.atMs;
      if (ELAPSED <= 0 && playback.durationMs !== 0) {
        return HAS_OPACITY_CHANNEL(playback.from, timeMs);
      }
      if (playback.durationMs === 0 || ELAPSED >= playback.durationMs) {
        return HAS_OPACITY_CHANNEL(playback.to, timeMs);
      }
      return HAS_OPACITY_CHANNEL(playback.from, timeMs) || HAS_OPACITY_CHANNEL(playback.to, timeMs);
    };
    const ENSURE_CURRENT_POSE = () => {
      if (sampledTimeMs !== displayTimeMs || sampledPlaybackRevision !== playbackRevision) {
        const START = NOW();
        currentPose = SAMPLE(rootPlayback, displayTimeMs);
        if (START !== null) {
          POSE_METRICS.fullSampleMs += NOW() - START;
        }
        sampledTimeMs = displayTimeMs;
        sampledPlaybackRevision = playbackRevision;
        POSE_METRICS.fullSamples++;
      }
    };
    const SEEK = (timeMs) => {
      ASSERT_ACTOR();
      const NEXT_TIME_MS = FINITE_TIME(timeMs, "displayTimeMs");
      if (NEXT_TIME_MS !== displayTimeMs || soughtPlaybackRevision !== playbackRevision) {
        displayTimeMs = NEXT_TIME_MS;
        soughtPlaybackRevision = playbackRevision;
        INVALIDATE_POSE();
      }
      return ACTOR;
    };
    const SET_EXPRESSION = (name) => {
      ASSERT_ACTOR();
      const VARIANT = METADATA.expressions[name];
      if (!VARIANT) {
        throw new TypeError(`Unknown vector expression: ${name}`);
      }
      if (name === expression && !visibilityOverridden) {
        return ACTOR;
      }
      for (const ID of EXPRESSION_PARTS) {
        VISIBLE.set(ID, false);
      }
      for (const ID of VARIANT.show) {
        VISIBLE.set(ID, true);
      }
      for (const ID of VARIANT.hide) {
        VISIBLE.set(ID, false);
      }
      expression = name;
      visibilityOverridden = false;
      INVALIDATE_POSE();
      return ACTOR;
    };
    const SET_PART_VISIBLE = (id, isVisible) => {
      ASSERT_ACTOR();
      if (!PART_INDICES.has(id) || typeof isVisible !== "boolean") {
        throw new TypeError("Known part id and boolean visibility required");
      }
      VISIBLE.set(id, isVisible);
      visibilityOverridden = true;
      INVALIDATE_POSE();
      return ACTOR;
    };
    const SET_BASE_POSE = (id, pose) => {
      ASSERT_ACTOR();
      if (!PART_INDICES.has(id) || !pose || typeof pose !== "object" || Array.isArray(pose)) {
        throw new TypeError("Known part and pose object required");
      }
      const CURRENT = BASE_POSE.get(id);
      for (const [FIELD, VALUE] of Object.entries(pose)) {
        if (!POSE_FIELDS.includes(FIELD) || !Number.isFinite(VALUE)) {
          throw new TypeError("Part base poses accept only finite authored numeric pose fields");
        }
        if (FIELD === "opacity" && (VALUE < 0 || VALUE > 1)) {
          throw new RangeError("Part opacity must be in [0,1]");
        }
        if ((FIELD === "scaleX" || FIELD === "scaleY") && VALUE === 0) {
          throw new RangeError("Part scale cannot be zero");
        }
      }
      let changed = false;
      for (const [FIELD, VALUE] of Object.entries(pose)) {
        if (CURRENT[FIELD] !== VALUE) {
          CURRENT[FIELD] = VALUE;
          changed = true;
        }
      }
      if (changed) {
        INVALIDATE_POSE();
      }
      return ACTOR;
    };
    const PLAY = (name, atMs = displayTimeMs) => {
      ASSERT_ACTOR();
      if (!Object.hasOwn(CLIPS, name)) {
        throw new TypeError(`Unknown vector clip: ${name}`);
      }
      rootPlayback = {
        kind: "clip",
        name,
        startedAtMs: FINITE_TIME(atMs, "atMs")
      };
      playbackRevision++;
      return SEEK(atMs);
    };
    const TRANSITION_TO = (name, atMs = displayTimeMs, durationMs = 0) => {
      ASSERT_ACTOR();
      if (!Object.hasOwn(CLIPS, name)) {
        throw new TypeError(`Unknown vector clip: ${name}`);
      }
      FINITE_TIME(atMs, "atMs");
      if (!Number.isFinite(durationMs) || durationMs < 0) {
        throw new RangeError("transition duration must be finite and nonnegative");
      }
      rootPlayback = {
        kind: "transition",
        from: rootPlayback,
        to: {
          kind: "clip",
          name,
          startedAtMs: atMs
        },
        atMs,
        durationMs
      };
      playbackRevision++;
      return SEEK(atMs);
    };
    const WORLD_MATRICES = () => {
      if (resolvedRevision === poseRevision) {
        return resolvedPose;
      }
      ENSURE_CURRENT_POSE();
      const OUTPUT = RESOLVED_MATRICES;
      OUTPUT.clear();
      const RESOLVE_PART = (id) => {
        if (OUTPUT.has(id)) {
          return OUTPUT.get(id);
        }
        const DEFINITION = METADATA.parts[PART_INDICES.get(id)];
        const POSE = effectivePose(BASE_POSE.get(id), currentPose.get(id));
        const LOCAL = localMatrix(DEFINITION.pivot, POSE);
        const MATRIX = DEFINITION.parent === null ? LOCAL : multiply(RESOLVE_PART(DEFINITION.parent), LOCAL);
        OUTPUT.set(id, MATRIX);
        return MATRIX;
      };
      for (const PART of METADATA.parts) {
        RESOLVE_PART(PART.id);
      }
      const PART_POSES2 = METADATA.parts.map((part) => {
        const POSE = RESOLVE_PART_POSE(part, OUTPUT);
        return {
          transform: POSE.transform,
          opacity: POSE.opacity,
          visible: POSE.visible
        };
      });
      resolvedPose = {
        matrices: OUTPUT,
        parts: PART_POSES2,
        morph: authoredMorph(SKETCH_MORPH_STYLE, displayTimeMs)
      };
      resolvedRevision = poseRevision;
      return resolvedPose;
    };
    const PARTIAL_POSE = (id, activeClip) => {
      const START = NOW();
      const BASE_POSES = METADATA.parts.map((part) => BASE_POSE.get(part.id));
      const ELAPSED = displayTimeMs - activeClip.startedAtMs;
      const RESULT = samplePartTransform(
        POSE_PROGRAM,
        activeClip.name,
        ELAPSED,
        PART_INDICES.get(id),
        BASE_POSES
      );
      let partId = id;
      let visible = true;
      let sampledParts = 0;
      while (partId !== null) {
        visible &&= VISIBLE.get(partId) !== false;
        sampledParts++;
        partId = METADATA.parts[PART_INDICES.get(partId)].parent;
      }
      POSE_METRICS.partialQueries++;
      POSE_METRICS.partialParts += sampledParts;
      if (START !== null) {
        POSE_METRICS.partialSampleMs += NOW() - START;
      }
      return { ...RESULT, visible };
    };
    const GET_SOCKET = (id) => {
      ASSERT_ACTOR();
      const SOCKET = METADATA.sockets[id];
      if (!SOCKET) {
        throw new TypeError(`Unknown vector socket: ${id}`);
      }
      const ACTIVE = GPU_CLIP();
      const MATRIX = ACTIVE ? PARTIAL_POSE(SOCKET.part, ACTIVE).transform : WORLD_MATRICES().matrices.get(SOCKET.part);
      return transformPoint(MATRIX, SOCKET.point);
    };
    const RESOLVE_PART_POSE = (part, matrices) => {
      let parentVisible = true;
      let opacity = 1;
      let parent = part;
      while (parent) {
        parentVisible &&= VISIBLE.get(parent.id) !== false;
        opacity *= effectivePose(BASE_POSE.get(parent.id), currentPose.get(parent.id)).opacity;
        parent = parent.parent === null ? null : METADATA.parts[PART_INDICES.get(parent.parent)];
      }
      return {
        transform: matrices.get(part.id),
        opacity,
        visible: parentVisible
      };
    };
    const PART_POSES = () => {
      ASSERT_ACTOR();
      const RESOLVED = WORLD_MATRICES();
      return RESOLVED.parts.map((pose, index) => {
        return {
          transform: pose.transform.slice(),
          morph: RESOLVED.morph.slice(),
          opacity: pose.opacity,
          visible: pose.visible,
          index
        };
      });
    };
    const VALIDATE_EXCLUSIONS = (excludeParts) => {
      if (excludeParts === null) {
        return 0;
      }
      if (!(excludeParts instanceof Set)) {
        throw new TypeError("excludeParts must be a Set of known part ids");
      }
      let excludedMask = 0;
      for (const PART_ID of excludeParts) {
        if (!PART_INDICES.has(PART_ID)) {
          throw new TypeError(`Unknown vector part: ${PART_ID}`);
        }
        excludedMask |= 1 << PART_INDICES.get(PART_ID);
      }
      return excludedMask;
    };
    const PREPARE_POSE = ({ excludeParts = null } = {}) => {
      ASSERT_ACTOR();
      const EXCLUDED_MASK = VALIDATE_EXCLUSIONS(excludeParts);
      if (!POSE_INSTANCE) {
        return null;
      }
      const DEVICE = meshRenderer.device;
      const FRAME = DEVICE?.stats?.frame;
      const RESTORES = DEVICE?.stats?.restores ?? 0;
      const GPU_UNAVAILABLE = meshRenderer.poseRenderer?.gpuUnavailableReason ?? null;
      const CACHEABLE = Number.isSafeInteger(FRAME) && (DEVICE?.state === void 0 || DEVICE.state === "ready") && (meshRenderer.state === void 0 || meshRenderer.state === "ready");
      if (CACHEABLE && preparedPose?.revision === poseRevision && preparedPose.frame === FRAME && preparedPose.restores === RESTORES && preparedPose.gpuUnavailable === GPU_UNAVAILABLE && preparedPose.excludedMask === EXCLUDED_MASK) {
        POSE_METRICS.preparedPoseCacheHits++;
        return preparedPose.handle;
      }
      const CACHE_PREPARED = (handle) => {
        preparedPose = CACHEABLE && handle ? {
          revision: poseRevision,
          frame: FRAME,
          restores: RESTORES,
          gpuUnavailable: meshRenderer.poseRenderer?.gpuUnavailableReason ?? null,
          excludedMask: EXCLUDED_MASK,
          handle
        } : null;
        return handle;
      };
      const MORPH = authoredMorph(SKETCH_MORPH_STYLE, displayTimeMs);
      const ACTIVE = GPU_CLIP();
      if (ACTIVE) {
        const HANDLE = meshRenderer.preparePose(POSE_INSTANCE, {
          clipName: ACTIVE.name,
          elapsedMs: displayTimeMs - ACTIVE.startedAtMs,
          basePoses: METADATA.parts.map((part) => BASE_POSE.get(part.id)),
          visible: METADATA.parts.map((part) => VISIBLE.get(part.id) !== false),
          excluded: METADATA.parts.map((part) => excludeParts?.has(part.id) ?? false),
          morph: MORPH
        });
        if (HANDLE) {
          POSE_METRICS.gpuPrepares++;
          return CACHE_PREPARED(HANDLE);
        }
      }
      const RESOLVED = WORLD_MATRICES();
      const PARTS = RESOLVED.parts.map((pose, index) => ({
        transform: pose.transform,
        opacity: pose.opacity,
        visible: pose.visible && !excludeParts?.has(METADATA.parts[index].id)
      }));
      const ACTIVE_PLAYBACK = ACTIVE_CLIP(rootPlayback, displayTimeMs);
      const REASON = ACTIVE ? meshRenderer.poseRenderer?.gpuUnavailableReason ?? "gpuUnavailable" : ACTIVE_PLAYBACK ? POSE_PROGRAM.clips[ACTIVE_PLAYBACK.name]?.reason ?? "unsupportedClip" : "transitionBlend";
      POSE_METRICS.cpuFallbacks++;
      return CACHE_PREPARED(meshRenderer.prepareCpuPose(POSE_INSTANCE, PARTS, MORPH, REASON));
    };
    const DRAW_ONE = ({
      projection,
      viewProjection,
      worldMatrix,
      matrix = IDENTITY,
      alpha = 1,
      color = [1, 1, 1, 1],
      paintRegions = null,
      forceColor = false,
      whiteFlash = false,
      clips = [],
      stencilRef = null,
      depth = 0,
      depthTest = false,
      depthWrite = false,
      depthFunc = "lequal",
      depthWriteAlphaThreshold = null,
      strokeViewport = null,
      excludeParts = null,
      instances = null
    } = {}) => {
      ASSERT_ACTOR();
      const SUBMIT = (options) => instances ? meshRenderer.drawMeshInstances(mesh, {
        ...options,
        matrices: instances.matrices,
        count: instances.count,
        prefixColor: instances.prefixColor,
        prefixCount: instances.prefixCount,
        forceColorPrefixCount: instances.forceColorPrefixCount
      }) : meshRenderer.drawMesh(mesh, options);
      VALIDATE_EXCLUSIONS(excludeParts);
      if (!mesh && paintRegions !== null) {
        throw new TypeError("This asset has no named mesh fills");
      }
      const ALPHA_DEPTH = depthWriteAlphaThreshold !== null;
      if (POSE_INSTANCE && !ALPHA_DEPTH) {
        const POSE = PREPARE_POSE({ excludeParts });
        if (POSE) {
          const INDEX_VARIANT2 = !visibilityOverridden && compiledAsset.geometry.expressionIndices?.[expression] ? expression : null;
          const WORLD_MODE2 = viewProjection !== void 0 || worldMatrix !== void 0;
          SUBMIT({
            ...WORLD_MODE2 ? { viewProjection, worldMatrix } : { projection },
            matrix,
            pose: POSE,
            alpha,
            color,
            forceColor,
            paintRegions,
            whiteFlash,
            clips,
            stencilRef,
            depth,
            depthTest,
            depthWrite,
            depthFunc,
            indexVariant: INDEX_VARIANT2,
            strokeViewport,
            timeMs: displayTimeMs
          });
          return;
        }
      }
      if (!POSE_INSTANCE || ALPHA_DEPTH) {
        meshRenderer.recordPoseFallback?.(ALPHA_DEPTH ? "alphaDepthClassification" : "uniformPose");
      }
      const RESOLVED = WORLD_MATRICES();
      const POSES = RESOLVED.parts.map((pose, index) => ({
        transform: pose.transform.slice(),
        opacity: pose.opacity,
        visible: pose.visible && !excludeParts?.has(METADATA.parts[index].id)
      }));
      const INDEX_VARIANT = !visibilityOverridden && compiledAsset.geometry.expressionIndices?.[expression] ? expression : null;
      const WORLD_MODE = viewProjection !== void 0 || worldMatrix !== void 0;
      SUBMIT({
        ...WORLD_MODE ? {
          viewProjection,
          worldMatrix
        } : {
          projection
        },
        matrix,
        parts: POSES,
        morph: RESOLVED.morph.slice(),
        alpha,
        color,
        forceColor,
        paintRegions,
        whiteFlash,
        clips,
        stencilRef,
        depth,
        depthTest,
        depthWrite,
        depthFunc,
        depthWriteAlphaThreshold,
        indexVariant: INDEX_VARIANT,
        strokeViewport,
        timeMs: displayTimeMs
      });
    };
    const DRAW = (options = {}) => {
      const { outlineExpression: OUTLINE_EXPRESSION = null, instances: INSTANCES = null } = options;
      if (OUTLINE_EXPRESSION === null) {
        return DRAW_ONE(options);
      }
      if (!INSTANCES || INSTANCES.prefixCount < 1 || INSTANCES.prefixCount >= INSTANCES.count) {
        throw new TypeError("outlineExpression requires silhouette instances");
      }
      if (visibilityOverridden) {
        throw new TypeError("outlineExpression cannot be combined with setPartVisible overrides");
      }
      const BODY_EXPRESSION = expression, OUTLINES = INSTANCES.prefixCount;
      SET_EXPRESSION(OUTLINE_EXPRESSION);
      try {
        DRAW_ONE({
          ...options,
          instances: {
            ...INSTANCES,
            matrices: INSTANCES.matrices.subarray(0, OUTLINES * 6),
            count: OUTLINES
          }
        });
      } finally {
        SET_EXPRESSION(BODY_EXPRESSION);
      }
      DRAW_ONE({
        ...options,
        instances: {
          matrices: INSTANCES.matrices.subarray(OUTLINES * 6, INSTANCES.count * 6),
          count: INSTANCES.count - OUTLINES,
          prefixColor: null,
          prefixCount: 0,
          forceColorPrefixCount: 0
        }
      });
    };
    const GET_PART_POSE = (id) => {
      ASSERT_ACTOR();
      if (!PART_INDICES.has(id)) {
        throw new TypeError(`Unknown vector part: ${id}`);
      }
      const INDEX = PART_INDICES.get(id);
      const ACTIVE = GPU_CLIP();
      const EFFECTIVE = ACTIVE ? PARTIAL_POSE(id, ACTIVE) : WORLD_MATRICES().parts[INDEX];
      const AUTHORED = ACTIVE ? samplePoseChannels(POSE_PROGRAM, ACTIVE.name, displayTimeMs - ACTIVE.startedAtMs, INDEX) : currentPose.get(id);
      return {
        ...AUTHORED,
        visible: EFFECTIVE.visible,
        transform: EFFECTIVE.transform.slice()
      };
    };
    const DISPOSE_ACTOR = () => {
      if (actorDisposed) {
        return false;
      }
      for (const { timeline: TIMELINE } of TIMELINES.values()) {
        TIMELINE.pause();
      }
      TIMELINES.clear();
      if (POSE_INSTANCE) {
        meshRenderer.deletePoseInstance(POSE_INSTANCE);
      }
      ACTORS.delete(ACTOR);
      actorDisposed = true;
      release?.();
      return true;
    };
    const ACTOR = Object.freeze({
      get expression() {
        return expression;
      },
      seek: SEEK,
      play: PLAY,
      transitionTo: TRANSITION_TO,
      setExpression: SET_EXPRESSION,
      setPartVisible: SET_PART_VISIBLE,
      setBasePose: SET_BASE_POSE,
      getPartPose: GET_PART_POSE,
      getSocket: GET_SOCKET,
      partPoses: PART_POSES,
      preparePose: PREPARE_POSE,
      draw: DRAW,
      dispose: DISPOSE_ACTOR,
      get currentClip() {
        return rootPlayback.kind === "clip" ? rootPlayback.name : rootPlayback.to.name;
      },
      get currentExpression() {
        return expression;
      },
      get currentTimeMs() {
        return displayTimeMs;
      },
      get hasOpacityChannel() {
        return HAS_OPACITY_CHANNEL(rootPlayback, displayTimeMs);
      },
      get hasNonUnitBaseOpacity() {
        for (const POSE of BASE_POSE.values()) {
          if (POSE.opacity < 1) {
            return true;
          }
        }
        return false;
      },
      get disposed() {
        return actorDisposed;
      },
      get poseMetrics() {
        return { ...POSE_METRICS };
      }
    });
    ACTORS.add(ACTOR);
    SEEK(startedAtMs);
    return ACTOR;
  };
  const DISPOSE = () => {
    if (disposed) {
      return false;
    }
    for (const ACTOR of [...ACTORS]) {
      ACTOR.dispose();
    }
    if (mesh) {
      meshRenderer.deleteMesh(mesh);
    }
    if (poseSource) {
      meshRenderer.deletePoseSource(poseSource);
    }
    disposed = true;
    return true;
  };
  return Object.freeze({
    id: METADATA.id,
    sourceSha256: compiledAsset.sourceSha256,
    schemaVersion: compiledAsset.schemaVersion,
    compilerVersion: compiledAsset.compilerVersion,
    viewBox: Object.freeze([...compiledAsset.viewBox]),
    metadata: METADATA,
    mesh,
    createActor: CREATE_ACTOR,
    ownsActor(actor) {
      return ACTORS.has(actor) && !actor.disposed;
    },
    dispose: DISPOSE,
    get disposed() {
      return disposed;
    },
    get actorCount() {
      return ACTORS.size;
    }
  });
}
function rejectUnknownOptions(unknownOptions) {
  const NAMES = Object.keys(unknownOptions);
  if (NAMES.length) {
    throw new TypeError(`Unknown option${NAMES.length > 1 ? "s" : ""}: ${NAMES.join(", ")}`);
  }
}
var SHARED_ASSETS = /* @__PURE__ */ new WeakMap();
function acquireVectorAsset(context, compiledAsset) {
  if (!context?.acquireMeshRenderer || !context?.onDispose) {
    throw new TypeError("A GameKit VectorContext is required");
  }
  let table = SHARED_ASSETS.get(context);
  if (!table) {
    table = /* @__PURE__ */ new Map();
    SHARED_ASSETS.set(context, table);
    const TABLE2 = table;
    context.onDispose(() => {
      const ENTRIES = [...TABLE2.values()];
      TABLE2.clear();
      for (const ENTRY2 of ENTRIES) {
        ENTRY2.asset.dispose();
      }
    });
  }
  let entry = table.get(compiledAsset);
  if (!entry) {
    entry = {
      asset: retainVectorAsset(context.acquireMeshRenderer(), compiledAsset),
      refs: 0
    };
    table.set(compiledAsset, entry);
  }
  entry.refs++;
  const ENTRY = entry, TABLE = table;
  let released = false;
  return {
    asset: ENTRY.asset,
    release() {
      if (released) {
        return false;
      }
      released = true;
      if (--ENTRY.refs === 0 && TABLE.get(compiledAsset) === ENTRY) {
        TABLE.delete(compiledAsset);
        ENTRY.asset.dispose();
      }
      return true;
    }
  };
}
function holdVectorAsset(context, compiledAsset) {
  const { release: RELEASE } = acquireVectorAsset(context, compiledAsset);
  return Object.freeze({ release: RELEASE });
}
function createVectorActor(context, compiledAsset, options = {}) {
  const { asset: ASSET, release: RELEASE } = acquireVectorAsset(context, compiledAsset);
  try {
    return ASSET.createActor(options, RELEASE);
  } catch (error) {
    RELEASE();
    throw error;
  }
}

// modules/vector-assets/raster-atlas.js
var IDENTITY_MATRIX = Object.freeze([1, 0, 0, 1, 0, 0]);
var NOW2 = () => globalThis.performance?.now?.() ?? null;
function nextPowerOfTwo(value) {
  return 2 ** Math.ceil(Math.log2(value));
}
function sourceRuns(geometry) {
  const { vertices: VERTICES, indices: INDICES, partCount: PART_COUNT } = geometry;
  if (!(INDICES instanceof Uint16Array)) {
    return null;
  }
  const RUNS = [];
  for (let offset = 0; offset < INDICES.length; offset += 3) {
    const A = INDICES[offset], B = INDICES[offset + 1], C = INDICES[offset + 2], PART = VERTICES[A * 11 + 10];
    if (!Number.isSafeInteger(PART) || PART < 0 || PART >= PART_COUNT || VERTICES[B * 11 + 10] !== PART || VERTICES[C * 11 + 10] !== PART) {
      return null;
    }
    let run = RUNS.at(-1);
    if (!run || run.partIndex !== PART) {
      run = {
        partIndex: PART,
        firstIndex: offset,
        indexCount: 0,
        minX: Infinity,
        minY: Infinity,
        maxX: -Infinity,
        maxY: -Infinity
      };
      RUNS.push(run);
    }
    run.indexCount += 3;
    for (const VERTEX of [A, B, C]) {
      const X = VERTICES[VERTEX * 11], Y = VERTICES[VERTEX * 11 + 1];
      run.minX = Math.min(run.minX, X);
      run.minY = Math.min(run.minY, Y);
      run.maxX = Math.max(run.maxX, X);
      run.maxY = Math.max(run.maxY, Y);
    }
  }
  return RUNS;
}
function wholeRunExpressions(geometry, runs) {
  const SOURCE = geometry.indices;
  for (const VARIANT of Object.values(geometry.expressionIndices ?? {})) {
    let offset = 0;
    for (const RUN of runs) {
      if (offset + RUN.indexCount > VARIANT.length) {
        continue;
      }
      let matches = true;
      for (let index = 0; index < RUN.indexCount; index++) {
        if (VARIANT[offset + index] !== SOURCE[RUN.firstIndex + index]) {
          matches = false;
          break;
        }
      }
      if (matches) {
        offset += RUN.indexCount;
      }
    }
    if (offset !== VARIANT.length) {
      return false;
    }
  }
  return true;
}
function packRuns(runs, maxWidth, maxHeight) {
  const WIDEST = Math.max(...runs.map((run) => run.tileWidth));
  if (WIDEST > maxWidth || runs.some((run) => run.tileHeight > maxHeight)) {
    return null;
  }
  const WIDTHS = /* @__PURE__ */ new Set([WIDEST, maxWidth]);
  for (let width = nextPowerOfTwo(WIDEST); width < maxWidth; width *= 2) {
    WIDTHS.add(width);
  }
  let best = null;
  for (const WIDTH of WIDTHS) {
    let x = 0, y = 0, rowHeight = 0;
    const POSITIONS = [];
    for (const RUN of runs) {
      if (x + RUN.tileWidth > WIDTH) {
        x = 0;
        y += rowHeight;
        rowHeight = 0;
      }
      POSITIONS.push([x, y]);
      x += RUN.tileWidth;
      rowHeight = Math.max(rowHeight, RUN.tileHeight);
    }
    const HEIGHT = y + rowHeight;
    const BYTES = WIDTH * HEIGHT * 4;
    if (HEIGHT > maxHeight || best && BYTES >= best.bytes) {
      continue;
    }
    best = { width: WIDTH, height: HEIGHT, bytes: BYTES, positions: POSITIONS };
  }
  return best;
}
function runTables(runs, packed, region, pixelsPerUnit, padding) {
  const ATLAS = region.atlas, UV_RECTS = new Float32Array(runs.length * 4), LOCAL_RECTS = new Float32Array(runs.length * 4), PARTS = new Float32Array(runs.length);
  for (let runIndex = 0; runIndex < runs.length; runIndex++) {
    const RUN = runs[runIndex], [TILE_X, TILE_Y] = packed.positions[runIndex];
    UV_RECTS.set(
      [
        (region.x + TILE_X) / ATLAS.width,
        (region.y + region.height - TILE_Y) / ATLAS.height,
        RUN.tileWidth / ATLAS.width,
        -RUN.tileHeight / ATLAS.height
      ],
      runIndex * 4
    );
    LOCAL_RECTS.set(
      [
        RUN.minX - padding / pixelsPerUnit,
        RUN.minY - padding / pixelsPerUnit,
        RUN.tileWidth / pixelsPerUnit,
        RUN.tileHeight / pixelsPerUnit
      ],
      runIndex * 4
    );
    PARTS[runIndex] = RUN.partIndex;
  }
  return { uvRects: UV_RECTS, localRects: LOCAL_RECTS, parts: PARTS };
}
function createVectorRasterAtlas(context, compiledAsset, options = {}) {
  const { asset: ASSET, release: RELEASE } = acquireVectorAsset(context, compiledAsset);
  try {
    return bakeRasterAtlas(context, ASSET, RELEASE, compiledAsset, options);
  } catch (error) {
    RELEASE();
    throw error;
  }
}
function bakeRasterAtlas(context, asset, release, compiledAsset, { pixelsPerUnit = 1, padding = 2, ...unknownOptions } = {}) {
  rejectUnknownOptions(unknownOptions);
  const DEVICE = context.device;
  const MESHES = context.meshRenderer;
  if (!context.drawQuads || !context.drawVectorActor || !DEVICE?.createTextureLayerTarget || !DEVICE?.bindRenderTarget || !DEVICE?.unbindRenderTarget) {
    throw new TypeError("A VectorContext is required");
  }
  if (!Number.isFinite(pixelsPerUnit) || pixelsPerUnit <= 0 || !Number.isSafeInteger(padding) || padding < 1) {
    throw new TypeError("A positive pixel scale and padding are required");
  }
  const ATLAS = DEVICE.textureAtlas;
  const GEOMETRY = compiledAsset.geometry;
  let unsupportedReason = null;
  if (GEOMETRY.morphCount) {
    unsupportedReason = "morphTargets";
  } else if (GEOMETRY.materials) {
    unsupportedReason = "shaderSurfaces";
  } else if (GEOMETRY.nonScalingStroke) {
    unsupportedReason = "nonScalingStroke";
  }
  const RUNS = unsupportedReason ? [] : sourceRuns(GEOMETRY);
  if (!unsupportedReason && (!RUNS || !RUNS.length)) {
    unsupportedReason = "partTriangles";
  } else if (!unsupportedReason && !wholeRunExpressions(GEOMETRY, RUNS)) {
    unsupportedReason = "expressionRunSelection";
  }
  if (!unsupportedReason) {
    for (const RUN of RUNS) {
      RUN.tileWidth = Math.max(1, Math.ceil((RUN.maxX - RUN.minX) * pixelsPerUnit)) + padding * 2;
      RUN.tileHeight = Math.max(1, Math.ceil((RUN.maxY - RUN.minY) * pixelsPerUnit)) + padding * 2;
      if (!Number.isSafeInteger(RUN.tileWidth) || !Number.isSafeInteger(RUN.tileHeight)) {
        unsupportedReason = "atlasLimit";
        break;
      }
    }
  }
  const PACKED = unsupportedReason ? null : packRuns(RUNS, ATLAS.width - ATLAS.gutter * 2, ATLAS.height - ATLAS.gutter * 2);
  if (!unsupportedReason && !PACKED) {
    unsupportedReason = "atlasLimit";
  }
  let region = null;
  if (!unsupportedReason) {
    try {
      region = ATLAS.allocate(PACKED.width, PACKED.height);
    } catch (error) {
      if (!(error instanceof RangeError)) {
        throw error;
      }
      unsupportedReason = "atlasLimit";
    }
  }
  const TABLES = region ? runTables(RUNS, PACKED, region, pixelsPerUnit, padding) : null;
  let target = null;
  let bakedRestores = -1;
  let failedFrame = -1;
  let failedRestores = -1;
  let lastFailure = null;
  let disposed = false;
  let bakeCount = 0;
  let bakeCpuMs = 0;
  let rasterDraws = 0;
  let vectorDraws = 0;
  const FALLBACK_REASONS = /* @__PURE__ */ Object.create(null);
  const FALLBACK = (actor, options, reason) => {
    vectorDraws++;
    FALLBACK_REASONS[reason] = (FALLBACK_REASONS[reason] ?? 0) + 1;
    context.drawVectorActor(actor, options);
    return { backend: "vector", reason };
  };
  const RELEASE_TARGET = () => {
    const TARGET = target;
    target = null;
    if (TARGET) {
      DEVICE.deleteRenderTarget(TARGET);
    }
  };
  const BAKE = () => {
    if (disposed || asset.disposed) {
      throw new Error("Vector raster atlas or source asset is disposed");
    }
    if (unsupportedReason) {
      return { backend: "vector", reason: unsupportedReason };
    }
    if (!DEVICE.active || DEVICE.state !== "ready") {
      return { backend: "vector", reason: "frameUnavailable" };
    }
    const RESTORES = DEVICE.stats.restores ?? 0;
    if (target && bakedRestores === RESTORES && DEVICE.isRenderTargetAvailable(target)) {
      return { backend: "raster", reason: null };
    }
    if (failedFrame === DEVICE.stats.frame && failedRestores === RESTORES) {
      return { backend: "vector", reason: "bakeFailed" };
    }
    const START = NOW2();
    let bound = false;
    try {
      DEVICE.flushBatchers("rasterAtlasBakeBoundary");
      if (target && !DEVICE.isRenderTargetAvailable(target)) {
        RELEASE_TARGET();
      }
      target ??= DEVICE.createTextureLayerTarget(ATLAS.texture, region.layer);
      DEVICE.clearTextureRegion(
        ATLAS.texture,
        region.layer,
        region.paddedX,
        region.paddedY,
        region.width + ATLAS.gutter * 2,
        region.height + ATLAS.gutter * 2
      );
      DEVICE.bindRenderTarget(target);
      bound = true;
      const TOP = ATLAS.height - (region.y + region.height);
      for (let index = 0; index < RUNS.length; index++) {
        const RUN = RUNS[index], [TILE_X, TILE_Y] = PACKED.positions[index], TX = region.x + TILE_X + padding - pixelsPerUnit * RUN.minX, TY = TOP + TILE_Y + padding - pixelsPerUnit * RUN.minY;
        MESHES.drawMesh(asset.mesh, {
          projection: [
            2 * pixelsPerUnit / ATLAS.width,
            0,
            0,
            0,
            -2 * pixelsPerUnit / ATLAS.height,
            0,
            2 * TX / ATLAS.width - 1,
            1 - 2 * TY / ATLAS.height,
            1
          ],
          indexRange: [RUN.firstIndex, RUN.indexCount]
        });
      }
      MESHES.flush("rasterAtlasBake");
      DEVICE.unbindRenderTarget(target);
      bound = false;
      bakedRestores = RESTORES;
      bakeCount++;
      if (START !== null) {
        bakeCpuMs += NOW2() - START;
      }
      lastFailure = null;
      return { backend: "raster", reason: null };
    } catch (error) {
      if (bound) {
        MESHES.discard();
        try {
          DEVICE.unbindRenderTarget(target);
        } catch {
        }
      }
      try {
        RELEASE_TARGET();
      } catch {
      }
      bakedRestores = -1;
      failedFrame = DEVICE.stats.frame;
      failedRestores = DEVICE.stats.restores ?? 0;
      lastFailure = error.message;
      return { backend: "vector", reason: "bakeFailed" };
    }
  };
  const DRAW = (actor, options = {}) => {
    if (disposed || asset.disposed) {
      throw new Error("Vector raster atlas or source asset is disposed");
    }
    if (!asset.ownsActor(actor)) {
      throw new TypeError("A live actor owned by this vector asset is required");
    }
    if (unsupportedReason) {
      return FALLBACK(actor, options, unsupportedReason);
    }
    if (options.forceColor === true) {
      return FALLBACK(actor, options, "forceColor");
    }
    if (options.alpha !== void 0 && options.alpha < 1 || options.color?.[3] < 1) {
      return FALLBACK(actor, options, "globalOpacity");
    }
    if (actor.hasOpacityChannel) {
      return FALLBACK(actor, options, "opacityChannel");
    }
    if (actor.hasNonUnitBaseOpacity) {
      return FALLBACK(actor, options, "baseOpacity");
    }
    if (options.depthWriteAlphaThreshold != null) {
      return FALLBACK(actor, options, "depthWriteAlphaThreshold");
    }
    const RESULT = BAKE();
    if (RESULT.backend !== "raster") {
      return FALLBACK(actor, options, RESULT.reason);
    }
    const { excludeParts: EXCLUDE_PARTS = null, matrix: MATRIX = IDENTITY_MATRIX, ...DRAW_OPTIONS } = options;
    const POSE = actor.preparePose({ excludeParts: EXCLUDE_PARTS });
    if (!POSE) {
      return FALLBACK(actor, options, "poseUnavailable");
    }
    context.drawQuads({
      ...DRAW_OPTIONS,
      matrix: MATRIX,
      layer: region.layer,
      filter: region.filter,
      pose: POSE,
      ...TABLES
    });
    rasterDraws++;
    return { backend: "raster", reason: null };
  };
  const DISPOSE = () => {
    if (disposed) {
      return false;
    }
    if (DEVICE.state === "ready" && DEVICE.active) {
      DEVICE.flushBatchers("rasterAtlasDispose");
    }
    disposed = true;
    try {
      RELEASE_TARGET();
    } finally {
      try {
        if (region && DEVICE.state === "ready") {
          ATLAS.release(region);
        }
      } finally {
        release();
      }
    }
    return true;
  };
  return Object.freeze({
    bake: BAKE,
    draw: DRAW,
    dispose: DISPOSE,
    get stats() {
      return {
        baked: Boolean(
          !disposed && !asset.disposed && target && bakedRestores === (DEVICE.stats.restores ?? 0)
        ),
        disposed,
        reason: unsupportedReason ?? (lastFailure ? "bakeFailed" : null),
        lastError: lastFailure,
        layer: region?.layer ?? null,
        runCount: RUNS?.length ?? 0,
        // The packed runs' region of the shared atlas array.
        atlasWidth: PACKED?.width ?? 0,
        atlasHeight: PACKED?.height ?? 0,
        atlasBytes: PACKED?.bytes ?? 0,
        allocatedBytes: !disposed && target ? PACKED?.bytes ?? 0 : 0,
        bakeCount,
        bakeCpuMs,
        rasterDraws,
        vectorDraws,
        fallbackReasons: { ...FALLBACK_REASONS }
      };
    }
  });
}

// modules/vector-assets/sprite-atlas.js
var CACHE = /* @__PURE__ */ new WeakMap();
var MAX_FRAMES = 512;
var NOW3 = () => globalThis.performance?.now?.() ?? null;
function sampleFrames(clip, interval) {
  const COUNT = Math.ceil(clip.durationMs / interval);
  if (!Number.isSafeInteger(COUNT) || COUNT < 1 || COUNT > MAX_FRAMES) {
    return null;
  }
  return Array.from({ length: COUNT }, (_, index) => {
    const START = index * interval, DURATION = Math.min(interval, clip.durationMs - START);
    return {
      timeMs: clip.loop === "once" && index === COUNT - 1 ? clip.durationMs : START + DURATION / 2,
      durationMs: DURATION
    };
  });
}
function sampledBounds(actor, geometry, samples) {
  const VERTICES = geometry.vertices;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const SAMPLE of samples) {
    actor.seek(SAMPLE.timeMs);
    const POSES = actor.partPoses();
    for (let offset = 0; offset < VERTICES.length; offset += 11) {
      const POSE = POSES[VERTICES[offset + 10]];
      if (!POSE.visible || POSE.opacity <= 0) {
        continue;
      }
      const X = VERTICES[offset] + VERTICES[offset + 6] * POSE.morph[0] + VERTICES[offset + 8] * POSE.morph[1], Y = VERTICES[offset + 1] + VERTICES[offset + 7] * POSE.morph[0] + VERTICES[offset + 9] * POSE.morph[1], M = POSE.transform, TX = M[0] * X + M[2] * Y + M[4], TY = M[1] * X + M[3] * Y + M[5];
      minX = Math.min(minX, TX);
      minY = Math.min(minY, TY);
      maxX = Math.max(maxX, TX);
      maxY = Math.max(maxY, TY);
    }
  }
  return Number.isFinite(minX) ? { minX, minY, maxX, maxY } : null;
}
function packFrames(count, tileWidth, tileHeight, maxWidth, maxHeight) {
  if (tileWidth > maxWidth || tileHeight > maxHeight) {
    return null;
  }
  let best = null;
  for (let columns = 1; columns <= count && columns * tileWidth <= maxWidth; columns++) {
    const ROWS = Math.ceil(count / columns), WIDTH = columns * tileWidth, HEIGHT = ROWS * tileHeight, BYTES = WIDTH * HEIGHT * 4;
    if (HEIGHT > maxHeight || best && BYTES >= best.bytes) {
      continue;
    }
    best = { columns, width: WIDTH, height: HEIGHT, bytes: BYTES };
  }
  return best;
}
function spriteDefinition(clipName, clip, samples, packed, contentWidth, contentHeight, padding, bounds, ppu) {
  const FRAMES = samples.map((sample, index) => ({
    x: index % packed.columns * (contentWidth + padding * 2) + padding,
    y: Math.floor(index / packed.columns) * (contentHeight + padding * 2) + padding,
    width: contentWidth,
    height: contentHeight,
    durationMs: sample.durationMs,
    sourceX: 0,
    sourceY: 0,
    sourceWidth: contentWidth,
    sourceHeight: contentHeight,
    pivotX: -bounds.minX * ppu,
    pivotY: -bounds.minY * ppu,
    gutter: padding
  }));
  const ORDER = FRAMES.map((_, index) => index);
  if (clip.loop === "alternate") {
    ORDER.push(...ORDER.slice().reverse());
  }
  return Object.freeze({
    textureOrigin: "bottom-left",
    sourceWidth: contentWidth,
    sourceHeight: contentHeight,
    gutter: padding,
    frames: Object.freeze(FRAMES.map((frame) => Object.freeze(frame))),
    clips: Object.freeze({
      [clipName]: Object.freeze({
        frames: Object.freeze(ORDER),
        loop: clip.loop === "once" ? "once" : "loop"
      })
    })
  });
}
function createVectorSpriteAtlas(context, compiledAsset, options = {}) {
  const { asset: ASSET, release: RELEASE } = acquireVectorAsset(context, compiledAsset);
  try {
    return bakeSpriteAtlas(context, ASSET, RELEASE, compiledAsset, options);
  } catch (error) {
    RELEASE();
    throw error;
  }
}
function bakeSpriteAtlas(context, asset, release, compiledAsset, {
  clip,
  expression = compiledAsset?.metadata?.defaultExpression,
  sampleIntervalMs = 100,
  pixelsPerUnit = 1,
  padding = 2,
  paintRegions = null,
  supersample = 1,
  ...unknownOptions
} = {}) {
  rejectUnknownOptions(unknownOptions);
  validateCompiledAsset(compiledAsset);
  const DEVICE = context.device, MESHES = context.meshRenderer, GEOMETRY = compiledAsset.geometry;
  if (!context.drawQuads || !DEVICE?.createRenderTarget || !DEVICE?.blitRenderTarget || !DEVICE?.createTextureLayerTarget || !DEVICE?.bindRenderTarget || !DEVICE?.unbindRenderTarget) {
    throw new TypeError("A VectorContext is required");
  }
  if (!Object.hasOwn(compiledAsset.metadata.clips, clip) || !Object.hasOwn(compiledAsset.metadata.expressions, expression)) {
    throw new TypeError("Known authored clip and expression required");
  }
  if (!Number.isFinite(sampleIntervalMs) || sampleIntervalMs <= 0 || !Number.isFinite(pixelsPerUnit) || pixelsPerUnit <= 0 || !Number.isSafeInteger(padding) || padding < 1) {
    throw new TypeError("Finite positive sample interval, pixel scale and padding required");
  }
  if (![1, 2, 4].includes(supersample)) {
    throw new RangeError("Sprite bake supersample must be 1, 2 or 4");
  }
  const WORKING_FACTOR = supersample === 1 ? 1 : supersample === 2 ? 5 : 21;
  const PAINT_NAMES = GEOMETRY.paintRegions?.names ?? [], PAINT = packPaintRegions(PAINT_NAMES, paintRegions, new Float32Array((PAINT_NAMES.length + 1) * 4)), CAPTURED_PAINT = Object.fromEntries(
    PAINT_NAMES.flatMap((name, index) => {
      const AT = (index + 1) * 4;
      return PAINT[AT + 3] ? [[name, Array.from(PAINT.subarray(AT, AT + 3))]] : [];
    })
  );
  const KEY = JSON.stringify([
    clip,
    expression,
    sampleIntervalMs,
    pixelsPerUnit,
    padding,
    Array.from(PAINT),
    supersample
  ]);
  const ATLAS = DEVICE.textureAtlas;
  let cached = CACHE.get(asset);
  if (!cached) {
    cached = /* @__PURE__ */ new Map();
    CACHE.set(asset, cached);
  }
  let record = cached.get(KEY);
  if (!record) {
    const DEFINITION = compiledAsset.metadata.clips[clip];
    let reason = null;
    if (GEOMETRY.materials) {
      reason = "shaderSurfaces";
    } else if (GEOMETRY.morphCount && compiledAsset.metadata.styles?.some((style) => style.kind === "sketch")) {
      reason = "timeDependentMorph";
    } else if (GEOMETRY.nonScalingStroke) {
      reason = "nonScalingStroke";
    } else if (!asset.mesh) {
      reason = "sourceMeshUnavailable";
    }
    const SAMPLES = reason ? null : sampleFrames(DEFINITION, sampleIntervalMs);
    if (!reason && !SAMPLES) {
      reason = "frameLimit";
    }
    const ACTOR = reason ? null : asset.createActor({ clip, startedAtMs: 0 });
    if (ACTOR && expression !== compiledAsset.metadata.defaultExpression) {
      ACTOR.setExpression(expression);
    }
    const BOUNDS = ACTOR ? sampledBounds(ACTOR, GEOMETRY, SAMPLES) : null;
    if (!reason && !BOUNDS) {
      reason = "emptyFrames";
    }
    const CONTENT_WIDTH = BOUNDS ? Math.max(1, Math.ceil((BOUNDS.maxX - BOUNDS.minX) * pixelsPerUnit)) : 0, CONTENT_HEIGHT = BOUNDS ? Math.max(1, Math.ceil((BOUNDS.maxY - BOUNDS.minY) * pixelsPerUnit)) : 0, TILE_WIDTH = CONTENT_WIDTH + padding * 2, TILE_HEIGHT = CONTENT_HEIGHT + padding * 2;
    const PACKED = reason ? null : packFrames(
      SAMPLES.length,
      TILE_WIDTH,
      TILE_HEIGHT,
      Math.min(ATLAS.width - ATLAS.gutter * 2, Math.floor(DEVICE.maxTextureSize / supersample)),
      Math.min(ATLAS.height - ATLAS.gutter * 2, Math.floor(DEVICE.maxTextureSize / supersample))
    );
    if (!reason && !PACKED) {
      reason = "atlasLimit";
    }
    let region = null;
    if (!reason) {
      try {
        region = ATLAS.allocate(PACKED.width, PACKED.height);
      } catch (error) {
        if (!(error instanceof RangeError)) {
          throw error;
        }
        reason = "atlasLimit";
      }
    }
    if (reason) {
      ACTOR?.dispose();
    }
    record = {
      key: KEY,
      refs: 0,
      reason,
      lastError: null,
      actor: reason ? null : ACTOR,
      samples: SAMPLES,
      bounds: BOUNDS,
      packed: PACKED,
      definition: reason ? null : spriteDefinition(
        clip,
        DEFINITION,
        SAMPLES,
        PACKED,
        CONTENT_WIDTH,
        CONTENT_HEIGHT,
        padding,
        BOUNDS,
        pixelsPerUnit
      ),
      region,
      target: null,
      bakedRestores: -1,
      failedFrame: -1,
      failedRestores: -1,
      bakeCount: 0,
      bakeCpuMs: 0
    };
    cached.set(KEY, record);
  }
  record.refs++;
  let disposed = false;
  const BAKE = () => {
    if (disposed || asset.disposed) {
      throw new Error("Vector sprite atlas or source asset is disposed");
    }
    if (record.reason) {
      return { backend: "vector", reason: record.reason };
    }
    if (!DEVICE.active || DEVICE.state !== "ready") {
      return { backend: "vector", reason: "frameUnavailable" };
    }
    const RESTORES = DEVICE.stats.restores ?? 0;
    if (record.target && record.bakedRestores === RESTORES && DEVICE.isRenderTargetAvailable(record.target)) {
      return { backend: "sprite", reason: null };
    }
    if (record.failedFrame === DEVICE.stats.frame && record.failedRestores === RESTORES) {
      return { backend: "vector", reason: "bakeFailed" };
    }
    const START = NOW3();
    let boundTarget = null;
    const TRANSIENTS = /* @__PURE__ */ new Set();
    try {
      DEVICE.flushBatchers("spriteAtlasBakeBoundary");
      if (record.target && !DEVICE.isRenderTargetAvailable(record.target)) {
        DEVICE.deleteRenderTarget(record.target);
        record.target = null;
      }
      const REGION = record.region;
      record.target ??= DEVICE.createTextureLayerTarget(ATLAS.texture, REGION.layer);
      let source = record.target;
      if (supersample > 1) {
        source = DEVICE.createRenderTarget(
          record.packed.width * supersample,
          record.packed.height * supersample,
          {
            format: "rgba",
            filter: "linear"
          }
        );
        TRANSIENTS.add(source);
      } else {
        DEVICE.clearTextureRegion(
          ATLAS.texture,
          REGION.layer,
          REGION.paddedX,
          REGION.paddedY,
          REGION.width + ATLAS.gutter * 2,
          REGION.height + ATLAS.gutter * 2
        );
      }
      DEVICE.bindRenderTarget(source);
      boundTarget = source;
      if (supersample > 1) {
        DEVICE.clear({ color: [0, 0, 0, 0] });
      }
      const { minX: MIN_X, minY: MIN_Y } = record.bounds;
      const DIRECT = supersample === 1, BAKE_WIDTH = DIRECT ? ATLAS.width : record.packed.width, BAKE_HEIGHT = DIRECT ? ATLAS.height : record.packed.height, ORIGIN_X = DIRECT ? REGION.x : 0, ORIGIN_Y = DIRECT ? ATLAS.height - (REGION.y + REGION.height) : 0;
      for (let index = 0; index < record.samples.length; index++) {
        const SAMPLE = record.samples[index], FRAME = record.definition.frames[index], TX = ORIGIN_X + FRAME.x - pixelsPerUnit * MIN_X, TY = ORIGIN_Y + FRAME.y - pixelsPerUnit * MIN_Y;
        record.actor.seek(SAMPLE.timeMs);
        record.actor.draw({
          paintRegions: CAPTURED_PAINT,
          projection: [
            2 * pixelsPerUnit / BAKE_WIDTH,
            0,
            0,
            0,
            -2 * pixelsPerUnit / BAKE_HEIGHT,
            0,
            2 * TX / BAKE_WIDTH - 1,
            1 - 2 * TY / BAKE_HEIGHT,
            1
          ]
        });
        MESHES.flush("spriteAtlasSample");
      }
      DEVICE.unbindRenderTarget(source);
      boundTarget = null;
      for (let scale = supersample / 2; supersample > 1 && scale >= 1; scale /= 2) {
        if (scale === 1) {
          DEVICE.blitRenderTarget(source, record.target, {
            x: REGION.x,
            y: REGION.y,
            width: record.packed.width,
            height: record.packed.height
          });
          break;
        }
        const TARGET = DEVICE.createRenderTarget(record.packed.width * scale, record.packed.height * scale, {
          format: "rgba",
          filter: "linear"
        });
        TRANSIENTS.add(TARGET);
        DEVICE.blitRenderTarget(source, TARGET);
        DEVICE.deleteRenderTarget(source);
        TRANSIENTS.delete(source);
        source = TARGET;
      }
      record.bakedRestores = RESTORES;
      record.bakeCount++;
      if (START !== null) {
        record.bakeCpuMs += NOW3() - START;
      }
      record.lastError = null;
      return { backend: "sprite", reason: null };
    } catch (error) {
      if (boundTarget) {
        MESHES.discard();
        try {
          DEVICE.unbindRenderTarget(boundTarget);
        } catch {
        }
      }
      try {
        if (record.target) {
          DEVICE.deleteRenderTarget(record.target);
          record.target = null;
        }
      } catch {
      }
      record.bakedRestores = -1;
      record.failedFrame = DEVICE.stats.frame;
      record.failedRestores = DEVICE.stats.restores ?? 0;
      record.lastError = error.message;
      return { backend: "vector", reason: "bakeFailed" };
    } finally {
      for (const TARGET of TRANSIENTS) {
        DEVICE.deleteRenderTarget(TARGET);
      }
    }
  };
  const DISPOSE = () => {
    if (disposed) {
      return false;
    }
    disposed = true;
    record.refs--;
    if (record.refs === 0) {
      try {
        if (DEVICE.state === "ready" && DEVICE.active) {
          DEVICE.flushBatchers("spriteAtlasDispose");
        }
        if (record.target) {
          DEVICE.deleteRenderTarget(record.target);
          record.target = null;
        }
      } finally {
        if (record.region && DEVICE.state === "ready") {
          ATLAS.release(record.region);
        }
        record.actor?.dispose();
        cached.delete(KEY);
        if (cached.size === 0) {
          CACHE.delete(asset);
        }
      }
    }
    release();
    return true;
  };
  return Object.freeze({
    bake: BAKE,
    dispose: DISPOSE,
    /** The shared-atlas region holding the baked frames; pass it to createSpriteAnimation. */
    get region() {
      return disposed || !record.target ? null : record.region;
    },
    get definition() {
      return disposed ? null : record.definition;
    },
    get stats() {
      return {
        disposed,
        reason: record.reason ?? (record.lastError ? "bakeFailed" : null),
        lastError: record.lastError,
        cacheKey: KEY,
        refCount: record.refs,
        clip,
        expression,
        pixelsPerUnit,
        supersample,
        bakeWorkingBytes: (record.packed?.bytes ?? 0) * WORKING_FACTOR,
        sampleIntervalMs,
        sampleTimesMs: record.samples?.map((sample) => sample.timeMs) ?? [],
        sampleDurationsMs: record.samples?.map((sample) => sample.durationMs) ?? [],
        sampledDurationMs: record.samples?.reduce((sum, sample) => sum + sample.durationMs, 0) ?? 0,
        frameCount: record.samples?.length ?? 0,
        atlasWidth: record.packed?.width ?? 0,
        atlasHeight: record.packed?.height ?? 0,
        // Planned RGBA capacity; allocatedBytes tracks the live shared texture.
        atlasBytes: record.packed?.bytes ?? 0,
        allocatedBytes: !disposed && record.target ? record.packed?.bytes ?? 0 : 0,
        bakeCount: record.bakeCount,
        bakeCpuMs: record.bakeCpuMs,
        baked: Boolean(
          !disposed && !asset.disposed && record.target && record.bakedRestores === (DEVICE.stats.restores ?? 0)
        )
      };
    }
  });
}

// modules/vector-assets/quality-presets.js
var VECTOR_ASSET_QUALITY_PRESETS = Object.freeze({
  standard: Object.freeze({
    curveSegments: 4,
    strokeArcDivisions: 2
  }),
  smallAsset: Object.freeze({
    curveSegments: 2,
    strokeArcDivisions: 2
  })
});

// modules/vector-assets/paint-regions.js
var SVG_PAINT_REGION_ATTRIBUTE = "data-paint-region";
function svgPaintRegion(node) {
  if (!node.hasAttribute(SVG_PAINT_REGION_ATTRIBUTE)) {
    return null;
  }
  return validatePaintRegionName(node.getAttribute(SVG_PAINT_REGION_ATTRIBUTE));
}
function applySvgPaintRegions(root, overrides) {
  if (!root || root.nodeType !== 1 || root.localName !== "svg") {
    throw new TypeError("An original SVG root element is required");
  }
  const OUTPUT = root.cloneNode(true), SHAPES = [...OUTPUT.getElementsByTagName("*")].filter((node) => svgPaintRegion(node) !== null), NAMES = [...new Set(SHAPES.map(svgPaintRegion))];
  if (NAMES.length > MAX_PAINT_REGIONS) {
    throw new RangeError("An SVG supports at most eight paint regions");
  }
  const PAINT = packPaintRegions(NAMES, overrides, new Float32Array((NAMES.length + 1) * 4));
  for (const NODE of SHAPES) {
    if (!["path", "rect", "circle", "ellipse", "polygon", "polyline"].includes(NODE.localName)) {
      throw new TypeError("A paint region must name an authored filled shape");
    }
    const STYLE = NODE.getAttribute("style") || "", INLINE_FILL = STYLE.match(/(?:^|;)\s*fill\s*:\s*([^;]+)/i)?.[1]?.trim(), FILL = INLINE_FILL ?? NODE.getAttribute("fill");
    if (!FILL || FILL === "none" || /url\s*\(/i.test(FILL)) {
      throw new TypeError("Paint regions require an explicit solid fill");
    }
  }
  for (const NODE of SHAPES) {
    const INDEX = NAMES.indexOf(svgPaintRegion(NODE)) + 1, AT = INDEX * 4;
    if (!PAINT[AT + 3]) {
      continue;
    }
    const COLOR = `rgb(${[0, 1, 2].map((channel) => PAINT[AT + channel] * 255).join(",")})`;
    NODE.setAttribute("fill", COLOR);
    const STYLE = NODE.getAttribute("style");
    if (STYLE && /(?:^|;)\s*fill\s*:/i.test(STYLE)) {
      NODE.setAttribute("style", STYLE.replace(/(^|;)\s*fill\s*:[^;]*/gi, "$1fill:" + COLOR));
    }
  }
  return OUTPUT;
}
export {
  SVG_PAINT_REGION_ATTRIBUTE,
  VECTOR_ASSET_QUALITY_PRESETS,
  applySvgPaintRegions,
  createVectorActor,
  createVectorRasterAtlas,
  createVectorSpriteAtlas,
  holdVectorAsset
};

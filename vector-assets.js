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

// modules/vector-assets/schema.js
var VECTOR_ASSET_SCHEMA_VERSION = 1;
var VECTOR_ASSET_COMPILER_VERSION = "0.8.0";
var ACCEPTED_COMPILER_VERSIONS = /* @__PURE__ */ new Set(["0.2.0", "0.3.0", "0.4.0", "0.5.0", "0.6.0", "0.7.0", VECTOR_ASSET_COMPILER_VERSION]);
var NUMERIC_POSE_FIELDS = Object.freeze(["x", "y", "rotation", "scaleX", "scaleY", "opacity"]);
var isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
var exactKeys = (value, keys) => isObject(value) && Object.keys(value).length === keys.length && keys.every((key2) => Object.hasOwn(value, key2));
function validateCompiledAsset(asset) {
  const shaderSurfaces = asset?.geometry?.shaderSurfaces;
  const surfaceOnly = Array.isArray(shaderSurfaces) && shaderSurfaces.length > 0;
  if (!isObject(asset) || asset.schemaVersion !== VECTOR_ASSET_SCHEMA_VERSION || !ACCEPTED_COMPILER_VERSIONS.has(asset.compilerVersion) || typeof asset.sourceSha256 !== "string" || !/^[a-f0-9]{64}$/.test(asset.sourceSha256) || !isObject(asset.metadata) || !isObject(asset.geometry) || !(asset.geometry.vertices instanceof Float32Array) || asset.geometry.vertices.length < 33 && !(surfaceOnly && asset.geometry.vertices.length === 0) || asset.geometry.vertices.length % 11 || asset.geometry.strideFloats !== 11 || asset.geometry.nonScalingStroke !== void 0 && typeof asset.geometry.nonScalingStroke !== "boolean" || asset.geometry.nonScalingStroke && asset.geometry.morphCount !== 0 || asset.geometry.partCount !== asset.metadata.parts?.length || ![0, 2].includes(asset.geometry.morphCount)) {
    throw new TypeError("Invalid compiled SVG vector asset");
  }
  const vertexCount = asset.geometry.vertices.length / 11, indices = asset.geometry.indices;
  if (indices !== void 0 && (!(indices instanceof Uint16Array) || indices.length < 3 && !(surfaceOnly && indices.length === 0) || indices.length % 3 || vertexCount > 65536 || indices.some((index) => index >= vertexCount))) {
    throw new TypeError("Invalid compiled SVG vertex indices");
  }
  if (indices === void 0 && vertexCount % 3) throw new TypeError("Non-indexed compiled SVG geometry must contain complete triangles");
  if (asset.compilerVersion === VECTOR_ASSET_COMPILER_VERSION && asset.compilerOptions === void 0) {
    throw new TypeError("Current SVG compiler options are required");
  }
  if (asset.compilerOptions !== void 0 && (!exactKeys(asset.compilerOptions, ["curveSegments"]) || !Number.isSafeInteger(asset.compilerOptions.curveSegments) || asset.compilerOptions.curveSegments < 4 || asset.compilerOptions.curveSegments > 64)) {
    throw new TypeError("Invalid SVG compiler options");
  }
  const expressionIndices = asset.geometry.expressionIndices;
  const indexVariants = asset.geometry.indexVariants;
  if (indexVariants !== void 0 && !isObject(indexVariants)) throw new TypeError("Invalid compiled SVG index variants");
  if (expressionIndices !== void 0) {
    if (!isObject(expressionIndices)) throw new TypeError("Invalid compiled SVG expression indices");
    for (const [name, variant] of Object.entries(expressionIndices)) {
      if (!Object.hasOwn(asset.metadata.expressions ?? {}, name) || !(variant instanceof Uint16Array) || variant.length % 3 || variant.some((index) => index >= vertexCount)) {
        throw new TypeError("Invalid compiled SVG expression index variant: " + name);
      }
    }
  }
  for (const [name, variant] of Object.entries(indexVariants ?? {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_.:-]{0,127}$/.test(name) || Object.hasOwn(expressionIndices ?? {}, name) || !(variant instanceof Uint16Array) || variant.length % 3 || variant.some((index) => index >= vertexCount)) {
      throw new TypeError("Invalid compiled SVG named index variant: " + name);
    }
  }
  const surfaces = asset.geometry.shaderSurfaces;
  const drawOrder = asset.geometry.drawOrder;
  if (surfaces !== void 0 || drawOrder !== void 0) {
    if (!Array.isArray(surfaces) || !Array.isArray(drawOrder) || !drawOrder.length || surfaces.length > 128 || drawOrder.length > 512) {
      throw new TypeError("Shader-backed SVG assets require bounded shaderSurfaces and drawOrder arrays");
    }
    for (const [index, surface] of surfaces.entries()) {
      const style = asset.metadata.styles?.find((entry) => entry.target === surface?.target && entry.backend === "shader");
      const contour = surface?.outline;
      if (!style || !Number.isSafeInteger(surface.partIndex) || surface.partIndex < 0 || surface.partIndex >= asset.geometry.partCount || !(surface.fillVertices instanceof Float32Array) || surface.fillVertices.length < 18 || surface.fillVertices.length % 18 || !(contour instanceof Float32Array) || contour.length < 6 || contour.length % 2 || !(surface.edgeColors instanceof Float32Array) || surface.edgeColors.length !== contour.length * 2) {
        throw new TypeError("Invalid retained SVG shader surface at index " + index);
      }
      if (surface.fillVertices.some((value, offset) => !Number.isFinite(value) || offset % 6 >= 2 && (value < 0 || value > 1)) || contour.some((value) => !Number.isFinite(value)) || surface.edgeColors.some((value) => !Number.isFinite(value) || value < 0 || value > 1)) {
        throw new TypeError("SVG shader surface values must be finite and colors in [0,1]");
      }
      const surfaceStyle = surface.style, styleKeys = Object.keys(style);
      if (!isObject(surfaceStyle) || Object.keys(surfaceStyle).length !== styleKeys.length || styleKeys.some((key2) => !Object.hasOwn(surfaceStyle, key2) || surfaceStyle[key2] !== style[key2])) {
        throw new TypeError("SVG shader surface style must exactly match its authored metadata target");
      }
    }
    const referenced = /* @__PURE__ */ new Set();
    for (const command of drawOrder) {
      if (command?.kind === "mesh") {
        if (!Number.isSafeInteger(command.firstIndex) || !Number.isSafeInteger(command.indexCount) || command.firstIndex < 0 || !Number.isSafeInteger(command.partIndex) || command.partIndex < 0 || command.partIndex >= asset.geometry.partCount || command.indexCount < 3 || command.indexCount % 3 || command.firstIndex % 3 || command.firstIndex + command.indexCount > (indices?.length ?? vertexCount)) {
          throw new TypeError("Invalid ordered SVG mesh range");
        }
      } else if (command?.kind === "surface") {
        if (!Number.isSafeInteger(command.surfaceIndex) || command.surfaceIndex < 0 || command.surfaceIndex >= surfaces.length || referenced.has(command.surfaceIndex)) throw new TypeError("Invalid or repeated ordered SVG shader surface reference");
        referenced.add(command.surfaceIndex);
      } else throw new TypeError("Unsupported SVG painter-order command");
    }
    if (referenced.size !== surfaces.length) throw new TypeError("Every retained SVG shader surface must appear once in drawOrder");
  }
  return asset;
}

// modules/vector-assets/runtime.js
var IDENTITY = Object.freeze([1, 0, 0, 1, 0, 0]);
var DEFAULT_POSE = Object.freeze({ x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1, opacity: 1 });
var POSE_FIELDS = Object.keys(DEFAULT_POSE);
var finiteTime = (value, name) => {
  if (!Number.isFinite(value)) throw new TypeError(`${name} must be a finite absolute display time in milliseconds`);
  return value;
};
function localMatrix(pivot, pose) {
  const [px, py] = pivot, cosine = Math.cos(pose.rotation), sine = Math.sin(pose.rotation);
  const a = cosine * pose.scaleX, b = sine * pose.scaleX, c = -sine * pose.scaleY, d = cosine * pose.scaleY;
  return [a, b, c, d, px + pose.x - a * px - c * py, py + pose.y - b * px - d * py];
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
function composeWorldMatrix(world, local) {
  if (!world || world.length !== 16 || local.length !== 6 || Array.from(local).some((value) => !Number.isFinite(value))) throw new TypeError("Six finite root matrix values required");
  const [a, b, c, d, e, f] = local, out = Float32Array.from(world);
  for (const value of out) if (!Number.isFinite(value)) throw new TypeError("worldMatrix must contain 16 finite values");
  if (Math.abs(out[3]) > 1e-7 || Math.abs(out[7]) > 1e-7 || Math.abs(out[11]) > 1e-7 || Math.abs(out[15] - 1) > 1e-7) {
    throw new TypeError("worldMatrix must be an affine column-major 4x4 matrix");
  }
  out[0] = world[0] * a + world[4] * b;
  out[1] = world[1] * a + world[5] * b;
  out[2] = world[2] * a + world[6] * b;
  out[3] = world[3] * a + world[7] * b;
  out[4] = world[0] * c + world[4] * d;
  out[5] = world[1] * c + world[5] * d;
  out[6] = world[2] * c + world[6] * d;
  out[7] = world[3] * c + world[7] * d;
  out[12] = world[0] * e + world[4] * f + world[12];
  out[13] = world[1] * e + world[5] * f + world[13];
  out[14] = world[2] * e + world[6] * f + world[14];
  out[15] = world[3] * e + world[7] * f + world[15];
  return out;
}
function validateShaderSurfaceClipCapacity(clips, maxPlanes) {
  if (!clips?.length) return;
  if (!Array.isArray(clips)) throw new TypeError("clips must be an array of convex polygons");
  let edgeCount = 0;
  for (const polygon of clips) {
    if (!Array.isArray(polygon) || polygon.length < 3 || polygon.some((point) => !Number.isFinite(point?.x) || !Number.isFinite(point?.y))) {
      throw new TypeError("Finite convex clip polygons required");
    }
    let area = 0;
    for (let i = 0; i < polygon.length; i++) {
      const a = polygon[i], b = polygon[(i + 1) % polygon.length];
      area += a.x * b.y - b.x * a.y;
      if (Math.hypot(b.x - a.x, b.y - a.y) > 0) edgeCount++;
    }
    if (Math.abs(area) < 1e-8) throw new RangeError("A clip polygon must have nonzero area");
    if (edgeCount > maxPlanes) throw new RangeError(`Vector asset clipping exceeds the shader surface limit of ${maxPlanes} edge planes`);
  }
}
function transformPoint(matrix, point) {
  return { x: matrix[0] * point[0] + matrix[2] * point[1] + matrix[4], y: matrix[1] * point[0] + matrix[3] * point[1] + matrix[5] };
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
  if (clip.loop === "once") return Math.min(clip.durationMs, Math.max(0, elapsed));
  if (clip.loop === "repeat") return (elapsed % clip.durationMs + clip.durationMs) % clip.durationMs;
  const cycle = clip.durationMs * 2, point = (elapsed % cycle + cycle) % cycle;
  return point <= clip.durationMs ? point : cycle - point;
}
function buildClipTimeline(clip, parts) {
  const tracks = new Map(parts.map((part) => [part.id, { ...DEFAULT_POSE }]));
  const first = clip.keyframes[0];
  for (const [partId, pose] of Object.entries(first.parts)) Object.assign(tracks.get(partId), pose);
  const timeline = createTimeline({ autoplay: false });
  for (let frameIndex = 1; frameIndex < clip.keyframes.length; frameIndex++) {
    const previous = clip.keyframes[frameIndex - 1], frame = clip.keyframes[frameIndex];
    const duration = frame.timeMs - previous.timeMs;
    for (const [partId, pose] of Object.entries(frame.parts)) {
      timeline.add(tracks.get(partId), { ...pose, duration, ease: frame.easing }, previous.timeMs);
    }
  }
  if (!timeline.paused) timeline.pause();
  return { timeline, tracks };
}
function copyPose(pose) {
  return Object.fromEntries(POSE_FIELDS.map((field) => [field, pose[field]]));
}
function authoredMorph(metadata, displayTimeMs) {
  const sketch = metadata.styles?.find((style) => style.kind === "sketch");
  if (!sketch) return [0, 0];
  const phase = (displayTimeMs % sketch.periodMs + sketch.periodMs) % sketch.periodMs / sketch.periodMs * 3;
  const segment = Math.floor(phase), amount = phase - segment;
  if (segment === 0) return [amount, 0];
  if (segment === 1) return [1 - amount, amount];
  return [0, 1 - amount];
}
function blendPoses(from, to, amount, partIds) {
  const output = /* @__PURE__ */ new Map();
  for (const id of partIds) {
    const a = from.get(id) ?? DEFAULT_POSE, b = to.get(id) ?? DEFAULT_POSE;
    output.set(id, Object.fromEntries(POSE_FIELDS.map((field) => [field, a[field] + (b[field] - a[field]) * amount])));
  }
  return output;
}
function createVectorAsset(meshRenderer, compiledAsset, { surfaceRenderer = null } = {}) {
  if (!meshRenderer?.createMesh || !meshRenderer?.drawMesh || !meshRenderer?.deleteMesh) throw new TypeError("A GameKit MeshRenderer is required");
  validateCompiledAsset(compiledAsset);
  const metadata = compiledAsset.metadata;
  const partIndices = new Map(metadata.parts.map((part, index) => [part.id, index]));
  const clips = metadata.clips;
  const geometry = compiledAsset.geometry, shaderGeometry = geometry.shaderSurfaces ?? [];
  if (shaderGeometry.length && (!surfaceRenderer?.createSurface || !surfaceRenderer?.drawSurface || !surfaceRenderer?.deleteSurface)) {
    throw new TypeError('This SVG declares backend:"shader"; pass a GameKit YarnSurfaceRenderer when creating the vector asset');
  }
  const mesh = geometry.vertices.length ? meshRenderer.createMesh(geometry) : null;
  const retainedSurfaces = [];
  try {
    for (const descriptor of shaderGeometry) retainedSurfaces.push(surfaceRenderer.createSurface(descriptor));
  } catch (error) {
    for (const surface of retainedSurfaces) surfaceRenderer.deleteSurface(surface);
    if (mesh) meshRenderer.deleteMesh(mesh);
    throw error;
  }
  const players = /* @__PURE__ */ new Set();
  let disposed = false;
  const requireReady = () => {
    if (disposed) throw new Error("Vector asset is disposed");
  };
  const createPlayer = ({ clip = Object.keys(clips)[0], startedAtMs = 0 } = {}) => {
    requireReady();
    if (!Object.hasOwn(clips, clip)) throw new TypeError(`Unknown vector clip: ${clip}`);
    finiteTime(startedAtMs, "startedAtMs");
    const timelines = /* @__PURE__ */ new Map();
    for (const [name, definition] of Object.entries(clips)) timelines.set(name, buildClipTimeline(definition, metadata.parts));
    const expressionParts = new Set(Object.values(metadata.expressions).flatMap((expression2) => [...expression2.show, ...expression2.hide]));
    const visible = new Map(metadata.parts.map((part) => [part.id, !expressionParts.has(part.id)]));
    const basePose = new Map(metadata.parts.map((part) => [part.id, { ...DEFAULT_POSE }]));
    const initial = metadata.expressions[metadata.defaultExpression];
    for (const id of initial.show) visible.set(id, true);
    for (const id of initial.hide) visible.set(id, false);
    let rootPlayback = { kind: "clip", name: clip, startedAtMs };
    let expression = metadata.defaultExpression;
    let visibilityOverridden = false;
    let displayTimeMs = startedAtMs;
    let currentPose = new Map(metadata.parts.map((part) => [part.id, { ...DEFAULT_POSE }]));
    let playerDisposed = false;
    const assertPlayer = () => {
      requireReady();
      if (playerDisposed) throw new Error("Vector player is disposed");
    };
    const sampleClip = (playback, timeMs) => {
      const definition = clips[playback.name], localTime = loopTime(definition, timeMs - playback.startedAtMs);
      const record = timelines.get(playback.name);
      record.timeline.seek(localTime, true);
      const output = /* @__PURE__ */ new Map();
      for (const [id, pose] of record.tracks) output.set(id, copyPose(pose));
      return output;
    };
    const sample = (playback, timeMs) => {
      if (playback.kind === "clip") return sampleClip(playback, timeMs);
      const source = sample(playback.from, timeMs);
      if (timeMs < playback.atMs) return source;
      const target = sample(playback.to, timeMs);
      const amount = playback.durationMs === 0 ? 1 : Math.min(1, Math.max(0, (timeMs - playback.atMs) / playback.durationMs));
      return blendPoses(source, target, amount, metadata.parts.map((part) => part.id));
    };
    const seek = (timeMs) => {
      assertPlayer();
      displayTimeMs = finiteTime(timeMs, "displayTimeMs");
      currentPose = sample(rootPlayback, displayTimeMs);
      return player;
    };
    const setExpression = (name) => {
      assertPlayer();
      const variant = metadata.expressions[name];
      if (!variant) throw new TypeError(`Unknown vector expression: ${name}`);
      for (const id of expressionParts) visible.set(id, false);
      for (const id of variant.show) visible.set(id, true);
      for (const id of variant.hide) visible.set(id, false);
      expression = name;
      visibilityOverridden = false;
      return player;
    };
    const setPartVisible = (id, isVisible) => {
      assertPlayer();
      if (!partIndices.has(id) || typeof isVisible !== "boolean") throw new TypeError("Known part id and boolean visibility required");
      visible.set(id, isVisible);
      visibilityOverridden = true;
      return player;
    };
    const setBasePose = (id, pose) => {
      assertPlayer();
      if (!partIndices.has(id) || !pose || typeof pose !== "object" || Array.isArray(pose)) throw new TypeError("Known part and pose object required");
      const current = basePose.get(id);
      for (const [field, value] of Object.entries(pose)) {
        if (!POSE_FIELDS.includes(field) || !Number.isFinite(value)) throw new TypeError("Part base poses accept only finite authored numeric pose fields");
        if (field === "opacity" && (value < 0 || value > 1)) throw new RangeError("Part opacity must be in [0,1]");
        if ((field === "scaleX" || field === "scaleY") && value === 0) throw new RangeError("Part scale cannot be zero");
        current[field] = value;
      }
      return player;
    };
    const play = (name, atMs = displayTimeMs) => {
      assertPlayer();
      if (!Object.hasOwn(clips, name)) throw new TypeError(`Unknown vector clip: ${name}`);
      rootPlayback = { kind: "clip", name, startedAtMs: finiteTime(atMs, "atMs") };
      return seek(atMs);
    };
    const transitionTo = (name, atMs = displayTimeMs, durationMs = 0) => {
      assertPlayer();
      if (!Object.hasOwn(clips, name)) throw new TypeError(`Unknown vector clip: ${name}`);
      finiteTime(atMs, "atMs");
      if (!Number.isFinite(durationMs) || durationMs < 0) throw new RangeError("transition duration must be finite and nonnegative");
      rootPlayback = { kind: "transition", from: rootPlayback, to: { kind: "clip", name, startedAtMs: atMs }, atMs, durationMs };
      return seek(atMs);
    };
    const worldMatrices = () => {
      const output = /* @__PURE__ */ new Map();
      const resolvePart = (id) => {
        if (output.has(id)) return output.get(id);
        const definition = metadata.parts[partIndices.get(id)];
        const pose = effectivePose(basePose.get(id), currentPose.get(id));
        const local = localMatrix(definition.pivot, pose);
        const matrix = definition.parent === null ? local : multiply(resolvePart(definition.parent), local);
        output.set(id, matrix);
        return matrix;
      };
      for (const part of metadata.parts) resolvePart(part.id);
      return output;
    };
    const getSocket = (id) => {
      assertPlayer();
      const socket = metadata.sockets[id];
      if (!socket) throw new TypeError(`Unknown vector socket: ${id}`);
      return transformPoint(worldMatrices().get(socket.part), socket.point);
    };
    const partPoses = () => {
      assertPlayer();
      const matrices = worldMatrices(), output = metadata.parts.map((part, index) => {
        const morph = authoredMorph(metadata, displayTimeMs);
        let parentVisible = true, opacity = 1, parent = part;
        while (parent) {
          parentVisible &&= visible.get(parent.id) !== false;
          opacity *= effectivePose(basePose.get(parent.id), currentPose.get(parent.id)).opacity;
          parent = parent.parent === null ? null : metadata.parts[partIndices.get(parent.parent)];
        }
        return { transform: matrices.get(part.id), morph, opacity, visible: parentVisible, index };
      });
      return output;
    };
    const draw = ({
      projection,
      viewProjection,
      worldMatrix,
      matrix = IDENTITY,
      alpha = 1,
      color = [1, 1, 1, 1],
      forceColor = false,
      whiteFlash = false,
      clips: clips2 = [],
      stencilRef = null,
      depth = 0,
      depthTest = false,
      depthWrite = false,
      depthFunc = "lequal",
      strokeViewport = null
    } = {}) => {
      assertPlayer();
      if (geometry.shaderSurfaces?.length) validateShaderSurfaceClipCapacity(clips2, surfaceRenderer.maxClipPlanes);
      const fullPartPoses = partPoses();
      const poses = fullPartPoses.map(({ transform, opacity, visible: isVisible }) => ({ transform, opacity, visible: isVisible }));
      if (geometry.drawOrder) {
        const worldMode2 = viewProjection !== void 0 || worldMatrix !== void 0;
        for (const command of geometry.drawOrder) {
          if (command.kind === "mesh") {
            if (!poses[command.partIndex].visible || poses[command.partIndex].opacity <= 0) continue;
            if (!mesh) throw new Error("SVG draw order references mesh geometry that was not retained");
            meshRenderer.drawMesh(mesh, {
              ...worldMode2 ? { viewProjection, worldMatrix } : { projection },
              matrix,
              parts: poses,
              morph: authoredMorph(metadata, displayTimeMs),
              alpha,
              color,
              forceColor,
              whiteFlash,
              clips: clips2,
              stencilRef,
              depth,
              depthTest,
              depthWrite,
              depthFunc,
              strokeViewport,
              indexRange: [command.firstIndex, command.indexCount]
            });
            continue;
          }
          const surface = retainedSurfaces[command.surfaceIndex], pose = fullPartPoses[geometry.shaderSurfaces[command.surfaceIndex].partIndex];
          if (!pose.visible || pose.opacity <= 0) continue;
          meshRenderer.flush("vectorShaderSurfaceBoundary");
          const materialTransform = worldMode2 ? pose.transform : multiply(matrix, pose.transform);
          const shaderDepth = depthTest || depthWrite ? { test: depthTest, write: depthWrite, func: depthFunc } : false;
          surfaceRenderer.drawSurface(surface, {
            ...worldMode2 ? { viewProjection, worldMatrix: composeWorldMatrix(worldMatrix, matrix) } : { projection },
            transform: materialTransform,
            color,
            alpha: alpha * pose.opacity,
            forceColor,
            whiteFlash: whiteFlash ? 1 : 0,
            timeMs: displayTimeMs,
            clips: clips2,
            stencilRef,
            z: depth,
            depth: shaderDepth
          });
        }
        return;
      }
      const indexVariant = !visibilityOverridden && compiledAsset.geometry.expressionIndices?.[expression] ? expression : null;
      const worldMode = viewProjection !== void 0 || worldMatrix !== void 0;
      meshRenderer.drawMesh(mesh, {
        ...worldMode ? { viewProjection, worldMatrix } : { projection },
        matrix,
        parts: poses,
        morph: authoredMorph(metadata, displayTimeMs),
        alpha,
        color,
        forceColor,
        whiteFlash,
        clips: clips2,
        stencilRef,
        depth,
        depthTest,
        depthWrite,
        depthFunc,
        indexVariant,
        strokeViewport
      });
    };
    const getPartPose = (id) => {
      assertPlayer();
      if (!partIndices.has(id)) throw new TypeError(`Unknown vector part: ${id}`);
      const index = partIndices.get(id), effective = partPoses()[index];
      return { ...currentPose.get(id), visible: effective.visible, transform: effective.transform };
    };
    const disposePlayer = () => {
      if (playerDisposed) return false;
      for (const { timeline } of timelines.values()) timeline.pause();
      timelines.clear();
      players.delete(player);
      playerDisposed = true;
      return true;
    };
    const player = Object.freeze({
      seek,
      play,
      transitionTo,
      setExpression,
      setPartVisible,
      setBasePose,
      getPartPose,
      getSocket,
      partPoses,
      draw,
      dispose: disposePlayer,
      get currentClip() {
        return rootPlayback.kind === "clip" ? rootPlayback.name : rootPlayback.to.name;
      },
      get currentExpression() {
        return expression;
      },
      get currentTimeMs() {
        return displayTimeMs;
      },
      get disposed() {
        return playerDisposed;
      }
    });
    players.add(player);
    seek(startedAtMs);
    return player;
  };
  const dispose = () => {
    if (disposed) return false;
    for (const player of [...players]) player.dispose();
    if (mesh) meshRenderer.deleteMesh(mesh);
    for (const surface of retainedSurfaces) surfaceRenderer.deleteSurface(surface);
    disposed = true;
    return true;
  };
  return Object.freeze({
    id: metadata.id,
    sourceSha256: compiledAsset.sourceSha256,
    schemaVersion: compiledAsset.schemaVersion,
    compilerVersion: compiledAsset.compilerVersion,
    viewBox: Object.freeze([...compiledAsset.viewBox]),
    metadata,
    mesh,
    surfaces: Object.freeze(retainedSurfaces),
    createPlayer,
    dispose,
    get disposed() {
      return disposed;
    },
    get playerCount() {
      return players.size;
    }
  });
}
export {
  createVectorAsset
};

// modules/hud/index.js
var FINITE = (value, name) => {
  if (!Number.isFinite(value)) {
    throw new TypeError(`${name} must be finite`);
  }
  return value;
};
function resolveAnchorInto(camera, anchor, out) {
  const SPACE = anchor.space ?? "world";
  if (SPACE === "world") {
    camera.worldToScreenInto(anchor.x, anchor.y, anchor.z ?? 0, out);
  } else if (SPACE === "screen") {
    out.x = FINITE(anchor.x, "x");
    out.y = FINITE(anchor.y, "y");
  } else {
    throw new RangeError("anchor.space must be world or screen");
  }
  out.x += FINITE(anchor.offsetX ?? 0, "offsetX");
  out.y += FINITE(anchor.offsetY ?? 0, "offsetY");
  const MARGIN = FINITE(anchor.margin ?? 0, "margin");
  if (MARGIN < 0 || MARGIN * 2 > Math.min(camera.width, camera.height)) {
    throw new RangeError("margin outside viewport");
  }
  out.onScreen = out.x >= MARGIN && out.x <= camera.width - MARGIN && out.y >= MARGIN && out.y <= camera.height - MARGIN;
  out.visible = anchor.visible !== false && (anchor.clamp === true || out.onScreen);
  if (anchor.clamp === true) {
    out.x = Math.max(MARGIN, Math.min(camera.width - MARGIN, out.x));
    out.y = Math.max(MARGIN, Math.min(camera.height - MARGIN, out.y));
  }
  return out;
}
var DOMHud = class {
  constructor({ camera, root } = {}) {
    if (typeof camera?.worldToScreenInto !== "function" || !root?.appendChild) {
      throw new TypeError("camera and DOM root required");
    }
    this.camera = camera;
    this.root = root;
    this.entries = /* @__PURE__ */ new Map();
    this.disposed = false;
    this.stats = {
      writes: 0,
      nodes: 0
    };
  }
  _ready() {
    if (this.disposed) {
      throw new Error("HUD disposed");
    }
  }
  add(id, { element, anchor, text } = {}) {
    this._ready();
    if (this.entries.has(id)) {
      throw new Error("duplicate HUD id");
    }
    if (!anchor || typeof anchor !== "object") {
      throw new TypeError("anchor required");
    }
    if (text !== void 0 && typeof text !== "string" && typeof text !== "number") {
      throw new TypeError("HUD text must be string or number");
    }
    const OWNED = !element;
    element ??= this.root.ownerDocument.createElement("span");
    if (!element.style || !element.setAttribute) {
      throw new TypeError("DOM element required");
    }
    const POINT = {};
    resolveAnchorInto(this.camera, anchor, POINT);
    const PREVIOUS = {
      css: element.getAttribute("style"),
      hidden: element.hidden,
      children: [...element.childNodes],
      parent: element.parentNode,
      next: element.nextSibling
    };
    if (!OWNED && PREVIOUS.parent) {
      PREVIOUS.marker = element.ownerDocument.createComment("hud position");
      PREVIOUS.parent.insertBefore(PREVIOUS.marker, element);
    }
    element.style.position = "absolute";
    element.style.left = "0";
    element.style.top = "0";
    element.style.pointerEvents = "none";
    this.root.appendChild(element);
    this.entries.set(id, {
      element,
      anchor: {
        ...anchor
      },
      point: POINT,
      owned: OWNED,
      previous: PREVIOUS,
      x: NaN,
      y: NaN,
      visible: null,
      text: void 0
    });
    this.stats.nodes++;
    if (text !== void 0) {
      this.setText(id, text);
    }
    return element;
  }
  setText(id, text) {
    this._ready();
    const ENTRY = this.entries.get(id);
    if (!ENTRY) {
      throw new RangeError("unknown HUD id");
    }
    if (typeof text !== "string" && typeof text !== "number") {
      throw new TypeError("HUD text must be string or number");
    }
    text = String(text);
    if (ENTRY.text !== text) {
      ENTRY.element.textContent = text;
      ENTRY.text = text;
      this.stats.writes++;
    }
    return this;
  }
  setAnchor(id, anchor) {
    this._ready();
    const ENTRY = this.entries.get(id);
    if (!ENTRY) {
      throw new RangeError("unknown HUD id");
    }
    const NEXT = {
      ...ENTRY.anchor,
      ...anchor
    };
    resolveAnchorInto(this.camera, NEXT, ENTRY.point);
    ENTRY.anchor = NEXT;
    return this;
  }
  update() {
    this._ready();
    for (const ENTRY of this.entries.values()) {
      const POINT = resolveAnchorInto(this.camera, ENTRY.anchor, ENTRY.point);
      if (POINT.visible !== ENTRY.visible) {
        ENTRY.element.hidden = !POINT.visible;
        ENTRY.visible = POINT.visible;
        this.stats.writes++;
      }
      if (POINT.visible && (POINT.x !== ENTRY.x || POINT.y !== ENTRY.y)) {
        ENTRY.element.style.transform = `translate(${POINT.x}px,${POINT.y}px) translate(-50%,-100%)`;
        ENTRY.x = POINT.x;
        ENTRY.y = POINT.y;
        this.stats.writes++;
      }
    }
    return this.stats;
  }
  remove(id) {
    const ENTRY = this.entries.get(id);
    if (!ENTRY) {
      return false;
    }
    const { element: ELEMENT, previous: PREVIOUS } = ENTRY;
    if (ENTRY.owned) {
      ELEMENT.remove();
    } else {
      if (PREVIOUS.css === null) {
        ELEMENT.removeAttribute("style");
      } else {
        ELEMENT.setAttribute("style", PREVIOUS.css);
      }
      ELEMENT.hidden = PREVIOUS.hidden;
      ELEMENT.replaceChildren(...PREVIOUS.children);
      if (PREVIOUS.parent) {
        PREVIOUS.parent.insertBefore(
          ELEMENT,
          PREVIOUS.marker?.parentNode === PREVIOUS.parent ? PREVIOUS.marker : PREVIOUS.next?.parentNode === PREVIOUS.parent ? PREVIOUS.next : null
        );
      } else {
        ELEMENT.remove();
      }
      PREVIOUS.marker?.remove();
    }
    this.entries.delete(id);
    this.stats.nodes--;
    return true;
  }
  dispose() {
    if (this.disposed) {
      return;
    }
    for (const ID of this.entries.keys()) {
      this.remove(ID);
    }
    this.disposed = true;
  }
};
function paintAnchored(camera, anchor, out, paint) {
  if (typeof paint !== "function") {
    throw new TypeError("paint required");
  }
  resolveAnchorInto(camera, anchor, out);
  if (out.visible) {
    paint(out);
  }
  return out.visible;
}
export {
  DOMHud,
  paintAnchored,
  resolveAnchorInto
};

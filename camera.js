// modules/camera/collision-boom.js
var NONNEGATIVE = (value, name) => {
  if (!Number.isFinite(value)) {
    throw new TypeError(`${name} must be finite`);
  }
  if (value < 0) {
    throw new RangeError(`${name} must be nonnegative`);
  }
  return value;
};
var CollisionBoom = class {
  constructor({ distance = 0, holdMs = 120, releaseHalfLifeMs = 180 } = {}) {
    this._holdMs = NONNEGATIVE(holdMs, "holdMs");
    this._releaseHalfLifeMs = NONNEGATIVE(releaseHalfLifeMs, "releaseHalfLifeMs");
    this.reset(distance);
  }
  get distance() {
    return this._distance;
  }
  /** 순간이동·재시작 시 과거 hold를 버립니다. 다음 update 전 안전성은 호출자 책임입니다. */
  reset(distance = 0) {
    this._distance = NONNEGATIVE(distance, "distance");
    this._holdRemainingMs = 0;
    return this;
  }
  /**
   * @param {number} desiredDistance 장애물이 없을 때 원하는 유한한 비음수 거리.
   * @param {number} clearDistance 현재 pivot/방향의 probe로 확인한 최대 안전 거리.
   *   충돌이 없으면 desiredDistance를 전달합니다. 반경·여유 거리는 이미 반영해야 합니다.
   * @param {number} elapsedMs 이전 update 이후 경과한 유한한 비음수 표현 시간.
   * @returns {number} min(desiredDistance, clearDistance)를 넘지 않는 현재 거리.
   * 축소는 elapsedMs=0이어도 즉시 적용합니다. 최근접 장애물의 재관측은 hold를
   * 갱신하며, hold를 지난 나머지 시간만 반감기 복원에 사용합니다. 0ms에는 늘어나지
   * 않습니다. releaseHalfLifeMs=0은 hold 후 양수 시간이 흐르면 즉시 복원합니다.
   * 반환 거리를 적용한 뒤 별도 위치 보간으로 안전 한계를 넘기지 마세요.
   */
  update(desiredDistance, clearDistance, elapsedMs) {
    NONNEGATIVE(desiredDistance, "desiredDistance");
    NONNEGATIVE(clearDistance, "clearDistance");
    NONNEGATIVE(elapsedMs, "elapsedMs");
    const TARGET = Math.min(desiredDistance, clearDistance);
    if (TARGET < this._distance || TARGET === this._distance && clearDistance < desiredDistance) {
      this._distance = TARGET;
      this._holdRemainingMs = this._holdMs;
      return this._distance;
    }
    const RELEASE_MS = Math.max(0, elapsedMs - this._holdRemainingMs);
    this._holdRemainingMs = Math.max(0, this._holdRemainingMs - elapsedMs);
    if (RELEASE_MS > 0) {
      const ALPHA = this._releaseHalfLifeMs === 0 ? 1 : -Math.expm1(-Math.LN2 * RELEASE_MS / this._releaseHalfLifeMs);
      this._distance = Math.min(TARGET, this._distance + (TARGET - this._distance) * ALPHA);
    }
    return this._distance;
  }
};

// modules/camera/index.js
var FINITE = (n, name) => {
  if (!Number.isFinite(n)) {
    throw new TypeError(`${name} must be finite`);
  }
  return n;
};
var POSITIVE = (n, name) => {
  FINITE(n, name);
  if (n <= 0) {
    throw new RangeError(`${name} must be positive`);
  }
  return n;
};
var OrthographicProjection = class {
  constructor(options = {}) {
    this.configure({
      degrees: 40,
      pixel2to1: false,
      ...options
    });
  }
  configure({ degrees = this._degrees, pixel2to1 = this.pixel2to1 } = {}) {
    FINITE(degrees, "degrees");
    if (degrees <= 0 || degrees > 90) {
      throw new RangeError("degrees must be (0,90]");
    }
    if (typeof pixel2to1 !== "boolean") {
      throw new TypeError("pixel2to1 must be boolean");
    }
    this._degrees = degrees;
    this.pixel2to1 = pixel2to1;
    this.K = pixel2to1 ? 0.5 : Math.sin(degrees * Math.PI / 180);
    this.H = Math.sqrt(Math.max(0, 1 - this.K * this.K));
    this.degrees = Math.asin(this.K) * 180 / Math.PI;
    return this;
  }
  projectInto(x, y, z, out) {
    FINITE(x, "x");
    FINITE(y, "y");
    FINITE(z, "z");
    out.x = x;
    out.y = y * this.K - z * this.H;
    out.depth = y * this.H + z * this.K;
    return out;
  }
  groundInto(x, y, out, z = 0) {
    FINITE(x, "x");
    FINITE(y, "y");
    FINITE(z, "z");
    out.x = x;
    out.y = (y + z * this.H) / this.K;
    out.z = z;
    return out;
  }
  depth(y, z = 0) {
    return FINITE(y, "y") * this.H + FINITE(z, "z") * this.K;
  }
  angle(angle) {
    FINITE(angle, "angle");
    return Math.atan2(Math.sin(angle) * this.K, Math.cos(angle));
  }
  intentInto(x, y, out) {
    FINITE(x, "x");
    FINITE(y, "y");
    const MAGNITUDE = Math.min(1, Math.hypot(x, y)), WY = y / this.K, LENGTH = Math.hypot(x, WY);
    out.x = LENGTH ? x / LENGTH * MAGNITUDE : 0;
    out.y = LENGTH ? WY / LENGTH * MAGNITUDE : 0;
    return out;
  }
};
var CameraViewport = class {
  constructor({
    projection = new OrthographicProjection(),
    width = 1,
    height = 1,
    dpr = 1,
    left = 0,
    top = 0,
    x = 0,
    y = 0,
    zoom = 1,
    rotation = 0
  } = {}) {
    if (typeof projection?.projectInto !== "function" || typeof projection?.groundInto !== "function") {
      throw new TypeError("projection contract required");
    }
    this.projection = projection;
    this.camera = {
      x: 0,
      y: 0,
      zoom: 1,
      rotation: 0
    };
    this._point = {};
    this._matrix = new Array(6);
    this.shakeX = 0;
    this.shakeY = 0;
    this.setViewport({
      width,
      height,
      dpr,
      left,
      top
    });
    this.setCamera({
      x,
      y,
      zoom,
      rotation
    });
  }
  setViewport({ width = this.width, height = this.height, dpr = this.dpr, left = this.left, top = this.top } = {}) {
    POSITIVE(width, "width");
    POSITIVE(height, "height");
    POSITIVE(dpr, "dpr");
    POSITIVE(width * dpr, "backing width");
    POSITIVE(height * dpr, "backing height");
    FINITE(left, "left");
    FINITE(top, "top");
    this.width = width;
    this.height = height;
    this.dpr = dpr;
    this.left = left;
    this.top = top;
    this.backingWidth = Math.max(1, Math.round(width * dpr));
    this.backingHeight = Math.max(1, Math.round(height * dpr));
    return this;
  }
  setCamera({ x = this.camera.x, y = this.camera.y, zoom = this.camera.zoom, rotation = this.camera.rotation } = {}) {
    FINITE(x, "x");
    FINITE(y, "y");
    POSITIVE(zoom, "zoom");
    FINITE(rotation, "rotation");
    Object.assign(this.camera, {
      x,
      y,
      zoom,
      rotation
    });
    this._cos = Math.cos(rotation);
    this._sin = Math.sin(rotation);
    return this;
  }
  setShake(x = 0, y = 0) {
    this.shakeX = FINITE(x, "x");
    this.shakeY = FINITE(y, "y");
    return this;
  }
  /** Caller chooses target and duration. This modifies presentation only; no random source or authority. */
  follow(x, y, elapsedMs, halfLifeMs = 0) {
    FINITE(x, "x");
    FINITE(y, "y");
    FINITE(elapsedMs, "elapsedMs");
    FINITE(halfLifeMs, "halfLifeMs");
    if (elapsedMs < 0 || halfLifeMs < 0) {
      throw new RangeError("follow times must be nonnegative");
    }
    const A = halfLifeMs === 0 ? 1 : -Math.expm1(-Math.LN2 * elapsedMs / halfLifeMs);
    return this.setCamera({
      x: this.camera.x + (x - this.camera.x) * A,
      y: this.camera.y + (y - this.camera.y) * A
    });
  }
  /**
   * World plane to canvas backing pixels as six affine floats in Canvas `setTransform(a, b, c, d, e, f)` order,
   * with zoom, rotation, shake and the backing scale folded in.
   */
  transformInto(out) {
    const C = this.camera, SX = this.backingWidth / this.width, SY = this.backingHeight / this.height, A = SX * this._cos * C.zoom, CC = SX * this._sin * C.zoom, B = -SY * this._sin * C.zoom, D = SY * this._cos * C.zoom;
    out[0] = A;
    out[1] = B;
    out[2] = CC;
    out[3] = D;
    out[4] = SX * (this.width / 2 + this.shakeX) - A * C.x - CC * C.y;
    out[5] = SY * (this.height / 2 + this.shakeY) - B * C.x - D * C.y;
    return out;
  }
  /** Sets the context transform for this frame (`VectorContext` or Canvas2D). */
  applyToContext(context) {
    context.setTransform(...this.transformInto(this._matrix));
    return this;
  }
  /** Sizes the canvas backing store to the viewport times dpr; CSS size stays with the page. */
  resizeCanvas(canvas) {
    if (canvas.width !== this.backingWidth) {
      canvas.width = this.backingWidth;
    }
    if (canvas.height !== this.backingHeight) {
      canvas.height = this.backingHeight;
    }
    return this;
  }
  planeToScreenInto(x, y, out) {
    FINITE(x, "x");
    FINITE(y, "y");
    const DX = x - this.camera.x, DY = y - this.camera.y;
    out.x = (this._cos * DX + this._sin * DY) * this.camera.zoom + this.width / 2 + this.shakeX;
    out.y = (-this._sin * DX + this._cos * DY) * this.camera.zoom + this.height / 2 + this.shakeY;
    return out;
  }
  screenToPlaneInto(x, y, out) {
    FINITE(x, "x");
    FINITE(y, "y");
    const DX = (x - this.width / 2 - this.shakeX) / this.camera.zoom, DY = (y - this.height / 2 - this.shakeY) / this.camera.zoom;
    out.x = this._cos * DX - this._sin * DY + this.camera.x;
    out.y = this._sin * DX + this._cos * DY + this.camera.y;
    return out;
  }
  worldToScreenInto(x, y, z, out) {
    this.projection.projectInto(x, y, z, this._point);
    return this.planeToScreenInto(this._point.x, this._point.y, out);
  }
  clientToScreenInto(x, y, out) {
    out.x = FINITE(x, "x") - this.left;
    out.y = FINITE(y, "y") - this.top;
    return out;
  }
  screenToClientInto(x, y, out) {
    out.x = FINITE(x, "x") + this.left;
    out.y = FINITE(y, "y") + this.top;
    return out;
  }
  screenToBackingInto(x, y, out) {
    out.x = FINITE(x, "x") * this.backingWidth / this.width;
    out.y = FINITE(y, "y") * this.backingHeight / this.height;
    return out;
  }
  /** Exact flat inverse, or caller terrain intersection hook (returns boolean). No hidden iterative solver. */
  screenToGroundInto(x, y, out, { z = 0, intersect = null } = {}) {
    this.screenToPlaneInto(x, y, this._point);
    if (intersect !== null) {
      if (typeof intersect !== "function") {
        throw new TypeError("intersect must be a function");
      }
      return intersect(this._point.x, this._point.y, this.projection, out);
    }
    this.projection.groundInto(this._point.x, this._point.y, out, z);
    return true;
  }
};
export {
  CameraViewport,
  CollisionBoom,
  OrthographicProjection
};

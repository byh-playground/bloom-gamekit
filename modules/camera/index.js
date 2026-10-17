export { CollisionBoom } from './collision-boom.js';
const FINITE = (n, name) => {
    if (!Number.isFinite(n)) {
        throw new TypeError(`${name} must be finite`);
    }
    return n;
};
const POSITIVE = (n, name) => {
    FINITE(n, name);
    if (n <= 0) {
        throw new RangeError(`${name} must be positive`);
    }
    return n;
};
/** XYZ pitch projection. Absolute Z; terrain offsets belong to the caller. */
export class OrthographicProjection {
    constructor(options = {}) {
        this.configure({
            degrees: 40,
            pixel2to1: false,
            ...options,
        });
    }
    configure({ degrees = this._degrees, pixel2to1 = this.pixel2to1 } = {}) {
        FINITE(degrees, 'degrees');
        if (degrees <= 0 || degrees > 90) {
            throw new RangeError('degrees must be (0,90]');
        }
        if (typeof pixel2to1 !== 'boolean') {
            throw new TypeError('pixel2to1 must be boolean');
        }
        this._degrees = degrees;
        this.pixel2to1 = pixel2to1;
        this.K = pixel2to1 ? 0.5 : Math.sin((degrees * Math.PI) / 180);
        this.H = Math.sqrt(Math.max(0, 1 - this.K * this.K));
        this.degrees = (Math.asin(this.K) * 180) / Math.PI;
        return this;
    }
    projectInto(x, y, z, out) {
        FINITE(x, 'x');
        FINITE(y, 'y');
        FINITE(z, 'z');
        out.x = x;
        out.y = y * this.K - z * this.H;
        out.depth = y * this.H + z * this.K;
        return out;
    }
    groundInto(x, y, out, z = 0) {
        FINITE(x, 'x');
        FINITE(y, 'y');
        FINITE(z, 'z');
        out.x = x;
        out.y = (y + z * this.H) / this.K;
        out.z = z;
        return out;
    }
    depth(y, z = 0) {
        return FINITE(y, 'y') * this.H + FINITE(z, 'z') * this.K;
    }
    angle(angle) {
        FINITE(angle, 'angle');
        return Math.atan2(Math.sin(angle) * this.K, Math.cos(angle));
    }
    intentInto(x, y, out) {
        FINITE(x, 'x');
        FINITE(y, 'y');
        const MAGNITUDE = Math.min(1, Math.hypot(x, y)),
            WY = y / this.K,
            LENGTH = Math.hypot(x, WY);
        out.x = LENGTH ? (x / LENGTH) * MAGNITUDE : 0;
        out.y = LENGTH ? (WY / LENGTH) * MAGNITUDE : 0;
        return out;
    }
}
/** Renderer2D's projected-plane center/zoom/rotation contract, in CSS pixels. */
export class CameraViewport {
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
        rotation = 0,
    } = {}) {
        if (typeof projection?.projectInto !== 'function' || typeof projection?.groundInto !== 'function') {
            throw new TypeError('projection contract required');
        }
        this.projection = projection;
        this.camera = {
            x: 0,
            y: 0,
            zoom: 1,
            rotation: 0,
        };
        this._point = {};
        this._render = {};
        this.shakeX = 0;
        this.shakeY = 0;
        this.setViewport({
            width,
            height,
            dpr,
            left,
            top,
        });
        this.setCamera({
            x,
            y,
            zoom,
            rotation,
        });
    }
    setViewport({ width = this.width, height = this.height, dpr = this.dpr, left = this.left, top = this.top } = {}) {
        POSITIVE(width, 'width');
        POSITIVE(height, 'height');
        POSITIVE(dpr, 'dpr');
        POSITIVE(width * dpr, 'backing width');
        POSITIVE(height * dpr, 'backing height');
        FINITE(left, 'left');
        FINITE(top, 'top');
        this.width = width;
        this.height = height;
        this.dpr = dpr;
        this.left = left;
        this.top = top;
        return this;
    }
    setCamera({ x = this.camera.x, y = this.camera.y, zoom = this.camera.zoom, rotation = this.camera.rotation } = {}) {
        FINITE(x, 'x');
        FINITE(y, 'y');
        POSITIVE(zoom, 'zoom');
        FINITE(rotation, 'rotation');
        Object.assign(this.camera, {
            x,
            y,
            zoom,
            rotation,
        });
        this._cos = Math.cos(rotation);
        this._sin = Math.sin(rotation);
        return this;
    }
    setShake(x = 0, y = 0) {
        this.shakeX = FINITE(x, 'x');
        this.shakeY = FINITE(y, 'y');
        return this;
    }
    /** Caller chooses target and duration. This modifies presentation only; no random source or authority. */
    follow(x, y, elapsedMs, halfLifeMs = 0) {
        FINITE(x, 'x');
        FINITE(y, 'y');
        FINITE(elapsedMs, 'elapsedMs');
        FINITE(halfLifeMs, 'halfLifeMs');
        if (elapsedMs < 0 || halfLifeMs < 0) {
            throw new RangeError('follow times must be nonnegative');
        }
        const A = halfLifeMs === 0 ? 1 : -Math.expm1((-Math.LN2 * elapsedMs) / halfLifeMs);
        return this.setCamera({
            x: this.camera.x + (x - this.camera.x) * A,
            y: this.camera.y + (y - this.camera.y) * A,
        });
    }
    rendererCameraInto(out) {
        const C = this.camera,
            DX = this.shakeX / C.zoom,
            DY = this.shakeY / C.zoom;
        out.x = C.x - this._cos * DX + this._sin * DY;
        out.y = C.y - this._sin * DX - this._cos * DY;
        out.zoom = C.zoom;
        out.rotation = C.rotation;
        return out;
    }
    applyToRenderer(renderer, resize = false) {
        if (resize) {
            renderer.resize(this.width, this.height, this.dpr);
        }
        renderer.setCamera(this.rendererCameraInto(this._render));
        return this;
    }
    planeToScreenInto(x, y, out) {
        FINITE(x, 'x');
        FINITE(y, 'y');
        const DX = x - this.camera.x,
            DY = y - this.camera.y;
        out.x = (this._cos * DX + this._sin * DY) * this.camera.zoom + this.width / 2 + this.shakeX;
        out.y = (-this._sin * DX + this._cos * DY) * this.camera.zoom + this.height / 2 + this.shakeY;
        return out;
    }
    screenToPlaneInto(x, y, out) {
        FINITE(x, 'x');
        FINITE(y, 'y');
        const DX = (x - this.width / 2 - this.shakeX) / this.camera.zoom,
            DY = (y - this.height / 2 - this.shakeY) / this.camera.zoom;
        out.x = this._cos * DX - this._sin * DY + this.camera.x;
        out.y = this._sin * DX + this._cos * DY + this.camera.y;
        return out;
    }
    worldToScreenInto(x, y, z, out) {
        this.projection.projectInto(x, y, z, this._point);
        return this.planeToScreenInto(this._point.x, this._point.y, out);
    }
    clientToScreenInto(x, y, out) {
        out.x = FINITE(x, 'x') - this.left;
        out.y = FINITE(y, 'y') - this.top;
        return out;
    }
    screenToClientInto(x, y, out) {
        out.x = FINITE(x, 'x') + this.left;
        out.y = FINITE(y, 'y') + this.top;
        return out;
    }
    screenToBackingInto(x, y, out) {
        out.x = (FINITE(x, 'x') * Math.max(1, Math.round(this.width * this.dpr))) / this.width;
        out.y = (FINITE(y, 'y') * Math.max(1, Math.round(this.height * this.dpr))) / this.height;
        return out;
    }
    /** Exact flat inverse, or caller terrain intersection hook (returns boolean). No hidden iterative solver. */
    screenToGroundInto(x, y, out, { z = 0, intersect = null } = {}) {
        this.screenToPlaneInto(x, y, this._point);
        if (intersect !== null) {
            if (typeof intersect !== 'function') {
                throw new TypeError('intersect must be a function');
            }
            return intersect(this._point.x, this._point.y, this.projection, out);
        }
        this.projection.groundInto(this._point.x, this._point.y, out, z);
        return true;
    }
}

// modules/pixel-physics/core.js
import Matter from "https://cdn.jsdelivr.net/npm/matter-js@0.19.0/+esm";
var KINDS = { solid: 0, powder: 1, liquid: 2, gas: 3 };
function inPoly(v, px, py) {
  let p = 0, n = 0;
  for (let i = 0, l = v.length; i < l; i++) {
    const A = v[i], B_VALUE = v[i + 1 === l ? 0 : i + 1], C_VALUE = (B_VALUE.x - A.x) * (py - A.y) - (B_VALUE.y - A.y) * (px - A.x);
    if (C_VALUE > 0) {
      p = 1;
    } else if (C_VALUE < 0) {
      n = 1;
    }
    if (p && n) {
      return false;
    }
  }
  return true;
}
function polyHit(pValue, x0, y0, x1, y1) {
  for (const V of pValue) {
    let ax = 1e9, bx = -1e9, ay = 1e9, by = -1e9;
    for (const P_VALUE of V) {
      if (P_VALUE.x < ax) {
        ax = P_VALUE.x;
      }
      if (P_VALUE.x > bx) {
        bx = P_VALUE.x;
      }
      if (P_VALUE.y < ay) {
        ay = P_VALUE.y;
      }
      if (P_VALUE.y > by) {
        by = P_VALUE.y;
      }
    }
    if (bx <= x0 || ax >= x1 || by <= y0 || ay >= y1) {
      continue;
    }
    let hit = true;
    for (let i = 0, l = V.length; i < l && hit; i++) {
      const A = V[i], B_VALUE = V[i + 1 === l ? 0 : i + 1], NX = B_VALUE.y - A.y, NY = A.x - B_VALUE.x;
      let pmin = 1e9, pmax = -1e9;
      for (const P_VALUE of V) {
        const D_VALUE = P_VALUE.x * NX + P_VALUE.y * NY;
        if (D_VALUE < pmin) {
          pmin = D_VALUE;
        }
        if (D_VALUE > pmax) {
          pmax = D_VALUE;
        }
      }
      const C0 = x0 * NX + y0 * NY, C1 = x1 * NX + y0 * NY, C2 = x0 * NX + y1 * NY, C3 = x1 * NX + y1 * NY, RMIN = Math.min(C0, C1, C2, C3), RMAX = Math.max(C0, C1, C2, C3);
      if (pmax <= RMIN || RMAX <= pmin) {
        hit = false;
      }
    }
    if (hit) {
      return true;
    }
  }
  return false;
}
function bodyHit(bValue, h, x0, y0, x1, y1) {
  const BD = bValue.getBounds(h);
  if (BD.x1 <= x0 || BD.x0 >= x1 || BD.y1 <= y0 || BD.y0 >= y1) {
    return false;
  }
  return polyHit(bValue.getPolys(h), x0, y0, x1, y1);
}
var HYP = (x, y) => Math.sqrt(x * x + y * y);
var NOW = () => typeof performance !== "undefined" ? performance.now() : Date.now();
function dsin(x) {
  const TP = 6.283185307179586, H = 1.5707963267948966;
  x -= TP * Math.round(x / TP);
  if (x > H) {
    x = Math.PI - x;
  } else if (x < -H) {
    x = -Math.PI - x;
  }
  const Q = x * x;
  return x * (1 + Q * (-1 / 6 + Q * (1 / 120 + Q * (-1 / 5040 + Q * (1 / 362880 + Q * (-1 / 39916800 + Q * (1 / 6227020800)))))));
}
function dcos(x) {
  return dsin(x + 1.5707963267948966);
}
function installDeterministicTrig() {
  Math.sin = dsin;
  Math.cos = dcos;
}
function shiftPlane(a, pw, ph, dx, dy, fill) {
  const X0 = Math.max(0, -dx), X1 = Math.min(pw, pw - dx), Y0 = Math.max(0, -dy), Y1 = Math.min(ph, ph - dy);
  if (X0 >= X1 || Y0 >= Y1) {
    a.fill(fill);
    return;
  }
  for (let n = 0; n < Y1 - Y0; n++) {
    const Y = dy > 0 ? Y0 + n : Y1 - 1 - n, SRC = (Y + dy) * pw + X0 + dx;
    a.copyWithin(Y * pw + X0, SRC, SRC + (X1 - X0));
  }
  a.fill(fill, 0, Y0 * pw);
  a.fill(fill, Y1 * pw);
  for (let y = Y0; y < Y1; y++) {
    a.fill(fill, y * pw, y * pw + X0);
    a.fill(fill, y * pw + X1, (y + 1) * pw);
  }
}
function hashCell(seed, x, y) {
  let h = (seed ^ Math.imul(x | 0, 2654435761) ^ Math.imul(y | 0, 2246822507)) >>> 0;
  h = Math.imul(h ^ h >>> 16, 2146121005);
  h = Math.imul(h ^ h >>> 15, 2221713035);
  return (h ^ h >>> 16) >>> 0;
}
var PixelWorld = class _PixelWorld {
  constructor(w, h, { seed = 1, originX = 0, originY = 0, stream = {} } = {}) {
    this.w = w;
    this.h = h;
    this.originX = originX;
    this.originY = originY;
    this.setStreaming(stream);
    const N_VALUE = w * h;
    this.g = new Uint8Array(N_VALUE);
    this.life = new Uint8Array(N_VALUE);
    this.u = new Uint8Array(N_VALUE);
    this.mats = [{ name: "empty", kind: "solid", color: [0, 0, 0], reactions: [] }];
    this.id = { empty: 0 };
    this.bodies = [];
    this.eseq = 1;
    this.statuses = {};
    this.flag = 1;
    this.dir = 0;
    this.seed = seed >>> 0;
    this.dirty = true;
    this.time = 0;
    this.cw = Math.ceil(w / 16);
    this.chh = Math.ceil(h / 16);
    const NCH = this.cw * this.chh;
    this.chd = new Uint8Array(NCH);
    this.awake = new Uint8Array(NCH).fill(20);
    this.reac = new Uint8Array(NCH).fill(1);
    this.sleepEnabled = true;
    this.chunkTick = new Uint32Array(NCH);
    this.pseq = 1;
    this.proj = [];
    this.stats = { active: NCH, total: NCH, ms: 0 };
    this.bridge = null;
    this.gown = new Int16Array(N_VALUE);
    this.jetPush = 0.5;
    this.fp = new Uint8Array(N_VALUE);
    this._ghost = [];
    this.ghostId = null;
    this.ev = {};
    this.impactScale = 150;
    this.fluidScale = 2e-4;
    this._mk = new Int32Array(N_VALUE);
    this._mkId = 0;
    this.collapse = null;
    this.supDirty = false;
    this._supT = -99;
    this._sup = null;
    this._stk = null;
    this._sk = null;
    this._skId = 0;
    this.frag = { minCells: 3, maxPieces: 6, jitter: 1.6, kick: 0.35, hardening: 1.5, maxGen: 3, maxBodies: 70 };
  }
  rand() {
    let t = this.seed += 1831565813;
    t = Math.imul(t ^ t >>> 15, t | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  }
  rnd(n) {
    return this.rand() * n | 0;
  }
  define(d) {
    const M_VALUE = {
      kind: "solid",
      density: 50,
      dispersion: 0,
      rise: 0,
      slow: 0,
      color: [200, 200, 200],
      reactions: [],
      ...d
    };
    M_VALUE.id = this.mats.length;
    this.mats.push(M_VALUE);
    this.id[M_VALUE.name] = M_VALUE.id;
    this.dirty = true;
    return M_VALUE.id;
  }
  defineStatus(name, s) {
    this.statuses[name] = s;
  }
  _compile() {
    const N = this.mats.length;
    this.K = new Uint8Array(N);
    this.D = new Float32Array(N);
    this.DI = new Uint8Array(N);
    this.R = new Float32Array(N);
    this.S = new Float32Array(N);
    this.NS = new Uint8Array(N);
    this.AN = new Uint8Array(N);
    this.ST = new Uint8Array(N);
    this.PU = new Float32Array(N);
    this.BL = new Uint8Array(N);
    this.SW = new Uint8Array(N);
    this.FL = new Uint8Array(N);
    this.PAL = new Uint32Array(N * 8);
    this.mats.forEach((m, i) => {
      this.K[i] = KINDS[m.kind];
      this.D[i] = m.density;
      this.DI[i] = m.dispersion;
      this.R[i] = m.rise;
      this.S[i] = m.slow;
      this.NS[i] = m.noSwap ? 1 : 0;
      this.PU[i] = m.push ?? m.density;
      this.ST[i] = i !== 0 && m.kind === "solid" && !(m.body && m.body.blocks === false) ? 1 : 0;
      this.FL[i] = m.flicker ? 1 : 0;
      this.AN[i] = m.anchor ?? m.indestructible ? 1 : 0;
      this.SW[i] = m.body && m.body.swim ? 1 : 0;
      this.BL[i] = m.body && m.body.blocks != null ? +m.body.blocks : m.kind === "solid" || m.kind === "powder" ? 1 : 0;
      m.rx = m.reactions.map((r) => ({
        w: [].concat(r.with).map((n) => this.id[n]),
        chance: r.chance ?? 1,
        self: r.self == null ? -1 : this.id[r.self],
        other: r.other == null ? -1 : this.id[r.other]
      }));
      m.decayTo = m.decay ? this.id[m.decay.to] ?? 0 : 0;
      m.act = !!(m.decay || m.rx.length || m.react);
      const C_VALUE = m.color;
      for (let v = 0; v < 8; v++) {
        const F_VALUE = 0.82 + v * 0.05;
        this.PAL[i * 8 + v] = 255 << 24 | Math.min(255, C_VALUE[2] * F_VALUE | 0) << 16 | Math.min(255, C_VALUE[1] * F_VALUE | 0) << 8 | Math.min(255, C_VALUE[0] * F_VALUE | 0);
      }
    });
    this.dirty = false;
  }
  _lf(id) {
    const M_VALUE = this.mats[id];
    return M_VALUE.life ? M_VALUE.life[0] + this.rnd(M_VALUE.life[1] - M_VALUE.life[0] + 1) : 0;
  }
  spray(x, y, vx, vy, mat, { shooter = null, recoil = 1 } = {}) {
    if (this.proj.length >= 600) {
      return;
    }
    const RID = typeof mat === "string" ? this.id[mat] : mat;
    this.proj.push({
      x,
      y,
      vx,
      vy,
      id: typeof mat === "string" ? this.id[mat] : mat,
      t: 0,
      ex: Math.floor(x),
      ey: Math.floor(y),
      src: shooter
    });
    if (shooter) {
      if (this.dirty) {
        this._compile();
      }
      const M_VALUE = this.PU[RID] * this.fluidScale * recoil, JX = -vx * M_VALUE, JY = -vy * M_VALUE;
      if (shooter.impulse) {
        shooter.impulse(JX / shooter.mass, JY / shooter.mass);
      } else if (this.bridge && shooter.body) {
        this.bridge.applyImpulse(shooter, JX, JY);
      }
    }
  }
  _drop(x, y, id) {
    if (x < 0 || y < 0) {
      return;
    }
    const G = this.g, W_VALUE = this.w, H_VALUE = this.h;
    if (!_PixelWorld._OFF) {
      const O = [];
      for (let dy = 0; dy <= 4; dy++) {
        for (let dx = -4; dx <= 4; dx++) {
          O.push([dx, dy]);
        }
      }
      O.sort((p, q) => p[0] * p[0] + p[1] * p[1] - (q[0] * q[0] + q[1] * q[1]) || p[1] - q[1] || p[0] - q[0]);
      _PixelWorld._OFF = O;
    }
    for (const [DX, DY] of _PixelWorld._OFF) {
      const QX = x + DX, QY = y - DY;
      if (QX < 0 || QX >= W_VALUE || QY < 0 || QY >= H_VALUE) {
        continue;
      }
      if (G[QY * W_VALUE + QX] === 0) {
        this.setCell(QY * W_VALUE + QX, id);
        return;
      }
    }
  }
  _jetMass(p) {
    return this.PU[p.id] * this.fluidScale * this.jetPush * (this.K[p.id] === 3 ? 0.25 : 1);
  }
  // 발사체 하나의 질량 환산 (밀도 기반, 반발력과 같은 환산). 기체는 맞았을 때 운동량 전달 효율이 낮아 x0.25
  _jetEntity(p) {
    for (const E of this.bodies) {
      if (E.sensor || E.dead || E === p.src && p.t < 8) {
        continue;
      }
      if (Math.abs(p.x - E.x) <= E.hx + 0.3 && Math.abs(p.y - E.y) <= E.hy + 0.3) {
        const M_VALUE = this._jetMass(p);
        E.impulse(p.vx * M_VALUE / E.mass, p.vy * M_VALUE / E.mass);
        return true;
      }
    }
    return false;
  }
  _jets() {
    const G = this.g, W_VALUE = this.w, H_VALUE = this.h, K = this.K, ST = this.ST, LIVE = [];
    for (const P_VALUE of this.proj) {
      const GAS = K[P_VALUE.id] === 3;
      P_VALUE.vy += GAS ? -0.03 : 0.1;
      if (GAS) {
        P_VALUE.vx *= 0.97;
        P_VALUE.vy *= 0.97;
      }
      P_VALUE.t++;
      const N_VALUE = Math.max(1, Math.ceil(Math.max(Math.abs(P_VALUE.vx), Math.abs(P_VALUE.vy))));
      let cx0 = Math.floor(P_VALUE.x), cy0 = Math.floor(P_VALUE.y), px = P_VALUE.ex, py = P_VALUE.ey, dead = false;
      for (let s = 0; s < N_VALUE; s++) {
        P_VALUE.x += P_VALUE.vx / N_VALUE;
        P_VALUE.y += P_VALUE.vy / N_VALUE;
        const CX = Math.floor(P_VALUE.x), CY = Math.floor(P_VALUE.y);
        if (CX === cx0 && CY === cy0) {
          continue;
        }
        cx0 = CX;
        cy0 = CY;
        if (CX < 0 || CX >= W_VALUE || CY >= H_VALUE) {
          dead = true;
          break;
        }
        if (CY < 0) {
          continue;
        }
        if (this._jetEntity(P_VALUE)) {
          this._drop(px, py, P_VALUE.id);
          dead = true;
          break;
        }
        const V = G[CY * W_VALUE + CX];
        if (V === 0) {
          px = CX;
          py = CY;
          continue;
        }
        if (V === this.ghostId && this.bridge) {
          const HB = this.bridge.bodies[this.gown[CY * W_VALUE + CX] - 1];
          if (HB) {
            const M_VALUE = this._jetMass(P_VALUE);
            this.bridge.applyImpulseAt(HB, CX + 0.5, CY + 0.5, P_VALUE.vx * M_VALUE, P_VALUE.vy * M_VALUE);
          }
          this._drop(px, py, P_VALUE.id);
          dead = true;
          break;
        }
        if (ST[V] || K[V] === 0) {
          this._drop(px, py, P_VALUE.id);
          dead = true;
          break;
        }
        const F_VALUE = K[V] === 2 ? 0.9 : K[V] === 1 ? 0.8 : 0.98;
        P_VALUE.vx *= F_VALUE;
        P_VALUE.vy *= F_VALUE;
        if (P_VALUE.vx * P_VALUE.vx + P_VALUE.vy * P_VALUE.vy < 0.36) {
          this._drop(px, py, P_VALUE.id);
          dead = true;
          break;
        }
      }
      if (!dead && GAS && P_VALUE.vx * P_VALUE.vx + P_VALUE.vy * P_VALUE.vy < 0.25) {
        this._drop(px, py, P_VALUE.id);
        dead = true;
      }
      P_VALUE.ex = px;
      P_VALUE.ey = py;
      if (!dead && P_VALUE.t > 300) {
        this._drop(px, py, P_VALUE.id);
        dead = true;
      }
      if (!dead) {
        LIVE.push(P_VALUE);
      }
    }
    this.proj = LIVE;
  }
  _wk(i) {
    const W_VALUE = this.w, X = i % W_VALUE, Y = (i - X) / W_VALUE, CX = X >> 4, CY = Y >> 4, C_VALUE = CY * this.cw + CX, A = this.awake, LX = X & 15, LY = Y & 15;
    A[C_VALUE] = 20;
    if (LX === 0) {
      if (CX > 0) {
        A[C_VALUE - 1] = 20;
      }
    } else if (LX === 15 && CX < this.cw - 1) {
      A[C_VALUE + 1] = 20;
    }
    if (LY === 0) {
      if (CY > 0) {
        A[C_VALUE - this.cw] = 20;
      }
    } else if (LY === 15 && CY < this.chh - 1) {
      A[C_VALUE + this.cw] = 20;
    }
    return C_VALUE;
  }
  _refreshReac(c) {
    const W_VALUE = this.w, X0 = c % this.cw << 4, Y0 = (c / this.cw | 0) << 4, X1 = Math.min(W_VALUE, X0 + 16), Y1 = Math.min(this.h, Y0 + 16);
    let r = 0;
    for (let y = Y0; y < Y1 && !r; y++) {
      for (let x = X0; x < X1; x++) {
        if (this.mats[this.g[y * W_VALUE + x]].act) {
          r = 1;
          break;
        }
      }
    }
    this.reac[c] = r;
  }
  setCell(i, id, l) {
    if (this.dirty) {
      this._compile();
    }
    const C_VALUE = this._wk(i);
    if (this.ST[this.g[i]] !== this.ST[id]) {
      this.chd[C_VALUE] = 1;
      if (!this.ST[id]) {
        this.supDirty = true;
      }
    }
    this.g[i] = id;
    this.life[i] = l ?? this._lf(id);
    this.u[i] = this.flag;
    if (this.mats[id].act) {
      this.reac[C_VALUE] = 1;
    }
  }
  set(x, y, mat) {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) {
      return;
    }
    this.setCell(y * this.w + x, typeof mat === "string" ? this.id[mat] : mat);
  }
  get(x, y) {
    return x < 0 || y < 0 || x >= this.w || y >= this.h ? -1 : this.g[y * this.w + x];
  }
  rect(x0, y0, x1, y1, mat) {
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        this.set(x, y, mat);
      }
    }
  }
  paint(cx, cy, r, mat, { sparse = 0 } = {}) {
    const ID = typeof mat === "string" ? this.id[mat] : mat;
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (dx * dx + dy * dy > r * r) {
          continue;
        }
        const X = cx + dx, Y = cy + dy;
        if (X < 0 || Y < 0 || X >= this.w || Y >= this.h || this.g[Y * this.w + X] !== 0 || this.rand() < sparse) {
          continue;
        }
        this.setCell(Y * this.w + X, ID);
      }
    }
  }
  carve(cx, cy, r) {
    let n = 0;
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (dx * dx + dy * dy > r * r) {
          continue;
        }
        const X = cx + dx, Y = cy + dy;
        if (X < 0 || Y < 0 || X >= this.w || Y >= this.h) {
          continue;
        }
        const I = Y * this.w + X, T = this.g[I];
        if (!T || this.mats[T].indestructible || this.K[T] > 1) {
          continue;
        }
        this.setCell(I, 0);
        n++;
      }
    }
    return n;
  }
  explode(cx, cy, r, { damage = 40, force = 2.5 } = {}) {
    const R2 = r * r, FIRE = this.id.fire;
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const D2 = dx * dx + dy * dy, X = cx + dx, Y = cy + dy;
        if (D2 > R2 || X < 0 || Y < 0 || X >= this.w || Y >= this.h) {
          continue;
        }
        const I = Y * this.w + X, T = this.g[I], RIM = D2 > R2 * 0.6;
        if (!T) {
          if (!RIM && FIRE != null && this.rand() < 0.08) {
            this.setCell(I, FIRE);
          }
          continue;
        }
        const M_VALUE = this.mats[T];
        if (M_VALUE.indestructible) {
          continue;
        }
        if (M_VALUE.kind === "solid" && RIM && this.rand() < 0.4) {
          continue;
        }
        const B_VALUE = M_VALUE.blast || {};
        if (B_VALUE.debris && this.rand() < (B_VALUE.debrisChance ?? 0.35)) {
          this.setCell(I, this.id[B_VALUE.debris]);
        } else if (B_VALUE.burn && this.rand() < (B_VALUE.burnChance ?? 0.4)) {
          this.setCell(I, this.id[B_VALUE.burn]);
        } else {
          this.setCell(I, 0);
        }
      }
    }
    const R = r * 1.5;
    this.emit("explosion", { x: cx, y: cy, r });
    for (const B_VALUE of this.bodies) {
      const PX = B_VALUE.x - cx, PY = B_VALUE.y - cy, D_VALUE = HYP(PX, PY) || 1;
      if (D_VALUE < R) {
        B_VALUE.impulse(PX / D_VALUE * force, PY / D_VALUE * force - 0.5);
        B_VALUE.hurt(damage * (1 - D_VALUE / R), "blast");
      }
    }
  }
  /* ---- 이벤트 / 강체 브릿지 ---- */
  on(t, f) {
    (this.ev[t] || (this.ev[t] = [])).push(f);
  }
  emit(t, e) {
    const L_VALUE = this.ev[t];
    if (L_VALUE) {
      for (const F_VALUE of L_VALUE) {
        F_VALUE(e);
      }
    }
  }
  _region(x, y, w, h) {
    if (![x, y, w, h].every(Number.isInteger) || w < 0 || h < 0 || x < 0 || y < 0 || x + w > this.w || y + h > this.h) {
      throw new RangeError("영역은 창 안의 정수 사각형이어야 합니다.");
    }
  }
  /**
   * 창 안 사각형(x,y,w,h)의 재료·수명을 새 Uint8Array로 읽습니다. 맵 데이터에 되쓸 때 씁니다.
   * 반환: {g, life} 각각 길이 w*h, 행 우선.
   */
  readRegion(x, y, w, h) {
    this._region(x, y, w, h);
    const G = new Uint8Array(w * h), LIFE = new Uint8Array(w * h);
    for (let r = 0; r < h; r++) {
      const SRC = (y + r) * this.w + x;
      G.set(this.g.subarray(SRC, SRC + w), r * w);
      LIFE.set(this.life.subarray(SRC, SRC + w), r * w);
    }
    return { g: G, life: LIFE };
  }
  /**
   * 창 안 사각형(x,y,w,h)을 맵 데이터로 덮어씁니다: cells는 길이 w*h인 재료 id 배열(행 우선, 0은 빈 셀)입니다.
   * life를 주지 않으면 재료의 수명 최솟값(없으면 0)을 씁니다. 월드 난수열을 쓰지 않아서 같은 데이터는 언제 써도 같은 결과입니다.
   * 덮은 청크와 이웃 청크는 깨우고 지형 충돌체를 다시 만들며 붕괴 검사를 요청합니다. 잘못된 재료 id는 RangeError입니다.
   */
  writeRegion(x, y, w, h, cells, life = null) {
    this._region(x, y, w, h);
    if (!(cells instanceof Uint8Array) || cells.length !== w * h || life && life.length !== w * h) {
      throw new RangeError("cells와 life는 길이 w*h인 Uint8Array여야 합니다.");
    }
    if (this.dirty) {
      this._compile();
    }
    for (let i = 0; i < cells.length; i++) {
      if (cells[i] >= this.mats.length) {
        throw new RangeError(`정의되지 않은 재료 id ${cells[i]}입니다.`);
      }
    }
    for (let r = 0; r < h; r++) {
      const DST = (y + r) * this.w + x;
      for (let c = 0; c < w; c++) {
        const ID = cells[r * w + c];
        this.g[DST + c] = ID;
        this.life[DST + c] = life ? life[r * w + c] : this.mats[ID].life?.[0] ?? 0;
      }
      this.u.fill(this.flag, DST, DST + w);
    }
    this._touch(x, y, x + w, y + h);
  }
  _touch(x0, y0, x1, y1) {
    if (x0 >= x1 || y0 >= y1) {
      return;
    }
    const CX0 = Math.max(0, (x0 >> 4) - 1), CX1 = Math.min(this.cw - 1, x1 - 1 >> 4) + 1, CY0 = Math.max(0, (y0 >> 4) - 1), CY1 = Math.min(this.chh - 1, y1 - 1 >> 4) + 1;
    for (let cy = CY0; cy <= Math.min(this.chh - 1, CY1); cy++) {
      for (let cx = CX0; cx <= Math.min(this.cw - 1, CX1); cx++) {
        const C_VALUE = cy * this.cw + cx;
        this.awake[C_VALUE] = 20;
        this.chd[C_VALUE] = 1;
        this._refreshReac(C_VALUE);
      }
    }
    this.supDirty = true;
  }
  /**
   * scrollTo가 쓰는 미리 불러오기 설정입니다(시뮬레이션 상태가 아니라 설정이라 snapshot에 들어가지 않습니다. 모든 참가자가 같게 두세요).
   * margin: 초점이 창 가장자리에서 이만큼(셀) 안쪽을 벗어나면 창을 옮깁니다. 곧 "미리 불러둘 거리"이며, 카메라 시야의 반 크기보다 크게 잡아야
   *   시야가 항상 불러온 영역 안에 있습니다. 기본은 짧은 변의 1/4.
   * step: 한 번에 옮기는 단위(셀, 16의 배수). 클수록 드물게 크게 불러오고 작을수록 자주 조금씩 불러옵니다. 기본은 16 이상 32 이하의 가능한 최대값.
   * 조건: step <= min(w,h) - 2*margin (옮긴 뒤 초점이 다시 여유 구간 안에 들어와야 합니다). 청크 크기 16은 sleep 단위라 고정입니다.
   */
  setStreaming({ margin, step } = {}) {
    const SIDE = Math.min(this.w, this.h), MARGIN = margin ?? SIDE >> 2, STEP = step ?? Math.max(16, Math.min(32, SIDE - 2 * MARGIN & ~15));
    if (!Number.isInteger(MARGIN) || MARGIN < 0 || !Number.isInteger(STEP) || STEP < 16 || STEP % 16) {
      throw new RangeError("margin은 0 이상 정수, step은 16 이상의 16의 배수여야 합니다.");
    }
    if (STEP > SIDE - 2 * MARGIN) {
      throw new RangeError(`step(${STEP}) <= min(w,h) - 2*margin(${SIDE - 2 * MARGIN})이어야 합니다.`);
    }
    this.stream = { margin: MARGIN, step: STEP };
  }
  /**
   * 초점(절대 좌표 focusX, focusY — 카메라 중심이나 플레이어)이 창의 여유 구간(margin 안쪽)을 벗어났을 때만 창을 옮깁니다.
   * 옮길 때는 초점이 창 가운데 근처로 오도록 step의 배수만큼 옮기며, 같은 초점 열이면 같은 이동을 하는 결정적 함수입니다.
   * 반환은 shiftWindow의 결과이고, 옮기지 않았으면 null입니다. 틱 사이에 매 프레임 불러도 됩니다.
   */
  scrollTo(focusX, focusY, hooks = {}) {
    const { margin: M, step: S } = this.stream, AXIS = (focus, origin, size) => {
      const POS = focus - origin;
      if (POS >= M && POS < size - M) {
        return 0;
      }
      const D = Math.round((POS - size / 2) / S) * S;
      return D || (POS < size / 2 ? -S : S);
    }, DX = AXIS(focusX, this.originX, this.w), DY = AXIS(focusY, this.originY, this.h);
    return DX || DY ? this.shiftWindow(DX, DY, hooks) : null;
  }
  _edges(dx, dy, leaving) {
    const { w: W, h: H } = this, OUT = [];
    const TOP = leaving ? dy > 0 : dy < 0, LEFT = leaving ? dx > 0 : dx < 0, AY = Math.min(H, Math.abs(dy)), AX = Math.min(W, Math.abs(dx));
    let ya = 0, yb = H;
    if (dy) {
      OUT.push({ x0: 0, y0: TOP ? 0 : H - AY, x1: W, y1: TOP ? AY : H });
      ya = TOP ? AY : 0;
      yb = TOP ? H : H - AY;
    }
    if (dx && ya < yb) {
      OUT.push({ x0: LEFT ? 0 : W - AX, y0: ya, x1: LEFT ? AX : W, y1: yb });
    }
    return OUT;
  }
  /**
   * 창(이 격자)을 큰 세계에서 (dx,dy)칸 움직입니다. 열린 월드·무한 스크롤용이며 틱 사이에만 호출하세요.
   * dx,dy는 16의 배수 정수(청크 단위)이고 둘 다 0일 수 없습니다. 창 좌표 (x,y)의 셀은 (x-dx, y-dy)로 옮겨지고
   * originX += dx, originY += dy가 됩니다(절대 좌표 = origin + 창 좌표).
   * 옮기는 것: 셀(g/life/u), 청크 플래그(awake/reac/chd/chunkTick), 발사체, 엔티티, 강체(위치·핀·고정 조인트·정적 충돌체).
   * 창 밖으로 나간 셀·발사체는 사라지고, 엔티티·강체는 지우지 않은 채 돌려줍니다(게임이 처리).
   * @param {{evict?: Function, load?: Function}} hooks evict(rect): 밀려나기 직전 호출(옛 origin 기준, 셀이 아직 있음 →
   *   readRegion으로 읽어 맵 데이터에 되쓰기). load(rect): 새로 드러난 영역마다 호출(새 origin 기준 → writeRegion이나 set으로 채우기).
   *   rect = {world, x0, y0, x1, y1, originX, originY}. 호출하지 않은 영역은 빈 셀입니다.
   * @returns {{originX:number, originY:number, entities:Body[], bodies:object[], projectiles:number}}
   */
  shiftWindow(dx, dy, { load, evict } = {}) {
    if (!Number.isInteger(dx) || !Number.isInteger(dy) || dx % 16 || dy % 16 || !dx && !dy) {
      throw new RangeError("dx, dy는 16의 배수 정수이고 둘 다 0일 수 없습니다.");
    }
    if (load && typeof load !== "function" || evict && typeof evict !== "function") {
      throw new TypeError("load와 evict는 함수여야 합니다.");
    }
    if (this.dirty) {
      this._compile();
    }
    const { w: W, h: H, cw: CW, chh: CH } = this, RECT = (e) => ({ world: this, ...e, originX: this.originX, originY: this.originY });
    if (evict) {
      for (const E of this._edges(dx, dy, true)) {
        evict(RECT(E));
      }
    }
    shiftPlane(this.g, W, H, dx, dy, 0);
    shiftPlane(this.life, W, H, dx, dy, 0);
    shiftPlane(this.u, W, H, dx, dy, 0);
    shiftPlane(this.awake, CW, CH, dx / 16, dy / 16, 20);
    shiftPlane(this.reac, CW, CH, dx / 16, dy / 16, 1);
    shiftPlane(this.chd, CW, CH, dx / 16, dy / 16, 1);
    shiftPlane(this.chunkTick, CW, CH, dx / 16, dy / 16, this.time);
    this.originX += dx;
    this.originY += dy;
    const OUT = { originX: this.originX, originY: this.originY, entities: [], bodies: [], projectiles: 0 }, INSIDE = (o) => o.x >= 0 && o.x < W && o.y >= 0 && o.y < H;
    for (const E of this.bodies) {
      E.x -= dx;
      E.y -= dy;
      E.px -= dx;
      E.py -= dy;
      if (!INSIDE(E)) {
        OUT.entities.push(E);
      }
    }
    const BEFORE = this.proj.length;
    for (const P of this.proj) {
      P.x -= dx;
      P.y -= dy;
      P.ex -= dx;
      P.ey -= dy;
    }
    this.proj = this.proj.filter((jet) => Math.floor(jet.x) >= 0 && Math.floor(jet.x) < W && Math.floor(jet.y) < H);
    OUT.projectiles = BEFORE - this.proj.length;
    if (this.bridge) {
      this.bridge.shift(dx, dy, (id) => {
        const CX = id % CW - dx / 16, CY = (id / CW | 0) - dy / 16;
        return CX < 0 || CX >= CW || CY < 0 || CY >= CH ? -1 : CY * CW + CX;
      });
      for (const H_VALUE of this.bridge.bodies) {
        if (H_VALUE._sm) {
          H_VALUE._sm.x -= dx;
          H_VALUE._sm.y -= dy;
        }
        if (!INSIDE(H_VALUE)) {
          OUT.bodies.push(H_VALUE);
        }
      }
    }
    this.supDirty = true;
    const ENTERING = this._edges(dx, dy, false);
    for (const E of ENTERING) {
      this._touch(E.x0, E.y0, E.x1, E.y1);
    }
    if (load) {
      for (const E of ENTERING) {
        load(RECT(E));
      }
    }
    this.emit("shift", { dx, dy, originX: this.originX, originY: this.originY });
    return OUT;
  }
  markAllDirty() {
    this.chd.fill(1);
    this.awake.fill(20);
    this.reac.fill(1);
  }
  attachBridge(bValue) {
    this.bridge = bValue;
    this.markAllDirty();
    if (this.ghostId == null) {
      this.ghostId = this.define({
        name: "__ghost",
        kind: "solid",
        color: [0, 0, 0],
        indestructible: true,
        body: { blocks: false }
      });
    }
    this.on("explosion", (e) => {
      const R = e.r * 1.5;
      for (const H_VALUE of bValue.bodies) {
        const DX = H_VALUE.x - e.x, DY = H_VALUE.y - e.y, D_VALUE = HYP(DX, DY) || 1;
        if (D_VALUE < R) {
          const DV = 3 * (1 - D_VALUE / R) * H_VALUE.mass;
          bValue.applyImpulse(H_VALUE, DX / D_VALUE * DV, DY / D_VALUE * DV - 0.3 * H_VALUE.mass);
        }
      }
    });
  }
  _chunkShapes(cx, cy) {
    const { w: W_VALUE, h: H_VALUE, g: G, ST } = this, X0 = cx * 16, Y0 = cy * 16, X1 = Math.min(W_VALUE, X0 + 16), Y1 = Math.min(H_VALUE, Y0 + 16), OUT = [];
    let open = /* @__PURE__ */ new Map();
    for (let y = Y0; y < Y1; y++) {
      const NEXT = /* @__PURE__ */ new Map();
      let x = X0;
      while (x < X1) {
        const T = G[y * W_VALUE + x];
        if (!ST[T]) {
          x++;
          continue;
        }
        let e = x;
        while (e < X1 && G[y * W_VALUE + e] === T) {
          e++;
        }
        const K_VALUE = x + "," + e + "," + T, O = open.get(K_VALUE);
        if (O) {
          O.y1 = y + 1;
          NEXT.set(K_VALUE, O);
        } else {
          const N_VALUE = { x0: x, x1: e, y0: y, y1: y + 1, m: T };
          NEXT.set(K_VALUE, N_VALUE);
          OUT.push(N_VALUE);
        }
        x = e;
      }
      open = NEXT;
    }
    return OUT.map((r) => ({
      mat: r.m,
      verts: [
        { x: r.x0, y: r.y0 },
        { x: r.x1, y: r.y0 },
        { x: r.x1, y: r.y1 },
        { x: r.x0, y: r.y1 }
      ]
    }));
  }
  _fluid(h) {
    const Q = h.sub;
    h.dbg = 0;
    if (!Q || !Q.n) {
      return;
    }
    const B = this.bridge, F_VALUE = Q.rho * this.fluidScale * B.gravityScale, FR = Q.n / (h.area || h.w * h.h);
    h.dbg = F_VALUE;
    B.applyForce(h, Q.sx / Q.n, Q.sy / Q.n, 0, -F_VALUE);
    B.damp(h, 1 - 0.08 * FR, 1 - 0.15 * FR);
  }
  chip(cx, cy, r, energy) {
    let n = 0;
    cx = Math.round(cx);
    cy = Math.round(cy);
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const D_VALUE = HYP(dx, dy);
        if (D_VALUE > r) {
          continue;
        }
        const X = cx + dx, Y = cy + dy;
        if (X < 0 || Y < 0 || X >= this.w || Y >= this.h) {
          continue;
        }
        const I = Y * this.w + X, T = this.g[I];
        if (!T || !this.ST[T]) {
          continue;
        }
        const M_VALUE = this.mats[T];
        if (M_VALUE.strength == null) {
          continue;
        }
        if (energy * (1 - D_VALUE / (r + 1)) > M_VALUE.strength) {
          const DB = M_VALUE.blast && M_VALUE.blast.debris;
          this.setCell(I, DB && this.rand() < (M_VALUE.blast.debrisChance ?? 0.35) ? this.id[DB] : 0);
          n++;
        }
      }
    }
    return n;
  }
  _impact(im) {
    if (im.entity) {
      this._entityImpact(im);
      return;
    }
    const E = im.impulse * this.impactScale;
    if (E < 10) {
      return;
    }
    const R_VALUE = Math.min(6, 1 + Math.floor(Math.sqrt(E) / 3)), N_VALUE = this.chip(im.x, im.y, R_VALUE, E);
    if (N_VALUE) {
      this.bridge.damp(im.body, 1 - Math.min(0.6, N_VALUE * 0.03), 1);
      this.emit("chip", { x: im.x, y: im.y, removed: N_VALUE, energy: E, body: im.body });
    }
    const D_VALUE = im.body.data;
    if (D_VALUE.strength != null && E > D_VALUE.strength && this.time - (D_VALUE.born ?? -99) >= 6 && this.bridge.bodies.includes(im.body)) {
      this.fracture(im.body, im, E);
    }
  }
  // 강도를 넘으면 강체 조각으로 쪼개짐 (너무 작으면 픽셀로 환원)
  _entityImpact(im) {
    const E = im.entity;
    if (E.dead || this.time - (im.body.data.born ?? -99) < 10) {
      return;
    }
    const DX = E.x - im.body.x, DY = E.y - im.body.y, DD = HYP(DX, DY) || 1, EN = im.body.mass * Math.max(0, (im.rvx * DX + im.rvy * DY) / DD) * this.impactScale;
    if (EN > 8 && this.time >= (E.data.rock || 0)) {
      E.data.rock = this.time + 20;
      const K_VALUE = im.body.mass / (im.body.mass + E.mass);
      E.hurt(EN * 0.4);
      E.impulse(im.rvx * K_VALUE, im.rvy * K_VALUE);
      this.emit("hit", { entity: E, rigid: im.body, energy: EN });
    }
  }
  _rowsOf(b) {
    const B = this.bridge, P = B.getPolys(b), BD = B.getBounds(b), { w: W_VALUE, h: H_VALUE } = this, MK = this._mk, ID = ++this._mkId, ROWS = [];
    const Y0 = Math.max(0, Math.floor(BD.y0)), Y1 = Math.min(H_VALUE - 1, Math.floor(BD.y1)), X0 = Math.max(0, Math.floor(BD.x0)), X1 = Math.min(W_VALUE - 1, Math.floor(BD.x1));
    for (const V of P) {
      let a = 1e9, c = -1e9, d = 1e9, e = -1e9;
      for (const P_VALUE of V) {
        if (P_VALUE.x < a) {
          a = P_VALUE.x;
        }
        if (P_VALUE.x > c) {
          c = P_VALUE.x;
        }
        if (P_VALUE.y < d) {
          d = P_VALUE.y;
        }
        if (P_VALUE.y > e) {
          e = P_VALUE.y;
        }
      }
      const YA = Math.max(Y0, Math.floor(d)), YB = Math.min(Y1, Math.floor(e)), XA = Math.max(X0, Math.floor(a)), XB = Math.min(X1, Math.floor(c));
      for (let y = YA; y <= YB; y++) {
        for (let x = XA; x <= XB; x++) {
          if (MK[y * W_VALUE + x] !== ID && inPoly(V, x + 0.5, y + 0.5)) {
            MK[y * W_VALUE + x] = ID;
          }
        }
      }
    }
    for (let y = Y0; y <= Y1; y++) {
      let xa = -1;
      for (let x = X0; x <= X1 + 1; x++) {
        const ON = x <= X1 && MK[y * W_VALUE + x] === ID;
        if (ON) {
          if (xa < 0) {
            xa = x;
          }
        } else if (xa >= 0) {
          ROWS.push({ y, xa, xb: x - 1 });
          xa = -1;
        }
      }
    }
    return ROWS;
  }
  /* ---- 셀 집합 <-> 강체 (지형 붕괴, 파편화, 굳히기의 공통 기반) ----
   * 마스크 강체 = 같은 재료 직사각형들을 부품으로 가진 복합체. h.cells = [{x,y,t}] 는 격자 좌표, (h.ox,h.oy) = 무게중심의 격자 좌표.
   * 셀 중심의 무게중심 기준 좌표 = (x+.5-h.ox, y+.5-h.oy) 를 h.angle만큼 회전해 h.x,h.y에 더하면 월드 좌표 */
  _rects(cells) {
    let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
    for (const C_VALUE of cells) {
      if (C_VALUE.x < x0) {
        x0 = C_VALUE.x;
      }
      if (C_VALUE.x > x1) {
        x1 = C_VALUE.x;
      }
      if (C_VALUE.y < y0) {
        y0 = C_VALUE.y;
      }
      if (C_VALUE.y > y1) {
        y1 = C_VALUE.y;
      }
    }
    const W = x1 - x0 + 1, H = y1 - y0 + 1, A = new Uint8Array(W * H), OUT = [];
    for (const C_VALUE of cells) {
      A[(C_VALUE.y - y0) * W + C_VALUE.x - x0] = C_VALUE.t;
    }
    let open = /* @__PURE__ */ new Map();
    for (let y = 0; y < H; y++) {
      const NEXT = /* @__PURE__ */ new Map();
      let x = 0;
      while (x < W) {
        const T = A[y * W + x];
        if (!T) {
          x++;
          continue;
        }
        let e = x;
        while (e < W && A[y * W + e] === T) {
          e++;
        }
        const K_VALUE = x + "," + e + "," + T, O = open.get(K_VALUE);
        if (O) {
          O.h++;
          NEXT.set(K_VALUE, O);
        } else {
          const N_VALUE = { x: x0 + x, y: y0 + y, w: e - x, h: 1, t: T };
          NEXT.set(K_VALUE, N_VALUE);
          OUT.push(N_VALUE);
        }
        x = e;
      }
      open = NEXT;
    }
    return OUT.map((r) => {
      const M_VALUE = this.mats[r.t].rigid || {};
      return { x: r.x, y: r.y, w: r.w, h: r.h, density: M_VALUE.density ?? 4e-3 };
    });
  }
  _strengthOf(cells) {
    let n = 0, sum = 0;
    for (const C_VALUE of cells) {
      const ST_VALUE = this.mats[C_VALUE.t].strength;
      if (ST_VALUE != null) {
        sum += ST_VALUE;
        n++;
      }
    }
    return n * 2 > cells.length ? sum / n : null;
  }
  // 절반 넘는 셀이 강도가 있을 때만 평균 (철 같은 건 안 깨짐)
  spawnCells(cells, { x = 0, y = 0, angle = 0, vx = 0, vy = 0, av = 0, data = {} } = {}) {
    if (this.dirty) {
      this._compile();
    }
    const D_VALUE = { born: this.time, chunk: true, ...data };
    if (D_VALUE.strength === void 0) {
      const ST_VALUE = this._strengthOf(cells);
      if (ST_VALUE != null) {
        D_VALUE.strength = ST_VALUE;
      }
    }
    const H_VALUE = this.bridge.addBody({
      kind: "compound",
      parts: this._rects(cells),
      x,
      y,
      angle,
      vx,
      vy,
      av,
      data: D_VALUE
    });
    H_VALUE.cells = cells;
    return H_VALUE;
  }
  cellsOf(h) {
    if (h.cells) {
      return { cells: h.cells, ox: h.ox, oy: h.oy };
    }
    const T = this.id[h.data.mat];
    if (!T) {
      return null;
    }
    const P = this.bridge.getPolys(h), C_VALUE = Math.cos(h.angle), S_VALUE = Math.sin(h.angle);
    const L = P.map(
      (v) => v.map((p) => {
        const DX = p.x - h.x, DY = p.y - h.y;
        return { x: DX * C_VALUE + DY * S_VALUE, y: -DX * S_VALUE + DY * C_VALUE };
      })
    );
    let a = 1e9, b = 1e9, e = -1e9, f = -1e9;
    for (const V of L) {
      for (const P_VALUE of V) {
        if (P_VALUE.x < a) {
          a = P_VALUE.x;
        }
        if (P_VALUE.x > e) {
          e = P_VALUE.x;
        }
        if (P_VALUE.y < b) {
          b = P_VALUE.y;
        }
        if (P_VALUE.y > f) {
          f = P_VALUE.y;
        }
      }
    }
    const GX0 = Math.floor(a), GY0 = Math.floor(b), CELLS = [];
    for (let gy = 0; gy <= Math.ceil(f) - GY0; gy++) {
      for (let gx = 0; gx <= Math.ceil(e) - GX0; gx++) {
        const PX = gx + GX0 + 0.5, PY = gy + GY0 + 0.5;
        if (L.some((v) => inPoly(v, PX, PY))) {
          CELLS.push({ x: gx, y: gy, t: T });
        }
      }
    }
    return CELLS.length ? { cells: CELLS, ox: -GX0, oy: -GY0 } : null;
  }
  _cellWorld(h, src, c) {
    const CO = Math.cos(h.angle), SI = Math.sin(h.angle), LX = c.x + 0.5 - src.ox, LY = c.y + 0.5 - src.oy;
    return [h.x + LX * CO - LY * SI, h.y + LX * SI + LY * CO];
  }
  fracture(h, im, e) {
    const F = this.frag, B = this.bridge, SRC = this.cellsOf(h);
    if (!SRC || SRC.cells.length < F.minCells * 2 || B.bodies.length >= F.maxBodies || (h.data.gen | 0) >= F.maxGen) {
      this.shatter(h);
      return;
    }
    const { cells: CELLS } = SRC, N_VALUE = CELLS.length, D_VALUE = h.data, CO = Math.cos(h.angle), SI = Math.sin(h.angle), PX = im.x - h.x, PY = im.y - h.y, LX = PX * CO + PY * SI + SRC.ox - 0.5, LY = -PX * SI + PY * CO + SRC.oy - 0.5;
    const K_VALUE = Math.max(
      2,
      Math.min(F.maxPieces, 2 + Math.floor(e / D_VALUE.strength - 1), N_VALUE / (F.minCells * 2) | 0)
    );
    const SEEDS = [];
    let bi = 0, bd = 1e9;
    CELLS.forEach((c, i) => {
      const DD = (c.x - LX) * (c.x - LX) + (c.y - LY) * (c.y - LY);
      if (DD < bd) {
        bd = DD;
        bi = i;
      }
    });
    SEEDS.push(CELLS[bi]);
    while (SEEDS.length < K_VALUE) {
      let best = null, bs = -1;
      for (let t = 0; t < 3; t++) {
        const C_VALUE = CELLS[this.rnd(N_VALUE)];
        let m = 1e9;
        for (const Q of SEEDS) {
          m = Math.min(m, (C_VALUE.x - Q.x) * (C_VALUE.x - Q.x) + (C_VALUE.y - Q.y) * (C_VALUE.y - Q.y));
        }
        if (m > bs) {
          bs = m;
          best = C_VALUE;
        }
      }
      SEEDS.push(best);
    }
    const LAB = new Int16Array(N_VALUE);
    CELLS.forEach((c, i) => {
      let bl = 0, bv = 1e9;
      SEEDS.forEach((q, j) => {
        const DD = HYP(c.x - q.x, c.y - q.y) + this.rand() * F.jitter;
        if (DD < bv) {
          bv = DD;
          bl = j;
        }
      });
      LAB[i] = bl;
    });
    const IDX = /* @__PURE__ */ new Map();
    CELLS.forEach((c, i) => IDX.set(c.y * 65536 + c.x, i));
    const SEEN = new Uint8Array(N_VALUE), COMPS = [];
    for (let i = 0; i < N_VALUE; i++) {
      if (SEEN[i]) {
        continue;
      }
      const COMP = [], ST_VALUE = [i];
      SEEN[i] = 1;
      while (ST_VALUE.length) {
        const J = ST_VALUE.pop();
        COMP.push(CELLS[J]);
        const C_VALUE = CELLS[J];
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const Q = IDX.get((C_VALUE.y + dy) * 65536 + C_VALUE.x + dx);
            if (Q !== void 0 && !SEEN[Q] && LAB[Q] === LAB[J]) {
              SEEN[Q] = 1;
              ST_VALUE.push(Q);
            }
          }
        }
      }
      COMPS.push(COMP);
    }
    const GX = h.x - (SRC.ox * CO - SRC.oy * SI), GY = h.y - (SRC.ox * SI + SRC.oy * CO), PIECES = [];
    for (const COMP of COMPS) {
      if (COMP.length < F.minCells) {
        for (const C_VALUE of COMP) {
          const DB = this.mats[C_VALUE.t].blast && this.mats[C_VALUE.t].blast.debris || D_VALUE.debris;
          if (!DB) {
            continue;
          }
          const [WX, WY] = this._cellWorld(h, SRC, C_VALUE), XI = Math.floor(WX), YI = Math.floor(WY);
          if (XI >= 0 && YI >= 0 && XI < this.w && YI < this.h) {
            const I = YI * this.w + XI;
            if (this.g[I] === 0 || this.K[this.g[I]] > 0) {
              this.setCell(I, this.id[DB]);
            }
          }
        }
        continue;
      }
      const ST_VALUE = D_VALUE.strength != null ? D_VALUE.strength * F.hardening : this._strengthOf(COMP), P_VALUE = this.spawnCells(COMP, {
        x: GX,
        y: GY,
        angle: h.angle,
        data: {
          strength: ST_VALUE ?? void 0,
          gen: (D_VALUE.gen | 0) + 1,
          debris: D_VALUE.debris,
          mat: void 0
        }
      });
      const RX = P_VALUE.x - h.x, RY = P_VALUE.y - h.y, IX = P_VALUE.x - im.x, IY = P_VALUE.y - im.y, ID = HYP(IX, IY) || 1;
      B.setVelocity(
        P_VALUE,
        h.vx - (h.av || 0) * RY + IX / ID * F.kick,
        h.vy + (h.av || 0) * RX + IY / ID * F.kick
      );
      B.setAngularVelocity(P_VALUE, h.av || 0);
      PIECES.push(P_VALUE);
    }
    B.removeBody(h);
    this.emit("fracture", { x: h.x, y: h.y, body: h, pieces: PIECES, energy: e });
  }
  /* ---- 지형 붕괴: 앵커(바닥·가장자리·indestructible 재료)와 8방향으로 이어지지 않은 고체 덩어리는 강체가 되어 떨어짐 ---- */
  enableCollapse(o = {}) {
    this.collapse = {
      minCells: 4,
      maxCells: 1500,
      interval: 4,
      bake: true,
      restTicks: 40,
      minBake: 0.7,
      anchorTop: false,
      ...o
    };
    this.supDirty = true;
  }
  _flood() {
    const { w: W_VALUE, h: H_VALUE, g: G, ST, AN } = this, N_VALUE = W_VALUE * H_VALUE;
    let sValue = this._sup;
    if (!sValue || sValue.length !== N_VALUE) {
      sValue = this._sup = new Uint8Array(N_VALUE);
      this._stk = new Int32Array(N_VALUE);
    } else {
      sValue.fill(0);
    }
    const STK = this._stk;
    let sp = 0;
    const SEED = (i) => {
      if (!sValue[i] && ST[G[i]]) {
        sValue[i] = 1;
        STK[sp++] = i;
      }
    };
    for (let i = 0; i < N_VALUE; i++) {
      if (AN[G[i]]) {
        SEED(i);
      }
    }
    for (let x = 0; x < W_VALUE; x++) {
      SEED((H_VALUE - 1) * W_VALUE + x);
      if (this.collapse?.anchorTop) {
        SEED(x);
      }
    }
    for (let y = 0; y < H_VALUE; y++) {
      SEED(y * W_VALUE);
      SEED(y * W_VALUE + W_VALUE - 1);
    }
    while (sp) {
      const I = STK[--sp], X = I % W_VALUE, Y = I / W_VALUE | 0;
      for (let dy = -1; dy <= 1; dy++) {
        const NY = Y + dy;
        if (NY < 0 || NY >= H_VALUE) {
          continue;
        }
        for (let dx = -1; dx <= 1; dx++) {
          const NX = X + dx;
          if (NX < 0 || NX >= W_VALUE || !dx && !dy) {
            continue;
          }
          SEED(NY * W_VALUE + NX);
        }
      }
    }
    return sValue;
  }
  _support() {
    const C = this.collapse;
    if (!C || !this.supDirty || this.time - this._supT < C.interval) {
      return;
    }
    this.supDirty = false;
    this._supT = this.time;
    const S = this._flood(), { w: W_VALUE, h: H_VALUE, g: G, ST } = this, N_VALUE = W_VALUE * H_VALUE;
    if (!this._sk) {
      this._sk = new Int32Array(N_VALUE);
    }
    const SK = this._sk, ID = ++this._skId, STK = new Int32Array(N_VALUE);
    for (let s0 = 0; s0 < N_VALUE; s0++) {
      if (!ST[G[s0]] || S[s0] || SK[s0] === ID) {
        continue;
      }
      const COMP = [];
      let sp = 0;
      STK[sp++] = s0;
      SK[s0] = ID;
      while (sp) {
        const I = STK[--sp];
        COMP.push(I);
        const X = I % W_VALUE, Y = I / W_VALUE | 0;
        for (let dy = -1; dy <= 1; dy++) {
          const NY = Y + dy;
          if (NY < 0 || NY >= H_VALUE) {
            continue;
          }
          for (let dx = -1; dx <= 1; dx++) {
            const NX = X + dx;
            if (NX < 0 || NX >= W_VALUE) {
              continue;
            }
            const Q = NY * W_VALUE + NX;
            if (SK[Q] !== ID && ST[G[Q]] && !S[Q]) {
              SK[Q] = ID;
              STK[sp++] = Q;
            }
          }
        }
      }
      if (COMP.length > C.maxCells) {
        continue;
      }
      if (COMP.length < C.minCells) {
        for (const I of COMP) {
          const DB = this.mats[G[I]].blast && this.mats[G[I]].blast.debris;
          if (DB) {
            this.setCell(I, this.id[DB]);
          }
        }
        continue;
      }
      COMP.sort((a, b) => a - b);
      const CELLS = COMP.map((i) => ({ x: i % W_VALUE, y: i / W_VALUE | 0, t: G[i] }));
      for (const I of COMP) {
        this.setCell(I, 0);
      }
      const HH = this.spawnCells(CELLS);
      this.emit("collapse", { body: HH, cells: CELLS.length, x: HH.x, y: HH.y });
    }
  }
  _bake(h) {
    const { w: W_VALUE, h: H, g: G } = this, B = this.bridge, MAP = /* @__PURE__ */ new Map();
    for (const C_VALUE of h.cells) {
      MAP.set(C_VALUE.y * 65536 + C_VALUE.x, C_VALUE.t);
    }
    const ROWS = this._rowsOf(h), CO = Math.cos(h.angle), SI = Math.sin(h.angle), TGT = [];
    for (const R_VALUE of ROWS) {
      for (let x = R_VALUE.xa; x <= R_VALUE.xb; x++) {
        const PX = x + 0.5 - h.x, PY = R_VALUE.y + 0.5 - h.y, T = MAP.get(Math.floor(-PX * SI + PY * CO + h.oy) * 65536 + Math.floor(PX * CO + PY * SI + h.ox));
        if (T) {
          TGT.push({ x, y: R_VALUE.y, t: T });
        }
      }
    }
    if (!TGT.length) {
      B.removeBody(h);
      return true;
    }
    for (const DY of [0, 1, -1]) {
      const USE = [], SAVED = [];
      for (const Q of TGT) {
        const Y = Q.y + DY;
        if (Y < 0 || Y >= H) {
          continue;
        }
        const I = Y * W_VALUE + Q.x;
        if (this.ST[G[I]]) {
          continue;
        }
        USE.push({ i: I, t: Q.t });
        SAVED.push([I, G[I], this.life[I]]);
      }
      if (!USE.length) {
        continue;
      }
      for (const Q of USE) {
        if (G[Q.i] && this.K[G[Q.i]] > 0) {
          this._eject(Q.i, Q.i % W_VALUE, Q.i / W_VALUE | 0);
        }
        this.setCell(Q.i, Q.t);
      }
      const S = this._flood();
      let ok = 0;
      for (const Q of USE) {
        if (S[Q.i]) {
          ok++;
        }
      }
      if (ok >= USE.length * this.collapse.minBake) {
        B.removeBody(h);
        this.supDirty = true;
        this.emit("bake", { x: h.x, y: h.y, cells: USE.length });
        return true;
      }
      for (let k = SAVED.length - 1; k >= 0; k--) {
        this.setCell(SAVED[k][0], SAVED[k][1], SAVED[k][2]);
      }
    }
    return false;
  }
  _settle() {
    const C = this.collapse;
    if (!C || !C.bake) {
      return;
    }
    for (const H_VALUE of this.bridge.bodies.slice()) {
      if (!H_VALUE.cells || H_VALUE.data.noBake) {
        continue;
      }
      const D_VALUE = H_VALUE.data;
      if (this.time - (D_VALUE.born ?? 0) < 20) {
        continue;
      }
      if (HYP(H_VALUE.vx, H_VALUE.vy) < 0.04 && Math.abs(H_VALUE.av || 0) < 4e-3) {
        D_VALUE.rest = (D_VALUE.rest | 0) + 1;
      } else {
        D_VALUE.rest = 0;
      }
      if (D_VALUE.rest >= C.restTicks && !this._bake(H_VALUE)) {
        D_VALUE.bakeFail = (D_VALUE.bakeFail | 0) + 1;
        D_VALUE.rest = -30;
        if (D_VALUE.bakeFail >= 3) {
          D_VALUE.noBake = true;
        }
      }
    }
  }
  shatter(h) {
    const DB = this.id[h.data.debris || "sand"];
    for (const R_VALUE of this._rowsOf(h)) {
      for (let x = R_VALUE.xa; x <= R_VALUE.xb; x++) {
        const I = R_VALUE.y * this.w + x, T = this.g[I];
        if ((T === 0 || this.K[T] > 0) && this.rand() < 0.7) {
          this.setCell(I, DB);
        }
      }
    }
    this.bridge.removeBody(h);
    this.emit("shatter", { x: h.x, y: h.y, body: h });
  }
  addEntity(body) {
    if (body.eid !== void 0) {
      throw new Error("이미 등록된 엔티티입니다.");
    }
    body.eid = this.eseq++;
    this.bodies.push(body);
    return body;
  }
  /* ---- 스냅샷 / 해시 (롤백, 리플레이, 락스텝 디싱크 검출) ---- */
  snapshot(copyGrid = true) {
    const GRID = copyGrid ? (array) => array.slice() : (array) => array;
    const S_VALUE = {
      g: GRID(this.g),
      life: GRID(this.life),
      u: GRID(this.u),
      awake: GRID(this.awake),
      reac: GRID(this.reac),
      flag: this.flag,
      dir: this.dir,
      seed: this.seed,
      time: this.time,
      originX: this.originX,
      originY: this.originY,
      pseq: this.pseq,
      eseq: this.eseq,
      supDirty: this.supDirty,
      supT: this._supT,
      proj: this.proj.map((p) => ({ ...p })),
      entRefs: this.bodies.slice(),
      ents: this.bodies.map((b) => b.save())
    };
    if (this.bridge) {
      S_VALUE.bridge = this.bridge.snapshot();
    }
    return S_VALUE;
  }
  restore(s) {
    this.g.set(s.g);
    this.life.set(s.life);
    this.u.set(s.u);
    this.awake.set(s.awake);
    this.reac.set(s.reac);
    this.flag = s.flag;
    this.dir = s.dir;
    this.seed = s.seed;
    this.time = s.time;
    this.originX = s.originX;
    this.originY = s.originY;
    this.pseq = s.pseq;
    this.eseq = s.eseq;
    this.supDirty = s.supDirty;
    this._supT = s.supT;
    this.proj = s.proj.map((p) => ({ ...p }));
    this._ghost = [];
    this.fp.fill(0);
    this.bodies = s.entRefs.slice();
    this.bodies.forEach((b, i) => b.load(s.ents[i]));
    if (this.bridge) {
      this.bridge.clearProxies();
      for (const B_VALUE of this.bodies) {
        B_VALUE._proxy = null;
      }
      this.bridge.restore(s.bridge);
      this.chd.fill(1);
    }
    for (const B_VALUE of this.bodies) {
      B_VALUE.px = B_VALUE.x;
      B_VALUE.py = B_VALUE.y;
    }
  }
  hash() {
    let h = 2166136261;
    const MIX = (v) => {
      h = Math.imul(h ^ (v | 0), 16777619);
    }, F = new Float64Array(1), U = new Uint32Array(F.buffer), MF = (x) => {
      F[0] = x;
      MIX(U[0]);
      MIX(U[1]);
    };
    for (let i = 0; i < this.g.length; i++) {
      MIX(this.g[i]);
      MIX(this.life[i]);
    }
    MIX(this.seed);
    MIX(this.time);
    MF(this.originX);
    MF(this.originY);
    for (const P_VALUE of this.proj) {
      MF(P_VALUE.x);
      MF(P_VALUE.y);
      MF(P_VALUE.vx);
      MF(P_VALUE.vy);
      MIX(P_VALUE.id);
      MIX(P_VALUE.t);
    }
    for (const E of this.bodies) {
      MF(E.x);
      MF(E.y);
      MF(E.vx);
      MF(E.vy);
      MF(E.hp);
      MIX(E.dead ? 1 : 0);
      for (const K_VALUE of Object.keys(E.status).sort()) {
        MIX(E.status[K_VALUE]);
      }
    }
    if (this.bridge) {
      for (const R_VALUE of this.bridge.bodies) {
        const B_VALUE = R_VALUE.body;
        MF(B_VALUE.position.x);
        MF(B_VALUE.position.y);
        MF(B_VALUE.positionPrev.x);
        MF(B_VALUE.positionPrev.y);
        MF(B_VALUE.angle);
        MF(B_VALUE.anglePrev);
        MF(B_VALUE.velocity.x);
        MF(B_VALUE.velocity.y);
        MF(B_VALUE.angularVelocity);
      }
    }
    return h >>> 0;
  }
  /* ---- 유령 solid: 강체 -> 입자 방향 (SSOT 아님, 입자 갱신 동안만 존재) ----
   * 틱 시작: 강체가 덮은 셀의 입자를 주변 빈 셀로 밀어내고, 빈 셀에 유령 재료를 찍는다
   * 입자 갱신: 유령 셀은 그냥 고체처럼 보이므로 액체/모래가 강체를 피해 흐르고 위에 쌓인다
   * 틱 끝: 유령 셀을 지운다. 잠긴 셀(=밀려난 유체)은 행 단위로 판정해 부력 계산에 쓴다 */
  _stamp() {
    const B = this.bridge, { w: W_VALUE, g: G } = this, GID = this.ghostId;
    this._ghost = [];
    for (const B_VALUE of B.bodies) {
      const ROWS = this._rowsOf(B_VALUE);
      for (const R_VALUE of ROWS) {
        for (let x = R_VALUE.xa; x <= R_VALUE.xb; x++) {
          this.fp[R_VALUE.y * W_VALUE + x] = 1;
        }
      }
      B_VALUE._rows = ROWS;
    }
    const AIR = (v) => v === 0 || this.K[v] === 3, LIQ = (v) => v !== 0 && this.K[v] === 2 ? v : 0;
    let bi = -1;
    for (const B_VALUE of B.bodies) {
      bi++;
      let carry = 0;
      B_VALUE.sub = { n: 0, rho: 0, sx: 0, sy: 0 };
      for (const R_VALUE of B_VALUE._rows) {
        const Y = R_VALUE.y;
        let ej = 0;
        for (let x = R_VALUE.xa; x <= R_VALUE.xb; x++) {
          const I = Y * W_VALUE + x, T = G[I];
          if (T && T !== GID && this.K[T] > 0 && this._eject(I, x, Y) && this.K[T] === 2) {
            ej = T;
          }
        }
        const L = R_VALUE.xa > 0 ? G[Y * W_VALUE + R_VALUE.xa - 1] : 1, R = R_VALUE.xb < W_VALUE - 1 ? G[Y * W_VALUE + R_VALUE.xb + 1] : 1;
        let f = ej || LIQ(L) || LIQ(R);
        if (!f && carry && !AIR(L) && !AIR(R)) {
          f = carry;
        }
        carry = f;
        for (let x = R_VALUE.xa; x <= R_VALUE.xb; x++) {
          const I = Y * W_VALUE + x;
          if (f) {
            B_VALUE.sub.n++;
            B_VALUE.sub.rho += this.D[f];
            B_VALUE.sub.sx += x + 0.5;
            B_VALUE.sub.sy += Y + 0.5;
          }
          if (G[I] === 0) {
            this.setCell(I, GID);
            this._ghost.push(I);
            this.gown[I] = bi + 1;
          }
        }
      }
      const Q = B_VALUE.sub, RAW2 = Q.n ? { n: Q.n, r: Q.rho / Q.n, x: Q.sx / Q.n, y: Q.sy / Q.n } : { n: 0, r: 0, x: B_VALUE.x, y: B_VALUE.y }, P_VALUE = B_VALUE._sm || (B_VALUE._sm = RAW2);
      P_VALUE.n += (RAW2.n - P_VALUE.n) * 0.25;
      if (RAW2.n) {
        P_VALUE.r += (RAW2.r - P_VALUE.r) * 0.25;
        P_VALUE.x += (RAW2.x - P_VALUE.x) * 0.25;
        P_VALUE.y += (RAW2.y - P_VALUE.y) * 0.25;
      }
      B_VALUE.sub = {
        n: P_VALUE.n,
        rho: P_VALUE.n * P_VALUE.r,
        sx: P_VALUE.n * P_VALUE.x,
        sy: P_VALUE.n * P_VALUE.y
      };
    }
  }
  _eject(i, x, y) {
    const { w: W_VALUE, h: H_VALUE, g: G } = this;
    for (let r = 1; r <= 4; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) {
            continue;
          }
          const NX = x + dx, NY = y + dy;
          if (NX < 0 || NY < 0 || NX >= W_VALUE || NY >= H_VALUE) {
            continue;
          }
          const J = NY * W_VALUE + NX;
          if (G[J] !== 0 || this.fp[J]) {
            continue;
          }
          this.setCell(J, G[i], this.life[i]);
          this.setCell(i, 0);
          return true;
        }
      }
    }
    return false;
  }
  _unstamp() {
    const GID = this.ghostId, G = this.g, W_VALUE = this.w, B = this.bridge, K = this.K, D = this.D;
    for (const B_VALUE of B.bodies) {
      let load = 0, sx = 0, sy = 0, m = 0;
      for (const R_VALUE of B_VALUE._rows) {
        for (let x = R_VALUE.xa; x <= R_VALUE.xb; x++) {
          const I = R_VALUE.y * W_VALUE + x;
          if (R_VALUE.y === 0 || this.fp[I - W_VALUE]) {
            continue;
          }
          let j = I - W_VALUE, n = 0;
          while (j >= 0 && K[G[j]] === 1 && n < 24) {
            load += D[G[j]];
            n++;
            j -= W_VALUE;
          }
          if (n) {
            sx += x + 0.5;
            sy += R_VALUE.y;
            m++;
          }
        }
      }
      B_VALUE.dbgLoad = m ? load * this.fluidScale * B.gravityScale : 0;
      if (m) {
        B.applyForce(B_VALUE, sx / m, sy / m, 0, B_VALUE.dbgLoad);
      }
    }
    for (const I of this._ghost) {
      if (G[I] === GID) {
        this.setCell(I, 0);
      }
    }
    for (const B_VALUE of this.bridge.bodies) {
      for (const R_VALUE of B_VALUE._rows) {
        for (let x = R_VALUE.xa; x <= R_VALUE.xb; x++) {
          this.fp[R_VALUE.y * W_VALUE + x] = 0;
        }
      }
    }
    this._ghost = [];
  }
  _entityHits() {
    for (const E of this.bodies) {
      if (E.dead || E.sensor) {
        continue;
      }
      const X0 = E.x - E.hx - 0.5, X1 = E.x + E.hx + 0.5, Y0 = E.y - E.hy - 0.5, Y1 = E.y + E.hy + 0.5;
      for (const H_VALUE of this.bridge.bodies) {
        if (this.time - (H_VALUE.data.born ?? -99) < 10 || !bodyHit(this.bridge, H_VALUE, X0, Y0, X1, Y1)) {
          continue;
        }
        const DX = E.x - H_VALUE.x, DY = E.y - H_VALUE.y, DD = HYP(DX, DY) || 1, EN = H_VALUE.mass * Math.max(0, (H_VALUE.vx * DX + H_VALUE.vy * DY) / DD) * this.impactScale;
        if (EN > 8 && this.time >= (E.data.rock || 0)) {
          E.data.rock = this.time + 20;
          const K_VALUE = H_VALUE.mass / (H_VALUE.mass + E.mass);
          E.hurt(EN * 0.4);
          E.impulse(H_VALUE.vx * K_VALUE, H_VALUE.vy * K_VALUE);
          this.emit("hit", { entity: E, rigid: H_VALUE, energy: EN });
        }
      }
    }
  }
  isCheckpoint() {
    return !this.bridge || this.bridge.tickNo % this.bridge.checkpoint === 0;
  }
  // 스냅샷은 이 틱에 찍어야 롤백이 비트 단위로 정확함
  _sync() {
    const B = this.bridge;
    for (let c = 0; c < this.chd.length; c++) {
      if (this.chd[c]) {
        this.chd[c] = 0;
        const CX = c % this.cw, CY = c / this.cw | 0;
        B.setStaticChunk(c, this._chunkShapes(CX, CY));
        this.chunkTick[c] = this.time;
        B.wake({ x: CX * 16 - 2, y: CY * 16 - 2, w: 20, h: 20 });
      }
    }
    for (const E of this.bodies) {
      if (E.sensor || E.dead || E.rigid === false) {
        continue;
      }
      if (E.pid == null) {
        E.pid = this.pseq++;
      }
      if (!E._proxy) {
        E._proxy = B.addProxy(E);
      }
      B.moveProxy(E._proxy, E.x, E.y);
    }
    for (const H_VALUE of B.bodies) {
      this._fluid(H_VALUE);
    }
    B.step(1e3 / 60);
    for (const IM of B.drainImpacts()) {
      this._impact(IM);
    }
    this._entityHits();
  }
  _ok(t, c) {
    if (c === 0) {
      return true;
    }
    if (this.NS[t]) {
      return false;
    }
    return this.K[t] < 3 ? this.K[c] >= 2 && this.D[t] > this.D[c] : this.K[c] === 2;
  }
  _mv(i, j) {
    const { g: G, life: LIFE, u: U_VALUE } = this;
    let t = G[i];
    G[i] = G[j];
    G[j] = t;
    t = LIFE[i];
    LIFE[i] = LIFE[j];
    LIFE[j] = t;
    U_VALUE[i] = U_VALUE[j] = this.flag;
    const A = this._wk(i), B_VALUE = this._wk(j);
    if (this.mats[G[i]].act) {
      this.reac[A] = 1;
    }
    if (this.mats[G[j]].act) {
      this.reac[B_VALUE] = 1;
    }
  }
  _nbr(x, y) {
    const D_VALUE = this.rnd(4), NX = x + (D_VALUE === 0) - (D_VALUE === 1), NY = y + (D_VALUE === 2) - (D_VALUE === 3);
    return NX < 0 || NY < 0 || NX >= this.w || NY >= this.h ? -1 : NY * this.w + NX;
  }
  _react(x, y, i, t) {
    const M_VALUE = this.mats[t];
    if (!M_VALUE.act) {
      return false;
    }
    if (M_VALUE.decay && --this.life[i] <= 0) {
      this.setCell(i, this.rand() < (M_VALUE.decay.chance ?? 1) ? M_VALUE.decayTo : 0);
      return true;
    }
    const N_VALUE = this._nbr(x, y), C_VALUE = N_VALUE < 0 ? 0 : this.g[N_VALUE];
    if (C_VALUE) {
      for (const R_VALUE of M_VALUE.rx) {
        if (R_VALUE.w.includes(C_VALUE) && this.rand() < R_VALUE.chance) {
          if (R_VALUE.other >= 0) {
            this.setCell(N_VALUE, R_VALUE.other);
          }
          if (R_VALUE.self >= 0) {
            this.setCell(i, R_VALUE.self);
            return true;
          }
          break;
        }
      }
    }
    return !!(M_VALUE.react && M_VALUE.react({ world: this, x, y, i, n: N_VALUE, other: C_VALUE, self: t }));
  }
  _step(x, y) {
    const { w: W_VALUE, h: H_VALUE, g: G } = this, I = y * W_VALUE + x, T = G[I];
    if (!T || this.u[I] === this.flag) {
      return;
    }
    if (this._react(x, y, I, T)) {
      return;
    }
    const K_VALUE = this.K[T];
    if (K_VALUE === 0) {
      return;
    }
    if (this.S[T] && this.rand() < this.S[T]) {
      return;
    }
    const D_VALUE = this.rand() < 0.5 ? -1 : 1;
    if (K_VALUE === 3) {
      if (y > 0 && this.rand() < this.R[T]) {
        if (this._ok(T, G[I - W_VALUE])) {
          this._mv(I, I - W_VALUE);
          return;
        }
        if (x + D_VALUE >= 0 && x + D_VALUE < W_VALUE && this._ok(T, G[I - W_VALUE + D_VALUE])) {
          this._mv(I, I - W_VALUE + D_VALUE);
          return;
        }
      }
      if (!this.NS[T] && x + D_VALUE >= 0 && x + D_VALUE < W_VALUE && G[I + D_VALUE] === 0) {
        this._mv(I, I + D_VALUE);
      }
      return;
    }
    if (y < H_VALUE - 1) {
      if (this._ok(T, G[I + W_VALUE])) {
        this._mv(I, I + W_VALUE);
        return;
      }
      for (let a = 0; a < 2; a++) {
        const S_VALUE = a ? -D_VALUE : D_VALUE;
        if (x + S_VALUE >= 0 && x + S_VALUE < W_VALUE && this._ok(T, G[I + W_VALUE + S_VALUE])) {
          this._mv(I, I + W_VALUE + S_VALUE);
          return;
        }
      }
    }
    if (K_VALUE === 2) {
      for (let a = 0; a < 2; a++) {
        const S_VALUE = a ? -D_VALUE : D_VALUE;
        let e = -1;
        for (let q = 1; q <= this.DI[T]; q++) {
          const NX = x + S_VALUE * q;
          if (NX < 0 || NX >= W_VALUE || G[y * W_VALUE + NX] !== 0) {
            break;
          }
          e = y * W_VALUE + NX;
        }
        if (e >= 0) {
          this._mv(I, e);
          return;
        }
      }
    }
  }
  tick() {
    if (this.dirty) {
      this._compile();
    }
    const T0 = NOW();
    if (this.time === 0) {
      for (let c = 0; c < this.reac.length; c++) {
        this._refreshReac(c);
      }
    }
    if (this.bridge) {
      for (const H_VALUE of this.bridge.bodies) {
        H_VALUE.px = H_VALUE.x;
        H_VALUE.py = H_VALUE.y;
        H_VALUE.pa = H_VALUE.angle;
      }
    }
    for (const B_VALUE of this.bodies) {
      B_VALUE.px = B_VALUE.x;
      B_VALUE.py = B_VALUE.y;
    }
    this.flag = this.flag === 1 ? 2 : 1;
    this.dir ^= 1;
    if (this.bridge) {
      this._stamp();
    }
    if (this.proj.length) {
      this._jets();
    }
    const { w: W_VALUE, cw: CW, awake: AWAKE, reac: REAC } = this, SL = this.sleepEnabled;
    for (let y = this.h - 1; y >= 0; y--) {
      const BASE = (y >> 4) * CW;
      if (this.dir) {
        for (let cx = 0; cx < CW; cx++) {
          if (SL && !AWAKE[BASE + cx] && !REAC[BASE + cx]) {
            continue;
          }
          const XE = Math.min(W_VALUE, cx + 1 << 4);
          for (let x = cx << 4; x < XE; x++) {
            this._step(x, y);
          }
        }
      } else {
        for (let cx = CW - 1; cx >= 0; cx--) {
          if (SL && !AWAKE[BASE + cx] && !REAC[BASE + cx]) {
            continue;
          }
          const XS = cx << 4;
          for (let x = Math.min(W_VALUE, cx + 1 << 4) - 1; x >= XS; x--) {
            this._step(x, y);
          }
        }
      }
    }
    let ac = 0;
    for (let c = 0; c < AWAKE.length; c++) {
      if (AWAKE[c] || REAC[c]) {
        ac++;
      }
      if (AWAKE[c]) {
        AWAKE[c]--;
      }
    }
    this._refreshReac(this.time % AWAKE.length);
    if (this.bridge) {
      this._unstamp();
      this._support();
      this._sync();
      this._settle();
    }
    for (const B_VALUE of this.bodies) {
      B_VALUE.update(this);
    }
    for (const A of this.bodies) {
      if (A.onOverlap && !A.dead) {
        for (const B_VALUE of this.bodies) {
          if (B_VALUE !== A && !B_VALUE.dead && Math.abs(A.x - B_VALUE.x) < A.hx + B_VALUE.hx + 0.4 && Math.abs(A.y - B_VALUE.y) < A.hy + B_VALUE.hy + 0.4) {
            A.onOverlap(B_VALUE);
          }
        }
      }
    }
    this.bodies = this.bodies.filter((b) => {
      if (b.dead && b._proxy) {
        this.bridge.removeProxy(b._proxy);
        b._proxy = null;
      }
      return !b.dead;
    });
    this.stats.active = ac;
    this.stats.ms = NOW() - T0;
    this.time++;
  }
};
var PhysicsBridge = class {
  constructor() {
    this.bodies = [];
    this.joints = [];
    this.gravityScale = 0;
  }
  // bodies: 핸들 {x,y,angle,w,h,mass,vx,vy,data,pins}
  setStaticChunk(_id, _shapes) {
  }
  // shapes: [{verts:[{x,y}..], mat}]  지형 충돌체 교체
  addBody(_o) {
  }
  addBox(_o) {
  }
  removeBody(_h) {
  }
  clearDynamic() {
  }
  // addBody({kind:'box'|'circle'|'poly'|'convex'|'compound', x,y,angle,vx,vy,av,density,friction,restitution,group,data, w,h|r|sides|verts|parts})
  getPolys(_h) {
    return [];
  }
  getBounds(_h) {
    return { x0: 0, y0: 0, x1: 0, y1: 0 };
  }
  // 형상 질의: 월드 좌표의 볼록 다각형들, AABB (격자 래스터화·엔티티 충돌·렌더가 사용)
  addJoint(_o) {
  }
  removeJoint(_j) {
  }
  shift(_dx, _dy, _remapStatic) {
  }
  // 창 이동: 모든 월드 좌표를 (-dx,-dy)만큼 옮기고 정적 충돌체 id를 remapStatic(id)(없으면 -1)로 바꿉니다
  setAngularVelocity(_h, _av) {
  }
  // 조인트: {a,b?,ax,ay,bx,by,len,stiff,damping}
  addProxy(_e) {
  }
  moveProxy(_p, _x, _y) {
  }
  removeProxy(_p) {
  }
  clearProxies() {
  }
  // 엔티티를 엔진에 정적 박스로 비춤
  addPin(_h, _ax, _ay, _lx, _ly, _len, _stiff) {
  }
  // 월드 고정점에 줄/핀으로 매달기
  applyForce(_h, _px, _py, _fx, _fy) {
  }
  applyImpulse(_h, _jx, _jy) {
  }
  applyImpulseAt(_h, _px, _py, _jx, _jy) {
  }
  setVelocity(_h, _vx, _vy) {
  }
  damp(_h, _lin, _ang) {
  }
  wake(_rect) {
  }
  step(_dtMs) {
  }
  drainImpacts() {
    return [];
  }
  // impacts: [{body,x,y,nx,ny,impulse,rvx,rvy,mat|entity}]
  snapshot() {
  }
  restore(_s) {
  }
  // 롤백/리플레이용 상태 저장/복원
};
var MatterBridge = class extends PhysicsBridge {
  /* deterministic: 바디 id/순서를 고정하고 checkpoint 틱마다 접촉 캐시를 비워서, 스냅샷에서 복원해 다시 돌려도 비트 단위로 같은 결과가 나오게 함.
   * 스냅샷은 world.time(= bridge.tickNo)이 checkpoint의 배수일 때 찍어야 정확히 재현됨 */
  constructor({ gravity = 4e-4, deterministic = true, checkpoint = 30 } = {}) {
    super();
    this.M = Matter;
    this.gravityScale = gravity;
    this.deterministic = deterministic;
    this.checkpoint = checkpoint;
    this.tickNo = 0;
    this.seq = 1;
    this.dt = 1e3 / 60;
    this.engine = Matter.Engine.create({ enableSleeping: false });
    this.engine.gravity.y = 1;
    this.engine.gravity.scale = gravity;
    this.engine.positionIterations = 16;
    this.engine.velocityIterations = 8;
    this.statics = /* @__PURE__ */ new Map();
    this.proxies = /* @__PURE__ */ new Set();
    this.impacts = [];
    this.jseq = 1;
    Matter.Events.on(this.engine, "collisionStart", (e) => {
      for (const P_VALUE of e.pairs) {
        const A = P_VALUE.bodyA.parent, B_VALUE = P_VALUE.bodyB.parent;
        if (A.isStatic === B_VALUE.isStatic) {
          continue;
        }
        const DYN = A.isStatic ? B_VALUE : A, ST_VALUE = A.isStatic ? A : B_VALUE, N_VALUE = P_VALUE.collision.normal, H_VALUE = DYN.plugin.handle;
        if (!H_VALUE) {
          continue;
        }
        const VN = Math.abs(
          (A.velocity.x - B_VALUE.velocity.x) * N_VALUE.x + (A.velocity.y - B_VALUE.velocity.y) * N_VALUE.y
        ), SP = (P_VALUE.collision.supports || []).find(Boolean) || DYN.position;
        const IM = {
          body: H_VALUE,
          x: SP.x,
          y: SP.y,
          nx: N_VALUE.x,
          ny: N_VALUE.y,
          impulse: DYN.mass * VN,
          rvx: DYN.velocity.x,
          rvy: DYN.velocity.y
        };
        if (ST_VALUE.plugin.proxy) {
          IM.entity = ST_VALUE.plugin.entity;
        } else {
          IM.mat = ST_VALUE.plugin.mat;
        }
        this.impacts.push(IM);
      }
    });
  }
  setStaticChunk(id, shapes) {
    const M = this.M, C = M.Composite, OLD = this.statics.get(id);
    if (OLD) {
      C.remove(this.engine.world, OLD);
    }
    if (!shapes.length) {
      this.statics.delete(id);
      return;
    }
    const BS = shapes.map((s, k) => {
      const C_VALUE = M.Vertices.centre(s.verts);
      const B_VALUE = M.Bodies.fromVertices(C_VALUE.x, C_VALUE.y, [s.verts], {
        isStatic: true,
        friction: 0.7,
        plugin: { mat: s.mat }
      });
      B_VALUE.id = 1e5 + id * 256 + k;
      return B_VALUE;
    });
    C.add(this.engine.world, BS);
    this.statics.set(id, BS);
  }
  clearStatics() {
    const C = this.M.Composite;
    for (const BS of this.statics.values()) {
      C.remove(this.engine.world, BS);
    }
    this.statics.clear();
  }
  _make(h, d) {
    const M = this.M, O = { density: d.density, friction: d.friction, restitution: d.restitution, frictionAir: 5e-3 };
    let b;
    if (d.kind === "circle") {
      b = M.Bodies.circle(0, 0, d.r, O);
    } else if (d.kind === "poly") {
      b = M.Bodies.polygon(0, 0, d.sides, d.r, O);
    } else if (d.kind === "convex") {
      b = M.Bodies.fromVertices(0, 0, [d.verts], O);
    } else if (d.kind === "compound") {
      b = M.Body.create({
        parts: d.parts.map(
          (p) => M.Bodies.rectangle(p.x + p.w / 2, p.y + p.h / 2, p.w, p.h, {
            density: p.density ?? d.density,
            friction: d.friction,
            restitution: d.restitution
          })
        ),
        friction: d.friction,
        restitution: d.restitution,
        frictionAir: 5e-3
      });
    } else {
      b = M.Bodies.rectangle(0, 0, d.w, d.h, O);
    }
    b.id = h.id;
    b.parts.forEach((p, k) => {
      if (k) {
        p.id = 4e6 + h.id * 1024 + k;
      }
      if (d.group) {
        p.collisionFilter.group = d.group;
      }
    });
    if (d.group) {
      b.collisionFilter.group = d.group;
    }
    b.plugin.handle = h;
    h.body = b;
    h.mass = b.mass;
    h.area = b.area;
    M.Composite.add(this.engine.world, b);
  }
  addBody(o) {
    const K_VALUE = o.kind || "box", D_VALUE = {
      kind: K_VALUE,
      density: o.density ?? 2e-3,
      friction: o.friction ?? 0.6,
      restitution: o.restitution ?? 0.1,
      w: o.w,
      h: o.h,
      r: o.r,
      sides: o.sides,
      verts: o.verts,
      parts: o.parts,
      group: o.group || 0
    };
    const H_VALUE = {
      id: this.seq++,
      desc: D_VALUE,
      x: 0,
      y: 0,
      angle: 0,
      w: 0,
      h: 0,
      mass: 0,
      area: 0,
      vx: 0,
      vy: 0,
      av: 0,
      data: o.data || {},
      pins: [],
      _cons: []
    }, M = this.M;
    this._make(H_VALUE, D_VALUE);
    const B_VALUE = H_VALUE.body, BD = B_VALUE.bounds;
    H_VALUE.w = BD.max.x - BD.min.x;
    H_VALUE.h = BD.max.y - BD.min.y;
    const A = o.angle || 0, OX = K_VALUE === "compound" ? B_VALUE.position.x : 0, OY = K_VALUE === "compound" ? B_VALUE.position.y : 0;
    if (K_VALUE === "compound") {
      H_VALUE.ox = OX;
      H_VALUE.oy = OY;
    }
    if (A) {
      M.Body.setAngle(B_VALUE, A);
    }
    const C_VALUE = Math.cos(A), S_VALUE = Math.sin(A);
    M.Body.setPosition(B_VALUE, { x: o.x + OX * C_VALUE - OY * S_VALUE, y: o.y + OX * S_VALUE + OY * C_VALUE });
    if (o.vx || o.vy) {
      M.Body.setVelocity(B_VALUE, { x: o.vx || 0, y: o.vy || 0 });
    }
    if (o.av) {
      M.Body.setAngularVelocity(B_VALUE, o.av);
    }
    H_VALUE.x = B_VALUE.position.x;
    H_VALUE.y = B_VALUE.position.y;
    H_VALUE.angle = B_VALUE.angle;
    H_VALUE.vx = B_VALUE.velocity.x;
    H_VALUE.vy = B_VALUE.velocity.y;
    H_VALUE.av = B_VALUE.angularVelocity;
    H_VALUE.px = H_VALUE.x;
    H_VALUE.py = H_VALUE.y;
    H_VALUE.pa = H_VALUE.angle;
    this.bodies.push(H_VALUE);
    return H_VALUE;
  }
  addBox(o) {
    return this.addBody({ ...o, kind: "box" });
  }
  addCircle(o) {
    return this.addBody({ ...o, kind: "circle" });
  }
  addPolygon(o) {
    return this.addBody({ ...o, kind: "poly" });
  }
  // 정다각형: sides, r
  addConvex(o) {
    return this.addBody({ ...o, kind: "convex" });
  }
  // 임의 볼록 다각형: verts [{x,y}..]
  getPolys(h) {
    const B_VALUE = h.body;
    return B_VALUE.parts.length > 1 ? B_VALUE.parts.slice(1).map((p) => p.vertices) : [B_VALUE.vertices];
  }
  getBounds(h) {
    const BD = h.body.bounds;
    return { x0: BD.min.x, y0: BD.min.y, x1: BD.max.x, y1: BD.max.y };
  }
  setAngularVelocity(h, av) {
    this.M.Body.setAngularVelocity(h.body, av);
    h.av = av;
  }
  _joint(j) {
    const O = {
      bodyA: j.a.body,
      pointA: { x: j.ax, y: j.ay },
      pointB: { x: j.bx, y: j.by },
      length: j.len,
      stiffness: j.stiff,
      damping: j.damp
    };
    if (j.b) {
      O.bodyB = j.b.body;
    }
    j.c = this.M.Constraint.create(O);
    j.c.id = 8e5 + j.id;
    this.M.Composite.add(this.engine.world, j.c);
  }
  addJoint(o) {
    const J = {
      id: this.jseq++,
      a: o.a,
      b: o.b || null,
      ax: o.ax || 0,
      ay: o.ay || 0,
      bx: o.bx || 0,
      by: o.by || 0,
      len: o.len || 0,
      stiff: o.stiff ?? 1,
      damp: o.damping ?? 0.02,
      c: null
    };
    this._joint(J);
    this.joints.push(J);
    return J;
  }
  removeJoint(j) {
    if (j.c) {
      this.M.Composite.remove(this.engine.world, j.c);
    }
    j.c = null;
    this.joints = this.joints.filter((x) => x !== j);
  }
  _pin(h, p) {
    const C_VALUE = this.M.Constraint.create({
      pointA: { x: p.ax, y: p.ay },
      bodyB: h.body,
      pointB: { x: p.lx, y: p.ly },
      length: p.len,
      stiffness: p.stiff,
      damping: 0.02
    });
    C_VALUE.id = 7e5 + h.id * 8 + h._cons.length;
    h._cons.push(C_VALUE);
    this.M.Composite.add(this.engine.world, C_VALUE);
  }
  addPin(h, ax, ay, lx = 0, ly = -h.h / 2, len = 0, stiff = 1) {
    const P_VALUE = { ax, ay, lx, ly, len, stiff };
    h.pins.push(P_VALUE);
    this._pin(h, P_VALUE);
    return P_VALUE;
  }
  removeBody(h) {
    const C = this.M.Composite;
    for (const J of this.joints.filter((j) => j.a === h || j.b === h)) {
      this.removeJoint(J);
    }
    for (const C_VALUE of h._cons) {
      C.remove(this.engine.world, C_VALUE);
    }
    h._cons = [];
    C.remove(this.engine.world, h.body);
    this.bodies = this.bodies.filter((x) => x !== h);
  }
  clearDynamic() {
    for (const H_VALUE of this.bodies.slice()) {
      this.removeBody(H_VALUE);
    }
    this.joints = [];
  }
  addProxy(e) {
    const M = this.M, B_VALUE = M.Bodies.rectangle(e.x, e.y, e.hx * 2 - 0.2, e.hy * 2 - 0.2, {
      isStatic: true,
      friction: 0.2,
      plugin: { proxy: true, entity: e }
    });
    B_VALUE.id = 2e5 + e.pid;
    M.Composite.add(this.engine.world, B_VALUE);
    const P_VALUE = { body: B_VALUE, e };
    this.proxies.add(P_VALUE);
    return P_VALUE;
  }
  moveProxy(p, x, y) {
    this.M.Body.setPosition(p.body, { x, y });
  }
  removeProxy(p) {
    this.M.Composite.remove(this.engine.world, p.body);
    this.proxies.delete(p);
  }
  clearProxies() {
    for (const P_VALUE of [...this.proxies]) {
      this.removeProxy(P_VALUE);
    }
  }
  applyForce(h, px, py, fx, fy) {
    this.M.Body.applyForce(h.body, { x: px, y: py }, { x: fx, y: fy });
  }
  applyImpulseAt(h, px, py, jx, jy) {
    const K_VALUE = 1 / (this.dt * this.dt);
    this.applyForce(h, px, py, jx * K_VALUE, jy * K_VALUE);
  }
  // 한 스텝치 힘으로 환산해 가해서 회전력도 생김 (속도 변화 = 힘/질량 x dt²)
  applyImpulse(h, jx, jy) {
    const B_VALUE = h.body, V = B_VALUE.velocity;
    this.M.Body.setVelocity(B_VALUE, { x: V.x + jx / B_VALUE.mass, y: V.y + jy / B_VALUE.mass });
  }
  setVelocity(h, vx, vy) {
    this.M.Body.setVelocity(h.body, { x: vx, y: vy });
    h.vx = vx;
    h.vy = vy;
  }
  damp(h, lin, ang) {
    const B_VALUE = h.body, V = B_VALUE.velocity;
    this.M.Body.setVelocity(B_VALUE, { x: V.x * lin, y: V.y * lin });
    this.M.Body.setAngularVelocity(B_VALUE, B_VALUE.angularVelocity * ang);
  }
  shift(dx, dy, remapStatic) {
    const M = this.M, T = { x: -dx, y: -dy };
    for (const H_VALUE of this.bodies) {
      M.Body.translate(H_VALUE.body, T, false);
      H_VALUE.x = H_VALUE.body.position.x;
      H_VALUE.y = H_VALUE.body.position.y;
      H_VALUE.px -= dx;
      H_VALUE.py -= dy;
      for (const P_VALUE of H_VALUE.pins) {
        P_VALUE.ax -= dx;
        P_VALUE.ay -= dy;
      }
      for (const C_VALUE of H_VALUE._cons) {
        C_VALUE.pointA.x -= dx;
        C_VALUE.pointA.y -= dy;
      }
    }
    for (const J of this.joints) {
      if (!J.b) {
        J.bx -= dx;
        J.by -= dy;
        J.c.pointB.x -= dx;
        J.c.pointB.y -= dy;
      }
    }
    const NEXT = /* @__PURE__ */ new Map();
    for (const [ID, BS] of this.statics) {
      const NEW_ID = remapStatic(ID);
      if (NEW_ID < 0) {
        M.Composite.remove(this.engine.world, BS);
        continue;
      }
      BS.forEach((b, k) => {
        M.Body.translate(b, T, false);
        b.id = 1e5 + NEW_ID * 256 + k;
      });
      NEXT.set(NEW_ID, BS);
    }
    this.statics = NEXT;
    M.Pairs.clear(this.engine.pairs);
  }
  wake(r) {
    for (const H_VALUE of this.bodies) {
      if (Math.abs(H_VALUE.x - (r.x + r.w / 2)) < r.w / 2 + H_VALUE.w && Math.abs(H_VALUE.y - (r.y + r.h / 2)) < r.h / 2 + H_VALUE.h) {
        this.M.Sleeping.set(H_VALUE.body, false);
      }
    }
  }
  step(dt) {
    const M = this.M, W = this.engine.world;
    if (this.deterministic) {
      if (this.tickNo % this.checkpoint === 0) {
        M.Pairs.clear(this.engine.pairs);
      }
      W.bodies.sort((a, b) => a.id - b.id);
      W.constraints.sort((a, b) => a.id - b.id);
      M.Composite.setModified(W, true, true, false);
    }
    this.tickNo++;
    M.Engine.update(this.engine, dt);
    for (const H_VALUE of this.bodies) {
      const B_VALUE = H_VALUE.body;
      H_VALUE.x = B_VALUE.position.x;
      H_VALUE.y = B_VALUE.position.y;
      H_VALUE.angle = B_VALUE.angle;
      H_VALUE.vx = B_VALUE.velocity.x;
      H_VALUE.vy = B_VALUE.velocity.y;
      H_VALUE.av = B_VALUE.angularVelocity;
    }
  }
  drainImpacts() {
    const R_VALUE = this.impacts;
    this.impacts = [];
    return R_VALUE;
  }
  snapshot() {
    const SP = (p) => ({
      pos: { x: p.position.x, y: p.position.y },
      ang: p.angle,
      vs: p.vertices.map((v) => [v.x, v.y]),
      ax: p.axes.map((a) => [a.x, a.y]),
      bd: [p.bounds.min.x, p.bounds.min.y, p.bounds.max.x, p.bounds.max.y]
    });
    const ST_VALUE = (b) => ({
      ...SP(b),
      pp: { x: b.positionPrev.x, y: b.positionPrev.y },
      ap: b.anglePrev,
      v: { x: b.velocity.x, y: b.velocity.y },
      av: b.angularVelocity,
      sp: b.speed,
      asp: b.angularSpeed,
      dt: b.deltaTime,
      pi: { x: b.positionImpulse.x, y: b.positionImpulse.y },
      ci: { x: b.constraintImpulse.x, y: b.constraintImpulse.y, a: b.constraintImpulse.angle },
      // 엔진이 틱 사이에 들고 가는 워밍 임펄스
      parts: b.parts.length > 1 ? b.parts.slice(1).map(SP) : []
    });
    return {
      tickNo: this.tickNo,
      seq: this.seq,
      jseq: this.jseq,
      bs: this.bodies.map((h) => ({
        h,
        w: h.w,
        hh: h.h,
        cells: h.cells,
        // 마스크 강체의 셀 집합(생성 뒤 불변)과 무게중심 격자 좌표
        ox: h.ox,
        oy: h.oy,
        desc: h.desc,
        pins: h.pins.map((p) => ({ ...p })),
        st: ST_VALUE(h.body),
        sm: h._sm ? { ...h._sm } : null,
        dat: { ...h.data },
        // 부력 평활화 상태, 줄 제약의 내부 상태(회전된 앵커/각도)도 저장
        cons: h._cons.map((c) => ({ x: c.pointB.x, y: c.pointB.y, a: c.angleB }))
      })),
      js: this.joints.map((j) => ({
        j,
        a: j.a,
        b: j.b,
        d: { ax: j.ax, ay: j.ay, bx: j.bx, by: j.by, len: j.len, stiff: j.stiff, damp: j.damp },
        k: {
          ax: j.c.pointA.x,
          ay: j.c.pointA.y,
          bx: j.c.pointB.x,
          by: j.c.pointB.y,
          aa: j.c.angleA,
          ab: j.c.angleB
        }
      }))
    };
  }
  restore(s) {
    for (const H_VALUE of this.bodies.slice()) {
      this.removeBody(H_VALUE);
    }
    this.joints = [];
    this.clearStatics();
    this.clearProxies();
    this.tickNo = s.tickNo;
    this.seq = s.seq;
    this.jseq = s.jseq;
    const PUT = (p, q) => {
      p.position.x = q.pos.x;
      p.position.y = q.pos.y;
      p.angle = q.ang;
      q.vs.forEach((v, i) => {
        p.vertices[i].x = v[0];
        p.vertices[i].y = v[1];
      });
      q.ax.forEach((a, i) => {
        p.axes[i].x = a[0];
        p.axes[i].y = a[1];
      });
      p.bounds.min.x = q.bd[0];
      p.bounds.min.y = q.bd[1];
      p.bounds.max.x = q.bd[2];
      p.bounds.max.y = q.bd[3];
    };
    for (const R_VALUE of s.bs) {
      const H_VALUE = R_VALUE.h, Q = R_VALUE.st;
      H_VALUE.pins = R_VALUE.pins;
      H_VALUE._cons = [];
      H_VALUE.w = R_VALUE.w;
      H_VALUE.h = R_VALUE.hh;
      if (R_VALUE.cells) {
        H_VALUE.cells = R_VALUE.cells;
        H_VALUE.ox = R_VALUE.ox;
        H_VALUE.oy = R_VALUE.oy;
      }
      this._make(H_VALUE, R_VALUE.desc);
      const B_VALUE = H_VALUE.body;
      PUT(B_VALUE, Q);
      B_VALUE.positionPrev.x = Q.pp.x;
      B_VALUE.positionPrev.y = Q.pp.y;
      B_VALUE.anglePrev = Q.ap;
      B_VALUE.velocity.x = Q.v.x;
      B_VALUE.velocity.y = Q.v.y;
      B_VALUE.angularVelocity = Q.av;
      B_VALUE.speed = Q.sp;
      B_VALUE.angularSpeed = Q.asp;
      B_VALUE.deltaTime = Q.dt;
      B_VALUE.positionImpulse.x = Q.pi.x;
      B_VALUE.positionImpulse.y = Q.pi.y;
      B_VALUE.constraintImpulse.x = Q.ci.x;
      B_VALUE.constraintImpulse.y = Q.ci.y;
      B_VALUE.constraintImpulse.angle = Q.ci.a;
      Q.parts.forEach((pq, i) => PUT(B_VALUE.parts[i + 1], pq));
      for (const P_VALUE of H_VALUE.pins) {
        this._pin(H_VALUE, P_VALUE);
      }
      H_VALUE._cons.forEach((c, i) => {
        const K_VALUE = R_VALUE.cons[i];
        c.pointB.x = K_VALUE.x;
        c.pointB.y = K_VALUE.y;
        c.angleB = K_VALUE.a;
      });
      H_VALUE._sm = R_VALUE.sm ? { ...R_VALUE.sm } : void 0;
      for (const K_VALUE in H_VALUE.data) {
        delete H_VALUE.data[K_VALUE];
      }
      Object.assign(H_VALUE.data, R_VALUE.dat);
      H_VALUE.x = Q.pos.x;
      H_VALUE.y = Q.pos.y;
      H_VALUE.angle = Q.ang;
      H_VALUE.vx = Q.v.x;
      H_VALUE.vy = Q.v.y;
      H_VALUE.av = Q.av;
      H_VALUE.px = H_VALUE.x;
      H_VALUE.py = H_VALUE.y;
      H_VALUE.pa = H_VALUE.angle;
      this.bodies.push(H_VALUE);
    }
    this.joints = [];
    for (const R_VALUE of s.js) {
      const J = R_VALUE.j;
      Object.assign(J, R_VALUE.d);
      J.a = R_VALUE.a;
      J.b = R_VALUE.b;
      this._joint(J);
      const C_VALUE = J.c;
      C_VALUE.pointA.x = R_VALUE.k.ax;
      C_VALUE.pointA.y = R_VALUE.k.ay;
      C_VALUE.pointB.x = R_VALUE.k.bx;
      C_VALUE.pointB.y = R_VALUE.k.by;
      C_VALUE.angleA = R_VALUE.k.aa;
      C_VALUE.angleB = R_VALUE.k.ab;
      this.joints.push(J);
    }
    this.M.Pairs.clear(this.engine.pairs);
  }
};
var Body = class {
  constructor(o) {
    Object.assign(
      this,
      {
        shape: "box",
        x: 0,
        y: 0,
        w: 3,
        h: 6,
        r: 3,
        vx: 0,
        vy: 0,
        gravity: 0.12,
        accel: 0.15,
        friction: 0.8,
        maxFall: 3,
        stepUp: 2,
        jumpV: 1.4,
        coyote: 6,
        jumpBuffer: 6,
        jumpCut: 0.5,
        _coy: 0,
        _buf: 0,
        _jh: false,
        _jumping: false,
        hp: 100,
        sensor: false,
        color: "#fff",
        showHp: false,
        input: { x: 0, jump: false },
        status: {},
        mass: 0.03,
        maxRise: Infinity,
        solid: true,
        _eg: null,
        _rw: 0,
        pid: null,
        _proxy: null,
        _rg: null,
        _ride: null,
        ground: false,
        swim: false,
        dead: false,
        contacts: /* @__PURE__ */ new Map(),
        onContact: null,
        onOverlap: null,
        onDeath: null,
        data: {}
      },
      o
    );
    if (this.sensor && o.gravity == null) {
      this.gravity = 0;
    }
    this.maxHp = this.hp;
    this.hx = this.shape === "circle" ? this.r : this.w / 2;
    this.hy = this.shape === "circle" ? this.r : this.h / 2;
  }
  impulse(ix, iy) {
    this.vx += ix;
    this.vy += iy;
  }
  save() {
    return {
      x: this.x,
      y: this.y,
      vx: this.vx,
      vy: this.vy,
      hp: this.hp,
      dead: this.dead,
      ground: this.ground,
      swim: this.swim,
      _coy: this._coy,
      _buf: this._buf,
      _jh: this._jh,
      _jumping: this._jumping,
      _rw: this._rw,
      pid: this.pid,
      _ride: this._ride,
      status: { ...this.status },
      input: { ...this.input },
      data: { ...this.data }
    };
  }
  load(s) {
    const { status: STATUS, input: INPUT, data: DATA, ...R_VALUE } = s;
    Object.assign(this, R_VALUE);
    for (const K_VALUE in this.status) {
      delete this.status[K_VALUE];
    }
    Object.assign(this.status, STATUS);
    for (const K_VALUE in this.input) {
      delete this.input[K_VALUE];
    }
    Object.assign(this.input, INPUT);
    for (const K_VALUE in this.data) {
      delete this.data[K_VALUE];
    }
    Object.assign(this.data, DATA);
  }
  hurt(a) {
    if (this.dead) {
      return;
    }
    this.hp -= a;
    if (this.hp <= 0) {
      this.dead = true;
      if (this.onDeath) {
        this.onDeath(this);
      }
    }
  }
  _cells(x, y, fn) {
    const X0 = Math.floor(x - this.hx), X1 = Math.floor(x + this.hx - 0.01), Y0 = Math.floor(y - this.hy), Y1 = Math.floor(y + this.hy - 0.01);
    for (let yy = Y0; yy <= Y1; yy++) {
      for (let xx = X0; xx <= X1; xx++) {
        if (this.shape === "circle") {
          const DX = xx + 0.5 - x, DY = yy + 0.5 - y;
          if (DX * DX + DY * DY > this.r * this.r) {
            continue;
          }
        }
        if (fn(xx, yy)) {
          return true;
        }
      }
    }
    return false;
  }
  _hit(wValue, x, y) {
    if (this._cells(x, y, (xx, yy) => {
      if (xx < 0 || xx >= wValue.w || yy >= wValue.h) {
        return true;
      }
      if (yy < 0) {
        return false;
      }
      const T = wValue.g[yy * wValue.w + xx];
      return T !== 0 && wValue.BL[T] === 1;
    })) {
      return 1;
    }
    const B = wValue.bridge;
    if (B && !this.sensor && this.rigid !== false) {
      const X0 = x - this.hx + 0.15, X1 = x + this.hx - 0.15, Y0 = y - this.hy + 0.15, Y1 = y + this.hy - 0.15;
      for (const H_VALUE of B.bodies) {
        if (bodyHit(B, H_VALUE, X0, Y0, X1, Y1)) {
          this._rg = H_VALUE;
          return 2;
        }
      }
    }
    if (this.solid && !this.sensor) {
      for (const O of wValue.bodies) {
        if (O === this || O.dead || O.sensor || !O.solid) {
          continue;
        }
        if (Math.abs(x - O.x) < this.hx + O.hx - 0.01 && Math.abs(y - O.y) < this.hy + O.hy - 0.01) {
          this._eg = O;
          return 3;
        }
      }
    }
    return 0;
  }
  _sep(o) {
    const OX = this.hx + o.hx - Math.abs(this.x - o.x), OY = this.hy + o.hy - Math.abs(this.y - o.y);
    if (OX <= 0 || OY <= 0) {
      return;
    }
    const M_VALUE = this.mass + o.mass, KS = o.mass / M_VALUE, KO = this.mass / M_VALUE;
    if (OX <= OY) {
      const SG = this.x < o.x ? -1 : 1;
      this.x += SG * OX * KS;
      o.x -= SG * OX * KO;
    } else {
      const SG = this.y < o.y ? -1 : 1;
      this.y += SG * OY * KS;
      o.y -= SG * OY * KO;
    }
  }
  _unstick(wValue) {
    const D = [
      [0, -1],
      [-1, 0],
      [1, 0],
      [0, 1]
    ];
    for (let d = 0.25; d <= 8; d += 0.25) {
      for (const [DX, DY] of D) {
        if (!this._hit(wValue, this.x + DX * d, this.y + DY * d)) {
          this.x += DX * d;
          this.y += DY * d;
          if (DY && Math.sign(DY) !== Math.sign(this.vy)) {
            this.vy = 0;
          }
          if (DX && Math.sign(DX) !== Math.sign(this.vx)) {
            this.vx = 0;
          }
          return;
        }
      }
    }
    this.hurt(0.5);
  }
  update(wValue) {
    if (this.dead) {
      return;
    }
    if (!this.sensor) {
      const K_VALUE = this._hit(wValue, this.x, this.y);
      if (!K_VALUE) {
        this._rw = 0;
      } else if (K_VALUE === 2 && this._rw < 8) {
        this._rw++;
      } else if (K_VALUE === 3) {
        this._sep(this._eg);
      } else {
        this._unstick(wValue);
      }
    }
    const CNT = this.contacts;
    CNT.clear();
    let n = 0, sw = 0;
    this._cells(this.x, this.y, (xx, yy) => {
      if (xx < 0 || xx >= wValue.w || yy < 0 || yy >= wValue.h) {
        return;
      }
      n++;
      const T = wValue.g[yy * wValue.w + xx];
      if (T) {
        CNT.set(T, (CNT.get(T) || 0) + 1);
        if (wValue.SW[T]) {
          sw++;
        }
      }
    });
    this.swim = n > 0 && sw / n >= 0.4;
    const JP = !!this.input.jump;
    if (JP && !this._jh) {
      this._buf = this.jumpBuffer;
    }
    this._jh = JP;
    if (this.ground) {
      this._coy = this.coyote;
    } else if (this._coy > 0) {
      this._coy--;
    }
    const AX = this.input.x || 0;
    if (this.swim) {
      this.vx = (this.vx + AX * this.accel * 0.55) * 0.85;
      this.vy = (this.vy + this.gravity * 0.25 - (this.input.jump ? 0.15 : 0)) * 0.9;
    } else {
      this.vx = (this.vx + AX * this.accel) * (this.sensor ? 1 : this.friction);
      this.vy = Math.min(this.vy + this.gravity, this.maxFall);
      if (this._buf > 0 && this._coy > 0) {
        this.vy = -this.jumpV;
        this._buf = 0;
        this._coy = 0;
        this._jumping = true;
      } else if (!JP && this._jumping && this.vy < 0) {
        this.vy *= this.jumpCut;
        this._jumping = false;
      }
      if (this.vy >= 0) {
        this._jumping = false;
      }
    }
    if (this.vy < -this.maxRise && !this._jumping) {
      this.vy = -this.maxRise;
    }
    if (this._buf > 0) {
      this._buf--;
    }
    if (this.sensor) {
      this.x += this.vx;
      this.y += this.vy;
    } else {
      if (this.ground && this._ride) {
        const RX = this._ride.vx;
        if (RX && !this._hit(wValue, this.x + RX, this.y)) {
          this.x += RX;
        }
      }
      this._ride = null;
      const SX = Math.max(1, Math.ceil(Math.abs(this.vx))), DX = this.vx / SX;
      for (let s = 0; s < SX; s++) {
        const K_VALUE = this._hit(wValue, this.x + DX, this.y), RH = K_VALUE === 2 ? this._rg : null, EH = K_VALUE === 3 ? this._eg : null;
        if (!K_VALUE) {
          this.x += DX;
        } else {
          let ok = false;
          for (let up = 1; up <= this.stepUp && !ok; up++) {
            if (!this._hit(wValue, this.x + DX, this.y - up)) {
              this.x += DX;
              this.y -= up;
              ok = true;
            }
          }
          if (!ok) {
            if (RH) {
              const V = (this.mass * this.vx + RH.mass * RH.vx) / (this.mass + RH.mass);
              wValue.bridge.setVelocity(RH, V, RH.vy);
              this.vx = V;
            } else if (EH) {
              const V = (this.mass * this.vx + EH.mass * EH.vx) / (this.mass + EH.mass);
              EH.vx = V;
              this.vx = V;
            } else {
              this.vx = 0;
            }
            break;
          }
        }
      }
      this.ground = false;
      const SY = Math.max(1, Math.ceil(Math.abs(this.vy))), DY = this.vy / SY;
      for (let s = 0; s < SY; s++) {
        const K_VALUE = this._hit(wValue, this.x, this.y + DY);
        if (!K_VALUE) {
          this.y += DY;
        } else {
          if (DY > 0) {
            this.ground = true;
            if (K_VALUE === 2) {
              const B = wValue.bridge;
              this._ride = this._rg;
              B.applyForce(this._rg, this.x, this.y + this.hy, 0, this.mass * B.gravityScale);
            } else if (K_VALUE === 3) {
              this._ride = this._eg;
            }
          }
          this.vy = 0;
          break;
        }
      }
    }
    for (const [T, C_VALUE] of CNT) {
      const M_VALUE = wValue.mats[T], E = M_VALUE.body;
      if (this.onContact && this.onContact(M_VALUE, C_VALUE, this) === true) {
        continue;
      }
      if (!E) {
        continue;
      }
      if (E.damage) {
        this.hurt(E.damage);
      }
      if (E.status) {
        this.status[E.status[0]] = Math.max(this.status[E.status[0]] || 0, E.status[1]);
      }
    }
    for (const K_VALUE in this.status) {
      const S_VALUE = wValue.statuses[K_VALUE] || {};
      if (S_VALUE.clearedBy && S_VALUE.clearedBy.some((nm) => (CNT.get(wValue.id[nm]) || 0) / (n || 1) >= 0.3)) {
        delete this.status[K_VALUE];
        continue;
      }
      if (--this.status[K_VALUE] <= 0) {
        delete this.status[K_VALUE];
        continue;
      }
      if (S_VALUE.damage) {
        this.hurt(S_VALUE.damage);
      }
      if (S_VALUE.emit && wValue.rand() < S_VALUE.emit.chance) {
        const FX = Math.floor(this.x - this.hx) + wValue.rnd(Math.ceil(this.hx * 2)), FY = Math.floor(this.y - this.hy) - 1;
        if (wValue.get(FX, FY) === 0) {
          wValue.set(FX, FY, S_VALUE.emit.material);
        }
      }
      if (S_VALUE.tick) {
        S_VALUE.tick(this, wValue);
      }
    }
  }
};

// modules/pixel-physics/pixels.js
var GRID_BACKGROUND = 255 << 24 | 26 << 16 | 22 << 8 | 20;
function createGridShade(cellCount) {
  const OUT = new Uint8Array(cellCount);
  for (let i = 0; i < cellCount; i++) {
    OUT[i] = (i * 2654435761 >>> 0) % 8;
  }
  return OUT;
}
function writeGridPixels(world, pixels, shade, background = GRID_BACKGROUND, view = null) {
  const { w: W, h: H } = world;
  if (shade.length !== W * H) {
    throw new RangeError("shade의 길이는 w*h여야 합니다.");
  }
  const VX = view ? view.x : 0, VY = view ? view.y : 0, VW = view ? view.w : W, VH = view ? view.h : H;
  if (![VX, VY, VW, VH].every(Number.isInteger) || VW < 0 || VH < 0) {
    throw new RangeError("view는 정수 {x, y, w, h}이고 w, h는 0 이상이어야 합니다.");
  }
  if (pixels.length !== VW * VH) {
    throw new RangeError(
      view ? "pixels의 길이는 view.w*view.h여야 합니다." : "pixels와 shade의 길이는 w*h여야 합니다."
    );
  }
  if (world.dirty) {
    world._compile();
  }
  const { g: G, life: LIFE, PAL, FL } = world;
  const X0 = Math.max(0, VX), X1 = Math.min(W, VX + VW);
  for (let r = 0; r < VH; r++) {
    const Y = VY + r, OUT = r * VW;
    if (Y < 0 || Y >= H || X0 >= X1) {
      pixels.fill(background, OUT, OUT + VW);
      continue;
    }
    pixels.fill(background, OUT, OUT + (X0 - VX));
    pixels.fill(background, OUT + (X1 - VX), OUT + VW);
    const SY = ((world.originY + Y) % H + H) % H;
    let sx = ((world.originX + X0) % W + W) % W;
    for (let x = X0, i = Y * W + X0, o = OUT + (X0 - VX); x < X1; x++, i++, o++) {
      const T = G[i], S = SY * W + sx;
      pixels[o] = T ? PAL[T * 8 + (FL[T] ? LIFE[i] + S & 7 : shade[S])] : background;
      if (++sx === W) {
        sx = 0;
      }
    }
  }
}

// modules/pixel-physics/renderer.js
var PixelRenderer = class {
  /** view = {x, y, w, h}(창 좌표)를 주면 그 사각형만 그립니다. 생략하면 전체 격자입니다. */
  constructor(canvas, world, { overlay = null, view = null } = {}) {
    this.ov = overlay;
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.world = world;
    this.sh = createGridShade(world.w * world.h);
    this.bg = GRID_BACKGROUND;
    this.setView(view);
  }
  /**
   * 그릴 사각형을 바꿉니다(null이면 전체). 크기가 바뀔 때만 캔버스와 버퍼를 다시 만들고, 같은 크기로 위치만 옮기면 비용이 없습니다.
   * 격자 밖에 걸친 부분은 배경색입니다. 개체와 extra 훅은 창 좌표 그대로 그리면 view에 맞춰 이동됩니다.
   */
  setView(view) {
    const V = view ?? { x: 0, y: 0, w: this.world.w, h: this.world.h };
    if (![V.x, V.y, V.w, V.h].every(Number.isInteger) || V.w <= 0 || V.h <= 0) {
      throw new RangeError("view는 정수 {x, y, w, h}이고 w, h는 1 이상이어야 합니다.");
    }
    if (!this.view || this.view.w !== V.w || this.view.h !== V.h) {
      this.canvas.width = V.w;
      this.canvas.height = V.h;
      this.img = this.ctx.createImageData(V.w, V.h);
      this.px = new Uint32Array(this.img.data.buffer);
    }
    this.view = { x: V.x, y: V.y, w: V.w, h: V.h };
  }
  draw(drawBody, extra) {
    const W = this.world, V = this.view;
    writeGridPixels(W, this.px, this.sh, this.bg, V);
    this.ctx.putImageData(this.img, 0, 0);
    const F = drawBody || this.drawBody;
    if (this.ov) {
      const O = this.ov, R = O.getBoundingClientRect(), D = window.devicePixelRatio || 1, PW = Math.round(R.width * D), PH = Math.round(R.height * D);
      if (O.width !== PW || O.height !== PH) {
        O.width = PW;
        O.height = PH;
      }
      const C = O.getContext("2d");
      C.clearRect(0, 0, PW, PH);
      const S = PW / V.w;
      C.save();
      C.translate(-V.x * S, -V.y * S);
      for (const B of W.bodies) {
        F(C, B, S);
      }
      if (extra) {
        extra(C, S);
      }
      C.restore();
    } else {
      this.ctx.save();
      this.ctx.translate(-V.x, -V.y);
      for (const B of W.bodies) {
        F(this.ctx, B, 1);
      }
      if (extra) {
        extra(this.ctx, 1);
      }
      this.ctx.restore();
    }
  }
  drawBody(ctx, b, s = 1) {
    ctx.fillStyle = b.status.burn ? "#ffc23a" : b.color;
    if (b.shape === "circle") {
      ctx.beginPath();
      ctx.arc(b.x * s, b.y * s, b.r * s, 0, 7);
      ctx.fill();
    } else {
      ctx.fillRect((b.x - b.hx) * s, (b.y - b.hy) * s, b.w * s, b.h * s);
    }
    if (b.showHp) {
      const X = (b.x - b.hx - 1) * s, Y = (b.y - b.hy - 3) * s, W_VALUE = (b.hx * 2 + 2) * s;
      ctx.fillStyle = "#c33";
      ctx.fillRect(X, Y, W_VALUE, s);
      ctx.fillStyle = "#4c4";
      ctx.fillRect(X, Y, W_VALUE * Math.max(0, b.hp) / b.maxHp, s);
    }
  }
};

// modules/deterministic/value-codec.js
var TYPED_KINDS = [
  [Int8Array, "getInt8", "setInt8", 1],
  [Int16Array, "getInt16", "setInt16", 2],
  [Uint16Array, "getUint16", "setUint16", 2],
  [Int32Array, "getInt32", "setInt32", 4],
  [Uint32Array, "getUint32", "setUint32", 4],
  [Float32Array, "getFloat32", "setFloat32", 4],
  [Float64Array, "getFloat64", "setFloat64", 8]
];
var FLOAT_KIND_START = 5;
var SCRATCH_LIMIT = 8 * 1024 * 1024;
function typedKindOf(value) {
  for (let i = 0; i < TYPED_KINDS.length; i++) {
    if (value instanceof TYPED_KINDS[i][0]) {
      return i;
    }
  }
  return -1;
}
function createValueCodec({
  format = "binary",
  maxBytes = 16 * 1024 * 1024,
  maxDepth = 128,
  maxEntries = 1e6,
  omitUndefined = false
} = {}) {
  if (!["binary", "json"].includes(format)) {
    throw new TypeError("Unknown codec format");
  }
  if (typeof omitUndefined !== "boolean") {
    throw new TypeError("omitUndefined must be boolean");
  }
  const KEYS_OF = (value) => Object.keys(value).filter((key) => !omitUndefined || value[key] !== void 0).sort();
  for (const LIMIT of [maxBytes, maxDepth, maxEntries]) {
    if (!Number.isSafeInteger(LIMIT) || LIMIT < 1) {
      throw new RangeError("Invalid codec limit");
    }
  }
  const ENCODER = new TextEncoder(), DECODER = new TextDecoder("utf-8", {
    fatal: true,
    ignoreBOM: true
  });
  function normalize(value, depth = 0, seen = /* @__PURE__ */ new Set(), budget = {
    count: 0
  }) {
    if (depth > maxDepth || ++budget.count > maxEntries) {
      throw new RangeError("Value codec budget exceeded");
    }
    if (value === null || typeof value === "boolean") {
      return value;
    }
    if (typeof value === "number") {
      if (!Number.isFinite(value)) {
        throw new TypeError("Finite numbers required");
      }
      return Object.is(value, -0) ? 0 : value;
    }
    if (typeof value === "string") {
      if (DECODER.decode(ENCODER.encode(value)) !== value) {
        throw new TypeError("Invalid Unicode string");
      }
      return value;
    }
    if (!value || typeof value !== "object" || seen.has(value)) {
      throw new TypeError("Unsupported or cyclic value");
    }
    seen.add(value);
    let result;
    if (value instanceof Uint8Array || typedKindOf(value) >= 0) {
      if (format === "json") {
        throw new TypeError("JSON codec does not support byte values");
      }
      result = value;
    } else if (Array.isArray(value)) {
      result = Array.from(value, (item) => normalize(item, depth + 1, seen, budget));
    } else {
      if (![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
        throw new TypeError("Plain records required");
      }
      result = {};
      for (const KEY of KEYS_OF(value)) {
        normalize(KEY, depth + 1, seen, budget);
        Object.defineProperty(result, KEY, {
          value: normalize(value[KEY], depth + 1, seen, budget),
          enumerable: true,
          writable: true,
          configurable: true
        });
      }
    }
    seen.delete(value);
    return result;
  }
  let scratch = null, encoding = false;
  const STRING_CACHE = /* @__PURE__ */ new Map();
  let cachedStringBytes = 0;
  function stringBytes(value) {
    let data = STRING_CACHE.get(value);
    if (data) {
      return data;
    }
    for (let i = 0; i < value.length; i++) {
      const C = value.charCodeAt(i);
      if (C >= 55296 && C <= 56319) {
        const NEXT = value.charCodeAt(++i);
        if (!(NEXT >= 56320 && NEXT <= 57343)) {
          throw new TypeError("Invalid Unicode string");
        }
      } else if (C >= 56320 && C <= 57343) {
        throw new TypeError("Invalid Unicode string");
      }
    }
    data = ENCODER.encode(value);
    if (data.length <= 256 && STRING_CACHE.size < 1024 && cachedStringBytes + data.length <= 131072) {
      STRING_CACHE.set(value, data);
      cachedStringBytes += data.length;
    }
    return data;
  }
  function encode(value) {
    if (format === "json") {
      const BYTES = ENCODER.encode(JSON.stringify(normalize(value)));
      if (BYTES.length > maxBytes) {
        throw new RangeError("Codec byte budget exceeded");
      }
      return BYTES;
    }
    const NESTED = encoding;
    encoding = true;
    let bytes = !NESTED && scratch ? scratch : new Uint8Array(Math.min(1024, maxBytes));
    let offset = 0;
    let view = new DataView(bytes.buffer);
    let entries = 0;
    const SEEN = /* @__PURE__ */ new Set(), STRINGS = /* @__PURE__ */ new Map();
    function reserve(size) {
      if (offset + size > maxBytes) {
        throw new RangeError("Codec byte budget exceeded");
      }
      if (offset + size > bytes.length) {
        const NEXT = new Uint8Array(Math.min(maxBytes, Math.max(offset + size, bytes.length * 2)));
        NEXT.set(bytes);
        bytes = NEXT;
        view = new DataView(bytes.buffer);
      }
    }
    function byte(n) {
      reserve(1);
      bytes[offset++] = n;
    }
    function length(n) {
      reserve(4);
      view.setUint32(offset, n, true);
      offset += 4;
    }
    function raw(data) {
      length(data.length);
      reserve(data.length);
      bytes.set(data, offset);
      offset += data.length;
    }
    function variable(n) {
      while (n >= 128) {
        byte(n % 128 + 128);
        n = Math.floor(n / 128);
      }
      byte(n);
    }
    function write(v, depth = 0) {
      if (depth > maxDepth || ++entries > maxEntries) {
        throw new RangeError("Value codec budget exceeded");
      }
      if (v === null) {
        byte(0);
      } else if (v === false) {
        byte(1);
      } else if (v === true) {
        byte(2);
      } else if (typeof v === "number") {
        if (!Number.isFinite(v)) {
          throw new TypeError("Finite numbers required");
        }
        if (Number.isInteger(v) && v >= -2147483648 && v <= 2147483647) {
          byte(8);
          variable(v < 0 ? -v * 2 - 1 : v * 2);
        } else {
          byte(3);
          reserve(8);
          view.setFloat64(offset, v, true);
          offset += 8;
        }
      } else if (typeof v === "string") {
        const REF = STRINGS.get(v);
        if (REF !== void 0) {
          byte(9);
          variable(REF);
        } else {
          STRINGS.set(v, STRINGS.size);
          byte(4);
          raw(stringBytes(v));
        }
      } else {
        if (!v || typeof v !== "object" || SEEN.has(v)) {
          throw new TypeError("Unsupported or cyclic value");
        }
        if (v instanceof Uint8Array) {
          byte(7);
          raw(v);
          return;
        }
        const KIND = typedKindOf(v);
        if (KIND >= 0) {
          const [, , SET, SIZE] = TYPED_KINDS[KIND];
          byte(10);
          byte(KIND);
          length(v.length);
          reserve(v.length * SIZE);
          for (let i = 0; i < v.length; i++) {
            let element = v[i];
            if (KIND >= FLOAT_KIND_START) {
              if (!Number.isFinite(element)) {
                throw new TypeError("Finite numbers required");
              }
              if (element === 0) {
                element = 0;
              }
            }
            view[SET](offset, element, true);
            offset += SIZE;
          }
          return;
        }
        SEEN.add(v);
        if (Array.isArray(v)) {
          byte(5);
          length(v.length);
          for (const ITEM of v) {
            write(ITEM, depth + 1);
          }
        } else {
          const PROTOTYPE = Object.getPrototypeOf(v);
          if (PROTOTYPE !== Object.prototype && PROTOTYPE !== null) {
            throw new TypeError("Plain records required");
          }
          byte(6);
          const KEYS = KEYS_OF(v);
          length(KEYS.length);
          for (const KEY of KEYS) {
            write(KEY, depth + 1);
            write(v[KEY], depth + 1);
          }
        }
        SEEN.delete(v);
      }
    }
    try {
      byte(82);
      byte(86);
      byte(1);
      write(value);
      return bytes.slice(0, offset);
    } finally {
      if (!NESTED) {
        scratch = bytes.length <= SCRATCH_LIMIT ? bytes : null;
        encoding = false;
      }
    }
  }
  function decode2(input) {
    const BYTES = input instanceof Uint8Array ? input : input instanceof ArrayBuffer ? new Uint8Array(input) : ArrayBuffer.isView(input) ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength) : null;
    if (!BYTES || BYTES.length > maxBytes) {
      throw new RangeError("Invalid codec bytes");
    }
    let result;
    if (format === "json") {
      result = normalize(JSON.parse(DECODER.decode(BYTES)));
    } else {
      let need = function(n) {
        if (n > BYTES.length - offset) {
          throw new RangeError("Truncated codec bytes");
        }
      }, byte = function() {
        need(1);
        return BYTES[offset++];
      }, length = function() {
        need(4);
        const N = VIEW.getUint32(offset, true);
        offset += 4;
        return N;
      }, raw = function() {
        const N = length();
        need(N);
        const DATA = BYTES.subarray(offset, offset + N);
        offset += N;
        return DATA;
      }, read = function(depth = 0) {
        if (depth > maxDepth || ++entries > maxEntries) {
          throw new RangeError("Value codec budget exceeded");
        }
        const TAG = byte();
        if (TAG === 0) {
          return null;
        }
        if (TAG === 1) {
          return false;
        }
        if (TAG === 2) {
          return true;
        }
        if (TAG === 3) {
          need(8);
          const N2 = VIEW.getFloat64(offset, true);
          offset += 8;
          if (!Number.isFinite(N2) || Object.is(N2, -0) || Number.isInteger(N2) && N2 >= -2147483648 && N2 <= 2147483647) {
            throw new TypeError("Noncanonical number");
          }
          return N2;
        }
        if (TAG === 8 || TAG === 9) {
          let n = 0;
          let scale = 1;
          let part;
          for (let i = 0; i < 5; i++) {
            part = byte();
            n += (part & 127) * scale;
            if (n > 4294967295) {
              throw new TypeError("Integer overflow");
            }
            if (part < 128) {
              if (i && part === 0) {
                throw new TypeError("Noncanonical integer");
              }
              if (TAG === 9) {
                if (n >= STRINGS.length) {
                  throw new TypeError("Invalid string reference");
                }
                return STRINGS[n];
              }
              return n % 2 ? -(n + 1) / 2 : n / 2;
            }
            scale *= 128;
          }
          throw new TypeError("Invalid integer");
        }
        if (TAG === 4) {
          const VALUE = DECODER.decode(raw());
          if (STRING_SET.has(VALUE)) {
            throw new TypeError("Noncanonical repeated string");
          }
          STRING_SET.add(VALUE);
          STRINGS.push(VALUE);
          return VALUE;
        }
        if (TAG === 7) {
          return raw().slice();
        }
        if (TAG === 10) {
          const KIND = byte();
          if (KIND >= TYPED_KINDS.length) {
            throw new TypeError("Invalid typed array kind");
          }
          const [TYPE, GET, , SIZE] = TYPED_KINDS[KIND];
          const COUNT = length();
          need(COUNT * SIZE);
          const ARRAY = new TYPE(COUNT);
          for (let i = 0; i < COUNT; i++) {
            const ELEMENT = VIEW[GET](offset, true);
            if (KIND >= FLOAT_KIND_START && (!Number.isFinite(ELEMENT) || Object.is(ELEMENT, -0))) {
              throw new TypeError("Noncanonical typed array number");
            }
            ARRAY[i] = ELEMENT;
            offset += SIZE;
          }
          return ARRAY;
        }
        if (TAG !== 5 && TAG !== 6) {
          throw new TypeError("Invalid codec tag");
        }
        const N = length();
        if (N > maxEntries - entries) {
          throw new RangeError("Value codec budget exceeded");
        }
        if (TAG === 5) {
          const ARR = [];
          for (let i = 0; i < N; i++) {
            ARR.push(read(depth + 1));
          }
          return ARR;
        }
        const OBJ = {};
        let previous;
        for (let i = 0; i < N; i++) {
          const KEY = read(depth + 1);
          if (typeof KEY !== "string" || i && KEY <= previous) {
            throw new TypeError("Noncanonical record key");
          }
          if (KEY === "__proto__") {
            Object.defineProperty(OBJ, KEY, {
              value: read(depth + 1),
              enumerable: true,
              writable: true,
              configurable: true
            });
          } else {
            OBJ[KEY] = read(depth + 1);
          }
          previous = KEY;
        }
        return OBJ;
      };
      let offset = 0;
      let entries = 0;
      const STRINGS = [], STRING_SET = /* @__PURE__ */ new Set();
      const VIEW = new DataView(BYTES.buffer, BYTES.byteOffset, BYTES.byteLength);
      if (byte() !== 82 || byte() !== 86 || byte() !== 1) {
        throw new TypeError("Invalid codec header");
      }
      result = read();
      if (offset !== BYTES.length) {
        throw new TypeError("Trailing codec bytes");
      }
    }
    if (format === "json") {
      const CANONICAL = encode(result);
      if (CANONICAL.length !== BYTES.length || CANONICAL.some((v, i) => v !== BYTES[i])) {
        throw new TypeError("Noncanonical codec bytes");
      }
    }
    return result;
  }
  return Object.freeze({
    format,
    encode,
    decode: decode2
  });
}
var BINARY_CODEC = createValueCodec();
var JSON_CODEC = createValueCodec({
  format: "json"
});

// modules/pixel-physics/snapshot.js
var CODEC = createValueCodec({
  format: "binary",
  maxBytes: 64 << 20,
  maxEntries: 1 << 22,
  maxDepth: 64,
  omitUndefined: true
});
var GRID_KEYS = ["g", "life", "u", "awake", "reac"];
var RAW = 0;
var RUNS = 1;
function encodeGrid(array) {
  const LIMIT = array.length;
  const OUT = new Uint8Array(LIMIT + 1);
  OUT[0] = RUNS;
  let used = 1;
  for (let i = 0; i < LIMIT; ) {
    const VALUE = array[i];
    let end = i + 1;
    while (end < LIMIT && array[end] === VALUE) {
      end++;
    }
    let rest = end - i - 1;
    if (used + 2 > LIMIT) {
      used = LIMIT + 1;
      break;
    }
    OUT[used++] = VALUE;
    while (rest >= 128) {
      if (used + 1 > LIMIT) {
        used = LIMIT + 1;
        break;
      }
      OUT[used++] = rest % 128 + 128;
      rest = Math.floor(rest / 128);
    }
    if (used > LIMIT) {
      break;
    }
    OUT[used++] = rest;
    i = end;
  }
  if (used <= LIMIT) {
    return OUT.slice(0, used);
  }
  const RAW_OUT = new Uint8Array(LIMIT + 1);
  RAW_OUT[0] = RAW;
  RAW_OUT.set(array, 1);
  return RAW_OUT;
}
function decodeGrid(data, length) {
  if (!(data instanceof Uint8Array) || data.length < 1) {
    throw new RangeError("격자 형식이 잘못됐습니다.");
  }
  if (data[0] === RAW) {
    if (data.length !== length + 1) {
      throw new RangeError("격자 길이가 다릅니다.");
    }
    return data.slice(1);
  }
  if (data[0] !== RUNS) {
    throw new RangeError("알 수 없는 격자 방식입니다.");
  }
  const OUT = new Uint8Array(length);
  let at = 0, previous = -1;
  for (let i = 1; i < data.length; ) {
    const VALUE = data[i++];
    let run = 0, scale = 1, part;
    do {
      if (i >= data.length || scale > 2 ** 28) {
        throw new RangeError("격자 구간이 잘렸습니다.");
      }
      part = data[i++];
      run += (part & 127) * scale;
      scale *= 128;
    } while (part >= 128);
    if (VALUE === previous || part === 0 && scale > 128 || at + run + 1 > length) {
      throw new RangeError("격자 구간이 비정규이거나 범위를 넘습니다.");
    }
    OUT.fill(VALUE, at, at + run + 1);
    at += run + 1;
    previous = VALUE;
  }
  if (at !== length) {
    throw new RangeError("격자 길이가 다릅니다.");
  }
  return OUT;
}
function ref(o) {
  if (o === null || o === void 0) {
    return null;
  }
  if (o instanceof Body) {
    if (o.eid === void 0) {
      throw new Error("eid가 없는 엔티티입니다. world.bodies.push 대신 world.addEntity를 사용하세요.");
    }
    return "e" + o.eid;
  }
  if (o.body && o.desc && typeof o.id === "number") {
    return "h" + o.id;
  }
  if (typeof o.id === "number" && "stiff" in o) {
    return "j" + o.id;
  }
  throw new Error("snapshot이 알 수 없는 객체를 참조합니다.");
}
function packCells(cells) {
  const OUT = new Int32Array(cells.length * 3);
  cells.forEach((c, i) => {
    OUT[i * 3] = c.x;
    OUT[i * 3 + 1] = c.y;
    OUT[i * 3 + 2] = c.t;
  });
  return OUT;
}
function unpackCells(flat) {
  const OUT = [];
  for (let i = 0; i < flat.length; i += 3) {
    OUT.push({ x: flat[i], y: flat[i + 1], t: flat[i + 2] });
  }
  return OUT;
}
function savePixelWorld(world) {
  const S = world.snapshot(false);
  const OUT = { ...S, entRefs: S.entRefs.map(ref), proj: S.proj.map((p) => ({ ...p, src: ref(p.src) })) };
  for (const KEY of GRID_KEYS) {
    OUT[KEY] = encodeGrid(S[KEY]);
  }
  OUT.ents = S.ents.map((e) => ({ ...e, _ride: ref(e._ride) }));
  if (S.bridge) {
    OUT.bridge = {
      ...S.bridge,
      bs: S.bridge.bs.map((r) => ({ ...r, h: ref(r.h), cells: r.cells && packCells(r.cells) })),
      js: S.bridge.js.map((r) => ({ ...r, j: ref(r.j), a: ref(r.a), b: ref(r.b) }))
    };
  }
  return CODEC.encode(OUT);
}
function decode(world, bytes) {
  const V = CODEC.decode(bytes);
  for (const KEY of GRID_KEYS) {
    V[KEY] = decodeGrid(V[KEY], world[KEY].length);
  }
  if (!Number.isFinite(V.originX) || !Number.isFinite(V.originY)) {
    throw new RangeError(
      "창 원점(originX, originY)이 없는 snapshot입니다. v0.15.0 이전 SDK에서 만든 바이트입니다."
    );
  }
  if (Boolean(V.bridge) !== Boolean(world.bridge)) {
    throw new RangeError("강체 브리지 유무가 다른 snapshot입니다.");
  }
  return V;
}
function validatePixelWorld(world, bytes) {
  try {
    decode(world, bytes);
    return true;
  } catch {
    return false;
  }
}
function loadPixelWorld(world, bytes, { createBody } = {}) {
  const V = decode(world, bytes);
  const ENTITIES = new Map(world.bodies.map((b) => [b.eid, b]));
  const ENTITY = (id, state) => {
    let b = ENTITIES.get(id);
    if (!b) {
      if (typeof createBody !== "function") {
        throw new Error(`엔티티 e${id}가 없습니다. createBody(eid, state)를 전달하세요.`);
      }
      b = createBody(id, state);
      if (!(b instanceof Body)) {
        throw new TypeError("createBody는 Body를 반환해야 합니다.");
      }
      b.eid = id;
      ENTITIES.set(id, b);
    }
    return b;
  };
  const HANDLES = new Map((world.bridge?.bodies ?? []).map((h) => [h.id, h]));
  const JOINTS = new Map((world.bridge?.joints ?? []).map((j) => [j.id, j]));
  const HANDLE = (id, rec) => {
    let h = HANDLES.get(id);
    if (!h) {
      h = {
        id,
        desc: rec?.desc,
        x: 0,
        y: 0,
        angle: 0,
        w: 0,
        h: 0,
        mass: 0,
        area: 0,
        vx: 0,
        vy: 0,
        av: 0,
        data: {},
        pins: [],
        _cons: []
      };
      HANDLES.set(id, h);
    }
    return h;
  };
  const RESOLVE = (r) => {
    if (r === null || r === void 0) {
      return null;
    }
    const ID = Number(r.slice(1));
    if (r[0] === "e") {
      return ENTITIES.get(ID) ?? ENTITY(ID, V.ents[V.entRefs.indexOf(r)]);
    }
    if (r[0] === "h") {
      return HANDLES.get(ID) ?? HANDLE(ID);
    }
    return JOINTS.get(ID);
  };
  const S = { ...V };
  S.entRefs = V.entRefs.map((r, i) => ENTITY(Number(r.slice(1)), V.ents[i]));
  if (V.bridge) {
    const BRIDGE = V.bridge;
    BRIDGE.bs.forEach((r) => HANDLE(Number(r.h.slice(1)), r));
    BRIDGE.js.forEach((r) => {
      const ID = Number(r.j.slice(1));
      if (!JOINTS.has(ID)) {
        JOINTS.set(ID, { id: ID, a: null, b: null, c: null });
      }
    });
    S.bridge = {
      ...BRIDGE,
      bs: BRIDGE.bs.map((r) => ({ ...r, h: RESOLVE(r.h), cells: r.cells && unpackCells(r.cells) })),
      js: BRIDGE.js.map((r) => ({ ...r, j: RESOLVE(r.j), a: RESOLVE(r.a), b: RESOLVE(r.b) }))
    };
  }
  S.proj = V.proj.map((p) => ({ ...p, src: p.src ? RESOLVE(p.src) : void 0 }));
  S.ents = V.ents.map((e) => ({ ...e, _ride: RESOLVE(e._ride) }));
  world.restore(S);
}
export {
  Body,
  GRID_BACKGROUND,
  MatterBridge,
  PhysicsBridge,
  PixelRenderer,
  PixelWorld,
  createGridShade,
  hashCell,
  HYP as hyp,
  installDeterministicTrig,
  loadPixelWorld,
  NOW as now,
  savePixelWorld,
  validatePixelWorld,
  writeGridPixels
};

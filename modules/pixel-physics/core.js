import Matter from 'matter-js';

/**
 * 사용자 제공 PixelPhysics의 동작 보존 이전입니다. 시간·snapshot·전역 Math 교체의
 * 제한은 README.md를 따릅니다. 아래 원본 API 설명은 교차 환경 결정성 보장이 아닙니다.
 */
/* =====================================================================
 * PixelPhysics 픽셀·강체 물리 — pixel-physics.js 단일 배포 모듈
 *
 *  const world = new PixelWorld(w, h, {seed});
 *  world.define({name, kind:'solid|powder|liquid|gas', density, dispersion, rise, slow,
 *                color:[r,g,b], life:[min,max], decay:{to,chance}, flicker, noSwap, indestructible,
 *                blast:{debris,debrisChance,burn,burnChance},          // 폭발 시 처리
 *                body:{blocks, swim, damage, status:[name,frames]},    // 개체에 주는 기본 효과
 *                reactions:[{with:name|[names], chance, self:name, other:name}],  // 선언형 반응
 *                react(ctx){...return true}});                         // 코드형 반응(콜백)
 *  world.defineStatus(name,{damage, emit:{material,chance}, clearedBy:[materials], tick(body,world)});
 *  world.addEntity(new Body({shape:'box'|'circle', x,y,w,h,r, sensor, onContact, onOverlap, onDeath}));
 *  world.tick();  world.explode(x,y,r);  world.carve(x,y,r);  world.paint(x,y,r,mat);  world.rect(...)
 *  new PixelRenderer(canvas, world, {overlay: 고해상도 canvas}).draw(drawBodyFn?)
 *     // drawBodyFn(ctx, body, scale): 개체를 화면 해상도로 직접 그리는 훅 (scale = 화면px / 격자셀)
 *  world.attachBridge(new MatterBridge());   // 강체 연동. 재료의 strength: 충격 에너지가 이보다 크면 깎임
 *  // 강체 -> 입자: 유령 solid로 밀어냄(수면 상승, 모래가 위에 쌓임), 잠긴 셀 기준 부력
 *  // 입자 -> 강체: 윗면에 쌓인 가루 기둥의 무게가 강체를 누름
 *  world.on('chip'|'explosion'|'hit', fn);   // hit: 강체가 엔티티를 때림. 엔티티는 강체를 막힘/밀기/탑승으로 상호작용
 *    bridge.addBox({x,y,w,h,density,vx,vy})  // 지형 셀이 SSOT, 변화는 청크 dirty 이벤트로 전달
 *  world.snapshot() / restore(s) / hash() / isCheckpoint()   // 롤백, 리플레이, 디싱크 검출
 *    락스텝용: 같은 시드 + 같은 입력 + new MatterBridge({deterministic:true}) + installDeterministicTrig() (Matter 생성 전)
 *    스냅샷은 isCheckpoint()가 true인 틱에서 찍으면 복원 후 재실행이 비트 단위로 일치
 *  world.spray(x,y,vx,vy,mat,{shooter,recoil})   // 유체 발사: 날아가다 막힌 곳에 그 재료 셀로 내려앉음. shooter(엔티티/강체)는 밀도 x 속도만큼 반발력을 받고,
 *                                              //   맞은 엔티티/강체도 같은 운동량으로 밀림 (world.jetPush로 세기 조절, 강체는 맞은 지점 기준이라 회전도 함)
 *  재료 push: 분사 운동량 밀도(기본은 density). 기체는 density가 작아 push를 크게 줘야 제트팩처럼 밀어줌. Body.maxRise: 상승 속도 한계
 *  world.sleepEnabled / world.stats / bridge.addPin(h,ax,ay,lx,ly,len)   // 청크 sleep, 통계, 줄
 *  --- 강체 형상 / 조인트 ---
 *  bridge.addBox({x,y,w,h}) / addCircle({x,y,r}) / addPolygon({x,y,sides,r}) / addConvex({x,y,verts}) / addBody({kind:'compound',parts:[{x,y,w,h,density}],x,y,angle,...})
 *     공통 옵션: density, friction, restitution, vx, vy, angle, group(같은 음수 group끼리는 충돌 안 함), data. 형상 질의는 bridge.getPolys(h)/getBounds(h) (월드 좌표 볼록 다각형)
 *  bridge.addJoint({a,b?,ax,ay,bx,by,len,stiff,damping})  // a의 로컬 앵커 ↔ b의 로컬 앵커 (b 없으면 월드 고정점). len=0,stiff=1:경첩, len>0:줄/막대, stiff 작게:스프링. removeJoint(j)
 *  --- 지형 붕괴 / 파편화 ---
 *  world.enableCollapse({minCells,maxCells,interval,bake})  // 앵커(재료 anchor:true 또는 indestructible, 바닥/좌우 가장자리)와 8방향으로 안 이어진 고체 덩어리는
 *     // 마스크 강체(같은 재료 직사각형 부품의 복합체)로 변해 떨어지고, 쉬면 다시 지형 셀로 굳음(bake). 재료 rigid:{density}로 무게 지정. 이벤트: 'collapse','bake'
 *  강체 data.strength를 넘는 충격이면 world.fracture가 충돌점 주변으로 쪼갬 (data.mat 이 있는 박스/원 포함, 조각은 강체로 유지, 너무 작으면 가루). 이벤트: 'fracture'
 *  world.spawnCells(cells[{x,y,t}], {x,y,angle,vx,vy,av,data})  // 셀 집합 → 강체 (직접 쓸 수도 있음)
 *  Body.solid(기본 true): 엔티티끼리 서로 막고(AABB), 밀고(운동량 공유), 위에 서면 같이 이동. 센서는 제외
 * 내부는 속성 테이블(typed array)로 컴파일되고, 난수는 시드 고정이라 결정적입니다.
 * ===================================================================== */
const KINDS = { solid: 0, powder: 1, liquid: 2, gas: 3 };
function inPoly(v, px, py) {
    // 볼록 다각형 안에 점이 있는지 (감김 방향 무관)
    let p = 0,
        n = 0;
    for (let i = 0, l = v.length; i < l; i++) {
        const A = v[i],
            B_VALUE = v[i + 1 === l ? 0 : i + 1],
            C_VALUE = (B_VALUE.x - A.x) * (py - A.y) - (B_VALUE.y - A.y) * (px - A.x);
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
    // 볼록 다각형들(P)과 축정렬 박스(AABB)의 SAT 겹침 판정 (맞닿기만 하면 false)
    for (const V of pValue) {
        let ax = 1e9,
            bx = -1e9,
            ay = 1e9,
            by = -1e9;
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
            const A = V[i],
                B_VALUE = V[i + 1 === l ? 0 : i + 1],
                NX = B_VALUE.y - A.y,
                NY = A.x - B_VALUE.x;
            let pmin = 1e9,
                pmax = -1e9;
            for (const P_VALUE of V) {
                const D_VALUE = P_VALUE.x * NX + P_VALUE.y * NY;
                if (D_VALUE < pmin) {
                    pmin = D_VALUE;
                }
                if (D_VALUE > pmax) {
                    pmax = D_VALUE;
                }
            }
            const C0 = x0 * NX + y0 * NY,
                C1 = x1 * NX + y0 * NY,
                C2 = x0 * NX + y1 * NY,
                C3 = x1 * NX + y1 * NY,
                RMIN = Math.min(C0, C1, C2, C3),
                RMAX = Math.max(C0, C1, C2, C3);
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
    // 강체 핸들 vs AABB (브릿지가 주는 다각형 사용 → 박스/원/다각형/복합체 모두 동일하게 처리)
    const BD = bValue.getBounds(h);
    if (BD.x1 <= x0 || BD.x0 >= x1 || BD.y1 <= y0 || BD.y0 >= y1) {
        return false;
    }
    return polyHit(bValue.getPolys(h), x0, y0, x1, y1);
}
/* ---- 결정성 유틸: 같은 입력이면 모든 클라이언트에서 같은 결과가 나오도록 ---- */
const HYP = (x, y) => Math.sqrt(x * x + y * y); // Math.hypot은 엔진마다 결과가 다를 수 있음 (sqrt는 IEEE 정확)
const NOW = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
function dsin(x) {
    // + - * 만 쓰는 사인 (Math.sin은 브라우저/CPU마다 마지막 비트가 다를 수 있음)
    const TP = 6.283185307179586,
        H = 1.5707963267948966;
    x -= TP * Math.round(x / TP);
    if (x > H) {
        x = Math.PI - x;
    } else if (x < -H) {
        x = -Math.PI - x;
    }
    const Q = x * x;
    return (
        x *
        (1 +
            Q *
                (-1 / 6 +
                    Q * (1 / 120 + Q * (-1 / 5040 + Q * (1 / 362880 + Q * (-1 / 39916800 + Q * (1 / 6227020800)))))))
    );
}
function dcos(x) {
    return dsin(x + 1.5707963267948966);
}
function installDeterministicTrig() {
    Math.sin = dsin;
    Math.cos = dcos;
} // 전역 교체: Matter.js 내부 호출까지 결정적으로 만듦. Matter 생성 전에 호출
class PixelWorld {
    constructor(w, h, { seed = 1 } = {}) {
        this.w = w;
        this.h = h;
        const N_VALUE = w * h;
        this.g = new Uint8Array(N_VALUE);
        this.life = new Uint8Array(N_VALUE);
        this.u = new Uint8Array(N_VALUE);
        this.mats = [{ name: 'empty', kind: 'solid', color: [0, 0, 0], reactions: [] }];
        this.id = { empty: 0 };
        this.bodies = [];
        this.eseq = 1; // 엔티티 식별자 발급기: 바이트 snapshot이 엔티티를 가리키는 키
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
        this.sleepEnabled = true; // 청크 sleep: 변화 없고 반응 재료도 없는 청크는 스캔 생략
        this.chunkTick = new Uint32Array(NCH);
        this.pseq = 1;
        this.proj = [];
        this.stats = { active: NCH, total: NCH, ms: 0 }; // proj: 날아가는 유체 발사체, 청크(16x16) dirty 플래그
        this.bridge = null;
        this.gown = new Int16Array(N_VALUE);
        this.jetPush = 0.5;
        this.fp = new Uint8Array(N_VALUE); // gown: 유령 셀이 어느 강체 것인지, jetPush: 유체가 맞은 대상을 미는 세기 배율
        this._ghost = [];
        this.ghostId = null;
        this.ev = {};
        this.impactScale = 150;
        this.fluidScale = 0.0002;
        this._mk = new Int32Array(N_VALUE);
        this._mkId = 0;
        this.collapse = null;
        this.supDirty = false;
        this._supT = -99;
        this._sup = null;
        this._stk = null;
        this._sk = null;
        this._skId = 0; // 붕괴/파편화 작업 버퍼
        this.frag = { minCells: 3, maxPieces: 6, jitter: 1.6, kick: 0.35, hardening: 1.5, maxGen: 3, maxBodies: 70 };
    }
    rand() {
        let t = (this.seed += 0x6d2b79f5);
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }
    rnd(n) {
        return (this.rand() * n) | 0;
    }
    define(d) {
        const M_VALUE = {
            kind: 'solid',
            density: 50,
            dispersion: 0,
            rise: 0,
            slow: 0,
            color: [200, 200, 200],
            reactions: [],
            ...d,
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
            this.PU[i] = m.push ?? m.density; // PU: 분사 운동량 밀도 (기체는 밀도가 낮아 push로 따로 지정)
            this.ST[i] = i !== 0 && m.kind === 'solid' && !(m.body && m.body.blocks === false) ? 1 : 0;
            this.FL[i] = m.flicker ? 1 : 0;
            this.AN[i] = (m.anchor ?? m.indestructible) ? 1 : 0;
            this.SW[i] = m.body && m.body.swim ? 1 : 0;
            this.BL[i] =
                m.body && m.body.blocks != null ? +m.body.blocks : m.kind === 'solid' || m.kind === 'powder' ? 1 : 0;
            m.rx = m.reactions.map((r) => ({
                w: [].concat(r.with).map((n) => this.id[n]),
                chance: r.chance ?? 1,
                self: r.self == null ? -1 : this.id[r.self],
                other: r.other == null ? -1 : this.id[r.other],
            }));
            m.decayTo = m.decay ? (this.id[m.decay.to] ?? 0) : 0;
            m.act = !!(m.decay || m.rx.length || m.react);
            const C_VALUE = m.color;
            for (let v = 0; v < 8; v++) {
                const F_VALUE = 0.82 + v * 0.05;
                this.PAL[i * 8 + v] =
                    (255 << 24) |
                    (Math.min(255, (C_VALUE[2] * F_VALUE) | 0) << 16) |
                    (Math.min(255, (C_VALUE[1] * F_VALUE) | 0) << 8) |
                    Math.min(255, (C_VALUE[0] * F_VALUE) | 0);
            }
        });
        this.dirty = false;
    }
    _lf(id) {
        const M_VALUE = this.mats[id];
        return M_VALUE.life ? M_VALUE.life[0] + this.rnd(M_VALUE.life[1] - M_VALUE.life[0] + 1) : 0;
    }
    spray(x, y, vx, vy, mat, { shooter = null, recoil = 1 } = {}) {
        // 유체 발사: 셀이 아니라 발사체로 날아가다 처음 막힌 셀 앞에 그 재료의 셀로 내려앉음 (시드 RNG만 쓰므로 결정적, 스냅샷/해시에 포함)
        if (this.proj.length >= 600) {
            return;
        }
        const RID = typeof mat === 'string' ? this.id[mat] : mat;
        this.proj.push({
            x,
            y,
            vx,
            vy,
            id: typeof mat === 'string' ? this.id[mat] : mat,
            t: 0,
            ex: Math.floor(x),
            ey: Math.floor(y),
            src: shooter,
        }); // src: 쏜 쪽(처음 몇 틱은 자기 유체에 안 맞음). ex,ey: 마지막으로 지난 빈 셀 (틱을 넘겨도 유지)
        if (shooter) {
            // 반발력: 쏜 유체의 운동량(밀도 x 속도)만큼 쏜 쪽을 반대로 밈. 밀도는 부력·하중과 같은 환산(fluidScale)을 써서 재료 공통
            if (this.dirty) {
                this._compile();
            }
            const M_VALUE = this.PU[RID] * this.fluidScale * recoil,
                JX = -vx * M_VALUE,
                JY = -vy * M_VALUE;
            if (shooter.impulse) {
                shooter.impulse(JX / shooter.mass, JY / shooter.mass);
            } else if (this.bridge && shooter.body) {
                this.bridge.applyImpulse(shooter, JX, JY);
            }
        }
    }
    _drop(x, y, id) {
        // 발사체를 (x,y) 근처에서 가장 가까운 빈 셀에 내려놓음 (같은 줄·위쪽 반경 4칸, 가까운 순). 양을 최대한 보존
        if (x < 0 || y < 0) {
            return;
        }
        const G = this.g,
            W_VALUE = this.w,
            H_VALUE = this.h;
        if (!PixelWorld._OFF) {
            const O = [];
            for (let dy = 0; dy <= 4; dy++) {
                for (let dx = -4; dx <= 4; dx++) {
                    O.push([dx, dy]);
                }
            }
            O.sort((p, q) => p[0] * p[0] + p[1] * p[1] - (q[0] * q[0] + q[1] * q[1]) || p[1] - q[1] || p[0] - q[0]);
            PixelWorld._OFF = O;
        }
        for (const [DX, DY] of PixelWorld._OFF) {
            const QX = x + DX,
                QY = y - DY;
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
    } // 발사체 하나의 질량 환산 (밀도 기반, 반발력과 같은 환산). 기체는 맞았을 때 운동량 전달 효율이 낮아 x0.25
    _jetEntity(p) {
        // 날아가던 유체가 엔티티에 맞으면 운동량(질량 x 속도)만큼 엔티티를 밂
        for (const E of this.bodies) {
            if (E.sensor || E.dead || (E === p.src && p.t < 8)) {
                continue;
            }
            if (Math.abs(p.x - E.x) <= E.hx + 0.3 && Math.abs(p.y - E.y) <= E.hy + 0.3) {
                const M_VALUE = this._jetMass(p);
                E.impulse((p.vx * M_VALUE) / E.mass, (p.vy * M_VALUE) / E.mass);
                return true;
            }
        }
        return false;
    }
    _jets() {
        const G = this.g,
            W_VALUE = this.w,
            H_VALUE = this.h,
            K = this.K,
            ST = this.ST,
            LIVE = [];
        for (const P_VALUE of this.proj) {
            const GAS = K[P_VALUE.id] === 3;
            P_VALUE.vy += GAS ? -0.03 : 0.1;
            if (GAS) {
                P_VALUE.vx *= 0.97;
                P_VALUE.vy *= 0.97;
            }
            P_VALUE.t++; // 기체 발사체는 중력 대신 살짝 뜨고 공기저항으로 빨리 느려짐
            const N_VALUE = Math.max(1, Math.ceil(Math.max(Math.abs(P_VALUE.vx), Math.abs(P_VALUE.vy))));
            let cx0 = Math.floor(P_VALUE.x),
                cy0 = Math.floor(P_VALUE.y),
                px = P_VALUE.ex,
                py = P_VALUE.ey,
                dead = false; // (px,py): 마지막으로 지난 빈 셀 — 유체 속에서 틱이 끝나도 잃지 않도록 발사체가 들고 다님
            for (let s = 0; s < N_VALUE; s++) {
                P_VALUE.x += P_VALUE.vx / N_VALUE;
                P_VALUE.y += P_VALUE.vy / N_VALUE;
                const CX = Math.floor(P_VALUE.x),
                    CY = Math.floor(P_VALUE.y);
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
                } // 엔티티에 부딪힘: 밀고 그 앞에 퇴적
                const V = G[CY * W_VALUE + CX];
                if (V === 0) {
                    px = CX;
                    py = CY;
                    continue;
                }
                if (V === this.ghostId && this.bridge) {
                    const HB = this.bridge.bodies[this.gown[CY * W_VALUE + CX] - 1]; // 강체의 유령 셀에 부딪힘: 맞은 지점에 충격량을 줘서 밀고 회전시킴
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
                } // 고체(강체 유령 셀 포함)에 막힘: 마지막 빈 셀에 퇴적
                const F_VALUE = K[V] === 2 ? 0.9 : K[V] === 1 ? 0.8 : 0.98;
                P_VALUE.vx *= F_VALUE;
                P_VALUE.vy *= F_VALUE; // 액체·가루·기체는 막지 않고 속도 벡터를 유지한 채 지나가며 감속
                if (P_VALUE.vx * P_VALUE.vx + P_VALUE.vy * P_VALUE.vy < 0.36) {
                    this._drop(px, py, P_VALUE.id);
                    dead = true;
                    break;
                } // 속도를 다 잃으면 그 자리 근처에 퇴적
            }
            if (!dead && GAS && P_VALUE.vx * P_VALUE.vx + P_VALUE.vy * P_VALUE.vy < 0.25) {
                this._drop(px, py, P_VALUE.id);
                dead = true;
            } // 기체는 힘이 다하면 기체 셀(올라가며 사라짐)이 됨
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
        // 셀이 바뀐 청크(와 경계에 닿은 이웃 청크)를 깨움. 청크 인덱스 반환
        const W_VALUE = this.w,
            X = i % W_VALUE,
            Y = (i - X) / W_VALUE,
            CX = X >> 4,
            CY = Y >> 4,
            C_VALUE = CY * this.cw + CX,
            A = this.awake,
            LX = X & 15,
            LY = Y & 15;
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
        const W_VALUE = this.w,
            X0 = (c % this.cw) << 4,
            Y0 = ((c / this.cw) | 0) << 4,
            X1 = Math.min(W_VALUE, X0 + 16),
            Y1 = Math.min(this.h, Y0 + 16);
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
        } // 정적 고체가 바뀐 청크만 표시
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
        this.setCell(y * this.w + x, typeof mat === 'string' ? this.id[mat] : mat);
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
        const ID = typeof mat === 'string' ? this.id[mat] : mat;
        for (let dy = -r; dy <= r; dy++) {
            for (let dx = -r; dx <= r; dx++) {
                if (dx * dx + dy * dy > r * r) {
                    continue;
                }
                const X = cx + dx,
                    Y = cy + dy;
                if (
                    X < 0 ||
                    Y < 0 ||
                    X >= this.w ||
                    Y >= this.h ||
                    this.g[Y * this.w + X] !== 0 ||
                    this.rand() < sparse
                ) {
                    continue;
                }
                this.setCell(Y * this.w + X, ID);
            }
        }
    }
    carve(cx, cy, r) {
        let n = 0; // 곡괭이: 부술 수 있는 고체/가루만 제거
        for (let dy = -r; dy <= r; dy++) {
            for (let dx = -r; dx <= r; dx++) {
                if (dx * dx + dy * dy > r * r) {
                    continue;
                }
                const X = cx + dx,
                    Y = cy + dy;
                if (X < 0 || Y < 0 || X >= this.w || Y >= this.h) {
                    continue;
                }
                const I = Y * this.w + X,
                    T = this.g[I];
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
        const R2 = r * r,
            FIRE = this.id.fire;
        for (let dy = -r; dy <= r; dy++) {
            for (let dx = -r; dx <= r; dx++) {
                const D2 = dx * dx + dy * dy,
                    X = cx + dx,
                    Y = cy + dy;
                if (D2 > R2 || X < 0 || Y < 0 || X >= this.w || Y >= this.h) {
                    continue;
                }
                const I = Y * this.w + X,
                    T = this.g[I],
                    RIM = D2 > R2 * 0.6;
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
                if (M_VALUE.kind === 'solid' && RIM && this.rand() < 0.4) {
                    continue;
                } // 가장자리는 들쭉날쭉하게 남김
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
        this.emit('explosion', { x: cx, y: cy, r });
        for (const B_VALUE of this.bodies) {
            const PX = B_VALUE.x - cx,
                PY = B_VALUE.y - cy,
                D_VALUE = HYP(PX, PY) || 1;
            if (D_VALUE < R) {
                B_VALUE.impulse((PX / D_VALUE) * force, (PY / D_VALUE) * force - 0.5);
                B_VALUE.hurt(damage * (1 - D_VALUE / R), 'blast');
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
                name: '__ghost',
                kind: 'solid',
                color: [0, 0, 0],
                indestructible: true,
                body: { blocks: false },
            });
        } // 유령 solid용 내부 재료
        this.on('explosion', (e) => {
            const R = e.r * 1.5;
            for (const H_VALUE of bValue.bodies) {
                const DX = H_VALUE.x - e.x,
                    DY = H_VALUE.y - e.y,
                    D_VALUE = HYP(DX, DY) || 1;
                if (D_VALUE < R) {
                    const DV = 3 * (1 - D_VALUE / R) * H_VALUE.mass;
                    bValue.applyImpulse(H_VALUE, (DX / D_VALUE) * DV, (DY / D_VALUE) * DV - 0.3 * H_VALUE.mass);
                }
            }
        });
    }
    _chunkShapes(cx, cy) {
        // 청크 안의 정적 고체를 같은 재료끼리 직사각형으로 병합 (격자와 정확히 일치)
        const { w: W_VALUE, h: H_VALUE, g: G, ST } = this,
            X0 = cx * 16,
            Y0 = cy * 16,
            X1 = Math.min(W_VALUE, X0 + 16),
            Y1 = Math.min(H_VALUE, Y0 + 16),
            OUT = [];
        let open = new Map();
        for (let y = Y0; y < Y1; y++) {
            const NEXT = new Map();
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
                const K_VALUE = x + ',' + e + ',' + T,
                    O = open.get(K_VALUE);
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
                { x: r.x0, y: r.y1 },
            ],
        }));
    }
    _fluid(h) {
        // 부력: 유령 solid가 밀어낸(=잠긴) 셀들의 (유체 밀도 합 x 중력)을 그 셀들의 무게중심에 위로 가함 → 질량에 따라 뜨고 가라앉음
        const Q = h.sub;
        h.dbg = 0;
        if (!Q || !Q.n) {
            return;
        }
        const B = this.bridge,
            F_VALUE = Q.rho * this.fluidScale * B.gravityScale,
            FR = Q.n / (h.area || h.w * h.h);
        h.dbg = F_VALUE;
        B.applyForce(h, Q.sx / Q.n, Q.sy / Q.n, 0, -F_VALUE);
        B.damp(h, 1 - 0.08 * FR, 1 - 0.15 * FR);
    }
    chip(cx, cy, r, energy) {
        // 충격 에너지 > 재료 strength 인 셀만 깎임 (중심에서 멀수록 에너지 감쇠)
        let n = 0;
        cx = Math.round(cx);
        cy = Math.round(cy);
        for (let dy = -r; dy <= r; dy++) {
            for (let dx = -r; dx <= r; dx++) {
                const D_VALUE = HYP(dx, dy);
                if (D_VALUE > r) {
                    continue;
                }
                const X = cx + dx,
                    Y = cy + dy;
                if (X < 0 || Y < 0 || X >= this.w || Y >= this.h) {
                    continue;
                }
                const I = Y * this.w + X,
                    T = this.g[I];
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
        const R_VALUE = Math.min(6, 1 + Math.floor(Math.sqrt(E) / 3)),
            N_VALUE = this.chip(im.x, im.y, R_VALUE, E);
        if (N_VALUE) {
            this.bridge.damp(im.body, 1 - Math.min(0.6, N_VALUE * 0.03), 1);
            this.emit('chip', { x: im.x, y: im.y, removed: N_VALUE, energy: E, body: im.body });
        }
        const D_VALUE = im.body.data;
        if (
            D_VALUE.strength != null &&
            E > D_VALUE.strength &&
            this.time - (D_VALUE.born ?? -99) >= 6 &&
            this.bridge.bodies.includes(im.body)
        ) {
            this.fracture(im.body, im, E);
        }
    } // 강도를 넘으면 강체 조각으로 쪼개짐 (너무 작으면 픽셀로 환원)
    _entityImpact(im) {
        // 엔티티 프록시와의 충돌: 충돌 직전 속도 기준으로 피해와 밀침
        const E = im.entity;
        if (E.dead || this.time - (im.body.data.born ?? -99) < 10) {
            return;
        }
        const DX = E.x - im.body.x,
            DY = E.y - im.body.y,
            DD = HYP(DX, DY) || 1,
            EN = im.body.mass * Math.max(0, (im.rvx * DX + im.rvy * DY) / DD) * this.impactScale; // 강체가 엔티티 쪽으로 향하는 속도만 충격으로 침 (밀려 멀어지는 접촉, 얹혀 있는 접촉은 0)
        if (EN > 8 && this.time >= (E.data.rock || 0)) {
            E.data.rock = this.time + 20;
            const K_VALUE = im.body.mass / (im.body.mass + E.mass);
            E.hurt(EN * 0.4);
            E.impulse(im.rvx * K_VALUE, im.rvy * K_VALUE);
            this.emit('hit', { entity: E, rigid: im.body, energy: EN });
        }
    }
    _rowsOf(b) {
        // 강체가 덮는 셀의 행 구간 목록 (브릿지가 주는 볼록 다각형들을 셀 중심으로 래스터화 → 박스/원/다각형/복합체 공통, 한 행에 구간이 여러 개일 수 있음)
        const B = this.bridge,
            P = B.getPolys(b),
            BD = B.getBounds(b),
            { w: W_VALUE, h: H_VALUE } = this,
            MK = this._mk,
            ID = ++this._mkId,
            ROWS = [];
        const Y0 = Math.max(0, Math.floor(BD.y0)),
            Y1 = Math.min(H_VALUE - 1, Math.floor(BD.y1)),
            X0 = Math.max(0, Math.floor(BD.x0)),
            X1 = Math.min(W_VALUE - 1, Math.floor(BD.x1));
        for (const V of P) {
            let a = 1e9,
                c = -1e9,
                d = 1e9,
                e = -1e9;
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
            const YA = Math.max(Y0, Math.floor(d)),
                YB = Math.min(Y1, Math.floor(e)),
                XA = Math.max(X0, Math.floor(a)),
                XB = Math.min(X1, Math.floor(c));
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
        // 셀 → 재료별 직사각형 병합 (_chunkShapes와 같은 방식)
        let x0 = 1e9,
            y0 = 1e9,
            x1 = -1e9,
            y1 = -1e9;
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
        const W = x1 - x0 + 1,
            H = y1 - y0 + 1,
            A = new Uint8Array(W * H),
            OUT = [];
        for (const C_VALUE of cells) {
            A[(C_VALUE.y - y0) * W + C_VALUE.x - x0] = C_VALUE.t;
        }
        let open = new Map();
        for (let y = 0; y < H; y++) {
            const NEXT = new Map();
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
                const K_VALUE = x + ',' + e + ',' + T,
                    O = open.get(K_VALUE);
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
            return { x: r.x, y: r.y, w: r.w, h: r.h, density: M_VALUE.density ?? 0.004 };
        });
    }
    _strengthOf(cells) {
        let n = 0,
            sum = 0;
        for (const C_VALUE of cells) {
            const ST_VALUE = this.mats[C_VALUE.t].strength;
            if (ST_VALUE != null) {
                sum += ST_VALUE;
                n++;
            }
        }
        return n * 2 > cells.length ? sum / n : null;
    } // 절반 넘는 셀이 강도가 있을 때만 평균 (철 같은 건 안 깨짐)
    spawnCells(cells, { x = 0, y = 0, angle = 0, vx = 0, vy = 0, av = 0, data = {} } = {}) {
        // 셀 집합으로 강체 생성. (x,y) = 격자 원점의 월드 위치, angle = 그 원점 기준 회전
        if (this.dirty) {
            this._compile();
        }
        const D_VALUE = { born: this.time, chunk: true, ...data };
        if (D_VALUE.strength === undefined) {
            const ST_VALUE = this._strengthOf(cells);
            if (ST_VALUE != null) {
                D_VALUE.strength = ST_VALUE;
            }
        }
        const H_VALUE = this.bridge.addBody({
            kind: 'compound',
            parts: this._rects(cells),
            x,
            y,
            angle,
            vx,
            vy,
            av,
            data: D_VALUE,
        });
        H_VALUE.cells = cells;
        return H_VALUE;
    }
    cellsOf(h) {
        // 강체를 셀로 분해 (마스크 강체는 그대로, 박스/원/다각형은 data.mat 재료로 로컬 격자에 샘플링). 불가능하면 null
        if (h.cells) {
            return { cells: h.cells, ox: h.ox, oy: h.oy };
        }
        const T = this.id[h.data.mat];
        if (!T) {
            return null;
        }
        const P = this.bridge.getPolys(h),
            C_VALUE = Math.cos(h.angle),
            S_VALUE = Math.sin(h.angle);
        const L = P.map((v) =>
            v.map((p) => {
                const DX = p.x - h.x,
                    DY = p.y - h.y;
                return { x: DX * C_VALUE + DY * S_VALUE, y: -DX * S_VALUE + DY * C_VALUE };
            }),
        );
        let a = 1e9,
            b = 1e9,
            e = -1e9,
            f = -1e9;
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
        const GX0 = Math.floor(a),
            GY0 = Math.floor(b),
            CELLS = [];
        for (let gy = 0; gy <= Math.ceil(f) - GY0; gy++) {
            for (let gx = 0; gx <= Math.ceil(e) - GX0; gx++) {
                const PX = gx + GX0 + 0.5,
                    PY = gy + GY0 + 0.5;
                if (L.some((v) => inPoly(v, PX, PY))) {
                    CELLS.push({ x: gx, y: gy, t: T });
                }
            }
        }
        return CELLS.length ? { cells: CELLS, ox: -GX0, oy: -GY0 } : null;
    }
    _cellWorld(h, src, c) {
        const CO = Math.cos(h.angle),
            SI = Math.sin(h.angle),
            LX = c.x + 0.5 - src.ox,
            LY = c.y + 0.5 - src.oy;
        return [h.x + LX * CO - LY * SI, h.y + LX * SI + LY * CO];
    }
    fracture(h, im, e) {
        // 강체 파편화: 충돌점 주변에 시드를 뿌려 셀을 보로노이 비슷하게 나누고, 각 덩어리를 새 강체로 (너무 작은 조각은 가루로)
        const F = this.frag,
            B = this.bridge,
            SRC = this.cellsOf(h);
        if (
            !SRC ||
            SRC.cells.length < F.minCells * 2 ||
            B.bodies.length >= F.maxBodies ||
            (h.data.gen | 0) >= F.maxGen
        ) {
            this.shatter(h);
            return;
        }
        const { cells: CELLS } = SRC,
            N_VALUE = CELLS.length,
            D_VALUE = h.data,
            CO = Math.cos(h.angle),
            SI = Math.sin(h.angle),
            PX = im.x - h.x,
            PY = im.y - h.y,
            LX = PX * CO + PY * SI + SRC.ox - 0.5,
            LY = -PX * SI + PY * CO + SRC.oy - 0.5;
        const K_VALUE = Math.max(
            2,
            Math.min(F.maxPieces, 2 + Math.floor(e / D_VALUE.strength - 1), (N_VALUE / (F.minCells * 2)) | 0),
        );
        const SEEDS = [];
        let bi = 0,
            bd = 1e9;
        CELLS.forEach((c, i) => {
            const DD = (c.x - LX) * (c.x - LX) + (c.y - LY) * (c.y - LY);
            if (DD < bd) {
                bd = DD;
                bi = i;
            }
        });
        SEEDS.push(CELLS[bi]); // 첫 시드는 충돌점에서 가장 가까운 셀
        while (SEEDS.length < K_VALUE) {
            let best = null,
                bs = -1;
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
            let bl = 0,
                bv = 1e9;
            SEEDS.forEach((q, j) => {
                const DD = HYP(c.x - q.x, c.y - q.y) + this.rand() * F.jitter;
                if (DD < bv) {
                    bv = DD;
                    bl = j;
                }
            });
            LAB[i] = bl;
        });
        const IDX = new Map();
        CELLS.forEach((c, i) => IDX.set(c.y * 65536 + c.x, i));
        const SEEN = new Uint8Array(N_VALUE),
            COMPS = [];
        for (let i = 0; i < N_VALUE; i++) {
            if (SEEN[i]) {
                continue;
            }
            const COMP = [],
                ST_VALUE = [i];
            SEEN[i] = 1;
            while (ST_VALUE.length) {
                const J = ST_VALUE.pop();
                COMP.push(CELLS[J]);
                const C_VALUE = CELLS[J];
                for (let dy = -1; dy <= 1; dy++) {
                    for (let dx = -1; dx <= 1; dx++) {
                        const Q = IDX.get((C_VALUE.y + dy) * 65536 + C_VALUE.x + dx);
                        if (Q !== undefined && !SEEN[Q] && LAB[Q] === LAB[J]) {
                            SEEN[Q] = 1;
                            ST_VALUE.push(Q);
                        }
                    }
                }
            }
            COMPS.push(COMP);
        }
        const GX = h.x - (SRC.ox * CO - SRC.oy * SI),
            GY = h.y - (SRC.ox * SI + SRC.oy * CO),
            PIECES = [];
        for (const COMP of COMPS) {
            if (COMP.length < F.minCells) {
                // 너무 작음 → 파편 재료 가루
                for (const C_VALUE of COMP) {
                    const DB = (this.mats[C_VALUE.t].blast && this.mats[C_VALUE.t].blast.debris) || D_VALUE.debris;
                    if (!DB) {
                        continue;
                    }
                    const [WX, WY] = this._cellWorld(h, SRC, C_VALUE),
                        XI = Math.floor(WX),
                        YI = Math.floor(WY);
                    if (XI >= 0 && YI >= 0 && XI < this.w && YI < this.h) {
                        const I = YI * this.w + XI;
                        if (this.g[I] === 0 || this.K[this.g[I]] > 0) {
                            this.setCell(I, this.id[DB]);
                        }
                    }
                }
                continue;
            }
            const ST_VALUE = D_VALUE.strength != null ? D_VALUE.strength * F.hardening : this._strengthOf(COMP),
                P_VALUE = this.spawnCells(COMP, {
                    x: GX,
                    y: GY,
                    angle: h.angle,
                    data: {
                        strength: ST_VALUE ?? undefined,
                        gen: (D_VALUE.gen | 0) + 1,
                        debris: D_VALUE.debris,
                        mat: undefined,
                    },
                });
            const RX = P_VALUE.x - h.x,
                RY = P_VALUE.y - h.y,
                IX = P_VALUE.x - im.x,
                IY = P_VALUE.y - im.y,
                ID = HYP(IX, IY) || 1;
            B.setVelocity(
                P_VALUE,
                h.vx - (h.av || 0) * RY + (IX / ID) * F.kick,
                h.vy + (h.av || 0) * RX + (IY / ID) * F.kick,
            );
            B.setAngularVelocity(P_VALUE, h.av || 0);
            PIECES.push(P_VALUE);
        }
        B.removeBody(h);
        this.emit('fracture', { x: h.x, y: h.y, body: h, pieces: PIECES, energy: e });
    }
    /* ---- 지형 붕괴: 앵커(바닥·가장자리·indestructible 재료)와 8방향으로 이어지지 않은 고체 덩어리는 강체가 되어 떨어짐 ---- */
    enableCollapse(o = {}) {
        this.collapse = { minCells: 4, maxCells: 1500, interval: 4, bake: true, restTicks: 40, minBake: 0.7, ...o };
        this.supDirty = true;
    }
    _flood() {
        // 앵커에서 8방향 flood fill. 반환: 지탱되는 고체 셀이 1인 배열
        const { w: W_VALUE, h: H_VALUE, g: G, ST, AN } = this,
            N_VALUE = W_VALUE * H_VALUE;
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
        }
        for (let y = 0; y < H_VALUE; y++) {
            SEED(y * W_VALUE);
            SEED(y * W_VALUE + W_VALUE - 1);
        }
        while (sp) {
            const I = STK[--sp],
                X = I % W_VALUE,
                Y = (I / W_VALUE) | 0;
            for (let dy = -1; dy <= 1; dy++) {
                const NY = Y + dy;
                if (NY < 0 || NY >= H_VALUE) {
                    continue;
                }
                for (let dx = -1; dx <= 1; dx++) {
                    const NX = X + dx;
                    if (NX < 0 || NX >= W_VALUE || (!dx && !dy)) {
                        continue;
                    }
                    SEED(NY * W_VALUE + NX);
                }
            }
        }
        return sValue;
    }
    _support() {
        // 셀이 사라진 적이 있을 때만(supDirty) 몇 틱에 한 번 검사
        const C = this.collapse;
        if (!C || !this.supDirty || this.time - this._supT < C.interval) {
            return;
        }
        this.supDirty = false;
        this._supT = this.time;
        const S = this._flood(),
            { w: W_VALUE, h: H_VALUE, g: G, ST } = this,
            N_VALUE = W_VALUE * H_VALUE;
        if (!this._sk) {
            this._sk = new Int32Array(N_VALUE);
        }
        const SK = this._sk,
            ID = ++this._skId,
            STK = new Int32Array(N_VALUE);
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
                const X = I % W_VALUE,
                    Y = (I / W_VALUE) | 0;
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
            } // 너무 큰 덩어리는 정적으로 둠 (성능 보호)
            if (COMP.length < C.minCells) {
                for (const I of COMP) {
                    const DB = this.mats[G[I]].blast && this.mats[G[I]].blast.debris;
                    if (DB) {
                        this.setCell(I, this.id[DB]);
                    }
                }
                continue;
            } // 부스러기는 가루로
            COMP.sort((a, b) => a - b);
            const CELLS = COMP.map((i) => ({ x: i % W_VALUE, y: (i / W_VALUE) | 0, t: G[i] }));
            for (const I of COMP) {
                this.setCell(I, 0);
            }
            const HH = this.spawnCells(CELLS);
            this.emit('collapse', { body: HH, cells: CELLS.length, x: HH.x, y: HH.y });
        }
    }
    _bake(h) {
        // 가만히 쉬는 조각을 다시 지형 셀로 굳힘. 굳힌 셀이 앵커에 이어지지 않으면 한 칸 아래/위로 옮겨 시도하고, 안 되면 실패
        const { w: W_VALUE, h: H, g: G } = this,
            B = this.bridge,
            MAP = new Map();
        for (const C_VALUE of h.cells) {
            MAP.set(C_VALUE.y * 65536 + C_VALUE.x, C_VALUE.t);
        }
        const ROWS = this._rowsOf(h),
            CO = Math.cos(h.angle),
            SI = Math.sin(h.angle),
            TGT = [];
        for (const R_VALUE of ROWS) {
            for (let x = R_VALUE.xa; x <= R_VALUE.xb; x++) {
                const PX = x + 0.5 - h.x,
                    PY = R_VALUE.y + 0.5 - h.y,
                    T = MAP.get(Math.floor(-PX * SI + PY * CO + h.oy) * 65536 + Math.floor(PX * CO + PY * SI + h.ox));
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
            const USE = [],
                SAVED = [];
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
                    this._eject(Q.i, Q.i % W_VALUE, (Q.i / W_VALUE) | 0);
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
                this.emit('bake', { x: h.x, y: h.y, cells: USE.length });
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
            if (HYP(H_VALUE.vx, H_VALUE.vy) < 0.04 && Math.abs(H_VALUE.av || 0) < 0.004) {
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
        // 강체 -> 픽셀: 덮고 있던 셀을 파편 재료로 바꾸고 강체 제거
        const DB = this.id[h.data.debris || 'sand'];
        for (const R_VALUE of this._rowsOf(h)) {
            for (let x = R_VALUE.xa; x <= R_VALUE.xb; x++) {
                const I = R_VALUE.y * this.w + x,
                    T = this.g[I];
                if ((T === 0 || this.K[T] > 0) && this.rand() < 0.7) {
                    this.setCell(I, DB);
                }
            }
        }
        this.bridge.removeBody(h);
        this.emit('shatter', { x: h.x, y: h.y, body: h });
    }
    addEntity(body) {
        // 엔티티를 월드에 등록하고 snapshot용 식별자 eid를 부여합니다. 발급 순서는 시뮬레이션 호출 순서이므로 결정적입니다.
        if (body.eid !== undefined) {
            throw new Error('이미 등록된 엔티티입니다.');
        }
        body.eid = this.eseq++;
        this.bodies.push(body);
        return body;
    }
    /* ---- 스냅샷 / 해시 (롤백, 리플레이, 락스텝 디싱크 검출) ---- */
    snapshot(copyGrid = true) {
        // copyGrid=false는 격자 배열을 복사하지 않고 살아 있는 배열을 돌려줍니다. 바이트로 즉시 인코딩할 때만 쓰고 보관하지 마세요.
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
            pseq: this.pseq,
            eseq: this.eseq,
            supDirty: this.supDirty,
            supT: this._supT,
            proj: this.proj.map((p) => ({ ...p })),
            entRefs: this.bodies.slice(),
            ents: this.bodies.map((b) => b.save()),
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
        // 시뮬레이션 상태 전체의 32비트 해시 (부동소수점은 비트 단위로 섞음)
        let h = 2166136261;
        const MIX = (v) => {
                h = Math.imul(h ^ (v | 0), 16777619);
            },
            F = new Float64Array(1),
            U = new Uint32Array(F.buffer),
            MF = (x) => {
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
        const B = this.bridge,
            { w: W_VALUE, g: G } = this,
            GID = this.ghostId;
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
        const AIR = (v) => v === 0 || this.K[v] === 3,
            LIQ = (v) => (v !== 0 && this.K[v] === 2 ? v : 0);
        let bi = -1;
        for (const B_VALUE of B.bodies) {
            bi++;
            let carry = 0;
            B_VALUE.sub = { n: 0, rho: 0, sx: 0, sy: 0 };
            for (const R_VALUE of B_VALUE._rows) {
                const Y = R_VALUE.y;
                let ej = 0;
                for (let x = R_VALUE.xa; x <= R_VALUE.xb; x++) {
                    const I = Y * W_VALUE + x,
                        T = G[I];
                    if (T && T !== GID && this.K[T] > 0 && this._eject(I, x, Y) && this.K[T] === 2) {
                        ej = T;
                    }
                }
                const L = R_VALUE.xa > 0 ? G[Y * W_VALUE + R_VALUE.xa - 1] : 1,
                    R = R_VALUE.xb < W_VALUE - 1 ? G[Y * W_VALUE + R_VALUE.xb + 1] : 1;
                let f = ej || LIQ(L) || LIQ(R);
                if (!f && carry && !AIR(L) && !AIR(R)) {
                    f = carry;
                } // 좁은 틈에 낀 경우: 위 행이 잠겼고 양옆이 막혀 있으면 이어서 잠김
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
            const Q = B_VALUE.sub,
                RAW = Q.n
                    ? { n: Q.n, r: Q.rho / Q.n, x: Q.sx / Q.n, y: Q.sy / Q.n }
                    : { n: 0, r: 0, x: B_VALUE.x, y: B_VALUE.y },
                P_VALUE = B_VALUE._sm || (B_VALUE._sm = RAW); // 잠김 값을 저역통과해서 수면 출렁임에 의한 부력 떨림을 줄임
            P_VALUE.n += (RAW.n - P_VALUE.n) * 0.25;
            if (RAW.n) {
                P_VALUE.r += (RAW.r - P_VALUE.r) * 0.25;
                P_VALUE.x += (RAW.x - P_VALUE.x) * 0.25;
                P_VALUE.y += (RAW.y - P_VALUE.y) * 0.25;
            }
            B_VALUE.sub = {
                n: P_VALUE.n,
                rho: P_VALUE.n * P_VALUE.r,
                sx: P_VALUE.n * P_VALUE.x,
                sy: P_VALUE.n * P_VALUE.y,
            };
        }
    }
    _eject(i, x, y) {
        // 위쪽 우선으로 가까운 빈 셀(다른 강체 영역 제외)로 입자 이동
        const { w: W_VALUE, h: H_VALUE, g: G } = this;
        for (let r = 1; r <= 4; r++) {
            for (let dy = -r; dy <= r; dy++) {
                for (let dx = -r; dx <= r; dx++) {
                    if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) {
                        continue;
                    }
                    const NX = x + dx,
                        NY = y + dy;
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
        const GID = this.ghostId,
            G = this.g,
            W_VALUE = this.w,
            B = this.bridge,
            K = this.K,
            D = this.D;
        for (const B_VALUE of B.bodies) {
            // 입자 -> 강체: 윗면에 쌓인 가루 기둥의 무게(밀도 합 x 중력)를 윗면 중심에 아래로 가함
            let load = 0,
                sx = 0,
                sy = 0,
                m = 0;
            for (const R_VALUE of B_VALUE._rows) {
                for (let x = R_VALUE.xa; x <= R_VALUE.xb; x++) {
                    const I = R_VALUE.y * W_VALUE + x;
                    if (R_VALUE.y === 0 || this.fp[I - W_VALUE]) {
                        continue;
                    }
                    let j = I - W_VALUE,
                        n = 0;
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
        // 강체 → 엔티티: 상대 운동량이 임계값을 넘으면 피해와 밀침 (자기가 쏜 직후 10틱은 무시)
        for (const E of this.bodies) {
            if (E.dead || E.sensor) {
                continue;
            }
            const X0 = E.x - E.hx - 0.5,
                X1 = E.x + E.hx + 0.5,
                Y0 = E.y - E.hy - 0.5,
                Y1 = E.y + E.hy + 0.5;
            for (const H_VALUE of this.bridge.bodies) {
                if (this.time - (H_VALUE.data.born ?? -99) < 10 || !bodyHit(this.bridge, H_VALUE, X0, Y0, X1, Y1)) {
                    continue;
                }
                const DX = E.x - H_VALUE.x,
                    DY = E.y - H_VALUE.y,
                    DD = HYP(DX, DY) || 1,
                    EN = H_VALUE.mass * Math.max(0, (H_VALUE.vx * DX + H_VALUE.vy * DY) / DD) * this.impactScale; // 강체가 엔티티 쪽으로 향하는 속도만 (엔티티가 걸어 들어가는 속도는 제외)
                if (EN > 8 && this.time >= (E.data.rock || 0)) {
                    E.data.rock = this.time + 20;
                    const K_VALUE = H_VALUE.mass / (H_VALUE.mass + E.mass);
                    E.hurt(EN * 0.4);
                    E.impulse(H_VALUE.vx * K_VALUE, H_VALUE.vy * K_VALUE);
                    this.emit('hit', { entity: E, rigid: H_VALUE, energy: EN });
                }
            }
        }
    }
    isCheckpoint() {
        return !this.bridge || this.bridge.tickNo % this.bridge.checkpoint === 0;
    } // 스냅샷은 이 틱에 찍어야 롤백이 비트 단위로 정확함
    _sync() {
        // 동기화 순서: dirty 청크 → 강체 엔진 / 부력 → step → 충격 이벤트 → 지형 반영
        const B = this.bridge;
        for (let c = 0; c < this.chd.length; c++) {
            if (this.chd[c]) {
                this.chd[c] = 0;
                const CX = c % this.cw,
                    CY = (c / this.cw) | 0;
                B.setStaticChunk(c, this._chunkShapes(CX, CY));
                this.chunkTick[c] = this.time;
                B.wake({ x: CX * 16 - 2, y: CY * 16 - 2, w: 20, h: 20 });
            }
        }
        for (const E of this.bodies) {
            if (E.sensor || E.dead || E.rigid === false) {
                continue;
            } // 엔티티를 엔진에 정적 박스로 비춤 → 상자가 엔티티를 뚫지 않고 위에 얹힘
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
        B.step(1000 / 60);
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
        const A = this._wk(i),
            B_VALUE = this._wk(j);
        if (this.mats[G[i]].act) {
            this.reac[A] = 1;
        }
        if (this.mats[G[j]].act) {
            this.reac[B_VALUE] = 1;
        }
    }
    _nbr(x, y) {
        const D_VALUE = this.rnd(4),
            NX = x + (D_VALUE === 0) - (D_VALUE === 1),
            NY = y + (D_VALUE === 2) - (D_VALUE === 3);
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
        const N_VALUE = this._nbr(x, y),
            C_VALUE = N_VALUE < 0 ? 0 : this.g[N_VALUE];
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
        const { w: W_VALUE, h: H_VALUE, g: G } = this,
            I = y * W_VALUE + x,
            T = G[I];
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
            // 청크 sleep 판정을 시작할 때 한 번에 확정합니다. 청크 하나씩 돌려 확정하면 청크 수만큼의 틱 동안 전 청크가 깨어 있습니다.
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
        } // 렌더 보간용 이전 상태
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
        } // 유령 셀이 찍힌 뒤라서 발사체도 강체에 막힘
        const { w: W_VALUE, cw: CW, awake: AWAKE, reac: REAC } = this,
            SL = this.sleepEnabled;
        for (let y = this.h - 1; y >= 0; y--) {
            const BASE = (y >> 4) * CW;
            if (this.dir) {
                for (let cx = 0; cx < CW; cx++) {
                    if (SL && !AWAKE[BASE + cx] && !REAC[BASE + cx]) {
                        continue;
                    }
                    const XE = Math.min(W_VALUE, (cx + 1) << 4);
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
                    for (let x = Math.min(W_VALUE, (cx + 1) << 4) - 1; x >= XS; x--) {
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
        this._refreshReac(this.time % AWAKE.length); // 반응 재료 유무는 청크 하나씩 돌아가며 갱신
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
                    if (
                        B_VALUE !== A &&
                        !B_VALUE.dead &&
                        Math.abs(A.x - B_VALUE.x) < A.hx + B_VALUE.hx + 0.4 &&
                        Math.abs(A.y - B_VALUE.y) < A.hy + B_VALUE.hy + 0.4
                    ) {
                        A.onOverlap(B_VALUE);
                    }
                }
            }
        } // 서로 막히는 엔티티는 맞닿기만 해도 접촉으로 침 (.4 여유)
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
}
/* 강체 엔진 어댑터 계약: 라이브러리는 이 메서드만 안다 (엔진을 바꿔도 PixelWorld는 그대로) */
class PhysicsBridge {
    constructor() {
        this.bodies = [];
        this.joints = [];
        this.gravityScale = 0;
    } // bodies: 핸들 {x,y,angle,w,h,mass,vx,vy,data,pins}
    setStaticChunk(_id, _shapes) {} // shapes: [{verts:[{x,y}..], mat}]  지형 충돌체 교체
    addBody(_o) {}
    addBox(_o) {}
    removeBody(_h) {}
    clearDynamic() {} // addBody({kind:'box'|'circle'|'poly'|'convex'|'compound', x,y,angle,vx,vy,av,density,friction,restitution,group,data, w,h|r|sides|verts|parts})
    getPolys(_h) {
        return [];
    }
    getBounds(_h) {
        return { x0: 0, y0: 0, x1: 0, y1: 0 };
    } // 형상 질의: 월드 좌표의 볼록 다각형들, AABB (격자 래스터화·엔티티 충돌·렌더가 사용)
    addJoint(_o) {}
    removeJoint(_j) {}
    setAngularVelocity(_h, _av) {} // 조인트: {a,b?,ax,ay,bx,by,len,stiff,damping}
    addProxy(_e) {}
    moveProxy(_p, _x, _y) {}
    removeProxy(_p) {}
    clearProxies() {} // 엔티티를 엔진에 정적 박스로 비춤
    addPin(_h, _ax, _ay, _lx, _ly, _len, _stiff) {} // 월드 고정점에 줄/핀으로 매달기
    applyForce(_h, _px, _py, _fx, _fy) {}
    applyImpulse(_h, _jx, _jy) {}
    applyImpulseAt(_h, _px, _py, _jx, _jy) {}
    setVelocity(_h, _vx, _vy) {}
    damp(_h, _lin, _ang) {}
    wake(_rect) {}
    step(_dtMs) {}
    drainImpacts() {
        return [];
    } // impacts: [{body,x,y,nx,ny,impulse,rvx,rvy,mat|entity}]
    snapshot() {}
    restore(_s) {} // 롤백/리플레이용 상태 저장/복원
}
class MatterBridge extends PhysicsBridge {
    /* deterministic: 바디 id/순서를 고정하고 checkpoint 틱마다 접촉 캐시를 비워서, 스냅샷에서 복원해 다시 돌려도 비트 단위로 같은 결과가 나오게 함.
     * 스냅샷은 world.time(= bridge.tickNo)이 checkpoint의 배수일 때 찍어야 정확히 재현됨 */
    constructor({ gravity = 0.0004, deterministic = true, checkpoint = 30 } = {}) {
        super();
        this.M = Matter;
        this.gravityScale = gravity;
        this.deterministic = deterministic;
        this.checkpoint = checkpoint;
        this.tickNo = 0;
        this.seq = 1;
        this.dt = 1000 / 60;
        this.engine = Matter.Engine.create({ enableSleeping: false });
        this.engine.gravity.y = 1;
        this.engine.gravity.scale = gravity;
        this.engine.positionIterations = 16;
        this.engine.velocityIterations = 8; // 셀 단위의 작은 스케일이라 반복 횟수를 늘려 파고듦을 줄임
        this.statics = new Map();
        this.proxies = new Set();
        this.impacts = [];
        this.jseq = 1;
        Matter.Events.on(this.engine, 'collisionStart', (e) => {
            for (const P_VALUE of e.pairs) {
                const A = P_VALUE.bodyA.parent,
                    B_VALUE = P_VALUE.bodyB.parent;
                if (A.isStatic === B_VALUE.isStatic) {
                    continue;
                } // 복합체는 부품 단위로 충돌하므로 부모로 환산
                const DYN = A.isStatic ? B_VALUE : A,
                    ST_VALUE = A.isStatic ? A : B_VALUE,
                    N_VALUE = P_VALUE.collision.normal,
                    H_VALUE = DYN.plugin.handle;
                if (!H_VALUE) {
                    continue;
                } // 충돌 직전(솔버 이전) 속도로 충격량 계산
                const VN = Math.abs(
                        (A.velocity.x - B_VALUE.velocity.x) * N_VALUE.x +
                            (A.velocity.y - B_VALUE.velocity.y) * N_VALUE.y,
                    ),
                    SP = (P_VALUE.collision.supports || []).find(Boolean) || DYN.position;
                const IM = {
                    body: H_VALUE,
                    x: SP.x,
                    y: SP.y,
                    nx: N_VALUE.x,
                    ny: N_VALUE.y,
                    impulse: DYN.mass * VN,
                    rvx: DYN.velocity.x,
                    rvy: DYN.velocity.y,
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
        const M = this.M,
            C = M.Composite,
            OLD = this.statics.get(id);
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
                plugin: { mat: s.mat },
            });
            B_VALUE.id = 100000 + id * 256 + k;
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
        // 형상별 바디 생성. 항상 원점(복합체는 격자 좌표) 기준의 정해진 위치에서 만들고, 포즈는 addBody가 나중에 적용 → 복원 시 질량/관성이 비트 단위로 같음
        const M = this.M,
            O = { density: d.density, friction: d.friction, restitution: d.restitution, frictionAir: 0.005 };
        let b;
        if (d.kind === 'circle') {
            b = M.Bodies.circle(0, 0, d.r, O);
        } else if (d.kind === 'poly') {
            b = M.Bodies.polygon(0, 0, d.sides, d.r, O);
        } else if (d.kind === 'convex') {
            b = M.Bodies.fromVertices(0, 0, [d.verts], O);
        } else if (d.kind === 'compound') {
            b = M.Body.create({
                parts: d.parts.map((p) =>
                    M.Bodies.rectangle(p.x + p.w / 2, p.y + p.h / 2, p.w, p.h, {
                        density: p.density ?? d.density,
                        friction: d.friction,
                        restitution: d.restitution,
                    }),
                ),
                friction: d.friction,
                restitution: d.restitution,
                frictionAir: 0.005,
            });
        } else {
            b = M.Bodies.rectangle(0, 0, d.w, d.h, O);
        }
        b.id = h.id;
        b.parts.forEach((p, k) => {
            if (k) {
                p.id = 4000000 + h.id * 1024 + k;
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
        const K_VALUE = o.kind || 'box',
            D_VALUE = {
                kind: K_VALUE,
                density: o.density ?? 0.002,
                friction: o.friction ?? 0.6,
                restitution: o.restitution ?? 0.1,
                w: o.w,
                h: o.h,
                r: o.r,
                sides: o.sides,
                verts: o.verts,
                parts: o.parts,
                group: o.group || 0,
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
                _cons: [],
            },
            M = this.M;
        this._make(H_VALUE, D_VALUE);
        const B_VALUE = H_VALUE.body,
            BD = B_VALUE.bounds;
        H_VALUE.w = BD.max.x - BD.min.x;
        H_VALUE.h = BD.max.y - BD.min.y;
        const A = o.angle || 0,
            OX = K_VALUE === 'compound' ? B_VALUE.position.x : 0,
            OY = K_VALUE === 'compound' ? B_VALUE.position.y : 0;
        if (K_VALUE === 'compound') {
            H_VALUE.ox = OX;
            H_VALUE.oy = OY;
        } // 복합체의 무게중심(격자 좌표)
        if (A) {
            M.Body.setAngle(B_VALUE, A);
        }
        const C_VALUE = Math.cos(A),
            S_VALUE = Math.sin(A);
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
        return this.addBody({ ...o, kind: 'box' });
    }
    addCircle(o) {
        return this.addBody({ ...o, kind: 'circle' });
    }
    addPolygon(o) {
        return this.addBody({ ...o, kind: 'poly' });
    } // 정다각형: sides, r
    addConvex(o) {
        return this.addBody({ ...o, kind: 'convex' });
    } // 임의 볼록 다각형: verts [{x,y}..]
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
            damping: j.damp,
        };
        if (j.b) {
            O.bodyB = j.b.body;
        }
        j.c = this.M.Constraint.create(O);
        j.c.id = 800000 + j.id;
        this.M.Composite.add(this.engine.world, j.c);
    }
    addJoint(o) {
        // a의 로컬 앵커(ax,ay) ↔ b의 로컬 앵커(bx,by). b가 없으면 (bx,by)는 월드 고정점. len=0,stiff=1 이면 핀(경첩), len>0 이면 줄/막대, stiff 작으면 스프링
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
            c: null,
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
            damping: 0.02,
        });
        C_VALUE.id = 700000 + h.id * 8 + h._cons.length;
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
        const M = this.M,
            B_VALUE = M.Bodies.rectangle(e.x, e.y, e.hx * 2 - 0.2, e.hy * 2 - 0.2, {
                isStatic: true,
                friction: 0.2,
                plugin: { proxy: true, entity: e },
            }); // 살짝 작게: 맞닿은 상자가 눌리지 않게
        B_VALUE.id = 200000 + e.pid;
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
    } // 한 스텝치 힘으로 환산해 가해서 회전력도 생김 (속도 변화 = 힘/질량 x dt²)
    applyImpulse(h, jx, jy) {
        const B_VALUE = h.body,
            V = B_VALUE.velocity;
        this.M.Body.setVelocity(B_VALUE, { x: V.x + jx / B_VALUE.mass, y: V.y + jy / B_VALUE.mass });
    }
    setVelocity(h, vx, vy) {
        this.M.Body.setVelocity(h.body, { x: vx, y: vy });
        h.vx = vx;
        h.vy = vy;
    }
    damp(h, lin, ang) {
        const B_VALUE = h.body,
            V = B_VALUE.velocity;
        this.M.Body.setVelocity(B_VALUE, { x: V.x * lin, y: V.y * lin });
        this.M.Body.setAngularVelocity(B_VALUE, B_VALUE.angularVelocity * ang);
    }
    wake(r) {
        for (const H_VALUE of this.bodies) {
            if (
                Math.abs(H_VALUE.x - (r.x + r.w / 2)) < r.w / 2 + H_VALUE.w &&
                Math.abs(H_VALUE.y - (r.y + r.h / 2)) < r.h / 2 + H_VALUE.h
            ) {
                this.M.Sleeping.set(H_VALUE.body, false);
            }
        }
    }
    step(dt) {
        const M = this.M,
            W = this.engine.world;
        if (this.deterministic) {
            if (this.tickNo % this.checkpoint === 0) {
                M.Pairs.clear(this.engine.pairs);
            } // 접촉 캐시(워밍 임펄스)를 주기적으로 비워 복원 지점을 정확하게 만듦
            W.bodies.sort((a, b) => a.id - b.id);
            W.constraints.sort((a, b) => a.id - b.id);
            M.Composite.setModified(W, true, true, false);
        } // 생성/삭제 이력과 무관한 고정 순서
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
            bd: [p.bounds.min.x, p.bounds.min.y, p.bounds.max.x, p.bounds.max.y],
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
            ci: { x: b.constraintImpulse.x, y: b.constraintImpulse.y, a: b.constraintImpulse.angle }, // 엔진이 틱 사이에 들고 가는 워밍 임펄스
            parts: b.parts.length > 1 ? b.parts.slice(1).map(SP) : [],
        }); // 복합체는 모든 부품의 정점/축/경계도 저장
        return {
            tickNo: this.tickNo,
            seq: this.seq,
            jseq: this.jseq,
            bs: this.bodies.map((h) => ({
                h,
                w: h.w,
                hh: h.h,
                cells: h.cells, // 마스크 강체의 셀 집합(생성 뒤 불변)과 무게중심 격자 좌표
                ox: h.ox,
                oy: h.oy,
                desc: h.desc,
                pins: h.pins.map((p) => ({ ...p })),
                st: ST_VALUE(h.body),
                sm: h._sm ? { ...h._sm } : null,
                dat: { ...h.data }, // 부력 평활화 상태, 줄 제약의 내부 상태(회전된 앵커/각도)도 저장
                cons: h._cons.map((c) => ({ x: c.pointB.x, y: c.pointB.y, a: c.angleB })),
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
                    ab: j.c.angleB,
                },
            })),
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
            const H_VALUE = R_VALUE.h,
                Q = R_VALUE.st;
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
            H_VALUE._sm = R_VALUE.sm ? { ...R_VALUE.sm } : undefined;
            for (const K_VALUE in H_VALUE.data) {
                delete H_VALUE.data[K_VALUE];
            }
            Object.assign(H_VALUE.data, R_VALUE.dat); // 가변 상태(굳히기 카운터 등)
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
}

class Body {
    constructor(o) {
        Object.assign(
            this,
            {
                shape: 'box',
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
                color: '#fff',
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
                contacts: new Map(),
                onContact: null,
                onOverlap: null,
                onDeath: null,
                data: {},
            },
            o,
        );
        if (this.sensor && o.gravity == null) {
            this.gravity = 0;
        }
        this.maxHp = this.hp;
        this.hx = this.shape === 'circle' ? this.r : this.w / 2;
        this.hy = this.shape === 'circle' ? this.r : this.h / 2;
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
            data: { ...this.data },
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
        const X0 = Math.floor(x - this.hx),
            X1 = Math.floor(x + this.hx - 0.01),
            Y0 = Math.floor(y - this.hy),
            Y1 = Math.floor(y + this.hy - 0.01);
        for (let yy = Y0; yy <= Y1; yy++) {
            for (let xx = X0; xx <= X1; xx++) {
                if (this.shape === 'circle') {
                    const DX = xx + 0.5 - x,
                        DY = yy + 0.5 - y;
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
        // 0 = 막힘 없음, 1 = 격자 지형에 막힘, 2 = 강체에 막힘 (this._rg에 해당 강체)
        if (
            this._cells(x, y, (xx, yy) => {
                if (xx < 0 || xx >= wValue.w || yy >= wValue.h) {
                    return true;
                }
                if (yy < 0) {
                    return false;
                }
                const T = wValue.g[yy * wValue.w + xx];
                return T !== 0 && wValue.BL[T] === 1;
            })
        ) {
            return 1;
        }
        const B = wValue.bridge;
        if (B && !this.sensor && this.rigid !== false) {
            const X0 = x - this.hx + 0.15,
                X1 = x + this.hx - 0.15,
                Y0 = y - this.hy + 0.15,
                Y1 = y + this.hy - 0.15; // 프록시를 .1 줄인 만큼 여유를 둬서 얹힌 상자가 계속 겹침으로 잡히지 않게
            for (const H_VALUE of B.bodies) {
                if (bodyHit(B, H_VALUE, X0, Y0, X1, Y1)) {
                    this._rg = H_VALUE;
                    return 2;
                }
            }
        }
        if (this.solid && !this.sensor) {
            for (const O of wValue.bodies) {
                // 엔티티끼리: solid 끼리는 서로 막힘 (AABB, 맞닿기만 하면 겹침 아님)
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
        // 겹친 엔티티 분리: 더 얕은 축으로, 가벼운 쪽이 더 많이 물러남
        const OX = this.hx + o.hx - Math.abs(this.x - o.x),
            OY = this.hy + o.hy - Math.abs(this.y - o.y);
        if (OX <= 0 || OY <= 0) {
            return;
        }
        const M_VALUE = this.mass + o.mass,
            KS = o.mass / M_VALUE,
            KO = this.mass / M_VALUE;
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
        // 상하좌우 중 가장 가까운 빈 자리로 이동 (동률이면 위, 좌, 우, 아래). 8칸 안에 없으면 끼임(압사 피해)
        const D = [
            [0, -1],
            [-1, 0],
            [1, 0],
            [0, 1],
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
            const K_VALUE = this._hit(wValue, this.x, this.y); // 겹쳤으면 겹침이 최소인 방향으로 빼냄
            if (!K_VALUE) {
                this._rw = 0;
            } else if (K_VALUE === 2 && this._rw < 8) {
                this._rw++;
            } // 강체와만 겹친 경우는 엔진이 상자를 밀어내도록 잠깐(8틱) 기다림
            else if (K_VALUE === 3) {
                this._sep(this._eg);
            } else {
                this._unstick(wValue);
            }
        }
        // 1) 몸이 겹친 셀을 재료별로 집계
        const CNT = this.contacts;
        CNT.clear();
        let n = 0,
            sw = 0;
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
        // 2) 속도 (입력은 body.input으로 외부에서 주입)
        const JP = !!this.input.jump;
        if (JP && !this._jh) {
            this._buf = this.jumpBuffer;
        }
        this._jh = JP; // 점프 버퍼
        if (this.ground) {
            this._coy = this.coyote;
        } else if (this._coy > 0) {
            this._coy--;
        } // 코요테 타임
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
            } // 버튼을 떼면 점프 컷
            if (this.vy >= 0) {
                this._jumping = false;
            }
        }
        if (this.vy < -this.maxRise && !this._jumping) {
            this.vy = -this.maxRise;
        } // 상승 속도 한계 (제트팩 등)
        if (this._buf > 0) {
            this._buf--;
        }
        // 3) 이동과 충돌 (서브스텝, 계단 오르기)
        if (this.sensor) {
            this.x += this.vx;
            this.y += this.vy;
        } else {
            if (this.ground && this._ride) {
                const RX = this._ride.vx;
                if (RX && !this._hit(wValue, this.x + RX, this.y)) {
                    this.x += RX;
                }
            } // 움직이는 강체 위에 타고 이동
            this._ride = null;
            const SX = Math.max(1, Math.ceil(Math.abs(this.vx))),
                DX = this.vx / SX;
            for (let s = 0; s < SX; s++) {
                const K_VALUE = this._hit(wValue, this.x + DX, this.y),
                    RH = K_VALUE === 2 ? this._rg : null,
                    EH = K_VALUE === 3 ? this._eg : null;
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
                        } // 강체 밀기: 운동량 공유, 무거울수록 느려짐
                        else if (EH) {
                            const V = (this.mass * this.vx + EH.mass * EH.vx) / (this.mass + EH.mass);
                            EH.vx = V;
                            this.vx = V;
                        } // 엔티티 밀기도 운동량 공유
                        else {
                            this.vx = 0;
                        }
                        break;
                    }
                }
            }
            this.ground = false;
            const SY = Math.max(1, Math.ceil(Math.abs(this.vy))),
                DY = this.vy / SY;
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
                    } // 올라선 강체에 내 체중이 실림 / 엔티티 위에 서면 같이 이동
                    this.vy = 0;
                    break;
                }
            }
        }
        // 4) 재료가 선언한 효과 적용 (onContact이 true를 반환하면 기본 효과를 건너뜀)
        for (const [T, C_VALUE] of CNT) {
            const M_VALUE = wValue.mats[T],
                E = M_VALUE.body;
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
        // 5) 상태이상 틱
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
                const FX = Math.floor(this.x - this.hx) + wValue.rnd(Math.ceil(this.hx * 2)),
                    FY = Math.floor(this.y - this.hy) - 1;
                if (wValue.get(FX, FY) === 0) {
                    wValue.set(FX, FY, S_VALUE.emit.material);
                }
            }
            if (S_VALUE.tick) {
                S_VALUE.tick(this, wValue);
            }
        }
    }
}

export { PixelWorld, Body, PhysicsBridge, MatterBridge, installDeterministicTrig, HYP as hyp, NOW as now };

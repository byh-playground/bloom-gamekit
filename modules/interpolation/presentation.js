import { RenderObject } from './render-object.js';
import { compileRenderSchema, captureRenderData, writeRenderModel } from './render-schema.js';
import { finite, ordinal } from './schema.js';
import { evaluate } from './tracks.js';

function fraction(track, now, stepMs) {
  return Math.min(1, Math.max(0, (now - track.at) / stepMs));
}

/**
 * 선언 필드만 소유하는 표시 계층. 시뮬/입력/자체 타이머 없이 일반 중첩 모델을 제공합니다.
 * capture packet은 전체 생존 목록이며 기존 timeline과 같은 revision/sequence 계약입니다.
 */
export class PresentationRuntime {
  #stepMs; #tracks = new Map(); #sources = new WeakMap(); #models = new WeakMap();
  #now = -Infinity; #revision = -1; #sequence = -1; #timeMs = -Infinity;
  #extrapolation;

  /** @param {{stepMs:number, extrapolation?:{fields:string[],maxMs:number}}} options */
  constructor({ stepMs, extrapolation } = {}) {
    this.#stepMs = finite(stepMs, 'stepMs');
    if (stepMs <= 0) throw new RangeError('stepMs must be positive');
    if (extrapolation) {
      if (!Array.isArray(extrapolation.fields) || new Set(extrapolation.fields).size !== extrapolation.fields.length || Array.from(extrapolation.fields).some(x => typeof x !== 'string')) throw new TypeError('extrapolation.fields must be unique paths');
      if (finite(extrapolation.maxMs, 'maxMs') <= 0) throw new RangeError('maxMs must be positive');
      if (extrapolation.maxMs < stepMs) throw new RangeError('maxMs must cover the correction stepMs');
      this.#extrapolation = { fields: new Set(extrapolation.fields), maxMs: extrapolation.maxMs };
    }
  }
  get size() { return this.#tracks.size; }
  isModel(value) {
    const owner = value && this.#models.get(value);
    const current = owner && this.#tracks.get(owner.id);
    return !!current && current.generation === owner.generation && current.model === value;
  }
  #checkClock(now) {
    finite(now, 'nowMs');
    if (now < this.#now) throw new RangeError('presentation clock must not go backwards');
  }

  /**
   * @param {{revision:number,sequence:number,timeMs:number,mode?:string,entities:Array<{id:string,generation:number,source:object,type?:typeof RenderObject,teleport?:boolean,resetFields?:string[],initialSource?:object}>}} packet
   * @param {number} nowMs
   */
  capture(packet, nowMs) {
    this.#checkClock(nowMs);
    if (!packet || typeof packet !== 'object') throw new TypeError('packet must be an object');
    const revision = ordinal(packet.revision, 'revision'), sequence = ordinal(packet.sequence, 'sequence'), timeMs = finite(packet.timeMs, 'timeMs');
    const mode = packet.mode ?? 'continuous';
    if (!['continuous', 'reset', 'load', 'rollback'].includes(mode)) throw new TypeError('unknown capture mode');
    if (revision < this.#revision || (revision === this.#revision && sequence <= this.#sequence)) return false;
    const changed = revision !== this.#revision;
    if (this.#revision >= 0 && changed && mode === 'continuous') throw new RangeError('new revision requires reset, load or rollback');
    if (!changed && mode !== 'continuous') throw new RangeError('reset, load and rollback require a newer revision');
    if (!changed && timeMs < this.#timeMs) return false;
    if (!Array.isArray(packet.entities)) throw new TypeError('entities must be an array');
    const next = new Map(), sources = new WeakMap();
    for (const entity of packet.entities) {
      if (!entity || typeof entity.id !== 'string' || !entity.id || next.has(entity.id)) throw new TypeError('entity IDs must be nonempty and unique');
      const generation = ordinal(entity.generation, 'generation'), source = entity.source;
      if (!source || typeof source !== 'object' || sources.has(source)) throw new TypeError('entity sources must be unique objects');
      if (entity.teleport !== undefined && typeof entity.teleport !== 'boolean') throw new TypeError('teleport must be boolean');
      const plan = compileRenderSchema(entity.type ?? source.constructor);
      if (this.#extrapolation) for (const field of plan.fields) {
        if (this.#extrapolation.fields.has(field.name) && field.code !== RenderObject.LINEAR) throw new TypeError('extrapolation requires LINEAR: ' + field.name);
      }
      const target = captureRenderData(plan, source);
      const initial = entity.initialSource === undefined ? null : captureRenderData(plan, entity.initialSource);
      const reset = new Set();
      if (entity.resetFields !== undefined) {
        if (!Array.isArray(entity.resetFields)) throw new TypeError('resetFields must be an array');
        for (const name of entity.resetFields) {
          if (!plan.indices.has(name) || reset.has(name)) throw new TypeError('resetFields must contain unique declared paths');
          reset.add(name);
        }
      }
      const old = this.#tracks.get(entity.id);
      const same = mode === 'continuous' && old && old.generation === generation && old.plan === plan;
      const snap = mode !== 'continuous' || entity.teleport === true;
      const from = (!same && !snap && initial ? initial.values : target.values).slice();
      const velocity = this.#extrapolation ? new Array(plan.fields.length).fill(0) : null;
      for (let i = 0; i < plan.fields.length; i++) {
        const field = plan.fields[i], value = target.values[i];
        if (reset.has(field.name)) from[i] = value;
        if (!same && !snap && initial && this.#extrapolation?.fields.has(field.name) && typeof from[i] === 'number' && typeof value === 'number') {
          if (!Number.isFinite(from[i] - value)) throw new RangeError('extrapolation correction overflow: ' + field.name);
        }
        if (same && !snap && !reset.has(field.name) && typeof value === 'number' && typeof old.target.values[i] === 'number') {
          from[i] = this.#value(old, i, nowMs);
          if (field.code === RenderObject.DECAY && value > old.target.values[i]) from[i] = value;
          if (this.#extrapolation?.fields.has(field.name)) {
            if (field.code !== RenderObject.LINEAR) throw new TypeError('extrapolation requires LINEAR: ' + field.name);
            const delta = timeMs - old.timeMs;
            if (delta > 0) {
              const distance = value - old.target.values[i];
              velocity[i] = !Number.isFinite(delta)
                ? (value / 2 - old.target.values[i] / 2) / (timeMs / 2 - old.timeMs / 2)
                : !Number.isFinite(distance) ? ((value / 2 - old.target.values[i] / 2) / delta) * 2 : distance / delta;
            }
            else velocity[i] = old.velocity[i];
            if (!Number.isFinite(velocity[i])) throw new RangeError('extrapolation velocity overflow: ' + field.name);
            if (!Number.isFinite(from[i] - value)) throw new RangeError('extrapolation correction overflow: ' + field.name);
          }
        }
      }
      const track = { id: entity.id, generation, source, plan, target, from, velocity, at: nowMs, timeMs,
        model: same ? old.model : {}, sampleValues: same ? old.sampleValues : undefined, sampledAt: -Infinity };
      next.set(entity.id, track); sources.set(source, track);
    }
    this.#tracks = next; this.#sources = sources;
    this.#revision = revision; this.#sequence = sequence; this.#timeMs = timeMs; this.#now = nowMs;
    return true;
  }

  #value(track, index, now) {
    const field = track.plan.fields[index], from = track.from[index], to = track.target.values[index];
    if (from == null || to == null || field.code === RenderObject.STEP) return to;
    const alpha = fraction(track, now, this.#stepMs);
    if (this.#extrapolation?.fields.has(field.name)) {
      const age = Math.min(this.#extrapolation.maxMs, Math.max(0, now - track.at));
      // 같은 표현이지만 to + (from-to)는 큰 목표에서 작은 from을 잃습니다.
      const value = evaluate('number', from, to, alpha) + track.velocity[index] * age;
      if (!Number.isFinite(value)) throw new RangeError('extrapolated render value overflow: ' + field.name);
      return value;
    }
    if (field.code === RenderObject.CYCLE) {
      if (alpha === 1) return to;
      const value = evaluate('number', from, to < from ? to + 1 : to, alpha);
      return value > 1 ? value - 1 : value;
    }
    return evaluate(field.kind, from, to, alpha);
  }

  /** 유효 identity가 아니면 null. 원본 fallback은 없습니다. 모델은 프레임 간 재사용됩니다. */
  sample(id, generation, nowMs) {
    this.#checkClock(nowMs);
    const track = this.#tracks.get(id);
    if (!track || track.generation !== generation) { this.#now = nowMs; return null; }
    if (track.sampledAt !== nowMs) {
      const values = track.sampleValues ??= new Array(track.plan.fields.length);
      for (let i = 0; i < values.length; i++) values[i] = this.#value(track, i, nowMs);
      writeRenderModel(track.plan, track.model, values, track.target.shapes);
      track.sampledAt = nowMs; this.#models.set(track.model, track);
    }
    this.#now = nowMs;
    return track.model;
  }

  /** 등록된 원본 객체나 유효한 모델만 받습니다. 삭제·세대 변경된 모델은 다시 그리지 않습니다. */
  modelFor(source, nowMs) {
    this.#checkClock(nowMs);
    if (this.isModel(source)) {
      const owner = this.#models.get(source);
      return this.sample(owner.id, owner.generation, nowMs);
    }
    const track = this.#sources.get(source);
    if (track) return this.sample(track.id, track.generation, nowMs);
    this.#now = nowMs; return null;
  }

  /** 정상적인 객체 메서드 호출입니다. this/프로토타입을 바꾸지 않습니다. */
  render(source, context, nowMs) {
    if (!(source instanceof RenderObject)) throw new TypeError('render() requires a RenderObject');
    const model = this.modelFor(source, nowMs);
    if (!model) throw new Error('Render object has not been captured');
    source.render(context, model);
    return model;
  }
}

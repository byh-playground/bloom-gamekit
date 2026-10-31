// modules/audio/index.js
var AUDIO_DEFAULTS = {
  volume: 0.7,
  headroom: 0.24,
  maxVoices: 12,
  rampMs: 8,
  settings: null,
  onSaveError: null,
  synthesis: {
    attackMs: 4,
    releaseTailMs: 6,
    sourceTailMs: 10,
    noiseMs: 1e3,
    minGain: 1e-4,
    minHz: 20
  },
  compressor: {
    threshold: -18,
    knee: 12,
    ratio: 6,
    attackMs: 3,
    releaseMs: 120
  },
  categories: {
    sfx: {
      volume: 1,
      max: 12,
      gapMs: 0,
      priority: 0
    }
  },
  sounds: {},
  beds: {}
};
function validateRecipe(recipe) {
  if (!recipe || !Array.isArray(recipe.layers) || !recipe.layers.length) {
    throw new TypeError("sound.layers required");
  }
  for (const LAYER of recipe.layers) {
    if (!["tone", "noise", "buffer"].includes(LAYER.kind) || !Number.isFinite(LAYER.ms) || LAYER.ms <= 0 || LAYER.ms > 1e4 || !Number.isFinite(LAYER.gain) || LAYER.gain < 0 || LAYER.gain > 1 || !Number.isFinite(LAYER.delay ?? 0) || (LAYER.delay ?? 0) < 0) {
      throw new RangeError("finite bounded layer duration/gain/delay required");
    }
    if (LAYER.kind === "tone" && (!Number.isFinite(LAYER.hz) || LAYER.hz <= 0 || !Number.isFinite(LAYER.end) || LAYER.end <= 0 || !["sine", "square", "triangle", "sawtooth"].includes(LAYER.type))) {
      throw new RangeError("valid tone frequency/type required");
    }
    if (LAYER.kind === "noise" && (!Number.isFinite(LAYER.hz) || LAYER.hz <= 0)) {
      throw new RangeError("noise cutoff required");
    }
  }
}
var BED_FILTERS = ["lowpass", "bandpass", "highpass"];
var EQ_TYPES = ["lowshelf", "highshelf", "peaking", "notch"];
function validBedEq(eq) {
  const IN_RANGE = (value, low, high) => Number.isFinite(value) && value >= low && value <= high;
  return Array.isArray(eq) && eq.length <= 8 && eq.every(
    (band) => band !== null && typeof band === "object" && EQ_TYPES.includes(band.type) && IN_RANGE(band.hz, 20, 2e4) && (band.type === "notch" ? band.gainDb === void 0 : IN_RANGE(band.gainDb, -24, 24)) && (band.q === void 0 || IN_RANGE(band.q, 0.1, 18))
  );
}
function validBedCompressor(compressor) {
  const IN_RANGE = (value, low, high) => Number.isFinite(value) && value >= low && value <= high;
  return compressor !== null && typeof compressor === "object" && IN_RANGE(compressor.threshold, -100, 0) && IN_RANGE(compressor.ratio, 1, 20) && (compressor.knee === void 0 || IN_RANGE(compressor.knee, 0, 40)) && (compressor.attackMs === void 0 || IN_RANGE(compressor.attackMs, 0, 1e3)) && (compressor.releaseMs === void 0 || IN_RANGE(compressor.releaseMs, 0, 1e3));
}
function validateBed(recipe) {
  if (!recipe || !Array.isArray(recipe.layers) || !recipe.layers.length) {
    throw new TypeError("bed.layers required");
  }
  for (const LAYER of recipe.layers) {
    if ("lfoHz" in LAYER || "lfoDepth" in LAYER) {
      throw new TypeError("bed layer lfoHz/lfoDepth were replaced by lfos: [{ hz, depth }]");
    }
    const LFOS = LAYER.lfos ?? [];
    if (LAYER.kind !== "noise" && LAYER.kind !== "buffer" || LAYER.kind === "buffer" && (typeof LAYER.bufferId !== "string" || !LAYER.bufferId) || (LAYER.kind === "noise" || LAYER.type !== void 0) && (!Number.isFinite(LAYER.hz) || LAYER.hz <= 0) || !Number.isFinite(LAYER.gain) || LAYER.gain < 0 || LAYER.gain > 1 || !BED_FILTERS.includes(LAYER.type ?? "lowpass") || !(LAYER.q === void 0 || Number.isFinite(LAYER.q) && LAYER.q > 0 && LAYER.q <= 30) || !Number.isFinite(LAYER.pan ?? 0) || Math.abs(LAYER.pan ?? 0) > 1 || !Number.isFinite(LAYER.offsetMs ?? 0) || (LAYER.offsetMs ?? 0) < 0 || (LAYER.offsetMs ?? 0) > 6e4 || !(LAYER.lowCutHz === void 0 || Number.isFinite(LAYER.lowCutHz) && LAYER.lowCutHz >= 10 && LAYER.lowCutHz <= 400) || !(LAYER.eq === void 0 || validBedEq(LAYER.eq)) || !(LAYER.compressor === void 0 || validBedCompressor(LAYER.compressor)) || !Array.isArray(LFOS) || LFOS.length > 4 || LFOS.some(
      (lfo) => !Number.isFinite(lfo?.hz) || lfo.hz < 0.01 || lfo.hz > 20 || !Number.isFinite(lfo.depth) || lfo.depth < 0 || lfo.depth > 1
    ) || LFOS.reduce((sum, lfo) => sum + lfo.depth, 0) > 1) {
      throw new RangeError(
        "bed layers are noise {hz} or buffer {bufferId} (hz only with a type), gain 0..1, optional type lowpass|bandpass|highpass, q 0..30, lowCutHz 10..400, eq up to 8 bands {type lowshelf|highshelf|peaking|notch, hz 20..20000, gainDb -24..24, q?}, compressor {threshold -100..0, ratio 1..20, knee?, attackMs?, releaseMs?}, pan -1..1, offsetMs 0..60000 and up to 4 lfos {hz 0.01..20, depth 0..1} whose depths sum to at most 1"
      );
    }
  }
}
var MAX_DETUNE_CENTS = 2400;
function clampPan(value) {
  return Number.isFinite(value) ? Math.max(-1, Math.min(1, value)) : 0;
}
function clampDetune(value) {
  return Number.isFinite(value) ? Math.max(-MAX_DETUNE_CENTS, Math.min(MAX_DETUNE_CENTS, value)) : 0;
}
function rampParam(param, target, rampMs, now) {
  param.cancelScheduledValues(now);
  if (!(rampMs > 0)) {
    param.setValueAtTime(target, now);
    return;
  }
  param.setValueAtTime(param.value, now);
  param.linearRampToValueAtTime(target, now + rampMs / 1e3);
}
function makeNoise(context, noiseMs = AUDIO_DEFAULTS.synthesis.noiseMs) {
  const BUFFER = context.createBuffer(1, Math.round(context.sampleRate * noiseMs / 1e3), context.sampleRate), DATA = BUFFER.getChannelData(0);
  let seed = 213341;
  for (let i = 0; i < DATA.length; i++) {
    seed = Math.imul(seed, 1664525) + 1013904223 >>> 0;
    DATA[i] = seed / 2147483648 - 1;
  }
  return BUFFER;
}
function createMix(context, destination, config = AUDIO_DEFAULTS) {
  const COMPRESSOR = context.createDynamicsCompressor(), MASTER = context.createGain();
  for (const KEY of ["threshold", "knee", "ratio"]) {
    COMPRESSOR[KEY].value = config.compressor[KEY];
  }
  COMPRESSOR.attack.value = config.compressor.attackMs / 1e3;
  COMPRESSOR.release.value = config.compressor.releaseMs / 1e3;
  MASTER.gain.value = config.headroom * config.volume;
  COMPRESSOR.connect(MASTER);
  MASTER.connect(destination);
  return {
    input: COMPRESSOR,
    master: MASTER,
    compressor: COMPRESSOR
  };
}
function renderSound(context, destination, recipe, buffer, {
  at = context.currentTime,
  scale = 1,
  onEnded = () => {
  },
  buffers = /* @__PURE__ */ new Map(),
  synthesis = AUDIO_DEFAULTS.synthesis,
  pan = 0,
  detune = 0
} = {}) {
  validateRecipe(recipe);
  for (const LAYER of recipe.layers) {
    if (LAYER.kind === "buffer" && !buffers.has(LAYER.bufferId)) {
      throw new Error("AudioBuffer not registered: " + LAYER.bufferId);
    }
  }
  const VOICES = [], PAN = clampPan(pan), CENTS = clampDetune(detune);
  let panner = null;
  if (PAN !== 0 && typeof context.createStereoPanner === "function") {
    panner = context.createStereoPanner();
    panner.pan.value = PAN;
    panner.connect(destination);
  }
  const OUTPUT = panner ?? destination;
  let remaining = recipe.layers.length;
  let finished = false;
  const FINISH = () => {
    if (--remaining === 0 && !finished) {
      finished = true;
      panner?.disconnect();
      onEnded();
    }
  };
  for (const LAYER of recipe.layers) {
    const START = at + (LAYER.delay || 0) / 1e3, DURATION = LAYER.ms / 1e3, GAIN = context.createGain();
    let source;
    let filter;
    if (LAYER.kind === "buffer") {
      source = context.createBufferSource();
      source.buffer = buffers.get(LAYER.bufferId);
      source.detune.value = CENTS;
      source.connect(GAIN);
    } else if (LAYER.kind === "noise") {
      source = context.createBufferSource();
      source.buffer = buffer;
      source.loop = DURATION > buffer.duration;
      filter = context.createBiquadFilter();
      filter.type = "lowpass";
      filter.frequency.value = LAYER.hz * 2 ** (CENTS / 1200);
      source.connect(filter);
      filter.connect(GAIN);
    } else {
      source = context.createOscillator();
      source.type = LAYER.type;
      source.detune.value = CENTS;
      source.frequency.setValueAtTime(LAYER.hz, START);
      source.frequency.exponentialRampToValueAtTime(Math.max(synthesis.minHz, LAYER.end), START + DURATION);
      source.connect(GAIN);
    }
    GAIN.gain.setValueAtTime(0, START);
    GAIN.gain.linearRampToValueAtTime(LAYER.gain * scale, START + synthesis.attackMs / 1e3);
    GAIN.gain.exponentialRampToValueAtTime(synthesis.minGain, START + DURATION);
    GAIN.gain.linearRampToValueAtTime(0, START + DURATION + synthesis.releaseTailMs / 1e3);
    GAIN.connect(OUTPUT);
    source.onended = () => {
      source.disconnect();
      filter?.disconnect();
      GAIN.disconnect();
      FINISH();
    };
    source.start(START);
    source.stop(START + DURATION + synthesis.sourceTailMs / 1e3);
    VOICES.push({
      source,
      gain: GAIN
    });
  }
  return {
    stop() {
      for (const VOICE of VOICES) {
        try {
          VOICE.gain.gain.cancelScheduledValues(context.currentTime);
          VOICE.gain.gain.setTargetAtTime(0, context.currentTime, 4e-3);
          VOICE.source.stop(context.currentTime);
        } catch {
        }
      }
    }
  };
}
function renderBed(context, destination, recipe, buffer, { at = context.currentTime, scale = 1, level = 1, fadeMs = 0, buffers = /* @__PURE__ */ new Map(), onEnded = () => {
} } = {}) {
  validateBed(recipe);
  for (const LAYER of recipe.layers) {
    if (LAYER.kind === "buffer" && !buffers.has(LAYER.bufferId)) {
      throw new Error("AudioBuffer not registered: " + LAYER.bufferId);
    }
  }
  const LEVEL = context.createGain(), SWELL = context.createGain(), NODES = [LEVEL, SWELL], SOURCES = [];
  let amount = Math.max(0, Math.min(1, level)), factor = scale, stopped = false;
  SWELL.gain.value = 1;
  SWELL.connect(LEVEL);
  LEVEL.connect(destination);
  LEVEL.gain.setValueAtTime(0, at);
  LEVEL.gain.linearRampToValueAtTime(amount * factor, at + Math.max(fadeMs, 1) / 1e3);
  for (const LAYER of recipe.layers) {
    const SOURCE = context.createBufferSource(), FILTER = LAYER.kind === "noise" || LAYER.type !== void 0 ? context.createBiquadFilter() : null, SAMPLE = LAYER.kind === "buffer" ? buffers.get(LAYER.bufferId) : buffer, GAIN = context.createGain(), LFOS = LAYER.lfos ?? [], DEPTH = LFOS.reduce((sum, lfo) => sum + lfo.depth, 0), PAN = clampPan(LAYER.pan ?? 0);
    SOURCE.buffer = SAMPLE;
    SOURCE.loop = true;
    if (FILTER) {
      FILTER.type = LAYER.type ?? "lowpass";
      FILTER.frequency.value = LAYER.hz;
      if (LAYER.q !== void 0) {
        FILTER.Q.value = LAYER.q;
      }
    }
    GAIN.gain.value = LAYER.gain * (1 - DEPTH / 2);
    let tail = SOURCE;
    if (LAYER.lowCutHz !== void 0) {
      const LOW_CUT = context.createBiquadFilter();
      LOW_CUT.type = "highpass";
      LOW_CUT.frequency.value = LAYER.lowCutHz;
      tail.connect(LOW_CUT);
      tail = LOW_CUT;
      NODES.push(LOW_CUT);
    }
    for (const BAND of LAYER.eq ?? []) {
      const EQ_FILTER = context.createBiquadFilter();
      EQ_FILTER.type = BAND.type;
      EQ_FILTER.frequency.value = BAND.hz;
      if (BAND.gainDb !== void 0) {
        EQ_FILTER.gain.value = BAND.gainDb;
      }
      EQ_FILTER.Q.value = BAND.q ?? (BAND.type === "peaking" || BAND.type === "notch" ? 1 : 0.7071);
      tail.connect(EQ_FILTER);
      tail = EQ_FILTER;
      NODES.push(EQ_FILTER);
    }
    if (FILTER) {
      tail.connect(FILTER);
      tail = FILTER;
      NODES.push(FILTER);
    }
    if (LAYER.compressor) {
      const COMPRESSOR = context.createDynamicsCompressor();
      COMPRESSOR.threshold.value = LAYER.compressor.threshold;
      COMPRESSOR.ratio.value = LAYER.compressor.ratio;
      COMPRESSOR.knee.value = LAYER.compressor.knee ?? 10;
      COMPRESSOR.attack.value = (LAYER.compressor.attackMs ?? 20) / 1e3;
      COMPRESSOR.release.value = (LAYER.compressor.releaseMs ?? 250) / 1e3;
      tail.connect(COMPRESSOR);
      tail = COMPRESSOR;
      NODES.push(COMPRESSOR);
    }
    tail.connect(GAIN);
    NODES.push(GAIN);
    if (PAN !== 0 && typeof context.createStereoPanner === "function") {
      const PANNER = context.createStereoPanner();
      PANNER.pan.value = PAN;
      GAIN.connect(PANNER);
      PANNER.connect(SWELL);
      NODES.push(PANNER);
    } else {
      GAIN.connect(SWELL);
    }
    SOURCE.start(at, (LAYER.offsetMs ?? 0) / 1e3 % SAMPLE.duration);
    SOURCES.push(SOURCE);
    for (const LFO_SPEC of LFOS) {
      if (LFO_SPEC.depth <= 0) {
        continue;
      }
      const LFO = context.createOscillator(), LFO_GAIN = context.createGain();
      LFO.type = "sine";
      LFO.frequency.value = LFO_SPEC.hz;
      LFO_GAIN.gain.value = LAYER.gain * LFO_SPEC.depth / 2;
      LFO.connect(LFO_GAIN);
      LFO_GAIN.connect(GAIN.gain);
      LFO.start(at);
      SOURCES.push(LFO);
      NODES.push(LFO_GAIN);
    }
  }
  let remaining = SOURCES.length;
  for (const SOURCE of SOURCES) {
    SOURCE.onended = () => {
      SOURCE.disconnect();
      if (--remaining === 0) {
        for (const NODE of NODES) {
          NODE.disconnect();
        }
        onEnded();
      }
    };
  }
  return {
    /** Target level 0..1 (times the category volume), reached in rampMs. */
    setLevel(value, rampMs = 0) {
      if (stopped || !Number.isFinite(value)) {
        return;
      }
      amount = Math.max(0, Math.min(1, value));
      rampParam(LEVEL.gain, amount * factor, rampMs, context.currentTime);
    },
    /** Raises the bed by boost (1 = twice as loud) over attackMs and settles back over releaseMs. */
    swell(boost = 1, attackMs = 100, releaseMs = 800) {
      if (stopped || !Number.isFinite(boost) || boost <= 0 || !Number.isFinite(attackMs) || !Number.isFinite(releaseMs)) {
        return;
      }
      const NOW = context.currentTime, ATTACK = Math.max(attackMs, 1) / 1e3, RELEASE = Math.max(releaseMs, 1) / 1e3;
      SWELL.gain.cancelScheduledValues(NOW);
      SWELL.gain.setValueAtTime(SWELL.gain.value, NOW);
      SWELL.gain.linearRampToValueAtTime(1 + boost, NOW + ATTACK);
      SWELL.gain.linearRampToValueAtTime(1, NOW + ATTACK + RELEASE);
    },
    /** The category volume changed: keep the requested level but rescale. */
    setScale(value) {
      factor = value;
      if (!stopped) {
        rampParam(LEVEL.gain, amount * factor, 30, context.currentTime);
      }
    },
    stop(fadeMs2 = 0) {
      if (stopped) {
        return;
      }
      stopped = true;
      const NOW = context.currentTime, FADE = Number.isFinite(fadeMs2) && fadeMs2 > 0 ? fadeMs2 / 1e3 : 0.01;
      rampParam(LEVEL.gain, 0, FADE * 1e3, NOW);
      for (const SOURCE of SOURCES) {
        try {
          SOURCE.stop(NOW + FADE + 0.02);
        } catch {
        }
      }
    }
  };
}
function audioSettings(config = AUDIO_DEFAULTS) {
  const CATEGORIES = config.categories ?? AUDIO_DEFAULTS.categories;
  const UNIT = (value) => Number.isFinite(value) && value >= 0 && value <= 1;
  return {
    key: "audio-settings",
    version: 1,
    create: () => ({
      volume: config.volume ?? AUDIO_DEFAULTS.volume,
      muted: false,
      categories: Object.fromEntries(
        Object.entries(CATEGORIES).map(([name, category]) => [name, category.volume])
      )
    }),
    validate(data) {
      if (!UNIT(data.volume) || typeof data.muted !== "boolean" || !data.categories || typeof data.categories !== "object" || Object.keys(data.categories).some((name) => !(name in CATEGORIES)) || Object.keys(CATEGORIES).some((name) => !UNIT(data.categories[name]))) {
        throw new TypeError("audio settings must hold volume, muted and every category volume in 0..1");
      }
    }
  };
}
var AudioPlayer = class {
  constructor(config = AUDIO_DEFAULTS) {
    config = {
      ...AUDIO_DEFAULTS,
      ...config,
      compressor: {
        ...AUDIO_DEFAULTS.compressor,
        ...config.compressor
      },
      synthesis: {
        ...AUDIO_DEFAULTS.synthesis,
        ...config.synthesis
      }
    };
    this.config = config;
    if (!Number.isSafeInteger(config.maxVoices) || config.maxVoices < 1 || config.maxVoices > 64) {
      throw new RangeError("maxVoices must be 1..64");
    }
    for (const C of Object.values(config.categories)) {
      if (!Number.isFinite(C.volume) || C.volume < 0 || C.volume > 1 || !Number.isSafeInteger(C.max) || C.max < 1 || !Number.isFinite(C.gapMs) || C.gapMs < 0 || !Number.isFinite(C.priority)) {
        throw new RangeError("valid category volume/budget/gap/priority required");
      }
    }
    for (const RECIPE of Object.values(config.sounds)) {
      validateRecipe(RECIPE);
      if (!config.categories[RECIPE.category]) {
        throw new Error("unknown sound category");
      }
    }
    for (const BED of Object.values(config.beds)) {
      validateBed(BED);
      if (!config.categories[BED.category]) {
        throw new Error("unknown bed category");
      }
    }
    this.disposed = false;
    this.beds = /* @__PURE__ */ new Map();
    this.buffers = /* @__PURE__ */ new Map();
    this.categoryVolumes = new Map(Object.entries(config.categories).map(([name, c]) => [name, c.volume]));
    this.context = null;
    this.mix = null;
    this.noise = null;
    this.analyser = null;
    this.volume = config.volume;
    this.muted = false;
    this.voices = /* @__PURE__ */ new Set();
    this.lastCategory = /* @__PURE__ */ new Map();
    this.metrics = {
      played: 0,
      dropped: 0,
      blocked: 0,
      maxObserved: 0,
      bySound: {}
    };
    if (config.settings !== null) {
      if (!config.settings?.data || typeof config.settings.update !== "function") {
        throw new TypeError("settings must be a loaded save from createSave(audioSettings(config))");
      }
      if (typeof config.onSaveError !== "function") {
        throw new TypeError("onSaveError is required with settings");
      }
      const DATA = config.settings.data;
      this.volume = DATA.volume;
      this.muted = DATA.muted;
      for (const [NAME, VALUE] of Object.entries(DATA.categories)) {
        this.categoryVolumes.set(NAME, VALUE);
      }
    }
    this.onGesture = () => {
      if (!globalThis.document?.hidden) {
        void this.unlock();
      }
    };
    this.onHidden = () => {
      if (globalThis.document?.hidden) {
        this.stopAll();
        void this.context?.suspend().catch(() => {
        });
      }
    };
    globalThis.document?.addEventListener("pointerdown", this.onGesture, {
      capture: true
    });
    globalThis.document?.addEventListener("keydown", this.onGesture, {
      capture: true
    });
    globalThis.document?.addEventListener("visibilitychange", this.onHidden);
  }
  async unlock() {
    if (this.disposed) {
      return false;
    }
    try {
      if (!this.context) {
        const AUDIO = globalThis.AudioContext || globalThis.webkitAudioContext;
        if (!AUDIO) {
          return false;
        }
        this.context = new AUDIO({
          latencyHint: "interactive"
        });
        this.analyser = this.context.createAnalyser();
        this.analyser.fftSize = 512;
        this.mix = createMix(this.context, this.analyser, this.config);
        this.analyser.connect(this.context.destination);
        this.noise = makeNoise(this.context, this.config.synthesis.noiseMs);
        this.applyVolume();
        this.context.onstatechange = () => {
          if (this.context.state !== "running") {
            this.stopAll();
          }
        };
      }
      if (globalThis.document?.hidden) {
        return false;
      }
      if (this.context.state !== "running") {
        await this.context.resume();
      }
      return this.context.state === "running";
    } catch (error) {
      this.metrics.blocked++;
      this.lastError = String(error.message || error);
      return false;
    }
  }
  applyVolume() {
    if (!this.mix) {
      return;
    }
    const NOW = this.context.currentTime;
    this.mix.master.gain.cancelScheduledValues(NOW);
    this.mix.master.gain.setTargetAtTime(
      this.muted ? 0 : this.volume * this.config.headroom,
      NOW,
      this.config.rampMs / 1e3
    );
  }
  /** Writes volume, mute and category volumes to `config.settings`. Failures go to `config.onSaveError`. */
  save() {
    const SETTINGS = this.config.settings;
    if (SETTINGS === null) {
      return Promise.resolve();
    }
    const NEXT = { volume: this.volume, muted: this.muted, categories: Object.fromEntries(this.categoryVolumes) };
    return SETTINGS.update((draft) => {
      if (draft.volume === NEXT.volume && draft.muted === NEXT.muted && Object.entries(NEXT.categories).every(([name, value]) => draft.categories[name] === value)) {
        return false;
      }
      Object.assign(draft, NEXT);
    }).catch((error) => this.config.onSaveError(error));
  }
  /** Registers caller-owned reusable decoded data; no fetch/decode or gameplay history. */
  setBuffer(id, buffer) {
    if (typeof id !== "string" || !id || typeof buffer?.getChannelData !== "function") {
      throw new TypeError("AudioBuffer and string ID required");
    }
    this.buffers.set(id, buffer);
  }
  setCategoryVolume(name, value) {
    if (!this.categoryVolumes.has(name) || !Number.isFinite(value)) {
      return false;
    }
    this.categoryVolumes.set(name, Math.max(0, Math.min(1, value)));
    for (const BED of this.beds.values()) {
      if (BED.category === name) {
        BED.handle.setScale(this.categoryVolumes.get(name));
      }
    }
    this.save();
    return true;
  }
  setVolume(value) {
    if (!Number.isFinite(value)) {
      return;
    }
    this.volume = Math.max(0, Math.min(1, value));
    this.applyVolume();
    this.save();
  }
  setMuted(value) {
    this.muted = !!value;
    this.applyVolume();
    if (this.muted) {
      this.stopAll();
    }
    this.save();
  }
  stopAll() {
    for (const VOICE of this.voices) {
      VOICE.handle.stop();
    }
    this.voices.clear();
    this.lastCategory.clear();
  }
  play(id, strength = 1) {
    return !!this.start(id, strength);
  }
  /**
   * Returns a stoppable voice or null; blocked/muted events are dropped, never queued.
   * options: pan -1..1 (left..right), detune in cents (the caller owns any randomness), onEnded().
   */
  start(id, strength = 1, options = {}) {
    if (typeof options !== "object" || options === null) {
      throw new TypeError("start options must be an object: { pan?, detune?, onEnded? }");
    }
    const { pan: PAN = 0, detune: DETUNE = 0, onEnded: ON_ENDED = () => {
    } } = options;
    if (this.disposed || !Number.isFinite(strength) || strength <= 0) {
      return null;
    }
    if (this.muted || this.volume <= 0) {
      return null;
    }
    if (!this.context || this.context.state !== "running" || globalThis.document?.hidden) {
      this.metrics.blocked++;
      return null;
    }
    const RECIPE = this.config.sounds[id];
    if (!RECIPE) {
      return null;
    }
    const CATEGORY = this.config.categories[RECIPE.category], PRIORITY = RECIPE.priority ?? CATEGORY.priority, NOW = this.context.currentTime * 1e3;
    if (NOW - (this.lastCategory.get(RECIPE.category) ?? -Infinity) < (RECIPE.gapMs ?? CATEGORY.gapMs)) {
      this.metrics.dropped++;
      return null;
    }
    if (this.categoryVolumes.get(RECIPE.category) <= 0) {
      return null;
    }
    const GROUP = [...this.voices].filter((v) => v.category === RECIPE.category);
    if (GROUP.length >= CATEGORY.max) {
      const LOW = GROUP.sort((a, b) => a.priority - b.priority || a.at - b.at)[0];
      if (LOW.priority >= PRIORITY) {
        this.metrics.dropped++;
        return null;
      }
      LOW.handle.stop();
      this.voices.delete(LOW);
    }
    if (this.voices.size >= this.config.maxVoices) {
      const LOW = [...this.voices].sort((a, b) => a.priority - b.priority || a.at - b.at)[0];
      if (LOW.priority >= PRIORITY) {
        this.metrics.dropped++;
        return null;
      }
      LOW.handle.stop();
      this.voices.delete(LOW);
    }
    const VOICE = {
      category: RECIPE.category,
      priority: PRIORITY,
      at: NOW,
      handle: null
    };
    VOICE.handle = renderSound(this.context, this.mix.input, RECIPE, this.noise, {
      scale: this.categoryVolumes.get(RECIPE.category) * Math.max(0, Math.min(1, strength)),
      buffers: this.buffers,
      synthesis: this.config.synthesis,
      pan: PAN,
      detune: DETUNE,
      onEnded: () => {
        this.voices.delete(VOICE);
        ON_ENDED();
      }
    });
    this.voices.add(VOICE);
    this.lastCategory.set(RECIPE.category, NOW);
    this.metrics.played++;
    this.metrics.bySound[id] = (this.metrics.bySound[id] || 0) + 1;
    this.metrics.maxObserved = Math.max(this.metrics.maxObserved, this.voices.size);
    return VOICE.handle;
  }
  /**
   * Starts a looping synthesized ambience (config.beds) and returns { setLevel, swell, stop }, or null when
   * the context is locked/hidden, the id is unknown, or the category is silent. Calling it again for a running
   * bed returns the same handle. A bed is not a one-shot voice: it ignores maxVoices, survives stopAll() and
   * mute (the master gain silences it), pauses while the context is suspended and ends on stop()/dispose().
   * Locked contexts drop the request like one-shots do, so start beds after `await unlock()`.
   */
  startBed(id, { level = 1, fadeMs = 400 } = {}) {
    if (this.disposed) {
      return null;
    }
    const RUNNING = this.beds.get(id);
    if (RUNNING) {
      return RUNNING.handle;
    }
    if (!this.context || this.context.state !== "running" || globalThis.document?.hidden) {
      this.metrics.blocked++;
      return null;
    }
    const RECIPE = this.config.beds[id];
    if (!RECIPE || this.categoryVolumes.get(RECIPE.category) <= 0) {
      return null;
    }
    const BED = { category: RECIPE.category, handle: null };
    BED.handle = renderBed(this.context, this.mix.input, RECIPE, this.noise, {
      buffers: this.buffers,
      scale: this.categoryVolumes.get(RECIPE.category),
      level,
      fadeMs,
      onEnded: () => {
        if (this.beds.get(id) === BED) {
          this.beds.delete(id);
        }
      }
    });
    const STOP = BED.handle.stop;
    BED.handle.stop = (stopFadeMs) => {
      this.beds.delete(id);
      STOP(stopFadeMs);
    };
    this.beds.set(id, BED);
    return BED.handle;
  }
  /** Connect to PresentationEventQueue's confirmed SFX policy; no second journal. */
  createAdapter({ onEnded } = {}) {
    if (typeof onEnded !== "function") {
      throw new TypeError("onEnded must release the presentation journal event");
    }
    return {
      reversible: false,
      start: (event) => {
        if (event.policy && event.policy !== "confirmed") {
          throw new Error("one-shot SFX requires confirmed policy");
        }
        let stopped = false;
        const HANDLE = this.start(event.payload?.soundId, event.payload?.strength ?? 1, {
          pan: event.payload?.pan,
          detune: event.payload?.detune,
          onEnded: () => {
            if (!stopped) {
              onEnded(event);
            }
          }
        });
        if (!HANDLE) {
          queueMicrotask(() => {
            if (!stopped) {
              onEnded(event);
            }
          });
        }
        return {
          stop() {
            stopped = true;
            HANDLE?.stop();
          }
        };
      },
      stop: (handle) => handle?.stop()
    };
  }
  meter() {
    if (!this.analyser) {
      return {
        peak: 0,
        rms: 0
      };
    }
    const VALUES = new Float32Array(this.analyser.fftSize);
    this.analyser.getFloatTimeDomainData(VALUES);
    let peak = 0;
    let sum = 0;
    for (const VALUE of VALUES) {
      peak = Math.max(peak, Math.abs(VALUE));
      sum += VALUE * VALUE;
    }
    return {
      peak,
      rms: Math.sqrt(sum / VALUES.length)
    };
  }
  snapshot() {
    return {
      state: this.disposed ? "disposed" : this.context?.state || "locked",
      volume: this.volume,
      muted: this.muted,
      voices: this.voices.size,
      beds: [...this.beds.keys()],
      categoryVolumes: Object.fromEntries(this.categoryVolumes),
      lastError: this.lastError || null,
      ...this.metrics,
      bySound: {
        ...this.metrics.bySound
      }
    };
  }
  dispose() {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    for (const BED of [...this.beds.values()]) {
      BED.handle.stop(0);
    }
    globalThis.document?.removeEventListener("pointerdown", this.onGesture, true);
    globalThis.document?.removeEventListener("keydown", this.onGesture, true);
    globalThis.document?.removeEventListener("visibilitychange", this.onHidden);
    this.stopAll();
    this.buffers.clear();
    this.noise = null;
    this.analyser?.disconnect();
    this.mix?.master.disconnect();
    this.mix?.compressor.disconnect();
    return this.context?.close().catch(() => {
    });
  }
};
export {
  AudioPlayer,
  AUDIO_DEFAULTS as audioDefaults,
  audioSettings,
  createMix,
  makeNoise,
  renderBed,
  renderSound
};

// modules/audio/index.js
var AUDIO_DEFAULTS = {
  volume: 0.7,
  headroom: 0.24,
  maxVoices: 12,
  rampMs: 8,
  storageKey: null,
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
  sounds: {}
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
  synthesis = AUDIO_DEFAULTS.synthesis
} = {}) {
  validateRecipe(recipe);
  for (const LAYER of recipe.layers) {
    if (LAYER.kind === "buffer" && !buffers.has(LAYER.bufferId)) {
      throw new Error("AudioBuffer not registered: " + LAYER.bufferId);
    }
  }
  const VOICES = [];
  let remaining = recipe.layers.length;
  let finished = false;
  const FINISH = () => {
    if (--remaining === 0 && !finished) {
      finished = true;
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
      source.connect(GAIN);
    } else if (LAYER.kind === "noise") {
      source = context.createBufferSource();
      source.buffer = buffer;
      source.loop = DURATION > buffer.duration;
      filter = context.createBiquadFilter();
      filter.type = "lowpass";
      filter.frequency.value = LAYER.hz;
      source.connect(filter);
      filter.connect(GAIN);
    } else {
      source = context.createOscillator();
      source.type = LAYER.type;
      source.frequency.setValueAtTime(LAYER.hz, START);
      source.frequency.exponentialRampToValueAtTime(Math.max(synthesis.minHz, LAYER.end), START + DURATION);
      source.connect(GAIN);
    }
    GAIN.gain.setValueAtTime(0, START);
    GAIN.gain.linearRampToValueAtTime(LAYER.gain * scale, START + synthesis.attackMs / 1e3);
    GAIN.gain.exponentialRampToValueAtTime(synthesis.minGain, START + DURATION);
    GAIN.gain.linearRampToValueAtTime(0, START + DURATION + synthesis.releaseTailMs / 1e3);
    GAIN.connect(destination);
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
    this.disposed = false;
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
    try {
      const DATA = JSON.parse(config.storageKey ? globalThis.localStorage?.getItem(config.storageKey) : null);
      if (DATA) {
        if (Number.isFinite(DATA.volume)) {
          this.volume = Math.max(0, Math.min(1, DATA.volume));
        }
        this.muted = DATA.muted === true;
        for (const [NAME, VALUE] of Object.entries(DATA.categories || {})) {
          if (this.categoryVolumes.has(NAME) && Number.isFinite(VALUE)) {
            this.categoryVolumes.set(NAME, Math.max(0, Math.min(1, VALUE)));
          }
        }
      }
    } catch {
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
  save() {
    if (!this.config.storageKey) {
      return;
    }
    try {
      globalThis.localStorage?.setItem(
        this.config.storageKey,
        JSON.stringify({
          volume: this.volume,
          muted: this.muted,
          categories: Object.fromEntries(this.categoryVolumes)
        })
      );
    } catch {
    }
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
  /** Returns a stoppable voice or null; blocked/muted events are dropped, never queued. */
  start(id, strength = 1, onEnded = () => {
  }) {
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
      onEnded: () => {
        this.voices.delete(VOICE);
        onEnded();
      }
    });
    this.voices.add(VOICE);
    this.lastCategory.set(RECIPE.category, NOW);
    this.metrics.played++;
    this.metrics.bySound[id] = (this.metrics.bySound[id] || 0) + 1;
    this.metrics.maxObserved = Math.max(this.metrics.maxObserved, this.voices.size);
    return VOICE.handle;
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
        const HANDLE = this.start(event.payload?.soundId, event.payload?.strength ?? 1, () => {
          if (!stopped) {
            onEnded(event);
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
  createMix,
  makeNoise,
  renderSound
};

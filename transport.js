// modules/deterministic/utilities.js
var NOW_MS = () => globalThis.performance?.now() ?? Date.now();
var COMPARE_IDS = (a, b) => a < b ? -1 : a > b ? 1 : 0;
function integer(value, name, min = 0, max = 4294967295) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new RangeError(name);
  }
  return value;
}
function bytes(value, name = "bytes") {
  if (value instanceof Uint8Array) {
    return value;
  }
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  throw new TypeError(`${name} must be Uint8Array or ArrayBuffer`);
}
function hashBytes(value, seed = 2166136261) {
  let h = seed >>> 0;
  const DATA2 = bytes(value);
  for (let i = 0; i < DATA2.length; i++) {
    h = Math.imul(h ^ DATA2[i], 16777619) >>> 0;
  }
  return h;
}
var SIGNED = (x) => integer(x, "fixed-point result", -2147483648, 2147483647);
var FIXED_POINT = Object.freeze({
  scale: 1024,
  fromNumber: (x) => SIGNED(Math.round(x * 1024)),
  toNumber: (x) => SIGNED(x) / 1024,
  add: (a, b) => SIGNED(SIGNED(a) + SIGNED(b)),
  sub: (a, b) => SIGNED(SIGNED(a) - SIGNED(b)),
  mul: (a, b) => {
    SIGNED(a);
    SIGNED(b);
    const PRODUCT = a * b;
    if (Number.isSafeInteger(PRODUCT)) {
      return SIGNED(Math.trunc(PRODUCT / 1024) || 0);
    }
    return SIGNED(Number(BigInt(a) * BigInt(b) / 1024n));
  },
  div: (a, b) => {
    if (SIGNED(b) === 0) {
      throw new RangeError("fixed-point division by zero");
    }
    return SIGNED(Number(BigInt(SIGNED(a)) * 1024n / BigInt(b)));
  }
});

// modules/_rollback-shared/protocol.js
var PROTOCOL_VERSION = 3;
var CHUNK_SIZE = 16384;
var DEFAULTS = {
  mode: "rollback",
  inputScheduling: "configured",
  inputSafetyMarginMs: 8,
  inputJitterMultiplier: 2,
  tickRate: 60,
  baseInputDelayTicks: 2,
  minInputDelayTicks: 0,
  maxInputDelayTicks: 8,
  rollbackWindowTicks: 12,
  stateHistorySize: 64,
  predictionPolicy: "hold",
  stallPolicy: "wait",
  tickDriftThreshold: 2,
  pacingPolicy: "hold",
  checksumInterval: 30,
  maxCatchupSteps: 4,
  adaptiveInputDelay: true,
  heartbeatMs: 100,
  adaptationIntervalMs: 1e3,
  maxSnapshotBytes: 4 * 1024 * 1024,
  maxHistoryBytes: 64 * 1024 * 1024,
  maxReplayBytes: 64 * 1024 * 1024,
  maxCommandBytes: 2048,
  maxPendingCommands: 256,
  maxQueuedBytes: 5 * 1024 * 1024,
  recoveryTimeoutMs: 1e4,
  maxRecoveryAttempts: 3,
  peerInterruptMs: 1e3,
  peerTimeoutMs: 1e4
};
var PROFILES = Object.freeze({
  action: Object.freeze({
    ...DEFAULTS
  }),
  rts: Object.freeze({
    ...DEFAULTS,
    tickRate: 20,
    baseInputDelayTicks: 4,
    maxInputDelayTicks: 12,
    rollbackWindowTicks: 6,
    stateHistorySize: 32,
    predictionPolicy: "neutral",
    checksumInterval: 20
  }),
  lockstep: Object.freeze({
    ...DEFAULTS,
    mode: "lockstep",
    tickRate: 20,
    baseInputDelayTicks: 4,
    maxInputDelayTicks: 20,
    rollbackWindowTicks: 0,
    checksumInterval: 20,
    stateHistorySize: 32,
    predictionPolicy: "neutral"
  })
});
var ENCODER = new TextEncoder();
var DECODER = new TextDecoder("utf-8", {
  fatal: true
});
var TYPE = Object.freeze({
  HELLO: 1,
  INPUT: 2,
  CLOCK: 3,
  HASH: 4,
  REQUEST: 5,
  BEGIN: 6,
  CHUNK: 7,
  INPUT_RESERVATION: 8,
  INPUT_RESERVATION_ACK: 9
});
var HEADER = 12;
var SNAP_CHUNK_BYTES = CHUNK_SIZE - HEADER - 8;

// modules/transport/webrtc.js
var WebRTCTransport = class {
  constructor({ inputChannel, controlChannel, highWaterMark = 262144, lowWaterMark = 65536 } = {}) {
    if (!controlChannel || typeof controlChannel.send !== "function") {
      throw new TypeError("controlChannel");
    }
    integer(highWaterMark, "highWaterMark", CHUNK_SIZE, 16 * 1024 * 1024);
    integer(lowWaterMark, "lowWaterMark", 0, highWaterMark);
    this.inputChannel = inputChannel ?? controlChannel;
    this.controlChannel = controlChannel;
    this.highWaterMark = highWaterMark;
    this.listeners = /* @__PURE__ */ new Set();
    this.statusListeners = /* @__PURE__ */ new Set();
    this.closed = false;
    this.connectionState = "connected";
    this._lastStatus = null;
    this.channels = [.../* @__PURE__ */ new Set([this.inputChannel, this.controlChannel])];
    this._onMessage = async (event) => {
      if (this.closed) {
        return;
      }
      let data = event.data;
      if (typeof Blob !== "undefined" && data instanceof Blob) {
        if (data.size > CHUNK_SIZE) {
          return;
        }
        data = await data.arrayBuffer();
      }
      if (this.closed) {
        return;
      }
      try {
        const B = bytes(data);
        if (B.length > CHUNK_SIZE) {
          return;
        }
        for (const LISTENER of this.listeners) {
          LISTENER(B.slice());
        }
      } catch {
      }
    };
    for (const CHANNEL of this.channels) {
      CHANNEL.binaryType = "arraybuffer";
      CHANNEL.bufferedAmountLowThreshold = lowWaterMark;
      CHANNEL.addEventListener("message", this._onMessage);
      CHANNEL.addEventListener("open", this._onStatus = this._onStatus ?? (() => this._notifyStatus()));
      CHANNEL.addEventListener("close", this._onStatus);
      CHANNEL.addEventListener(
        "error",
        this._onChannelError = this._onChannelError ?? (() => {
          this.connectionState = "failed";
          this._notifyStatus();
        })
      );
    }
  }
  get state() {
    if (this.closed || this.connectionState === "closed" || this.channels.some((c) => c.readyState === "closed" || c.readyState === "closing")) {
      return "closed";
    }
    if (this.connectionState === "failed") {
      return "failed";
    }
    if (this.connectionState === "disconnected") {
      return "interrupted";
    }
    return this.channels.every((c) => c.readyState === "open") ? "open" : "connecting";
  }
  _notifyStatus() {
    const STATE = this.state;
    if (STATE === this._lastStatus) {
      return;
    }
    this._lastStatus = STATE;
    for (const LISTENER of this.statusListeners) {
      try {
        LISTENER(STATE);
      } catch {
      }
    }
  }
  setConnectionState(state) {
    this.connectionState = state;
    this._notifyStatus();
  }
  subscribeStatus(listener) {
    if (typeof listener !== "function") {
      throw new TypeError("status subscriber");
    }
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }
  get bufferedAmount() {
    return this.channels.reduce((n, c) => n + c.bufferedAmount, 0);
  }
  send(data) {
    const B = bytes(data);
    if (B.length > CHUNK_SIZE) {
      throw new RangeError("DataChannel chunk size");
    }
    const TYPE_LOCAL = B.length >= HEADER ? B[5] : 0;
    const CHANNEL = TYPE_LOCAL === TYPE.INPUT || TYPE_LOCAL === TYPE.CLOCK ? this.inputChannel : this.controlChannel;
    if (this.closed || CHANNEL.readyState !== "open" || this.bufferedAmount + B.length > this.highWaterMark) {
      return false;
    }
    try {
      CHANNEL.send(B);
      return true;
    } catch (error) {
      if (error.name === "OperationError" || error.name === "InvalidStateError") {
        return false;
      }
      throw error;
    }
  }
  subscribe(handler) {
    if (this.closed || typeof handler !== "function") {
      throw new TypeError("transport subscriber");
    }
    this.listeners.add(handler);
    return () => this.listeners.delete(handler);
  }
  close() {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this._notifyStatus();
    for (const CHANNEL of this.channels) {
      CHANNEL.removeEventListener("message", this._onMessage);
      CHANNEL.removeEventListener("open", this._onStatus);
      CHANNEL.removeEventListener("close", this._onStatus);
      CHANNEL.removeEventListener("error", this._onChannelError);
      CHANNEL.close();
    }
    this.listeners.clear();
    this.statusListeners.clear();
  }
};
var DEFAULT_ICE = Object.freeze([
  {
    urls: "stun:stun.l.google.com:19302"
  }
]);
function createWebRTCPeer({
  initiator = false,
  signaler,
  remoteId,
  rtcConfig = {
    iceServers: DEFAULT_ICE
  },
  timeoutMs = 2e4,
  RTCPeerConnectionImpl: rTCPeerConnectionImpl = globalThis.RTCPeerConnection,
  onStatus = () => {
  },
  signal
} = {}) {
  if (signal?.aborted) {
    return Promise.reject(new Error("connection aborted"));
  }
  if (typeof rTCPeerConnectionImpl !== "function" || typeof signaler?.send !== "function" || typeof signaler.subscribe !== "function" || !remoteId) {
    return Promise.reject(new TypeError("WebRTC and Signaler capabilities required"));
  }
  let pc;
  try {
    integer(timeoutMs, "timeoutMs", 1, 12e4);
    pc = new rTCPeerConnectionImpl(rtcConfig);
  } catch (error) {
    return Promise.reject(error);
  }
  let inputChannel;
  let controlChannel;
  let transport;
  let unsubscribe;
  let timer;
  let disposed = false;
  let settled = false;
  let chain = Promise.resolve();
  const EARLY_ICE = [], ICE_BATCH = [];
  let iceTimer;
  const STATUS = (value) => {
    try {
      onStatus(value);
    } catch {
    }
  };
  let resolve;
  let reject;
  const RESULT = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  const CLOSE = () => {
    if (disposed) {
      return;
    }
    disposed = true;
    clearTimeout(timer);
    clearTimeout(iceTimer);
    unsubscribe?.();
    signal?.removeEventListener("abort", CLOSE);
    transport?.close();
    pc.close();
    if (!settled) {
      settled = true;
      reject(new Error("WebRTC connection closed"));
    }
  };
  const FAIL = (error) => {
    STATUS({
      type: "connection-error",
      error
    });
    if (!settled) {
      settled = true;
      reject(error);
    }
    CLOSE();
  };
  signal?.addEventListener("abort", CLOSE, {
    once: true
  });
  const SEND = (message) => Promise.resolve(signaler.send(remoteId, message));
  const MAYBE_READY = () => {
    if (disposed || settled || inputChannel?.readyState !== "open" || controlChannel?.readyState !== "open") {
      return;
    }
    clearTimeout(timer);
    settled = true;
    transport = new WebRTCTransport({
      inputChannel,
      controlChannel
    });
    STATUS({
      type: "connected"
    });
    resolve({
      transport,
      peerConnection: pc,
      close: CLOSE
    });
  };
  const CHANNEL = (value) => {
    if (value.label === "inputs" && !inputChannel) {
      inputChannel = value;
    } else if (value.label === "control" && !controlChannel) {
      controlChannel = value;
    } else {
      value.close();
      return;
    }
    value.addEventListener("open", MAYBE_READY);
    MAYBE_READY();
  };
  pc.addEventListener("datachannel", (event) => CHANNEL(event.channel));
  const FLUSH_CANDIDATES = () => {
    clearTimeout(iceTimer);
    if (disposed || !ICE_BATCH.length) {
      return;
    }
    SEND({
      type: "ice",
      candidates: ICE_BATCH.splice(0)
    }).catch(FAIL);
  };
  pc.addEventListener("icecandidate", (event) => {
    if (disposed) {
      return;
    }
    if (event.candidate) {
      if (ICE_BATCH.length >= 128) {
        FAIL(new RangeError("ICE candidate batch capacity"));
        return;
      }
      ICE_BATCH.push(event.candidate.toJSON());
      clearTimeout(iceTimer);
      iceTimer = setTimeout(FLUSH_CANDIDATES, 100);
    } else {
      FLUSH_CANDIDATES();
    }
  });
  pc.addEventListener("connectionstatechange", () => {
    transport?.setConnectionState(pc.connectionState);
    STATUS({
      type: "connection-state",
      state: pc.connectionState
    });
    if (pc.connectionState === "failed") {
      FAIL(new Error("P2P connection failed; no automatic TURN fallback"));
    }
  });
  const FLUSH_ICE = async () => {
    while (EARLY_ICE.length) {
      await pc.addIceCandidate(EARLY_ICE.shift());
    }
  };
  unsubscribe = signaler.subscribe((event) => {
    if (disposed || event.from !== remoteId || event.to !== signaler.id && event.to !== "*") {
      return;
    }
    const MESSAGE = event.message;
    chain = chain.then(async () => {
      if (disposed) {
        return;
      }
      if (MESSAGE?.type === "offer" && !initiator && !pc.remoteDescription) {
        await pc.setRemoteDescription(MESSAGE.description);
        await FLUSH_ICE();
        await pc.setLocalDescription(await pc.createAnswer());
        await SEND({
          type: "answer",
          description: pc.localDescription.toJSON()
        });
      } else if (MESSAGE?.type === "answer" && initiator && !pc.remoteDescription) {
        await pc.setRemoteDescription(MESSAGE.description);
        await FLUSH_ICE();
      } else if (MESSAGE?.type === "ice") {
        const CANDIDATES = MESSAGE.candidates ?? (MESSAGE.candidate ? [MESSAGE.candidate] : []);
        if (!Array.isArray(CANDIDATES) || CANDIDATES.length > 128) {
          throw new RangeError("ICE candidate batch");
        }
        for (const CANDIDATE of CANDIDATES) {
          if (pc.remoteDescription) {
            await pc.addIceCandidate(CANDIDATE);
          } else if (EARLY_ICE.length < 128) {
            EARLY_ICE.push(CANDIDATE);
          } else {
            throw new RangeError("ICE queue capacity");
          }
        }
      } else if (MESSAGE?.type === "bye") {
        CLOSE();
      }
    }).catch(FAIL);
  });
  timer = setTimeout(() => FAIL(new Error("P2P connection timeout")), integer(timeoutMs, "timeoutMs", 1, 12e4));
  if (initiator) {
    CHANNEL(
      pc.createDataChannel("inputs", {
        ordered: false,
        maxRetransmits: 0
      })
    );
    CHANNEL(
      pc.createDataChannel("control", {
        ordered: true
      })
    );
    chain = chain.then(async () => {
      await pc.setLocalDescription(await pc.createOffer());
      await SEND({
        type: "offer",
        description: pc.localDescription.toJSON()
      });
    }).catch(FAIL);
  }
  return RESULT;
}

// modules/transport/nostr-crypto.js
var NOSTR_FIELD = 0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2fn;
var NOSTR_ORDER = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
var NOSTR_GENERATOR = [
  0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798n,
  0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8n,
  1n
];
var NOSTR_INFINITY = [0n, 1n, 0n];
var NOSTR_ENCODER = new TextEncoder();
function nostrMod(nostrValue, nostrModulus = NOSTR_FIELD) {
  const NOSTR_REMAINDER = nostrValue % nostrModulus;
  return NOSTR_REMAINDER < 0n ? NOSTR_REMAINDER + nostrModulus : NOSTR_REMAINDER;
}
function nostrPow(nostrBase, nostrExponent) {
  let nostrResult = 1n;
  nostrBase = nostrMod(nostrBase);
  while (nostrExponent > 0n) {
    if (nostrExponent & 1n) {
      nostrResult = nostrMod(nostrResult * nostrBase);
    }
    nostrBase = nostrMod(nostrBase * nostrBase);
    nostrExponent >>= 1n;
  }
  return nostrResult;
}
function nostrDouble(nostrPoint) {
  const [NOSTR_X, NOSTR_Y, NOSTR_Z] = nostrPoint;
  if (NOSTR_Z === 0n || NOSTR_Y === 0n) {
    return NOSTR_INFINITY;
  }
  const NOSTR_A = nostrMod(NOSTR_X * NOSTR_X);
  const NOSTR_B = nostrMod(NOSTR_Y * NOSTR_Y);
  const NOSTR_C = nostrMod(NOSTR_B * NOSTR_B);
  const NOSTR_D = nostrMod(2n * (nostrMod((NOSTR_X + NOSTR_B) ** 2n) - NOSTR_A - NOSTR_C));
  const NOSTR_E = nostrMod(3n * NOSTR_A);
  const NOSTR_NEXT_X = nostrMod(NOSTR_E * NOSTR_E - 2n * NOSTR_D);
  return [
    NOSTR_NEXT_X,
    nostrMod(NOSTR_E * (NOSTR_D - NOSTR_NEXT_X) - 8n * NOSTR_C),
    nostrMod(2n * NOSTR_Y * NOSTR_Z)
  ];
}
function nostrAdd(nostrLeft, nostrRight) {
  if (nostrLeft[2] === 0n) {
    return nostrRight;
  }
  if (nostrRight[2] === 0n) {
    return nostrLeft;
  }
  const [NOSTR_X1, NOSTR_Y1, NOSTR_Z1] = nostrLeft;
  const [NOSTR_X2, NOSTR_Y2, NOSTR_Z2] = nostrRight;
  const NOSTR_Z1_SQUARED = nostrMod(NOSTR_Z1 * NOSTR_Z1);
  const NOSTR_Z2_SQUARED = nostrMod(NOSTR_Z2 * NOSTR_Z2);
  const NOSTR_U1 = nostrMod(NOSTR_X1 * NOSTR_Z2_SQUARED);
  const NOSTR_U2 = nostrMod(NOSTR_X2 * NOSTR_Z1_SQUARED);
  const NOSTR_S1 = nostrMod(NOSTR_Y1 * NOSTR_Z2_SQUARED * NOSTR_Z2);
  const NOSTR_S2 = nostrMod(NOSTR_Y2 * NOSTR_Z1_SQUARED * NOSTR_Z1);
  if (NOSTR_U1 === NOSTR_U2) {
    return NOSTR_S1 === NOSTR_S2 ? nostrDouble(nostrLeft) : NOSTR_INFINITY;
  }
  const NOSTR_H = nostrMod(NOSTR_U2 - NOSTR_U1);
  const NOSTR_I = nostrMod(4n * NOSTR_H * NOSTR_H);
  const NOSTR_J = nostrMod(NOSTR_H * NOSTR_I);
  const NOSTR_R = nostrMod(2n * (NOSTR_S2 - NOSTR_S1));
  const NOSTR_V = nostrMod(NOSTR_U1 * NOSTR_I);
  const NOSTR_NEXT_X = nostrMod(NOSTR_R * NOSTR_R - NOSTR_J - 2n * NOSTR_V);
  return [
    NOSTR_NEXT_X,
    nostrMod(NOSTR_R * (NOSTR_V - NOSTR_NEXT_X) - 2n * NOSTR_S1 * NOSTR_J),
    nostrMod(((NOSTR_Z1 + NOSTR_Z2) ** 2n - NOSTR_Z1_SQUARED - NOSTR_Z2_SQUARED) * NOSTR_H)
  ];
}
function nostrMultiply(nostrScalar, nostrPoint = NOSTR_GENERATOR) {
  let nostrResult = NOSTR_INFINITY;
  while (nostrScalar > 0n) {
    if (nostrScalar & 1n) {
      nostrResult = nostrAdd(nostrResult, nostrPoint);
    }
    nostrPoint = nostrDouble(nostrPoint);
    nostrScalar >>= 1n;
  }
  return nostrResult;
}
function nostrAffine(nostrPoint) {
  if (nostrPoint[2] === 0n) {
    return null;
  }
  const NOSTR_INVERSE = nostrPow(nostrPoint[2], NOSTR_FIELD - 2n);
  const NOSTR_INVERSE_SQUARED = nostrMod(NOSTR_INVERSE * NOSTR_INVERSE);
  return [
    nostrMod(nostrPoint[0] * NOSTR_INVERSE_SQUARED),
    nostrMod(nostrPoint[1] * NOSTR_INVERSE_SQUARED * NOSTR_INVERSE)
  ];
}
function nostrLiftX(nostrX) {
  if (nostrX >= NOSTR_FIELD) {
    return null;
  }
  const NOSTR_C = nostrMod(nostrX ** 3n + 7n);
  const NOSTR_Y = nostrPow(NOSTR_C, (NOSTR_FIELD + 1n) / 4n);
  if (nostrMod(NOSTR_Y * NOSTR_Y) !== NOSTR_C) {
    return null;
  }
  return [nostrX, NOSTR_Y & 1n ? NOSTR_FIELD - NOSTR_Y : NOSTR_Y, 1n];
}
function nostrRequireBytes(nostrValue, nostrLength, nostrName) {
  if (!(nostrValue instanceof Uint8Array) || nostrValue.length !== nostrLength) {
    throw new TypeError(`${nostrName} must be a ${nostrLength}-byte Uint8Array`);
  }
  return new Uint8Array(nostrValue);
}
function nostrBytesToNumber(nostrBytes) {
  let nostrValue = 0n;
  for (const NOSTR_BYTE of nostrBytes) {
    nostrValue = nostrValue << 8n | BigInt(NOSTR_BYTE);
  }
  return nostrValue;
}
function nostrNumberToBytes(nostrValue) {
  const NOSTR_BYTES = new Uint8Array(32);
  for (let nostrIndex = 31; nostrIndex >= 0; nostrIndex--) {
    NOSTR_BYTES[nostrIndex] = Number(nostrValue & 255n);
    nostrValue >>= 8n;
  }
  return NOSTR_BYTES;
}
function nostrToHex(nostrBytes) {
  return Array.from(nostrBytes, (nostrByte) => nostrByte.toString(16).padStart(2, "0")).join("");
}
function nostrFromHex(nostrHex) {
  return Uint8Array.from(nostrHex.match(/../g), (nostrByte) => parseInt(nostrByte, 16));
}
function nostrConcat(...nostrParts) {
  const NOSTR_BYTES = new Uint8Array(nostrParts.reduce((nostrSize, nostrPart) => nostrSize + nostrPart.length, 0));
  let nostrOffset = 0;
  for (const NOSTR_PART of nostrParts) {
    NOSTR_BYTES.set(NOSTR_PART, nostrOffset);
    nostrOffset += NOSTR_PART.length;
  }
  return NOSTR_BYTES;
}
function nostrRequireCrypto(nostrCryptoImpl, nostrRandom = false) {
  if (!nostrCryptoImpl?.subtle || typeof nostrCryptoImpl.subtle.digest !== "function" || nostrRandom && typeof nostrCryptoImpl.getRandomValues !== "function") {
    throw new Error("Nostr signaling requires WebCrypto SHA-256 and secure randomness (use HTTPS)");
  }
}
async function nostrHash(nostrBytes, nostrCryptoImpl) {
  nostrRequireCrypto(nostrCryptoImpl);
  return new Uint8Array(await nostrCryptoImpl.subtle.digest("SHA-256", nostrBytes));
}
async function nostrTaggedHash(nostrTag, nostrBytes, nostrCryptoImpl) {
  const NOSTR_TAG_HASH = await nostrHash(NOSTR_ENCODER.encode(nostrTag), nostrCryptoImpl);
  return nostrHash(nostrConcat(NOSTR_TAG_HASH, NOSTR_TAG_HASH, nostrBytes), nostrCryptoImpl);
}
function nostrPublicKey(nostrSecret) {
  const NOSTR_SECRET_COPY = nostrRequireBytes(nostrSecret, 32, "secret");
  try {
    const NOSTR_SCALAR = nostrBytesToNumber(NOSTR_SECRET_COPY);
    if (NOSTR_SCALAR === 0n || NOSTR_SCALAR >= NOSTR_ORDER) {
      throw new RangeError("Invalid secp256k1 secret");
    }
    return nostrNumberToBytes(nostrAffine(nostrMultiply(NOSTR_SCALAR))[0]);
  } finally {
    NOSTR_SECRET_COPY.fill(0);
  }
}
async function nostrVerify(nostrSignature, nostrMessage, nostrPublic, nostrCryptoImpl) {
  if (!(nostrSignature instanceof Uint8Array) || nostrSignature.length !== 64 || !(nostrMessage instanceof Uint8Array) || nostrMessage.length !== 32 || !(nostrPublic instanceof Uint8Array) || nostrPublic.length !== 32) {
    return false;
  }
  const NOSTR_SIGNATURE_COPY = new Uint8Array(nostrSignature);
  const NOSTR_MESSAGE_COPY = new Uint8Array(nostrMessage);
  const NOSTR_PUBLIC_COPY = new Uint8Array(nostrPublic);
  const NOSTR_POINT = nostrLiftX(nostrBytesToNumber(NOSTR_PUBLIC_COPY));
  const NOSTR_R = nostrBytesToNumber(NOSTR_SIGNATURE_COPY.subarray(0, 32));
  const NOSTR_S = nostrBytesToNumber(NOSTR_SIGNATURE_COPY.subarray(32));
  if (!NOSTR_POINT || NOSTR_R >= NOSTR_FIELD || NOSTR_S >= NOSTR_ORDER) {
    return false;
  }
  const NOSTR_CHALLENGE = nostrBytesToNumber(
    await nostrTaggedHash(
      "BIP0340/challenge",
      nostrConcat(NOSTR_SIGNATURE_COPY.subarray(0, 32), NOSTR_PUBLIC_COPY, NOSTR_MESSAGE_COPY),
      nostrCryptoImpl
    )
  ) % NOSTR_ORDER;
  const NOSTR_RESULT = nostrAffine(
    nostrAdd(
      nostrMultiply(NOSTR_S),
      nostrMultiply(NOSTR_CHALLENGE, [NOSTR_POINT[0], nostrMod(-NOSTR_POINT[1]), 1n])
    )
  );
  return NOSTR_RESULT !== null && (NOSTR_RESULT[1] & 1n) === 0n && NOSTR_RESULT[0] === NOSTR_R;
}
async function nostrSign(nostrMessage, nostrSecret, nostrAuxiliary, nostrCryptoImpl) {
  const NOSTR_MESSAGE_COPY = nostrRequireBytes(nostrMessage, 32, "message");
  const NOSTR_AUXILIARY_COPY = nostrRequireBytes(nostrAuxiliary, 32, "auxiliary randomness");
  const NOSTR_SECRET_COPY = nostrRequireBytes(nostrSecret, 32, "secret");
  let nostrMaskedSecret;
  try {
    const NOSTR_SCALAR = nostrBytesToNumber(NOSTR_SECRET_COPY);
    if (NOSTR_SCALAR === 0n || NOSTR_SCALAR >= NOSTR_ORDER) {
      throw new RangeError("Invalid secp256k1 secret");
    }
    const NOSTR_POINT = nostrAffine(nostrMultiply(NOSTR_SCALAR));
    const NOSTR_NORMALIZED_SECRET = NOSTR_POINT[1] & 1n ? NOSTR_ORDER - NOSTR_SCALAR : NOSTR_SCALAR;
    const NOSTR_PUBLIC = nostrNumberToBytes(NOSTR_POINT[0]);
    const NOSTR_AUXILIARY_HASH = await nostrTaggedHash("BIP0340/aux", NOSTR_AUXILIARY_COPY, nostrCryptoImpl);
    nostrMaskedSecret = nostrNumberToBytes(NOSTR_NORMALIZED_SECRET);
    for (let nostrIndex = 0; nostrIndex < 32; nostrIndex++) {
      nostrMaskedSecret[nostrIndex] ^= NOSTR_AUXILIARY_HASH[nostrIndex];
    }
    const NOSTR_NONCE = nostrBytesToNumber(
      await nostrTaggedHash(
        "BIP0340/nonce",
        nostrConcat(nostrMaskedSecret, NOSTR_PUBLIC, NOSTR_MESSAGE_COPY),
        nostrCryptoImpl
      )
    ) % NOSTR_ORDER;
    if (NOSTR_NONCE === 0n) {
      throw new Error("BIP340 nonce generation failed");
    }
    const NOSTR_NONCE_POINT = nostrAffine(nostrMultiply(NOSTR_NONCE));
    const NOSTR_NORMALIZED_NONCE = NOSTR_NONCE_POINT[1] & 1n ? NOSTR_ORDER - NOSTR_NONCE : NOSTR_NONCE;
    const NOSTR_R = nostrNumberToBytes(NOSTR_NONCE_POINT[0]);
    const NOSTR_CHALLENGE = nostrBytesToNumber(
      await nostrTaggedHash(
        "BIP0340/challenge",
        nostrConcat(NOSTR_R, NOSTR_PUBLIC, NOSTR_MESSAGE_COPY),
        nostrCryptoImpl
      )
    ) % NOSTR_ORDER;
    const NOSTR_SIGNATURE = nostrConcat(
      NOSTR_R,
      nostrNumberToBytes(
        nostrMod(NOSTR_NORMALIZED_NONCE + NOSTR_CHALLENGE * NOSTR_NORMALIZED_SECRET, NOSTR_ORDER)
      )
    );
    if (!await nostrVerify(NOSTR_SIGNATURE, NOSTR_MESSAGE_COPY, NOSTR_PUBLIC, nostrCryptoImpl)) {
      throw new Error("BIP340 signature self-check failed");
    }
    return NOSTR_SIGNATURE;
  } finally {
    NOSTR_SECRET_COPY.fill(0);
    NOSTR_AUXILIARY_COPY.fill(0);
    nostrMaskedSecret?.fill(0);
  }
}
var NOSTR_CRYPTO = Object.freeze({
  publicKey: nostrPublicKey,
  sign: (nostrMessage, nostrSecret, nostrAuxiliary) => nostrSign(nostrMessage, nostrSecret, nostrAuxiliary, globalThis.crypto),
  verify: (nostrSignature, nostrMessage, nostrPublic) => nostrVerify(nostrSignature, nostrMessage, nostrPublic, globalThis.crypto)
});

// modules/transport/nostr.js
var NOSTR_HEX32 = /^[0-9a-f]{64}$/;
var NOSTR_HEX64 = /^[0-9a-f]{128}$/;
var NOSTR_SIGNAL_TYPES = /* @__PURE__ */ new Set(["discover", "presence", "offer", "answer", "ice", "bye", "group"]);
var NOSTR_CONTENT_LIMIT = 128 * 1024;
var NOSTR_FRESH_SECONDS = 120;
var NOSTR_FUTURE_SECONDS = 30;
function nostrIsSignalMessage(nostrMessage) {
  return nostrMessage !== null && typeof nostrMessage === "object" && !Array.isArray(nostrMessage) && Object.prototype.hasOwnProperty.call(nostrMessage, "type") && NOSTR_SIGNAL_TYPES.has(nostrMessage.type);
}
function nostrListen(nostrSocket, nostrType, nostrHandler) {
  if (typeof nostrSocket.addEventListener === "function") {
    nostrSocket.addEventListener(nostrType, nostrHandler);
    return () => nostrSocket.removeEventListener(nostrType, nostrHandler);
  }
  const NOSTR_PROPERTY = `on${nostrType}`;
  nostrSocket[NOSTR_PROPERTY] = nostrHandler;
  return () => {
    if (nostrSocket[NOSTR_PROPERTY] === nostrHandler) {
      nostrSocket[NOSTR_PROPERTY] = null;
    }
  };
}
async function createNostrSignaler({
  room,
  namespace = "rollback-netcode",
  relays = ["wss://relay.primal.net", "wss://relay.damus.io"],
  timeoutMs = 1e4,
  onStatus = () => {
  },
  WebSocketImpl: webSocketImpl = globalThis.WebSocket,
  cryptoImpl = globalThis.crypto,
  signal,
  publishIntervalMs = 500,
  maxVerificationsPerSecond = 16,
  verificationBurst = 8,
  identity
} = {}) {
  if (signal?.aborted) {
    throw new Error("Nostr signaler aborted");
  }
  if (typeof room !== "string" || !/^\d{4}$/.test(room)) {
    throw new TypeError("room must contain exactly four ASCII digits");
  }
  if (typeof namespace !== "string" || namespace.trim().length === 0 || NOSTR_ENCODER.encode(namespace).length > 128) {
    throw new TypeError("namespace must be a nonempty string of at most 128 UTF-8 bytes");
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 12e4) {
    throw new RangeError("timeoutMs must be greater than zero and at most 120000");
  }
  integer(publishIntervalMs, "publishIntervalMs", 0, 1e4);
  integer(maxVerificationsPerSecond, "maxVerificationsPerSecond", 1, 1024);
  integer(verificationBurst, "verificationBurst", 1, 32);
  if (typeof webSocketImpl !== "function") {
    throw new Error("Nostr signaling requires WebSocket support");
  }
  if (typeof onStatus !== "function") {
    throw new TypeError("onStatus must be a function");
  }
  nostrRequireCrypto(cryptoImpl, true);
  if (!Array.isArray(relays) || relays.length === 0 || relays.length > 16) {
    throw new TypeError("relays must contain between 1 and 16 WebSocket URLs");
  }
  const NOSTR_URLS = [
    ...new Set(
      relays.map((nostrRelay) => {
        if (typeof nostrRelay !== "string") {
          throw new TypeError("Relay URLs must be strings");
        }
        const NOSTR_URL = new URL(nostrRelay);
        if (!["ws:", "wss:"].includes(NOSTR_URL.protocol) || NOSTR_URL.username || NOSTR_URL.password || NOSTR_URL.hash) {
          throw new TypeError("Relays must be ws:// or wss:// URLs without credentials or fragments");
        }
        return NOSTR_URL.href;
      })
    )
  ];
  const NOSTR_RANDOM = (nostrLength) => cryptoImpl.getRandomValues(new Uint8Array(nostrLength));
  if (identity && (!NOSTR_HEX32.test(identity.id) || typeof identity.sign !== "function" || typeof identity.close !== "function")) {
    throw new TypeError("Nostr identity capability");
  }
  const NOSTR_SECRET = new Uint8Array(32);
  let nostrSecretReady = !!identity;
  for (let nostrAttempt = 0; !nostrSecretReady && nostrAttempt < 16; nostrAttempt++) {
    NOSTR_SECRET.set(NOSTR_RANDOM(32));
    const NOSTR_VALUE = nostrBytesToNumber(NOSTR_SECRET);
    if (NOSTR_VALUE > 0n && NOSTR_VALUE < NOSTR_ORDER) {
      nostrSecretReady = true;
      break;
    }
  }
  if (!nostrSecretReady) {
    NOSTR_SECRET.fill(0);
    throw new Error("Secure random secret generation failed");
  }
  const NOSTR_ID = identity?.id ?? nostrToHex(nostrPublicKey(NOSTR_SECRET));
  const NOSTR_ROOM_TAG = `${namespace}:${room}`;
  const NOSTR_SUBSCRIPTION = `rn-${nostrToHex(NOSTR_RANDOM(16))}`;
  const NOSTR_LISTENERS = /* @__PURE__ */ new Set();
  const NOSTR_BACKLOG = [];
  const NOSTR_SEEN = /* @__PURE__ */ new Map();
  const NOSTR_VERIFYING = /* @__PURE__ */ new Set();
  const NOSTR_PENDING = /* @__PURE__ */ new Map();
  const NOSTR_STATES = [];
  let verificationTokens = verificationBurst;
  let verificationAt = NOW_MS();
  const VERIFICATION_METRICS = {
    attempted: 0,
    verified: 0,
    throttled: 0,
    totalVerificationMs: 0,
    maxVerificationMs: 0
  };
  let nostrClosed = false;
  let nostrSending = 0;
  let nostrSendTail = Promise.resolve();
  let nostrLastPublication = -Infinity;
  const NOSTR_WAITERS = /* @__PURE__ */ new Map();
  let nostrHasSubscriber = false;
  let nostrReadyResolve;
  let nostrReadyReject;
  let nostrInitializationSettled = false;
  const NOSTR_READY = new Promise((nostrResolve, nostrReject) => {
    nostrReadyResolve = nostrResolve;
    nostrReadyReject = nostrReject;
  });
  const NOSTR_STATUS = (nostrStatusName, nostrRelay, nostrMessage) => {
    if (nostrClosed && nostrStatusName !== "closed") {
      return;
    }
    try {
      onStatus({
        type: "signaler",
        transport: "nostr",
        status: nostrStatusName,
        ...nostrRelay ? {
          relay: nostrRelay
        } : {},
        ...nostrMessage ? {
          message: String(nostrMessage)
        } : {}
      });
    } catch {
    }
  };
  function nostrFinishPublication(nostrEventId, nostrError) {
    const NOSTR_PUBLICATION = NOSTR_PENDING.get(nostrEventId);
    if (!NOSTR_PUBLICATION) {
      return;
    }
    clearTimeout(NOSTR_PUBLICATION.timer);
    NOSTR_PENDING.delete(nostrEventId);
    if (nostrError) {
      NOSTR_PUBLICATION.reject(nostrError);
    } else {
      NOSTR_PUBLICATION.resolve();
    }
  }
  function nostrPublicationFailure(nostrState, nostrEventId, nostrReason) {
    const NOSTR_PUBLICATION = NOSTR_PENDING.get(nostrEventId);
    if (!NOSTR_PUBLICATION || !NOSTR_PUBLICATION.remaining.delete(nostrState)) {
      return;
    }
    NOSTR_PUBLICATION.failures.push(`${nostrState.url}: ${nostrReason}`);
    if (NOSTR_PUBLICATION.remaining.size === 0 && !NOSTR_STATES.some((nostrRelay) => !nostrRelay.failed && !nostrRelay.ready)) {
      nostrFinishPublication(
        nostrEventId,
        new Error(`No Nostr relay accepted the event: ${NOSTR_PUBLICATION.failures.join("; ")}`)
      );
    }
  }
  function nostrFailRelay(nostrState, nostrReason) {
    if (nostrState.failed || nostrClosed) {
      return;
    }
    nostrState.failed = true;
    nostrState.ready = false;
    clearTimeout(nostrState.timer);
    for (const NOSTR_REMOVE of nostrState.remove) {
      NOSTR_REMOVE();
    }
    try {
      nostrState.socket?.close();
    } catch {
    }
    for (const NOSTR_EVENT_ID of NOSTR_PENDING.keys()) {
      nostrPublicationFailure(nostrState, NOSTR_EVENT_ID, nostrReason);
    }
    NOSTR_STATUS("error", nostrState.url, nostrReason);
    if (!nostrInitializationSettled && NOSTR_STATES.length === NOSTR_URLS.length && NOSTR_STATES.every((nostrRelay) => nostrRelay.failed)) {
      nostrInitializationSettled = true;
      nostrReadyReject(new Error(`No Nostr relay became ready: ${nostrReason}`));
    }
  }
  function nostrDeliver(nostrEnvelope) {
    if (nostrClosed) {
      return;
    }
    if (!nostrHasSubscriber) {
      if (NOSTR_BACKLOG.length === 32) {
        NOSTR_BACKLOG.shift();
      }
      NOSTR_BACKLOG.push(nostrEnvelope);
      return;
    }
    for (const NOSTR_HANDLER of [...NOSTR_LISTENERS]) {
      if (nostrClosed) {
        break;
      }
      try {
        const NOSTR_RESULT = NOSTR_HANDLER(nostrEnvelope);
        if (NOSTR_RESULT && typeof NOSTR_RESULT.then === "function") {
          Promise.resolve(NOSTR_RESULT).catch(
            (nostrError) => NOSTR_STATUS("error", null, nostrError?.message || "Signaling subscriber failed")
          );
        }
      } catch (nostrError) {
        NOSTR_STATUS("error", null, nostrError?.message || "Signaling subscriber failed");
      }
    }
  }
  async function nostrReceive(nostrEvent) {
    if (nostrClosed || !nostrEvent || typeof nostrEvent !== "object" || Array.isArray(nostrEvent) || typeof nostrEvent.id !== "string" || typeof nostrEvent.pubkey !== "string" || typeof nostrEvent.sig !== "string" || !NOSTR_HEX32.test(nostrEvent.id) || !NOSTR_HEX32.test(nostrEvent.pubkey) || !NOSTR_HEX64.test(nostrEvent.sig) || nostrEvent.pubkey === NOSTR_ID || nostrEvent.kind !== 20078 || !Number.isSafeInteger(nostrEvent.created_at) || typeof nostrEvent.content !== "string" || nostrEvent.content.length > NOSTR_CONTENT_LIMIT || !Array.isArray(nostrEvent.tags) || nostrEvent.tags.length > 16 || NOSTR_VERIFYING.size >= 32) {
      return;
    }
    const NOSTR_NOW = Date.now();
    const NOSTR_NOW_SECONDS = Math.floor(NOSTR_NOW / 1e3);
    if (nostrEvent.created_at < NOSTR_NOW_SECONDS - NOSTR_FRESH_SECONDS || nostrEvent.created_at > NOSTR_NOW_SECONDS + NOSTR_FUTURE_SECONDS || NOSTR_ENCODER.encode(nostrEvent.content).length > NOSTR_CONTENT_LIMIT) {
      return;
    }
    for (const [NOSTR_SEEN_ID, NOSTR_EXPIRY] of NOSTR_SEEN) {
      if (NOSTR_EXPIRY > NOSTR_NOW) {
        break;
      }
      NOSTR_SEEN.delete(NOSTR_SEEN_ID);
    }
    if (NOSTR_SEEN.has(nostrEvent.id) || NOSTR_VERIFYING.has(nostrEvent.id)) {
      return;
    }
    if (!nostrEvent.tags.every(
      (nostrTag) => Array.isArray(nostrTag) && nostrTag.length > 0 && nostrTag.length <= 4 && nostrTag.every(
        (nostrValue) => typeof nostrValue === "string" && NOSTR_ENCODER.encode(nostrValue).length <= 256
      )
    )) {
      return;
    }
    const NOSTR_ROOM_TAGS = nostrEvent.tags.filter((nostrTag) => nostrTag[0] === "d");
    const NOSTR_RECIPIENT_TAGS = nostrEvent.tags.filter((nostrTag) => nostrTag[0] === "p");
    if (NOSTR_ROOM_TAGS.length !== 1 || NOSTR_ROOM_TAGS[0][1] !== NOSTR_ROOM_TAG) {
      return;
    }
    let nostrContent;
    try {
      nostrContent = JSON.parse(nostrEvent.content);
    } catch {
      return;
    }
    if (!nostrContent || nostrContent.v !== 1 || nostrContent.namespace !== namespace || nostrContent.room !== room || nostrContent.from !== nostrEvent.pubkey || typeof nostrContent.nonce !== "string" || !/^[0-9a-f]{32}$/.test(nostrContent.nonce) || nostrContent.to !== "*" && nostrContent.to !== NOSTR_ID || !nostrIsSignalMessage(nostrContent.message)) {
      return;
    }
    if (nostrContent.to === "*" ? NOSTR_RECIPIENT_TAGS.length !== 0 : NOSTR_RECIPIENT_TAGS.length !== 1 || NOSTR_RECIPIENT_TAGS[0][1] !== nostrContent.to) {
      return;
    }
    const MEASURED_NOW = NOW_MS();
    verificationTokens = Math.min(
      verificationBurst,
      verificationTokens + Math.max(0, MEASURED_NOW - verificationAt) * maxVerificationsPerSecond / 1e3
    );
    verificationAt = MEASURED_NOW;
    if (verificationTokens < 1) {
      VERIFICATION_METRICS.throttled++;
      return;
    }
    verificationTokens--;
    VERIFICATION_METRICS.attempted++;
    NOSTR_VERIFYING.add(nostrEvent.id);
    try {
      const NOSTR_HASH_BYTES = await nostrHash(
        NOSTR_ENCODER.encode(
          JSON.stringify([
            0,
            nostrEvent.pubkey,
            nostrEvent.created_at,
            nostrEvent.kind,
            nostrEvent.tags,
            nostrEvent.content
          ])
        ),
        cryptoImpl
      );
      if (nostrToHex(NOSTR_HASH_BYTES) !== nostrEvent.id || !await nostrVerify(
        nostrFromHex(nostrEvent.sig),
        NOSTR_HASH_BYTES,
        nostrFromHex(nostrEvent.pubkey),
        cryptoImpl
      ) || nostrClosed) {
        return;
      }
      if (NOSTR_SEEN.size >= 2048) {
        NOSTR_SEEN.delete(NOSTR_SEEN.keys().next().value);
      }
      NOSTR_SEEN.set(nostrEvent.id, NOSTR_NOW + 3e5);
      VERIFICATION_METRICS.verified++;
      nostrDeliver({
        from: nostrContent.from,
        to: nostrContent.to,
        message: nostrContent.message
      });
    } catch (nostrError) {
      NOSTR_STATUS("error", null, nostrError?.message || "Nostr verification failed");
    } finally {
      NOSTR_VERIFYING.delete(nostrEvent.id);
      const ELAPSED = NOW_MS() - MEASURED_NOW;
      VERIFICATION_METRICS.totalVerificationMs += ELAPSED;
      VERIFICATION_METRICS.maxVerificationMs = Math.max(VERIFICATION_METRICS.maxVerificationMs, ELAPSED);
    }
  }
  function nostrHandleMessage(nostrState, nostrData) {
    if (nostrClosed || nostrState.failed || typeof nostrData !== "string" || nostrData.length > 1024 * 1024) {
      return;
    }
    let nostrFrame;
    try {
      nostrFrame = JSON.parse(nostrData);
    } catch {
      return;
    }
    if (!Array.isArray(nostrFrame)) {
      return;
    }
    if (nostrFrame[0] === "EOSE" && nostrFrame.length === 2 && nostrFrame[1] === NOSTR_SUBSCRIPTION && nostrState.requested) {
      if (nostrState.ready) {
        return;
      }
      nostrState.ready = true;
      clearTimeout(nostrState.timer);
      NOSTR_STATUS("connected", nostrState.url);
      if (!nostrInitializationSettled) {
        nostrInitializationSettled = true;
        nostrReadyResolve();
      }
      for (const NOSTR_PUBLICATION of NOSTR_PENDING.values()) {
        if (!NOSTR_PUBLICATION.attempted.has(nostrState)) {
          NOSTR_PUBLICATION.attempted.add(nostrState);
          NOSTR_PUBLICATION.remaining.add(nostrState);
          try {
            nostrState.socket.send(NOSTR_PUBLICATION.frame);
          } catch (nostrError) {
            nostrFailRelay(nostrState, nostrError?.message || "Fallback publication failed");
          }
        }
      }
    } else if (nostrFrame[0] === "EVENT" && nostrFrame.length === 3 && nostrFrame[1] === NOSTR_SUBSCRIPTION && nostrState.requested) {
      void nostrReceive(nostrFrame[2]);
    } else if (nostrFrame[0] === "OK" && nostrFrame.length === 4 && typeof nostrFrame[1] === "string" && typeof nostrFrame[2] === "boolean" && typeof nostrFrame[3] === "string") {
      const NOSTR_PUBLICATION = NOSTR_PENDING.get(nostrFrame[1]);
      if (!NOSTR_PUBLICATION?.remaining.has(nostrState)) {
        return;
      }
      if (nostrFrame[2]) {
        nostrFinishPublication(nostrFrame[1]);
        NOSTR_STATUS("published", nostrState.url);
      } else {
        nostrFailRelay(nostrState, nostrFrame[3].slice(0, 256) || "Relay rejected the event");
      }
    } else if (nostrFrame[0] === "CLOSED" && nostrFrame.length === 3 && nostrFrame[1] === NOSTR_SUBSCRIPTION && typeof nostrFrame[2] === "string") {
      nostrFailRelay(nostrState, `Relay ended the signaling subscription: ${nostrFrame[2].slice(0, 256)}`);
    } else if (nostrFrame[0] === "NOTICE" && typeof nostrFrame[1] === "string") {
      NOSTR_STATUS("notice", nostrState.url, nostrFrame[1].slice(0, 256));
    }
  }
  function nostrClose() {
    if (nostrClosed) {
      return;
    }
    nostrClosed = true;
    signal?.removeEventListener("abort", nostrClose);
    for (const [NOSTR_TIMER, NOSTR_REJECT] of NOSTR_WAITERS) {
      clearTimeout(NOSTR_TIMER);
      NOSTR_REJECT(new Error("Nostr signaler closed"));
    }
    NOSTR_WAITERS.clear();
    for (const NOSTR_STATE of NOSTR_STATES) {
      clearTimeout(NOSTR_STATE.timer);
      if (NOSTR_STATE.socket?.readyState === 1 && NOSTR_STATE.requested) {
        try {
          NOSTR_STATE.socket.send(JSON.stringify(["CLOSE", NOSTR_SUBSCRIPTION]));
        } catch {
        }
      }
      for (const NOSTR_REMOVE of NOSTR_STATE.remove) {
        NOSTR_REMOVE();
      }
      try {
        NOSTR_STATE.socket?.close();
      } catch {
      }
      NOSTR_STATE.ready = false;
    }
    for (const NOSTR_EVENT_ID of NOSTR_PENDING.keys()) {
      nostrFinishPublication(NOSTR_EVENT_ID, new Error("Nostr signaler closed"));
    }
    if (!nostrInitializationSettled) {
      nostrInitializationSettled = true;
      nostrReadyReject(new Error("Nostr signaler closed"));
    }
    NOSTR_SECRET.fill(0);
    identity?.close();
    NOSTR_LISTENERS.clear();
    NOSTR_BACKLOG.length = 0;
    NOSTR_SEEN.clear();
    NOSTR_VERIFYING.clear();
    NOSTR_STATUS("closed");
  }
  signal?.addEventListener("abort", nostrClose, {
    once: true
  });
  for (const NOSTR_URL of NOSTR_URLS) {
    if (nostrClosed) {
      break;
    }
    const NOSTR_STATE = {
      url: NOSTR_URL,
      socket: null,
      ready: false,
      requested: false,
      failed: false,
      remove: [],
      timer: null
    };
    NOSTR_STATES.push(NOSTR_STATE);
    NOSTR_STATUS("connecting", NOSTR_URL);
    if (nostrClosed) {
      break;
    }
    try {
      const NOSTR_SOCKET = NOSTR_STATE.socket = new webSocketImpl(NOSTR_URL);
      if (nostrClosed) {
        try {
          NOSTR_SOCKET.close();
        } catch {
        }
        break;
      }
      NOSTR_STATE.timer = setTimeout(
        () => nostrFailRelay(NOSTR_STATE, "Nostr connection/subscription timed out"),
        timeoutMs
      );
      const NOSTR_OPEN = () => {
        if (nostrClosed || NOSTR_STATE.failed || NOSTR_STATE.requested) {
          return;
        }
        NOSTR_STATE.requested = true;
        try {
          NOSTR_SOCKET.send(
            JSON.stringify([
              "REQ",
              NOSTR_SUBSCRIPTION,
              {
                kinds: [20078],
                "#d": [NOSTR_ROOM_TAG],
                since: Math.floor(Date.now() / 1e3) - NOSTR_FRESH_SECONDS,
                limit: 0
              }
            ])
          );
        } catch (nostrError) {
          nostrFailRelay(NOSTR_STATE, nostrError?.message || "Nostr subscription failed");
        }
      };
      NOSTR_STATE.remove.push(
        nostrListen(NOSTR_SOCKET, "open", NOSTR_OPEN),
        nostrListen(NOSTR_SOCKET, "message", (nostrEvent) => nostrHandleMessage(NOSTR_STATE, nostrEvent.data)),
        nostrListen(NOSTR_SOCKET, "error", () => nostrFailRelay(NOSTR_STATE, "Nostr WebSocket error")),
        nostrListen(NOSTR_SOCKET, "close", () => nostrFailRelay(NOSTR_STATE, "Nostr relay disconnected"))
      );
      if (NOSTR_SOCKET.readyState === 1) {
        NOSTR_OPEN();
      }
    } catch (nostrError) {
      nostrFailRelay(NOSTR_STATE, nostrError?.message || "Nostr connection failed");
    }
  }
  try {
    await NOSTR_READY;
  } catch (nostrError) {
    nostrClose();
    throw nostrError;
  }
  return {
    id: NOSTR_ID,
    room,
    get metrics() {
      return {
        ...VERIFICATION_METRICS
      };
    },
    async send(nostrTo, nostrMessage) {
      if (nostrClosed) {
        throw new Error("Nostr signaler closed");
      }
      if (nostrTo !== "*" && (typeof nostrTo !== "string" || !NOSTR_HEX32.test(nostrTo))) {
        throw new TypeError("Nostr recipient must be a lowercase public key or *");
      }
      if (!nostrIsSignalMessage(nostrMessage)) {
        throw new TypeError(
          "Nostr carries discovery, presence, offer, answer, ice, bye and group signaling only"
        );
      }
      if (nostrSending >= 64) {
        throw new Error("Too many pending Nostr publications");
      }
      if (!NOSTR_STATES.some(
        (nostrState) => nostrState.ready && !nostrState.failed && nostrState.socket.readyState === 1
      )) {
        throw new Error("No live Nostr relays");
      }
      nostrSending++;
      const NOSTR_PREVIOUS = nostrSendTail;
      let nostrUnlock;
      nostrSendTail = new Promise((nostrResolve) => {
        nostrUnlock = nostrResolve;
      });
      try {
        let nostrContent;
        try {
          nostrContent = JSON.stringify({
            v: 1,
            namespace,
            room,
            from: NOSTR_ID,
            to: nostrTo,
            nonce: nostrToHex(NOSTR_RANDOM(16)),
            message: nostrMessage
          });
        } catch {
          throw new TypeError("Nostr signaling message must be JSON serializable");
        }
        if (NOSTR_ENCODER.encode(nostrContent).length > NOSTR_CONTENT_LIMIT) {
          throw new RangeError("Nostr signaling content exceeds 128 KiB");
        }
        if (!nostrIsSignalMessage(JSON.parse(nostrContent).message)) {
          throw new TypeError("Nostr signaling message serialization changed its type");
        }
        await NOSTR_PREVIOUS;
        if (nostrClosed) {
          throw new Error("Nostr signaler closed");
        }
        const NOSTR_WAIT = publishIntervalMs - (Date.now() - nostrLastPublication);
        if (NOSTR_WAIT > 0) {
          await new Promise((nostrResolve, nostrReject) => {
            const NOSTR_TIMER = setTimeout(() => {
              NOSTR_WAITERS.delete(NOSTR_TIMER);
              nostrResolve();
            }, NOSTR_WAIT);
            NOSTR_WAITERS.set(NOSTR_TIMER, nostrReject);
          });
        }
        if (nostrClosed) {
          throw new Error("Nostr signaler closed");
        }
        const NOSTR_EVENT = {
          pubkey: NOSTR_ID,
          created_at: Math.floor(Date.now() / 1e3),
          kind: 20078,
          tags: [["d", NOSTR_ROOM_TAG], ...nostrTo === "*" ? [] : [["p", nostrTo]]],
          content: nostrContent
        };
        const NOSTR_HASH_BYTES = await nostrHash(
          NOSTR_ENCODER.encode(
            JSON.stringify([
              0,
              NOSTR_ID,
              NOSTR_EVENT.created_at,
              NOSTR_EVENT.kind,
              NOSTR_EVENT.tags,
              nostrContent
            ])
          ),
          cryptoImpl
        );
        if (nostrClosed) {
          throw new Error("Nostr signaler closed");
        }
        const NOSTR_AUXILIARY = NOSTR_RANDOM(32);
        try {
          NOSTR_EVENT.sig = nostrToHex(
            await (identity ? identity.sign(NOSTR_HASH_BYTES, NOSTR_AUXILIARY, cryptoImpl) : nostrSign(NOSTR_HASH_BYTES, NOSTR_SECRET, NOSTR_AUXILIARY, cryptoImpl))
          );
        } finally {
          NOSTR_AUXILIARY.fill(0);
        }
        NOSTR_EVENT.id = nostrToHex(NOSTR_HASH_BYTES);
        if (nostrClosed) {
          throw new Error("Nostr signaler closed");
        }
        const NOSTR_AVAILABLE = NOSTR_STATES.filter(
          (nostrState) => nostrState.ready && !nostrState.failed && nostrState.socket.readyState === 1
        );
        if (NOSTR_AVAILABLE.length === 0) {
          throw new Error("No live Nostr relays");
        }
        const NOSTR_FRAME = JSON.stringify(["EVENT", NOSTR_EVENT]);
        nostrLastPublication = Date.now();
        await new Promise((nostrResolve, nostrReject) => {
          const NOSTR_PUBLICATION = {
            resolve: nostrResolve,
            reject: nostrReject,
            remaining: new Set(NOSTR_AVAILABLE),
            attempted: new Set(NOSTR_AVAILABLE),
            frame: NOSTR_FRAME,
            failures: [],
            timer: null
          };
          NOSTR_PENDING.set(NOSTR_EVENT.id, NOSTR_PUBLICATION);
          NOSTR_PUBLICATION.timer = setTimeout(
            () => nostrFinishPublication(
              NOSTR_EVENT.id,
              new Error("Nostr publication timed out without a positive relay OK")
            ),
            timeoutMs
          );
          for (const NOSTR_STATE of NOSTR_AVAILABLE) {
            if (nostrClosed) {
              break;
            }
            try {
              NOSTR_STATE.socket.send(NOSTR_FRAME);
            } catch (nostrError) {
              nostrFailRelay(NOSTR_STATE, nostrError?.message || "Nostr publication failed");
            }
          }
        });
      } finally {
        await NOSTR_PREVIOUS;
        nostrSending--;
        nostrUnlock();
      }
    },
    subscribe(nostrHandler) {
      if (nostrClosed) {
        throw new Error("Nostr signaler closed");
      }
      if (typeof nostrHandler !== "function") {
        throw new TypeError("Signaling subscriber must be a function");
      }
      NOSTR_LISTENERS.add(nostrHandler);
      if (!nostrHasSubscriber) {
        nostrHasSubscriber = true;
        const NOSTR_QUEUED = NOSTR_BACKLOG.splice(0);
        for (const NOSTR_ENVELOPE of NOSTR_QUEUED) {
          nostrDeliver(NOSTR_ENVELOPE);
        }
      }
      return () => NOSTR_LISTENERS.delete(nostrHandler);
    },
    close: nostrClose
  };
}

// modules/transport/room.js
async function createNostrRoom({
  role,
  room,
  namespace = "rollback-netcode",
  relays,
  rtcConfig,
  timeoutMs = 3e4,
  onStatus = () => {
  },
  signal,
  signalerFactory = createNostrSignaler,
  peerFactory = createWebRTCPeer
} = {}) {
  if (!["host", "join"].includes(role)) {
    throw new TypeError("room role");
  }
  integer(timeoutMs, "timeoutMs", 1, 12e4);
  if (typeof signalerFactory !== "function" || typeof peerFactory !== "function") {
    throw new TypeError("room adapter factories");
  }
  if (signal?.aborted) {
    throw new Error("room aborted");
  }
  if (!room && role === "host") {
    const VALUE = new Uint32Array(1);
    globalThis.crypto.getRandomValues(VALUE);
    room = String(VALUE[0] % 1e4).padStart(4, "0");
  }
  if (!/^\d{4}$/.test(room ?? "")) {
    throw new TypeError("four-digit room");
  }
  const CONTROLLER = new AbortController();
  const EXTERNAL_ABORT = () => CONTROLLER.abort(signal?.reason);
  signal?.addEventListener("abort", EXTERNAL_ABORT, {
    once: true
  });
  const ROOM_SIGNAL = CONTROLLER.signal;
  let signaler;
  try {
    signaler = await signalerFactory({
      room,
      namespace,
      relays,
      timeoutMs: Math.min(timeoutMs, 1e4),
      onStatus,
      signal: ROOM_SIGNAL
    });
  } catch (error) {
    signal?.removeEventListener("abort", EXTERNAL_ABORT);
    throw error;
  }
  if (ROOM_SIGNAL.aborted) {
    signaler.close();
    signal?.removeEventListener("abort", EXTERNAL_ABORT);
    throw new Error("room aborted");
  }
  return new Promise((resolve, reject) => {
    let connection;
    let unsubscribe;
    let pulse;
    let deadline;
    let collisionTimer;
    let disposed = false;
    let connecting = false;
    let completed = false;
    let selectedPeer;
    let checking = role === "host";
    const NONCE = new Uint8Array(16);
    globalThis.crypto.getRandomValues(NONCE);
    let sessionId = [...NONCE].map((n) => n.toString(16).padStart(2, "0")).join("");
    const STATUS = (value) => {
      try {
        onStatus(value);
      } catch {
      }
    };
    const CLOSE = () => {
      if (disposed) {
        return;
      }
      disposed = true;
      clearInterval(pulse);
      clearTimeout(deadline);
      clearTimeout(collisionTimer);
      unsubscribe?.();
      ROOM_SIGNAL.removeEventListener("abort", ABORT);
      signal?.removeEventListener("abort", EXTERNAL_ABORT);
      CONTROLLER.abort();
      connection?.close();
      signaler.close();
    };
    const FAIL = (error) => {
      if (!completed) {
        completed = true;
        reject(error);
      }
      CLOSE();
    };
    const ABORT = () => FAIL(new Error("room aborted"));
    ROOM_SIGNAL.addEventListener("abort", ABORT, {
      once: true
    });
    const SEND = (to, message) => signaler.send(to, message).catch(FAIL);
    const PRESENCE = (to) => SEND(to, {
      type: "presence",
      room,
      namespace,
      host: signaler.id,
      sessionId,
      protocol: PROTOCOL_VERSION
    });
    const CONNECT = (remoteId) => {
      if (connecting || disposed) {
        return;
      }
      connecting = true;
      selectedPeer = remoteId;
      Promise.resolve().then(
        () => peerFactory({
          initiator: role === "join",
          signaler,
          remoteId,
          rtcConfig,
          timeoutMs: Math.min(timeoutMs, 2e4),
          onStatus,
          signal: ROOM_SIGNAL
        })
      ).then((value) => {
        if (disposed) {
          value.close();
          return;
        }
        connection = value;
        completed = true;
        clearInterval(pulse);
        clearTimeout(deadline);
        clearTimeout(collisionTimer);
        unsubscribe?.();
        resolve({
          room,
          sessionId,
          localPlayerId: role === "host" ? "a" : "b",
          remotePlayerId: role === "host" ? "b" : "a",
          transport: value.transport,
          peerConnection: value.peerConnection,
          close: CLOSE
        });
      }).catch(FAIL);
    };
    unsubscribe = signaler.subscribe(({ from, to, message }) => {
      if (disposed || from === signaler.id) {
        return;
      }
      if (role === "host") {
        if (message.type === "presence" && message.host === from && message.protocol === PROTOCOL_VERSION) {
          FAIL(new Error("room code is already in use; choose another four-digit code"));
          return;
        }
        if (message.type === "discover" && !checking && (!selectedPeer || selectedPeer === from)) {
          CONNECT(from);
          PRESENCE(from);
        }
      } else if (message.type === "presence" && message.host === from && message.protocol === PROTOCOL_VERSION && typeof message.sessionId === "string") {
        if (selectedPeer && selectedPeer !== from) {
          return;
        }
        selectedPeer = from;
        if (to === signaler.id) {
          sessionId = message.sessionId;
          CONNECT(from);
        } else {
          SEND(from, {
            type: "discover"
          });
        }
      }
    });
    if (disposed) {
      unsubscribe?.();
      return;
    }
    deadline = setTimeout(() => FAIL(new Error("room discovery timeout")), timeoutMs);
    const ADVERTISE = () => {
      if (disposed || connecting || checking) {
        return;
      }
      if (role === "host") {
        PRESENCE("*");
      } else {
        SEND(selectedPeer ?? "*", {
          type: "discover"
        });
      }
    };
    pulse = setInterval(ADVERTISE, 1e3);
    STATUS({
      type: "room",
      room,
      role
    });
    if (disposed) {
      return;
    }
    if (checking) {
      collisionTimer = setTimeout(() => {
        checking = false;
        ADVERTISE();
      }, 1200);
    } else {
      ADVERTISE();
    }
  });
}

// modules/transport/star-transport.js
var STAR_HEADER = 24;
var STAR_PAYLOAD = CHUNK_SIZE - STAR_HEADER;
var STAR_MAGIC = 827544658;
function createStarTransports({
  players,
  localPlayerId,
  hostPlayerId,
  sessionId,
  physicalTransports,
  onError = () => {
  },
  maxQueuedBytes = 5 * 1024 * 1024
} = {}) {
  if (!Array.isArray(players) || players.length < 2 || players.length > 8 || new Set(players).size !== players.length || !players.includes(localPlayerId) || !players.includes(hostPlayerId) || typeof sessionId !== "string" || !(physicalTransports instanceof Map) || typeof onError !== "function") {
    throw new TypeError("star transport configuration");
  }
  integer(maxQueuedBytes, "star queue budget", CHUNK_SIZE * 2, 64 * 1024 * 1024);
  const LOCAL = players.indexOf(localPlayerId), HOST = players.indexOf(hostPlayerId), IS_HOST = LOCAL === HOST;
  const REQUIRED = IS_HOST ? players.filter((id) => id !== localPlayerId) : [hostPlayerId];
  if (REQUIRED.some((id) => !physicalTransports.get(id)?.subscribe || !physicalTransports.get(id)?.send)) {
    throw new TypeError("missing star physical transport");
  }
  const TAG = hashBytes(new TextEncoder().encode(sessionId)), LISTENERS = /* @__PURE__ */ new Map(), STATUS_LISTENERS = /* @__PURE__ */ new Map();
  const QUEUES = new Map(REQUIRED.map((id) => [id, []])), ASSEMBLIES = /* @__PURE__ */ new Map(), COMPLETED = /* @__PURE__ */ new Map();
  const UNSUBS = [], STATS = {
    sentFrames: 0,
    forwardedFrames: 0,
    rejectedFrames: 0,
    queuedBytes: 0,
    queuedFrames: 0,
    assemblyBytes: 0
  };
  let closed = false;
  let sequence = 0;
  let pumping = false;
  function reject() {
    STATS.rejectedFrames++;
  }
  function close() {
    if (closed) {
      return;
    }
    closed = true;
    clearInterval(TIMER);
    for (const REMOVE of UNSUBS.splice(0)) {
      REMOVE();
    }
    QUEUES.forEach((q) => q.length = 0);
    ASSEMBLIES.clear();
    COMPLETED.clear();
    STATS.queuedBytes = 0;
    STATS.queuedFrames = 0;
    STATS.assemblyBytes = 0;
    for (const SET of STATUS_LISTENERS.values()) {
      for (const FN of SET) {
        try {
          FN("closed");
        } catch {
        }
      }
    }
    LISTENERS.clear();
    STATUS_LISTENERS.clear();
  }
  function fail(message) {
    if (closed) {
      return;
    }
    close();
    try {
      onError(new Error(message));
    } catch {
    }
  }
  function pump() {
    if (closed || pumping) {
      return;
    }
    pumping = true;
    try {
      const NOW = NOW_MS();
      for (const [ID, Q] of QUEUES) {
        let work = 0;
        while (Q.length && work++ < 128 && !closed) {
          if (NOW - Q[0].at > 1e4) {
            fail("star forwarding backpressure timeout");
            break;
          }
          if (physicalTransports.get(ID).send(Q[0].bytes) === false) {
            break;
          }
          STATS.queuedBytes -= Q.shift().bytes.length;
          STATS.queuedFrames--;
          STATS.sentFrames++;
        }
      }
      for (const [KEY, A] of ASSEMBLIES) {
        if (NOW - A.at > 2e3) {
          ASSEMBLIES.delete(KEY);
          STATS.assemblyBytes -= A.total;
        }
      }
    } catch (error) {
      fail("star forwarding failed: " + error.message);
    } finally {
      pumping = false;
    }
  }
  function enqueue(id, frames, forwarded) {
    const SIZE = frames.reduce((n, b) => n + b.length, 0), Q = QUEUES.get(id);
    if (closed || !Q || physicalTransports.get(id).state && physicalTransports.get(id).state !== "open") {
      return false;
    }
    if (STATS.queuedBytes + SIZE > maxQueuedBytes || STATS.queuedFrames + frames.length > 4096) {
      if (forwarded) {
        fail("star forwarding queue capacity");
      }
      return false;
    }
    const AT = NOW_MS();
    for (const B of frames) {
      Q.push({
        bytes: B.slice(),
        at: AT
      });
    }
    STATS.queuedBytes += SIZE;
    STATS.queuedFrames += frames.length;
    if (forwarded) {
      STATS.forwardedFrames += frames.length;
    }
    pump();
    return !closed;
  }
  function deliver(from, id, payload, lane) {
    const ACTUAL_LANE = payload.length > 5 && [TYPE.INPUT, TYPE.CLOCK].includes(payload[5]) ? payload[5] : 1;
    if (ACTUAL_LANE !== lane) {
      reject();
      return;
    }
    let seen = COMPLETED.get(from);
    if (!seen) {
      COMPLETED.set(from, seen = /* @__PURE__ */ new Set());
    }
    if (seen.has(id)) {
      return;
    }
    seen.add(id);
    if (seen.size > 256) {
      seen.delete(seen.values().next().value);
    }
    const TARGET = LISTENERS.get(players[from]);
    if (TARGET?.size) {
      for (const FN of TARGET) {
        FN(payload.slice());
      }
    }
  }
  function receive(physicalId, data) {
    if (closed) {
      return;
    }
    let b;
    try {
      b = bytes(data);
    } catch {
      reject();
      return;
    }
    if (b.length < STAR_HEADER || b.length > CHUNK_SIZE) {
      reject();
      return;
    }
    const V = new DataView(b.buffer, b.byteOffset, b.byteLength), FROM = b[6], TO = b[7], LANE = b[5];
    const ID = V.getUint32(12, true), TOTAL = V.getUint16(16, true), OFFSET = V.getUint16(18, true), LENGTH = V.getUint16(20, true);
    if (V.getUint32(0, true) !== STAR_MAGIC || b[4] !== 1 || V.getUint32(8, true) !== TAG || V.getUint16(22, true) !== 0 || ![1, TYPE.INPUT, TYPE.CLOCK].includes(LANE) || FROM >= players.length || TO >= players.length || FROM === TO || FROM === LOCAL || !ID || !TOTAL || TOTAL > CHUNK_SIZE || ![0, STAR_PAYLOAD].includes(OFFSET) || OFFSET >= TOTAL || LENGTH !== Math.min(STAR_PAYLOAD, TOTAL - OFFSET) || b.length !== STAR_HEADER + LENGTH || (IS_HOST ? players[FROM] !== physicalId : physicalId !== hostPlayerId || TO !== LOCAL)) {
      reject();
      return;
    }
    if (TO !== LOCAL) {
      if (!IS_HOST || !enqueue(players[TO], [b], true)) {
        if (!closed) {
          fail("star destination is not available");
        }
      }
      return;
    }
    if (COMPLETED.get(FROM)?.has(ID)) {
      return;
    }
    if (TOTAL <= STAR_PAYLOAD) {
      deliver(FROM, ID, b.slice(STAR_HEADER), LANE);
      return;
    }
    const KEY = FROM + ":" + ID;
    let a = ASSEMBLIES.get(KEY);
    if (!a) {
      if (ASSEMBLIES.size >= 32 || STATS.assemblyBytes + TOTAL > 512 * 1024) {
        reject();
        return;
      }
      a = {
        total: TOTAL,
        lane: LANE,
        bytes: new Uint8Array(TOTAL),
        seen: /* @__PURE__ */ new Set(),
        at: NOW_MS()
      };
      ASSEMBLIES.set(KEY, a);
      STATS.assemblyBytes += TOTAL;
    }
    if (a.total !== TOTAL || a.lane !== LANE) {
      reject();
      return;
    }
    if (a.seen.has(OFFSET)) {
      for (let i = 0; i < LENGTH; i++) {
        if (a.bytes[OFFSET + i] !== b[STAR_HEADER + i]) {
          reject();
          return;
        }
      }
      return;
    }
    a.bytes.set(b.subarray(STAR_HEADER), OFFSET);
    a.seen.add(OFFSET);
    if (a.seen.size === 2) {
      ASSEMBLIES.delete(KEY);
      STATS.assemblyBytes -= TOTAL;
      deliver(FROM, ID, a.bytes, LANE);
    }
  }
  const TIMER = setInterval(pump, 16);
  TIMER.unref?.();
  const TRANSPORTS = /* @__PURE__ */ new Map();
  for (const REMOTE of players.filter((id) => id !== localPlayerId)) {
    LISTENERS.set(REMOTE, /* @__PURE__ */ new Set());
    STATUS_LISTENERS.set(REMOTE, /* @__PURE__ */ new Set());
    const PHYSICAL = IS_HOST ? REMOTE : hostPlayerId;
    TRANSPORTS.set(REMOTE, {
      get state() {
        return closed ? "closed" : physicalTransports.get(PHYSICAL).state ?? "open";
      },
      send(data) {
        if (closed) {
          return false;
        }
        const PAYLOAD = bytes(data);
        if (!PAYLOAD.length || PAYLOAD.length > CHUNK_SIZE) {
          throw new RangeError("star packet size");
        }
        sequence = sequence + 1 >>> 0 || 1;
        const ID = sequence, FRAMES = [];
        const LANE = PAYLOAD.length > 5 && [TYPE.INPUT, TYPE.CLOCK].includes(PAYLOAD[5]) ? PAYLOAD[5] : 1;
        for (let offset = 0; offset < PAYLOAD.length; offset += STAR_PAYLOAD) {
          const LENGTH = Math.min(STAR_PAYLOAD, PAYLOAD.length - offset), B = new Uint8Array(STAR_HEADER + LENGTH), V = new DataView(B.buffer);
          V.setUint32(0, STAR_MAGIC, true);
          B[4] = 1;
          B[5] = LANE;
          B[6] = LOCAL;
          B[7] = players.indexOf(REMOTE);
          V.setUint32(8, TAG, true);
          V.setUint32(12, ID, true);
          V.setUint16(16, PAYLOAD.length, true);
          V.setUint16(18, offset, true);
          V.setUint16(20, LENGTH, true);
          B.set(PAYLOAD.subarray(offset, offset + LENGTH), STAR_HEADER);
          FRAMES.push(B);
        }
        return enqueue(PHYSICAL, FRAMES, false);
      },
      subscribe(fn) {
        if (closed || typeof fn !== "function") {
          throw new TypeError("star subscriber");
        }
        const SET = LISTENERS.get(REMOTE);
        SET.add(fn);
        return () => SET.delete(fn);
      },
      subscribeStatus(fn) {
        if (closed || typeof fn !== "function") {
          throw new TypeError("star status subscriber");
        }
        const SET = STATUS_LISTENERS.get(REMOTE);
        SET.add(fn);
        return () => SET.delete(fn);
      },
      close() {
        LISTENERS.get(REMOTE)?.clear();
        STATUS_LISTENERS.get(REMOTE)?.clear();
      }
    });
  }
  try {
    for (const ID of REQUIRED) {
      const RAW = physicalTransports.get(ID);
      UNSUBS.push(RAW.subscribe((data) => receive(ID, data)));
      if (RAW.subscribeStatus) {
        UNSUBS.push(
          RAW.subscribeStatus((state) => {
            for (const [REMOTE, SET] of STATUS_LISTENERS) {
              if (!IS_HOST || REMOTE === ID) {
                for (const FN of SET) {
                  try {
                    FN(state);
                  } catch {
                  }
                }
              }
            }
          })
        );
      }
    }
  } catch (error) {
    close();
    throw error;
  }
  return {
    transports: TRANSPORTS,
    close,
    get metrics() {
      return {
        ...STATS
      };
    }
  };
}

// modules/transport/group-room.js
function groupRoomId(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}
async function createNostrGroupRoom({
  role,
  room,
  playerCount = 2,
  topology = "mesh",
  namespace = "rollback-netcode",
  relays,
  rtcConfig,
  timeoutMs = 6e4,
  onStatus = () => {
  },
  signal,
  signalerFactory = createNostrSignaler,
  peerFactory = createWebRTCPeer
} = {}) {
  if (!["host", "join"].includes(role) || !["mesh", "star"].includes(topology)) {
    throw new TypeError("group room role/topology");
  }
  integer(playerCount, "playerCount", 2, 8);
  integer(timeoutMs, "timeoutMs", 1, 12e4);
  if (typeof namespace !== "string" || !namespace.trim() || new TextEncoder().encode(namespace + ":group-v1").length > 128) {
    throw new TypeError("group namespace");
  }
  if ([onStatus, signalerFactory, peerFactory].some((fn) => typeof fn !== "function")) {
    throw new TypeError("group room capability");
  }
  if (signal?.aborted) {
    throw new Error("group room aborted");
  }
  const RANDOM = () => [...globalThis.crypto.getRandomValues(new Uint8Array(16))].map((v) => v.toString(16).padStart(2, "0")).join("");
  if (!room && role === "host") {
    room = String(globalThis.crypto.getRandomValues(new Uint32Array(1))[0] % 1e4).padStart(4, "0");
  }
  if (!/^\d{4}$/.test(room ?? "")) {
    throw new TypeError("four-digit room");
  }
  const PEER_CONTROLLER = new AbortController(), SIGNAL_CONTROLLER = new AbortController(), STARTED_AT = NOW_MS();
  const EARLY_ABORT = () => {
    PEER_CONTROLLER.abort();
    SIGNAL_CONTROLLER.abort();
  };
  signal?.addEventListener("abort", EARLY_ABORT, {
    once: true
  });
  let signaler;
  try {
    signaler = await signalerFactory({
      room,
      namespace: namespace + ":group-v1",
      relays,
      signal: SIGNAL_CONTROLLER.signal,
      timeoutMs: Math.min(timeoutMs, 1e4),
      onStatus,
      maxVerificationsPerSecond: Math.max(16, playerCount * 4),
      verificationBurst: playerCount * 4
    });
    if (!groupRoomId(signaler?.id) || typeof signaler.send !== "function" || typeof signaler.subscribe !== "function" || typeof signaler.close !== "function") {
      throw new TypeError("group signaler capability");
    }
    if (signal?.aborted || SIGNAL_CONTROLLER.signal.aborted) {
      throw new Error("group room aborted");
    }
  } catch (error) {
    EARLY_ABORT();
    signaler?.close?.();
    signal?.removeEventListener("abort", EARLY_ABORT);
    throw error;
  }
  signal?.removeEventListener("abort", EARLY_ABORT);
  return new Promise((resolve, reject) => {
    const SELF = signaler.id, MEMBERS = /* @__PURE__ */ new Set([SELF]), DEPARTED = /* @__PURE__ */ new Set(), ACKS = /* @__PURE__ */ new Set([SELF]), READY = /* @__PURE__ */ new Set(), STARTS = /* @__PURE__ */ new Set([SELF]);
    const PEERS = /* @__PURE__ */ new Map(), SUBSCRIBERS = /* @__PURE__ */ new Map(), BACKLOG = /* @__PURE__ */ new Map(), CONTROL_PENDING = /* @__PURE__ */ new Map(), REMOVERS = [];
    let host = role === "host" ? SELF : null;
    let sessionId = role === "host" ? RANDOM() : null;
    let roster2 = null;
    let rosterKey = "";
    let phase = role === "host" ? "checking" : "discovering";
    let disposed = false;
    let settled = false;
    let connecting = false;
    let localReady = false;
    let unsubscribe;
    let interval;
    let collisionTimer;
    let deadline;
    let router;
    let backlogBytes = 0;
    let startPublished = false;
    const STATUS = (type, detail = {}) => {
      try {
        onStatus({
          type,
          room,
          role,
          playerCount,
          topology,
          phase,
          ...detail
        });
      } catch {
      }
    };
    function message(op, extra = {}) {
      return {
        type: "group",
        version: 1,
        protocol: PROTOCOL_VERSION,
        op,
        host,
        sessionId,
        playerCount,
        topology,
        ...extra
      };
    }
    function dispose(reason, notify = true) {
      if (disposed) {
        return;
      }
      disposed = true;
      clearInterval(interval);
      clearTimeout(collisionTimer);
      clearTimeout(deadline);
      unsubscribe?.();
      signal?.removeEventListener("abort", abort);
      PEER_CONTROLLER.abort();
      REMOVERS.splice(0).forEach((fn) => fn());
      router?.close();
      PEERS.forEach((p) => p.close());
      PEERS.clear();
      SUBSCRIBERS.clear();
      BACKLOG.clear();
      backlogBytes = 0;
      const FINISH = () => {
        SIGNAL_CONTROLLER.abort();
        signaler.close();
      };
      if (notify && host && sessionId) {
        const GRACE = setTimeout(FINISH, 1500);
        GRACE.unref?.();
        Promise.resolve().then(
          () => signaler.send(
            role === "host" ? "*" : host,
            message("leave", {
              reason
            })
          )
        ).catch(() => {
        }).finally(() => {
          clearTimeout(GRACE);
          FINISH();
        });
      } else {
        FINISH();
      }
    }
    function fail(error, notify = true) {
      if (disposed) {
        return;
      }
      const VALUE = error instanceof Error ? error : new Error(String(error));
      const FORMER = phase;
      phase = "failed";
      dispose(VALUE.message, notify);
      STATUS("group-failed", {
        reason: VALUE.message,
        previousPhase: FORMER
      });
      if (!settled) {
        settled = true;
        reject(VALUE);
      }
    }
    function abort() {
      fail(new Error("group room aborted"));
    }
    function send(to, op, extra = {}) {
      if (disposed) {
        return Promise.resolve();
      }
      const KEY = to + ":" + op;
      if (CONTROL_PENDING.has(KEY)) {
        return CONTROL_PENDING.get(KEY);
      }
      if (CONTROL_PENDING.size >= 32) {
        return Promise.resolve();
      }
      const PENDING = Promise.resolve().then(() => {
        if (!disposed) {
          return signaler.send(to, message(op, extra));
        }
      }).catch((error) => {
        fail(error);
      }).finally(() => CONTROL_PENDING.delete(KEY));
      CONTROL_PENDING.set(KEY, PENDING);
      return PENDING;
    }
    function close() {
      if (disposed) {
        return;
      }
      const PENDING = !settled;
      phase = "closed";
      dispose("room closed");
      STATUS("group-closed");
      if (PENDING) {
        settled = true;
        reject(new Error("group room closed"));
      }
    }
    function finish() {
      if (disposed || settled || !localReady) {
        return;
      }
      settled = true;
      phase = "running";
      clearTimeout(deadline);
      clearInterval(interval);
      const PHYSICAL = new Map([...PEERS].map(([id, peer]) => [id, peer.transport]));
      STATUS("group-started", {
        players: [...roster2],
        localPlayerId: SELF
      });
      if (disposed) {
        reject(new Error("group room closed by observer"));
        return;
      }
      resolve({
        room,
        sessionId,
        playerCount,
        topology,
        players: Object.freeze([...roster2]),
        localPlayerId: SELF,
        authorityPlayerId: host,
        hostPlayerId: host,
        transports: new Map(router?.transports ?? PHYSICAL),
        peerConnections: new Map([...PEERS].map(([id, peer]) => [id, peer.peerConnection])),
        get closed() {
          return disposed;
        },
        get metrics() {
          return router?.metrics ?? null;
        },
        close
      });
    }
    function hostProgress() {
      if (disposed || role !== "host" || !roster2) {
        return;
      }
      if (phase === "roster" && ACKS.size === playerCount) {
        phase = "connecting";
        connect();
        send("*", "connect", {
          rosterKey
        });
      }
      if (phase === "connecting" && READY.size === playerCount) {
        phase = "starting";
        send("*", "start", {
          rosterKey
        }).then(() => {
          startPublished = true;
          hostProgress();
        });
      }
      if (phase === "starting" && startPublished && STARTS.size === playerCount) {
        finish();
      }
    }
    function wantedPeers() {
      return roster2.filter((id) => id !== SELF && (topology === "mesh" || SELF === host || id === host));
    }
    function scopedSignaler(remote) {
      return {
        id: SELF,
        send(to, payload) {
          if (disposed || to !== remote) {
            return Promise.reject(new Error("group peer scope"));
          }
          return signaler.send(to, {
            ...payload,
            groupSession: sessionId
          });
        },
        subscribe(fn) {
          const SET = SUBSCRIBERS.get(remote) ?? /* @__PURE__ */ new Set();
          SUBSCRIBERS.set(remote, SET);
          SET.add(fn);
          const QUEUED = BACKLOG.get(remote) ?? [];
          BACKLOG.delete(remote);
          for (const ITEM of QUEUED) {
            backlogBytes -= ITEM.size;
            if (!disposed) {
              fn(ITEM.envelope);
            }
          }
          return () => SET.delete(fn);
        },
        close() {
        }
      };
    }
    function connect() {
      if (disposed || connecting || !roster2) {
        return;
      }
      connecting = true;
      phase = "connecting";
      STATUS("group-connecting", {
        players: [...roster2]
      });
      if (disposed) {
        return;
      }
      Promise.all(
        wantedPeers().map(
          (remote) => Promise.resolve().then(() => {
            if (disposed) {
              throw new Error("group room closed");
            }
            return peerFactory({
              initiator: COMPARE_IDS(SELF, remote) > 0,
              signaler: scopedSignaler(remote),
              remoteId: remote,
              rtcConfig,
              timeoutMs: Math.min(timeoutMs, 3e4),
              onStatus: (event) => STATUS("group-peer", {
                peerId: remote,
                event
              }),
              signal: PEER_CONTROLLER.signal
            });
          }).then((peer) => {
            if (disposed) {
              peer.close();
              return;
            }
            if (!peer?.transport?.send || !peer.transport.subscribe || typeof peer.close !== "function") {
              throw new TypeError("group peer capability");
            }
            PEERS.set(remote, peer);
            if (peer.transport.subscribeStatus) {
              REMOVERS.push(
                peer.transport.subscribeStatus((state) => {
                  if (!disposed && (state === "closed" || state === "failed" || !settled && state === "interrupted")) {
                    fail(new Error("group peer unavailable: " + remote));
                  }
                })
              );
            }
          })
        )
      ).then(() => {
        if (disposed) {
          return;
        }
        if ([...PEERS.values()].some((p) => p.transport.state && p.transport.state !== "open")) {
          throw new Error("group transport not open");
        }
        if (topology === "star") {
          router = createStarTransports({
            players: roster2,
            localPlayerId: SELF,
            hostPlayerId: host,
            sessionId,
            physicalTransports: new Map([...PEERS].map(([id, p]) => [id, p.transport])),
            onError: fail
          });
        }
        localReady = true;
        STATUS("group-ready", {
          players: [...roster2]
        });
        if (disposed) {
          return;
        }
        if (role === "host") {
          READY.add(SELF);
          hostProgress();
        } else {
          send(host, "ready", {
            rosterKey
          });
        }
      }).catch(fail);
    }
    function publishRoster() {
      send("*", "roster", {
        players: roster2,
        rosterKey
      });
    }
    function advertise(to = "*") {
      send(to, "hello", {
        accepting: phase === "collecting",
        memberCount: MEMBERS.size
      });
    }
    function acceptRoster(from, m) {
      if (from !== host || !Array.isArray(m.players) || m.players.length !== playerCount || m.players.some((id) => !groupRoomId(id)) || new Set(m.players).size !== playerCount || !m.players.includes(SELF) || !m.players.includes(host) || m.players.join("\n") !== [...m.players].sort(COMPARE_IDS).join("\n") || m.rosterKey !== m.players.join("\n")) {
        fail(new Error("invalid group roster"));
        return;
      }
      if (roster2 && rosterKey !== m.rosterKey) {
        fail(new Error("group roster changed"));
        return;
      }
      if (!roster2) {
        roster2 = Object.freeze([...m.players]);
        rosterKey = m.rosterKey;
        phase = "roster";
        STATUS("group-roster", {
          players: [...roster2]
        });
      }
      send(host, "ack", {
        rosterKey
      });
    }
    function receive(envelope) {
      if (disposed || !envelope || envelope.from === SELF || !groupRoomId(envelope.from) || !["*", SELF].includes(envelope.to) || !envelope.message || typeof envelope.message !== "object") {
        return;
      }
      const { from: FROM, to: TO, message: M } = envelope;
      if (["offer", "answer", "ice", "bye"].includes(M.type)) {
        if (!roster2 || TO !== SELF || M.groupSession !== sessionId || !wantedPeers().includes(FROM)) {
          return;
        }
        const SET = SUBSCRIBERS.get(FROM);
        if (SET?.size) {
          for (const FN of SET) {
            FN(envelope);
          }
          return;
        }
        const SIZE = ENCODER.encode(JSON.stringify(M)).length, QUEUED = BACKLOG.get(FROM) ?? [];
        if (QUEUED.length >= 32 || backlogBytes + SIZE > 2 * 1024 * 1024) {
          fail(new Error("group signaling backlog capacity"));
          return;
        }
        QUEUED.push({
          envelope,
          size: SIZE
        });
        BACKLOG.set(FROM, QUEUED);
        backlogBytes += SIZE;
        return;
      }
      if (M.type !== "group" || M.version !== 1 || M.protocol !== PROTOCOL_VERSION) {
        return;
      }
      if (role === "host" && M.op === "hello" && M.host === FROM) {
        if (["checking", "collecting"].includes(phase)) {
          fail(new Error("room code is already in use"));
        } else if (M.accepting !== false) {
          advertise(FROM);
        }
        return;
      }
      if (role === "join" && M.op === "hello" && M.host === FROM && groupRoomId(M.sessionId)) {
        if (host && (host !== FROM || sessionId !== M.sessionId)) {
          return;
        }
        if (M.playerCount !== playerCount || M.topology !== topology) {
          fail(new Error("group playerCount/topology mismatch"), false);
          return;
        }
        const SELECTED = !!host;
        if (!host) {
          host = FROM;
          sessionId = M.sessionId;
        }
        if (!roster2) {
          if (M.accepting === false && !SELECTED) {
            fail(new Error("group room is full or already started"), false);
            return;
          }
          send(host, "join");
        }
        return;
      }
      if (role === "host" && M.op === "discover") {
        if (phase !== "checking") {
          advertise(FROM);
        }
        return;
      }
      if (M.host !== host || M.sessionId !== sessionId || M.playerCount !== playerCount || M.topology !== topology) {
        return;
      }
      if (role === "host") {
        if (M.op === "join") {
          if (MEMBERS.has(FROM)) {
            if (roster2) {
              publishRoster();
            }
            return;
          }
          if (phase !== "collecting" || DEPARTED.has(FROM)) {
            send(FROM, "reject", {
              reason: "group room is full or already started"
            });
            return;
          }
          MEMBERS.add(FROM);
          STATUS("group-members", {
            players: [...MEMBERS].sort(COMPARE_IDS)
          });
          if (disposed) {
            return;
          }
          if (MEMBERS.size === playerCount) {
            roster2 = Object.freeze([...MEMBERS].sort(COMPARE_IDS));
            rosterKey = roster2.join("\n");
            phase = "roster";
            STATUS("group-roster", {
              players: [...roster2]
            });
            publishRoster();
          }
        } else if (M.op === "leave" && MEMBERS.has(FROM)) {
          if (phase === "collecting") {
            MEMBERS.delete(FROM);
            DEPARTED.add(FROM);
            if (DEPARTED.size > 64) {
              fail(new Error("group membership churn limit"));
            } else {
              STATUS("group-members", {
                players: [...MEMBERS].sort(COMPARE_IDS)
              });
            }
          } else {
            fail(new Error("group participant left"));
          }
        } else if (roster2?.includes(FROM) && M.rosterKey === rosterKey) {
          if (M.op === "ack") {
            ACKS.add(FROM);
          }
          if (M.op === "ready" && ["connecting", "starting"].includes(phase)) {
            READY.add(FROM);
          }
          if (M.op === "start-ack" && phase === "starting") {
            STARTS.add(FROM);
          }
          hostProgress();
        }
      } else if (FROM === host) {
        if (M.op === "reject") {
          fail(new Error(String(M.reason || "group rejected")), false);
        } else if (M.op === "leave") {
          fail(new Error("group host left"), false);
        } else if (M.op === "roster") {
          acceptRoster(FROM, M);
        } else if (roster2 && M.rosterKey === rosterKey) {
          if (M.op === "connect") {
            connect();
            if (localReady) {
              send(host, "ready", {
                rosterKey
              });
            }
          }
          if (M.op === "start" && localReady) {
            send(host, "start-ack", {
              rosterKey
            }).then(finish);
          }
        }
      }
    }
    signal?.addEventListener("abort", abort, {
      once: true
    });
    if (signal?.aborted) {
      abort();
      return;
    }
    unsubscribe = signaler.subscribe(receive);
    if (disposed) {
      unsubscribe?.();
      return;
    }
    const REMAINING = timeoutMs - (NOW_MS() - STARTED_AT);
    if (REMAINING <= 0) {
      fail(new Error("group room timeout"));
      return;
    }
    deadline = setTimeout(() => fail(new Error("group room timeout: " + phase)), REMAINING);
    interval = setInterval(() => {
      if (disposed) {
        return;
      }
      if (role === "host") {
        if (phase === "collecting") {
          advertise();
        } else if (phase === "roster") {
          publishRoster();
        } else if (phase === "connecting") {
          send("*", "connect", {
            rosterKey
          });
        } else if (phase === "starting") {
          send("*", "start", {
            rosterKey
          }).then(() => {
            startPublished = true;
            hostProgress();
          });
        }
      } else if (!host) {
        send("*", "discover");
      } else if (!roster2) {
        send(host, "join");
      } else if (!connecting) {
        send(host, "ack", {
          rosterKey
        });
      } else if (localReady) {
        send(host, "ready", {
          rosterKey
        });
      }
    }, 1e3);
    STATUS("room");
    if (disposed) {
      return;
    }
    if (role === "host") {
      collisionTimer = setTimeout(() => {
        if (!disposed) {
          phase = "collecting";
          advertise();
        }
      }, 1200);
    } else {
      send("*", "discover");
    }
  });
}

// modules/save/index.js
var SaveError = class extends Error {
  constructor(kind, message, cause) {
    super(message, cause === void 0 ? void 0 : { cause });
    this.name = "SaveError";
    this.kind = kind;
  }
};
var RECORD = (data, schema, revision) => ({ ...data, schema, revision });
var DATA = (record) => {
  const COPY = { ...record };
  delete COPY.schema;
  delete COPY.revision;
  return COPY;
};
var INTEGER = (value) => Number.isSafeInteger(value) && value >= 0;
function createSave({ adapter, key, version, create, validate, migrate = {} } = {}) {
  if (!adapter || typeof adapter.transact !== "function") {
    throw new TypeError("save adapter must provide transact");
  }
  if (typeof key !== "string" || key === "") {
    throw new TypeError("save key must be a non-empty string");
  }
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new RangeError("save version must be a positive integer");
  }
  if (typeof create !== "function" || typeof validate !== "function") {
    throw new TypeError("save create and validate must be functions");
  }
  const LISTENERS = /* @__PURE__ */ new Set();
  let channel = null, pending = Promise.resolve(), closed = false;
  if (adapter.channelName && typeof BroadcastChannel !== "undefined") {
    channel = new BroadcastChannel(`${adapter.channelName}:${key}`);
    channel.onmessage = (event) => {
      const REVISION = event.data?.revision;
      if (INTEGER(REVISION) && SAVE.revision !== null && REVISION > SAVE.revision) {
        for (const LISTENER of LISTENERS) {
          LISTENER({ revision: REVISION });
        }
      }
    };
  }
  const READ = (stored) => {
    if (stored instanceof SaveError) {
      throw stored;
    }
    if (stored === void 0) {
      const CREATED = create();
      validate(CREATED);
      return { record: RECORD(CREATED, version, 0), write: true };
    }
    if (!stored || typeof stored !== "object" || !INTEGER(stored.schema) || !INTEGER(stored.revision)) {
      throw new SaveError("unreadable", "saved record has no schema or revision");
    }
    if (stored.schema > version) {
      throw new SaveError("unreadable", `saved schema ${stored.schema} is newer than ${version}`);
    }
    let data = DATA(stored);
    for (let schema = stored.schema; schema < version; schema++) {
      if (typeof migrate[schema] !== "function") {
        throw new SaveError("unreadable", `no migration from schema ${schema}`);
      }
      data = migrate[schema](data);
    }
    try {
      validate(data);
    } catch (error) {
      throw new SaveError("unreadable", "saved record failed validation", error);
    }
    const MIGRATED = stored.schema !== version;
    return { record: RECORD(data, version, stored.revision + (MIGRATED ? 1 : 0)), write: MIGRATED };
  };
  const QUEUE = (operation) => {
    const RUN = pending.then(() => {
      if (closed) {
        throw new SaveError("closed", "save is closed");
      }
      return operation();
    });
    pending = RUN.catch(() => {
    });
    return RUN;
  };
  const COMMIT = (record, written) => {
    SAVE.data = DATA(record);
    SAVE.revision = record.revision;
    if (written) {
      channel?.postMessage({ revision: record.revision });
    }
    return SAVE.data;
  };
  const SAVE = {
    /** 마지막으로 읽거나 저장한 데이터. 직접 고치지 말고 update로 바꿉니다. */
    data: null,
    revision: null,
    /** 읽지 못한 저장을 만나면 true. 원본을 덮어쓰지 않도록 update를 거부합니다. */
    locked: false,
    /** 저장소에서 다시 읽습니다. 없으면 create로 만들고, 낮은 schema는 이관해 저장합니다. */
    load() {
      return QUEUE(async () => {
        let written = false, record;
        try {
          record = await adapter.transact(key, (stored) => {
            const RESULT = READ(stored);
            written = RESULT.write;
            return { value: RESULT.record, write: RESULT.write };
          });
        } catch (error) {
          if (error instanceof SaveError && error.kind === "unreadable") {
            SAVE.locked = true;
          }
          throw error;
        }
        SAVE.locked = false;
        return COMMIT(record, written);
      });
    },
    /**
     * 현재 데이터의 복사본을 고쳐 저장합니다. mutate가 false를 반환하면 저장하지 않습니다.
     * 저장소의 revision이 마지막으로 읽은 것과 다르면 아무것도 쓰지 않고 conflict를 던집니다.
     */
    update(mutate) {
      return QUEUE(async () => {
        if (SAVE.locked) {
          throw new SaveError("unreadable", "saved record is unreadable and preserved");
        }
        if (SAVE.revision === null) {
          throw new Error("load before update");
        }
        let written = false;
        const UPDATED = await adapter.transact(key, (stored) => {
          if (stored instanceof SaveError) {
            throw stored;
          }
          if (!stored || stored.revision !== SAVE.revision || stored.schema !== version) {
            throw new SaveError("conflict", "saved record changed elsewhere");
          }
          const NEXT = structuredClone(DATA(stored));
          if (mutate(NEXT) === false) {
            return { value: stored, write: false };
          }
          validate(NEXT);
          written = true;
          return { value: RECORD(NEXT, version, stored.revision + 1), write: true };
        });
        return COMMIT(UPDATED, written);
      });
    },
    /**
     * 저장된 레코드를 버리고 `create()`로 새로 만들어 저장합니다. 읽지 못한 저장도 덮어쓰고 잠금을 풉니다.
     * 되돌릴 수 없으므로 게임이 사용자 확인을 받은 뒤에만 부릅니다. 다른 탭이 알도록 revision은 이어서 올립니다.
     */
    reset() {
      return QUEUE(async () => {
        const CREATED = create();
        validate(CREATED);
        const RECORD_RESET = await adapter.transact(key, (stored) => ({
          value: RECORD(CREATED, version, INTEGER(stored?.revision) ? stored.revision + 1 : 0),
          write: true
        }));
        SAVE.locked = false;
        return COMMIT(RECORD_RESET, true);
      });
    },
    /** 다른 탭이 이 레코드를 저장하면 `{revision}`으로 부릅니다. 해제 함수를 반환합니다. */
    onExternalChange(listener) {
      LISTENERS.add(listener);
      return () => LISTENERS.delete(listener);
    },
    dispose() {
      closed = true;
      LISTENERS.clear();
      channel?.close();
      channel = null;
      adapter.close?.();
    }
  };
  return SAVE;
}
function memoryAdapter(records = {}) {
  const RECORDS = new Map(Object.entries(structuredClone(records)));
  return {
    channelName: null,
    async transact(key, body) {
      const { value: VALUE, write: WRITE } = body(structuredClone(RECORDS.get(key)));
      if (WRITE) {
        RECORDS.set(key, structuredClone(VALUE));
      }
      return structuredClone(VALUE);
    }
  };
}

// modules/transport/room-resume-identity.js
var HEX32 = /^[0-9a-f]{64}$/;
var DAY_MS = 24 * 60 * 60 * 1e3;
var INVALID = "invalid resume record; explicitly reset for a fresh room";
var EXPIRED = "resume record expired; explicitly reset for a fresh room";
var UNAVAILABLE = "resume storage unavailable";
var UNREADABLE = (error) => error instanceof SaveError && error.kind === "unreadable";
function createResumeRecord(options) {
  let save = null, pending = Promise.resolve(), released = false;
  const SETTLE = () => {
    if (!released) {
      return;
    }
    const LAST = pending;
    LAST.then(() => {
      if (pending === LAST && save) {
        save.dispose();
        save = null;
      }
    });
  };
  const RUN = (operation) => {
    const RESULT = pending.then(operation);
    pending = RESULT.then(
      () => {
      },
      () => {
      }
    );
    SETTLE();
    return RESULT;
  };
  return {
    /** Reads the record, or discards whatever is stored (readable or not) when `reset` is true. */
    open: (reset) => RUN(() => {
      save ??= createSave(options);
      return reset ? save.reset() : save.load();
    }),
    /** Applies a synchronous `mutate` after every earlier write. */
    write: (mutate) => RUN(async () => {
      if (!save) {
        save = createSave(options);
        await save.load();
      }
      return save.update(mutate);
    }),
    release() {
      released = true;
      SETTLE();
    }
  };
}
var IDENTITY_SAVE = ({ adapter, key }, { namespace, room }) => ({
  adapter,
  key: key ?? `bloom-gamekit:dynamic-v2:${namespace}:${room}`,
  version: 1,
  create: () => ({ identity: null }),
  validate(data) {
    const VALUE = data?.identity;
    if (VALUE === null) {
      return;
    }
    if (!VALUE || typeof VALUE !== "object" || VALUE.namespace !== namespace || VALUE.room !== room || !HEX32.test(VALUE.id) || !HEX32.test(VALUE.secret) || !Number.isSafeInteger(VALUE.createdAt) || !Number.isSafeInteger(VALUE.expiresAt) || VALUE.expiresAt - VALUE.createdAt > DAY_MS || VALUE.sessionId !== null && (typeof VALUE.sessionId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(VALUE.sessionId)) || !Array.isArray(VALUE.players) || VALUE.players.length > 5 || VALUE.players.some((id) => !HEX32.test(id)) || new Set(VALUE.players).size !== VALUE.players.length || !Number.isSafeInteger(VALUE.epoch) || VALUE.epoch < 0 || VALUE.epoch > 65534 || VALUE.coordinatorId !== null && !VALUE.players.includes(VALUE.coordinatorId)) {
      throw new TypeError("resume identity record");
    }
  }
});
function resumeOptions({ key, lifetimeMs = 8 * 60 * 60 * 1e3, reset = false } = {}) {
  integer(lifetimeMs, "resume lifetimeMs", 1e3, DAY_MS);
  if (key !== void 0 && (typeof key !== "string" || !key.length || key.length > 512)) {
    throw new TypeError("resume storage key");
  }
  if (typeof reset !== "boolean") {
    throw new TypeError("resume reset");
  }
  return { lifetimeMs, reset };
}
async function resetRoomResume(resume, scope) {
  resumeOptions(resume);
  const RECORD2 = createResumeRecord(IDENTITY_SAVE(resume, scope));
  try {
    await RECORD2.open(true);
  } finally {
    RECORD2.release();
  }
}
async function createRoomResumeIdentity(resume, { namespace, room, onWriteFailure }) {
  const { lifetimeMs: LIFETIME_MS, reset: RESET } = resumeOptions(resume);
  if (typeof onWriteFailure !== "function") {
    throw new TypeError("resume onWriteFailure");
  }
  const RECORD2 = createResumeRecord(IDENTITY_SAVE(resume, { namespace, room }));
  let saved;
  let secret;
  let forgotten = false;
  let closed = false;
  try {
    try {
      ({ identity: saved } = await RECORD2.open(RESET));
    } catch (error) {
      throw UNREADABLE(error) ? new Error(INVALID, { cause: error }) : error;
    }
    const NOW = Date.now();
    if (saved) {
      if (saved.expiresAt <= NOW) {
        throw new Error(EXPIRED);
      }
      secret = nostrFromHex(saved.secret);
      const SCALAR = nostrBytesToNumber(secret);
      if (saved.createdAt > NOW || SCALAR <= 0n || SCALAR >= NOSTR_ORDER || nostrToHex(nostrPublicKey(secret)) !== saved.id) {
        throw new Error(INVALID);
      }
    } else {
      secret = new Uint8Array(32);
      let valid = false;
      for (let attempt = 0; attempt < 16; attempt++) {
        globalThis.crypto.getRandomValues(secret);
        const VALUE = nostrBytesToNumber(secret);
        if (VALUE > 0n && VALUE < NOSTR_ORDER) {
          valid = true;
          break;
        }
      }
      if (!valid) {
        throw new Error("resume identity generation failed");
      }
      const FRESH = {
        namespace,
        room,
        id: nostrToHex(nostrPublicKey(secret)),
        secret: nostrToHex(secret),
        createdAt: NOW,
        expiresAt: NOW + LIFETIME_MS,
        sessionId: null,
        coordinatorId: null,
        epoch: 0,
        players: []
      };
      try {
        await RECORD2.write((draft) => {
          draft.identity = FRESH;
        });
      } catch (error) {
        throw new Error(UNAVAILABLE, { cause: error });
      }
      saved = FRESH;
    }
  } catch (error) {
    secret?.fill(0);
    RECORD2.release();
    throw error;
  }
  const ID = saved.id;
  let record = saved;
  const METADATA = saved.sessionId === null ? null : {
    sessionId: saved.sessionId,
    coordinatorId: saved.coordinatorId,
    epoch: saved.epoch,
    players: [...saved.players]
  };
  function close() {
    if (closed) {
      return;
    }
    closed = true;
    secret.fill(0);
    record = null;
    RECORD2.release();
  }
  function persist(value) {
    RECORD2.write((draft) => {
      draft.identity = value;
    }).catch((error) => {
      close();
      onWriteFailure(error);
    });
  }
  return {
    metadata: METADATA,
    identity: {
      id: ID,
      sign(hash, auxiliary, cryptoImpl) {
        if (closed) {
          throw new Error("resume identity closed");
        }
        return nostrSign(hash, secret, auxiliary, cryptoImpl);
      },
      close
    },
    update(value) {
      if (!forgotten && !closed) {
        record = {
          ...record,
          ...value,
          players: [...value.players]
        };
        persist(record);
      }
    },
    forget() {
      forgotten = true;
      persist(null);
    }
  };
}

// modules/transport/dynamic-room.js
var VALID_ID = (value) => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
var SIGNAL_TYPES = /* @__PURE__ */ new Set(["offer", "answer", "ice", "bye"]);
var PROBE_MAGIC = new Uint8Array([66, 77, 68, 89, 78, 80, 82, 49]);
var MAX_SIGNAL_BYTES = 128 * 1024;
var MAX_BACKLOG_BYTES = 2 * 1024 * 1024;
var RANDOM_ID = () => [...globalThis.crypto.getRandomValues(new Uint8Array(16))].map((n) => n.toString(16).padStart(2, "0")).join("");
function roster(value, maxPlayers) {
  if (!Array.isArray(value) || value.length < 1 || value.length > maxPlayers || value.some((id) => !VALID_ID(id)) || new Set(value).size !== value.length) {
    throw new TypeError("dynamic room players");
  }
  return Object.freeze([...value].sort(COMPARE_IDS));
}
async function createNostrDynamicRoom({
  role,
  room,
  namespace = "rollback-netcode",
  maxPlayers = 5,
  maxPendingPeers = 5,
  timeoutMs = 6e4,
  peerTimeoutMs = 2e4,
  retryMs = 1500,
  advertiseIntervalMs = 5e3,
  resume,
  resumeProbeMs = 1500,
  relays,
  rtcConfig,
  signal,
  onStatus = () => {
  },
  signalerFactory = createNostrSignaler,
  peerFactory = createWebRTCPeer,
  expectedSessionId,
  authorizeJoin = () => true
} = {}) {
  if (!["host", "join"].includes(role)) {
    throw new TypeError("dynamic room role");
  }
  integer(maxPlayers, "maxPlayers", 1, 5);
  integer(maxPendingPeers, "maxPendingPeers", 1, 5);
  integer(timeoutMs, "timeoutMs", 1, 12e4);
  integer(peerTimeoutMs, "peerTimeoutMs", 1, 12e4);
  integer(resumeProbeMs, "resumeProbeMs", 10, 1e4);
  integer(retryMs, "retryMs", 10, 1e4);
  integer(advertiseIntervalMs, "advertiseIntervalMs", 10, 12e4);
  if (typeof namespace !== "string" || !namespace.trim() || ENCODER.encode(namespace + ":dynamic-v1").length > 128) {
    throw new TypeError("dynamic room namespace");
  }
  if (expectedSessionId !== void 0 && (!VALID_ID(expectedSessionId) || expectedSessionId.length > 116)) {
    throw new TypeError("expectedSessionId");
  }
  if ([onStatus, signalerFactory, peerFactory, authorizeJoin].some((fn) => typeof fn !== "function")) {
    throw new TypeError("dynamic room capability");
  }
  if (signal?.aborted) {
    throw new Error("dynamic room aborted");
  }
  if (!room && role === "host") {
    room = String(globalThis.crypto.getRandomValues(new Uint32Array(1))[0] % 1e4).padStart(4, "0");
  }
  if (!/^\d{4}$/.test(room ?? "")) {
    throw new TypeError("four-digit room");
  }
  const RESUME_IDENTITY = resume ? await createRoomResumeIdentity(resume, {
    namespace,
    room,
    onWriteFailure: (error) => STATUS("resume-save-failed", {
      record: "identity",
      reason: error.message,
      error
    })
  }) : null;
  const STARTED_AT = NOW_MS(), SIGNAL_CONTROLLER = new AbortController();
  let initializationReject;
  const INITIALIZATION_FAILURE = new Promise((_resolve, reject) => {
    initializationReject = reject;
  });
  const INITIALIZATION_TIMER = setTimeout(() => {
    SIGNAL_CONTROLLER.abort();
    initializationReject(new Error("dynamic room signaling timeout"));
  }, timeoutMs);
  const EARLY_ABORT = () => {
    SIGNAL_CONTROLLER.abort();
    initializationReject(new Error("dynamic room aborted"));
  };
  signal?.addEventListener("abort", EARLY_ABORT, {
    once: true
  });
  let signaler;
  try {
    const SETUP = Promise.resolve().then(
      () => signalerFactory({
        room,
        namespace: namespace + ":dynamic-v1",
        relays,
        signal: SIGNAL_CONTROLLER.signal,
        timeoutMs: Math.min(timeoutMs, 1e4),
        onStatus,
        maxVerificationsPerSecond: 32,
        verificationBurst: 20,
        identity: RESUME_IDENTITY?.identity
      })
    ).then((value) => {
      if (SIGNAL_CONTROLLER.signal.aborted) {
        value?.close?.();
      }
      return value;
    });
    signaler = await Promise.race([SETUP, INITIALIZATION_FAILURE]);
    if (!VALID_ID(signaler?.id) || ["send", "subscribe", "close"].some((key) => typeof signaler?.[key] !== "function")) {
      throw new TypeError("dynamic signaler capability");
    }
    if (signal?.aborted || SIGNAL_CONTROLLER.signal.aborted) {
      throw new Error("dynamic room aborted");
    }
  } catch (error) {
    SIGNAL_CONTROLLER.abort();
    signaler?.close?.();
    RESUME_IDENTITY?.identity.close();
    throw error;
  } finally {
    clearTimeout(INITIALIZATION_TIMER);
    signal?.removeEventListener("abort", EARLY_ABORT);
  }
  if (RESUME_IDENTITY && signaler.id !== RESUME_IDENTITY.identity.id) {
    signaler.close();
    RESUME_IDENTITY.identity.close();
    throw new Error("resume signaler identity mismatch");
  }
  const SELF = signaler.id, INCARNATION = RANDOM_ID(), TRANSPORTS = /* @__PURE__ */ new Map(), PEER_CONNECTIONS = /* @__PURE__ */ new Map(), LISTENERS = /* @__PURE__ */ new Set();
  const LINKS = /* @__PURE__ */ new Map(), GENERATIONS = /* @__PURE__ */ new Map(), CANDIDATES = /* @__PURE__ */ new Map(), BACKLOG = /* @__PURE__ */ new Map(), PUBLICATIONS = /* @__PURE__ */ new Map();
  const SAVED = RESUME_IDENTITY?.metadata, RESUMED = !!(SAVED?.sessionId && SAVED.players.includes(SELF));
  if (SAVED?.sessionId && expectedSessionId !== void 0 && expectedSessionId !== SAVED.sessionId) {
    signaler.close();
    RESUME_IDENTITY.identity.close();
    throw new Error("resume session does not match expectedSessionId; explicitly reset");
  }
  const RESUME_TARGETS = new Set(RESUMED ? SAVED.players : []);
  const ESTABLISHING = role === "join" || RESUMED, INCARNATIONS = /* @__PURE__ */ new Map([[SELF, INCARNATION]]), RESUME_APPROVED = /* @__PURE__ */ new Set(), RESUME_CHECKS = /* @__PURE__ */ new Map();
  let resumePeerId = null;
  let players = Object.freeze(RESUMED ? [...SAVED.players] : role === "host" ? [SELF] : []);
  let coordinatorId = RESUMED ? SAVED.coordinatorId : role === "host" ? SELF : null;
  let sessionId = RESUMED ? SAVED.sessionId : role === "host" ? RANDOM_ID() : null;
  let epoch = RESUMED ? SAVED.epoch : 0;
  let meshPlayers = new Set(players);
  let meshUntil = RESUMED ? Infinity : 0;
  let hasBeenAdmitted = players.includes(SELF);
  let allowBranchReconnect = false;
  let disposed = false;
  let settled = false;
  let backlogBytes = 0;
  let unsubscribe;
  let interval;
  let deadline;
  let invitation;
  let nextAdvertisement = 0;
  let readyResolve;
  let readyReject;
  const READY = new Promise((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  const STATUS = (type, detail = {}) => {
    const EVENT = {
      type,
      room,
      role,
      ...detail
    };
    try {
      onStatus(EVENT);
    } catch {
    }
    for (const FN of [...LISTENERS]) {
      try {
        FN(EVENT);
      } catch {
      }
    }
  };
  const PENDING_COUNT = () => [...LINKS.values()].filter((link) => !link.peer).length;
  const ACCEPTED = (id) => players.includes(id) || meshPlayers.has(id) && meshUntil > NOW_MS() || CANDIDATES.has(id);
  const LEADER = (id) => COMPARE_IDS(SELF, id) > 0;
  const CONTROL = (op, extra = {}) => ({
    type: "group",
    mode: "dynamic",
    version: 1,
    protocol: PROTOCOL_VERSION,
    op,
    sessionId,
    coordinatorId,
    epoch,
    incarnation: INCARNATION,
    ...extra
  });
  function publish(to, payload, key = to + ":" + payload.op) {
    if (disposed) {
      return Promise.reject(new Error("dynamic room closed"));
    }
    if (PUBLICATIONS.has(key)) {
      return PUBLICATIONS.get(key);
    }
    if (PUBLICATIONS.size >= 32) {
      return Promise.reject(new Error("dynamic signaling publication capacity"));
    }
    const PROMISE = Promise.resolve().then(() => {
      if (disposed) {
        throw new Error("dynamic room closed");
      }
      return signaler.send(to, payload);
    }).finally(() => {
      if (PUBLICATIONS.get(key) === PROMISE) {
        PUBLICATIONS.delete(key);
      }
    });
    PUBLICATIONS.set(key, PROMISE);
    return PROMISE;
  }
  function send(to, op, extra = {}) {
    const PROMISE = publish(
      to,
      CONTROL(op, {
        targetIncarnation: INCARNATIONS.get(to),
        ...extra
      })
    );
    PROMISE.catch((error) => {
      if (!disposed) {
        STATUS("signal-error", {
          peerId: to,
          reason: error.message
        });
      }
    });
    return PROMISE;
  }
  function forgetBacklog(key) {
    const QUEUED = BACKLOG.get(key);
    if (!QUEUED) {
      return;
    }
    for (const ITEM of QUEUED.items) {
      backlogBytes -= ITEM.size;
    }
    BACKLOG.delete(key);
  }
  function rememberGeneration(id, generation) {
    GENERATIONS.delete(id);
    GENERATIONS.set(id, generation);
    for (const OLD of GENERATIONS.keys()) {
      if (GENERATIONS.size <= 64) {
        break;
      }
      if (!LINKS.has(OLD) && !ACCEPTED(OLD)) {
        GENERATIONS.delete(OLD);
      }
    }
  }
  function destroyLink(link, reason, notify = true, preserveWaiter = false) {
    if (LINKS.get(link.id) !== link) {
      return;
    }
    LINKS.delete(link.id);
    clearTimeout(link.deadline);
    link.removeStatus?.();
    link.removeRaw?.();
    link.cancelProbe?.();
    link.controller.abort();
    const WAS_CONNECTED = TRANSPORTS.delete(link.id);
    PEER_CONNECTIONS.delete(link.id);
    link.peer?.close();
    link.subscribers.clear();
    link.outbound.clear();
    if (!preserveWaiter) {
      link.reject(new Error(reason));
    }
    if (WAS_CONNECTED && notify && !disposed) {
      STATUS("peer-disconnected", {
        peerId: link.id,
        reason
      });
    }
  }
  function finish() {
    if (disposed || settled) {
      return;
    }
    settled = true;
    clearTimeout(deadline);
    readyResolve(CAPABILITY);
  }
  function close(reason = "dynamic room closed") {
    if (disposed) {
      return;
    }
    disposed = true;
    clearInterval(interval);
    clearTimeout(deadline);
    unsubscribe?.();
    signal?.removeEventListener("abort", abort);
    for (const LINK of [...LINKS.values()]) {
      destroyLink(LINK, reason, false);
    }
    SIGNAL_CONTROLLER.abort();
    signaler.close();
    RESUME_IDENTITY?.identity.close();
    BACKLOG.clear();
    backlogBytes = 0;
    CANDIDATES.clear();
    PUBLICATIONS.clear();
    if (!settled) {
      settled = true;
      readyReject(new Error(reason));
    }
    STATUS("room-closed", {
      reason
    });
    LISTENERS.clear();
  }
  function abort() {
    close("dynamic room aborted");
  }
  function failLink(link, error) {
    if (disposed || LINKS.get(link.id) !== link) {
      return;
    }
    destroyLink(link, error.message || String(error));
    STATUS("peer-failed", {
      peerId: link.id,
      reason: error.message || String(error)
    });
  }
  function newLink(id, generation, connectionId, prior) {
    if (!prior && (PENDING_COUNT() >= maxPendingPeers || LINKS.size >= maxPlayers - 1 + maxPendingPeers)) {
      throw new Error("dynamic pending peer capacity");
    }
    let resolve;
    let reject;
    let promise;
    if (prior && !prior.peer) {
      ({ resolve, reject, promise } = prior);
    } else {
      promise = new Promise((yes, no) => {
        resolve = yes;
        reject = no;
      });
      promise.catch(() => {
      });
    }
    if (prior) {
      destroyLink(prior, "peer reconnecting", true, !prior.peer);
    }
    const LINK = {
      id,
      generation,
      connectionId,
      resolve,
      reject,
      promise,
      controller: new AbortController(),
      peer: null,
      started: false,
      subscribers: /* @__PURE__ */ new Set(),
      outbound: /* @__PURE__ */ new Map(),
      nextRetry: 0,
      requestGeneration: GENERATIONS.get(id) ?? 0,
      force: false
    };
    LINKS.set(id, LINK);
    LINK.deadline = setTimeout(() => failLink(LINK, new Error("dynamic peer timeout")), peerTimeoutMs);
    return LINK;
  }
  function scopedSignaler(link) {
    return {
      id: SELF,
      close() {
      },
      send(to, payload) {
        if (disposed || LINKS.get(link.id) !== link || to !== link.id || !SIGNAL_TYPES.has(payload?.type)) {
          return Promise.reject(new Error("dynamic peer scope"));
        }
        const MESSAGE = {
          ...payload,
          dynamicSession: sessionId,
          dynamicGeneration: link.generation,
          dynamicConnection: link.connectionId,
          dynamicFrom: INCARNATION,
          dynamicTo: INCARNATIONS.get(to)
        };
        if (ENCODER.encode(JSON.stringify(MESSAGE)).length > MAX_SIGNAL_BYTES) {
          return Promise.reject(new RangeError("dynamic signaling message capacity"));
        }
        if (payload.type === "offer" || payload.type === "answer") {
          link.outbound.set(payload.type, MESSAGE);
        }
        return Promise.resolve(link.announcement).then(() => {
          if (disposed || LINKS.get(link.id) !== link) {
            throw new Error("dynamic peer scope");
          }
          return publish(to, MESSAGE, `${to}:signal:${link.generation}:${payload.type}`);
        });
      },
      subscribe(fn) {
        if (typeof fn !== "function") {
          throw new TypeError("dynamic signaling subscriber");
        }
        link.subscribers.add(fn);
        const KEY = `${link.id}:${link.generation}:${link.connectionId}`, QUEUED = BACKLOG.get(KEY);
        if (QUEUED) {
          const ITEMS = QUEUED.items.slice();
          forgetBacklog(KEY);
          for (const ITEM of ITEMS) {
            if (!disposed) {
              fn(ITEM.envelope);
            }
          }
        }
        return () => link.subscribers.delete(fn);
      }
    };
  }
  function saveResume() {
    if (!RESUME_IDENTITY || !sessionId) {
      return;
    }
    if (hasBeenAdmitted && !players.includes(SELF)) {
      RESUME_IDENTITY.forget();
      return;
    }
    if (players.includes(SELF)) {
      hasBeenAdmitted = true;
    }
    RESUME_IDENTITY.update({
      sessionId,
      coordinatorId,
      epoch,
      players
    });
  }
  function acceptIncarnations(value, next) {
    if (!value || typeof value !== "object") {
      return;
    }
    for (const ID of next) {
      if (ID !== SELF && VALID_ID(value[ID])) {
        if (!LINKS.has(ID) || !INCARNATIONS.has(ID)) {
          INCARNATIONS.set(ID, value[ID]);
        }
      }
    }
  }
  function wrapTransport(link, raw) {
    const HANDLERS = /* @__PURE__ */ new Set();
    link.removeRaw = raw.subscribe((bytes2) => {
      if (bytes2.length === 25 && PROBE_MAGIC.every((value, i) => bytes2[i] === value)) {
        if (bytes2[8] === 1) {
          const REPLY = bytes2.slice();
          REPLY[8] = 2;
          raw.send(REPLY);
        } else if (bytes2[8] === 2) {
          link.onPong?.(bytes2.subarray(9));
        }
        return;
      }
      for (const FN of [...HANDLERS]) {
        FN(bytes2);
      }
    });
    return {
      get state() {
        return raw.state;
      },
      get bufferedAmount() {
        return raw.bufferedAmount ?? 0;
      },
      send: (data) => raw.send(data),
      close: () => link.peer.close(),
      subscribe(fn) {
        if (typeof fn !== "function") {
          throw new TypeError("dynamic transport subscriber");
        }
        HANDLERS.add(fn);
        return () => HANDLERS.delete(fn);
      },
      subscribeStatus: (fn) => raw.subscribeStatus?.(fn) ?? (() => {
      })
    };
  }
  function probePeer(link) {
    if (!link?.peer || link.peer.transport.state && link.peer.transport.state !== "open") {
      return Promise.resolve(false);
    }
    return new Promise((resolve) => {
      const BYTES = new Uint8Array(25);
      BYTES.set(PROBE_MAGIC);
      BYTES[8] = 1;
      const NONCE = globalThis.crypto.getRandomValues(new Uint8Array(16));
      BYTES.set(NONCE, 9);
      let done = false;
      let timer;
      const FINISH = (alive) => {
        if (done) {
          return;
        }
        done = true;
        clearTimeout(timer);
        link.onPong = null;
        link.cancelProbe = null;
        resolve(alive);
      };
      link.onPong = (response) => {
        if (NONCE.every((value, i) => response[i] === value)) {
          FINISH(true);
        }
      };
      link.cancelProbe = () => FINISH(false);
      timer = setTimeout(() => FINISH(false), resumeProbeMs);
      if (!link.peer.transport.send(BYTES)) {
        FINISH(true);
      }
    });
  }
  function approveResume(id, requestedIncarnation) {
    if (INCARNATIONS.get(id) === requestedIncarnation) {
      send(id, "resume-accept", {
        generation: LINKS.get(id)?.connectionId ? LINKS.get(id).generation : (GENERATIONS.get(id) ?? 0) + 1
      });
      return;
    }
    if (RESUME_CHECKS.has(id)) {
      return;
    }
    const EXISTING = LINKS.get(id);
    const CHECK = probePeer(EXISTING).then((alive) => {
      if (disposed || LINKS.get(id) !== EXISTING) {
        return;
      }
      if (alive) {
        send(id, "resume-reject", {
          targetIncarnation: requestedIncarnation
        });
        return;
      }
      if (EXISTING?.peer && LINKS.get(id) === EXISTING) {
        destroyLink(EXISTING, "peer resuming");
      }
      INCARNATIONS.set(id, requestedIncarnation);
      const GENERATION = (GENERATIONS.get(id) ?? 0) + 1;
      send(id, "resume-accept", {
        generation: GENERATION,
        targetIncarnation: requestedIncarnation
      });
      STATUS("peer-resuming", {
        peerId: id
      });
      if (LEADER(id)) {
        try {
          startGeneration(id, GENERATION);
        } catch {
        }
      } else if (EXISTING && LINKS.get(id) === EXISTING) {
        try {
          newLink(id, 0, null, EXISTING);
        } catch {
        }
      }
    }).finally(() => RESUME_CHECKS.delete(id));
    RESUME_CHECKS.set(id, CHECK);
  }
  function startPeer(link) {
    if (disposed || link.started || LINKS.get(link.id) !== link) {
      return;
    }
    link.started = true;
    Promise.resolve().then(() => {
      if (disposed || LINKS.get(link.id) !== link) {
        throw new Error("dynamic peer superseded");
      }
      return peerFactory({
        initiator: LEADER(link.id),
        signaler: scopedSignaler(link),
        remoteId: link.id,
        rtcConfig,
        timeoutMs: peerTimeoutMs,
        signal: link.controller.signal,
        onStatus: (event) => STATUS("peer-status", {
          peerId: link.id,
          event
        })
      });
    }).then((peer) => {
      if (disposed || LINKS.get(link.id) !== link) {
        peer?.close?.();
        return;
      }
      if (typeof peer?.transport?.send !== "function" || typeof peer.transport.subscribe !== "function" || typeof peer.close !== "function") {
        peer?.close?.();
        throw new TypeError("dynamic peer capability");
      }
      if (peer.transport.state && peer.transport.state !== "open") {
        peer.close();
        throw new Error("dynamic transport not open");
      }
      link.peer = peer;
      clearTimeout(link.deadline);
      link.outbound.clear();
      const TRANSPORT = wrapTransport(link, peer.transport);
      TRANSPORTS.set(link.id, TRANSPORT);
      PEER_CONNECTIONS.set(link.id, peer.peerConnection);
      if (peer.transport.subscribeStatus) {
        link.removeStatus = peer.transport.subscribeStatus((state) => {
          if (state === "closed" || state === "failed" || state === "interrupted") {
            failLink(link, new Error("dynamic peer " + state));
          }
        });
      }
      link.resolve(TRANSPORT);
      STATUS("peer-connected", {
        peerId: link.id,
        transport: TRANSPORT,
        generation: link.generation
      });
      if (!disposed && ESTABLISHING && (link.id === coordinatorId || RESUMED && coordinatorId === SELF)) {
        resumePeerId ??= link.id;
        finish();
      }
    }).catch((error) => failLink(link, error));
  }
  function announceLink(link) {
    return send(link.id, "link", {
      generation: link.generation,
      connectionId: link.connectionId
    });
  }
  function startGeneration(id, generation) {
    const LINK = newLink(id, generation, RANDOM_ID(), LINKS.get(id));
    rememberGeneration(id, generation);
    LINK.announcement = announceLink(LINK);
    LINK.announcement.catch((error) => failLink(LINK, error));
    startPeer(LINK);
    return LINK;
  }
  function ensurePeer(id, force = false) {
    if (disposed) {
      return Promise.reject(new Error("dynamic room closed"));
    }
    if (!VALID_ID(id) || id === SELF || !ACCEPTED(id)) {
      return Promise.reject(new Error("dynamic peer is not invited"));
    }
    const OLD = LINKS.get(id);
    if (RESUMED && RESUME_TARGETS.has(id) && !RESUME_APPROVED.has(id)) {
      try {
        const WAITING = OLD ?? newLink(id, 0, null);
        WAITING.resuming = true;
        send(id, "resume-request", {
          resumeSession: sessionId
        });
        return WAITING.promise;
      } catch (error) {
        return Promise.reject(error);
      }
    }
    if (!INCARNATIONS.has(id)) {
      try {
        const WAITING = OLD ?? newLink(id, 0, null);
        WAITING.waitingIncarnation = true;
        return WAITING.promise;
      } catch (error) {
        return Promise.reject(error);
      }
    }
    if (OLD && !OLD.waitingIncarnation && (!force || !OLD.peer)) {
      return OLD.promise;
    }
    try {
      if (LEADER(id)) {
        return startGeneration(id, (GENERATIONS.get(id) ?? 0) + 1).promise;
      }
      const LINK = newLink(id, 0, null, OLD);
      LINK.force = force;
      send(id, "request", {
        generation: LINK.requestGeneration,
        reconnect: force
      });
      return LINK.promise;
    } catch (error) {
      return Promise.reject(error);
    }
  }
  function advertise(to = "*") {
    if (coordinatorId !== SELF || RESUMED && !settled) {
      return;
    }
    send(to, "hello", {
      players,
      maxPlayers,
      accepting: players.length < maxPlayers
    });
  }
  function inviteMesh(value) {
    const NEXT = roster(value, maxPlayers);
    if (!NEXT.includes(SELF) || !NEXT.includes(coordinatorId)) {
      throw new TypeError("dynamic mesh requires local player and coordinator");
    }
    meshPlayers = new Set(NEXT);
    meshUntil = NOW_MS() + peerTimeoutMs;
    if (coordinatorId === SELF) {
      invitation = {
        players: NEXT,
        until: meshUntil
      };
      send("*", "mesh", {
        players: NEXT,
        peerIncarnations: Object.fromEntries(INCARNATIONS)
      });
    }
    return NEXT;
  }
  function setRoster(value) {
    if (disposed) {
      throw new Error("dynamic room closed");
    }
    const NEXT = roster(value?.players, maxPlayers), NEXT_EPOCH = integer(value?.epoch, "epoch", 0, 65534);
    if (!VALID_ID(value?.coordinatorId) || !NEXT.includes(value.coordinatorId)) {
      throw new TypeError("dynamic roster coordinator");
    }
    if (NEXT_EPOCH < epoch) {
      throw new Error("stale dynamic room epoch");
    }
    if (NEXT_EPOCH === epoch && (players.join("\n") !== NEXT.join("\n") || coordinatorId !== value.coordinatorId)) {
      throw new Error("conflicting dynamic room epoch");
    }
    players = NEXT;
    epoch = NEXT_EPOCH;
    coordinatorId = value.coordinatorId;
    if (value.allowBranchReconnect === true) {
      allowBranchReconnect = true;
    }
    meshPlayers = new Set(NEXT);
    meshUntil = Infinity;
    invitation = null;
    for (const ID of CANDIDATES.keys()) {
      if (NEXT.includes(ID)) {
        CANDIDATES.delete(ID);
      }
    }
    for (const ID of INCARNATIONS.keys()) {
      if (ID !== SELF && !NEXT.includes(ID) && !LINKS.has(ID) && !CANDIDATES.has(ID)) {
        INCARNATIONS.delete(ID);
      }
    }
    saveResume();
    if (coordinatorId === SELF) {
      advertise();
    }
  }
  const CAPABILITY = {
    room,
    role,
    maxPlayers,
    resumed: RESUMED,
    get resumePeerId() {
      return resumePeerId;
    },
    localPlayerId: SELF,
    transports: TRANSPORTS,
    peerConnections: PEER_CONNECTIONS,
    get sessionId() {
      return sessionId;
    },
    get coordinatorId() {
      return coordinatorId;
    },
    get players() {
      return players;
    },
    get epoch() {
      return epoch;
    },
    get joining() {
      return !players.includes(SELF);
    },
    get closed() {
      return disposed;
    },
    get metrics() {
      return {
        activePeerCount: TRANSPORTS.size,
        pendingPeerCount: PENDING_COUNT(),
        signalBacklogBytes: backlogBytes
      };
    },
    subscribe(fn) {
      if (disposed || typeof fn !== "function") {
        throw new TypeError("dynamic room subscriber");
      }
      LISTENERS.add(fn);
      return () => LISTENERS.delete(fn);
    },
    setRoster,
    connectMesh(value) {
      try {
        if (disposed) {
          throw new Error("dynamic room closed");
        }
        const NEXT = inviteMesh(value);
        return Promise.all(NEXT.filter((id) => id !== SELF).map((id) => ensurePeer(id))).then(() => void 0);
      } catch (error) {
        return Promise.reject(error);
      }
    },
    reconnect(id) {
      return ensurePeer(id, true);
    },
    forgetResume() {
      RESUME_IDENTITY?.forget();
    },
    disconnect(id) {
      if (!VALID_ID(id) || id === SELF) {
        throw new TypeError("dynamic peer id");
      }
      const LINK = LINKS.get(id);
      if (LINK) {
        destroyLink(LINK, "peer disconnected by owner");
      }
      CANDIDATES.delete(id);
      meshPlayers.delete(id);
      if (!players.includes(id)) {
        INCARNATIONS.delete(id);
      }
      for (const KEY of BACKLOG.keys()) {
        if (KEY.startsWith(id + ":")) {
          forgetBacklog(KEY);
        }
      }
      return !!LINK;
    },
    close
  };
  function routeSignal(envelope) {
    const { from: FROM, to: TO, message: M } = envelope;
    if (TO !== SELF || M.dynamicSession !== sessionId || M.dynamicTo !== INCARNATION || M.dynamicFrom !== INCARNATIONS.get(FROM) || !ACCEPTED(FROM) || !Number.isSafeInteger(M.dynamicGeneration) || M.dynamicGeneration < 1 || !VALID_ID(M.dynamicConnection)) {
      return;
    }
    let size;
    try {
      size = ENCODER.encode(JSON.stringify(M)).length;
    } catch {
      return;
    }
    if (size > MAX_SIGNAL_BYTES) {
      return;
    }
    const LINK = LINKS.get(FROM);
    if (LINK?.generation === M.dynamicGeneration && LINK.connectionId === M.dynamicConnection && LINK.subscribers.size) {
      for (const FN of [...LINK.subscribers]) {
        FN(envelope);
      }
      return;
    }
    const KNOWN = GENERATIONS.get(FROM) ?? 0;
    if (LEADER(FROM) || M.dynamicGeneration < KNOWN || M.dynamicGeneration === KNOWN && (!LINK || LINK.generation !== M.dynamicGeneration || LINK.connectionId !== M.dynamicConnection)) {
      return;
    }
    const KEY = `${FROM}:${M.dynamicGeneration}:${M.dynamicConnection}`;
    const QUEUED = BACKLOG.get(KEY) ?? {
      items: [],
      until: NOW_MS() + peerTimeoutMs
    };
    if (QUEUED.items.length >= 32 || !BACKLOG.has(KEY) && BACKLOG.size >= maxPendingPeers || backlogBytes + size > MAX_BACKLOG_BYTES) {
      return;
    }
    QUEUED.items.push({
      envelope,
      size
    });
    backlogBytes += size;
    BACKLOG.set(KEY, QUEUED);
  }
  function receive(envelope) {
    if (disposed || !envelope || !VALID_ID(envelope.from) || envelope.from === SELF || !["*", SELF].includes(envelope.to) || !envelope.message || typeof envelope.message !== "object") {
      return;
    }
    const { from: FROM, message: M } = envelope;
    if (SIGNAL_TYPES.has(M.type)) {
      routeSignal(envelope);
      return;
    }
    if (M.type !== "group" || M.mode !== "dynamic" || M.version !== 1 || M.protocol !== PROTOCOL_VERSION) {
      return;
    }
    if (M.targetIncarnation && M.targetIncarnation !== INCARNATION) {
      return;
    }
    if (M.op === "discover") {
      if (M.resumeSession === sessionId && players.includes(FROM) && VALID_ID(M.incarnation)) {
        send(FROM, "resume-hello", {
          targetIncarnation: M.incarnation,
          players,
          peerIncarnations: Object.fromEntries(INCARNATIONS)
        });
      } else {
        advertise(FROM);
      }
      return;
    }
    if (M.op === "resume-hello" && RESUMED && !settled && M.sessionId === sessionId && players.includes(FROM) && VALID_ID(M.incarnation)) {
      let next;
      try {
        next = roster(M.players, maxPlayers);
        integer(M.epoch, "epoch", epoch, 65534);
      } catch {
        return;
      }
      if (!next.includes(SELF) || !next.includes(FROM) || !next.includes(M.coordinatorId)) {
        return;
      }
      players = next;
      epoch = M.epoch;
      coordinatorId = M.coordinatorId;
      meshPlayers = new Set(next);
      meshUntil = Infinity;
      acceptIncarnations(M.peerIncarnations, next);
      INCARNATIONS.set(FROM, M.incarnation);
      saveResume();
      const DONOR = coordinatorId === SELF ? FROM : coordinatorId;
      if (INCARNATIONS.has(DONOR)) {
        ensurePeer(DONOR).catch(() => {
        });
      }
      return;
    }
    if (M.op === "hello" && expectedSessionId !== void 0 && M.sessionId !== expectedSessionId) {
      return;
    }
    if (M.op === "hello" && !RESUMED && !settled && role === "join" && M.coordinatorId === FROM && VALID_ID(M.sessionId)) {
      if (coordinatorId && (coordinatorId !== FROM || sessionId !== M.sessionId)) {
        return;
      }
      let known;
      try {
        known = roster(M.players, maxPlayers);
        integer(M.epoch, "epoch", 0, 65534);
      } catch {
        return;
      }
      if (!known.includes(FROM)) {
        return;
      }
      if (M.maxPlayers !== maxPlayers) {
        close("dynamic room maxPlayers mismatch");
        return;
      }
      if (M.accepting === false && !known.includes(SELF)) {
        close("dynamic room is full");
        return;
      }
      coordinatorId = FROM;
      sessionId = M.sessionId;
      players = known;
      epoch = M.epoch;
      INCARNATIONS.set(FROM, M.incarnation);
      meshPlayers = new Set(known);
      meshUntil = Infinity;
      saveResume();
      send(FROM, "join");
      ensurePeer(FROM).catch(() => {
      });
      return;
    }
    const BRANCH_RECONNECT = allowBranchReconnect && players.includes(FROM) && ["request", "link", "resume-request", "resume-accept", "resume-reject"].includes(M.op);
    if (!sessionId || M.sessionId !== sessionId || M.coordinatorId !== coordinatorId && !BRANCH_RECONNECT) {
      return;
    }
    if (M.op === "resume-request" && players.includes(FROM) && M.resumeSession === sessionId && VALID_ID(M.incarnation)) {
      approveResume(FROM, M.incarnation);
      return;
    }
    if (M.op === "resume-reject" && RESUMED && players.includes(FROM)) {
      if (!settled) {
        close("duplicate live resume identity");
      } else if (LINKS.get(FROM)?.resuming) {
        failLink(LINKS.get(FROM), new Error("duplicate live resume identity"));
      }
      return;
    }
    if (M.op === "resume-accept" && RESUMED && players.includes(FROM) && VALID_ID(M.incarnation) && Number.isSafeInteger(M.generation) && M.generation > 0) {
      if (RESUME_APPROVED.has(FROM)) {
        return;
      }
      INCARNATIONS.set(FROM, M.incarnation);
      RESUME_APPROVED.add(FROM);
      if (LEADER(FROM)) {
        try {
          startGeneration(FROM, Math.max(M.generation, (GENERATIONS.get(FROM) ?? 0) + 1));
        } catch {
        }
      }
      return;
    }
    if (M.op === "join" && coordinatorId === SELF) {
      if (!VALID_ID(M.incarnation)) {
        return;
      }
      if (INCARNATIONS.has(FROM) && INCARNATIONS.get(FROM) !== M.incarnation) {
        send(FROM, "reject", {
          targetIncarnation: M.incarnation,
          reason: "duplicate live identity; use resume"
        });
        return;
      }
      if (!players.includes(FROM) && !CANDIDATES.has(FROM)) {
        let authorized = false;
        try {
          authorized = authorizeJoin(FROM, {
            sessionId,
            room
          }) === true;
        } catch {
        }
        if (!authorized) {
          send(FROM, "reject", {
            targetIncarnation: M.incarnation,
            reason: "dynamic room admission reservation required"
          });
          return;
        }
        if (players.length + CANDIDATES.size >= maxPlayers || PENDING_COUNT() >= maxPendingPeers) {
          send(FROM, "reject", {
            targetIncarnation: M.incarnation,
            reason: "dynamic room is full"
          });
          return;
        }
        CANDIDATES.set(FROM, NOW_MS() + peerTimeoutMs);
      }
      INCARNATIONS.set(FROM, M.incarnation);
      ensurePeer(FROM).catch(() => {
      });
      return;
    }
    if (M.op === "reject" && !settled && FROM === coordinatorId) {
      close(typeof M.reason === "string" ? M.reason.slice(0, 256) : "dynamic room rejected");
      return;
    }
    if (M.op === "mesh" && FROM === coordinatorId && M.incarnation === INCARNATIONS.get(FROM) && M.epoch === epoch) {
      let next;
      try {
        next = roster(M.players, maxPlayers);
      } catch {
        return;
      }
      if (!next.includes(SELF) || !next.includes(coordinatorId)) {
        return;
      }
      acceptIncarnations(M.peerIncarnations, next);
      meshPlayers = new Set(next);
      meshUntil = NOW_MS() + peerTimeoutMs;
      for (const ID of next) {
        if (ID !== SELF) {
          ensurePeer(ID).catch(() => {
          });
        }
      }
      return;
    }
    if (!ACCEPTED(FROM) || M.incarnation !== INCARNATIONS.get(FROM)) {
      return;
    }
    if (M.op === "request" && LEADER(FROM) && Number.isSafeInteger(M.generation) && M.generation >= 0) {
      const LINK = LINKS.get(FROM), GENERATION = GENERATIONS.get(FROM) ?? 0;
      if (M.generation > GENERATION) {
        return;
      }
      if (!LINK || M.reconnect === true && M.generation === GENERATION && LINK.peer) {
        try {
          startGeneration(FROM, GENERATION + 1);
        } catch {
        }
      } else if (LINK.connectionId) {
        announceLink(LINK);
      }
    } else if (M.op === "link" && !LEADER(FROM) && Number.isSafeInteger(M.generation) && M.generation > 0 && VALID_ID(M.connectionId)) {
      const KNOWN = GENERATIONS.get(FROM) ?? 0, CURRENT = LINKS.get(FROM);
      if (M.generation < KNOWN || M.generation === KNOWN && CURRENT?.connectionId !== M.connectionId) {
        return;
      }
      if (CURRENT?.generation === M.generation && CURRENT.connectionId === M.connectionId) {
        return;
      }
      try {
        const LINK = newLink(FROM, M.generation, M.connectionId, CURRENT);
        rememberGeneration(FROM, M.generation);
        startPeer(LINK);
      } catch {
      }
    }
  }
  signal?.addEventListener("abort", abort, {
    once: true
  });
  if (signal?.aborted) {
    abort();
    return READY;
  }
  try {
    unsubscribe = signaler.subscribe((envelope) => {
      try {
        receive(envelope);
      } catch (error) {
        close(error.message);
      }
    });
  } catch (error) {
    close(error.message);
    return READY;
  }
  if (disposed) {
    unsubscribe?.();
    return READY;
  }
  const REMAINING = timeoutMs - (NOW_MS() - STARTED_AT);
  if (REMAINING <= 0) {
    close("dynamic room timeout");
    return READY;
  }
  if (ESTABLISHING) {
    deadline = setTimeout(() => close("dynamic room join timeout"), REMAINING);
  }
  interval = setInterval(() => {
    const NOW = NOW_MS();
    for (const [ID, UNTIL] of CANDIDATES) {
      if (UNTIL <= NOW && !players.includes(ID)) {
        CANDIDATES.delete(ID);
        INCARNATIONS.delete(ID);
        const LINK = LINKS.get(ID);
        if (LINK) {
          destroyLink(LINK, "dynamic admission timeout");
        }
      }
    }
    for (const [KEY, QUEUED] of BACKLOG) {
      if (QUEUED.until <= NOW) {
        forgetBacklog(KEY);
      }
    }
    if (coordinatorId === SELF && NOW >= nextAdvertisement) {
      nextAdvertisement = NOW + advertiseIntervalMs;
      advertise();
    }
    if (!settled && ESTABLISHING) {
      if (RESUMED) {
        send("*", "discover", {
          resumeSession: sessionId
        });
      } else if (!coordinatorId) {
        send("*", "discover");
      } else {
        send(coordinatorId, "join");
        ensurePeer(coordinatorId).catch(() => {
        });
      }
    }
    if (invitation && invitation.until > NOW) {
      send("*", "mesh", {
        players: invitation.players,
        peerIncarnations: Object.fromEntries(INCARNATIONS)
      });
    } else {
      invitation = null;
    }
    for (const LINK of LINKS.values()) {
      if (!LINK.peer && NOW >= LINK.nextRetry) {
        LINK.nextRetry = NOW + retryMs;
        if (LINK.waitingIncarnation) {
          if (INCARNATIONS.has(LINK.id)) {
            ensurePeer(LINK.id).catch(() => {
            });
          }
          continue;
        }
        if (LINK.resuming && !RESUME_APPROVED.has(LINK.id)) {
          send(LINK.id, "resume-request", {
            resumeSession: sessionId
          });
          continue;
        }
        if (LEADER(LINK.id)) {
          announceLink(LINK);
        } else if (!LINK.connectionId) {
          send(LINK.id, "request", {
            generation: LINK.requestGeneration,
            reconnect: LINK.force
          });
        }
        for (const [TYPE2, MESSAGE] of LINK.outbound) {
          publish(LINK.id, MESSAGE, `${LINK.id}:signal:${LINK.generation}:${TYPE2}`).catch(() => {
          });
        }
      }
    }
  }, retryMs);
  interval.unref?.();
  STATUS("room-ready", {
    localPlayerId: SELF
  });
  if (!disposed) {
    saveResume();
    if (!ESTABLISHING) {
      advertise();
      finish();
    } else {
      send(
        "*",
        "discover",
        RESUMED ? {
          resumeSession: sessionId
        } : {}
      );
    }
  }
  return READY;
}

// modules/transport/public-room.js
var ID_VALID = (value) => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
var RANDOM_ID2 = () => [...globalThis.crypto.getRandomValues(new Uint8Array(16))].map((n) => n.toString(16).padStart(2, "0")).join("");
var RANDOM_ROOM = () => String(globalThis.crypto.getRandomValues(new Uint32Array(1))[0] % 1e4).padStart(4, "0");
var DIRECTORY_LIMIT = 64;
var PUBLICATION_LIMIT = 16;
var ERROR = (code, message) => Object.assign(new Error(message), {
  code
});
async function createNostrPublicRoom({
  namespace = "rollback-netcode",
  simulationVersion,
  maxPlayers = 5,
  discoveryMs = 1500,
  totalTimeoutMs = 6e4,
  leaseMs = 15e3,
  reservationMs = 3e4,
  maxAttempts = 3,
  relays,
  rtcConfig,
  resume,
  signal,
  onStatus = () => {
  },
  signalerFactory = createNostrSignaler,
  dynamicRoomFactory = createNostrDynamicRoom,
  ...dynamicOptions
} = {}) {
  if (typeof namespace !== "string" || !namespace.trim() || ENCODER.encode(namespace + ":public-v1").length > 128) {
    throw new TypeError("public room namespace");
  }
  if (typeof simulationVersion !== "string" || !simulationVersion.length || ENCODER.encode(simulationVersion).length > 128) {
    throw new TypeError("public simulationVersion");
  }
  integer(maxPlayers, "maxPlayers", 1, 5);
  integer(discoveryMs, "discoveryMs", 10, 3e4);
  integer(totalTimeoutMs, "totalTimeoutMs", 10, 12e4);
  integer(leaseMs, "leaseMs", 100, 6e4);
  integer(reservationMs, "reservationMs", 100, 12e4);
  integer(maxAttempts, "maxAttempts", 1, 8);
  if ([onStatus, signalerFactory, dynamicRoomFactory].some((fn) => typeof fn !== "function")) {
    throw new TypeError("public room capability");
  }
  if (resume) {
    integer(resume.lifetimeMs ?? 8 * 60 * 60 * 1e3, "resume lifetimeMs", 1e3, 864e5);
    if (resume.reset !== void 0 && typeof resume.reset !== "boolean") {
      throw new TypeError("resume reset");
    }
    if (resume.key !== void 0 && (typeof resume.key !== "string" || !resume.key.length || resume.key.length > 500)) {
      throw new TypeError("resume key");
    }
  }
  if (signal?.aborted) {
    throw ERROR("PUBLIC_ABORTED", "public room aborted");
  }
  const STARTED = NOW_MS(), STARTED_WALL_AT = Date.now(), CONTROLLER = new AbortController(), DIRECTORY = /* @__PURE__ */ new Map(), RESERVATIONS = /* @__PURE__ */ new Map(), PUBLICATIONS = /* @__PURE__ */ new Map();
  const WRITE_FAILED = (record) => (error) => STATUS("resume-save-failed", {
    record,
    reason: error.message,
    error
  });
  const EPHEMERAL = await createRoomResumeIdentity(
    {
      adapter: memoryAdapter()
    },
    {
      namespace,
      room: "0000",
      onWriteFailure: WRITE_FAILED("identity")
    }
  );
  const SHARED = (identity) => ({
    id: identity.id,
    sign: (...args) => identity.sign(...args),
    close() {
    }
  });
  let disposed = false;
  let everAdmitted = false;
  let resumeForgotten = false;
  let room;
  let directorySignaler;
  let removeDirectory;
  let removeRoom;
  let interval;
  let nextAdvertisement = 0;
  let sequence = 0;
  let reservationWaiter;
  let selected;
  let setupTimer;
  let generation = 0;
  let directoryId;
  let pointer;
  let pointerRecord;
  let storedUntil;
  const TIMER_WAITERS = /* @__PURE__ */ new Map(), OBSERVERS = /* @__PURE__ */ new Set();
  const STATUS = (type, detail = {}) => {
    const EVENT = {
      type,
      ...detail
    };
    try {
      onStatus(EVENT);
    } catch {
    }
    for (const FN of [...OBSERVERS]) {
      try {
        FN(EVENT);
      } catch {
      }
    }
  };
  const REMAINING = () => Math.max(0, Math.floor(totalTimeoutMs - (NOW_MS() - STARTED)));
  const SCOPED_RESUME = (code) => resume ? {
    ...resume,
    ...resume.key ? {
      key: `${resume.key}:${code}`
    } : {}
  } : void 0;
  if (resume) {
    const POINTER_KEY = `${resume.key ?? `bloom-gamekit:public-v2:${namespace}:${simulationVersion}`}:pointer`;
    if (POINTER_KEY.length > 512) {
      EPHEMERAL.identity.close();
      throw new TypeError("public resume key");
    }
    pointerRecord = createResumeRecord({
      adapter: resume.adapter,
      key: POINTER_KEY,
      version: 1,
      create: () => ({ pointer: null }),
      validate(data) {
        const VALUE = data?.pointer;
        if (VALUE !== null && (!VALUE || typeof VALUE !== "object" || VALUE.namespace !== namespace || VALUE.simulationVersion !== simulationVersion || !/^\d{4}$/.test(VALUE.room) || !ID_VALID(VALUE.sessionId) || !Number.isSafeInteger(VALUE.expiresAt))) {
          throw new TypeError("public resume pointer");
        }
      }
    });
    try {
      if (resume.reset) {
        let old = null;
        try {
          ({ pointer: old } = await pointerRecord.open(false));
        } catch (error) {
          if (!(error instanceof SaveError && error.kind === "unreadable")) {
            throw error;
          }
        }
        if (old) {
          await resetRoomResume(SCOPED_RESUME(old.room), { namespace, room: old.room });
        }
        await pointerRecord.open(true);
      } else {
        let unreadable = false;
        try {
          ({ pointer } = await pointerRecord.open(false));
        } catch (error) {
          unreadable = error instanceof SaveError && error.kind === "unreadable";
          if (!unreadable) {
            throw error;
          }
        }
        if (unreadable || pointer && (pointer.expiresAt <= Date.now() || pointer.expiresAt > Date.now() + 864e5)) {
          throw ERROR(
            "PUBLIC_RESUME_INVALID",
            "invalid or expired public resume pointer; explicitly reset for a fresh room"
          );
        }
        storedUntil = pointer?.expiresAt;
      }
    } catch (error) {
      EPHEMERAL.identity.close();
      pointerRecord.release();
      throw error;
    }
  }
  const FAIL = (message) => ERROR("PUBLIC_TIMEOUT", message ?? "public room total timeout");
  function wait(ms) {
    if (disposed) {
      return Promise.reject(ERROR("PUBLIC_CLOSED", "public room closed"));
    }
    return new Promise((resolve, reject) => {
      const TIMER = setTimeout(
        () => {
          TIMER_WAITERS.delete(TIMER);
          resolve();
        },
        Math.max(1, ms)
      );
      TIMER_WAITERS.set(TIMER, reject);
    });
  }
  function bounded(promise, ms, reason) {
    let timer;
    const DEADLINE = new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(reason), Math.max(1, ms));
      TIMER_WAITERS.set(timer, reject);
    });
    return Promise.race([promise, DEADLINE]).finally(() => {
      clearTimeout(timer);
      TIMER_WAITERS.delete(timer);
    });
  }
  function close(reason = "public room closed") {
    if (disposed) {
      return;
    }
    disposed = true;
    clearTimeout(setupTimer);
    clearInterval(interval);
    removeRoom?.();
    removeDirectory?.();
    CONTROLLER.abort();
    signal?.removeEventListener("abort", abort);
    const PENDING = reservationWaiter;
    reservationWaiter = null;
    PENDING?.reject(ERROR("PUBLIC_CLOSED", reason));
    for (const [TIMER, REJECT] of TIMER_WAITERS) {
      clearTimeout(TIMER);
      REJECT(ERROR("PUBLIC_CLOSED", reason));
    }
    TIMER_WAITERS.clear();
    directorySignaler?.close();
    room?.close();
    EPHEMERAL.forget();
    EPHEMERAL.identity.close();
    pointerRecord?.release();
    DIRECTORY.clear();
    RESERVATIONS.clear();
    PUBLICATIONS.clear();
    STATUS("public-room-closed", {
      reason
    });
    OBSERVERS.clear();
  }
  function abort() {
    close("public room aborted");
  }
  signal?.addEventListener("abort", abort, {
    once: true
  });
  setupTimer = setTimeout(() => close("public room total timeout"), totalTimeoutMs);
  function publish(to, op, extra = {}, key = `${to}:${op}`) {
    if (disposed || !directorySignaler) {
      return Promise.reject(ERROR("PUBLIC_CLOSED", "public directory closed"));
    }
    if (PUBLICATIONS.has(key)) {
      return PUBLICATIONS.get(key);
    }
    if (PUBLICATIONS.size >= PUBLICATION_LIMIT) {
      return Promise.reject(ERROR("PUBLIC_CAPACITY", "public directory publication capacity"));
    }
    const CHANNEL = directorySignaler, PROMISE = Promise.resolve().then(
      () => CHANNEL.send(to, {
        type: "group",
        mode: "public-directory",
        version: 1,
        protocol: PROTOCOL_VERSION,
        simulationVersion,
        maxPlayers,
        op,
        ...extra
      })
    ).finally(() => {
      if (PUBLICATIONS.get(key) === PROMISE) {
        PUBLICATIONS.delete(key);
      }
    });
    PUBLICATIONS.set(key, PROMISE);
    return PROMISE;
  }
  function prune() {
    const NOW = Date.now();
    for (const [ID, LEASE] of DIRECTORY) {
      if ((LEASE.refreshUntil ?? LEASE.expiresAt) <= NOW) {
        DIRECTORY.delete(ID);
      }
    }
    for (const [ID, SEAT] of RESERVATIONS) {
      if (!room || room.players.includes(ID) || SEAT.expiresAt <= NOW || room.coordinatorId !== room.localPlayerId) {
        RESERVATIONS.delete(ID);
        if (room && !room.players.includes(ID)) {
          room.disconnect(ID);
        }
      }
    }
  }
  function advertise(to = "*") {
    if (!room || room.closed || room.joining || room.coordinatorId !== room.localPlayerId) {
      return Promise.resolve();
    }
    prune();
    const ISSUED_AT = Date.now();
    return publish(to, "lease", {
      room: room.room,
      sessionId: room.sessionId,
      coordinatorId: room.coordinatorId,
      players: [...room.players],
      epoch: room.epoch,
      sequence: ++sequence,
      issuedAt: ISSUED_AT,
      expiresAt: ISSUED_AT + leaseMs,
      committed: room.players.length,
      pending: RESERVATIONS.size
    });
  }
  const BACKGROUND = (promise) => promise.catch((cause) => {
    if (!disposed) {
      STATUS("public-directory-error", {
        reason: cause.message
      });
    }
  });
  function receive({ from, to, message: m } = {}) {
    if (disposed || !ID_VALID(from) || from === directoryId || !["*", directoryId].includes(to) || !m || m.type !== "group" || m.mode !== "public-directory" || m.version !== 1 || m.protocol !== PROTOCOL_VERSION || m.simulationVersion !== simulationVersion || m.maxPlayers !== maxPlayers) {
      return;
    }
    const NOW = Date.now();
    if (m.op === "lease") {
      if (!/^\d{4}$/.test(m.room) || !ID_VALID(m.sessionId) || m.coordinatorId !== from || !Number.isSafeInteger(m.epoch) || m.epoch < 0 || m.epoch > 65534 || !Number.isSafeInteger(m.sequence) || m.sequence < 1 || !Number.isSafeInteger(m.issuedAt) || m.issuedAt > NOW + 1e3 || !Number.isSafeInteger(m.expiresAt) || m.expiresAt <= NOW || m.expiresAt <= m.issuedAt || m.expiresAt - m.issuedAt > 6e4 || !Array.isArray(m.players) || m.players.length < 1 || m.players.length > maxPlayers || m.players.some((id) => !ID_VALID(id)) || new Set(m.players).size !== m.players.length || !m.players.includes(from) || m.committed !== m.players.length || !Number.isSafeInteger(m.pending) || m.pending < 0 || m.pending + m.committed > maxPlayers) {
        return;
      }
      prune();
      const PRIOR = DIRECTORY.get(m.sessionId);
      if (PRIOR && (m.room !== PRIOR.room || m.epoch < PRIOR.epoch || m.epoch === PRIOR.epoch && (PRIOR.refreshAfter || m.coordinatorId !== PRIOR.coordinatorId || m.sequence <= PRIOR.sequence))) {
        return;
      }
      if (PRIOR && m.epoch > PRIOR.epoch && !PRIOR.players.includes(from)) {
        PRIOR.refreshAfter ??= PRIOR.expiresAt;
        PRIOR.refreshUntil ??= PRIOR.refreshAfter + 6e4;
        if (NOW < PRIOR.refreshAfter || m.issuedAt < PRIOR.refreshAfter) {
          return;
        }
      }
      if (!DIRECTORY.has(m.sessionId) && DIRECTORY.size >= DIRECTORY_LIMIT) {
        return;
      }
      DIRECTORY.set(m.sessionId, {
        room: m.room,
        sessionId: m.sessionId,
        coordinatorId: from,
        players: [...m.players],
        epoch: m.epoch,
        sequence: m.sequence,
        issuedAt: m.issuedAt,
        expiresAt: m.expiresAt,
        committed: m.committed,
        pending: m.pending
      });
      return;
    }
    if (m.op === "discover") {
      BACKGROUND(advertise());
      return;
    }
    if (m.op === "grant" || m.op === "deny") {
      const PENDING = reservationWaiter;
      if (!PENDING || to !== directoryId || from !== PENDING.lease.coordinatorId || m.sessionId !== PENDING.lease.sessionId || m.requestId !== PENDING.requestId || m.epoch !== PENDING.lease.epoch) {
        return;
      }
      if (m.op === "deny") {
        reservationWaiter = null;
        PENDING.reject(
          m.reason === "stale-epoch" ? ERROR("PUBLIC_STALE_LEASE", "public room lease advanced; retry discovery") : ERROR("PUBLIC_RESERVED", "public room has no available reservation")
        );
      } else if (Number.isSafeInteger(m.expiresAt) && m.expiresAt > NOW && m.expiresAt <= NOW + 12e4) {
        reservationWaiter = null;
        PENDING.resolve({
          expiresAt: m.expiresAt
        });
      }
      return;
    }
    if (!room || room.closed || room.coordinatorId !== room.localPlayerId || m.sessionId !== room.sessionId || to !== directoryId || !ID_VALID(m.requestId)) {
      return;
    }
    prune();
    if (m.op === "release") {
      const SEAT = RESERVATIONS.get(from);
      if (SEAT?.requestId === m.requestId) {
        RESERVATIONS.delete(from);
        if (!room.players.includes(from)) {
          room.disconnect(from);
        }
        BACKGROUND(advertise());
      }
      return;
    }
    if (m.op !== "reserve" || !Number.isSafeInteger(m.expiresAt) || m.expiresAt <= NOW || m.expiresAt > NOW + 12e4) {
      return;
    }
    if (m.epoch !== room.epoch) {
      if (Number.isSafeInteger(m.epoch) && m.epoch >= 0 && m.epoch < room.epoch) {
        BACKGROUND(advertise(from));
        BACKGROUND(
          publish(from, "deny", {
            sessionId: room.sessionId,
            epoch: m.epoch,
            requestId: m.requestId,
            reason: "stale-epoch"
          })
        );
      }
      return;
    }
    let seat = RESERVATIONS.get(from);
    if (room.players.includes(from)) {
      BACKGROUND(
        publish(from, "grant", {
          sessionId: room.sessionId,
          epoch: room.epoch,
          requestId: m.requestId,
          expiresAt: NOW + reservationMs
        })
      );
      return;
    }
    if (!seat && room.players.length + RESERVATIONS.size < maxPlayers) {
      seat = {
        requestId: m.requestId,
        expiresAt: Math.min(NOW + reservationMs, m.expiresAt),
        epoch: room.epoch
      };
      RESERVATIONS.set(from, seat);
    }
    if (seat) {
      seat.requestId = m.requestId;
      BACKGROUND(
        publish(from, "grant", {
          sessionId: room.sessionId,
          epoch: room.epoch,
          requestId: m.requestId,
          expiresAt: seat.expiresAt
        })
      );
    } else {
      BACKGROUND(
        publish(from, "deny", {
          sessionId: room.sessionId,
          epoch: room.epoch,
          requestId: m.requestId
        })
      );
    }
    BACKGROUND(advertise());
  }
  async function openDirectory(identity) {
    if (directorySignaler && directoryId === identity.id) {
      return;
    }
    removeDirectory?.();
    directorySignaler?.close();
    PUBLICATIONS.clear();
    const CURRENT = ++generation;
    const SETUP = Promise.resolve().then(
      () => signalerFactory({
        room: "0000",
        namespace: namespace + ":public-v1",
        relays,
        timeoutMs: Math.max(1, Math.min(1e4, REMAINING())),
        signal: CONTROLLER.signal,
        onStatus,
        maxVerificationsPerSecond: 32,
        verificationBurst: 20,
        identity: SHARED(identity)
      })
    ).then((value) => {
      if (disposed || CURRENT !== generation) {
        value?.close?.();
        throw ERROR("PUBLIC_CLOSED", "public directory closed");
      }
      return value;
    });
    try {
      directorySignaler = await bounded(SETUP, REMAINING(), FAIL());
    } catch (cause) {
      throw ERROR("PUBLIC_RELAY_UNAVAILABLE", "public directory relay unavailable: " + cause.message);
    }
    if (directorySignaler?.id !== identity.id || ["send", "subscribe", "close"].some((k) => typeof directorySignaler?.[k] !== "function")) {
      throw new TypeError("public signaler capability");
    }
    directoryId = identity.id;
    removeDirectory = directorySignaler.subscribe((envelope) => {
      try {
        receive(envelope);
      } catch (cause) {
        STATUS("public-directory-error", {
          reason: cause.message
        });
      }
    });
  }
  async function discover() {
    STATUS("public-discovering");
    try {
      await bounded(publish("*", "discover"), REMAINING(), FAIL());
    } catch (cause) {
      throw ERROR("PUBLIC_RELAY_UNAVAILABLE", "public directory relay unavailable: " + cause.message);
    }
    await wait(Math.min(discoveryMs, REMAINING()));
    try {
      await bounded(publish("*", "discover"), REMAINING(), FAIL());
    } catch (cause) {
      throw ERROR("PUBLIC_RELAY_UNAVAILABLE", "public directory relay unavailable: " + cause.message);
    }
    prune();
    const AVAILABLE = [...DIRECTORY.values()].filter((lease) => !lease.refreshAfter && lease.committed + lease.pending < maxPlayers).sort((a, b) => b.committed - a.committed || a.sessionId.localeCompare(b.sessionId));
    if (!AVAILABLE.length && [...DIRECTORY.values()].some((lease) => lease.refreshAfter)) {
      throw ERROR(
        "PUBLIC_HANDOVER_PENDING",
        "public room coordinator changed; waiting for a fresh lease after prior expiry"
      );
    }
    return AVAILABLE;
  }
  async function reserve(lease) {
    const REQUEST_ID = RANDOM_ID2(), EXPIRES_AT = Date.now() + Math.min(REMAINING(), reservationMs);
    let resolve;
    let reject;
    const RESPONSE = new Promise((yes, no) => {
      resolve = yes;
      reject = no;
    });
    reservationWaiter = {
      lease,
      requestId: REQUEST_ID,
      resolve,
      reject
    };
    RESPONSE.catch(() => {
    });
    selected = {
      ...lease,
      requestId: REQUEST_ID
    };
    const ATTEMPT_MS = Math.min(REMAINING(), Math.max(250, discoveryMs * 2));
    try {
      await bounded(
        publish(lease.coordinatorId, "reserve", {
          sessionId: lease.sessionId,
          epoch: lease.epoch,
          requestId: REQUEST_ID,
          expiresAt: EXPIRES_AT
        }),
        ATTEMPT_MS,
        ERROR("PUBLIC_RESERVATION_TIMEOUT", "public reservation timeout")
      );
      await bounded(RESPONSE, ATTEMPT_MS, ERROR("PUBLIC_RESERVATION_TIMEOUT", "public reservation timeout"));
    } finally {
      if (reservationWaiter?.requestId === REQUEST_ID) {
        reservationWaiter = null;
      }
    }
  }
  async function release() {
    if (!selected?.requestId || disposed) {
      return;
    }
    const PRIOR = selected;
    selected = null;
    try {
      await bounded(
        publish(PRIOR.coordinatorId, "release", {
          sessionId: PRIOR.sessionId,
          epoch: PRIOR.epoch,
          requestId: PRIOR.requestId
        }),
        Math.min(REMAINING(), 1e3),
        FAIL()
      );
    } catch {
    }
  }
  function savePointer(committed = false) {
    if (!resume || !room || resumeForgotten) {
      return void 0;
    }
    if (room.players.includes(room.localPlayerId)) {
      everAdmitted = true;
    }
    if (committed && everAdmitted && !room.players.includes(room.localPlayerId)) {
      resumeForgotten = true;
      return writePointer(null);
    }
    if (room.joining) {
      return void 0;
    }
    storedUntil ??= STARTED_WALL_AT + (resume.lifetimeMs ?? 8 * 60 * 60 * 1e3);
    return writePointer({
      namespace,
      simulationVersion,
      room: room.room,
      sessionId: room.sessionId,
      expiresAt: storedUntil
    });
  }
  function writePointer(value) {
    return pointerRecord.write((draft) => {
      draft.pointer = value;
    });
  }
  async function connect(lease, restoring = false) {
    const CODE = lease?.room ?? RANDOM_ROOM();
    let cancelled = false;
    const ATTEMPT_CONTROLLER = new AbortController(), ABORT_ATTEMPT = () => ATTEMPT_CONTROLLER.abort();
    CONTROLLER.signal.addEventListener("abort", ABORT_ATTEMPT, {
      once: true
    });
    if (CONTROLLER.signal.aborted) {
      ABORT_ATTEMPT();
    }
    const ATTEMPT_TIMEOUT = Math.max(
      1,
      Math.min(
        REMAINING(),
        restoring ? totalTimeoutMs : Math.max(discoveryMs * 2, dynamicOptions.peerTimeoutMs ?? 2e4)
      )
    );
    const PENDING = Promise.resolve().then(
      () => dynamicRoomFactory({
        ...dynamicOptions,
        role: lease ? "join" : "host",
        room: CODE,
        namespace,
        maxPlayers,
        timeoutMs: ATTEMPT_TIMEOUT,
        relays,
        rtcConfig,
        resume: SCOPED_RESUME(CODE),
        signal: ATTEMPT_CONTROLLER.signal,
        onStatus,
        expectedSessionId: lease?.sessionId,
        authorizeJoin: (id) => {
          prune();
          return !!room && room.coordinatorId === room.localPlayerId && RESERVATIONS.has(id);
        },
        signalerFactory: async (options) => {
          const IDENTITY = options.identity ?? EPHEMERAL.identity;
          await openDirectory(IDENTITY);
          if (ATTEMPT_CONTROLLER.signal.aborted) {
            throw ERROR("PUBLIC_CLOSED", "public attempt aborted");
          }
          if (lease && !restoring) {
            await reserve(lease);
          }
          const VALUE = await signalerFactory({
            ...options,
            identity: SHARED(IDENTITY)
          });
          if (disposed) {
            VALUE?.close?.();
          }
          return VALUE;
        }
      })
    ).then((result2) => {
      if (disposed || cancelled) {
        result2?.close?.();
      }
      return result2;
    });
    let result;
    try {
      result = await bounded(PENDING, ATTEMPT_TIMEOUT, FAIL("public room connection attempt timeout"));
    } catch (cause) {
      cancelled = true;
      ATTEMPT_CONTROLLER.abort();
      CONTROLLER.signal.removeEventListener("abort", ABORT_ATTEMPT);
      throw cause;
    }
    if (disposed) {
      result?.close?.();
      throw FAIL();
    }
    room = result;
    if (lease && room.sessionId !== lease.sessionId || room.localPlayerId !== directoryId) {
      room.close();
      room = null;
      throw ERROR("PUBLIC_SCOPE", "public room identity/session mismatch");
    }
    return room;
  }
  try {
    await openDirectory(EPHEMERAL.identity);
    if (pointer) {
      STATUS("public-resuming", {
        room: pointer.room
      });
      await connect(pointer, true);
    } else {
      let lastError;
      const TRIED = /* @__PURE__ */ new Set();
      for (let attempt = 0; attempt < maxAttempts && !room; attempt++) {
        const AVAILABLE = await discover(), LEASE = AVAILABLE.find((value) => !TRIED.has(`${value.sessionId}:${value.epoch}`));
        if (!LEASE && AVAILABLE.length) {
          lastError ??= ERROR("PUBLIC_NO_ROOM", "available public rooms did not accept this connection");
          break;
        }
        if (!LEASE) {
          STATUS("public-hosting");
          await connect(null);
          break;
        }
        TRIED.add(`${LEASE.sessionId}:${LEASE.epoch}`);
        STATUS("public-joining", {
          room: LEASE.room,
          sessionId: LEASE.sessionId
        });
        try {
          await connect(LEASE);
        } catch (cause) {
          lastError = cause;
          await release();
          await openDirectory(EPHEMERAL.identity);
          STATUS("public-attempt-failed", {
            reason: cause.message
          });
        }
      }
      if (!room) {
        throw lastError ?? FAIL();
      }
    }
    await savePointer();
    removeRoom = room.subscribe((event) => {
      if (event.type === "peer-failed" || event.type === "peer-disconnected") {
        if (RESERVATIONS.delete(event.peerId)) {
          BACKGROUND(advertise());
        }
      }
      if (event.type === "room-closed") {
        close(event.reason);
      }
    });
    await bounded(advertise(), REMAINING(), FAIL());
    clearTimeout(setupTimer);
    interval = setInterval(
      () => {
        if (disposed) {
          return;
        }
        prune();
        if (Date.now() >= nextAdvertisement) {
          nextAdvertisement = Date.now() + Math.max(30, Math.floor(leaseMs / 3));
          BACKGROUND(advertise());
        }
      },
      Math.max(10, Math.min(1e3, Math.floor(leaseMs / 3)))
    );
    interval.unref?.();
    const CAPABILITY = {};
    for (const KEY of Object.keys(room)) {
      Object.defineProperty(CAPABILITY, KEY, {
        enumerable: true,
        configurable: true,
        get: () => room[KEY]
      });
    }
    Object.defineProperties(CAPABILITY, {
      close: {
        enumerable: true,
        configurable: true,
        value: close
      },
      setRoster: {
        enumerable: true,
        configurable: true,
        value(value) {
          room.setRoster(value);
          prune();
          savePointer(true)?.catch(WRITE_FAILED("pointer"));
          BACKGROUND(advertise());
        }
      },
      forgetResume: {
        enumerable: true,
        configurable: true,
        value() {
          resumeForgotten = true;
          room.forgetResume?.();
          if (resume) {
            writePointer(null).catch(WRITE_FAILED("pointer"));
          }
        }
      },
      publicMetrics: {
        enumerable: true,
        get: () => ({
          directoryEntries: DIRECTORY.size,
          pendingReservations: RESERVATIONS.size,
          pendingPublications: PUBLICATIONS.size
        })
      },
      subscribe: {
        enumerable: true,
        configurable: true,
        value(fn) {
          if (typeof fn !== "function" || disposed) {
            throw new TypeError("public room subscriber");
          }
          const REMOVE = room.subscribe(fn);
          OBSERVERS.add(fn);
          return () => {
            REMOVE();
            OBSERVERS.delete(fn);
          };
        }
      }
    });
    STATUS("public-room-ready", {
      room: room.room,
      sessionId: room.sessionId
    });
    return CAPABILITY;
  } catch (cause) {
    close(cause.message);
    throw cause;
  }
}
export {
  WebRTCTransport,
  createNostrDynamicRoom,
  createNostrGroupRoom,
  createNostrPublicRoom,
  createNostrRoom,
  createNostrSignaler,
  createWebRTCPeer,
  NOSTR_CRYPTO as nostrCrypto
};

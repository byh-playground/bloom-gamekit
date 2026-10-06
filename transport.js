// packages/deterministic/src/utilities.js
var nowMs = () => globalThis.performance?.now() ?? Date.now();
var compareIds = (a, b) => a < b ? -1 : a > b ? 1 : 0;
function integer(value, name, min = 0, max = 4294967295) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new RangeError(name);
  return value;
}
function bytes(value, name = "bytes") {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  throw new TypeError(`${name} must be Uint8Array or ArrayBuffer`);
}
function hashBytes(value, seed = 2166136261) {
  let h = seed >>> 0;
  for (const b of bytes(value)) h = Math.imul(h ^ b, 16777619) >>> 0;
  return h;
}
var signed = (x) => integer(x, "fixed-point result", -2147483648, 2147483647);
var fixedPoint = Object.freeze({
  scale: 1024,
  fromNumber: (x) => signed(Math.round(x * 1024)),
  toNumber: (x) => signed(x) / 1024,
  add: (a, b) => signed(signed(a) + signed(b)),
  sub: (a, b) => signed(signed(a) - signed(b)),
  mul: (a, b) => {
    signed(a);
    signed(b);
    const product = a * b;
    if (Number.isSafeInteger(product)) return signed(Math.trunc(product / 1024) || 0);
    return signed(Number(BigInt(a) * BigInt(b) / 1024n));
  },
  div: (a, b) => {
    if (signed(b) === 0) throw new RangeError("fixed-point division by zero");
    return signed(Number(BigInt(signed(a)) * 1024n / BigInt(b)));
  }
});

// packages/_rollback-shared/src/protocol.js
var PROTOCOL_VERSION = 1;
var CHUNK_SIZE = 16384;
var defaults = {
  mode: "rollback",
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
var profiles = Object.freeze({
  action: Object.freeze({ ...defaults }),
  rts: Object.freeze({
    ...defaults,
    tickRate: 20,
    baseInputDelayTicks: 4,
    maxInputDelayTicks: 12,
    rollbackWindowTicks: 6,
    stateHistorySize: 32,
    predictionPolicy: "neutral",
    checksumInterval: 20
  }),
  lockstep: Object.freeze({
    ...defaults,
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
var encoder = new TextEncoder();
var decoder = new TextDecoder("utf-8", { fatal: true });
var TYPE = Object.freeze({
  HELLO: 1,
  INPUT: 2,
  CLOCK: 3,
  HASH: 4,
  REQUEST: 5,
  BEGIN: 6,
  CHUNK: 7
});
var HEADER = 12;
var SNAP_CHUNK_BYTES = CHUNK_SIZE - HEADER - 8;

// packages/transport/src/webrtc.js
var WebRTCTransport = class {
  constructor({ inputChannel, controlChannel, highWaterMark = 262144, lowWaterMark = 65536 } = {}) {
    if (!controlChannel || typeof controlChannel.send !== "function") throw new TypeError("controlChannel");
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
      if (this.closed) return;
      let data = event.data;
      if (typeof Blob !== "undefined" && data instanceof Blob) {
        if (data.size > CHUNK_SIZE) return;
        data = await data.arrayBuffer();
      }
      if (this.closed) return;
      try {
        const b = bytes(data);
        if (b.length > CHUNK_SIZE) return;
        for (const listener of this.listeners) listener(b.slice());
      } catch {
      }
    };
    for (const channel of this.channels) {
      channel.binaryType = "arraybuffer";
      channel.bufferedAmountLowThreshold = lowWaterMark;
      channel.addEventListener("message", this._onMessage);
      channel.addEventListener("open", this._onStatus = this._onStatus ?? (() => this._notifyStatus()));
      channel.addEventListener("close", this._onStatus);
      channel.addEventListener("error", this._onChannelError = this._onChannelError ?? (() => {
        this.connectionState = "failed";
        this._notifyStatus();
      }));
    }
  }
  get state() {
    if (this.closed || this.connectionState === "closed" || this.channels.some((c) => c.readyState === "closed" || c.readyState === "closing")) return "closed";
    if (this.connectionState === "failed") return "failed";
    if (this.connectionState === "disconnected") return "interrupted";
    return this.channels.every((c) => c.readyState === "open") ? "open" : "connecting";
  }
  _notifyStatus() {
    const state = this.state;
    if (state === this._lastStatus) return;
    this._lastStatus = state;
    for (const listener of this.statusListeners) {
      try {
        listener(state);
      } catch {
      }
    }
  }
  setConnectionState(state) {
    this.connectionState = state;
    this._notifyStatus();
  }
  subscribeStatus(listener) {
    if (typeof listener !== "function") throw new TypeError("status subscriber");
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }
  get bufferedAmount() {
    return this.channels.reduce((n, c) => n + c.bufferedAmount, 0);
  }
  send(data) {
    const b = bytes(data);
    if (b.length > CHUNK_SIZE) throw new RangeError("DataChannel chunk size");
    const type = b.length >= HEADER ? b[5] : 0;
    const channel = type === TYPE.INPUT || type === TYPE.CLOCK ? this.inputChannel : this.controlChannel;
    if (this.closed || channel.readyState !== "open" || this.bufferedAmount + b.length > this.highWaterMark) return false;
    try {
      channel.send(b);
      return true;
    } catch (error2) {
      if (error2.name === "OperationError" || error2.name === "InvalidStateError") return false;
      throw error2;
    }
  }
  subscribe(handler) {
    if (this.closed || typeof handler !== "function") throw new TypeError("transport subscriber");
    this.listeners.add(handler);
    return () => this.listeners.delete(handler);
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this._notifyStatus();
    for (const channel of this.channels) {
      channel.removeEventListener("message", this._onMessage);
      channel.removeEventListener("open", this._onStatus);
      channel.removeEventListener("close", this._onStatus);
      channel.removeEventListener("error", this._onChannelError);
      channel.close();
    }
    this.listeners.clear();
    this.statusListeners.clear();
  }
};
var DEFAULT_ICE = Object.freeze([{ urls: "stun:stun.l.google.com:19302" }]);
function createWebRTCPeer({
  initiator = false,
  signaler,
  remoteId,
  rtcConfig = { iceServers: DEFAULT_ICE },
  timeoutMs = 2e4,
  RTCPeerConnectionImpl = globalThis.RTCPeerConnection,
  onStatus = () => {
  },
  signal
} = {}) {
  if (signal?.aborted) return Promise.reject(new Error("connection aborted"));
  if (typeof RTCPeerConnectionImpl !== "function" || typeof signaler?.send !== "function" || typeof signaler.subscribe !== "function" || !remoteId) return Promise.reject(new TypeError("WebRTC and Signaler capabilities required"));
  let pc;
  try {
    integer(timeoutMs, "timeoutMs", 1, 12e4);
    pc = new RTCPeerConnectionImpl(rtcConfig);
  } catch (error2) {
    return Promise.reject(error2);
  }
  let inputChannel, controlChannel, transport, unsubscribe, timer, disposed = false, settled = false;
  let chain = Promise.resolve();
  const earlyIce = [], iceBatch = [];
  let iceTimer;
  const status = (value) => {
    try {
      onStatus(value);
    } catch {
    }
  };
  let resolve, reject;
  const result = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  const close = () => {
    if (disposed) return;
    disposed = true;
    clearTimeout(timer);
    clearTimeout(iceTimer);
    unsubscribe?.();
    signal?.removeEventListener("abort", close);
    transport?.close();
    pc.close();
    if (!settled) {
      settled = true;
      reject(new Error("WebRTC connection closed"));
    }
  };
  const fail = (error2) => {
    status({ type: "connection-error", error: error2 });
    if (!settled) {
      settled = true;
      reject(error2);
    }
    close();
  };
  signal?.addEventListener("abort", close, { once: true });
  const send = (message) => Promise.resolve(signaler.send(remoteId, message));
  const maybeReady = () => {
    if (disposed || settled || inputChannel?.readyState !== "open" || controlChannel?.readyState !== "open") return;
    clearTimeout(timer);
    settled = true;
    transport = new WebRTCTransport({ inputChannel, controlChannel });
    status({ type: "connected" });
    resolve({ transport, peerConnection: pc, close });
  };
  const channel = (value) => {
    if (value.label === "inputs" && !inputChannel) inputChannel = value;
    else if (value.label === "control" && !controlChannel) controlChannel = value;
    else {
      value.close();
      return;
    }
    value.addEventListener("open", maybeReady);
    maybeReady();
  };
  pc.addEventListener("datachannel", (event) => channel(event.channel));
  const flushCandidates = () => {
    clearTimeout(iceTimer);
    if (disposed || !iceBatch.length) return;
    send({ type: "ice", candidates: iceBatch.splice(0) }).catch(fail);
  };
  pc.addEventListener("icecandidate", (event) => {
    if (disposed) return;
    if (event.candidate) {
      if (iceBatch.length >= 128) {
        fail(new RangeError("ICE candidate batch capacity"));
        return;
      }
      iceBatch.push(event.candidate.toJSON());
      clearTimeout(iceTimer);
      iceTimer = setTimeout(flushCandidates, 100);
    } else flushCandidates();
  });
  pc.addEventListener("connectionstatechange", () => {
    transport?.setConnectionState(pc.connectionState);
    status({ type: "connection-state", state: pc.connectionState });
    if (pc.connectionState === "failed") fail(new Error("P2P connection failed; no automatic TURN fallback"));
  });
  const flushIce = async () => {
    while (earlyIce.length) await pc.addIceCandidate(earlyIce.shift());
  };
  unsubscribe = signaler.subscribe((event) => {
    if (disposed || event.from !== remoteId || event.to !== signaler.id && event.to !== "*") return;
    const message = event.message;
    chain = chain.then(async () => {
      if (disposed) return;
      if (message?.type === "offer" && !initiator && !pc.remoteDescription) {
        await pc.setRemoteDescription(message.description);
        await flushIce();
        await pc.setLocalDescription(await pc.createAnswer());
        await send({ type: "answer", description: pc.localDescription.toJSON() });
      } else if (message?.type === "answer" && initiator && !pc.remoteDescription) {
        await pc.setRemoteDescription(message.description);
        await flushIce();
      } else if (message?.type === "ice") {
        const candidates = message.candidates ?? (message.candidate ? [message.candidate] : []);
        if (!Array.isArray(candidates) || candidates.length > 128) throw new RangeError("ICE candidate batch");
        for (const candidate of candidates) {
          if (pc.remoteDescription) await pc.addIceCandidate(candidate);
          else if (earlyIce.length < 128) earlyIce.push(candidate);
          else throw new RangeError("ICE queue capacity");
        }
      } else if (message?.type === "bye") close();
    }).catch(fail);
  });
  timer = setTimeout(() => fail(new Error("P2P connection timeout")), integer(timeoutMs, "timeoutMs", 1, 12e4));
  if (initiator) {
    channel(pc.createDataChannel("inputs", { ordered: false, maxRetransmits: 0 }));
    channel(pc.createDataChannel("control", { ordered: true }));
    chain = chain.then(async () => {
      await pc.setLocalDescription(await pc.createOffer());
      await send({ type: "offer", description: pc.localDescription.toJSON() });
    }).catch(fail);
  }
  return result;
}

// packages/transport/src/nostr-crypto.js
var nostrField = 0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2fn;
var nostrOrder = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
var nostrGenerator = [
  0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798n,
  0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8n,
  1n
];
var nostrInfinity = [0n, 1n, 0n];
var nostrEncoder = new TextEncoder();
function nostrMod(nostrValue, nostrModulus = nostrField) {
  const nostrRemainder = nostrValue % nostrModulus;
  return nostrRemainder < 0n ? nostrRemainder + nostrModulus : nostrRemainder;
}
function nostrPow(nostrBase, nostrExponent) {
  let nostrResult = 1n;
  nostrBase = nostrMod(nostrBase);
  while (nostrExponent > 0n) {
    if (nostrExponent & 1n) nostrResult = nostrMod(nostrResult * nostrBase);
    nostrBase = nostrMod(nostrBase * nostrBase);
    nostrExponent >>= 1n;
  }
  return nostrResult;
}
function nostrDouble(nostrPoint) {
  const [nostrX, nostrY, nostrZ] = nostrPoint;
  if (nostrZ === 0n || nostrY === 0n) return nostrInfinity;
  const nostrA = nostrMod(nostrX * nostrX);
  const nostrB = nostrMod(nostrY * nostrY);
  const nostrC = nostrMod(nostrB * nostrB);
  const nostrD = nostrMod(2n * (nostrMod((nostrX + nostrB) ** 2n) - nostrA - nostrC));
  const nostrE = nostrMod(3n * nostrA);
  const nostrNextX = nostrMod(nostrE * nostrE - 2n * nostrD);
  return [nostrNextX, nostrMod(nostrE * (nostrD - nostrNextX) - 8n * nostrC), nostrMod(2n * nostrY * nostrZ)];
}
function nostrAdd(nostrLeft, nostrRight) {
  if (nostrLeft[2] === 0n) return nostrRight;
  if (nostrRight[2] === 0n) return nostrLeft;
  const [nostrX1, nostrY1, nostrZ1] = nostrLeft;
  const [nostrX2, nostrY2, nostrZ2] = nostrRight;
  const nostrZ1Squared = nostrMod(nostrZ1 * nostrZ1);
  const nostrZ2Squared = nostrMod(nostrZ2 * nostrZ2);
  const nostrU1 = nostrMod(nostrX1 * nostrZ2Squared);
  const nostrU2 = nostrMod(nostrX2 * nostrZ1Squared);
  const nostrS1 = nostrMod(nostrY1 * nostrZ2Squared * nostrZ2);
  const nostrS2 = nostrMod(nostrY2 * nostrZ1Squared * nostrZ1);
  if (nostrU1 === nostrU2) return nostrS1 === nostrS2 ? nostrDouble(nostrLeft) : nostrInfinity;
  const nostrH = nostrMod(nostrU2 - nostrU1);
  const nostrI = nostrMod(4n * nostrH * nostrH);
  const nostrJ = nostrMod(nostrH * nostrI);
  const nostrR = nostrMod(2n * (nostrS2 - nostrS1));
  const nostrV = nostrMod(nostrU1 * nostrI);
  const nostrNextX = nostrMod(nostrR * nostrR - nostrJ - 2n * nostrV);
  return [
    nostrNextX,
    nostrMod(nostrR * (nostrV - nostrNextX) - 2n * nostrS1 * nostrJ),
    nostrMod(((nostrZ1 + nostrZ2) ** 2n - nostrZ1Squared - nostrZ2Squared) * nostrH)
  ];
}
function nostrMultiply(nostrScalar, nostrPoint = nostrGenerator) {
  let nostrResult = nostrInfinity;
  while (nostrScalar > 0n) {
    if (nostrScalar & 1n) nostrResult = nostrAdd(nostrResult, nostrPoint);
    nostrPoint = nostrDouble(nostrPoint);
    nostrScalar >>= 1n;
  }
  return nostrResult;
}
function nostrAffine(nostrPoint) {
  if (nostrPoint[2] === 0n) return null;
  const nostrInverse = nostrPow(nostrPoint[2], nostrField - 2n);
  const nostrInverseSquared = nostrMod(nostrInverse * nostrInverse);
  return [nostrMod(nostrPoint[0] * nostrInverseSquared), nostrMod(nostrPoint[1] * nostrInverseSquared * nostrInverse)];
}
function nostrLiftX(nostrX) {
  if (nostrX >= nostrField) return null;
  const nostrC = nostrMod(nostrX ** 3n + 7n);
  const nostrY = nostrPow(nostrC, (nostrField + 1n) / 4n);
  if (nostrMod(nostrY * nostrY) !== nostrC) return null;
  return [nostrX, nostrY & 1n ? nostrField - nostrY : nostrY, 1n];
}
function nostrRequireBytes(nostrValue, nostrLength, nostrName) {
  if (!(nostrValue instanceof Uint8Array) || nostrValue.length !== nostrLength) {
    throw new TypeError(`${nostrName} must be a ${nostrLength}-byte Uint8Array`);
  }
  return new Uint8Array(nostrValue);
}
function nostrBytesToNumber(nostrBytes) {
  let nostrValue = 0n;
  for (const nostrByte of nostrBytes) nostrValue = nostrValue << 8n | BigInt(nostrByte);
  return nostrValue;
}
function nostrNumberToBytes(nostrValue) {
  const nostrBytes = new Uint8Array(32);
  for (let nostrIndex = 31; nostrIndex >= 0; nostrIndex--) {
    nostrBytes[nostrIndex] = Number(nostrValue & 255n);
    nostrValue >>= 8n;
  }
  return nostrBytes;
}
function nostrToHex(nostrBytes) {
  return Array.from(nostrBytes, (nostrByte) => nostrByte.toString(16).padStart(2, "0")).join("");
}
function nostrFromHex(nostrHex) {
  return Uint8Array.from(nostrHex.match(/../g), (nostrByte) => parseInt(nostrByte, 16));
}
function nostrConcat(...nostrParts) {
  const nostrBytes = new Uint8Array(nostrParts.reduce((nostrSize, nostrPart) => nostrSize + nostrPart.length, 0));
  let nostrOffset = 0;
  for (const nostrPart of nostrParts) {
    nostrBytes.set(nostrPart, nostrOffset);
    nostrOffset += nostrPart.length;
  }
  return nostrBytes;
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
  const nostrTagHash = await nostrHash(nostrEncoder.encode(nostrTag), nostrCryptoImpl);
  return nostrHash(nostrConcat(nostrTagHash, nostrTagHash, nostrBytes), nostrCryptoImpl);
}
function nostrPublicKey(nostrSecret) {
  const nostrSecretCopy = nostrRequireBytes(nostrSecret, 32, "secret");
  try {
    const nostrScalar = nostrBytesToNumber(nostrSecretCopy);
    if (nostrScalar === 0n || nostrScalar >= nostrOrder) throw new RangeError("Invalid secp256k1 secret");
    return nostrNumberToBytes(nostrAffine(nostrMultiply(nostrScalar))[0]);
  } finally {
    nostrSecretCopy.fill(0);
  }
}
async function nostrVerify(nostrSignature, nostrMessage, nostrPublic, nostrCryptoImpl) {
  if (!(nostrSignature instanceof Uint8Array) || nostrSignature.length !== 64 || !(nostrMessage instanceof Uint8Array) || nostrMessage.length !== 32 || !(nostrPublic instanceof Uint8Array) || nostrPublic.length !== 32) return false;
  const nostrSignatureCopy = new Uint8Array(nostrSignature);
  const nostrMessageCopy = new Uint8Array(nostrMessage);
  const nostrPublicCopy = new Uint8Array(nostrPublic);
  const nostrPoint = nostrLiftX(nostrBytesToNumber(nostrPublicCopy));
  const nostrR = nostrBytesToNumber(nostrSignatureCopy.subarray(0, 32));
  const nostrS = nostrBytesToNumber(nostrSignatureCopy.subarray(32));
  if (!nostrPoint || nostrR >= nostrField || nostrS >= nostrOrder) return false;
  const nostrChallenge = nostrBytesToNumber(await nostrTaggedHash(
    "BIP0340/challenge",
    nostrConcat(nostrSignatureCopy.subarray(0, 32), nostrPublicCopy, nostrMessageCopy),
    nostrCryptoImpl
  )) % nostrOrder;
  const nostrResult = nostrAffine(nostrAdd(nostrMultiply(nostrS), nostrMultiply(
    nostrChallenge,
    [nostrPoint[0], nostrMod(-nostrPoint[1]), 1n]
  )));
  return nostrResult !== null && (nostrResult[1] & 1n) === 0n && nostrResult[0] === nostrR;
}
async function nostrSign(nostrMessage, nostrSecret, nostrAuxiliary, nostrCryptoImpl) {
  const nostrMessageCopy = nostrRequireBytes(nostrMessage, 32, "message");
  const nostrAuxiliaryCopy = nostrRequireBytes(nostrAuxiliary, 32, "auxiliary randomness");
  const nostrSecretCopy = nostrRequireBytes(nostrSecret, 32, "secret");
  let nostrMaskedSecret;
  try {
    const nostrScalar = nostrBytesToNumber(nostrSecretCopy);
    if (nostrScalar === 0n || nostrScalar >= nostrOrder) throw new RangeError("Invalid secp256k1 secret");
    const nostrPoint = nostrAffine(nostrMultiply(nostrScalar));
    const nostrNormalizedSecret = nostrPoint[1] & 1n ? nostrOrder - nostrScalar : nostrScalar;
    const nostrPublic = nostrNumberToBytes(nostrPoint[0]);
    const nostrAuxiliaryHash = await nostrTaggedHash("BIP0340/aux", nostrAuxiliaryCopy, nostrCryptoImpl);
    nostrMaskedSecret = nostrNumberToBytes(nostrNormalizedSecret);
    for (let nostrIndex = 0; nostrIndex < 32; nostrIndex++) nostrMaskedSecret[nostrIndex] ^= nostrAuxiliaryHash[nostrIndex];
    const nostrNonce = nostrBytesToNumber(await nostrTaggedHash(
      "BIP0340/nonce",
      nostrConcat(nostrMaskedSecret, nostrPublic, nostrMessageCopy),
      nostrCryptoImpl
    )) % nostrOrder;
    if (nostrNonce === 0n) throw new Error("BIP340 nonce generation failed");
    const nostrNoncePoint = nostrAffine(nostrMultiply(nostrNonce));
    const nostrNormalizedNonce = nostrNoncePoint[1] & 1n ? nostrOrder - nostrNonce : nostrNonce;
    const nostrR = nostrNumberToBytes(nostrNoncePoint[0]);
    const nostrChallenge = nostrBytesToNumber(await nostrTaggedHash(
      "BIP0340/challenge",
      nostrConcat(nostrR, nostrPublic, nostrMessageCopy),
      nostrCryptoImpl
    )) % nostrOrder;
    const nostrSignature = nostrConcat(nostrR, nostrNumberToBytes(nostrMod(nostrNormalizedNonce + nostrChallenge * nostrNormalizedSecret, nostrOrder)));
    if (!await nostrVerify(nostrSignature, nostrMessageCopy, nostrPublic, nostrCryptoImpl)) throw new Error("BIP340 signature self-check failed");
    return nostrSignature;
  } finally {
    nostrSecretCopy.fill(0);
    nostrAuxiliaryCopy.fill(0);
    nostrMaskedSecret?.fill(0);
  }
}
var nostrCrypto = Object.freeze({
  publicKey: nostrPublicKey,
  sign: (nostrMessage, nostrSecret, nostrAuxiliary) => nostrSign(nostrMessage, nostrSecret, nostrAuxiliary, globalThis.crypto),
  verify: (nostrSignature, nostrMessage, nostrPublic) => nostrVerify(nostrSignature, nostrMessage, nostrPublic, globalThis.crypto)
});

// packages/transport/src/nostr.js
var nostrHex32 = /^[0-9a-f]{64}$/;
var nostrHex64 = /^[0-9a-f]{128}$/;
var nostrSignalTypes = /* @__PURE__ */ new Set(["discover", "presence", "offer", "answer", "ice", "bye", "group"]);
var nostrContentLimit = 128 * 1024;
var nostrFreshSeconds = 120;
var nostrFutureSeconds = 30;
function nostrIsSignalMessage(nostrMessage) {
  return nostrMessage !== null && typeof nostrMessage === "object" && !Array.isArray(nostrMessage) && Object.prototype.hasOwnProperty.call(nostrMessage, "type") && nostrSignalTypes.has(nostrMessage.type);
}
function nostrListen(nostrSocket, nostrType, nostrHandler) {
  if (typeof nostrSocket.addEventListener === "function") {
    nostrSocket.addEventListener(nostrType, nostrHandler);
    return () => nostrSocket.removeEventListener(nostrType, nostrHandler);
  }
  const nostrProperty = `on${nostrType}`;
  nostrSocket[nostrProperty] = nostrHandler;
  return () => {
    if (nostrSocket[nostrProperty] === nostrHandler) nostrSocket[nostrProperty] = null;
  };
}
async function createNostrSignaler({
  room,
  namespace = "rollback-netcode",
  relays = ["wss://relay.primal.net", "wss://relay.damus.io"],
  timeoutMs = 1e4,
  onStatus = () => {
  },
  WebSocketImpl = globalThis.WebSocket,
  cryptoImpl = globalThis.crypto,
  signal,
  publishIntervalMs = 500,
  maxVerificationsPerSecond = 16,
  verificationBurst = 8,
  identity
} = {}) {
  if (signal?.aborted) throw new Error("Nostr signaler aborted");
  if (typeof room !== "string" || !/^\d{4}$/.test(room)) throw new TypeError("room must contain exactly four ASCII digits");
  if (typeof namespace !== "string" || namespace.trim().length === 0 || nostrEncoder.encode(namespace).length > 128) throw new TypeError("namespace must be a nonempty string of at most 128 UTF-8 bytes");
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 12e4) throw new RangeError("timeoutMs must be greater than zero and at most 120000");
  integer(publishIntervalMs, "publishIntervalMs", 0, 1e4);
  integer(maxVerificationsPerSecond, "maxVerificationsPerSecond", 1, 1024);
  integer(verificationBurst, "verificationBurst", 1, 32);
  if (typeof WebSocketImpl !== "function") throw new Error("Nostr signaling requires WebSocket support");
  if (typeof onStatus !== "function") throw new TypeError("onStatus must be a function");
  nostrRequireCrypto(cryptoImpl, true);
  if (!Array.isArray(relays) || relays.length === 0 || relays.length > 16) throw new TypeError("relays must contain between 1 and 16 WebSocket URLs");
  const nostrUrls = [...new Set(relays.map((nostrRelay) => {
    if (typeof nostrRelay !== "string") throw new TypeError("Relay URLs must be strings");
    const nostrUrl = new URL(nostrRelay);
    if (!["ws:", "wss:"].includes(nostrUrl.protocol) || nostrUrl.username || nostrUrl.password || nostrUrl.hash) throw new TypeError("Relays must be ws:// or wss:// URLs without credentials or fragments");
    return nostrUrl.href;
  }))];
  const nostrRandom = (nostrLength) => cryptoImpl.getRandomValues(new Uint8Array(nostrLength));
  if (identity && (!nostrHex32.test(identity.id) || typeof identity.sign !== "function" || typeof identity.close !== "function")) throw new TypeError("Nostr identity capability");
  const nostrSecret = new Uint8Array(32);
  let nostrSecretReady = !!identity;
  for (let nostrAttempt = 0; !nostrSecretReady && nostrAttempt < 16; nostrAttempt++) {
    nostrSecret.set(nostrRandom(32));
    const nostrValue = nostrBytesToNumber(nostrSecret);
    if (nostrValue > 0n && nostrValue < nostrOrder) {
      nostrSecretReady = true;
      break;
    }
  }
  if (!nostrSecretReady) {
    nostrSecret.fill(0);
    throw new Error("Secure random secret generation failed");
  }
  const nostrId = identity?.id ?? nostrToHex(nostrPublicKey(nostrSecret));
  const nostrRoomTag = `${namespace}:${room}`;
  const nostrSubscription = `rn-${nostrToHex(nostrRandom(16))}`;
  const nostrListeners = /* @__PURE__ */ new Set();
  const nostrBacklog = [];
  const nostrSeen = /* @__PURE__ */ new Map();
  const nostrVerifying = /* @__PURE__ */ new Set();
  const nostrPending = /* @__PURE__ */ new Map();
  const nostrStates = [];
  let verificationTokens = verificationBurst, verificationAt = nowMs();
  const verificationMetrics = { attempted: 0, verified: 0, throttled: 0, totalVerificationMs: 0, maxVerificationMs: 0 };
  let nostrClosed = false;
  let nostrSending = 0;
  let nostrSendTail = Promise.resolve(), nostrLastPublication = -Infinity;
  const nostrWaiters = /* @__PURE__ */ new Map();
  let nostrHasSubscriber = false;
  let nostrReadyResolve;
  let nostrReadyReject;
  let nostrInitializationSettled = false;
  const nostrReady = new Promise((nostrResolve, nostrReject) => {
    nostrReadyResolve = nostrResolve;
    nostrReadyReject = nostrReject;
  });
  const nostrStatus = (nostrStatusName, nostrRelay, nostrMessage) => {
    if (nostrClosed && nostrStatusName !== "closed") return;
    try {
      onStatus({ type: "signaler", transport: "nostr", status: nostrStatusName, ...nostrRelay ? { relay: nostrRelay } : {}, ...nostrMessage ? { message: String(nostrMessage) } : {} });
    } catch {
    }
  };
  function nostrFinishPublication(nostrEventId, nostrError) {
    const nostrPublication = nostrPending.get(nostrEventId);
    if (!nostrPublication) return;
    clearTimeout(nostrPublication.timer);
    nostrPending.delete(nostrEventId);
    if (nostrError) nostrPublication.reject(nostrError);
    else nostrPublication.resolve();
  }
  function nostrPublicationFailure(nostrState, nostrEventId, nostrReason) {
    const nostrPublication = nostrPending.get(nostrEventId);
    if (!nostrPublication || !nostrPublication.remaining.delete(nostrState)) return;
    nostrPublication.failures.push(`${nostrState.url}: ${nostrReason}`);
    if (nostrPublication.remaining.size === 0 && !nostrStates.some((nostrRelay) => !nostrRelay.failed && !nostrRelay.ready)) nostrFinishPublication(
      nostrEventId,
      new Error(`No Nostr relay accepted the event: ${nostrPublication.failures.join("; ")}`)
    );
  }
  function nostrFailRelay(nostrState, nostrReason) {
    if (nostrState.failed || nostrClosed) return;
    nostrState.failed = true;
    nostrState.ready = false;
    clearTimeout(nostrState.timer);
    for (const nostrRemove of nostrState.remove) nostrRemove();
    try {
      nostrState.socket?.close();
    } catch {
    }
    for (const nostrEventId of nostrPending.keys()) nostrPublicationFailure(nostrState, nostrEventId, nostrReason);
    nostrStatus("error", nostrState.url, nostrReason);
    if (!nostrInitializationSettled && nostrStates.length === nostrUrls.length && nostrStates.every((nostrRelay) => nostrRelay.failed)) {
      nostrInitializationSettled = true;
      nostrReadyReject(new Error(`No Nostr relay became ready: ${nostrReason}`));
    }
  }
  function nostrDeliver(nostrEnvelope) {
    if (nostrClosed) return;
    if (!nostrHasSubscriber) {
      if (nostrBacklog.length === 32) nostrBacklog.shift();
      nostrBacklog.push(nostrEnvelope);
      return;
    }
    for (const nostrHandler of [...nostrListeners]) {
      if (nostrClosed) break;
      try {
        const nostrResult = nostrHandler(nostrEnvelope);
        if (nostrResult && typeof nostrResult.then === "function") Promise.resolve(nostrResult).catch((nostrError) => nostrStatus("error", null, nostrError?.message || "Signaling subscriber failed"));
      } catch (nostrError) {
        nostrStatus("error", null, nostrError?.message || "Signaling subscriber failed");
      }
    }
  }
  async function nostrReceive(nostrEvent) {
    if (nostrClosed || !nostrEvent || typeof nostrEvent !== "object" || Array.isArray(nostrEvent) || typeof nostrEvent.id !== "string" || typeof nostrEvent.pubkey !== "string" || typeof nostrEvent.sig !== "string" || !nostrHex32.test(nostrEvent.id) || !nostrHex32.test(nostrEvent.pubkey) || !nostrHex64.test(nostrEvent.sig) || nostrEvent.pubkey === nostrId || nostrEvent.kind !== 20078 || !Number.isSafeInteger(nostrEvent.created_at) || typeof nostrEvent.content !== "string" || nostrEvent.content.length > nostrContentLimit || !Array.isArray(nostrEvent.tags) || nostrEvent.tags.length > 16 || nostrVerifying.size >= 32) return;
    const nostrNow = Date.now();
    const nostrNowSeconds = Math.floor(nostrNow / 1e3);
    if (nostrEvent.created_at < nostrNowSeconds - nostrFreshSeconds || nostrEvent.created_at > nostrNowSeconds + nostrFutureSeconds || nostrEncoder.encode(nostrEvent.content).length > nostrContentLimit) return;
    for (const [nostrSeenId, nostrExpiry] of nostrSeen) {
      if (nostrExpiry > nostrNow) break;
      nostrSeen.delete(nostrSeenId);
    }
    if (nostrSeen.has(nostrEvent.id) || nostrVerifying.has(nostrEvent.id)) return;
    if (!nostrEvent.tags.every((nostrTag) => Array.isArray(nostrTag) && nostrTag.length > 0 && nostrTag.length <= 4 && nostrTag.every((nostrValue) => typeof nostrValue === "string" && nostrEncoder.encode(nostrValue).length <= 256))) return;
    const nostrRoomTags = nostrEvent.tags.filter((nostrTag) => nostrTag[0] === "d");
    const nostrRecipientTags = nostrEvent.tags.filter((nostrTag) => nostrTag[0] === "p");
    if (nostrRoomTags.length !== 1 || nostrRoomTags[0][1] !== nostrRoomTag) return;
    let nostrContent;
    try {
      nostrContent = JSON.parse(nostrEvent.content);
    } catch {
      return;
    }
    if (!nostrContent || nostrContent.v !== 1 || nostrContent.namespace !== namespace || nostrContent.room !== room || nostrContent.from !== nostrEvent.pubkey || typeof nostrContent.nonce !== "string" || !/^[0-9a-f]{32}$/.test(nostrContent.nonce) || nostrContent.to !== "*" && nostrContent.to !== nostrId || !nostrIsSignalMessage(nostrContent.message)) return;
    if (nostrContent.to === "*" ? nostrRecipientTags.length !== 0 : nostrRecipientTags.length !== 1 || nostrRecipientTags[0][1] !== nostrContent.to) return;
    const measuredNow = nowMs();
    verificationTokens = Math.min(verificationBurst, verificationTokens + Math.max(0, measuredNow - verificationAt) * maxVerificationsPerSecond / 1e3);
    verificationAt = measuredNow;
    if (verificationTokens < 1) {
      verificationMetrics.throttled++;
      return;
    }
    verificationTokens--;
    verificationMetrics.attempted++;
    nostrVerifying.add(nostrEvent.id);
    try {
      const nostrHashBytes = await nostrHash(nostrEncoder.encode(JSON.stringify([0, nostrEvent.pubkey, nostrEvent.created_at, nostrEvent.kind, nostrEvent.tags, nostrEvent.content])), cryptoImpl);
      if (nostrToHex(nostrHashBytes) !== nostrEvent.id || !await nostrVerify(nostrFromHex(nostrEvent.sig), nostrHashBytes, nostrFromHex(nostrEvent.pubkey), cryptoImpl) || nostrClosed) return;
      if (nostrSeen.size >= 2048) nostrSeen.delete(nostrSeen.keys().next().value);
      nostrSeen.set(nostrEvent.id, nostrNow + 3e5);
      verificationMetrics.verified++;
      nostrDeliver({ from: nostrContent.from, to: nostrContent.to, message: nostrContent.message });
    } catch (nostrError) {
      nostrStatus("error", null, nostrError?.message || "Nostr verification failed");
    } finally {
      nostrVerifying.delete(nostrEvent.id);
      const elapsed = nowMs() - measuredNow;
      verificationMetrics.totalVerificationMs += elapsed;
      verificationMetrics.maxVerificationMs = Math.max(verificationMetrics.maxVerificationMs, elapsed);
    }
  }
  function nostrHandleMessage(nostrState, nostrData) {
    if (nostrClosed || nostrState.failed || typeof nostrData !== "string" || nostrData.length > 1024 * 1024) return;
    let nostrFrame;
    try {
      nostrFrame = JSON.parse(nostrData);
    } catch {
      return;
    }
    if (!Array.isArray(nostrFrame)) return;
    if (nostrFrame[0] === "EOSE" && nostrFrame.length === 2 && nostrFrame[1] === nostrSubscription && nostrState.requested) {
      if (nostrState.ready) return;
      nostrState.ready = true;
      clearTimeout(nostrState.timer);
      nostrStatus("connected", nostrState.url);
      if (!nostrInitializationSettled) {
        nostrInitializationSettled = true;
        nostrReadyResolve();
      }
      for (const nostrPublication of nostrPending.values()) if (!nostrPublication.attempted.has(nostrState)) {
        nostrPublication.attempted.add(nostrState);
        nostrPublication.remaining.add(nostrState);
        try {
          nostrState.socket.send(nostrPublication.frame);
        } catch (nostrError) {
          nostrFailRelay(nostrState, nostrError?.message || "Fallback publication failed");
        }
      }
    } else if (nostrFrame[0] === "EVENT" && nostrFrame.length === 3 && nostrFrame[1] === nostrSubscription && nostrState.requested) {
      void nostrReceive(nostrFrame[2]);
    } else if (nostrFrame[0] === "OK" && nostrFrame.length === 4 && typeof nostrFrame[1] === "string" && typeof nostrFrame[2] === "boolean" && typeof nostrFrame[3] === "string") {
      const nostrPublication = nostrPending.get(nostrFrame[1]);
      if (!nostrPublication?.remaining.has(nostrState)) return;
      if (nostrFrame[2]) {
        nostrFinishPublication(nostrFrame[1]);
        nostrStatus("published", nostrState.url);
      } else nostrFailRelay(nostrState, nostrFrame[3].slice(0, 256) || "Relay rejected the event");
    } else if (nostrFrame[0] === "CLOSED" && nostrFrame.length === 3 && nostrFrame[1] === nostrSubscription && typeof nostrFrame[2] === "string") {
      nostrFailRelay(nostrState, `Relay ended the signaling subscription: ${nostrFrame[2].slice(0, 256)}`);
    } else if (nostrFrame[0] === "NOTICE" && typeof nostrFrame[1] === "string") {
      nostrStatus("notice", nostrState.url, nostrFrame[1].slice(0, 256));
    }
  }
  function nostrClose() {
    if (nostrClosed) return;
    nostrClosed = true;
    signal?.removeEventListener("abort", nostrClose);
    for (const [nostrTimer, nostrReject] of nostrWaiters) {
      clearTimeout(nostrTimer);
      nostrReject(new Error("Nostr signaler closed"));
    }
    nostrWaiters.clear();
    for (const nostrState of nostrStates) {
      clearTimeout(nostrState.timer);
      if (nostrState.socket?.readyState === 1 && nostrState.requested) {
        try {
          nostrState.socket.send(JSON.stringify(["CLOSE", nostrSubscription]));
        } catch {
        }
      }
      for (const nostrRemove of nostrState.remove) nostrRemove();
      try {
        nostrState.socket?.close();
      } catch {
      }
      nostrState.ready = false;
    }
    for (const nostrEventId of nostrPending.keys()) nostrFinishPublication(nostrEventId, new Error("Nostr signaler closed"));
    if (!nostrInitializationSettled) {
      nostrInitializationSettled = true;
      nostrReadyReject(new Error("Nostr signaler closed"));
    }
    nostrSecret.fill(0);
    identity?.close();
    nostrListeners.clear();
    nostrBacklog.length = 0;
    nostrSeen.clear();
    nostrVerifying.clear();
    nostrStatus("closed");
  }
  signal?.addEventListener("abort", nostrClose, { once: true });
  for (const nostrUrl of nostrUrls) {
    if (nostrClosed) break;
    const nostrState = { url: nostrUrl, socket: null, ready: false, requested: false, failed: false, remove: [], timer: null };
    nostrStates.push(nostrState);
    nostrStatus("connecting", nostrUrl);
    if (nostrClosed) break;
    try {
      const nostrSocket = nostrState.socket = new WebSocketImpl(nostrUrl);
      if (nostrClosed) {
        try {
          nostrSocket.close();
        } catch {
        }
        break;
      }
      nostrState.timer = setTimeout(() => nostrFailRelay(nostrState, "Nostr connection/subscription timed out"), timeoutMs);
      const nostrOpen = () => {
        if (nostrClosed || nostrState.failed || nostrState.requested) return;
        nostrState.requested = true;
        try {
          nostrSocket.send(JSON.stringify(["REQ", nostrSubscription, { kinds: [20078], "#d": [nostrRoomTag], since: Math.floor(Date.now() / 1e3) - nostrFreshSeconds, limit: 0 }]));
        } catch (nostrError) {
          nostrFailRelay(nostrState, nostrError?.message || "Nostr subscription failed");
        }
      };
      nostrState.remove.push(
        nostrListen(nostrSocket, "open", nostrOpen),
        nostrListen(nostrSocket, "message", (nostrEvent) => nostrHandleMessage(nostrState, nostrEvent.data)),
        nostrListen(nostrSocket, "error", () => nostrFailRelay(nostrState, "Nostr WebSocket error")),
        nostrListen(nostrSocket, "close", () => nostrFailRelay(nostrState, "Nostr relay disconnected"))
      );
      if (nostrSocket.readyState === 1) nostrOpen();
    } catch (nostrError) {
      nostrFailRelay(nostrState, nostrError?.message || "Nostr connection failed");
    }
  }
  try {
    await nostrReady;
  } catch (nostrError) {
    nostrClose();
    throw nostrError;
  }
  return {
    id: nostrId,
    room,
    get metrics() {
      return { ...verificationMetrics };
    },
    async send(nostrTo, nostrMessage) {
      if (nostrClosed) throw new Error("Nostr signaler closed");
      if (nostrTo !== "*" && (typeof nostrTo !== "string" || !nostrHex32.test(nostrTo))) throw new TypeError("Nostr recipient must be a lowercase public key or *");
      if (!nostrIsSignalMessage(nostrMessage)) throw new TypeError("Nostr carries discovery, presence, offer, answer, ice, bye and group signaling only");
      if (nostrSending >= 64) throw new Error("Too many pending Nostr publications");
      if (!nostrStates.some((nostrState) => nostrState.ready && !nostrState.failed && nostrState.socket.readyState === 1)) throw new Error("No live Nostr relays");
      nostrSending++;
      const nostrPrevious = nostrSendTail;
      let nostrUnlock;
      nostrSendTail = new Promise((nostrResolve) => {
        nostrUnlock = nostrResolve;
      });
      try {
        let nostrContent;
        try {
          nostrContent = JSON.stringify({ v: 1, namespace, room, from: nostrId, to: nostrTo, nonce: nostrToHex(nostrRandom(16)), message: nostrMessage });
        } catch {
          throw new TypeError("Nostr signaling message must be JSON serializable");
        }
        if (nostrEncoder.encode(nostrContent).length > nostrContentLimit) throw new RangeError("Nostr signaling content exceeds 128 KiB");
        if (!nostrIsSignalMessage(JSON.parse(nostrContent).message)) throw new TypeError("Nostr signaling message serialization changed its type");
        await nostrPrevious;
        if (nostrClosed) throw new Error("Nostr signaler closed");
        const nostrWait = publishIntervalMs - (Date.now() - nostrLastPublication);
        if (nostrWait > 0) await new Promise((nostrResolve, nostrReject) => {
          const nostrTimer = setTimeout(() => {
            nostrWaiters.delete(nostrTimer);
            nostrResolve();
          }, nostrWait);
          nostrWaiters.set(nostrTimer, nostrReject);
        });
        if (nostrClosed) throw new Error("Nostr signaler closed");
        const nostrEvent = {
          pubkey: nostrId,
          created_at: Math.floor(Date.now() / 1e3),
          kind: 20078,
          tags: [["d", nostrRoomTag], ...nostrTo === "*" ? [] : [["p", nostrTo]]],
          content: nostrContent
        };
        const nostrHashBytes = await nostrHash(nostrEncoder.encode(JSON.stringify([0, nostrId, nostrEvent.created_at, nostrEvent.kind, nostrEvent.tags, nostrContent])), cryptoImpl);
        if (nostrClosed) throw new Error("Nostr signaler closed");
        const nostrAuxiliary = nostrRandom(32);
        try {
          nostrEvent.sig = nostrToHex(await (identity ? identity.sign(nostrHashBytes, nostrAuxiliary, cryptoImpl) : nostrSign(nostrHashBytes, nostrSecret, nostrAuxiliary, cryptoImpl)));
        } finally {
          nostrAuxiliary.fill(0);
        }
        nostrEvent.id = nostrToHex(nostrHashBytes);
        if (nostrClosed) throw new Error("Nostr signaler closed");
        const nostrAvailable = nostrStates.filter((nostrState) => nostrState.ready && !nostrState.failed && nostrState.socket.readyState === 1);
        if (nostrAvailable.length === 0) throw new Error("No live Nostr relays");
        const nostrFrame = JSON.stringify(["EVENT", nostrEvent]);
        nostrLastPublication = Date.now();
        await new Promise((nostrResolve, nostrReject) => {
          const nostrPublication = {
            resolve: nostrResolve,
            reject: nostrReject,
            remaining: new Set(nostrAvailable),
            attempted: new Set(nostrAvailable),
            frame: nostrFrame,
            failures: [],
            timer: null
          };
          nostrPending.set(nostrEvent.id, nostrPublication);
          nostrPublication.timer = setTimeout(() => nostrFinishPublication(nostrEvent.id, new Error("Nostr publication timed out without a positive relay OK")), timeoutMs);
          for (const nostrState of nostrAvailable) {
            if (nostrClosed) break;
            try {
              nostrState.socket.send(nostrFrame);
            } catch (nostrError) {
              nostrFailRelay(nostrState, nostrError?.message || "Nostr publication failed");
            }
          }
        });
      } finally {
        await nostrPrevious;
        nostrSending--;
        nostrUnlock();
      }
    },
    subscribe(nostrHandler) {
      if (nostrClosed) throw new Error("Nostr signaler closed");
      if (typeof nostrHandler !== "function") throw new TypeError("Signaling subscriber must be a function");
      nostrListeners.add(nostrHandler);
      if (!nostrHasSubscriber) {
        nostrHasSubscriber = true;
        const nostrQueued = nostrBacklog.splice(0);
        for (const nostrEnvelope of nostrQueued) nostrDeliver(nostrEnvelope);
      }
      return () => nostrListeners.delete(nostrHandler);
    },
    close: nostrClose
  };
}

// packages/transport/src/room.js
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
  if (!["host", "join"].includes(role)) throw new TypeError("room role");
  integer(timeoutMs, "timeoutMs", 1, 12e4);
  if (typeof signalerFactory !== "function" || typeof peerFactory !== "function") throw new TypeError("room adapter factories");
  if (signal?.aborted) throw new Error("room aborted");
  if (!room && role === "host") {
    const value = new Uint32Array(1);
    globalThis.crypto.getRandomValues(value);
    room = String(value[0] % 1e4).padStart(4, "0");
  }
  if (!/^\d{4}$/.test(room ?? "")) throw new TypeError("four-digit room");
  const controller = new AbortController();
  const externalAbort = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", externalAbort, { once: true });
  const roomSignal = controller.signal;
  let signaler;
  try {
    signaler = await signalerFactory({
      room,
      namespace,
      relays,
      timeoutMs: Math.min(timeoutMs, 1e4),
      onStatus,
      signal: roomSignal
    });
  } catch (error2) {
    signal?.removeEventListener("abort", externalAbort);
    throw error2;
  }
  if (roomSignal.aborted) {
    signaler.close();
    signal?.removeEventListener("abort", externalAbort);
    throw new Error("room aborted");
  }
  return new Promise((resolve, reject) => {
    let connection, unsubscribe, pulse, deadline, collisionTimer;
    let disposed = false, connecting = false, completed = false, selectedPeer, checking = role === "host";
    const nonce = new Uint8Array(16);
    globalThis.crypto.getRandomValues(nonce);
    let sessionId = [...nonce].map((n) => n.toString(16).padStart(2, "0")).join("");
    const status = (value) => {
      try {
        onStatus(value);
      } catch {
      }
    };
    const close = () => {
      if (disposed) return;
      disposed = true;
      clearInterval(pulse);
      clearTimeout(deadline);
      clearTimeout(collisionTimer);
      unsubscribe?.();
      roomSignal.removeEventListener("abort", abort);
      signal?.removeEventListener("abort", externalAbort);
      controller.abort();
      connection?.close();
      signaler.close();
    };
    const fail = (error2) => {
      if (!completed) {
        completed = true;
        reject(error2);
      }
      close();
    };
    const abort = () => fail(new Error("room aborted"));
    roomSignal.addEventListener("abort", abort, { once: true });
    const send = (to, message) => signaler.send(to, message).catch(fail);
    const presence = (to) => send(to, { type: "presence", room, namespace, host: signaler.id, sessionId, protocol: PROTOCOL_VERSION });
    const connect = (remoteId) => {
      if (connecting || disposed) return;
      connecting = true;
      selectedPeer = remoteId;
      Promise.resolve().then(() => peerFactory({
        initiator: role === "join",
        signaler,
        remoteId,
        rtcConfig,
        timeoutMs: Math.min(timeoutMs, 2e4),
        onStatus,
        signal: roomSignal
      })).then((value) => {
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
          close
        });
      }).catch(fail);
    };
    unsubscribe = signaler.subscribe(({ from, to, message }) => {
      if (disposed || from === signaler.id) return;
      if (role === "host") {
        if (message.type === "presence" && message.host === from && message.protocol === PROTOCOL_VERSION) {
          fail(new Error("room code is already in use; choose another four-digit code"));
          return;
        }
        if (message.type === "discover" && !checking && (!selectedPeer || selectedPeer === from)) {
          connect(from);
          presence(from);
        }
      } else if (message.type === "presence" && message.host === from && message.protocol === PROTOCOL_VERSION && typeof message.sessionId === "string") {
        if (selectedPeer && selectedPeer !== from) return;
        selectedPeer = from;
        if (to === signaler.id) {
          sessionId = message.sessionId;
          connect(from);
        } else send(from, { type: "discover" });
      }
    });
    if (disposed) {
      unsubscribe?.();
      return;
    }
    deadline = setTimeout(() => fail(new Error("room discovery timeout")), timeoutMs);
    const advertise = () => {
      if (disposed || connecting || checking) return;
      if (role === "host") presence("*");
      else send(selectedPeer ?? "*", { type: "discover" });
    };
    pulse = setInterval(advertise, 1e3);
    status({ type: "room", room, role });
    if (disposed) return;
    if (checking) collisionTimer = setTimeout(() => {
      checking = false;
      advertise();
    }, 1200);
    else advertise();
  });
}

// packages/transport/src/star-transport.js
var starHeader = 24;
var starPayload = CHUNK_SIZE - starHeader;
var starMagic = 827544658;
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
  if (!Array.isArray(players) || players.length < 2 || players.length > 8 || new Set(players).size !== players.length || !players.includes(localPlayerId) || !players.includes(hostPlayerId) || typeof sessionId !== "string" || !(physicalTransports instanceof Map) || typeof onError !== "function") throw new TypeError("star transport configuration");
  integer(maxQueuedBytes, "star queue budget", CHUNK_SIZE * 2, 64 * 1024 * 1024);
  const local = players.indexOf(localPlayerId), host = players.indexOf(hostPlayerId), isHost = local === host;
  const required = isHost ? players.filter((id) => id !== localPlayerId) : [hostPlayerId];
  if (required.some((id) => !physicalTransports.get(id)?.subscribe || !physicalTransports.get(id)?.send)) throw new TypeError("missing star physical transport");
  const tag = hashBytes(new TextEncoder().encode(sessionId)), listeners = /* @__PURE__ */ new Map(), statusListeners = /* @__PURE__ */ new Map();
  const queues = new Map(required.map((id) => [id, []])), assemblies = /* @__PURE__ */ new Map(), completed = /* @__PURE__ */ new Map();
  const unsubs = [], stats = { sentFrames: 0, forwardedFrames: 0, rejectedFrames: 0, queuedBytes: 0, queuedFrames: 0, assemblyBytes: 0 };
  let closed = false, sequence = 0, pumping = false;
  function reject() {
    stats.rejectedFrames++;
  }
  function close() {
    if (closed) return;
    closed = true;
    clearInterval(timer);
    for (const remove of unsubs.splice(0)) remove();
    queues.forEach((q) => q.length = 0);
    assemblies.clear();
    completed.clear();
    stats.queuedBytes = 0;
    stats.queuedFrames = 0;
    stats.assemblyBytes = 0;
    for (const set of statusListeners.values()) for (const fn of set) {
      try {
        fn("closed");
      } catch {
      }
    }
    listeners.clear();
    statusListeners.clear();
  }
  function fail(message) {
    if (closed) return;
    close();
    try {
      onError(new Error(message));
    } catch {
    }
  }
  function pump() {
    if (closed || pumping) return;
    pumping = true;
    try {
      const now = nowMs();
      for (const [id, q] of queues) {
        let work = 0;
        while (q.length && work++ < 128 && !closed) {
          if (now - q[0].at > 1e4) {
            fail("star forwarding backpressure timeout");
            break;
          }
          if (physicalTransports.get(id).send(q[0].bytes) === false) break;
          stats.queuedBytes -= q.shift().bytes.length;
          stats.queuedFrames--;
          stats.sentFrames++;
        }
      }
      for (const [key, a] of assemblies) if (now - a.at > 2e3) {
        assemblies.delete(key);
        stats.assemblyBytes -= a.total;
      }
    } catch (error2) {
      fail("star forwarding failed: " + error2.message);
    } finally {
      pumping = false;
    }
  }
  function enqueue(id, frames, forwarded) {
    const size = frames.reduce((n, b) => n + b.length, 0), q = queues.get(id);
    if (closed || !q || physicalTransports.get(id).state && physicalTransports.get(id).state !== "open") return false;
    if (stats.queuedBytes + size > maxQueuedBytes || stats.queuedFrames + frames.length > 4096) {
      if (forwarded) fail("star forwarding queue capacity");
      return false;
    }
    const at = nowMs();
    for (const b of frames) q.push({ bytes: b.slice(), at });
    stats.queuedBytes += size;
    stats.queuedFrames += frames.length;
    if (forwarded) stats.forwardedFrames += frames.length;
    pump();
    return !closed;
  }
  function deliver(from, id, payload, lane) {
    const actualLane = payload.length > 5 && [TYPE.INPUT, TYPE.CLOCK].includes(payload[5]) ? payload[5] : 1;
    if (actualLane !== lane) {
      reject();
      return;
    }
    let seen = completed.get(from);
    if (!seen) completed.set(from, seen = /* @__PURE__ */ new Set());
    if (seen.has(id)) return;
    seen.add(id);
    if (seen.size > 256) seen.delete(seen.values().next().value);
    const target = listeners.get(players[from]);
    if (target?.size) for (const fn of target) fn(payload.slice());
  }
  function receive(physicalId, data) {
    if (closed) return;
    let b;
    try {
      b = bytes(data);
    } catch {
      reject();
      return;
    }
    if (b.length < starHeader || b.length > CHUNK_SIZE) {
      reject();
      return;
    }
    const v = new DataView(b.buffer, b.byteOffset, b.byteLength), from = b[6], to = b[7], lane = b[5];
    const id = v.getUint32(12, true), total = v.getUint16(16, true), offset = v.getUint16(18, true), length = v.getUint16(20, true);
    if (v.getUint32(0, true) !== starMagic || b[4] !== 1 || v.getUint32(8, true) !== tag || v.getUint16(22, true) !== 0 || ![1, TYPE.INPUT, TYPE.CLOCK].includes(lane) || from >= players.length || to >= players.length || from === to || from === local || !id || !total || total > CHUNK_SIZE || ![0, starPayload].includes(offset) || offset >= total || length !== Math.min(starPayload, total - offset) || b.length !== starHeader + length || (isHost ? players[from] !== physicalId : physicalId !== hostPlayerId || to !== local)) {
      reject();
      return;
    }
    if (to !== local) {
      if (!isHost || !enqueue(players[to], [b], true)) {
        if (!closed) fail("star destination is not available");
      }
      return;
    }
    if (completed.get(from)?.has(id)) return;
    if (total <= starPayload) {
      deliver(from, id, b.slice(starHeader), lane);
      return;
    }
    const key = from + ":" + id;
    let a = assemblies.get(key);
    if (!a) {
      if (assemblies.size >= 32 || stats.assemblyBytes + total > 512 * 1024) {
        reject();
        return;
      }
      a = { total, lane, bytes: new Uint8Array(total), seen: /* @__PURE__ */ new Set(), at: nowMs() };
      assemblies.set(key, a);
      stats.assemblyBytes += total;
    }
    if (a.total !== total || a.lane !== lane) {
      reject();
      return;
    }
    if (a.seen.has(offset)) {
      for (let i = 0; i < length; i++) if (a.bytes[offset + i] !== b[starHeader + i]) {
        reject();
        return;
      }
      return;
    }
    a.bytes.set(b.subarray(starHeader), offset);
    a.seen.add(offset);
    if (a.seen.size === 2) {
      assemblies.delete(key);
      stats.assemblyBytes -= total;
      deliver(from, id, a.bytes, lane);
    }
  }
  const timer = setInterval(pump, 16);
  timer.unref?.();
  const transports = /* @__PURE__ */ new Map();
  for (const remote of players.filter((id) => id !== localPlayerId)) {
    listeners.set(remote, /* @__PURE__ */ new Set());
    statusListeners.set(remote, /* @__PURE__ */ new Set());
    const physical = isHost ? remote : hostPlayerId;
    transports.set(remote, {
      get state() {
        return closed ? "closed" : physicalTransports.get(physical).state ?? "open";
      },
      send(data) {
        if (closed) return false;
        const payload = bytes(data);
        if (!payload.length || payload.length > CHUNK_SIZE) throw new RangeError("star packet size");
        sequence = sequence + 1 >>> 0 || 1;
        const id = sequence, frames = [];
        const lane = payload.length > 5 && [TYPE.INPUT, TYPE.CLOCK].includes(payload[5]) ? payload[5] : 1;
        for (let offset = 0; offset < payload.length; offset += starPayload) {
          const length = Math.min(starPayload, payload.length - offset), b = new Uint8Array(starHeader + length), v = new DataView(b.buffer);
          v.setUint32(0, starMagic, true);
          b[4] = 1;
          b[5] = lane;
          b[6] = local;
          b[7] = players.indexOf(remote);
          v.setUint32(8, tag, true);
          v.setUint32(12, id, true);
          v.setUint16(16, payload.length, true);
          v.setUint16(18, offset, true);
          v.setUint16(20, length, true);
          b.set(payload.subarray(offset, offset + length), starHeader);
          frames.push(b);
        }
        return enqueue(physical, frames, false);
      },
      subscribe(fn) {
        if (closed || typeof fn !== "function") throw new TypeError("star subscriber");
        const set = listeners.get(remote);
        set.add(fn);
        return () => set.delete(fn);
      },
      subscribeStatus(fn) {
        if (closed || typeof fn !== "function") throw new TypeError("star status subscriber");
        const set = statusListeners.get(remote);
        set.add(fn);
        return () => set.delete(fn);
      },
      close() {
        listeners.get(remote)?.clear();
        statusListeners.get(remote)?.clear();
      }
    });
  }
  try {
    for (const id of required) {
      const raw = physicalTransports.get(id);
      unsubs.push(raw.subscribe((data) => receive(id, data)));
      if (raw.subscribeStatus) unsubs.push(raw.subscribeStatus((state) => {
        for (const [remote, set] of statusListeners) if (!isHost || remote === id) for (const fn of set) {
          try {
            fn(state);
          } catch {
          }
        }
      }));
    }
  } catch (error2) {
    close();
    throw error2;
  }
  return { transports, close, get metrics() {
    return { ...stats };
  } };
}

// packages/transport/src/group-room.js
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
  if (!["host", "join"].includes(role) || !["mesh", "star"].includes(topology)) throw new TypeError("group room role/topology");
  integer(playerCount, "playerCount", 2, 8);
  integer(timeoutMs, "timeoutMs", 1, 12e4);
  if (typeof namespace !== "string" || !namespace.trim() || new TextEncoder().encode(namespace + ":group-v1").length > 128) throw new TypeError("group namespace");
  if ([onStatus, signalerFactory, peerFactory].some((fn) => typeof fn !== "function")) throw new TypeError("group room capability");
  if (signal?.aborted) throw new Error("group room aborted");
  const random = () => [...globalThis.crypto.getRandomValues(new Uint8Array(16))].map((v) => v.toString(16).padStart(2, "0")).join("");
  if (!room && role === "host") room = String(globalThis.crypto.getRandomValues(new Uint32Array(1))[0] % 1e4).padStart(4, "0");
  if (!/^\d{4}$/.test(room ?? "")) throw new TypeError("four-digit room");
  const peerController = new AbortController(), signalController = new AbortController(), startedAt = nowMs();
  const earlyAbort = () => {
    peerController.abort();
    signalController.abort();
  };
  signal?.addEventListener("abort", earlyAbort, { once: true });
  let signaler;
  try {
    signaler = await signalerFactory({
      room,
      namespace: namespace + ":group-v1",
      relays,
      signal: signalController.signal,
      timeoutMs: Math.min(timeoutMs, 1e4),
      onStatus,
      maxVerificationsPerSecond: Math.max(16, playerCount * 4),
      verificationBurst: playerCount * 4
    });
    if (!groupRoomId(signaler?.id) || typeof signaler.send !== "function" || typeof signaler.subscribe !== "function" || typeof signaler.close !== "function") throw new TypeError("group signaler capability");
    if (signal?.aborted || signalController.signal.aborted) throw new Error("group room aborted");
  } catch (error2) {
    earlyAbort();
    signaler?.close?.();
    signal?.removeEventListener("abort", earlyAbort);
    throw error2;
  }
  signal?.removeEventListener("abort", earlyAbort);
  return new Promise((resolve, reject) => {
    const self = signaler.id, members = /* @__PURE__ */ new Set([self]), departed = /* @__PURE__ */ new Set(), acks = /* @__PURE__ */ new Set([self]), ready = /* @__PURE__ */ new Set(), starts = /* @__PURE__ */ new Set([self]);
    const peers = /* @__PURE__ */ new Map(), subscribers = /* @__PURE__ */ new Map(), backlog = /* @__PURE__ */ new Map(), controlPending = /* @__PURE__ */ new Map(), removers = [];
    let host = role === "host" ? self : null, sessionId = role === "host" ? random() : null, roster2 = null, rosterKey = "";
    let phase = role === "host" ? "checking" : "discovering", disposed = false, settled = false, connecting = false, localReady = false;
    let unsubscribe, interval, collisionTimer, deadline, router, backlogBytes = 0, startPublished = false;
    const status = (type, detail = {}) => {
      try {
        onStatus({ type, room, role, playerCount, topology, phase, ...detail });
      } catch {
      }
    };
    function message(op, extra = {}) {
      return { type: "group", version: 1, protocol: PROTOCOL_VERSION, op, host, sessionId, playerCount, topology, ...extra };
    }
    function dispose(reason, notify = true) {
      if (disposed) return;
      disposed = true;
      clearInterval(interval);
      clearTimeout(collisionTimer);
      clearTimeout(deadline);
      unsubscribe?.();
      signal?.removeEventListener("abort", abort);
      peerController.abort();
      removers.splice(0).forEach((fn) => fn());
      router?.close();
      peers.forEach((p) => p.close());
      peers.clear();
      subscribers.clear();
      backlog.clear();
      backlogBytes = 0;
      const finish2 = () => {
        signalController.abort();
        signaler.close();
      };
      if (notify && host && sessionId) {
        const grace = setTimeout(finish2, 1500);
        grace.unref?.();
        Promise.resolve().then(() => signaler.send(role === "host" ? "*" : host, message("leave", { reason }))).catch(() => {
        }).finally(() => {
          clearTimeout(grace);
          finish2();
        });
      } else finish2();
    }
    function fail(error2, notify = true) {
      if (disposed) return;
      const value = error2 instanceof Error ? error2 : new Error(String(error2));
      const former = phase;
      phase = "failed";
      dispose(value.message, notify);
      status("group-failed", { reason: value.message, previousPhase: former });
      if (!settled) {
        settled = true;
        reject(value);
      }
    }
    function abort() {
      fail(new Error("group room aborted"));
    }
    function send(to, op, extra = {}) {
      if (disposed) return Promise.resolve();
      const key = to + ":" + op;
      if (controlPending.has(key)) return controlPending.get(key);
      if (controlPending.size >= 32) return Promise.resolve();
      const pending = Promise.resolve().then(() => {
        if (!disposed) return signaler.send(to, message(op, extra));
      }).catch((error2) => {
        fail(error2);
      }).finally(() => controlPending.delete(key));
      controlPending.set(key, pending);
      return pending;
    }
    function close() {
      if (disposed) return;
      const pending = !settled;
      phase = "closed";
      dispose("room closed");
      status("group-closed");
      if (pending) {
        settled = true;
        reject(new Error("group room closed"));
      }
    }
    function finish() {
      if (disposed || settled || !localReady) return;
      settled = true;
      phase = "running";
      clearTimeout(deadline);
      clearInterval(interval);
      const physical = new Map([...peers].map(([id, peer]) => [id, peer.transport]));
      status("group-started", { players: [...roster2], localPlayerId: self });
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
        localPlayerId: self,
        authorityPlayerId: host,
        hostPlayerId: host,
        transports: new Map(router?.transports ?? physical),
        peerConnections: new Map([...peers].map(([id, peer]) => [id, peer.peerConnection])),
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
      if (disposed || role !== "host" || !roster2) return;
      if (phase === "roster" && acks.size === playerCount) {
        phase = "connecting";
        connect();
        send("*", "connect", { rosterKey });
      }
      if (phase === "connecting" && ready.size === playerCount) {
        phase = "starting";
        send("*", "start", { rosterKey }).then(() => {
          startPublished = true;
          hostProgress();
        });
      }
      if (phase === "starting" && startPublished && starts.size === playerCount) finish();
    }
    function wantedPeers() {
      return roster2.filter((id) => id !== self && (topology === "mesh" || self === host || id === host));
    }
    function scopedSignaler(remote) {
      return {
        id: self,
        send(to, payload) {
          if (disposed || to !== remote) return Promise.reject(new Error("group peer scope"));
          return signaler.send(to, { ...payload, groupSession: sessionId });
        },
        subscribe(fn) {
          const set = subscribers.get(remote) ?? /* @__PURE__ */ new Set();
          subscribers.set(remote, set);
          set.add(fn);
          const queued = backlog.get(remote) ?? [];
          backlog.delete(remote);
          for (const item of queued) {
            backlogBytes -= item.size;
            if (!disposed) fn(item.envelope);
          }
          return () => set.delete(fn);
        },
        close() {
        }
      };
    }
    function connect() {
      if (disposed || connecting || !roster2) return;
      connecting = true;
      phase = "connecting";
      status("group-connecting", { players: [...roster2] });
      if (disposed) return;
      Promise.all(wantedPeers().map((remote) => Promise.resolve().then(() => {
        if (disposed) throw new Error("group room closed");
        return peerFactory({
          initiator: compareIds(self, remote) > 0,
          signaler: scopedSignaler(remote),
          remoteId: remote,
          rtcConfig,
          timeoutMs: Math.min(timeoutMs, 3e4),
          onStatus: (event) => status("group-peer", { peerId: remote, event }),
          signal: peerController.signal
        });
      }).then((peer) => {
        if (disposed) {
          peer.close();
          return;
        }
        if (!peer?.transport?.send || !peer.transport.subscribe || typeof peer.close !== "function") throw new TypeError("group peer capability");
        peers.set(remote, peer);
        if (peer.transport.subscribeStatus) removers.push(peer.transport.subscribeStatus((state) => {
          if (!disposed && (state === "closed" || state === "failed" || !settled && state === "interrupted")) fail(new Error("group peer unavailable: " + remote));
        }));
      }))).then(() => {
        if (disposed) return;
        if ([...peers.values()].some((p) => p.transport.state && p.transport.state !== "open")) throw new Error("group transport not open");
        if (topology === "star") router = createStarTransports({
          players: roster2,
          localPlayerId: self,
          hostPlayerId: host,
          sessionId,
          physicalTransports: new Map([...peers].map(([id, p]) => [id, p.transport])),
          onError: fail
        });
        localReady = true;
        status("group-ready", { players: [...roster2] });
        if (disposed) return;
        if (role === "host") {
          ready.add(self);
          hostProgress();
        } else send(host, "ready", { rosterKey });
      }).catch(fail);
    }
    function publishRoster() {
      send("*", "roster", { players: roster2, rosterKey });
    }
    function advertise(to = "*") {
      send(to, "hello", { accepting: phase === "collecting", memberCount: members.size });
    }
    function acceptRoster(from, m) {
      if (from !== host || !Array.isArray(m.players) || m.players.length !== playerCount || m.players.some((id) => !groupRoomId(id)) || new Set(m.players).size !== playerCount || !m.players.includes(self) || !m.players.includes(host) || m.players.join("\n") !== [...m.players].sort(compareIds).join("\n") || m.rosterKey !== m.players.join("\n")) {
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
        status("group-roster", { players: [...roster2] });
      }
      send(host, "ack", { rosterKey });
    }
    function receive(envelope) {
      if (disposed || !envelope || envelope.from === self || !groupRoomId(envelope.from) || !["*", self].includes(envelope.to) || !envelope.message || typeof envelope.message !== "object") return;
      const { from, to, message: m } = envelope;
      if (["offer", "answer", "ice", "bye"].includes(m.type)) {
        if (!roster2 || to !== self || m.groupSession !== sessionId || !wantedPeers().includes(from)) return;
        const set = subscribers.get(from);
        if (set?.size) {
          for (const fn of set) fn(envelope);
          return;
        }
        const size = encoder.encode(JSON.stringify(m)).length, queued = backlog.get(from) ?? [];
        if (queued.length >= 32 || backlogBytes + size > 2 * 1024 * 1024) {
          fail(new Error("group signaling backlog capacity"));
          return;
        }
        queued.push({ envelope, size });
        backlog.set(from, queued);
        backlogBytes += size;
        return;
      }
      if (m.type !== "group" || m.version !== 1 || m.protocol !== PROTOCOL_VERSION) return;
      if (role === "host" && m.op === "hello" && m.host === from) {
        if (["checking", "collecting"].includes(phase)) fail(new Error("room code is already in use"));
        else if (m.accepting !== false) advertise(from);
        return;
      }
      if (role === "join" && m.op === "hello" && m.host === from && groupRoomId(m.sessionId)) {
        if (host && (host !== from || sessionId !== m.sessionId)) return;
        if (m.playerCount !== playerCount || m.topology !== topology) {
          fail(new Error("group playerCount/topology mismatch"), false);
          return;
        }
        const selected = !!host;
        if (!host) {
          host = from;
          sessionId = m.sessionId;
        }
        if (!roster2) {
          if (m.accepting === false && !selected) {
            fail(new Error("group room is full or already started"), false);
            return;
          }
          send(host, "join");
        }
        return;
      }
      if (role === "host" && m.op === "discover") {
        if (phase !== "checking") advertise(from);
        return;
      }
      if (m.host !== host || m.sessionId !== sessionId || m.playerCount !== playerCount || m.topology !== topology) return;
      if (role === "host") {
        if (m.op === "join") {
          if (members.has(from)) {
            if (roster2) publishRoster();
            return;
          }
          if (phase !== "collecting" || departed.has(from)) {
            send(from, "reject", { reason: "group room is full or already started" });
            return;
          }
          members.add(from);
          status("group-members", { players: [...members].sort(compareIds) });
          if (disposed) return;
          if (members.size === playerCount) {
            roster2 = Object.freeze([...members].sort(compareIds));
            rosterKey = roster2.join("\n");
            phase = "roster";
            status("group-roster", { players: [...roster2] });
            publishRoster();
          }
        } else if (m.op === "leave" && members.has(from)) {
          if (phase === "collecting") {
            members.delete(from);
            departed.add(from);
            if (departed.size > 64) fail(new Error("group membership churn limit"));
            else status("group-members", { players: [...members].sort(compareIds) });
          } else fail(new Error("group participant left"));
        } else if (roster2?.includes(from) && m.rosterKey === rosterKey) {
          if (m.op === "ack") acks.add(from);
          if (m.op === "ready" && ["connecting", "starting"].includes(phase)) ready.add(from);
          if (m.op === "start-ack" && phase === "starting") starts.add(from);
          hostProgress();
        }
      } else if (from === host) {
        if (m.op === "reject") fail(new Error(String(m.reason || "group rejected")), false);
        else if (m.op === "leave") fail(new Error("group host left"), false);
        else if (m.op === "roster") acceptRoster(from, m);
        else if (roster2 && m.rosterKey === rosterKey) {
          if (m.op === "connect") {
            connect();
            if (localReady) send(host, "ready", { rosterKey });
          }
          if (m.op === "start" && localReady) send(host, "start-ack", { rosterKey }).then(finish);
        }
      }
    }
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) {
      abort();
      return;
    }
    unsubscribe = signaler.subscribe(receive);
    if (disposed) {
      unsubscribe?.();
      return;
    }
    const remaining = timeoutMs - (nowMs() - startedAt);
    if (remaining <= 0) {
      fail(new Error("group room timeout"));
      return;
    }
    deadline = setTimeout(() => fail(new Error("group room timeout: " + phase)), remaining);
    interval = setInterval(() => {
      if (disposed) return;
      if (role === "host") {
        if (phase === "collecting") advertise();
        else if (phase === "roster") publishRoster();
        else if (phase === "connecting") send("*", "connect", { rosterKey });
        else if (phase === "starting") send("*", "start", { rosterKey }).then(() => {
          startPublished = true;
          hostProgress();
        });
      } else if (!host) send("*", "discover");
      else if (!roster2) send(host, "join");
      else if (!connecting) send(host, "ack", { rosterKey });
      else if (localReady) send(host, "ready", { rosterKey });
    }, 1e3);
    status("room");
    if (disposed) return;
    if (role === "host") collisionTimer = setTimeout(() => {
      if (!disposed) {
        phase = "collecting";
        advertise();
      }
    }, 1200);
    else send("*", "discover");
  });
}

// packages/transport/src/room-resume-identity.js
var hex32 = /^[0-9a-f]{64}$/;
function createRoomResumeIdentity({ storage, key, lifetimeMs = 8 * 60 * 60 * 1e3, reset = false } = {}, { namespace, room }) {
  if (!storage || ["getItem", "setItem", "removeItem"].some((name) => typeof storage[name] !== "function")) throw new TypeError("resume storage capability");
  integer(lifetimeMs, "resume lifetimeMs", 1e3, 24 * 60 * 60 * 1e3);
  key ??= `bloom-gamekit:dynamic-v1:${namespace}:${room}`;
  if (typeof key !== "string" || !key.length || key.length > 512) throw new TypeError("resume storage key");
  if (typeof reset !== "boolean") throw new TypeError("resume reset");
  if (reset) storage.removeItem(key);
  let saved, secret, forgotten = false, closed = false;
  const raw = storage.getItem(key), now = Date.now();
  if (raw != null) {
    let expired = false;
    try {
      if (typeof raw !== "string" || raw.length > 8192) throw new Error("invalid record");
      saved = JSON.parse(raw);
      expired = Number.isSafeInteger(saved?.expiresAt) && saved.expiresAt <= now;
      if (saved.version !== 1 || saved.namespace !== namespace || saved.room !== room || !hex32.test(saved.secret) || !Number.isSafeInteger(saved.createdAt) || !Number.isSafeInteger(saved.expiresAt) || saved.createdAt > now || saved.expiresAt <= now || saved.expiresAt - saved.createdAt > 24 * 60 * 60 * 1e3 || saved.sessionId !== null && (typeof saved.sessionId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(saved.sessionId)) || !Array.isArray(saved.players) || saved.players.length > 5 || saved.players.some((id2) => !hex32.test(id2)) || new Set(saved.players).size !== saved.players.length || !Number.isSafeInteger(saved.epoch) || saved.epoch < 0 || saved.epoch > 65534 || saved.coordinatorId !== null && !saved.players.includes(saved.coordinatorId)) throw new Error("invalid record");
      secret = nostrFromHex(saved.secret);
      const scalar = nostrBytesToNumber(secret);
      if (scalar <= 0n || scalar >= nostrOrder || nostrToHex(nostrPublicKey(secret)) !== saved.id) throw new Error("invalid key");
    } catch {
      secret?.fill(0);
      throw new Error(expired ? "resume record expired; explicitly reset for a fresh room" : "invalid resume record; explicitly reset for a fresh room");
    }
  }
  if (!secret) {
    secret = new Uint8Array(32);
    let valid = false;
    for (let attempt = 0; attempt < 16; attempt++) {
      globalThis.crypto.getRandomValues(secret);
      const value = nostrBytesToNumber(secret);
      if (value > 0n && value < nostrOrder) {
        valid = true;
        break;
      }
    }
    if (!valid) {
      secret.fill(0);
      throw new Error("resume identity generation failed");
    }
  }
  const id = nostrToHex(nostrPublicKey(secret));
  let record = saved ?? {
    version: 1,
    namespace,
    room,
    id,
    secret: nostrToHex(secret),
    createdAt: now,
    expiresAt: now + lifetimeMs,
    sessionId: null,
    coordinatorId: null,
    epoch: 0,
    players: []
  };
  const metadata = saved ? { sessionId: saved.sessionId, coordinatorId: saved.coordinatorId, epoch: saved.epoch, players: [...saved.players] } : null;
  function write() {
    if (forgotten || closed) return;
    try {
      storage.setItem(key, JSON.stringify(record));
    } catch {
      secret.fill(0);
      closed = true;
      throw new Error("resume storage unavailable");
    }
  }
  write();
  return {
    metadata,
    identity: {
      id,
      sign(hash, auxiliary, cryptoImpl) {
        if (closed) throw new Error("resume identity closed");
        return nostrSign(hash, secret, auxiliary, cryptoImpl);
      },
      close() {
        if (closed) return;
        closed = true;
        secret.fill(0);
        record = null;
      }
    },
    update(value) {
      if (!forgotten && !closed) {
        record = { ...record, ...value, players: [...value.players] };
        write();
      }
    },
    forget() {
      storage.removeItem(key);
      forgotten = true;
    }
  };
}

// packages/transport/src/dynamic-room.js
var validId = (value) => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
var signalTypes = /* @__PURE__ */ new Set(["offer", "answer", "ice", "bye"]);
var PROBE_MAGIC = new Uint8Array([66, 77, 68, 89, 78, 80, 82, 49]);
var MAX_SIGNAL_BYTES = 128 * 1024;
var MAX_BACKLOG_BYTES = 2 * 1024 * 1024;
var randomId = () => [...globalThis.crypto.getRandomValues(new Uint8Array(16))].map((n) => n.toString(16).padStart(2, "0")).join("");
function roster(value, maxPlayers) {
  if (!Array.isArray(value) || value.length < 1 || value.length > maxPlayers || value.some((id) => !validId(id)) || new Set(value).size !== value.length) throw new TypeError("dynamic room players");
  return Object.freeze([...value].sort(compareIds));
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
  if (!["host", "join"].includes(role)) throw new TypeError("dynamic room role");
  integer(maxPlayers, "maxPlayers", 1, 5);
  integer(maxPendingPeers, "maxPendingPeers", 1, 5);
  integer(timeoutMs, "timeoutMs", 1, 12e4);
  integer(peerTimeoutMs, "peerTimeoutMs", 1, 12e4);
  integer(resumeProbeMs, "resumeProbeMs", 10, 1e4);
  integer(retryMs, "retryMs", 10, 1e4);
  integer(advertiseIntervalMs, "advertiseIntervalMs", 10, 12e4);
  if (typeof namespace !== "string" || !namespace.trim() || encoder.encode(namespace + ":dynamic-v1").length > 128) throw new TypeError("dynamic room namespace");
  if (expectedSessionId !== void 0 && (!validId(expectedSessionId) || expectedSessionId.length > 116)) throw new TypeError("expectedSessionId");
  if ([onStatus, signalerFactory, peerFactory, authorizeJoin].some((fn) => typeof fn !== "function")) throw new TypeError("dynamic room capability");
  if (signal?.aborted) throw new Error("dynamic room aborted");
  if (!room && role === "host") room = String(globalThis.crypto.getRandomValues(new Uint32Array(1))[0] % 1e4).padStart(4, "0");
  if (!/^\d{4}$/.test(room ?? "")) throw new TypeError("four-digit room");
  const resumeIdentity = resume ? createRoomResumeIdentity(resume, { namespace, room }) : null;
  const startedAt = nowMs(), signalController = new AbortController();
  let initializationReject;
  const initializationFailure = new Promise((resolve, reject) => {
    initializationReject = reject;
  });
  const initializationTimer = setTimeout(() => {
    signalController.abort();
    initializationReject(new Error("dynamic room signaling timeout"));
  }, timeoutMs);
  const earlyAbort = () => {
    signalController.abort();
    initializationReject(new Error("dynamic room aborted"));
  };
  signal?.addEventListener("abort", earlyAbort, { once: true });
  let signaler;
  try {
    const setup = Promise.resolve().then(() => signalerFactory({
      room,
      namespace: namespace + ":dynamic-v1",
      relays,
      signal: signalController.signal,
      timeoutMs: Math.min(timeoutMs, 1e4),
      onStatus,
      maxVerificationsPerSecond: 32,
      verificationBurst: 20,
      identity: resumeIdentity?.identity
    })).then((value) => {
      if (signalController.signal.aborted) value?.close?.();
      return value;
    });
    signaler = await Promise.race([setup, initializationFailure]);
    if (!validId(signaler?.id) || ["send", "subscribe", "close"].some((key) => typeof signaler?.[key] !== "function")) throw new TypeError("dynamic signaler capability");
    if (signal?.aborted || signalController.signal.aborted) throw new Error("dynamic room aborted");
  } catch (error2) {
    signalController.abort();
    signaler?.close?.();
    resumeIdentity?.identity.close();
    throw error2;
  } finally {
    clearTimeout(initializationTimer);
    signal?.removeEventListener("abort", earlyAbort);
  }
  if (resumeIdentity && signaler.id !== resumeIdentity.identity.id) {
    signaler.close();
    resumeIdentity.identity.close();
    throw new Error("resume signaler identity mismatch");
  }
  const self = signaler.id, incarnation = randomId(), transports = /* @__PURE__ */ new Map(), peerConnections = /* @__PURE__ */ new Map(), listeners = /* @__PURE__ */ new Set();
  const links = /* @__PURE__ */ new Map(), generations = /* @__PURE__ */ new Map(), candidates = /* @__PURE__ */ new Map(), backlog = /* @__PURE__ */ new Map(), publications = /* @__PURE__ */ new Map();
  const saved = resumeIdentity?.metadata, resumed = !!(saved?.sessionId && saved.players.includes(self));
  if (saved?.sessionId && expectedSessionId !== void 0 && expectedSessionId !== saved.sessionId) {
    signaler.close();
    resumeIdentity.identity.close();
    throw new Error("resume session does not match expectedSessionId; explicitly reset");
  }
  const resumeTargets = new Set(resumed ? saved.players : []);
  const establishing = role === "join" || resumed, incarnations = /* @__PURE__ */ new Map([[self, incarnation]]), resumeApproved = /* @__PURE__ */ new Set(), resumeChecks = /* @__PURE__ */ new Map();
  let resumePeerId = null;
  let players = Object.freeze(resumed ? [...saved.players] : role === "host" ? [self] : []);
  let coordinatorId = resumed ? saved.coordinatorId : role === "host" ? self : null;
  let sessionId = resumed ? saved.sessionId : role === "host" ? randomId() : null;
  let epoch = resumed ? saved.epoch : 0, meshPlayers = new Set(players), meshUntil = resumed ? Infinity : 0;
  let hasBeenAdmitted = players.includes(self);
  let disposed = false, settled = false, backlogBytes = 0, unsubscribe, interval, deadline, invitation, nextAdvertisement = 0;
  let readyResolve, readyReject;
  const ready = new Promise((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  const status = (type, detail = {}) => {
    const event = { type, room, role, ...detail };
    try {
      onStatus(event);
    } catch {
    }
    for (const fn of [...listeners]) {
      try {
        fn(event);
      } catch {
      }
    }
  };
  const pendingCount = () => [...links.values()].filter((link) => !link.peer).length;
  const accepted = (id) => players.includes(id) || meshPlayers.has(id) && meshUntil > nowMs() || candidates.has(id);
  const leader = (id) => compareIds(self, id) > 0;
  const control = (op, extra = {}) => ({
    type: "group",
    mode: "dynamic",
    version: 1,
    protocol: PROTOCOL_VERSION,
    op,
    sessionId,
    coordinatorId,
    epoch,
    incarnation,
    ...extra
  });
  function publish(to, payload, key = to + ":" + payload.op) {
    if (disposed) return Promise.reject(new Error("dynamic room closed"));
    if (publications.has(key)) return publications.get(key);
    if (publications.size >= 32) return Promise.reject(new Error("dynamic signaling publication capacity"));
    const promise = Promise.resolve().then(() => {
      if (disposed) throw new Error("dynamic room closed");
      return signaler.send(to, payload);
    }).finally(() => {
      if (publications.get(key) === promise) publications.delete(key);
    });
    publications.set(key, promise);
    return promise;
  }
  function send(to, op, extra = {}) {
    const promise = publish(to, control(op, { targetIncarnation: incarnations.get(to), ...extra }));
    promise.catch((error2) => {
      if (!disposed) status("signal-error", { peerId: to, reason: error2.message });
    });
    return promise;
  }
  function forgetBacklog(key) {
    const queued = backlog.get(key);
    if (!queued) return;
    for (const item of queued.items) backlogBytes -= item.size;
    backlog.delete(key);
  }
  function rememberGeneration(id, generation) {
    generations.delete(id);
    generations.set(id, generation);
    for (const old of generations.keys()) {
      if (generations.size <= 64) break;
      if (!links.has(old) && !accepted(old)) generations.delete(old);
    }
  }
  function destroyLink(link, reason, notify = true, preserveWaiter = false) {
    if (links.get(link.id) !== link) return;
    links.delete(link.id);
    clearTimeout(link.deadline);
    link.removeStatus?.();
    link.removeRaw?.();
    link.cancelProbe?.();
    link.controller.abort();
    const wasConnected = transports.delete(link.id);
    peerConnections.delete(link.id);
    link.peer?.close();
    link.subscribers.clear();
    link.outbound.clear();
    if (!preserveWaiter) link.reject(new Error(reason));
    if (wasConnected && notify && !disposed) status("peer-disconnected", { peerId: link.id, reason });
  }
  function finish() {
    if (disposed || settled) return;
    settled = true;
    clearTimeout(deadline);
    readyResolve(capability);
  }
  function close(reason = "dynamic room closed") {
    if (disposed) return;
    disposed = true;
    clearInterval(interval);
    clearTimeout(deadline);
    unsubscribe?.();
    signal?.removeEventListener("abort", abort);
    for (const link of [...links.values()]) destroyLink(link, reason, false);
    signalController.abort();
    signaler.close();
    resumeIdentity?.identity.close();
    backlog.clear();
    backlogBytes = 0;
    candidates.clear();
    publications.clear();
    if (!settled) {
      settled = true;
      readyReject(new Error(reason));
    }
    status("room-closed", { reason });
    listeners.clear();
  }
  function abort() {
    close("dynamic room aborted");
  }
  function failLink(link, error2) {
    if (disposed || links.get(link.id) !== link) return;
    destroyLink(link, error2.message || String(error2));
    status("peer-failed", { peerId: link.id, reason: error2.message || String(error2) });
  }
  function newLink(id, generation, connectionId, prior) {
    if (!prior && (pendingCount() >= maxPendingPeers || links.size >= maxPlayers - 1 + maxPendingPeers)) throw new Error("dynamic pending peer capacity");
    let resolve, reject, promise;
    if (prior && !prior.peer) ({ resolve, reject, promise } = prior);
    else {
      promise = new Promise((yes, no) => {
        resolve = yes;
        reject = no;
      });
      promise.catch(() => {
      });
    }
    if (prior) destroyLink(prior, "peer reconnecting", true, !prior.peer);
    const link = {
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
      requestGeneration: generations.get(id) ?? 0,
      force: false
    };
    links.set(id, link);
    link.deadline = setTimeout(() => failLink(link, new Error("dynamic peer timeout")), peerTimeoutMs);
    return link;
  }
  function scopedSignaler(link) {
    return {
      id: self,
      close() {
      },
      send(to, payload) {
        if (disposed || links.get(link.id) !== link || to !== link.id || !signalTypes.has(payload?.type)) return Promise.reject(new Error("dynamic peer scope"));
        const message = { ...payload, dynamicSession: sessionId, dynamicGeneration: link.generation, dynamicConnection: link.connectionId, dynamicFrom: incarnation, dynamicTo: incarnations.get(to) };
        if (encoder.encode(JSON.stringify(message)).length > MAX_SIGNAL_BYTES) return Promise.reject(new RangeError("dynamic signaling message capacity"));
        if (payload.type === "offer" || payload.type === "answer") link.outbound.set(payload.type, message);
        return Promise.resolve(link.announcement).then(() => {
          if (disposed || links.get(link.id) !== link) throw new Error("dynamic peer scope");
          return publish(to, message, `${to}:signal:${link.generation}:${payload.type}`);
        });
      },
      subscribe(fn) {
        if (typeof fn !== "function") throw new TypeError("dynamic signaling subscriber");
        link.subscribers.add(fn);
        const key = `${link.id}:${link.generation}:${link.connectionId}`, queued = backlog.get(key);
        if (queued) {
          const items = queued.items.slice();
          forgetBacklog(key);
          for (const item of items) if (!disposed) fn(item.envelope);
        }
        return () => link.subscribers.delete(fn);
      }
    };
  }
  function saveResume() {
    if (!resumeIdentity || !sessionId) return;
    if (hasBeenAdmitted && !players.includes(self)) {
      resumeIdentity.forget();
      return;
    }
    if (players.includes(self)) hasBeenAdmitted = true;
    resumeIdentity.update({ sessionId, coordinatorId, epoch, players });
  }
  function acceptIncarnations(value, next) {
    if (!value || typeof value !== "object") return;
    for (const id of next) if (id !== self && validId(value[id])) {
      if (!links.get(id)?.peer || !incarnations.has(id)) incarnations.set(id, value[id]);
    }
  }
  function wrapTransport(link, raw) {
    const handlers = /* @__PURE__ */ new Set();
    link.removeRaw = raw.subscribe((bytes2) => {
      if (bytes2.length === 25 && PROBE_MAGIC.every((value, i) => bytes2[i] === value)) {
        if (bytes2[8] === 1) {
          const reply = bytes2.slice();
          reply[8] = 2;
          raw.send(reply);
        } else if (bytes2[8] === 2) link.onPong?.(bytes2.subarray(9));
        return;
      }
      for (const fn of [...handlers]) fn(bytes2);
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
        if (typeof fn !== "function") throw new TypeError("dynamic transport subscriber");
        handlers.add(fn);
        return () => handlers.delete(fn);
      },
      subscribeStatus: (fn) => raw.subscribeStatus?.(fn) ?? (() => {
      })
    };
  }
  function probePeer(link) {
    if (!link?.peer || link.peer.transport.state && link.peer.transport.state !== "open") return Promise.resolve(false);
    return new Promise((resolve) => {
      const bytes2 = new Uint8Array(25);
      bytes2.set(PROBE_MAGIC);
      bytes2[8] = 1;
      const nonce = globalThis.crypto.getRandomValues(new Uint8Array(16));
      bytes2.set(nonce, 9);
      let done = false, timer;
      const finish2 = (alive) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        link.onPong = null;
        link.cancelProbe = null;
        resolve(alive);
      };
      link.onPong = (response) => {
        if (nonce.every((value, i) => response[i] === value)) finish2(true);
      };
      link.cancelProbe = () => finish2(false);
      timer = setTimeout(() => finish2(false), resumeProbeMs);
      if (!link.peer.transport.send(bytes2)) finish2(true);
    });
  }
  function approveResume(id, requestedIncarnation) {
    if (incarnations.get(id) === requestedIncarnation) {
      send(id, "resume-accept", { generation: links.get(id)?.connectionId ? links.get(id).generation : (generations.get(id) ?? 0) + 1 });
      return;
    }
    if (resumeChecks.has(id)) return;
    const existing = links.get(id);
    const check = probePeer(existing).then((alive) => {
      if (disposed) return;
      if (alive) {
        send(id, "resume-reject", { targetIncarnation: requestedIncarnation });
        return;
      }
      if (existing && links.get(id) === existing) destroyLink(existing, "peer resuming");
      incarnations.set(id, requestedIncarnation);
      const generation = (generations.get(id) ?? 0) + 1;
      send(id, "resume-accept", { generation, targetIncarnation: requestedIncarnation });
      status("peer-resuming", { peerId: id });
      if (leader(id)) {
        try {
          startGeneration(id, generation);
        } catch {
        }
      }
    }).finally(() => resumeChecks.delete(id));
    resumeChecks.set(id, check);
  }
  function startPeer(link) {
    if (disposed || link.started || links.get(link.id) !== link) return;
    link.started = true;
    Promise.resolve().then(() => {
      if (disposed || links.get(link.id) !== link) throw new Error("dynamic peer superseded");
      return peerFactory({
        initiator: leader(link.id),
        signaler: scopedSignaler(link),
        remoteId: link.id,
        rtcConfig,
        timeoutMs: peerTimeoutMs,
        signal: link.controller.signal,
        onStatus: (event) => status("peer-status", { peerId: link.id, event })
      });
    }).then((peer) => {
      if (disposed || links.get(link.id) !== link) {
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
      const transport = wrapTransport(link, peer.transport);
      transports.set(link.id, transport);
      peerConnections.set(link.id, peer.peerConnection);
      if (peer.transport.subscribeStatus) link.removeStatus = peer.transport.subscribeStatus((state) => {
        if (state === "closed" || state === "failed" || state === "interrupted") failLink(link, new Error("dynamic peer " + state));
      });
      link.resolve(transport);
      status("peer-connected", { peerId: link.id, transport, generation: link.generation });
      if (!disposed && establishing && (link.id === coordinatorId || resumed && coordinatorId === self)) {
        resumePeerId ??= link.id;
        finish();
      }
    }).catch((error2) => failLink(link, error2));
  }
  function announceLink(link) {
    return send(link.id, "link", { generation: link.generation, connectionId: link.connectionId });
  }
  function startGeneration(id, generation) {
    const link = newLink(id, generation, randomId(), links.get(id));
    rememberGeneration(id, generation);
    link.announcement = announceLink(link);
    link.announcement.catch((error2) => failLink(link, error2));
    startPeer(link);
    return link;
  }
  function ensurePeer(id, force = false) {
    if (disposed) return Promise.reject(new Error("dynamic room closed"));
    if (!validId(id) || id === self || !accepted(id)) return Promise.reject(new Error("dynamic peer is not invited"));
    const old = links.get(id);
    if (resumed && resumeTargets.has(id) && !resumeApproved.has(id)) {
      try {
        const waiting = old ?? newLink(id, 0, null);
        waiting.resuming = true;
        send(id, "resume-request", { resumeSession: sessionId });
        return waiting.promise;
      } catch (error2) {
        return Promise.reject(error2);
      }
    }
    if (!incarnations.has(id)) {
      try {
        const waiting = old ?? newLink(id, 0, null);
        waiting.waitingIncarnation = true;
        return waiting.promise;
      } catch (error2) {
        return Promise.reject(error2);
      }
    }
    if (old && !old.waitingIncarnation && (!force || !old.peer)) return old.promise;
    try {
      if (leader(id)) return startGeneration(id, (generations.get(id) ?? 0) + 1).promise;
      const link = newLink(id, 0, null, old);
      link.force = force;
      send(id, "request", { generation: link.requestGeneration, reconnect: force });
      return link.promise;
    } catch (error2) {
      return Promise.reject(error2);
    }
  }
  function advertise(to = "*") {
    if (coordinatorId !== self || resumed && !settled) return;
    send(to, "hello", { players, maxPlayers, accepting: players.length < maxPlayers });
  }
  function inviteMesh(value) {
    const next = roster(value, maxPlayers);
    if (!next.includes(self) || !next.includes(coordinatorId)) throw new TypeError("dynamic mesh requires local player and coordinator");
    meshPlayers = new Set(next);
    meshUntil = nowMs() + peerTimeoutMs;
    if (coordinatorId === self) {
      invitation = { players: next, until: meshUntil };
      send("*", "mesh", { players: next, peerIncarnations: Object.fromEntries(incarnations) });
    }
    return next;
  }
  function setRoster(value) {
    if (disposed) throw new Error("dynamic room closed");
    const next = roster(value?.players, maxPlayers), nextEpoch = integer(value?.epoch, "epoch", 0, 65534);
    if (!validId(value?.coordinatorId) || !next.includes(value.coordinatorId)) throw new TypeError("dynamic roster coordinator");
    if (nextEpoch < epoch) throw new Error("stale dynamic room epoch");
    if (nextEpoch === epoch && (players.join("\n") !== next.join("\n") || coordinatorId !== value.coordinatorId)) throw new Error("conflicting dynamic room epoch");
    players = next;
    epoch = nextEpoch;
    coordinatorId = value.coordinatorId;
    meshPlayers = new Set(next);
    meshUntil = Infinity;
    invitation = null;
    for (const id of candidates.keys()) if (next.includes(id)) candidates.delete(id);
    for (const id of incarnations.keys()) if (id !== self && !next.includes(id) && !links.has(id) && !candidates.has(id)) incarnations.delete(id);
    saveResume();
    if (coordinatorId === self) advertise();
  }
  const capability = {
    room,
    role,
    maxPlayers,
    resumed,
    get resumePeerId() {
      return resumePeerId;
    },
    localPlayerId: self,
    transports,
    peerConnections,
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
      return !players.includes(self);
    },
    get closed() {
      return disposed;
    },
    get metrics() {
      return { activePeerCount: transports.size, pendingPeerCount: pendingCount(), signalBacklogBytes: backlogBytes };
    },
    subscribe(fn) {
      if (disposed || typeof fn !== "function") throw new TypeError("dynamic room subscriber");
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    setRoster,
    connectMesh(value) {
      try {
        if (disposed) throw new Error("dynamic room closed");
        const next = inviteMesh(value);
        return Promise.all(next.filter((id) => id !== self).map((id) => ensurePeer(id))).then(() => void 0);
      } catch (error2) {
        return Promise.reject(error2);
      }
    },
    reconnect(id) {
      return ensurePeer(id, true);
    },
    forgetResume() {
      resumeIdentity?.forget();
    },
    disconnect(id) {
      if (!validId(id) || id === self) throw new TypeError("dynamic peer id");
      const link = links.get(id);
      if (link) destroyLink(link, "peer disconnected by owner");
      candidates.delete(id);
      meshPlayers.delete(id);
      if (!players.includes(id)) incarnations.delete(id);
      for (const key of backlog.keys()) if (key.startsWith(id + ":")) forgetBacklog(key);
      return !!link;
    },
    close
  };
  function routeSignal(envelope) {
    const { from, to, message: m } = envelope;
    if (to !== self || m.dynamicSession !== sessionId || m.dynamicTo !== incarnation || m.dynamicFrom !== incarnations.get(from) || !accepted(from) || !Number.isSafeInteger(m.dynamicGeneration) || m.dynamicGeneration < 1 || !validId(m.dynamicConnection)) return;
    let size;
    try {
      size = encoder.encode(JSON.stringify(m)).length;
    } catch {
      return;
    }
    if (size > MAX_SIGNAL_BYTES) return;
    const link = links.get(from);
    if (link?.generation === m.dynamicGeneration && link.connectionId === m.dynamicConnection && link.subscribers.size) {
      for (const fn of [...link.subscribers]) fn(envelope);
      return;
    }
    const known = generations.get(from) ?? 0;
    if (leader(from) || m.dynamicGeneration < known || m.dynamicGeneration === known && (!link || link.generation !== m.dynamicGeneration || link.connectionId !== m.dynamicConnection)) return;
    const key = `${from}:${m.dynamicGeneration}:${m.dynamicConnection}`;
    const queued = backlog.get(key) ?? { items: [], until: nowMs() + peerTimeoutMs };
    if (queued.items.length >= 32 || !backlog.has(key) && backlog.size >= maxPendingPeers || backlogBytes + size > MAX_BACKLOG_BYTES) return;
    queued.items.push({ envelope, size });
    backlogBytes += size;
    backlog.set(key, queued);
  }
  function receive(envelope) {
    if (disposed || !envelope || !validId(envelope.from) || envelope.from === self || !["*", self].includes(envelope.to) || !envelope.message || typeof envelope.message !== "object") return;
    const { from, message: m } = envelope;
    if (signalTypes.has(m.type)) {
      routeSignal(envelope);
      return;
    }
    if (m.type !== "group" || m.mode !== "dynamic" || m.version !== 1 || m.protocol !== PROTOCOL_VERSION) return;
    if (m.targetIncarnation && m.targetIncarnation !== incarnation) return;
    if (m.op === "discover") {
      if (m.resumeSession === sessionId && players.includes(from) && validId(m.incarnation)) {
        send(from, "resume-hello", { targetIncarnation: m.incarnation, players, peerIncarnations: Object.fromEntries(incarnations) });
      } else advertise(from);
      return;
    }
    if (m.op === "resume-hello" && resumed && !settled && m.sessionId === sessionId && players.includes(from) && validId(m.incarnation)) {
      let next;
      try {
        next = roster(m.players, maxPlayers);
        integer(m.epoch, "epoch", epoch, 65534);
      } catch {
        return;
      }
      if (!next.includes(self) || !next.includes(from) || !next.includes(m.coordinatorId)) return;
      players = next;
      epoch = m.epoch;
      coordinatorId = m.coordinatorId;
      meshPlayers = new Set(next);
      meshUntil = Infinity;
      acceptIncarnations(m.peerIncarnations, next);
      incarnations.set(from, m.incarnation);
      saveResume();
      const donor = coordinatorId === self ? from : coordinatorId;
      if (incarnations.has(donor)) ensurePeer(donor).catch(() => {
      });
      return;
    }
    if (m.op === "hello" && expectedSessionId !== void 0 && m.sessionId !== expectedSessionId) return;
    if (m.op === "hello" && !resumed && !settled && role === "join" && m.coordinatorId === from && validId(m.sessionId)) {
      if (coordinatorId && (coordinatorId !== from || sessionId !== m.sessionId)) return;
      let known;
      try {
        known = roster(m.players, maxPlayers);
        integer(m.epoch, "epoch", 0, 65534);
      } catch {
        return;
      }
      if (!known.includes(from)) return;
      if (m.maxPlayers !== maxPlayers) {
        close("dynamic room maxPlayers mismatch");
        return;
      }
      if (m.accepting === false && !known.includes(self)) {
        close("dynamic room is full");
        return;
      }
      coordinatorId = from;
      sessionId = m.sessionId;
      players = known;
      epoch = m.epoch;
      incarnations.set(from, m.incarnation);
      meshPlayers = new Set(known);
      meshUntil = Infinity;
      saveResume();
      send(from, "join");
      ensurePeer(from).catch(() => {
      });
      return;
    }
    if (!sessionId || m.sessionId !== sessionId || m.coordinatorId !== coordinatorId) return;
    if (m.op === "resume-request" && players.includes(from) && m.resumeSession === sessionId && validId(m.incarnation)) {
      approveResume(from, m.incarnation);
      return;
    }
    if (m.op === "resume-reject" && resumed && players.includes(from)) {
      if (!settled) close("duplicate live resume identity");
      else if (links.get(from)?.resuming) failLink(links.get(from), new Error("duplicate live resume identity"));
      return;
    }
    if (m.op === "resume-accept" && resumed && players.includes(from) && validId(m.incarnation) && Number.isSafeInteger(m.generation) && m.generation > 0) {
      if (resumeApproved.has(from)) return;
      incarnations.set(from, m.incarnation);
      resumeApproved.add(from);
      if (leader(from)) {
        try {
          startGeneration(from, Math.max(m.generation, (generations.get(from) ?? 0) + 1));
        } catch {
        }
      }
      return;
    }
    if (m.op === "join" && coordinatorId === self) {
      if (!validId(m.incarnation)) return;
      if (incarnations.has(from) && incarnations.get(from) !== m.incarnation) {
        send(from, "reject", { targetIncarnation: m.incarnation, reason: "duplicate live identity; use resume" });
        return;
      }
      if (!players.includes(from) && !candidates.has(from)) {
        let authorized = false;
        try {
          authorized = authorizeJoin(from, { sessionId, room }) === true;
        } catch {
        }
        if (!authorized) {
          send(from, "reject", { targetIncarnation: m.incarnation, reason: "dynamic room admission reservation required" });
          return;
        }
        if (players.length + candidates.size >= maxPlayers || pendingCount() >= maxPendingPeers) {
          send(from, "reject", { targetIncarnation: m.incarnation, reason: "dynamic room is full" });
          return;
        }
        candidates.set(from, nowMs() + peerTimeoutMs);
      }
      incarnations.set(from, m.incarnation);
      ensurePeer(from).catch(() => {
      });
      return;
    }
    if (m.op === "reject" && !settled && from === coordinatorId) {
      close(typeof m.reason === "string" ? m.reason.slice(0, 256) : "dynamic room rejected");
      return;
    }
    if (m.op === "mesh" && from === coordinatorId && m.incarnation === incarnations.get(from) && m.epoch === epoch) {
      let next;
      try {
        next = roster(m.players, maxPlayers);
      } catch {
        return;
      }
      if (!next.includes(self) || !next.includes(coordinatorId)) return;
      acceptIncarnations(m.peerIncarnations, next);
      meshPlayers = new Set(next);
      meshUntil = nowMs() + peerTimeoutMs;
      for (const id of next) if (id !== self) ensurePeer(id).catch(() => {
      });
      return;
    }
    if (!accepted(from) || m.incarnation !== incarnations.get(from)) return;
    if (m.op === "request" && leader(from) && Number.isSafeInteger(m.generation) && m.generation >= 0) {
      const link = links.get(from), generation = generations.get(from) ?? 0;
      if (m.generation > generation) return;
      if (!link || m.reconnect === true && m.generation === generation && link.peer) {
        try {
          startGeneration(from, generation + 1);
        } catch {
        }
      } else if (link.connectionId) announceLink(link);
    } else if (m.op === "link" && !leader(from) && Number.isSafeInteger(m.generation) && m.generation > 0 && validId(m.connectionId)) {
      const known = generations.get(from) ?? 0, current = links.get(from);
      if (m.generation < known || m.generation === known && current?.connectionId !== m.connectionId) return;
      if (current?.generation === m.generation && current.connectionId === m.connectionId) return;
      try {
        const link = newLink(from, m.generation, m.connectionId, current);
        rememberGeneration(from, m.generation);
        startPeer(link);
      } catch {
      }
    }
  }
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) {
    abort();
    return ready;
  }
  try {
    unsubscribe = signaler.subscribe((envelope) => {
      try {
        receive(envelope);
      } catch (error2) {
        close(error2.message);
      }
    });
  } catch (error2) {
    close(error2.message);
    return ready;
  }
  if (disposed) {
    unsubscribe?.();
    return ready;
  }
  const remaining = timeoutMs - (nowMs() - startedAt);
  if (remaining <= 0) {
    close("dynamic room timeout");
    return ready;
  }
  if (establishing) deadline = setTimeout(() => close("dynamic room join timeout"), remaining);
  interval = setInterval(() => {
    const now = nowMs();
    for (const [id, until] of candidates) if (until <= now && !players.includes(id)) {
      candidates.delete(id);
      incarnations.delete(id);
      const link = links.get(id);
      if (link) destroyLink(link, "dynamic admission timeout");
    }
    for (const [key, queued] of backlog) if (queued.until <= now) forgetBacklog(key);
    if (coordinatorId === self && now >= nextAdvertisement) {
      nextAdvertisement = now + advertiseIntervalMs;
      advertise();
    }
    if (!settled && establishing) {
      if (resumed) send("*", "discover", { resumeSession: sessionId });
      else if (!coordinatorId) send("*", "discover");
      else {
        send(coordinatorId, "join");
        ensurePeer(coordinatorId).catch(() => {
        });
      }
    }
    if (invitation && invitation.until > now) send("*", "mesh", { players: invitation.players, peerIncarnations: Object.fromEntries(incarnations) });
    else invitation = null;
    for (const link of links.values()) if (!link.peer && now >= link.nextRetry) {
      link.nextRetry = now + retryMs;
      if (link.waitingIncarnation) {
        if (incarnations.has(link.id)) ensurePeer(link.id).catch(() => {
        });
        continue;
      }
      if (link.resuming && !resumeApproved.has(link.id)) {
        send(link.id, "resume-request", { resumeSession: sessionId });
        continue;
      }
      if (leader(link.id)) announceLink(link);
      else if (!link.connectionId) send(link.id, "request", { generation: link.requestGeneration, reconnect: link.force });
      for (const [type, message] of link.outbound) publish(link.id, message, `${link.id}:signal:${link.generation}:${type}`).catch(() => {
      });
    }
  }, retryMs);
  interval.unref?.();
  status("room-ready", { localPlayerId: self });
  if (!disposed) {
    try {
      saveResume();
    } catch (error2) {
      close(error2.message);
      return ready;
    }
    if (!establishing) {
      advertise();
      finish();
    } else send("*", "discover", resumed ? { resumeSession: sessionId } : {});
  }
  return ready;
}

// packages/transport/src/public-room.js
var idValid = (value) => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
var randomId2 = () => [...globalThis.crypto.getRandomValues(new Uint8Array(16))].map((n) => n.toString(16).padStart(2, "0")).join("");
var randomRoom = () => String(globalThis.crypto.getRandomValues(new Uint32Array(1))[0] % 1e4).padStart(4, "0");
var DIRECTORY_LIMIT = 64;
var PUBLICATION_LIMIT = 16;
var error = (code, message) => Object.assign(new Error(message), { code });
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
  if (typeof namespace !== "string" || !namespace.trim() || encoder.encode(namespace + ":public-v1").length > 128) throw new TypeError("public room namespace");
  if (typeof simulationVersion !== "string" || !simulationVersion.length || encoder.encode(simulationVersion).length > 128) throw new TypeError("public simulationVersion");
  integer(maxPlayers, "maxPlayers", 1, 5);
  integer(discoveryMs, "discoveryMs", 10, 3e4);
  integer(totalTimeoutMs, "totalTimeoutMs", 10, 12e4);
  integer(leaseMs, "leaseMs", 100, 6e4);
  integer(reservationMs, "reservationMs", 100, 12e4);
  integer(maxAttempts, "maxAttempts", 1, 8);
  if ([onStatus, signalerFactory, dynamicRoomFactory].some((fn) => typeof fn !== "function")) throw new TypeError("public room capability");
  if (resume) {
    if (!resume.storage || ["getItem", "setItem", "removeItem"].some((k) => typeof resume.storage[k] !== "function")) throw new TypeError("resume storage capability");
    integer(resume.lifetimeMs ?? 8 * 60 * 60 * 1e3, "resume lifetimeMs", 1e3, 864e5);
    if (resume.reset !== void 0 && typeof resume.reset !== "boolean") throw new TypeError("resume reset");
    if (resume.key !== void 0 && (typeof resume.key !== "string" || !resume.key.length || resume.key.length > 500)) throw new TypeError("resume key");
  }
  if (signal?.aborted) throw error("PUBLIC_ABORTED", "public room aborted");
  const started = nowMs(), startedWallAt = Date.now(), controller = new AbortController(), directory = /* @__PURE__ */ new Map(), reservations = /* @__PURE__ */ new Map(), publications = /* @__PURE__ */ new Map();
  const ephemeralStore = /* @__PURE__ */ new Map();
  const ephemeral = createRoomResumeIdentity({ storage: { getItem: (k) => ephemeralStore.get(k) ?? null, setItem: (k, v) => ephemeralStore.set(k, v), removeItem: (k) => ephemeralStore.delete(k) } }, { namespace, room: "0000" });
  const shared = (identity) => ({ id: identity.id, sign: (...args) => identity.sign(...args), close() {
  } });
  let disposed = false, everAdmitted = false, resumeForgotten = false, room, directorySignaler, removeDirectory, removeRoom, interval, nextAdvertisement = 0;
  let sequence = 0, reservationWaiter, selected, setupTimer, generation = 0, directoryId, pointer, pointerKey, storedUntil;
  const timerWaiters = /* @__PURE__ */ new Map(), observers = /* @__PURE__ */ new Set();
  const status = (type, detail = {}) => {
    const event = { type, ...detail };
    try {
      onStatus(event);
    } catch {
    }
    for (const fn of [...observers]) {
      try {
        fn(event);
      } catch {
      }
    }
  };
  const remaining = () => Math.max(0, Math.floor(totalTimeoutMs - (nowMs() - started)));
  const scopedResume = (code) => resume ? { ...resume, ...resume.key ? { key: `${resume.key}:${code}` } : {} } : void 0;
  const roomStorageKey = (code) => scopedResume(code)?.key ?? `bloom-gamekit:dynamic-v1:${namespace}:${code}`;
  if (resume) {
    if (!resume.storage || ["getItem", "setItem", "removeItem"].some((k) => typeof resume.storage[k] !== "function")) throw new TypeError("resume storage capability");
    pointerKey = `${resume.key ?? `bloom-gamekit:public-v1:${namespace}:${simulationVersion}`}:pointer`;
    if (pointerKey.length > 512) throw new TypeError("public resume key");
    const raw = resume.storage.getItem(pointerKey);
    if (resume.reset) {
      if (raw) {
        try {
          const old = JSON.parse(raw);
          if (/^\d{4}$/.test(old?.room)) resume.storage.removeItem(roomStorageKey(old.room));
        } catch {
        }
      }
      resume.storage.removeItem(pointerKey);
    } else if (raw != null) {
      try {
        if (typeof raw !== "string" || raw.length > 2048) throw Error();
        pointer = JSON.parse(raw);
        if (pointer.version !== 1 || pointer.namespace !== namespace || pointer.simulationVersion !== simulationVersion || !/^\d{4}$/.test(pointer.room) || !idValid(pointer.sessionId) || !Number.isSafeInteger(pointer.expiresAt) || pointer.expiresAt <= Date.now() || pointer.expiresAt > Date.now() + 864e5) throw Error();
        storedUntil = pointer.expiresAt;
      } catch {
        ephemeral.identity.close();
        throw error("PUBLIC_RESUME_INVALID", "invalid or expired public resume pointer; explicitly reset for a fresh room");
      }
    }
  }
  const fail = (message) => error("PUBLIC_TIMEOUT", message ?? "public room total timeout");
  function wait(ms) {
    if (disposed) return Promise.reject(error("PUBLIC_CLOSED", "public room closed"));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        timerWaiters.delete(timer);
        resolve();
      }, Math.max(1, ms));
      timerWaiters.set(timer, reject);
    });
  }
  function bounded(promise, ms, reason) {
    let timer;
    const deadline = new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(reason), Math.max(1, ms));
      timerWaiters.set(timer, reject);
    });
    return Promise.race([promise, deadline]).finally(() => {
      clearTimeout(timer);
      timerWaiters.delete(timer);
    });
  }
  function close(reason = "public room closed") {
    if (disposed) return;
    disposed = true;
    clearTimeout(setupTimer);
    clearInterval(interval);
    removeRoom?.();
    removeDirectory?.();
    controller.abort();
    signal?.removeEventListener("abort", abort);
    const pending = reservationWaiter;
    reservationWaiter = null;
    pending?.reject(error("PUBLIC_CLOSED", reason));
    for (const [timer, reject] of timerWaiters) {
      clearTimeout(timer);
      reject(error("PUBLIC_CLOSED", reason));
    }
    timerWaiters.clear();
    directorySignaler?.close();
    room?.close();
    ephemeral.identity.close();
    ephemeralStore.clear();
    directory.clear();
    reservations.clear();
    publications.clear();
    status("public-room-closed", { reason });
    observers.clear();
  }
  function abort() {
    close("public room aborted");
  }
  signal?.addEventListener("abort", abort, { once: true });
  setupTimer = setTimeout(() => close("public room total timeout"), totalTimeoutMs);
  function publish(to, op, extra = {}, key = `${to}:${op}`) {
    if (disposed || !directorySignaler) return Promise.reject(error("PUBLIC_CLOSED", "public directory closed"));
    if (publications.has(key)) return publications.get(key);
    if (publications.size >= PUBLICATION_LIMIT) return Promise.reject(error("PUBLIC_CAPACITY", "public directory publication capacity"));
    const channel = directorySignaler, promise = Promise.resolve().then(() => channel.send(
      to,
      { type: "group", mode: "public-directory", version: 1, protocol: PROTOCOL_VERSION, simulationVersion, maxPlayers, op, ...extra }
    )).finally(() => {
      if (publications.get(key) === promise) publications.delete(key);
    });
    publications.set(key, promise);
    return promise;
  }
  function prune() {
    const now = Date.now();
    for (const [id, lease] of directory) if ((lease.refreshUntil ?? lease.expiresAt) <= now) directory.delete(id);
    for (const [id, seat] of reservations) if (!room || room.players.includes(id) || seat.expiresAt <= now || room.coordinatorId !== room.localPlayerId) {
      reservations.delete(id);
      if (room && !room.players.includes(id)) room.disconnect(id);
    }
  }
  function advertise(to = "*") {
    if (!room || room.closed || room.joining || room.coordinatorId !== room.localPlayerId) return Promise.resolve();
    prune();
    const issuedAt = Date.now();
    return publish(to, "lease", {
      room: room.room,
      sessionId: room.sessionId,
      coordinatorId: room.coordinatorId,
      players: [...room.players],
      epoch: room.epoch,
      sequence: ++sequence,
      issuedAt,
      expiresAt: issuedAt + leaseMs,
      committed: room.players.length,
      pending: reservations.size
    });
  }
  const background = (promise) => promise.catch((cause) => {
    if (!disposed) status("public-directory-error", { reason: cause.message });
  });
  function receive({ from, to, message: m } = {}) {
    if (disposed || !idValid(from) || from === directoryId || !["*", directoryId].includes(to) || !m || m.type !== "group" || m.mode !== "public-directory" || m.version !== 1 || m.protocol !== PROTOCOL_VERSION || m.simulationVersion !== simulationVersion || m.maxPlayers !== maxPlayers) return;
    const now = Date.now();
    if (m.op === "lease") {
      if (!/^\d{4}$/.test(m.room) || !idValid(m.sessionId) || m.coordinatorId !== from || !Number.isSafeInteger(m.epoch) || m.epoch < 0 || m.epoch > 65534 || !Number.isSafeInteger(m.sequence) || m.sequence < 1 || !Number.isSafeInteger(m.issuedAt) || m.issuedAt > now + 1e3 || !Number.isSafeInteger(m.expiresAt) || m.expiresAt <= now || m.expiresAt <= m.issuedAt || m.expiresAt - m.issuedAt > 6e4 || !Array.isArray(m.players) || m.players.length < 1 || m.players.length > maxPlayers || m.players.some((id) => !idValid(id)) || new Set(m.players).size !== m.players.length || !m.players.includes(from) || m.committed !== m.players.length || !Number.isSafeInteger(m.pending) || m.pending < 0 || m.pending + m.committed > maxPlayers) return;
      prune();
      const prior = directory.get(m.sessionId);
      if (prior && (m.room !== prior.room || m.epoch < prior.epoch || m.epoch === prior.epoch && (prior.refreshAfter || m.coordinatorId !== prior.coordinatorId || m.sequence <= prior.sequence))) return;
      if (prior && m.epoch > prior.epoch && !prior.players.includes(from)) {
        prior.refreshAfter ??= prior.expiresAt;
        prior.refreshUntil ??= prior.refreshAfter + 6e4;
        if (now < prior.refreshAfter || m.issuedAt < prior.refreshAfter) return;
      }
      if (!directory.has(m.sessionId) && directory.size >= DIRECTORY_LIMIT) return;
      directory.set(m.sessionId, {
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
      background(advertise());
      return;
    }
    if (m.op === "grant" || m.op === "deny") {
      const pending = reservationWaiter;
      if (!pending || to !== directoryId || from !== pending.lease.coordinatorId || m.sessionId !== pending.lease.sessionId || m.requestId !== pending.requestId || m.epoch !== pending.lease.epoch) return;
      if (m.op === "deny") {
        reservationWaiter = null;
        pending.reject(m.reason === "stale-epoch" ? error("PUBLIC_STALE_LEASE", "public room lease advanced; retry discovery") : error("PUBLIC_RESERVED", "public room has no available reservation"));
      } else if (Number.isSafeInteger(m.expiresAt) && m.expiresAt > now && m.expiresAt <= now + 12e4) {
        reservationWaiter = null;
        pending.resolve({ expiresAt: m.expiresAt });
      }
      return;
    }
    if (!room || room.closed || room.coordinatorId !== room.localPlayerId || m.sessionId !== room.sessionId || to !== directoryId || !idValid(m.requestId)) return;
    prune();
    if (m.op === "release") {
      const seat2 = reservations.get(from);
      if (seat2?.requestId === m.requestId) {
        reservations.delete(from);
        if (!room.players.includes(from)) room.disconnect(from);
        background(advertise());
      }
      return;
    }
    if (m.op !== "reserve" || !Number.isSafeInteger(m.expiresAt) || m.expiresAt <= now || m.expiresAt > now + 12e4) return;
    if (m.epoch !== room.epoch) {
      if (Number.isSafeInteger(m.epoch) && m.epoch >= 0 && m.epoch < room.epoch) {
        background(advertise(from));
        background(publish(from, "deny", { sessionId: room.sessionId, epoch: m.epoch, requestId: m.requestId, reason: "stale-epoch" }));
      }
      return;
    }
    let seat = reservations.get(from);
    if (room.players.includes(from)) {
      background(publish(from, "grant", { sessionId: room.sessionId, epoch: room.epoch, requestId: m.requestId, expiresAt: now + reservationMs }));
      return;
    }
    if (!seat && room.players.length + reservations.size < maxPlayers) {
      seat = { requestId: m.requestId, expiresAt: Math.min(now + reservationMs, m.expiresAt), epoch: room.epoch };
      reservations.set(from, seat);
    }
    if (seat) {
      seat.requestId = m.requestId;
      background(publish(from, "grant", { sessionId: room.sessionId, epoch: room.epoch, requestId: m.requestId, expiresAt: seat.expiresAt }));
    } else background(publish(from, "deny", { sessionId: room.sessionId, epoch: room.epoch, requestId: m.requestId }));
    background(advertise());
  }
  async function openDirectory(identity) {
    if (directorySignaler && directoryId === identity.id) return;
    removeDirectory?.();
    directorySignaler?.close();
    publications.clear();
    const current = ++generation;
    const setup = Promise.resolve().then(() => signalerFactory({
      room: "0000",
      namespace: namespace + ":public-v1",
      relays,
      timeoutMs: Math.max(1, Math.min(1e4, remaining())),
      signal: controller.signal,
      onStatus,
      maxVerificationsPerSecond: 32,
      verificationBurst: 20,
      identity: shared(identity)
    })).then((value) => {
      if (disposed || current !== generation) {
        value?.close?.();
        throw error("PUBLIC_CLOSED", "public directory closed");
      }
      return value;
    });
    try {
      directorySignaler = await bounded(setup, remaining(), fail());
    } catch (cause) {
      throw error("PUBLIC_RELAY_UNAVAILABLE", "public directory relay unavailable: " + cause.message);
    }
    if (directorySignaler?.id !== identity.id || ["send", "subscribe", "close"].some((k) => typeof directorySignaler?.[k] !== "function")) throw new TypeError("public signaler capability");
    directoryId = identity.id;
    removeDirectory = directorySignaler.subscribe((envelope) => {
      try {
        receive(envelope);
      } catch (cause) {
        status("public-directory-error", { reason: cause.message });
      }
    });
  }
  async function discover() {
    status("public-discovering");
    try {
      await bounded(publish("*", "discover"), remaining(), fail());
    } catch (cause) {
      throw error("PUBLIC_RELAY_UNAVAILABLE", "public directory relay unavailable: " + cause.message);
    }
    await wait(Math.min(discoveryMs, remaining()));
    try {
      await bounded(publish("*", "discover"), remaining(), fail());
    } catch (cause) {
      throw error("PUBLIC_RELAY_UNAVAILABLE", "public directory relay unavailable: " + cause.message);
    }
    prune();
    const available = [...directory.values()].filter((lease) => !lease.refreshAfter && lease.committed + lease.pending < maxPlayers).sort((a, b) => b.committed - a.committed || a.sessionId.localeCompare(b.sessionId));
    if (!available.length && [...directory.values()].some((lease) => lease.refreshAfter)) {
      throw error("PUBLIC_HANDOVER_PENDING", "public room coordinator changed; waiting for a fresh lease after prior expiry");
    }
    return available;
  }
  async function reserve(lease) {
    const requestId = randomId2(), expiresAt = Date.now() + Math.min(remaining(), reservationMs);
    let resolve, reject;
    const response = new Promise((yes, no) => {
      resolve = yes;
      reject = no;
    });
    reservationWaiter = { lease, requestId, resolve, reject };
    response.catch(() => {
    });
    selected = { ...lease, requestId };
    const attemptMs = Math.min(remaining(), Math.max(250, discoveryMs * 2));
    try {
      await bounded(publish(lease.coordinatorId, "reserve", { sessionId: lease.sessionId, epoch: lease.epoch, requestId, expiresAt }), attemptMs, error("PUBLIC_RESERVATION_TIMEOUT", "public reservation timeout"));
      await bounded(response, attemptMs, error("PUBLIC_RESERVATION_TIMEOUT", "public reservation timeout"));
    } finally {
      if (reservationWaiter?.requestId === requestId) reservationWaiter = null;
    }
  }
  async function release() {
    if (!selected?.requestId || disposed) return;
    const prior = selected;
    selected = null;
    try {
      await bounded(publish(prior.coordinatorId, "release", { sessionId: prior.sessionId, epoch: prior.epoch, requestId: prior.requestId }), Math.min(remaining(), 1e3), fail());
    } catch {
    }
  }
  function savePointer(committed = false) {
    if (!resume || !room || resumeForgotten) return;
    if (room.players.includes(room.localPlayerId)) everAdmitted = true;
    if (committed && everAdmitted && !room.players.includes(room.localPlayerId)) {
      resumeForgotten = true;
      resume.storage.removeItem(pointerKey);
      return;
    }
    if (room.joining) return;
    storedUntil ??= startedWallAt + (resume.lifetimeMs ?? 8 * 60 * 60 * 1e3);
    resume.storage.setItem(pointerKey, JSON.stringify({ version: 1, namespace, simulationVersion, room: room.room, sessionId: room.sessionId, expiresAt: storedUntil }));
  }
  async function connect(lease, restoring = false) {
    const code = lease?.room ?? randomRoom();
    let cancelled = false;
    const attemptController = new AbortController(), abortAttempt = () => attemptController.abort();
    controller.signal.addEventListener("abort", abortAttempt, { once: true });
    if (controller.signal.aborted) abortAttempt();
    const attemptTimeout = Math.max(1, Math.min(remaining(), restoring ? totalTimeoutMs : Math.max(discoveryMs * 2, dynamicOptions.peerTimeoutMs ?? 2e4)));
    const pending = Promise.resolve().then(() => dynamicRoomFactory({
      ...dynamicOptions,
      role: lease ? "join" : "host",
      room: code,
      namespace,
      maxPlayers,
      timeoutMs: attemptTimeout,
      relays,
      rtcConfig,
      resume: scopedResume(code),
      signal: attemptController.signal,
      onStatus,
      expectedSessionId: lease?.sessionId,
      authorizeJoin: (id) => {
        prune();
        return !!room && room.coordinatorId === room.localPlayerId && reservations.has(id);
      },
      signalerFactory: async (options) => {
        const identity = options.identity ?? ephemeral.identity;
        await openDirectory(identity);
        if (attemptController.signal.aborted) throw error("PUBLIC_CLOSED", "public attempt aborted");
        if (lease && !restoring) await reserve(lease);
        const value = await signalerFactory({ ...options, identity: shared(identity) });
        if (disposed) value?.close?.();
        return value;
      }
    })).then((result2) => {
      if (disposed || cancelled) result2?.close?.();
      return result2;
    });
    let result;
    try {
      result = await bounded(pending, attemptTimeout, fail("public room connection attempt timeout"));
    } catch (cause) {
      cancelled = true;
      attemptController.abort();
      controller.signal.removeEventListener("abort", abortAttempt);
      throw cause;
    }
    if (disposed) {
      result?.close?.();
      throw fail();
    }
    room = result;
    if (lease && room.sessionId !== lease.sessionId || room.localPlayerId !== directoryId) {
      room.close();
      room = null;
      throw error("PUBLIC_SCOPE", "public room identity/session mismatch");
    }
    return room;
  }
  try {
    await openDirectory(ephemeral.identity);
    if (pointer) {
      status("public-resuming", { room: pointer.room });
      await connect(pointer, true);
    } else {
      let lastError;
      const tried = /* @__PURE__ */ new Set();
      for (let attempt = 0; attempt < maxAttempts && !room; attempt++) {
        const available = await discover(), lease = available.find((value) => !tried.has(`${value.sessionId}:${value.epoch}`));
        if (!lease && available.length) {
          lastError ??= error("PUBLIC_NO_ROOM", "available public rooms did not accept this connection");
          break;
        }
        if (!lease) {
          status("public-hosting");
          await connect(null);
          break;
        }
        tried.add(`${lease.sessionId}:${lease.epoch}`);
        status("public-joining", { room: lease.room, sessionId: lease.sessionId });
        try {
          await connect(lease);
        } catch (cause) {
          lastError = cause;
          await release();
          await openDirectory(ephemeral.identity);
          status("public-attempt-failed", { reason: cause.message });
        }
      }
      if (!room) throw lastError ?? fail();
    }
    savePointer();
    removeRoom = room.subscribe((event) => {
      if (event.type === "peer-failed" || event.type === "peer-disconnected") {
        if (reservations.delete(event.peerId)) background(advertise());
      }
      if (event.type === "room-closed") close(event.reason);
    });
    await bounded(advertise(), remaining(), fail());
    clearTimeout(setupTimer);
    interval = setInterval(() => {
      if (disposed) return;
      prune();
      if (Date.now() >= nextAdvertisement) {
        nextAdvertisement = Date.now() + Math.max(30, Math.floor(leaseMs / 3));
        background(advertise());
      }
    }, Math.max(10, Math.min(1e3, Math.floor(leaseMs / 3))));
    interval.unref?.();
    const capability = {};
    for (const key of Object.keys(room)) Object.defineProperty(capability, key, { enumerable: true, configurable: true, get: () => room[key] });
    Object.defineProperties(capability, {
      close: { enumerable: true, configurable: true, value: close },
      setRoster: { enumerable: true, configurable: true, value(value) {
        room.setRoster(value);
        prune();
        savePointer(true);
        background(advertise());
      } },
      forgetResume: { enumerable: true, configurable: true, value() {
        resumeForgotten = true;
        room.forgetResume?.();
        resume?.storage.removeItem(pointerKey);
      } },
      publicMetrics: { enumerable: true, get: () => ({ directoryEntries: directory.size, pendingReservations: reservations.size, pendingPublications: publications.size }) },
      subscribe: { enumerable: true, configurable: true, value(fn) {
        if (typeof fn !== "function" || disposed) throw new TypeError("public room subscriber");
        const remove = room.subscribe(fn);
        observers.add(fn);
        return () => {
          remove();
          observers.delete(fn);
        };
      } }
    });
    status("public-room-ready", { room: room.room, sessionId: room.sessionId });
    return capability;
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
  nostrCrypto
};

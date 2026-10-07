import { nostrOrder, nostrBytesToNumber, nostrToHex, nostrFromHex, nostrPublicKey, nostrSign } from './nostr-crypto.js';
import { integer } from '../deterministic/utilities.js';

const hex32 = /^[0-9a-f]{64}$/;
/** Internal opt-in tab storage. No plaintext credential is returned by the room. */
export function createRoomResumeIdentity({ storage, key, lifetimeMs = 8 * 60 * 60 * 1000, reset = false } = {}, { namespace, room }) {
  if (!storage || ['getItem', 'setItem', 'removeItem'].some(name => typeof storage[name] !== 'function')) throw new TypeError('resume storage capability');
  integer(lifetimeMs, 'resume lifetimeMs', 1000, 24 * 60 * 60 * 1000);
  key ??= `bloom-gamekit:dynamic-v1:${namespace}:${room}`;
  if (typeof key !== 'string' || !key.length || key.length > 512) throw new TypeError('resume storage key');
  if (typeof reset !== 'boolean') throw new TypeError('resume reset');
  if (reset) storage.removeItem(key);
  let saved, secret, forgotten = false, closed = false;
  const raw = storage.getItem(key), now = Date.now();
  if (raw != null) {
    let expired = false;
    try {
      if (typeof raw !== 'string' || raw.length > 8192) throw new Error('invalid record');
      saved = JSON.parse(raw);
      expired = Number.isSafeInteger(saved?.expiresAt) && saved.expiresAt <= now;
      if (saved.version !== 1 || saved.namespace !== namespace || saved.room !== room || !hex32.test(saved.secret) ||
          !Number.isSafeInteger(saved.createdAt) || !Number.isSafeInteger(saved.expiresAt) || saved.createdAt > now ||
          saved.expiresAt <= now || saved.expiresAt - saved.createdAt > 24 * 60 * 60 * 1000 ||
          saved.sessionId !== null && (typeof saved.sessionId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(saved.sessionId)) ||
          !Array.isArray(saved.players) || saved.players.length > 5 || saved.players.some(id => !hex32.test(id)) ||
          new Set(saved.players).size !== saved.players.length || !Number.isSafeInteger(saved.epoch) || saved.epoch < 0 || saved.epoch > 65534 ||
          saved.coordinatorId !== null && !saved.players.includes(saved.coordinatorId)) throw new Error('invalid record');
      secret = nostrFromHex(saved.secret);
      const scalar = nostrBytesToNumber(secret);
      if (scalar <= 0n || scalar >= nostrOrder || nostrToHex(nostrPublicKey(secret)) !== saved.id) throw new Error('invalid key');
    } catch {
      secret?.fill(0);
      throw new Error(expired ? 'resume record expired; explicitly reset for a fresh room' : 'invalid resume record; explicitly reset for a fresh room');
    }
  }
  if (!secret) {
    secret = new Uint8Array(32);
    let valid = false;
    for (let attempt = 0; attempt < 16; attempt++) {
      globalThis.crypto.getRandomValues(secret);
      const value = nostrBytesToNumber(secret); if (value > 0n && value < nostrOrder) { valid = true; break; }
    }
    if (!valid) { secret.fill(0); throw new Error('resume identity generation failed'); }
  }
  const id = nostrToHex(nostrPublicKey(secret));
  let record = saved ?? { version: 1, namespace, room, id, secret: nostrToHex(secret), createdAt: now,
    expiresAt: now + lifetimeMs, sessionId: null, coordinatorId: null, epoch: 0, players: [] };
  const metadata = saved ? { sessionId: saved.sessionId, coordinatorId: saved.coordinatorId, epoch: saved.epoch, players: [...saved.players] } : null;
  function write() {
    if (forgotten || closed) return;
    try { storage.setItem(key, JSON.stringify(record)); }
    catch { secret.fill(0); closed = true; throw new Error('resume storage unavailable'); }
  }
  write();
  return {
    metadata,
    identity: { id,
      sign(hash, auxiliary, cryptoImpl) {
        if (closed) throw new Error('resume identity closed');
        return nostrSign(hash, secret, auxiliary, cryptoImpl);
      },
      close() { if (closed) return; closed = true; secret.fill(0); record = null; }
    },
    update(value) { if (!forgotten && !closed) { record = { ...record, ...value, players: [...value.players] }; write(); } },
    forget() { storage.removeItem(key); forgotten = true; },
  };
}

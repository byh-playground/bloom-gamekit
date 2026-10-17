// NIP-01/BIP340 signaling. These short-lived keys identify a signaling session,
// never a wallet. JavaScript BigInt arithmetic is not constant-time.
const NOSTR_FIELD = 0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2fn;
const NOSTR_ORDER = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
export { NOSTR_ORDER as nostrOrder };
const NOSTR_GENERATOR = [
    0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798n,
    0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8n,
    1n,
];
const NOSTR_INFINITY = [0n, 1n, 0n];
const NOSTR_ENCODER = new TextEncoder();
export { NOSTR_ENCODER as nostrEncoder };
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
        nostrMod(2n * NOSTR_Y * NOSTR_Z),
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
        nostrMod(((NOSTR_Z1 + NOSTR_Z2) ** 2n - NOSTR_Z1_SQUARED - NOSTR_Z2_SQUARED) * NOSTR_H),
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
        nostrMod(nostrPoint[1] * NOSTR_INVERSE_SQUARED * NOSTR_INVERSE),
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
export function nostrBytesToNumber(nostrBytes) {
    let nostrValue = 0n;
    for (const NOSTR_BYTE of nostrBytes) {
        nostrValue = (nostrValue << 8n) | BigInt(NOSTR_BYTE);
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
export function nostrToHex(nostrBytes) {
    return Array.from(nostrBytes, (nostrByte) => nostrByte.toString(16).padStart(2, '0')).join('');
}
export function nostrFromHex(nostrHex) {
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
export function nostrRequireCrypto(nostrCryptoImpl, nostrRandom = false) {
    if (
        !nostrCryptoImpl?.subtle ||
        typeof nostrCryptoImpl.subtle.digest !== 'function' ||
        (nostrRandom && typeof nostrCryptoImpl.getRandomValues !== 'function')
    ) {
        throw new Error('Nostr signaling requires WebCrypto SHA-256 and secure randomness (use HTTPS)');
    }
}
export async function nostrHash(nostrBytes, nostrCryptoImpl) {
    nostrRequireCrypto(nostrCryptoImpl);
    return new Uint8Array(await nostrCryptoImpl.subtle.digest('SHA-256', nostrBytes));
}
async function nostrTaggedHash(nostrTag, nostrBytes, nostrCryptoImpl) {
    const NOSTR_TAG_HASH = await nostrHash(NOSTR_ENCODER.encode(nostrTag), nostrCryptoImpl);
    return nostrHash(nostrConcat(NOSTR_TAG_HASH, NOSTR_TAG_HASH, nostrBytes), nostrCryptoImpl);
}
export function nostrPublicKey(nostrSecret) {
    const NOSTR_SECRET_COPY = nostrRequireBytes(nostrSecret, 32, 'secret');
    try {
        const NOSTR_SCALAR = nostrBytesToNumber(NOSTR_SECRET_COPY);
        if (NOSTR_SCALAR === 0n || NOSTR_SCALAR >= NOSTR_ORDER) {
            throw new RangeError('Invalid secp256k1 secret');
        }
        return nostrNumberToBytes(nostrAffine(nostrMultiply(NOSTR_SCALAR))[0]);
    } finally {
        NOSTR_SECRET_COPY.fill(0);
    }
}
export async function nostrVerify(nostrSignature, nostrMessage, nostrPublic, nostrCryptoImpl) {
    if (
        !(nostrSignature instanceof Uint8Array) ||
        nostrSignature.length !== 64 ||
        !(nostrMessage instanceof Uint8Array) ||
        nostrMessage.length !== 32 ||
        !(nostrPublic instanceof Uint8Array) ||
        nostrPublic.length !== 32
    ) {
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
    const NOSTR_CHALLENGE =
        nostrBytesToNumber(
            await nostrTaggedHash(
                'BIP0340/challenge',
                nostrConcat(NOSTR_SIGNATURE_COPY.subarray(0, 32), NOSTR_PUBLIC_COPY, NOSTR_MESSAGE_COPY),
                nostrCryptoImpl,
            ),
        ) % NOSTR_ORDER;
    const NOSTR_RESULT = nostrAffine(
        nostrAdd(
            nostrMultiply(NOSTR_S),
            nostrMultiply(NOSTR_CHALLENGE, [NOSTR_POINT[0], nostrMod(-NOSTR_POINT[1]), 1n]),
        ),
    );
    return NOSTR_RESULT !== null && (NOSTR_RESULT[1] & 1n) === 0n && NOSTR_RESULT[0] === NOSTR_R;
}
export async function nostrSign(nostrMessage, nostrSecret, nostrAuxiliary, nostrCryptoImpl) {
    const NOSTR_MESSAGE_COPY = nostrRequireBytes(nostrMessage, 32, 'message');
    const NOSTR_AUXILIARY_COPY = nostrRequireBytes(nostrAuxiliary, 32, 'auxiliary randomness');
    const NOSTR_SECRET_COPY = nostrRequireBytes(nostrSecret, 32, 'secret');
    let nostrMaskedSecret;
    try {
        const NOSTR_SCALAR = nostrBytesToNumber(NOSTR_SECRET_COPY);
        if (NOSTR_SCALAR === 0n || NOSTR_SCALAR >= NOSTR_ORDER) {
            throw new RangeError('Invalid secp256k1 secret');
        }
        const NOSTR_POINT = nostrAffine(nostrMultiply(NOSTR_SCALAR));
        const NOSTR_NORMALIZED_SECRET = NOSTR_POINT[1] & 1n ? NOSTR_ORDER - NOSTR_SCALAR : NOSTR_SCALAR;
        const NOSTR_PUBLIC = nostrNumberToBytes(NOSTR_POINT[0]);
        const NOSTR_AUXILIARY_HASH = await nostrTaggedHash('BIP0340/aux', NOSTR_AUXILIARY_COPY, nostrCryptoImpl);
        nostrMaskedSecret = nostrNumberToBytes(NOSTR_NORMALIZED_SECRET);
        for (let nostrIndex = 0; nostrIndex < 32; nostrIndex++) {
            nostrMaskedSecret[nostrIndex] ^= NOSTR_AUXILIARY_HASH[nostrIndex];
        }
        const NOSTR_NONCE =
            nostrBytesToNumber(
                await nostrTaggedHash(
                    'BIP0340/nonce',
                    nostrConcat(nostrMaskedSecret, NOSTR_PUBLIC, NOSTR_MESSAGE_COPY),
                    nostrCryptoImpl,
                ),
            ) % NOSTR_ORDER;
        if (NOSTR_NONCE === 0n) {
            throw new Error('BIP340 nonce generation failed');
        }
        const NOSTR_NONCE_POINT = nostrAffine(nostrMultiply(NOSTR_NONCE));
        const NOSTR_NORMALIZED_NONCE = NOSTR_NONCE_POINT[1] & 1n ? NOSTR_ORDER - NOSTR_NONCE : NOSTR_NONCE;
        const NOSTR_R = nostrNumberToBytes(NOSTR_NONCE_POINT[0]);
        const NOSTR_CHALLENGE =
            nostrBytesToNumber(
                await nostrTaggedHash(
                    'BIP0340/challenge',
                    nostrConcat(NOSTR_R, NOSTR_PUBLIC, NOSTR_MESSAGE_COPY),
                    nostrCryptoImpl,
                ),
            ) % NOSTR_ORDER;
        const NOSTR_SIGNATURE = nostrConcat(
            NOSTR_R,
            nostrNumberToBytes(
                nostrMod(NOSTR_NORMALIZED_NONCE + NOSTR_CHALLENGE * NOSTR_NORMALIZED_SECRET, NOSTR_ORDER),
            ),
        );
        if (!(await nostrVerify(NOSTR_SIGNATURE, NOSTR_MESSAGE_COPY, NOSTR_PUBLIC, nostrCryptoImpl))) {
            throw new Error('BIP340 signature self-check failed');
        }
        return NOSTR_SIGNATURE;
    } finally {
        NOSTR_SECRET_COPY.fill(0);
        NOSTR_AUXILIARY_COPY.fill(0);
        nostrMaskedSecret?.fill(0);
    }
}

/** Low-level 32-byte-message helpers for conformance tests, not wallet signing. */
const NOSTR_CRYPTO = Object.freeze({
    publicKey: nostrPublicKey,
    sign: (nostrMessage, nostrSecret, nostrAuxiliary) =>
        nostrSign(nostrMessage, nostrSecret, nostrAuxiliary, globalThis.crypto),
    verify: (nostrSignature, nostrMessage, nostrPublic) =>
        nostrVerify(nostrSignature, nostrMessage, nostrPublic, globalThis.crypto),
});
export { NOSTR_CRYPTO as nostrCrypto };

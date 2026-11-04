// How a face finds its place on a body: three named sockets in the body's canvas, and the transform that carries the
// rest triangle of those sockets onto the posed one so squash, lean and bounce move the face like the body.

// The sockets a body's SVG declares for its face. Every body that wears a face needs exactly these three.
export const FACE_SOCKETS = Object.freeze(['face-eye-left', 'face-eye-right', 'face-mouth']);

const ANCHORS = new WeakMap();

// The three face sockets of a compiled body at its rest pose, in the body's canvas. Cached per compiled body.
export function faceAnchor(compiled) {
    let anchor = ANCHORS.get(compiled);
    if (!anchor) {
        const SOCKETS = compiled.metadata.sockets,
            POINT = (id) => {
                const SOCKET = SOCKETS[id];
                if (!SOCKET) {
                    throw new Error('Body is missing face socket ' + id + ' (' + compiled.sourcePath + ')');
                }
                return SOCKET.point;
            };
        anchor = Object.freeze({
            eyeLeft: POINT(FACE_SOCKETS[0]),
            eyeRight: POINT(FACE_SOCKETS[1]),
            mouth: POINT(FACE_SOCKETS[2]),
        });
        ANCHORS.set(compiled, anchor);
    }
    return anchor;
}

// Writes into `out` ([a, b, c, d, e, f], Canvas transform order) the transform that maps the rest anchor triangle
// onto the posed one, read from the actor's sockets. `out` is the caller's scratch so a frame allocates nothing.
export function posedFace(actor, rest, out) {
    const EL = actor.getSocket(FACE_SOCKETS[0]),
        ER = actor.getSocket(FACE_SOCKETS[1]),
        MO = actor.getSocket(FACE_SOCKETS[2]);
    const U1X = rest.eyeRight[0] - rest.eyeLeft[0],
        U1Y = rest.eyeRight[1] - rest.eyeLeft[1],
        U2X = rest.mouth[0] - rest.eyeLeft[0],
        U2Y = rest.mouth[1] - rest.eyeLeft[1],
        V1X = ER.x - EL.x,
        V1Y = ER.y - EL.y,
        V2X = MO.x - EL.x,
        V2Y = MO.y - EL.y,
        DET = U1X * U2Y - U1Y * U2X;
    // [a c; b d] = V * U^-1
    out[0] = (V1X * U2Y - V2X * U1Y) / DET;
    out[1] = (V1Y * U2Y - V2Y * U1Y) / DET;
    out[2] = (V2X * U1X - V1X * U2X) / DET;
    out[3] = (V2Y * U1X - V1Y * U2X) / DET;
    out[4] = EL.x - (out[0] * rest.eyeLeft[0] + out[2] * rest.eyeLeft[1]);
    out[5] = EL.y - (out[1] * rest.eyeLeft[0] + out[3] * rest.eyeLeft[1]);
    return out;
}

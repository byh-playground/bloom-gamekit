import assert from 'node:assert/strict';

export async function exerciseDebugHost(page) {
    const R = await page.evaluate(async () => {
        const { installDebugHost: INSTALL } = await import('/dist/debug-tools.js'),
            CANVAS = document.createElement('canvas'),
            CONTEXT = CANVAS.getContext('2d');
        CANVAS.width = CANVAS.height = 64;
        document.body.append(CANVAS);
        // A fixed scenario: a square moves `speed` pixels per tick from x=0.
        const SCENES = {
                move({ speed }) {
                    let x = 0;
                    const SPEED = Number(speed);
                    return {
                        step: () => {
                            x += SPEED;
                        },
                        render: () => {
                            CONTEXT.clearRect(0, 0, 64, 64);
                            CONTEXT.fillStyle = '#f00';
                            CONTEXT.fillRect(x, 24, 8, 8);
                        },
                        state: () => ({ x }),
                    };
                },
                broken() {
                    throw new Error('scene failed');
                },
            },
            OPEN = async (search) => {
                const TARGET = {},
                    HOST = INSTALL({ scenes: SCENES, search, target: TARGET });
                await HOST?.done;
                return { TARGET, HOST };
            },
            ALPHA = (x) => CONTEXT.getImageData(x, 28, 1, 1).data[3],
            RESULT = {};
        RESULT.none = (await OPEN('?scene=move&speed=4')).HOST;
        const MOVED = await OPEN('?debug=1&scene=move&speed=4&tick=5');
        RESULT.moved = {
            ready: MOVED.HOST.ready,
            exposed: MOVED.TARGET.__bloomDebug === MOVED.HOST,
            state: MOVED.HOST.state(),
            atTarget: ALPHA(22),
            atStart: ALPHA(2),
        };
        MOVED.HOST.step(2);
        RESULT.stepped = { tick: MOVED.HOST.tick, x: MOVED.HOST.state().x, atNew: ALPHA(30) };
        MOVED.HOST.dispose();
        RESULT.disposed = { exposed: '__bloomDebug' in MOVED.TARGET, ready: MOVED.HOST.ready };
        const FAILURES = {};
        for (const [NAME, SEARCH] of Object.entries({
            unknown: '?debug=1&scene=nope',
            missing: '?debug=1',
            broken: '?debug=1&scene=broken',
            wrongTick: '?debug=1&scene=move&speed=4&tick=1.5',
        })) {
            const { HOST } = await OPEN(SEARCH);
            FAILURES[NAME] = { ready: HOST.ready, error: HOST.error };
        }
        RESULT.failures = FAILURES;
        // The host does not interpret scene parameters: a wrong number reaches the scene as it is, with no default.
        const WRONG = await OPEN('?debug=1&scene=move&speed=abc&tick=2');
        RESULT.passThrough = { ready: WRONG.HOST.ready, nan: Number.isNaN(WRONG.HOST.state().x) };
        CANVAS.remove();
        return RESULT;
    });
    assert.equal(R.none, null, 'no debug parameter installs nothing');
    assert.equal(R.moved.ready, true);
    assert.equal(R.moved.exposed, true);
    assert.deepEqual(R.moved.state, { scene: 'move', params: { speed: '4' }, tick: 5, x: 20 });
    assert.equal(R.moved.atTarget, 255, 'the square is drawn where tick 5 puts it');
    assert.equal(R.moved.atStart, 0, 'and not where tick 0 had it');
    assert.deepEqual(R.stepped, { tick: 7, x: 28, atNew: 255 });
    assert.deepEqual(R.disposed, { exposed: false, ready: false });
    for (const [NAME, FAILURE] of Object.entries(R.failures)) {
        assert.equal(FAILURE.ready, false, `${NAME} must not become ready`);
        assert.ok(FAILURE.error, `${NAME} must report its error`);
    }
    assert.deepEqual(R.passThrough, { ready: true, nan: true });
    return R;
}

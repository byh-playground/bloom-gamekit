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
                // Draws with the page clock, as a game's presentation does: only a frozen clock makes the picture repeat.
                // Each tick advances 50 ms and measures its own time on the real clock.
                clocked(_params, { freezeClock }) {
                    const CLOCK = freezeClock(),
                        TIMES = [];
                    return {
                        step() {
                            CLOCK.advance(50);
                            TIMES.push(CLOCK.realTime(() => performance.now()));
                        },
                        render: () => {
                            CONTEXT.clearRect(0, 0, 64, 64);
                            CONTEXT.fillStyle = `hsl(${performance.now() % 360} 80% 50%)`;
                            CONTEXT.fillRect(0, 0, 64, 64);
                        },
                        state: (options) => ({
                            now: performance.now(),
                            options,
                            // Times read inside realTime come from the real clock, far below the virtual epoch.
                            ...(options?.times
                                ? { times: TIMES.length, real: TIMES.every((time) => time < 10_000_000) }
                                : {}),
                        }),
                    };
                },
                // Freezes the clock, then fails to open.
                frozenBroken(_params, { freezeClock }) {
                    freezeClock();
                    throw new Error('scene failed after freezing');
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
        // The virtual clock: the same address twice gives the same state and the same pixels; dispose restores the clock.
        const OWN_NOW = () => Object.hasOwn(performance, 'now');
        RESULT.clock = { ownBefore: OWN_NOW(), opens: [] };
        for (let open = 0; open < 2; open++) {
            const { HOST } = await OPEN('?debug=1&scene=clocked&tick=7');
            RESULT.clock.opens.push({
                ready: HOST.ready,
                state: HOST.state({ times: true }),
                plain: HOST.state(),
                pixels: CANVAS.toDataURL(),
            });
            HOST.dispose();
            RESULT.clock.opens[open].restored = !OWN_NOW() && performance.now() < 10_000_000;
        }
        const BROKEN = await OPEN('?debug=1&scene=frozenBroken');
        RESULT.clock.failed = { ready: BROKEN.HOST.ready, restored: !OWN_NOW() };
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
    assert.equal(R.clock.ownBefore, false, 'the page starts on the real clock');
    const [FIRST, SECOND] = R.clock.opens;
    assert.equal(FIRST.ready, true);
    // Seven ticks of 50 ms from the fixed epoch; the state options reach the scene as given.
    assert.deepEqual(FIRST.state, {
        scene: 'clocked',
        params: {},
        tick: 7,
        now: 10_000_350,
        options: { times: true },
        times: 7,
        real: true,
    });
    assert.equal(FIRST.plain.options, undefined, 'no options reach the scene as none');
    assert.equal('times' in FIRST.plain, false);
    assert.deepEqual(SECOND.state, FIRST.state, 'the same address gives the same state');
    assert.equal(SECOND.pixels, FIRST.pixels, 'and the same picture');
    assert.equal(FIRST.restored && SECOND.restored, true, 'dispose puts the real performance.now back');
    assert.deepEqual(
        R.clock.failed,
        { ready: false, restored: true },
        'a scene that fails to open leaves no frozen clock',
    );
    return R;
}

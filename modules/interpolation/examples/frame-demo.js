import { RenderObject as R, PresentationRuntime } from '../../../dist/interpolation.js';
import { WebGLDevice, VectorContext } from '../../../dist/rendering.js';
class Shot extends R {
    static renderSchema = {
        x: R.POSITION_X,
        y: R.POSITION_Y,
        color: R.STEP,
    };
    static renderPath = {
        x: 'x',
        y: 'y',
        durationMs: 600,
        maxPoints: 64,
    };
}
// Shape, bend and lifetime are game rules. The module owns display-time sampling.
export function startFrameDemo(canvas, status) {
    const DEVICE = new WebGLDevice(canvas),
        CONTEXT = new VectorContext(DEVICE),
        VIEW = new PresentationRuntime({
            stepMs: 100,
            delayMs: 200,
        });
    const PATH = [],
        SHOT = {
            x: 0,
            y: 0,
            color: 'cyan',
        };
    let sequence = 0;
    let revision = 0;
    let generation = 0;
    let timeMs = 0;
    let age = 0;
    let alive = false;
    let stopped = false;
    const EPOCH = performance.now();
    VIEW.capture(
        {
            revision,
            sequence,
            timeMs,
            entities: [],
        },
        EPOCH,
    );
    function spawn() {
        generation++;
        alive = true;
        age = 0;
        SHOT.x = 80;
        SHOT.y = 100;
    }
    function rollback() {
        revision++;
        generation++;
        sequence = 0;
        SHOT.x = 80;
        SHOT.y = 100;
        age = 0;
        alive = true;
        VIEW.capture(
            {
                revision,
                sequence,
                timeMs,
                mode: 'rollback',
                entities: [
                    {
                        id: 'shot',
                        generation,
                        type: Shot,
                        source: SHOT,
                    },
                ],
            },
            performance.now(),
        );
    }
    const TIMER = setInterval(() => {
        const INITIAL = {
            ...SHOT,
        };
        timeMs += 100;
        sequence++;
        if (alive) {
            age += 100;
            SHOT.x += 20;
            SHOT.y = 100 + Math.max(0, Math.min(100, (age - 500) / 5));
            if (age >= 2000) {
                alive = false;
            }
        }
        VIEW.capture(
            {
                revision,
                sequence,
                timeMs,
                entities: alive
                    ? [
                          {
                              id: 'shot',
                              generation,
                              type: Shot,
                              source: SHOT,
                              ...(age === 100
                                  ? {
                                        initialSource: INITIAL,
                                        initialTimeMs: timeMs - 100,
                                    }
                                  : {}),
                          },
                      ]
                    : [],
            },
            performance.now(),
        );
    }, 100);
    function paint() {
        if (stopped) {
            return;
        }
        const NOW = performance.now(),
            FRAME = VIEW.frame(NOW);
        let count = 0;
        if (CONTEXT.beginFrame({ clearColor: [0.03, 0.06, 0.09, 1] })) {
            CONTEXT.strokeStyle = [0.2, 0.7, 0.9, 0.7];
            CONTEXT.lineWidth = 3;
            CONTEXT.fillStyle = [0.3, 1, 0.8, 1];
            FRAME.forEach((model, id, generation) => {
                count++;
                FRAME.pathInto(id, generation, PATH);
                if (PATH.length > 1) {
                    CONTEXT.beginPath();
                    CONTEXT.moveTo(PATH[0].x, PATH[0].y);
                    for (let i = 1; i < PATH.length; i++) {
                        CONTEXT.lineTo(PATH[i].x, PATH[i].y);
                    }
                    CONTEXT.stroke();
                }
                CONTEXT.fillRect(model.x - 6, model.y - 6, 12, 12);
            });
            CONTEXT.endFrame();
        }
        status.textContent = `authority alive: ${alive} / displayed: ${count} / display ms: ${FRAME.timeMs.toFixed(0)}`;
        requestAnimationFrame(paint);
    }
    requestAnimationFrame(paint);
    spawn();
    return {
        spawn,
        rollback,
        dispose() {
            stopped = true;
            clearInterval(TIMER);
            CONTEXT.dispose();
            DEVICE.dispose();
        },
    };
}

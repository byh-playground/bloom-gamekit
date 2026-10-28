export async function runRenderObjectChecks(page) {
    return page.evaluate(async () => {
        const { RenderObject: RENDER_OBJECT, PresentationRuntime: PRESENTATION_RUNTIME } =
            await import('/dist/interpolation.js');
        const { WebGLDevice: WEB_GL_DEVICE, VectorContext: VECTOR_CONTEXT } = await import('/dist/rendering.js');
        const { ActionState: ACTION_STATE, createDOMInput: CREATE_DOM_INPUT } = await import('/dist/input.js');
        const CHECK = (ok, message) => {
            if (!ok) {
                throw new Error(message);
            }
        };
        class Actor extends RENDER_OBJECT {
            static renderSchema = {
                x: this.LINEAR,
                y: this.LINEAR,
                'roll.progress': this.LINEAR,
                color: this.STEP,
                'node.state': this.STATE_KEY,
                'node.clock': this.COUNTDOWN_MS,
                'node.anchor': this.LINEAR,
            };
            x = 16;
            y = 32;
            roll = {
                progress: 0,
            };
            color = [0, 1, 0, 1];
            node = {
                state: 'ready',
                clock: 100,
                anchor: 12,
            };
            #renders = 0;
            update(input) {
                if (input.held) {
                    this.x += 32;
                    this.roll.progress = 1;
                    this.node = {
                        state: 'active',
                        clock: 200,
                        anchor: 60,
                    };
                }
            }
            render(renderer, model) {
                this.#renders++;
                renderer.fillStyle = model.color;
                renderer.fillRect(model.x - 4, model.y - 4, 8, 8);
            }
            get renders() {
                return this.#renders;
            }
        }
        const CANVAS = document.createElement('canvas');
        document.body.append(CANVAS);
        CANVAS.width = CANVAS.height = 64;
        const DEVICE = new WEB_GL_DEVICE(CANVAS, {
                preserveDrawingBuffer: true,
            }),
            RENDERER = new VECTOR_CONTEXT(DEVICE);
        const ACTOR = new Actor(),
            RUNTIME = new PRESENTATION_RUNTIME({
                stepMs: 100,
            }),
            STATE = new ACTION_STATE();
        const INPUT = CREATE_DOM_INPUT({
            target: CANVAS,
            state: STATE,
            keys: {
                KeyQ: 'move',
            },
        });
        const PACKET = (sequence) => ({
            revision: 0,
            sequence,
            timeMs: sequence * 100,
            entities: [
                {
                    id: 'actor',
                    generation: 0,
                    source: ACTOR,
                },
            ],
        });
        RUNTIME.capture(PACKET(0), 0);
        document.dispatchEvent(
            new KeyboardEvent('keydown', {
                code: 'KeyQ',
                bubbles: true,
            }),
        );
        ACTOR.update(STATE.sample('move'));
        STATE.consume();
        RUNTIME.capture(PACKET(1), 100);
        const MODEL = RUNTIME.sample('actor', 0, 150);
        CHECK(MODEL.x === 32 && MODEL.roll.progress === 0.5, 'native nested half-tick model');
        CHECK(
            MODEL.node.clock === 200 && MODEL.node.anchor === 60,
            'state/countdown parent resets do not snap root movement',
        );
        CHECK(
            MODEL.roll !== ACTOR.roll && MODEL.color !== ACTOR.color && !('update' in MODEL),
            'detached field-only model',
        );
        RENDERER.beginFrame({ clearColor: [0, 0, 0, 1] });
        RUNTIME.render(ACTOR, RENDERER, 150);
        RENDERER.endFrame();
        const PIXEL = new Uint8Array(4);
        DEVICE.gl.readPixels(32, 32, 1, 1, DEVICE.gl.RGBA, DEVICE.gl.UNSIGNED_BYTE, PIXEL);
        CHECK(PIXEL[1] > 240 && PIXEL[0] < 10, 'real WebGL draws interpolated midpoint');
        CHECK(ACTOR.renders === 1 && ACTOR.x === 48, 'normal this retains private fields and authority');
        CHECK(
            RUNTIME.modelFor(
                {
                    ...ACTOR,
                },
                150,
            ) === null,
            'copied authority cannot bypass capture',
        );
        window.dispatchEvent(new Event('blur'));
        CHECK(!STATE.sample('move').held, 'independent input blur release');
        const PREDICTED = new Actor();
        PREDICTED.x = 64;
        RUNTIME.selectPreview([
            {
                id: 'actor',
                generation: 0,
            },
        ]);
        RUNTIME.capturePreview(
            {
                revision: 0,
                sequence: 0,
                timeMs: 150,
                entities: [
                    {
                        id: 'actor',
                        generation: 0,
                        source: PREDICTED,
                    },
                ],
            },
            150,
        );
        const PREVIEW_MODEL = RUNTIME.sample('actor', 0, 175);
        CHECK(
            PREVIEW_MODEL.x === 40 &&
                RUNTIME.modelFor(PREDICTED, 175) === PREVIEW_MODEL &&
                RUNTIME.sample('actor', 0, 175).x === 40,
            'body/HUD share same-time preview value and model',
        );
        PREDICTED.x = 56;
        RUNTIME.capturePreview(
            {
                revision: 0,
                sequence: 1,
                timeMs: 175,
                entities: [
                    {
                        id: 'actor',
                        generation: 0,
                        source: PREDICTED,
                    },
                ],
            },
            175,
        );
        CHECK(
            RUNTIME.sample('actor', 0, 175) === PREVIEW_MODEL && PREVIEW_MODEL.x === 40,
            'same-time preview recapture starts at displayed pose',
        );
        RENDERER.beginFrame({ clearColor: [0, 0, 0, 1] });
        RUNTIME.render(ACTOR, RENDERER, 225);
        RENDERER.endFrame();
        const PREVIEW_PIXEL = new Uint8Array(4);
        DEVICE.gl.readPixels(48, 32, 1, 1, DEVICE.gl.RGBA, DEVICE.gl.UNSIGNED_BYTE, PREVIEW_PIXEL);
        CHECK(
            PREVIEW_MODEL.x === 48 && PREVIEW_PIXEL[1] > 240 && ACTOR.x === 48,
            'recaptured preview reaches new midpoint through WebGL without changing authority',
        );
        RUNTIME.releasePreview(225);
        CHECK(RUNTIME.sample('actor', 0, 225).x === 48, 'same-time preview release preserves displayed pose');
        RUNTIME.capture(
            {
                revision: 0,
                sequence: 2,
                timeMs: 250,
                entities: [],
            },
            250,
        );
        CHECK(RUNTIME.modelFor(MODEL, 250) === null, 'despawned model cannot render');
        class Spark extends RENDER_OBJECT {
            static renderSchema = {
                'point.u': this.POSITION_X,
                'point.v': this.POSITION_Y,
                'launch.a': this.ORIGIN_X,
                'launch.b': this.ORIGIN_Y,
                extent: this.SPAWN_LINEAR,
            };
            point = {
                u: 48,
                v: 32,
            };
            launch = {
                a: 16,
                b: 32,
            };
            extent = 8;
            render(renderer, model) {
                renderer.fillStyle = [0, 0, 1, 1];
                renderer.fillRect(model.point.u - model.extent / 2, model.point.v - 2, model.extent, 4);
            }
        }
        const SPARK = new Spark(),
            SPARKS = new PRESENTATION_RUNTIME({
                stepMs: 100,
            });
        SPARKS.capture(
            {
                revision: 0,
                sequence: 0,
                timeMs: 0,
                entities: [
                    {
                        id: 'spark',
                        generation: 0,
                        source: SPARK,
                    },
                ],
            },
            0,
        );
        RENDERER.beginFrame({ clearColor: [0, 0, 0, 1] });
        SPARKS.render(SPARK, RENDERER, 50);
        RENDERER.endFrame();
        const SPAWNED = new Uint8Array(4);
        DEVICE.gl.readPixels(32, 32, 1, 1, DEVICE.gl.RGBA, DEVICE.gl.UNSIGNED_BYTE, SPAWNED);
        CHECK(
            SPAWNED[2] > 240 && SPAWNED[0] < 10,
            'generic origin roles draw newborn midpoint with foreign field names',
        );
        const RESULT = {
            pixel: [...PIXEL],
            spawnPixel: [...SPAWNED],
            previewPixel: [...PREVIEW_PIXEL],
            previewRecapture: true,
            fieldPolicies: true,
            nested: true,
            privateThis: true,
            detached: true,
            input: true,
            despawn: true,
        };
        INPUT.dispose();
        RENDERER.dispose();
        DEVICE.dispose();
        CANVAS.remove();
        return RESULT;
    });
}

import { ActionState, createDOMInput } from '../../dist/input.js';
import { Renderer2D } from '../../dist/rendering.js';
import { PresentationRuntime, RenderObject } from '../../dist/interpolation.js';
import { LocalInputPreview, createLoop } from '../../dist/simloop.js';

const DT = 1000 / 60, MIN_X = 24, MAX_X = 696;
class Unit extends RenderObject {
  constructor(color) { super(); this.x = 80; this.y = 100; this.direction = 1; this.roll = { progress: 0 }; this.flash = 0; this.color = color; }
  static renderSchema = { x: this.POSITION_X, y: this.POSITION_Y, direction: this.STEP, 'roll.progress': this.CYCLE, flash: this.DECAY, color: this.STEP };
  render(renderer, model) {
    renderer.rect(model.x, model.y, 24, 28, model.flash ? [1, .65, .2, 1] : model.color, 0);
    renderer.rect(model.x + model.direction * 13, model.y - 19, 11, 3, [1, 1, 1, .85], 0);
  }
}
function stepUnit(unit, input, commands = []) {
  const axis = input[0] === 1 ? -1 : input[0] === 2 ? 1 : 0;
  if (axis) unit.direction = axis;
  unit.x += axis * 1.2;
  if (commands.some(command => command.payload[0] === 1)) { unit.x += unit.direction * 22; unit.roll.progress = .01; unit.flash = 1; }
  else { unit.roll.progress = (unit.roll.progress + .18) % 1; unit.flash = Math.max(0, unit.flash - .2); }
  if (unit.x < MIN_X || unit.x > MAX_X) { unit.x = Math.max(MIN_X, Math.min(MAX_X, unit.x)); unit.direction *= -1; unit.flash = 1; }
}
function bytes(state) { return { x: state.x, y: state.y, direction: state.direction, roll: { ...state.roll }, flash: state.flash }; }

export function startInputPreviewDemo(canvas, status) {
  const renderer = new Renderer2D(canvas, { antialias: false, preserveDrawingBuffer: true });
  renderer.resize(canvas.clientWidth, canvas.clientHeight, devicePixelRatio || 1);
  const inputState = new ActionState();
  const domInput = createDOMInput({ target: canvas, state: inputState, keys: { KeyA: 'left', ArrowLeft: 'left', KeyD: 'right', ArrowRight: 'right', Space: 'roll' } });
  const presentation = new PresentationRuntime({ stepMs: DT, snapDistance: 180 });
  const authorityUnit = new Unit([.25, .55, 1, 1]), remoteUnit = new Unit([.9, .25, .25, 1]);
  remoteUnit.x = 575; remoteUnit.y = 150;
  let revision = 0, sequence = 0, commandSequence = 0, confirmedCommandSequence = 0, tick = 0, epoch = 0, lastConfirm = 0, queue = [], queuedCommands = [], paused = false, frames = 0, predictionEnabled = true;
  const session = {
    inputSize: 1, profile: { tickRate: 1000 / DT, maxCatchupSteps: 4 }, pace: 1, tick: 0, epoch: 0, closed: false, resimulating: false,
    poll() {
      const now = performance.now();
      if (queue.length && now - queue[0].at >= 180) {
        const item = queue.shift(); stepUnit(authorityUnit, item.input, item.commands); tick++; lastConfirm = item.sequence; sequence++;
        if (item.commands.length) confirmedCommandSequence = item.commands[item.commands.length - 1].sequence;
        presentation.capture({ revision, sequence, timeMs: tick * DT, entities: [
          { id: 'local', generation: 0, source: authorityUnit }, { id: 'remote', generation: 0, source: remoteUnit },
        ] }, now);
        preview.reconcile({ snapshot: { unit: bytes(authorityUnit) }, revision, tick, epoch, confirmedSequence: lastConfirm, confirmedCommandSequence, timeMs: now, mode: 'continuous' });
      }
    },
    queueCommand(payload) { const id = ++commandSequence; queuedCommands.push({ sequence: id, payload: payload.slice() }); return id; },
    advance(input) { const id = ++sequence; queue.push({ sequence: id, input: Uint8Array.from(input), commands: queuedCommands.splice(0), at: performance.now() }); this.tick++; return { status: 'advanced', tick: this.tick }; },
    releaseInput() { queue.length = 0; queuedCommands.length = 0; },
  };
  const preview = new LocalInputPreview({ presentation,
    createFork: snapshot => { const unit = Object.assign(new Unit([.15, 1, .55, 1]), snapshot.unit); return { unit, step: (input, context) => stepUnit(unit, input, context.commands) }; },
    cloneSnapshot: snapshot => structuredClone(snapshot), readEntities: fork => [{ id: 'local', generation: 0, source: fork.unit }],
    maxPendingInputs: 64, maxFutureTicks: 64, maxAgeMs: 1500,
  });
  presentation.capture({ revision: 0, sequence: 0, timeMs: 0, entities: [
    { id: 'local', generation: 0, source: authorityUnit }, { id: 'remote', generation: 0, source: remoteUnit },
  ] }, performance.now());
  preview.reconcile({ snapshot: { unit: bytes(authorityUnit) }, revision: 0, tick: 0, epoch, confirmedCommandSequence, timeMs: performance.now(), mode: 'reset' });
  let pose = {};
  const loop = createLoop({ session, inputPreview: preview, canAdvance: () => !paused,
    getInput() { const left = inputState.sample('left').held, right = inputState.sample('right').held; const roll = inputState.sample('roll').pressed;
      inputState.consume(); return { input: Uint8Array.of(left === right ? 0 : left ? 1 : 2), commands: roll ? [{ payload: Uint8Array.of(1) }] : [] }; },
    render({ alpha }) {
      frames++; const now = performance.now(); renderer.beginFrame([.035, .07, .09, 1]);
      renderer.rect(360, 115, 650, 2, [.25, .36, .4, 1]);
      presentation.render(authorityUnit, renderer, now); presentation.render(remoteUnit, renderer, now);
      renderer.endFrame(); const model = presentation.modelFor(authorityUnit, now); if (model) pose = model;
      status.textContent = `authority x=${authorityUnit.x.toFixed(1)} · displayed x=${pose.x?.toFixed(1) ?? '—'} · tick=${tick} · pending=${preview.pendingCount}\npreview=${predictionEnabled ? 'on' : 'off'} · frame=${frames} · alpha=${alpha.toFixed(2)} · correction=${preview.metrics.corrections} · snapshot bytes=${preview.metrics.snapshotBytes}`;
    },
  });
  preview.reconcile({ snapshot: { unit: bytes(authorityUnit) }, revision: 0, tick: 0, epoch, confirmedCommandSequence, timeMs: performance.now(), mode: 'reset' });
  loop.start();
  return {
    renderer, presentation, preview, session, get diagnostics() { return { authorityX: authorityUnit.x, displayedX: pose.x, remoteX: remoteUnit.x, tick, pending: preview.pendingCount, frames, metrics: preview.metrics, presentationMetrics: presentation.previewMetrics, lastConfirm, confirmedCommandSequence }; },
    setPreview(enabled) { predictionEnabled = enabled; preview.setEnabled(enabled); if (enabled) preview.reconcile({ snapshot: { unit: bytes(authorityUnit) }, revision, tick, epoch, confirmedSequence: lastConfirm, confirmedCommandSequence, timeMs: performance.now(), mode: 'reset' }); },
    forceCollision() { authorityUnit.x = MAX_X - 1; authorityUnit.direction = 1; stepUnit(authorityUnit, Uint8Array.of(2), []); tick++; sequence++; presentation.capture({ revision, sequence, timeMs: tick * DT, entities: [
      { id: 'local', generation: 0, source: authorityUnit }, { id: 'remote', generation: 0, source: remoteUnit },
    ] }, performance.now()); preview.reconcile({ snapshot: { unit: bytes(authorityUnit) }, revision, tick, epoch, confirmedSequence: lastConfirm, confirmedCommandSequence, timeMs: performance.now(), mode: 'continuous' }); },
    clockGap() { loop.pulse(performance.now() + 5000); preview.reconcile({ snapshot: { unit: bytes(authorityUnit) }, revision, tick, epoch,
      confirmedSequence: lastConfirm, confirmedCommandSequence, timeMs: performance.now(), mode: 'resync' }); },
    restart() { queue.length = 0; queuedCommands.length = 0; epoch++; session.epoch = epoch; revision++; sequence = 0; tick = 0; session.tick = 0; authorityUnit.x = 80; authorityUnit.direction = 1; authorityUnit.flash = 0;
      loop.resetTiming(); presentation.capture({ revision, sequence, timeMs: 0, mode: 'reset', entities: [
        { id: 'local', generation: 0, source: authorityUnit }, { id: 'remote', generation: 0, source: remoteUnit },
      ] }, performance.now()); preview.reconcile({ snapshot: { unit: bytes(authorityUnit) }, revision, tick, epoch, confirmedCommandSequence, timeMs: performance.now(), mode: 'join' }); },
    dispose() { paused = true; loop.stop(); preview.dispose(); domInput.dispose(); renderer.dispose(); },
  };
}

import { createScenario } from './scenario.js';

// Presentation host only. The consumer owns its real gameplay simulation, commands and scene data.
// An isolated same-origin frame prevents showcase commands from entering the playable session.
const DEMO_PARAMETER = 'showcaseDemo';
const ROUTE = '#/showcase';

function element(name, className = '', label = '') {
    const NODE = document.createElement(name);
    if (className) {
        NODE.className = className;
    }
    if (label) {
        NODE.textContent = label;
    }
    return NODE;
}

function sendKey(win, code, down) {
    const KEY =
        code === 'Space'
            ? ' '
            : code.startsWith('Key')
              ? code.slice(3).toLowerCase()
              : code.startsWith('Digit')
                ? code.slice(5)
                : code;
    const EVENT = new win.KeyboardEvent(down ? 'keydown' : 'keyup', {
        bubbles: true,
        cancelable: true,
        code,
        key: KEY,
        repeat: false,
    });
    win.document.dispatchEvent(EVENT);
}

function point(win, selector, phase, u = 0.5, v = 0.5) {
    const TARGET = win.document.querySelector(selector);
    if (!TARGET) {
        return false;
    }
    const BOUNDS = TARGET.getBoundingClientRect();
    if (!BOUNDS.width || !BOUNDS.height) {
        return false;
    }
    const X = BOUNDS.left + BOUNDS.width * u;
    const Y = BOUNDS.top + BOUNDS.height * v;
    const EVENT = new win.PointerEvent(phase, {
        bubbles: true,
        cancelable: true,
        composed: true,
        pointerId: 71,
        pointerType: 'mouse',
        isPrimary: true,
        button: 0,
        buttons: phase === 'pointerup' ? 0 : 1,
        clientX: X,
        clientY: Y,
    });
    TARGET.dispatchEvent(EVENT);
    return true;
}

function execute(win, event, custom) {
    if (event.action === 'chapter') {
        return true;
    }
    if (event.action === 'custom') {
        return custom ? custom(event.name, win) !== false : true;
    }
    if (event.action === 'click') {
        const TARGET = win.document.querySelector(event.selector);
        if (!TARGET || TARGET.disabled) {
            return false;
        }
        TARGET.click();
        return true;
    }
    if (event.action === 'select') {
        const TARGET = win.document.querySelector(event.selector);
        if (!TARGET) {
            return false;
        }
        TARGET.value = event.value;
        TARGET.dispatchEvent(new win.Event('input', { bubbles: true }));
        TARGET.dispatchEvent(new win.Event('change', { bubbles: true }));
        return true;
    }
    if (event.action === 'key') {
        sendKey(win, event.code, event.down);
        return true;
    }
    if (event.action === 'pointer') {
        return point(win, event.selector, event.phase, event.u, event.v);
    }
    if (event.action === 'draw') {
        const TARGET = win.document.querySelector(event.selector);
        if (!TARGET) {
            return false;
        }
        const SHAPE = event.shape || 'circle';
        const TOTAL = SHAPE === 'line' ? 18 : 48;
        for (let index = 0; index <= TOTAL; index++) {
            const T = index / TOTAL;
            const U = SHAPE === 'line' ? 0.24 + T * 0.5 : 0.51 + Math.cos(T * Math.PI * 2) * 0.1;
            const V = SHAPE === 'line' ? 0.6 - T * 0.26 : 0.47 + Math.sin(T * Math.PI * 2) * 0.14;
            const PHASE = index === 0 ? 'pointerdown' : index === TOTAL ? 'pointerup' : 'pointermove';
            if (!point(win, event.selector, PHASE, U, V)) {
                return false;
            }
        }
        return true;
    }
    return true;
}

function style() {
    const TAG = document.createElement('style');
    TAG.textContent = `
    .bloom-showcase-link{min-height:44px;min-width:44px;touch-action:manipulation;cursor:pointer;border:1px solid currentColor;border-radius:10px;background:transparent;color:inherit;padding:10px 18px;font:inherit;font-weight:700;opacity:.95}
    .bloom-showcase-link:hover{opacity:1;filter:brightness(1.15)}
    #bloom-showcase{position:fixed;z-index:2147483000;inset:0;display:flex;align-items:center;justify-content:center;padding:max(12px,env(safe-area-inset-top)) max(12px,env(safe-area-inset-right)) max(12px,env(safe-area-inset-bottom)) max(12px,env(safe-area-inset-left));background:#080c0def;color:#f1f5ef;font-family:system-ui,-apple-system,"Malgun Gothic",sans-serif}
    #bloom-showcase[hidden]{display:none!important}
    #bloom-showcase *{box-sizing:border-box}
    .bloom-showcase-shell{width:min(1120px,100%);height:min(760px,100%);min-height:0;display:grid;grid-template-rows:auto minmax(0,1fr) auto;gap:12px}
    .bloom-showcase-head{display:flex;align-items:center;justify-content:space-between;gap:12px}
    .bloom-showcase-name{font-size:clamp(13px,2vw,19px);font-weight:800;letter-spacing:-.025em}
    .bloom-showcase-controls{display:flex;gap:8px;align-items:center}
    .bloom-showcase-controls button,.bloom-showcase-foot button{min-height:44px;min-width:44px;padding:9px 14px;border-radius:10px;border:1px solid #65756b;background:#1a2620;color:#f4f7f1;font:inherit;font-size:13px;font-weight:700;cursor:pointer;touch-action:manipulation}
    .bloom-showcase-controls button:hover,.bloom-showcase-foot button:hover{background:#283c2f}
    .bloom-showcase-stage{position:relative;min-height:0;overflow:hidden;border:1px solid #42564b;border-radius:18px;background:#111c18}
    .bloom-showcase-stage iframe{display:block;border:0;width:100%;height:100%;pointer-events:none}
    .bloom-showcase-stage::after{content:"";position:absolute;inset:0;pointer-events:none;box-shadow:inset 0 0 70px #090e1299}
    .bloom-showcase-foot{display:grid;gap:9px}
    .bloom-showcase-caption h2{margin:0;font-size:clamp(16px,2.8vw,27px);font-weight:850;line-height:1.2}
    .bloom-showcase-caption p{margin:5px 0 0;font-size:clamp(12px,1.7vw,15px);color:#b9c9bc;line-height:1.5}
    .bloom-showcase-row{display:flex;justify-content:space-between;align-items:center;gap:12px}
    .bloom-showcase-row strong{font-size:12px;color:#b8c9c0;font-variant-numeric:tabular-nums}
    .bloom-showcase-foot .bloom-showcase-play{background:#d3f576;border-color:#d3f576;color:#16241a;font-weight:850}
    .bloom-showcase-track{height:4px;width:100%;background:#385043;border-radius:2px;overflow:hidden}
    .bloom-showcase-track span{display:block;background:#d3f576;width:0;height:100%;transition:width .08s linear}
    #bloom-showcase button:focus-visible{outline:3px solid #d3f576;outline-offset:3px}
    @media(max-height:520px){.bloom-showcase-shell{gap:4px}.bloom-showcase-head{min-height:44px}.bloom-showcase-caption p{margin:1px 0}.bloom-showcase-foot{gap:3px}.bloom-showcase-stage{border-radius:10px}}
    @media(prefers-reduced-motion:reduce){.bloom-showcase-track span{transition:none}}
    `;
    document.head.append(TAG);
    return TAG;
}

export function installShowcase({
    title,
    launcher,
    timeline,
    durationMs = 27000,
    readyTimeoutMs = 15000,
    playSelector,
    custom,
    ready = () => true,
} = {}) {
    if (new URLSearchParams(location.search).get(DEMO_PARAMETER) === '1') {
        return null;
    }
    if (!title || !launcher || !Array.isArray(timeline) || durationMs < 1000) {
        throw new TypeError('showcase configuration');
    }
    const CSS = style();
    const ROOT = element('section');
    ROOT.id = 'bloom-showcase';
    ROOT.hidden = true;
    ROOT.setAttribute('role', 'dialog');
    ROOT.setAttribute('aria-modal', 'true');
    ROOT.setAttribute('aria-label', title + ' 소개');
    ROOT.innerHTML = `
       <div class="bloom-showcase-shell">
         <header class="bloom-showcase-head"><strong class="bloom-showcase-name"></strong>
           <nav class="bloom-showcase-controls" aria-label="소개 재생 제어">
             <button type="button" data-action="pause">일시정지</button>
             <button type="button" data-action="replay">다시 보기</button>
             <button type="button" data-action="close">닫기</button>
           </nav>
         </header>
         <div class="bloom-showcase-stage" data-viewport></div>
         <footer class="bloom-showcase-foot">
           <div class="bloom-showcase-caption"><h2 data-copy>실제 플레이 소개</h2><p data-sub>게임을 준비하는 중입니다.</p></div>
           <div class="bloom-showcase-row"><strong data-time>0초</strong><button class="bloom-showcase-play" type="button" data-action="play">직접 플레이</button></div>
           <div class="bloom-showcase-track" aria-hidden="true"><span data-progress></span></div>
         </footer>
       </div>`;
    document.body.append(ROOT);
    const PICK = (s) => ROOT.querySelector(s);
    const VIEWPORT = PICK('[data-viewport]');
    const NAME = PICK('.bloom-showcase-name');
    const HEADING = PICK('[data-copy]');
    const SUBTITLE = PICK('[data-sub]');
    const PROGRESS = PICK('[data-progress]');
    const TIME = PICK('[data-time]');
    const PAUSE_BUTTON = PICK('[data-action=pause]');
    NAME.textContent = title + ' · 플레이 소개';
    const LAUNCH_BUTTON = element('button', 'bloom-showcase-link', '▶ 소개 보기');
    LAUNCH_BUTTON.type = 'button';
    LAUNCH_BUTTON.setAttribute('aria-label', title + ' 플레이 소개 보기');
    let frame = null,
        runner = null,
        focus = null,
        previousUrl = null;
    let held = new Set(),
        restored = [];

    const IS_OPEN = () => !ROOT.hidden;
    const CONTENT_WINDOW = () => frame?.contentWindow || null;
    function restoreBackground() {
        for (const [NODE, VALUE] of restored) {
            NODE.inert = VALUE;
        }
        restored = [];
    }
    function destroy() {
        runner?.dispose();
        runner = null;
        const WIN = CONTENT_WINDOW();
        if (WIN && WIN.document) {
            for (const CODE of held) {
                sendKey(WIN, CODE, false);
            }
        }
        held = new Set();
        frame?.remove();
        frame = null;
        VIEWPORT.replaceChildren();
    }
    function stop(clearRoute = true) {
        if (!IS_OPEN()) {
            return;
        }
        destroy();
        ROOT.hidden = true;
        restoreBackground();
        if (clearRoute && location.hash === ROUTE) {
            history.replaceState(null, '', previousUrl || location.pathname + location.search);
        }
        focus?.focus?.({ preventScroll: true });
        focus = null;
        window.dispatchEvent(new Event('bloom-showcase-closed'));
    }
    async function mount() {
        destroy();
        HEADING.textContent = '실제 플레이 소개';
        SUBTITLE.textContent = '게임을 준비하는 중입니다.';
        TIME.textContent = '0 / ' + Math.ceil(durationMs / 1000) + '초';
        PROGRESS.style.width = '0%';
        PAUSE_BUTTON.textContent = '일시정지';
        const INTRO_URL = new URL(location.href);
        INTRO_URL.searchParams.set(DEMO_PARAMETER, '1');
        INTRO_URL.hash = '';
        const NEXT = document.createElement('iframe');
        NEXT.title = title + ' 격리된 실제 플레이';
        NEXT.tabIndex = -1;
        NEXT.allow = 'autoplay';
        NEXT.src = INTRO_URL.href;
        frame = NEXT;
        VIEWPORT.replaceChildren(frame);
        await new Promise((resolve, reject) => {
            NEXT.addEventListener('load', resolve, { once: true });
            NEXT.addEventListener('error', () => reject(new Error('소개 게임을 불러오지 못했습니다')), { once: true });
        });
        if (!IS_OPEN() || NEXT !== frame) {
            return;
        }
        const WIN = CONTENT_WINDOW();
        const LOADED_AT = performance.now();
        await new Promise((resolve, reject) => {
            const CHECK = () => {
                if (!IS_OPEN() || NEXT !== frame) {
                    resolve();
                    return;
                }
                try {
                    if (ready(WIN)) {
                        resolve();
                        return;
                    }
                } catch {
                    /* Optional readiness probes may throw before the game loads. */
                }
                if (performance.now() - LOADED_AT > readyTimeoutMs) {
                    reject(new Error('실제 게임 준비 시간이 초과되었습니다'));
                    return;
                }
                requestAnimationFrame(CHECK);
            };
            CHECK();
        });
        if (!IS_OPEN() || NEXT !== frame) {
            return;
        }
        const QUEUE = [];
        runner = createScenario({
            definition: {
                seed: 28101,
                tickRate: 30,
                endTick: Math.ceil((durationMs * 30) / 1000),
                timeline,
            },
            createRun() {
                return {
                    initialize({ events }) {
                        QUEUE.push(...events);
                    },
                    step({ events, timeMs }) {
                        QUEUE.push(...events);
                        for (let i = 0; i < QUEUE.length;) {
                            const EVENT = QUEUE[i];
                            if (EVENT.action === 'chapter') {
                                HEADING.textContent = EVENT.title || title;
                                SUBTITLE.textContent = EVENT.caption || '';
                                QUEUE.splice(i, 1);
                                continue;
                            }
                            if (execute(WIN, EVENT, custom)) {
                                if (EVENT.action === 'key') {
                                    if (EVENT.down) {
                                        held.add(EVENT.code);
                                    } else {
                                        held.delete(EVENT.code);
                                    }
                                }
                                QUEUE.splice(i, 1);
                                continue;
                            }
                            if (timeMs - (EVENT.atMs || 0) > 6000) {
                                QUEUE.splice(i, 1);
                                continue;
                            }
                            break;
                        }
                    },
                    render({ timeMs }) {
                        const ELAPSED = Math.min(durationMs, timeMs);
                        TIME.textContent = Math.floor(ELAPSED / 1000) + ' / ' + Math.ceil(durationMs / 1000) + '초';
                        PROGRESS.style.width = Math.min(100, (ELAPSED / durationMs) * 100) + '%';
                    },
                    pause() {
                        PAUSE_BUTTON.textContent = '이어 보기';
                    },
                    dispose() {
                        QUEUE.length = 0;
                    },
                };
            },
            onEnd() {
                if (!IS_OPEN()) {
                    return;
                }
                HEADING.textContent = title;
                SUBTITLE.textContent = '소개가 끝났습니다. 바로 플레이하거나 다시 볼 수 있습니다.';
                PAUSE_BUTTON.disabled = true;
            },
        });
        PAUSE_BUTTON.disabled = false;
        runner.play();
    }
    function open(viaButton) {
        if (IS_OPEN()) {
            return;
        }
        previousUrl = viaButton ? location.href : location.pathname + location.search;
        focus = viaButton ? LAUNCH_BUTTON : document.activeElement;
        if (viaButton) {
            history.pushState(null, '', location.pathname + location.search + ROUTE);
        }
        ROOT.hidden = false;
        restored = [...document.body.children]
            .filter((n) => n !== ROOT && n.tagName !== 'SCRIPT')
            .map((n) => [n, n.inert]);
        for (const [NODE] of restored) {
            NODE.inert = true;
        }
        PICK('[data-action=close]').focus({ preventScroll: true });
        window.dispatchEvent(new Event('bloom-showcase-opened'));
        void mount().catch((error) => {
            if (!IS_OPEN()) {
                return;
            }
            HEADING.textContent = '소개를 실행하지 못했습니다';
            SUBTITLE.textContent = String(error.message || error);
            console.warn('[BLOOM showcase]', error);
        });
    }
    function syncRoute() {
        if (location.hash === ROUTE) {
            if (!IS_OPEN()) {
                open(false);
            }
        } else if (IS_OPEN()) {
            stop(false);
        }
    }
    LAUNCH_BUTTON.onclick = () => open(true);
    PICK('[data-action=close]').onclick = () => stop();
    PICK('[data-action=replay]').onclick = () => {
        if (IS_OPEN()) {
            void mount().catch((error) => {
                SUBTITLE.textContent = String(error.message || error);
            });
        }
    };
    PAUSE_BUTTON.onclick = () => {
        if (!runner) {
            return;
        }
        if (runner.state === 'playing') {
            runner.pause();
        } else if (runner.state === 'paused') {
            runner.play();
        }
        PAUSE_BUTTON.textContent = runner.state === 'playing' ? '일시정지' : '이어 보기';
    };
    PICK('[data-action=play]').onclick = () => {
        stop();
        const TARGET = playSelector && document.querySelector(playSelector);
        if (TARGET && !TARGET.disabled) {
            TARGET.click();
        } else {
            LAUNCH_BUTTON.focus({ preventScroll: true });
        }
    };
    const ON_KEY = (event) => {
        if (!IS_OPEN()) {
            return;
        }
        if (event.key === 'Escape') {
            event.preventDefault();
            event.stopImmediatePropagation();
            stop();
            return;
        }
        if (event.key !== 'Tab') {
            return;
        }
        const BUTTONS = [...ROOT.querySelectorAll('button:not(:disabled)')];
        const FIRST = BUTTONS[0],
            LAST = BUTTONS.at(-1);
        if (event.shiftKey && document.activeElement === FIRST) {
            event.preventDefault();
            LAST.focus();
        } else if (!event.shiftKey && document.activeElement === LAST) {
            event.preventDefault();
            FIRST.focus();
        }
    };
    document.addEventListener('keydown', ON_KEY, true);
    window.addEventListener('popstate', syncRoute);
    window.addEventListener('hashchange', syncRoute);
    const OBSERVER = new MutationObserver(() => attach());
    function attach() {
        if (LAUNCH_BUTTON.isConnected) {
            return;
        }
        const ANCHOR = document.querySelector(launcher);
        if (ANCHOR && !ANCHOR.closest('#bloom-showcase')) {
            ANCHOR.insertAdjacentElement('afterend', LAUNCH_BUTTON);
        }
    }
    OBSERVER.observe(document.body, { subtree: true, childList: true });
    attach();
    queueMicrotask(syncRoute);
    return {
        open: () => open(true),
        close: stop,
        dispose() {
            stop();
            OBSERVER.disconnect();
            document.removeEventListener('keydown', ON_KEY, true);
            window.removeEventListener('popstate', syncRoute);
            window.removeEventListener('hashchange', syncRoute);
            LAUNCH_BUTTON.remove();
            ROOT.remove();
            CSS.remove();
        },
        get active() {
            return IS_OPEN();
        },
    };
}

import { createScenario } from './scenario.js';

// Presentation host only. The consumer owns its real gameplay simulation, commands and scene data.
// An isolated same-origin frame prevents showcase commands from entering the playable session.
const DEMO_PARAMETER = 'showcaseDemo';
const ROUTE = '#/showcase';

function element(name, className = '', label = '') {
    const node = document.createElement(name);
    if (className) node.className = className;
    if (label) node.textContent = label;
    return node;
}

function sendKey(win, code, down) {
    const key =
        code === 'Space'
            ? ' '
            : code.startsWith('Key')
              ? code.slice(3).toLowerCase()
              : code.startsWith('Digit')
                ? code.slice(5)
                : code;
    const event = new win.KeyboardEvent(down ? 'keydown' : 'keyup', {
        bubbles: true,
        cancelable: true,
        code,
        key,
        repeat: false,
    });
    win.document.dispatchEvent(event);
}

function point(win, selector, phase, u = 0.5, v = 0.5) {
    const target = win.document.querySelector(selector);
    if (!target) return false;
    const bounds = target.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return false;
    const x = bounds.left + bounds.width * u;
    const y = bounds.top + bounds.height * v;
    const event = new win.PointerEvent(phase, {
        bubbles: true,
        cancelable: true,
        composed: true,
        pointerId: 71,
        pointerType: 'mouse',
        isPrimary: true,
        button: 0,
        buttons: phase === 'pointerup' ? 0 : 1,
        clientX: x,
        clientY: y,
    });
    target.dispatchEvent(event);
    return true;
}

function execute(win, event, custom) {
    if (event.action === 'chapter') return true;
    if (event.action === 'custom') return custom ? custom(event.name, win) !== false : true;
    if (event.action === 'click') {
        const target = win.document.querySelector(event.selector);
        if (!target || target.disabled) return false;
        target.click();
        return true;
    }
    if (event.action === 'select') {
        const target = win.document.querySelector(event.selector);
        if (!target) return false;
        target.value = event.value;
        target.dispatchEvent(new win.Event('input', { bubbles: true }));
        target.dispatchEvent(new win.Event('change', { bubbles: true }));
        return true;
    }
    if (event.action === 'key') {
        sendKey(win, event.code, event.down);
        return true;
    }
    if (event.action === 'pointer') return point(win, event.selector, event.phase, event.u, event.v);
    if (event.action === 'draw') {
        const target = win.document.querySelector(event.selector);
        if (!target) return false;
        const shape = event.shape || 'circle';
        const total = shape === 'line' ? 18 : 48;
        for (let index = 0; index <= total; index++) {
            const t = index / total;
            const u = shape === 'line' ? 0.24 + t * 0.5 : 0.51 + Math.cos(t * Math.PI * 2) * 0.1;
            const v = shape === 'line' ? 0.6 - t * 0.26 : 0.47 + Math.sin(t * Math.PI * 2) * 0.14;
            const phase = index === 0 ? 'pointerdown' : index === total ? 'pointerup' : 'pointermove';
            if (!point(win, event.selector, phase, u, v)) return false;
        }
        return true;
    }
    return true;
}

function style() {
    const tag = document.createElement('style');
    tag.textContent = `
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
    document.head.append(tag);
    return tag;
}

export function installShowcase({
    title,
    launcher,
    timeline,
    durationMs = 27000,
    playSelector,
    custom,
    ready = () => true,
} = {}) {
    if (new URLSearchParams(location.search).get(DEMO_PARAMETER) === '1') return null;
    if (!title || !launcher || !Array.isArray(timeline) || durationMs < 1000)
        throw new TypeError('showcase configuration');
    const css = style();
    const root = element('section');
    root.id = 'bloom-showcase';
    root.hidden = true;
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.setAttribute('aria-label', title + ' 소개');
    root.innerHTML = `
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
    document.body.append(root);
    const pick = (s) => root.querySelector(s);
    const viewport = pick('[data-viewport]');
    const name = pick('.bloom-showcase-name');
    const heading = pick('[data-copy]');
    const subtitle = pick('[data-sub]');
    const progress = pick('[data-progress]');
    const time = pick('[data-time]');
    const pauseButton = pick('[data-action=pause]');
    name.textContent = title + ' · 플레이 소개';
    const launchButton = element('button', 'bloom-showcase-link', '▶ 소개 보기');
    launchButton.type = 'button';
    launchButton.setAttribute('aria-label', title + ' 플레이 소개 보기');
    let frame = null,
        runner = null,
        opening = false,
        focus = null,
        previousUrl = null;
    let held = new Set(),
        restored = [],
        live = false,
        stopped = false;
    const isOpen = () => !root.hidden;
    const contentWindow = () => frame?.contentWindow || null;
    function restoreBackground() {
        for (const [node, value] of restored) node.inert = value;
        restored = [];
    }
    function destroy() {
        runner?.dispose();
        runner = null;
        const win = contentWindow();
        if (win && win.document) for (const code of held) sendKey(win, code, false);
        held = new Set();
        frame?.remove();
        frame = null;
        viewport.replaceChildren();
    }
    function stop(clearRoute = true) {
        if (!isOpen()) return;
        destroy();
        root.hidden = true;
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
        live = false;
        stopped = false;
        heading.textContent = '실제 플레이 소개';
        subtitle.textContent = '게임을 준비하는 중입니다.';
        time.textContent = '0 / ' + Math.ceil(durationMs / 1000) + '초';
        progress.style.width = '0%';
        pauseButton.textContent = '일시정지';
        const url = new URL(location.href);
        url.searchParams.set(DEMO_PARAMETER, '1');
        url.hash = '';
        const next = document.createElement('iframe');
        next.title = title + ' 격리된 실제 플레이';
        next.tabIndex = -1;
        next.allow = 'autoplay';
        next.src = url.href;
        frame = next;
        viewport.replaceChildren(frame);
        await new Promise((resolve, reject) => {
            next.addEventListener('load', resolve, { once: true });
            next.addEventListener('error', () => reject(new Error('소개 게임을 불러오지 못했습니다')), { once: true });
        });
        if (!isOpen() || next !== frame) return;
        const win = contentWindow();
        const loadedAt = performance.now();
        await new Promise((resolve, reject) => {
            const check = () => {
                if (!isOpen() || next !== frame) {
                    resolve();
                    return;
                }
                try {
                    if (ready(win)) {
                        resolve();
                        return;
                    }
                } catch {}
                if (performance.now() - loadedAt > 15000) {
                    reject(new Error('실제 게임 준비 시간이 초과되었습니다'));
                    return;
                }
                requestAnimationFrame(check);
            };
            check();
        });
        if (!isOpen() || next !== frame) return;
        const queue = [];
        let index = -1;
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
                        queue.push(...events);
                    },
                    step({ events, timeMs }) {
                        queue.push(...events);
                        for (let i = 0; i < queue.length;) {
                            const event = queue[i];
                            if (event.action === 'chapter') {
                                index = Math.max(0, Number(event.index) || 0);
                                heading.textContent = event.title || title;
                                subtitle.textContent = event.caption || '';
                                queue.splice(i, 1);
                                continue;
                            }
                            if (execute(win, event, custom)) {
                                if (event.action === 'key') {
                                    if (event.down) held.add(event.code);
                                    else held.delete(event.code);
                                }
                                queue.splice(i, 1);
                                continue;
                            }
                            if (timeMs - (event.atMs || 0) > 6000) {
                                queue.splice(i, 1);
                                continue;
                            }
                            break;
                        }
                    },
                    render({ timeMs }) {
                        const elapsed = Math.min(durationMs, timeMs);
                        time.textContent = Math.floor(elapsed / 1000) + ' / ' + Math.ceil(durationMs / 1000) + '초';
                        progress.style.width = Math.min(100, (elapsed / durationMs) * 100) + '%';
                    },
                    pause() {
                        pauseButton.textContent = '이어 보기';
                    },
                    dispose() {
                        queue.length = 0;
                    },
                };
            },
            onEnd() {
                if (!isOpen()) return;
                heading.textContent = title;
                subtitle.textContent = '소개가 끝났습니다. 바로 플레이하거나 다시 볼 수 있습니다.';
                pauseButton.disabled = true;
            },
        });
        pauseButton.disabled = false;
        runner.play();
        live = true;
    }
    function open(viaButton) {
        if (isOpen()) return;
        previousUrl = viaButton ? location.href : location.pathname + location.search;
        focus = viaButton ? launchButton : document.activeElement;
        if (viaButton) history.pushState(null, '', location.pathname + location.search + ROUTE);
        root.hidden = false;
        restored = [...document.body.children]
            .filter((n) => n !== root && n.tagName !== 'SCRIPT')
            .map((n) => [n, n.inert]);
        for (const [node] of restored) node.inert = true;
        pick('[data-action=close]').focus({ preventScroll: true });
        window.dispatchEvent(new Event('bloom-showcase-opened'));
        void mount().catch((error) => {
            if (!isOpen()) return;
            live = false;
            heading.textContent = '소개를 실행하지 못했습니다';
            subtitle.textContent = String(error.message || error);
            console.warn('[BLOOM showcase]', error);
        });
    }
    function syncRoute() {
        if (location.hash === ROUTE) {
            if (!isOpen()) open(false);
        } else if (isOpen()) stop(false);
    }
    launchButton.onclick = () => open(true);
    pick('[data-action=close]').onclick = () => stop();
    pick('[data-action=replay]').onclick = () => {
        if (isOpen())
            void mount().catch((error) => {
                subtitle.textContent = String(error.message || error);
            });
    };
    pauseButton.onclick = () => {
        if (!runner) return;
        if (runner.state === 'playing') runner.pause();
        else if (runner.state === 'paused') runner.play();
        pauseButton.textContent = runner.state === 'playing' ? '일시정지' : '이어 보기';
    };
    pick('[data-action=play]').onclick = () => {
        stop();
        const target = playSelector && document.querySelector(playSelector);
        if (target && !target.disabled) target.click();
        else launchButton.focus({ preventScroll: true });
    };
    const onKey = (event) => {
        if (!isOpen()) return;
        if (event.key === 'Escape') {
            event.preventDefault();
            event.stopImmediatePropagation();
            stop();
            return;
        }
        if (event.key !== 'Tab') return;
        const buttons = [...root.querySelectorAll('button:not(:disabled)')];
        const first = buttons[0],
            last = buttons.at(-1);
        if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
        }
    };
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('popstate', syncRoute);
    window.addEventListener('hashchange', syncRoute);
    const observer = new MutationObserver(() => attach());
    function attach() {
        if (launchButton.isConnected) return;
        const anchor = document.querySelector(launcher);
        if (anchor && !anchor.closest('#bloom-showcase')) anchor.insertAdjacentElement('afterend', launchButton);
    }
    observer.observe(document.body, { subtree: true, childList: true });
    attach();
    queueMicrotask(syncRoute);
    return {
        open: () => open(true),
        close: stop,
        dispose() {
            stop();
            observer.disconnect();
            document.removeEventListener('keydown', onKey, true);
            window.removeEventListener('popstate', syncRoute);
            window.removeEventListener('hashchange', syncRoute);
            launchButton.remove();
            root.remove();
            css.remove();
        },
        get active() {
            return isOpen();
        },
    };
}

// 선행 조건이 있는 성장 트리 화면(스탯·업그레이드·연구). 노드는 `requires`만 적고, 배치·연결선·상태 계산·상세·조건 칩·
// 주소 동기화·줌/팬은 이 모듈이 맡습니다. 규칙·비용·구매·그림·문구는 게임이 소유하며 모듈은 구매를 실행하지 않습니다.
// 분류(branch)마다 선행 깊이로 층을 나누고, 루트의 시작 위치를 맞춥니다. 크기와 무관하게 제스처로 줌/팬하며,
// 분류·상세·구매 영역은 지도 아래에 분리합니다(브라우저 스크롤이 생기지 않습니다).

const NODE = 72;
const GAP_MAIN = 44;
const GAP_CROSS = 20;
const PAD = 16;
const TOUCH_MIN = 56;
const MAX_SCALE = 1.6;
const DRAG_START = 6;
const STATES = Object.freeze(['owned', 'locked', 'available', 'waiting']);
const TEXT_KEYS = Object.freeze(['branch', 'name', 'state', 'buy', 'reason', 'prerequisite', 'level', 'map']);
const ROOT_POSITIONS = Object.freeze({
    center: [0.5, 0.5],
    top: [0.5, 0],
    bottom: [0.5, 1],
    left: [0, 0.5],
    right: [1, 0.5],
    'top-left': [0, 0],
    'top-right': [1, 0],
    'bottom-left': [0, 1],
    'bottom-right': [1, 1],
});
const STYLE_ID = 'bloom-tech-tree-style';
const STYLE = `
.bloom-tech{display:flex;flex-direction:column;gap:8px;width:100%;height:100%;min-height:0;box-sizing:border-box;color:var(--tt-fg,#e8eefc)}
.bloom-tech *{box-sizing:border-box}
.tt-tabs{display:flex;gap:6px;flex:none}
.tt-tabs[hidden]{display:none}
.tt-tab{flex:1;min-height:56px;border:2px solid var(--tt-line,#4a5a86);border-radius:12px;background:transparent;color:inherit;font:inherit;cursor:pointer}
.tt-tab[aria-selected=true]{background:var(--tt-accent,#ffd166);color:var(--tt-on-accent,#1b2238);border-color:var(--tt-accent,#ffd166)}
.tt-main{display:flex;flex-direction:column;flex:1;gap:8px;min-height:0}
.tt-view{position:relative;flex:1;min-height:0;min-width:0;overflow:clip;touch-action:none;border-radius:12px;background:var(--tt-bg,rgba(255,255,255,.04));user-select:none;-webkit-user-select:none}
.tt-view[data-pan=on]{cursor:grab}
.tt-world{position:absolute;left:0;top:0;transform-origin:0 0}
.tt-world[data-moving]{transition:transform .22s ease}
.tt-edges{position:absolute;left:0;top:0;overflow:visible;pointer-events:none}
.tt-edge{fill:none;stroke:var(--tt-line,#4a5a86);stroke-width:3;stroke-dasharray:6 6}
.tt-edge[data-met=true]{stroke:var(--tt-accent,#ffd166);stroke-dasharray:none;stroke-width:4}
.tt-node{position:absolute;width:${NODE}px;height:${NODE}px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;padding:4px;overflow:hidden;border:3px solid var(--tt-line,#4a5a86);border-radius:16px;background:var(--tt-node,#222b46);color:inherit;font:inherit;line-height:1.15;text-align:center;overflow-wrap:anywhere;cursor:pointer}
.tt-node[data-state=locked]{border-style:dashed;opacity:.62}
.tt-node[data-state=waiting]{border-style:solid}
.tt-node[data-state=available]{border-color:var(--tt-accent,#ffd166);box-shadow:0 0 0 3px color-mix(in srgb,var(--tt-accent,#ffd166) 35%,transparent)}
.tt-node[data-state=owned]{border-style:double;border-width:6px;border-color:var(--tt-accent,#ffd166)}
.tt-node[aria-pressed=true]{outline:3px solid var(--tt-fg,#e8eefc);outline-offset:3px}
.tt-view:focus-visible,.tt-node:focus-visible,.tt-tab:focus-visible,.tt-buy:focus-visible,.tt-req:focus-visible{outline:3px solid var(--tt-fg,#e8eefc);outline-offset:2px}
.tt-badge{font-size:11px;white-space:nowrap}
.tt-detail{flex:none;display:flex;flex-direction:column;gap:6px;padding:10px 12px;border-radius:12px;background:var(--tt-bg,rgba(255,255,255,.04));max-height:45%;overflow:auto}
.tt-head{display:flex;justify-content:space-between;gap:8px;font-weight:700}
.tt-reqs{display:flex;flex-wrap:wrap;gap:6px}
.tt-req{min-height:44px;padding:0 12px;border:2px solid var(--tt-line,#4a5a86);border-radius:999px;background:transparent;color:inherit;font:inherit;cursor:pointer}
.tt-req[data-met=true]{border-color:var(--tt-accent,#ffd166)}
.tt-reason{font-size:13px;opacity:.85}
.tt-buy{min-height:56px;border:0;border-radius:14px;background:var(--tt-accent,#ffd166);color:var(--tt-on-accent,#1b2238);font:700 16px/1 inherit;cursor:pointer}
.tt-buy:disabled{opacity:.45;cursor:default}
@media (prefers-reduced-motion:reduce){.tt-world[data-moving]{transition:none}}
`;

function fail(message) {
    throw new Error(`tech-tree: ${message}`);
}

function readOptions(options) {
    if (options === null || typeof options !== 'object') {
        fail('options object is required');
    }
    if (!options.root || typeof options.root.appendChild !== 'function') {
        fail('root must be an element');
    }
    if (typeof options.screen !== 'string' || options.screen === '') {
        fail('screen must be a non-empty string');
    }
    if (
        options.rootPosition !== undefined &&
        options.rootPosition !== 'auto' &&
        !Object.hasOwn(ROOT_POSITIONS, options.rootPosition)
    ) {
        fail('rootPosition must be auto, center, top, bottom, left, right or a corner');
    }
    const NAV = options.navigation;
    if (!NAV || ['snapshot', 'replace', 'subscribe'].some((name) => typeof NAV[name] !== 'function')) {
        fail('navigation must provide snapshot, replace and subscribe');
    }
    for (const KEY of ['level', 'canBuy', 'onBuy', 'renderNode', 'renderDetail']) {
        if (typeof options[KEY] !== 'function') {
            fail(`${KEY} must be a function`);
        }
    }
    for (const KEY of TEXT_KEYS) {
        if (typeof options.text?.[KEY] !== 'function') {
            fail(`text.${KEY} must be a function`);
        }
    }
    if (!Array.isArray(options.nodes) || options.nodes.length === 0) {
        fail('nodes must be a non-empty array');
    }
    const BY_ID = new Map();
    for (const NODE_DEF of options.nodes) {
        if (typeof NODE_DEF?.id !== 'string' || NODE_DEF.id === '' || BY_ID.has(NODE_DEF.id)) {
            fail(`node id must be a unique non-empty string: ${NODE_DEF?.id}`);
        }
        if (typeof NODE_DEF.branch !== 'string' || NODE_DEF.branch === '') {
            fail(`node ${NODE_DEF.id} needs a branch`);
        }
        if (!Number.isSafeInteger(NODE_DEF.max) || NODE_DEF.max < 1) {
            fail(`node ${NODE_DEF.id} max must be a positive integer`);
        }
        if (!Array.isArray(NODE_DEF.requires)) {
            fail(`node ${NODE_DEF.id} requires must be an array (empty for none)`);
        }
        BY_ID.set(NODE_DEF.id, NODE_DEF);
    }
    for (const NODE_DEF of options.nodes) {
        for (const ID of NODE_DEF.requires) {
            if (!BY_ID.has(ID) || ID === NODE_DEF.id) {
                fail(`node ${NODE_DEF.id} requires unknown node ${ID}`);
            }
        }
    }
    const VISIT = new Map();
    const WALK = (id, trail) => {
        if (VISIT.get(id) === 'done') {
            return;
        }
        if (VISIT.get(id) === 'open') {
            fail(`requires form a cycle: ${[...trail, id].join(' -> ')}`);
        }
        VISIT.set(id, 'open');
        for (const PARENT of BY_ID.get(id).requires) {
            WALK(PARENT, [...trail, id]);
        }
        VISIT.set(id, 'done');
    };
    for (const ID of BY_ID.keys()) {
        WALK(ID, []);
    }
    return BY_ID;
}

// 분류 하나의 층 나누기. 깊이 = 같은 분류 안 선행 조건의 최대 깊이 + 1. 같은 층은 부모 평균 위치로 한 번 정렬해 교차를 줄입니다.
function layoutBranch(nodes, orientation) {
    const IDS = new Set(nodes.map((node) => node.id));
    const DEPTH = new Map();
    const DEPTH_OF = (node) => {
        if (!DEPTH.has(node.id)) {
            const PARENTS = node.requires.filter((id) => IDS.has(id));
            DEPTH.set(
                node.id,
                PARENTS.length === 0
                    ? 0
                    : 1 + Math.max(...PARENTS.map((id) => DEPTH_OF(nodes.find((n) => n.id === id)))),
            );
        }
        return DEPTH.get(node.id);
    };
    const LAYERS = [];
    for (const NODE_DEF of nodes) {
        (LAYERS[DEPTH_OF(NODE_DEF)] ??= []).push(NODE_DEF);
    }
    const INDEX = new Map(LAYERS[0].map((node, index) => [node.id, index]));
    for (let depth = 1; depth < LAYERS.length; depth++) {
        const SCORE = (node) => {
            const PARENTS = node.requires.filter((id) => INDEX.has(id));
            return PARENTS.length === 0
                ? Infinity
                : PARENTS.reduce((sum, id) => sum + INDEX.get(id), 0) / PARENTS.length;
        };
        LAYERS[depth] = LAYERS[depth]
            .map((node, order) => ({ node, order, score: SCORE(node) }))
            .sort((a, b) => (a.score === b.score ? a.order - b.order : a.score - b.score))
            .map(({ node }) => node);
        LAYERS[depth].forEach((node, index) => INDEX.set(node.id, index));
    }
    const EXTENT = (count) => count * NODE + (count - 1) * GAP_CROSS;
    const CROSS = Math.max(...LAYERS.map((layer) => EXTENT(layer.length)));
    const MAIN = LAYERS.length * NODE + (LAYERS.length - 1) * GAP_MAIN;
    const POSITIONS = new Map();
    LAYERS.forEach((layer, depth) => {
        const START = (CROSS - EXTENT(layer.length)) / 2;
        layer.forEach((node, index) => {
            const MAIN_AT = PAD + depth * (NODE + GAP_MAIN);
            const CROSS_AT = PAD + START + index * (NODE + GAP_CROSS);
            POSITIONS.set(node.id, orientation === 'down' ? { x: CROSS_AT, y: MAIN_AT } : { x: MAIN_AT, y: CROSS_AT });
        });
    });
    const SIZE =
        orientation === 'down'
            ? { width: CROSS + PAD * 2, height: MAIN + PAD * 2 }
            : { width: MAIN + PAD * 2, height: CROSS + PAD * 2 };
    // 건너뛰는 선이 지나갈 빈 길: 층마다 노드 사이(양 끝 바깥 포함)의 가운데 좌표입니다.
    const GAPS = LAYERS.map((layer) => {
        const START = PAD + (CROSS - EXTENT(layer.length)) / 2;
        return [
            START - GAP_CROSS / 2,
            ...layer.map((_node, index) => START + index * (NODE + GAP_CROSS) + NODE + GAP_CROSS / 2),
        ];
    });
    return { positions: POSITIONS, depth: DEPTH, gaps: GAPS, ...SIZE };
}

/**
 * @param {object} options 모양은 index.d.ts와 README를 봅니다. 필수 옵션이 빠지면 기본값 없이 던집니다.
 */
export function createTechTree(options) {
    const BY_ID = readOptions(options);
    const { root: ROOT, screen: SCREEN, navigation: NAVIGATION, nodes: NODES, text: TEXT } = options;
    const DOC = ROOT.ownerDocument;
    const WIN = DOC.defaultView;
    if (!DOC.getElementById(STYLE_ID)) {
        const STYLE_EL = DOC.createElement('style');
        STYLE_EL.id = STYLE_ID;
        STYLE_EL.textContent = STYLE;
        DOC.head.append(STYLE_EL);
    }
    const BRANCHES = [...new Set(NODES.map((node) => node.branch))];
    const EL = (tag, className, parent) => {
        const ELEMENT = DOC.createElement(tag);
        ELEMENT.className = className;
        parent?.append(ELEMENT);
        return ELEMENT;
    };
    ROOT.replaceChildren();
    ROOT.classList.add('bloom-tech');
    const MAIN = EL('div', 'tt-main', ROOT);
    const VIEW = EL('div', 'tt-view', MAIN);
    VIEW.setAttribute('role', 'group');
    VIEW.tabIndex = 0;
    VIEW.dataset.pan = 'on';
    const WORLD = EL('div', 'tt-world', VIEW);
    const SVG_NS = 'http://www.w3.org/2000/svg';
    const EDGES = DOC.createElementNS(SVG_NS, 'svg');
    EDGES.setAttribute('class', 'tt-edges');
    EDGES.setAttribute('aria-hidden', 'true');
    WORLD.append(EDGES);
    const TABS = EL('div', 'tt-tabs', MAIN);
    TABS.setAttribute('role', 'tablist');
    const DETAIL = EL('section', 'tt-detail', MAIN);
    const HEAD = EL('div', 'tt-head', DETAIL);
    const TITLE = EL('span', 'tt-title', HEAD);
    const LEVEL = EL('span', 'tt-level', HEAD);
    const BODY = EL('div', 'tt-body', DETAIL);
    const REQS = EL('div', 'tt-reqs', DETAIL);
    const REASON = EL('div', 'tt-reason', DETAIL);
    const BUY = EL('button', 'tt-buy', DETAIL);
    BUY.type = 'button';

    TABS.hidden = BRANCHES.length === 1; // 분류가 하나뿐이면 탭을 두지 않습니다.
    const TAB_BUTTONS = new Map();
    for (const BRANCH of BRANCHES) {
        const BUTTON = EL('button', 'tt-tab', TABS);
        BUTTON.type = 'button';
        BUTTON.setAttribute('role', 'tab');
        BUTTON.textContent = TEXT.branch(BRANCH);
        BUTTON.onclick = () => select(NODES.find((node) => node.branch === BRANCH).id);
        TAB_BUTTONS.set(BRANCH, BUTTON);
    }
    VIEW.setAttribute('aria-label', TEXT.map());

    // 노드 버튼은 한 번만 만듭니다(문구는 페이지 로드 때 정해진 언어). 분류가 바뀌면 보이는 것만 놓습니다.
    const NODE_BUTTONS = new Map();
    for (const NODE_DEF of NODES) {
        const BUTTON = EL('button', 'tt-node');
        BUTTON.type = 'button';
        BUTTON.dataset.id = NODE_DEF.id;
        options.renderNode(NODE_DEF, BUTTON);
        EL('small', 'tt-badge', BUTTON);
        BUTTON.onclick = () => select(NODE_DEF.id, { reveal: true });
        NODE_BUTTONS.set(NODE_DEF.id, BUTTON);
    }

    let selected = null;
    let branch = BRANCHES[0];
    let layout = null;
    let orientation = 'down';
    let scale = 1;
    let tx = 0;
    let ty = 0;
    let minScale = 1;
    let movingTimer = 0;
    let suppressClick = false;
    let sizeKey = '';
    let viewChanged = false;
    let disposed = false;
    let builtDetail = null;

    const LEVEL_OF = (id) => options.level(id);
    const STATE_OF = (node) => {
        const LEVEL_NOW = LEVEL_OF(node.id);
        if (LEVEL_NOW >= node.max) {
            return { state: 'owned', check: null };
        }
        if (!node.requires.every((id) => LEVEL_OF(id) > 0)) {
            return { state: 'locked', check: null };
        }
        const CHECK = options.canBuy(node);
        return { state: CHECK?.ok === true ? 'available' : 'waiting', check: CHECK };
    };

    function clampView() {
        const VW = VIEW.clientWidth;
        const VH = VIEW.clientHeight;
        const FIT = (size, content, at) => {
            const SHOWN = content * scale;
            return Math.min(size - PAD - PAD * scale, Math.max(PAD - SHOWN + PAD * scale, at));
        };
        tx = FIT(VW, layout.width, tx);
        ty = FIT(VH, layout.height, ty);
    }
    function applyView(animate = false) {
        clampView();
        if (animate && !WIN.matchMedia('(prefers-reduced-motion: reduce)').matches) {
            WORLD.dataset.moving = '';
            WIN.clearTimeout(movingTimer);
            movingTimer = WIN.setTimeout(() => delete WORLD.dataset.moving, 260);
        } else {
            delete WORLD.dataset.moving;
        }
        WORLD.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
    }
    function zoomAt(factor, cx, cy, animate = false) {
        viewChanged = true;
        const NEXT = Math.min(MAX_SCALE, Math.max(minScale, scale * factor));
        tx = cx - ((cx - tx) * NEXT) / scale;
        ty = cy - ((cy - ty) * NEXT) / scale;
        scale = NEXT;
        applyView(animate);
    }
    function resetView(animate = false, revealSelection = false) {
        viewChanged = false;
        const VW = VIEW.clientWidth;
        const VH = VIEW.clientHeight;
        scale = Math.min(1, Math.max(VW / layout.width, TOUCH_MIN / NODE));
        minScale = Math.min(scale, VW / layout.width, VH / layout.height);
        const ROOTS = [...layout.positions]
            .filter(([id]) => layout.depth.get(id) === 0)
            .map(([, position]) => position);
        const MIN_X = Math.min(...ROOTS.map((position) => position.x));
        const MIN_Y = Math.min(...ROOTS.map((position) => position.y));
        const WIDTH = Math.max(...ROOTS.map((position) => position.x)) + NODE - MIN_X;
        const HEIGHT = Math.max(...ROOTS.map((position) => position.y)) + NODE - MIN_Y;
        const POSITION = options.rootPosition ?? 'auto';
        const [AX, AY] = ROOT_POSITIONS[POSITION === 'auto' ? (orientation === 'down' ? 'top' : 'left') : POSITION];
        tx = (VW - WIDTH * scale) * AX + PAD * (1 - 2 * AX) - MIN_X * scale;
        ty = (VH - HEIGHT * scale) * AY + PAD * (1 - 2 * AY) - MIN_Y * scale;
        applyView(animate);
        if (revealSelection && selected && BY_ID.get(selected).branch === branch) {
            reveal(selected, animate);
        }
    }
    // 선택한 노드가 보이게 합니다. 손가락 영역보다 작게 줄어 있으면 눌러 볼 만한 크기까지 키워 가운데에 놓습니다.
    function reveal(id, animate = true) {
        const POSITION = layout.positions.get(id);
        if (!POSITION) {
            return;
        }
        const VW = VIEW.clientWidth;
        const VH = VIEW.clientHeight;
        const SMALL = scale * NODE < TOUCH_MIN;
        const LEFT = tx + POSITION.x * scale;
        const TOP = ty + POSITION.y * scale;
        const SIZE = NODE * scale;
        if (!SMALL && LEFT >= 0 && TOP >= 0 && LEFT + SIZE <= VW && TOP + SIZE <= VH) {
            return;
        }
        if (SMALL) {
            scale = Math.min(MAX_SCALE, TOUCH_MIN / NODE);
        }
        tx = VW / 2 - (POSITION.x + NODE / 2) * scale;
        ty = VH / 2 - (POSITION.y + NODE / 2) * scale;
        applyView(animate);
    }

    // 연결선: 바로 아래 층이면 S자 곡선 하나, 층을 건너뛰면 중간 층마다 노드 사이의 빈 길로 곧게 지나갑니다(노드를 관통하지 않음).
    function routeEdge(from, to) {
        const DOWN = orientation === 'down';
        const AT = (cross, main) => (DOWN ? `${cross} ${main}` : `${main} ${cross}`);
        const MAIN_START = (depth) => PAD + depth * (NODE + GAP_MAIN);
        const CROSS_OF = (id) => (DOWN ? layout.positions.get(id).x : layout.positions.get(id).y) + NODE / 2;
        const FROM_DEPTH = layout.depth.get(from);
        const TO_DEPTH = layout.depth.get(to);
        const FROM_CROSS = CROSS_OF(from);
        const TO_CROSS = CROSS_OF(to);
        let currentCross = FROM_CROSS;
        let currentMain = MAIN_START(FROM_DEPTH) + NODE;
        let path = `M${AT(currentCross, currentMain)}`;
        const CURVE = (cross, main) => {
            const HALF = (main - currentMain) / 2;
            path += ` C${AT(currentCross, currentMain + HALF)} ${AT(cross, main - HALF)} ${AT(cross, main)}`;
            currentCross = cross;
            currentMain = main;
        };
        for (let depth = FROM_DEPTH + 1; depth < TO_DEPTH; depth++) {
            const WANT = FROM_CROSS + ((TO_CROSS - FROM_CROSS) * (depth - FROM_DEPTH)) / (TO_DEPTH - FROM_DEPTH);
            const LANE = layout.gaps[depth].reduce((best, gap) =>
                Math.abs(gap - WANT) < Math.abs(best - WANT) ? gap : best,
            );
            CURVE(LANE, MAIN_START(depth));
            currentMain = MAIN_START(depth) + NODE;
            path += ` L${AT(LANE, currentMain)}`;
        }
        CURVE(TO_CROSS, MAIN_START(TO_DEPTH));
        return path;
    }

    function buildBranch(next) {
        branch = next;
        const NODE_LIST = NODES.filter((node) => node.branch === branch);
        layout = layoutBranch(NODE_LIST, orientation);
        WORLD.style.width = `${layout.width}px`;
        WORLD.style.height = `${layout.height}px`;
        EDGES.setAttribute('width', layout.width);
        EDGES.setAttribute('height', layout.height);
        EDGES.replaceChildren();
        WORLD.querySelectorAll('.tt-node').forEach((element) => element.remove());
        for (const NODE_DEF of NODE_LIST) {
            const BUTTON = NODE_BUTTONS.get(NODE_DEF.id);
            const POSITION = layout.positions.get(NODE_DEF.id);
            BUTTON.style.left = `${POSITION.x}px`;
            BUTTON.style.top = `${POSITION.y}px`;
            WORLD.append(BUTTON);
            for (const PARENT of NODE_DEF.requires) {
                const FROM = layout.positions.get(PARENT);
                if (!FROM) {
                    continue; // 다른 분류의 선행 조건은 선 없이 상세의 조건 칩으로 읽습니다.
                }
                const PATH = DOC.createElementNS(SVG_NS, 'path');
                PATH.setAttribute('class', 'tt-edge');
                PATH.dataset.from = PARENT;
                PATH.dataset.to = NODE_DEF.id;
                PATH.setAttribute('d', routeEdge(PARENT, NODE_DEF.id));
                EDGES.append(PATH);
            }
        }
        for (const [NAME, BUTTON] of TAB_BUTTONS) {
            BUTTON.setAttribute('aria-selected', String(NAME === branch));
        }
        refresh();
        resetView(false, true);
    }

    function renderDetail() {
        const NODE_DEF = BY_ID.get(selected);
        const { state: STATE, check: CHECK } = STATE_OF(NODE_DEF);
        const LEVEL_NOW = LEVEL_OF(NODE_DEF.id);
        if (builtDetail !== NODE_DEF.id) {
            builtDetail = NODE_DEF.id;
            TITLE.textContent = TEXT.name(NODE_DEF);
            BODY.replaceChildren();
            options.renderDetail(NODE_DEF, BODY);
            // 조건 칩은 선택이 바뀔 때만 다시 만들어, 자주 갱신해도 눌리는 중인 칩이 바뀌지 않게 합니다.
            REQS.replaceChildren();
            for (const ID of NODE_DEF.requires) {
                const CHIP = EL('button', 'tt-req', REQS);
                CHIP.type = 'button';
                CHIP.dataset.id = ID;
                CHIP.onclick = () => select(ID, { reveal: true });
            }
        }
        for (const CHIP of REQS.children) {
            const REQUIRED = BY_ID.get(CHIP.dataset.id);
            const MET = LEVEL_OF(REQUIRED.id) > 0;
            CHIP.dataset.met = String(MET);
            CHIP.textContent = TEXT.prerequisite(REQUIRED, MET);
        }
        LEVEL.textContent = TEXT.level(NODE_DEF, LEVEL_NOW);
        REASON.textContent = TEXT.reason(STATE, NODE_DEF, CHECK);
        BUY.textContent = TEXT.buy(STATE, NODE_DEF, CHECK);
        BUY.disabled = STATE !== 'available';
    }

    function refresh() {
        if (disposed) {
            return;
        }
        for (const NODE_DEF of NODES) {
            const BUTTON = NODE_BUTTONS.get(NODE_DEF.id);
            const { state: STATE } = STATE_OF(NODE_DEF);
            const LEVEL_NOW = LEVEL_OF(NODE_DEF.id);
            const LABEL = TEXT.state(STATE, NODE_DEF, LEVEL_NOW);
            BUTTON.dataset.state = STATE;
            BUTTON.setAttribute('aria-pressed', String(NODE_DEF.id === selected));
            BUTTON.setAttribute('aria-label', `${TEXT.name(NODE_DEF)}, ${LABEL}`);
            BUTTON.querySelector('.tt-badge').textContent = LABEL;
        }
        for (const PATH of EDGES.children) {
            PATH.dataset.met = String(LEVEL_OF(PATH.dataset.from) > 0);
        }
        renderDetail();
    }

    function select(id, { write = true, reveal: shouldReveal = false } = {}) {
        const NODE_DEF = BY_ID.get(id);
        if (!NODE_DEF) {
            fail(`unknown node ${id}`);
        }
        selected = id;
        viewChanged = true;
        if (NODE_DEF.branch !== branch) {
            buildBranch(NODE_DEF.branch);
        } else {
            refresh();
        }
        if (shouldReveal || NODE_DEF.branch === branch) {
            reveal(id, true);
        }
        if (write) {
            const ROUTE = NAVIGATION.snapshot();
            if (ROUTE.screen !== SCREEN || ROUTE.item !== id) {
                NAVIGATION.replace({ ...ROUTE, screen: SCREEN, item: id });
            }
        }
    }

    // 포인터: 한 손가락/마우스 끌기 = 이동, 두 손가락 = 확대·축소. 눌렀다 떼기는 노드 클릭으로 남깁니다.
    const POINTERS = new Map();
    let dragging = false;
    let origin = null;
    let pinch = null;
    const MID = () => {
        const [A, B] = [...POINTERS.values()];
        return { x: (A.x + B.x) / 2, y: (A.y + B.y) / 2, gap: Math.hypot(A.x - B.x, A.y - B.y) };
    };
    const LOCAL = (event) => {
        const BOX = VIEW.getBoundingClientRect();
        return { x: event.clientX - BOX.left, y: event.clientY - BOX.top };
    };
    VIEW.addEventListener('pointerdown', (event) => {
        if (event.pointerType === 'mouse' && event.button !== 0) {
            return;
        }
        viewChanged = true;
        POINTERS.set(event.pointerId, LOCAL(event));
        origin = { ...LOCAL(event), tx: tx, ty: ty };
        if (POINTERS.size === 2) {
            const MIDDLE = MID();
            pinch = { gap: MIDDLE.gap, scale, x: MIDDLE.x, y: MIDDLE.y };
            dragging = true;
        }
    });
    VIEW.addEventListener('pointermove', (event) => {
        if (!POINTERS.has(event.pointerId)) {
            return;
        }
        POINTERS.set(event.pointerId, LOCAL(event));
        if (POINTERS.size >= 2 && pinch) {
            const MIDDLE = MID();
            const NEXT = Math.min(MAX_SCALE, Math.max(minScale, (pinch.scale * MIDDLE.gap) / pinch.gap));
            tx = MIDDLE.x - ((pinch.x - tx) * NEXT) / scale;
            ty = MIDDLE.y - ((pinch.y - ty) * NEXT) / scale;
            scale = NEXT;
            pinch.x = MIDDLE.x;
            pinch.y = MIDDLE.y;
            pinch.scale = NEXT;
            pinch.gap = MIDDLE.gap;
            applyView();
            return;
        }
        const NOW = POINTERS.get(event.pointerId);
        if (!dragging && Math.hypot(NOW.x - origin.x, NOW.y - origin.y) > DRAG_START) {
            dragging = true;
            VIEW.setPointerCapture(event.pointerId);
        }
        if (dragging) {
            tx = origin.tx + NOW.x - origin.x;
            ty = origin.ty + NOW.y - origin.y;
            applyView();
        }
    });
    const RELEASE = (event) => {
        if (!POINTERS.delete(event.pointerId)) {
            return;
        }
        if (POINTERS.size === 1) {
            const [REST] = POINTERS.values();
            origin = { ...REST, tx: tx, ty: ty };
            pinch = null;
        }
        if (POINTERS.size === 0) {
            if (dragging) {
                suppressClick = true;
                WIN.setTimeout(() => (suppressClick = false), 50);
            }
            dragging = false;
            pinch = null;
        }
    };
    VIEW.addEventListener('pointerup', RELEASE);
    VIEW.addEventListener('pointercancel', RELEASE);
    VIEW.addEventListener(
        'click',
        (event) => {
            if (suppressClick && event.target.closest('.tt-world')) {
                event.stopPropagation();
                event.preventDefault();
                suppressClick = false;
            }
        },
        true,
    );
    VIEW.addEventListener(
        'wheel',
        (event) => {
            event.preventDefault();
            const POINT = LOCAL(event);
            zoomAt(Math.exp(-event.deltaY * 0.0015), POINT.x, POINT.y);
        },
        { passive: false },
    );
    VIEW.addEventListener('keydown', (event) => {
        if (event.target !== VIEW) {
            return;
        }
        if (event.key === '+' || event.key === '=') {
            zoomAt(1.3, VIEW.clientWidth / 2, VIEW.clientHeight / 2);
        } else if (event.key === '-') {
            zoomAt(1 / 1.3, VIEW.clientWidth / 2, VIEW.clientHeight / 2);
        } else if (event.key === 'Home') {
            resetView();
        } else if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
            viewChanged = true;
            tx += event.key === 'ArrowLeft' ? NODE / 2 : event.key === 'ArrowRight' ? -NODE / 2 : 0;
            ty += event.key === 'ArrowUp' ? NODE / 2 : event.key === 'ArrowDown' ? -NODE / 2 : 0;
            applyView();
        } else {
            return;
        }
        event.preventDefault();
    });
    // 키보드: 노드 버튼에 포커스가 가면 보이는 곳으로 옮깁니다.
    VIEW.addEventListener('focusin', (event) => {
        const BUTTON = event.target.closest?.('.tt-node');
        if (BUTTON) {
            reveal(BUTTON.dataset.id, true);
        }
    });

    // 크기가 실제로 바뀔 때만 다시 맞춥니다(ResizeObserver의 첫 알림이 끌어 둔 보기를 되돌리지 않게).
    // 방향이 같고 계속 넘치는 크기 변화(모바일 주소창 등)는 이동·배율을 지키고 범위만 다시 잡습니다.
    function sizeLayout() {
        const WIDTH = ROOT.clientWidth;
        ROOT.dataset.layout = WIDTH >= 720 ? 'wide' : 'narrow';
        const KEY = `${WIDTH}x${VIEW.clientWidth}x${VIEW.clientHeight}`;
        if (KEY === sizeKey) {
            return;
        }
        sizeKey = KEY;
        const WANT = VIEW.clientWidth > VIEW.clientHeight * 1.2 ? 'right' : 'down';
        const VW = VIEW.clientWidth;
        const VH = VIEW.clientHeight;
        if (WANT !== orientation) {
            orientation = WANT;
            buildBranch(branch);
        } else if (!viewChanged) {
            resetView(false, true);
        } else {
            minScale = Math.min(1, VW / layout.width, VH / layout.height);
            scale = Math.min(MAX_SCALE, Math.max(minScale, scale));
            applyView();
        }
    }
    const OBSERVER = new WIN.ResizeObserver(() => !disposed && layout && sizeLayout());
    OBSERVER.observe(ROOT);
    OBSERVER.observe(VIEW);

    const UNSUBSCRIBE = NAVIGATION.subscribe((route) => {
        if (route.screen === SCREEN && BY_ID.has(route.item) && route.item !== selected) {
            select(route.item, { write: false, reveal: true });
        }
    });
    BUY.onclick = () => {
        const { state: STATE } = STATE_OF(BY_ID.get(selected));
        if (STATE === 'available') {
            options.onBuy(selected);
        }
    };

    // 시작: 주소의 선택을 읽습니다(이력은 쓰지 않음). 모르는 선택이면 첫 노드로 바로잡습니다.
    const START = NAVIGATION.snapshot();
    const START_ID = START.screen === SCREEN && BY_ID.has(START.item) ? START.item : null;
    selected = START_ID ?? NODES[0].id;
    ROOT.dataset.layout = ROOT.clientWidth >= 720 ? 'wide' : 'narrow';
    orientation = VIEW.clientWidth > VIEW.clientHeight * 1.2 ? 'right' : 'down';
    buildBranch(BY_ID.get(selected).branch);
    sizeKey = `${ROOT.clientWidth}x${VIEW.clientWidth}x${VIEW.clientHeight}`;
    if (START_ID === null && START.screen === SCREEN) {
        NAVIGATION.replace({ ...START, item: selected });
    }

    return {
        /** 레벨·포인트가 바뀐 뒤 부릅니다. 상태·문구·조건 칩을 다시 계산합니다(배치는 그대로). */
        refresh,
        /** 선택한 노드 id. */
        get selected() {
            return selected;
        },
        /** 노드의 현재 상태: owned | locked | available | waiting. */
        stateOf(id) {
            if (!BY_ID.has(id)) {
                fail(`unknown node ${id}`);
            }
            return STATE_OF(BY_ID.get(id)).state;
        },
        select: (id) => select(id, { reveal: true }),
        dispose() {
            disposed = true;
            UNSUBSCRIBE();
            OBSERVER.disconnect();
            WIN.clearTimeout(movingTimer);
            ROOT.replaceChildren();
            ROOT.classList.remove('bloom-tech');
            delete ROOT.dataset.layout;
        },
    };
}

export { STATES as TECH_STATES };

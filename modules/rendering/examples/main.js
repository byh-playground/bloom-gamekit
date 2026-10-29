import { startAtlas } from './atlas.js';
import { startMaterials } from './materials.js';
import { startPaint } from './paint.js';
import { startVector } from './vector.js';

// One page, one tab per example. A tab starts its WebGL scene the first time it is shown, so a hidden tab costs nothing.
const TABS = {
    vector: startVector,
    atlas: startAtlas,
    materials: startMaterials,
    paint: startPaint,
};
const NAMES = Object.keys(TABS);
const EXAMPLES = {};
let current = null;

function select(name) {
    if (!NAMES.includes(name)) {
        throw new RangeError(`unknown example tab: ${name}`);
    }
    if (current && current !== name) {
        EXAMPLES[current]?.pause?.();
    }
    for (const TAB of NAMES) {
        const SELECTED = TAB === name;
        document.querySelector(`#panel-${TAB}`).hidden = !SELECTED;
        const BUTTON = document.querySelector(`#tab-${TAB}`);
        BUTTON.setAttribute('aria-selected', String(SELECTED));
        BUTTON.tabIndex = SELECTED ? 0 : -1;
    }
    EXAMPLES[name] ??= TABS[name](document.querySelector(`#canvas-${name}`), document.querySelector(`#stats-${name}`));
    EXAMPLES[name].resume?.();
    current = name;
    history.replaceState(null, '', `#${name}`);
}

for (const NAME of NAMES) {
    const BUTTON = document.querySelector(`#tab-${NAME}`);
    BUTTON.addEventListener('click', () => select(NAME));
    BUTTON.addEventListener('keydown', (event) => {
        const STEP = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
        if (STEP) {
            const NEXT = NAMES[(NAMES.indexOf(NAME) + STEP + NAMES.length) % NAMES.length];
            select(NEXT);
            document.querySelector(`#tab-${NEXT}`).focus();
        }
    });
}
window.addEventListener('hashchange', () => {
    const NAME = location.hash.slice(1);
    if (NAMES.includes(NAME) && NAME !== current) {
        select(NAME);
    }
});
window.renderingExamples = EXAMPLES;
window.addEventListener(
    'pagehide',
    () => {
        for (const EXAMPLE of Object.values(EXAMPLES)) {
            EXAMPLE.dispose();
        }
    },
    { once: true },
);
select(NAMES.includes(location.hash.slice(1)) ? location.hash.slice(1) : 'vector');

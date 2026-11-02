// modules/pwa/build.js
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
var MARKER_START = "<!-- bloom-pwa:start -->";
var MARKER_END = "<!-- bloom-pwa:end -->";
var COLOR = /^#[0-9a-f]{6}$/i;
var SHARE_SIZE = Object.freeze({ width: 1200, height: 630 });
var MASKABLE_SAFE_ZONE = 0.8;
var MANIFEST_FILE = "manifest.webmanifest";
var WORKER_FILE = "sw.js";
var IMAGES = Object.freeze({
  icon192: "pwa/icon-192.png",
  icon512: "pwa/icon-512.png",
  maskable: "pwa/maskable-512.png",
  apple: "pwa/apple-touch-icon.png",
  share: "pwa/share.png"
});
var GAMEKIT_URL = /https:\/\/cdn\.jsdelivr\.net\/gh\/byh-playground\/bloom-gamekit@[0-9a-f]{40}\/[A-Za-z0-9._/-]+/;
var TEXT_FILE = /\.(?:html?|m?js|css|json|webmanifest|svg|txt)$/i;
var OPTION_KEYS = /* @__PURE__ */ new Set([
  "chromium",
  "name",
  "shortName",
  "description",
  "lang",
  "icon",
  "maskableIcon",
  "share",
  "themeColor",
  "backgroundColor",
  "startUrl",
  "scope",
  "siteUrl",
  "html",
  "out",
  "check"
]);
var POSIX = (path) => path.split(sep).join("/");
var IS_TEXT = (path) => TEXT_FILE.test(path);
var HEAD_LAYOUT = (text) => {
  const START = text.indexOf(MARKER_START);
  const END = text.indexOf(MARKER_END, START);
  if (START < 0 || END < 0) {
    return text;
  }
  const BLOCK = text.slice(START, END).replace(/"[^"]*"|'[^']*'|\s+/g, (token) => /^\s/.test(token) ? " " : token).replace(/ ?\/>/g, ">");
  return text.slice(0, START) + BLOCK + text.slice(END);
};
var CANONICAL = (path, bytes) => {
  if (!IS_TEXT(path)) {
    return bytes;
  }
  const TEXT = bytes.toString("utf8").replace(/\r\n/g, "\n");
  return Buffer.from(/\.html?$/i.test(path) ? HEAD_LAYOUT(TEXT) : TEXT, "utf8");
};
var ATTRIBUTE = (value) => {
  const TEXT = String(value).replace(/[&<>]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[char]);
  const DOUBLE = (TEXT.match(/"/g) ?? []).length;
  const SINGLE = (TEXT.match(/'/g) ?? []).length;
  return DOUBLE > SINGLE ? `'${TEXT.replace(/'/g, "&apos;")}'` : `"${TEXT.replace(/"/g, "&quot;")}"`;
};
function fail(message) {
  throw new Error(`buildPwa: ${message}`);
}
function readOptions(options) {
  if (options === null || typeof options !== "object") {
    fail("options object is required");
  }
  for (const KEY of Object.keys(options)) {
    if (!OPTION_KEYS.has(KEY)) {
      fail(`unknown option "${KEY}"`);
    }
  }
  if (typeof options.chromium?.launch !== "function") {
    fail('chromium must be Playwright chromium (import { chromium } from "playwright")');
  }
  for (const KEY of [
    "name",
    "shortName",
    "description",
    "lang",
    "icon",
    "share",
    "startUrl",
    "scope",
    "siteUrl",
    "html",
    "out"
  ]) {
    if (typeof options[KEY] !== "string" || options[KEY].trim() === "") {
      fail(`${KEY} must be a non-empty string`);
    }
  }
  if (options.maskableIcon !== void 0 && (typeof options.maskableIcon !== "string" || !options.maskableIcon)) {
    fail("maskableIcon must be a non-empty string when given");
  }
  for (const KEY of ["themeColor", "backgroundColor"]) {
    if (typeof options[KEY] !== "string" || !COLOR.test(options[KEY])) {
      fail(`${KEY} must be a #rrggbb color`);
    }
  }
  if (typeof options.check !== "boolean") {
    fail("check must be true or false");
  }
  let site;
  try {
    site = new URL(options.siteUrl);
  } catch {
    fail(`siteUrl must be an absolute URL: ${options.siteUrl}`);
  }
  if (site.protocol !== "https:" || !site.pathname.endsWith("/") || site.search || site.hash) {
    fail('siteUrl must be the https URL of the published out folder, ending with "/"');
  }
  return options;
}
function inside(root, path, label) {
  const RELATIVE = relative(root, path);
  if (RELATIVE === "" || RELATIVE.startsWith("..") || isAbsolute(RELATIVE)) {
    fail(`${label} must be inside out: ${path}`);
  }
  return POSIX(RELATIVE);
}
async function readSource(cwd, path, label) {
  try {
    return await readFile(resolve(cwd, path), "utf8");
  } catch (error) {
    fail(`cannot read ${label} ${path}: ${error.message}`);
  }
}
async function rasterize(chromium, sources, jobs) {
  const BROWSER = await chromium.launch();
  try {
    const PAGE = await BROWSER.newPage({ viewport: { width: 64, height: 64 }, deviceScaleFactor: 1 });
    for (const [LABEL, { svg: SVG, aspect: ASPECT }] of Object.entries(sources)) {
      const PROBLEM = await PAGE.evaluate(
        ({ svg, aspect }) => {
          const DOCUMENT = new DOMParser().parseFromString(svg, "image/svg+xml");
          const ROOT = DOCUMENT.documentElement;
          if (DOCUMENT.querySelector("parsererror") || ROOT.localName !== "svg") {
            return "is not a valid SVG document";
          }
          const BOX = ROOT.viewBox.baseVal;
          if (!ROOT.hasAttribute("viewBox") || !(BOX.width > 0) || !(BOX.height > 0)) {
            return "needs a viewBox with positive width and height";
          }
          if (Math.abs(BOX.width / BOX.height - aspect) > 1e-3) {
            return `viewBox must have aspect ${aspect.toFixed(4)} (got ${BOX.width}x${BOX.height})`;
          }
          for (const ELEMENT of DOCUMENT.querySelectorAll("*")) {
            for (const ATTRIBUTE2 of ELEMENT.attributes) {
              if (ATTRIBUTE2.localName === "href" && !ATTRIBUTE2.value.startsWith("#") && !ATTRIBUTE2.value.startsWith("data:")) {
                return `must not reference external files (${ATTRIBUTE2.value})`;
              }
            }
          }
          return null;
        },
        { svg: SVG, aspect: ASPECT }
      );
      if (PROBLEM) {
        fail(`${LABEL} SVG ${PROBLEM}`);
      }
    }
    const IMAGES_OUT = /* @__PURE__ */ new Map();
    for (const {
      file: FILE,
      svg: SVG,
      width: WIDTH,
      height: HEIGHT,
      background: BACKGROUND,
      inset: INSET
    } of jobs) {
      await PAGE.setViewportSize({ width: WIDTH, height: HEIGHT });
      const BOX = { width: WIDTH * INSET, height: HEIGHT * INSET };
      await PAGE.setContent(
        `<!doctype html><style>html,body{margin:0;width:${WIDTH}px;height:${HEIGHT}px;overflow:hidden;background:${BACKGROUND ?? "transparent"}}img{position:absolute;display:block;left:${(WIDTH - BOX.width) / 2}px;top:${(HEIGHT - BOX.height) / 2}px;width:${BOX.width}px;height:${BOX.height}px}</style><img alt="" src="data:image/svg+xml;base64,${Buffer.from(SVG).toString("base64")}">`
      );
      const DECODED = await PAGE.evaluate(
        () => document.images[0].decode().then(
          () => null,
          (error) => String(error)
        )
      );
      if (DECODED !== null) {
        fail(`cannot draw SVG for ${FILE}: ${DECODED}`);
      }
      IMAGES_OUT.set(
        FILE,
        await PAGE.screenshot({
          type: "png",
          omitBackground: BACKGROUND === null,
          clip: { x: 0, y: 0, width: WIDTH, height: HEIGHT }
        })
      );
    }
    return IMAGES_OUT;
  } finally {
    await BROWSER.close();
  }
}
function headBlock(html, tags) {
  const START = html.indexOf(MARKER_START);
  const END = html.indexOf(MARKER_END);
  if (START < 0 || END < START || html.indexOf(MARKER_START, START + 1) >= 0 || html.indexOf(MARKER_END, END + 1) >= 0) {
    fail(`html needs exactly one "${MARKER_START}" followed by one "${MARKER_END}" inside <head>`);
  }
  const HEAD_END = html.search(/<\/head\s*>/i);
  if (HEAD_END < 0 || END > HEAD_END) {
    fail("the bloom-pwa markers must be inside <head>");
  }
  const BEFORE = html.slice(0, START);
  const AFTER = html.slice(END + MARKER_END.length);
  const CONFLICTS = (BEFORE + AFTER).match(
    /<link\b[^>]*\brel\s*=\s*["']?(?:manifest|icon|apple-touch-icon)\b[^>]*>|<meta\b[^>]*\b(?:name\s*=\s*["']?(?:theme-color|description|apple-mobile-web-app-title|twitter:[\w:-]+)|property\s*=\s*["']?og:[\w:-]+)\b[^>]*>/gi
  );
  if (CONFLICTS) {
    fail(`remove these tags outside the bloom-pwa markers (they are generated): ${CONFLICTS.join(" ")}`);
  }
  const EOL = html.includes("\r\n") ? "\r\n" : "\n";
  const INDENT = BEFORE.slice(BEFORE.lastIndexOf("\n") + 1);
  if (INDENT.trim() !== "") {
    fail(`"${MARKER_START}" must be on its own line`);
  }
  return [BEFORE + MARKER_START, ...tags.map((tag) => INDENT + tag), INDENT + MARKER_END + AFTER].join(EOL);
}
function serviceWorker(config) {
  const PREFIX = `bloom-pwa:${new URL(self.registration.scope).pathname}:`;
  const RUNTIME = PREFIX + "runtime";
  const GAMEKIT_CACHE = PREFIX + "gamekit";
  const GAMEKIT = new RegExp(config.gamekit);
  self.addEventListener("install", () => {
    self.skipWaiting();
  });
  self.addEventListener("activate", (event) => {
    event.waitUntil(
      Promise.all([
        self.clients.claim(),
        caches.keys().then(
          (keys) => Promise.all(
            keys.filter((key) => key.startsWith(PREFIX) && key !== RUNTIME && key !== GAMEKIT_CACHE).map((key) => caches.delete(key))
          )
        )
      ])
    );
  });
  async function offline(request, error) {
    const STORE = await caches.open(RUNTIME);
    const NAVIGATE = request.mode === "navigate";
    let response = await STORE.match(request, { ignoreSearch: NAVIGATE });
    const ADDRESS = new URL(request.url);
    if (!response && NAVIGATE && ADDRESS.pathname.endsWith("/")) {
      response = await STORE.match(new URL("index.html", ADDRESS).href);
    }
    if (!response) {
      throw error;
    }
    return response;
  }
  async function sameOrigin(event) {
    const REQUEST = event.request;
    let response;
    try {
      response = await fetch(REQUEST, { cache: "no-cache" });
    } catch (error) {
      return offline(REQUEST, error);
    }
    if (response.status === 200) {
      const COPY = response.clone();
      event.waitUntil(caches.open(RUNTIME).then((store) => store.put(REQUEST, COPY)));
    }
    return response;
  }
  async function gamekit(request) {
    const STORE = await caches.open(GAMEKIT_CACHE);
    const CACHED = await STORE.match(request);
    if (CACHED) {
      return CACHED;
    }
    const RESPONSE = await fetch(request);
    if (RESPONSE.ok) {
      await STORE.put(request, RESPONSE.clone());
    }
    return RESPONSE;
  }
  self.addEventListener("fetch", (event) => {
    const REQUEST = event.request;
    if (REQUEST.method !== "GET") {
      return;
    }
    if (new URL(REQUEST.url).origin === self.location.origin) {
      event.respondWith(sameOrigin(event));
    } else if (GAMEKIT.test(REQUEST.url)) {
      event.respondWith(gamekit(REQUEST));
    }
  });
}
async function buildPwa(options) {
  const {
    chromium: CHROMIUM,
    name: NAME,
    shortName: SHORT_NAME,
    description: DESCRIPTION,
    lang: LANG,
    icon: ICON,
    maskableIcon: MASKABLE_ICON,
    share: SHARE,
    themeColor: THEME_COLOR,
    backgroundColor: BACKGROUND_COLOR,
    startUrl: START_URL,
    scope: SCOPE,
    siteUrl: SITE_URL,
    html: HTML,
    out: OUT,
    check: CHECK
  } = readOptions(options);
  const CWD = process.cwd();
  const OUT_DIR = resolve(CWD, OUT);
  const HTML_PATH = resolve(CWD, HTML);
  const HTML_FILE = inside(OUT_DIR, HTML_PATH, "html");
  const BASE = new URL("https://pwa.invalid/");
  const START = new URL(START_URL, BASE);
  const SCOPE_URL = new URL(SCOPE, BASE);
  if (START.origin !== BASE.origin || SCOPE_URL.origin !== BASE.origin) {
    fail("startUrl and scope must be relative to the out folder");
  }
  if (!SCOPE_URL.pathname.endsWith("/") || !START.pathname.startsWith(SCOPE_URL.pathname)) {
    fail('scope must be a folder ("./") that contains startUrl');
  }
  const SOURCES = {
    icon: { svg: await readSource(CWD, ICON, "icon"), aspect: 1 },
    share: { svg: await readSource(CWD, SHARE, "share"), aspect: SHARE_SIZE.width / SHARE_SIZE.height }
  };
  if (MASKABLE_ICON !== void 0) {
    SOURCES.maskableIcon = { svg: await readSource(CWD, MASKABLE_ICON, "maskableIcon"), aspect: 1 };
  }
  const OPAQUE = SOURCES.maskableIcon ? { svg: SOURCES.maskableIcon.svg, inset: 1 } : { svg: SOURCES.icon.svg, inset: MASKABLE_SAFE_ZONE };
  const PNG = await rasterize(CHROMIUM, SOURCES, [
    { file: IMAGES.icon192, svg: SOURCES.icon.svg, width: 192, height: 192, background: null, inset: 1 },
    { file: IMAGES.icon512, svg: SOURCES.icon.svg, width: 512, height: 512, background: null, inset: 1 },
    { file: IMAGES.maskable, ...OPAQUE, width: 512, height: 512, background: BACKGROUND_COLOR },
    { file: IMAGES.apple, ...OPAQUE, width: 180, height: 180, background: BACKGROUND_COLOR },
    { file: IMAGES.share, svg: SOURCES.share.svg, ...SHARE_SIZE, background: null, inset: 1 }
  ]);
  const OUTPUTS = new Map(PNG);
  OUTPUTS.set(
    MANIFEST_FILE,
    Buffer.from(
      JSON.stringify(
        {
          id: START_URL,
          name: NAME,
          short_name: SHORT_NAME,
          description: DESCRIPTION,
          lang: LANG,
          start_url: START_URL,
          scope: SCOPE,
          display: "standalone",
          background_color: BACKGROUND_COLOR,
          theme_color: THEME_COLOR,
          icons: [
            { src: IMAGES.icon192, sizes: "192x192", type: "image/png", purpose: "any" },
            { src: IMAGES.icon512, sizes: "512x512", type: "image/png", purpose: "any" },
            { src: IMAGES.maskable, sizes: "512x512", type: "image/png", purpose: "maskable" }
          ]
        },
        null,
        2
      ) + "\n"
    )
  );
  const HREF = (file) => POSIX(relative(dirname(HTML_PATH), resolve(OUT_DIR, file)));
  const PAGE_URL = new URL(HTML_FILE.replace(/(^|\/)index\.html$/, "$1"), SITE_URL).href;
  const TAGS = [
    `<link rel="manifest" href=${ATTRIBUTE(HREF(MANIFEST_FILE))} />`,
    `<meta name="theme-color" content=${ATTRIBUTE(THEME_COLOR)} />`,
    `<meta name="description" content=${ATTRIBUTE(DESCRIPTION)} />`,
    `<link rel="icon" type="image/png" sizes="192x192" href=${ATTRIBUTE(HREF(IMAGES.icon192))} />`,
    `<link rel="apple-touch-icon" href=${ATTRIBUTE(HREF(IMAGES.apple))} />`,
    `<meta name="apple-mobile-web-app-title" content=${ATTRIBUTE(SHORT_NAME)} />`,
    '<meta property="og:type" content="website" />',
    `<meta property="og:url" content=${ATTRIBUTE(PAGE_URL)} />`,
    `<meta property="og:title" content=${ATTRIBUTE(NAME)} />`,
    `<meta property="og:description" content=${ATTRIBUTE(DESCRIPTION)} />`,
    `<meta property="og:image" content=${ATTRIBUTE(new URL(IMAGES.share, SITE_URL).href)} />`,
    `<meta property="og:image:width" content="${SHARE_SIZE.width}" />`,
    `<meta property="og:image:height" content="${SHARE_SIZE.height}" />`,
    '<meta name="twitter:card" content="summary_large_image" />'
  ];
  OUTPUTS.set(HTML_FILE, Buffer.from(headBlock(await readSource(CWD, HTML, "html"), TAGS), "utf8"));
  const CONFIG = { gamekit: `^${GAMEKIT_URL.source}$` };
  OUTPUTS.set(
    WORKER_FILE,
    Buffer.from(
      `// bloom-gamekit pwa가 생성한 파일입니다. 직접 고치지 말고 생성 스크립트를 다시 실행하세요.
(${serviceWorker.toString()})(${JSON.stringify(CONFIG, null, 4)});
`
    )
  );
  const CHANGED = [];
  for (const [FILE, BYTES] of OUTPUTS) {
    let current = null;
    try {
      current = await readFile(resolve(OUT_DIR, FILE));
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }
    if (current === null || !CANONICAL(FILE, current).equals(CANONICAL(FILE, BYTES))) {
      CHANGED.push(FILE);
    }
  }
  CHANGED.sort();
  if (CHECK) {
    if (CHANGED.length > 0) {
      fail(`generated PWA files are out of date; run the generator without check: ${CHANGED.join(", ")}`);
    }
  } else {
    for (const FILE of CHANGED) {
      const TARGET = resolve(OUT_DIR, FILE);
      await mkdir(dirname(TARGET), { recursive: true });
      await writeFile(TARGET, OUTPUTS.get(FILE));
    }
  }
  return { files: [...OUTPUTS.keys()].sort(), changed: CHANGED };
}
export {
  buildPwa
};

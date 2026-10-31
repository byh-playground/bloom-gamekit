// modules/pwa/build.js
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
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
var GAMEKIT_URL = /https:\/\/cdn\.jsdelivr\.net\/gh\/byh-playground\/bloom-gamekit@[0-9a-f]{40}\/[A-Za-z0-9._/-]+/g;
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
  "precache",
  "out",
  "check"
]);
var SHA256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
var POSIX = (path) => path.split(sep).join("/");
var IS_TEXT = (path) => TEXT_FILE.test(path);
var CANONICAL = (path, bytes) => IS_TEXT(path) ? Buffer.from(bytes.toString("utf8").replace(/\r\n/g, "\n"), "utf8") : bytes;
var ESCAPE = (value) => String(value).replace(/[&"<>]/g, (char) => ({ "&": "&amp;", '"': "&quot;", "<": "&lt;", ">": "&gt;" })[char]);
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
  if (!Array.isArray(options.precache) || options.precache.length === 0) {
    fail("precache must be a non-empty array of path patterns");
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
function patternRegExp(pattern) {
  let source = "";
  for (let index = 0; index < pattern.length; index++) {
    const CHAR = pattern[index];
    if (CHAR === "*" && pattern[index + 1] === "*") {
      const SLASH = pattern[index + 2] === "/";
      source += SLASH ? "(?:.*/)?" : ".*";
      index += SLASH ? 2 : 1;
    } else if (CHAR === "*") {
      source += "[^/]*";
    } else {
      source += CHAR.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${source}$`);
}
async function walk(directory) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
  const FILES = [];
  for (const ENTRY of entries) {
    const PATH = resolve(directory, ENTRY.name);
    if (ENTRY.isDirectory()) {
      if (ENTRY.name !== "node_modules" && !ENTRY.name.startsWith(".")) {
        FILES.push(...await walk(PATH));
      }
    } else if (ENTRY.isFile()) {
      FILES.push(PATH);
    }
  }
  return FILES;
}
async function expandPrecache(cwd, patterns) {
  const FILES = /* @__PURE__ */ new Set();
  for (const PATTERN of patterns) {
    if (typeof PATTERN !== "string" || PATTERN === "" || PATTERN.startsWith("/") || PATTERN.includes("\\")) {
      fail(`precache patterns must be relative POSIX paths: ${PATTERN}`);
    }
    if (PATTERN.split("/").includes("..")) {
      fail(`precache patterns must not contain "..": ${PATTERN}`);
    }
    const SEGMENTS = PATTERN.split("/");
    const STATIC = [];
    for (const SEGMENT of SEGMENTS) {
      if (SEGMENT.includes("*")) {
        break;
      }
      STATIC.push(SEGMENT);
    }
    const REGEXP = patternRegExp(PATTERN.replace(/^\.\//, ""));
    const MATCHED = STATIC.length === SEGMENTS.length ? (await walk(resolve(cwd, ...STATIC.slice(0, -1)))).filter(
      (file) => POSIX(relative(cwd, file)) === PATTERN.replace(/^\.\//, "")
    ) : (await walk(resolve(cwd, ...STATIC))).filter((file) => REGEXP.test(POSIX(relative(cwd, file))));
    if (MATCHED.length === 0) {
      fail(`precache pattern matched no file: ${PATTERN}`);
    }
    for (const FILE of MATCHED) {
      FILES.add(FILE);
    }
  }
  return [...FILES];
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
            for (const ATTRIBUTE of ELEMENT.attributes) {
              if (ATTRIBUTE.localName === "href" && !ATTRIBUTE.value.startsWith("#") && !ATTRIBUTE.value.startsWith("data:")) {
                return `must not reference external files (${ATTRIBUTE.value})`;
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
  const SCOPE = self.registration.scope;
  const PREFIX = `bloom-pwa:${new URL(SCOPE).pathname}:`;
  const CACHE = PREFIX + config.version;
  const RUNTIME = PREFIX + "gamekit";
  const GAMEKIT = new RegExp(config.gamekit);
  self.addEventListener("install", (event) => {
    event.waitUntil(
      caches.open(CACHE).then(
        (cache) => cache.addAll(
          config.precache.map(
            (url) => GAMEKIT.test(url) ? new Request(url, { mode: "cors" }) : new Request(url, { cache: "reload" })
          )
        )
      )
    );
  });
  self.addEventListener("activate", (event) => {
    event.waitUntil(
      caches.keys().then(
        (keys) => Promise.all(
          keys.filter((key) => key.startsWith(PREFIX) && key !== CACHE && key !== RUNTIME).map((key) => caches.delete(key))
        )
      ).then(() => self.clients.claim())
    );
  });
  self.addEventListener("message", (event) => {
    if (event.data?.type === config.activateMessage) {
      self.skipWaiting();
    }
  });
  async function sameOrigin(request) {
    const STORE = await caches.open(CACHE);
    const NAVIGATE = request.mode === "navigate";
    let response = await STORE.match(request, { ignoreSearch: NAVIGATE });
    const ADDRESS = new URL(request.url);
    if (!response && NAVIGATE && ADDRESS.pathname.endsWith("/")) {
      response = await STORE.match(new URL("index.html", ADDRESS).href);
    }
    return response ?? fetch(request);
  }
  async function gamekit(request) {
    const CACHED = await caches.match(request);
    if (CACHED) {
      return CACHED;
    }
    const RESPONSE = await fetch(request);
    if (RESPONSE.ok) {
      const STORE = await caches.open(RUNTIME);
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
      event.respondWith(sameOrigin(REQUEST));
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
    precache: PRECACHE,
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
  const START_FILE = (START.pathname.endsWith("/") ? START.pathname + "index.html" : START.pathname).slice(1);
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
    `<link rel="manifest" href="${ESCAPE(HREF(MANIFEST_FILE))}">`,
    `<meta name="theme-color" content="${ESCAPE(THEME_COLOR)}">`,
    `<meta name="description" content="${ESCAPE(DESCRIPTION)}">`,
    `<link rel="icon" type="image/png" sizes="192x192" href="${ESCAPE(HREF(IMAGES.icon192))}">`,
    `<link rel="apple-touch-icon" href="${ESCAPE(HREF(IMAGES.apple))}">`,
    `<meta name="apple-mobile-web-app-title" content="${ESCAPE(SHORT_NAME)}">`,
    '<meta property="og:type" content="website">',
    `<meta property="og:url" content="${ESCAPE(PAGE_URL)}">`,
    `<meta property="og:title" content="${ESCAPE(NAME)}">`,
    `<meta property="og:description" content="${ESCAPE(DESCRIPTION)}">`,
    `<meta property="og:image" content="${ESCAPE(new URL(IMAGES.share, SITE_URL).href)}">`,
    `<meta property="og:image:width" content="${SHARE_SIZE.width}">`,
    `<meta property="og:image:height" content="${SHARE_SIZE.height}">`,
    '<meta name="twitter:card" content="summary_large_image">'
  ];
  OUTPUTS.set(HTML_FILE, Buffer.from(headBlock(await readSource(CWD, HTML, "html"), TAGS), "utf8"));
  const LOCAL = /* @__PURE__ */ new Map();
  for (const FILE of await expandPrecache(CWD, PRECACHE)) {
    const PATH = inside(OUT_DIR, FILE, "precache file");
    if (PATH === WORKER_FILE) {
      fail(`${WORKER_FILE} must not be precached; the browser checks it on every visit`);
    }
    LOCAL.set(PATH, OUTPUTS.get(PATH) ?? await readFile(FILE));
  }
  for (const FILE of [MANIFEST_FILE, IMAGES.icon192, IMAGES.icon512, IMAGES.maskable, IMAGES.apple]) {
    LOCAL.set(FILE, OUTPUTS.get(FILE));
  }
  if (!LOCAL.has(HTML_FILE)) {
    fail(`precache must include ${HTML_FILE} so the game starts offline`);
  }
  if (!LOCAL.has(START_FILE)) {
    fail(`precache must include ${START_FILE} (startUrl ${START_URL})`);
  }
  const LOCAL_FILES = [...LOCAL.keys()].sort();
  const REMOTE = /* @__PURE__ */ new Set();
  for (const FILE of LOCAL_FILES.filter(IS_TEXT)) {
    for (const ADDRESS of LOCAL.get(FILE).toString("utf8").match(GAMEKIT_URL) ?? []) {
      REMOTE.add(ADDRESS);
    }
  }
  const REMOTE_URLS = [...REMOTE].sort();
  const VERSION = SHA256(
    [...LOCAL_FILES.map((file) => `${file}
${SHA256(CANONICAL(file, LOCAL.get(file)))}`), ...REMOTE_URLS].join(
      "\n"
    )
  ).slice(0, 16);
  const CONFIG = {
    version: VERSION,
    activateMessage: "bloom-pwa:activate",
    gamekit: `^${GAMEKIT_URL.source}$`,
    precache: [...LOCAL_FILES, ...REMOTE_URLS]
  };
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

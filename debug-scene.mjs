// modules/debug-tools/scene-runner.js
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
var ANGLE = Object.freeze({
  swiftshader: Object.freeze({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] }),
  gpu: Object.freeze({
    args: ["--use-angle=d3d11", "--ignore-gpu-blocklist", "--enable-gpu"],
    ignoreDefaultArgs: ["--enable-unsafe-swiftshader"]
  })
});
var USAGE = 'usage: "<query>" [--ticks N] [--state <json>] [--capture out.png] [--compare <checkout>] [--compare-query "<query>"] [--repeat N] [--heap] [--gpu] [--json]';
var HEAP_SAMPLING_BYTES = 1024;
function readArguments(argv) {
  const [QUERY, ...REST] = argv;
  if (!QUERY || QUERY.startsWith("--")) {
    throw new Error(USAGE);
  }
  const OPTIONS = {
    query: QUERY,
    ticks: 0,
    state: void 0,
    capture: null,
    compare: null,
    compareQuery: null,
    repeat: 1,
    heap: false,
    gpu: false,
    json: false
  };
  for (let index = 0; index < REST.length; index++) {
    const NAME = REST[index];
    const VALUE = () => {
      const TEXT = REST[++index];
      if (TEXT === void 0) {
        throw new Error(`${NAME} needs a value`);
      }
      return TEXT;
    };
    if (NAME === "--gpu" || NAME === "--heap" || NAME === "--json") {
      OPTIONS[NAME.slice(2)] = true;
    } else if (NAME === "--ticks" || NAME === "--repeat") {
      const COUNT = Number(VALUE());
      if (!Number.isSafeInteger(COUNT) || COUNT < (NAME === "--repeat" ? 1 : 0)) {
        throw new Error(`${NAME} needs an integer`);
      }
      OPTIONS[NAME.slice(2)] = COUNT;
    } else if (NAME === "--state") {
      OPTIONS.state = JSON.parse(VALUE());
    } else if (NAME === "--capture") {
      OPTIONS.capture = resolve(VALUE());
    } else if (NAME === "--compare") {
      OPTIONS.compare = resolve(VALUE());
    } else if (NAME === "--compare-query") {
      OPTIONS.compareQuery = VALUE();
    } else {
      throw new Error(`unknown option ${NAME}
${USAGE}`);
    }
  }
  if (OPTIONS.heap && !OPTIONS.ticks) {
    throw new Error("--heap measures the ticks of --ticks N; give N > 0");
  }
  return OPTIONS;
}
function describeCheckout(root) {
  const GIT = (args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  return { root, commit: GIT(["rev-parse", "--short", "HEAD"]), dirty: GIT(["status", "--porcelain"]) !== "" };
}
async function sampleAllocation(cdp, operation) {
  await cdp.send("HeapProfiler.startSampling", {
    samplingInterval: HEAP_SAMPLING_BYTES,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true
  });
  await operation();
  const { profile: PROFILE } = await cdp.send("HeapProfiler.stopSampling");
  let total = 0;
  const PENDING = [PROFILE.head];
  while (PENDING.length) {
    const NODE = PENDING.pop();
    total += NODE.selfSize;
    PENDING.push(...NODE.children);
  }
  return total;
}
async function runScene(browser, side, options, capture, { viewport, ready }) {
  const CONTEXT = await browser.newContext({ ...viewport ? { viewport } : {}, deviceScaleFactor: 1 });
  const PAGE = await CONTEXT.newPage(), PAGE_ERRORS = [];
  PAGE.on("pageerror", (error) => PAGE_ERRORS.push(error.message));
  try {
    await side.site.route?.(PAGE);
    const URL_TEXT = side.site.url;
    await PAGE.goto(`${URL_TEXT}${URL_TEXT.includes("?") ? "&" : "?"}debug=1&${side.query}`, {
      waitUntil: "domcontentloaded"
    });
    await PAGE.waitForFunction(() => globalThis.__bloomDebug?.error || globalThis.__bloomDebug?.ready, null, {
      timeout: 6e5,
      polling: 100
    });
    const ERROR = await PAGE.evaluate(() => globalThis.__bloomDebug.error);
    if (ERROR) {
      throw new Error(ERROR);
    }
    if (ready) {
      await PAGE.waitForFunction(ready, null, { timeout: 6e5, polling: 100 });
    }
    const STEP = (count) => PAGE.evaluate((n) => globalThis.__bloomDebug.step(n), count, {
      timeout: 6e5
    });
    let heap;
    if (options.heap) {
      const CDP = await CONTEXT.newCDPSession(PAGE);
      const STEPPED = await sampleAllocation(CDP, () => STEP(options.ticks));
      const RENDER = await sampleAllocation(CDP, () => STEP(0));
      await CDP.detach();
      heap = {
        stepBytes: STEPPED,
        renderBytes: RENDER,
        perTickBytes: Math.round((STEPPED - RENDER) / options.ticks)
      };
    } else if (options.ticks) {
      await STEP(options.ticks);
    }
    const STATE = await PAGE.evaluate((state) => globalThis.__bloomDebug.state(state), options.state);
    const HASH = await PAGE.evaluate(() => globalThis.__bloomDebug.hash());
    if (capture) {
      mkdirSync(dirname(capture), { recursive: true });
      await PAGE.screenshot({ path: capture, animations: "disabled" });
    }
    return {
      state: STATE,
      hash: HASH ?? null,
      ...heap ? { heap } : {},
      ...capture ? { capture } : {},
      ...PAGE_ERRORS.length ? { pageErrors: PAGE_ERRORS } : {}
    };
  } finally {
    await CONTEXT.close();
  }
}
var PICK = (value, path) => path.split(".").reduce((item, key) => item?.[key], value);
async function runDebugScene({ chromium, argv, root, serve, ready, fields = [], viewport }) {
  if (typeof chromium?.launch !== "function" || typeof serve !== "function" || typeof root !== "string") {
    throw new TypeError("runDebugScene needs chromium, root and serve");
  }
  const OPTIONS = readArguments(argv);
  const COMPARING = OPTIONS.compare !== null || OPTIONS.compareQuery !== null;
  const ROOTS = [resolve(root), ...COMPARING ? [OPTIONS.compare ?? resolve(root)] : []];
  const SITES = /* @__PURE__ */ new Map();
  let browser;
  try {
    for (const ROOT of new Set(ROOTS)) {
      SITES.set(ROOT, { ...describeCheckout(ROOT), site: await serve(ROOT) });
    }
    const SIDES = ROOTS.map((sideRoot, index) => ({
      name: index ? "B" : "A",
      ...SITES.get(sideRoot),
      query: index && OPTIONS.compareQuery !== null ? OPTIONS.compareQuery : OPTIONS.query
    }));
    browser = await chromium.launch(OPTIONS.gpu ? ANGLE.gpu : ANGLE.swiftshader);
    const RUNS = [];
    for (let round = 0; round < (COMPARING ? OPTIONS.repeat : 1); round++) {
      const ORDER = round % 2 ? [...SIDES].reverse() : SIDES;
      for (const SIDE of ORDER) {
        const CAPTURE = OPTIONS.capture && round === 0 ? SIDE.name === "A" ? OPTIONS.capture : OPTIONS.capture.replace(/(\.[^.\\/]+)?$/, "-compare$1") : null;
        const RESULT = await runScene(browser, SIDE, OPTIONS, CAPTURE, { viewport, ready });
        RUNS.push({
          side: SIDE.name,
          round: round + 1,
          root: SIDE.root,
          commit: SIDE.commit,
          dirty: SIDE.dirty,
          query: SIDE.query,
          gpu: OPTIONS.gpu ? "d3d11" : "swiftshader",
          ...RESULT
        });
      }
    }
    if (!COMPARING) {
      const [RUN] = RUNS;
      const BRIEF = {
        ...RUN.state,
        ...RUN.heap ? { heap: RUN.heap } : {},
        ...RUN.pageErrors ? { pageErrors: RUN.pageErrors } : {}
      };
      console.log(JSON.stringify(OPTIONS.json ? RUN : BRIEF, null, 2));
      return RUNS;
    }
    if (OPTIONS.json) {
      console.log(JSON.stringify(RUNS, null, 2));
    }
    for (const SIDE of SIDES) {
      console.log(
        `${SIDE.name}: ${SIDE.root} @ ${SIDE.commit}${SIDE.dirty ? " (미커밋 변경 있음)" : ""} ?${SIDE.query}`
      );
    }
    console.table(
      RUNS.map((run) => ({
        run: `${run.side} #${run.round}`,
        hash: run.hash,
        ...Object.fromEntries(fields.map((field) => [field, PICK(run.state, field)])),
        ...run.heap ? { "heap B/tick": run.heap.perTickBytes, "render B": run.heap.renderBytes } : {},
        ...run.pageErrors ? { pageErrors: run.pageErrors.length } : {}
      }))
    );
    return RUNS;
  } finally {
    await browser?.close();
    for (const SITE of SITES.values()) {
      await SITE.site.close();
    }
  }
}
export {
  runDebugScene
};

// modules/boot/build.js
import { readFileSync, statSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
var REGEX_AFTER_WORD = /* @__PURE__ */ new Set([
  "return",
  "typeof",
  "instanceof",
  "in",
  "of",
  "new",
  "delete",
  "void",
  "throw",
  "case",
  "do",
  "else",
  "yield",
  "await"
]);
var WORD_START = /[A-Za-z_$#\u0080-￿]/;
var WORD_PART = /[\w$\u0080-￿]/;
var SPACE = /\s/;
var EXTERNAL = /^[a-z][a-z\d+.-]*:/i;
function fail(message) {
  throw new Error(`listModuleGraph: ${message}`);
}
function tokenize(source, file) {
  const TOKENS = [];
  const BRACES = [];
  let i = source.startsWith("#!") ? source.indexOf("\n") + 1 || source.length : 0;
  const PREVIOUS = () => TOKENS.at(-1);
  const REGEX_ALLOWED = () => {
    const TOKEN = PREVIOUS();
    if (!TOKEN) {
      return true;
    }
    if (TOKEN.t === "w") {
      return REGEX_AFTER_WORD.has(TOKEN.v);
    }
    return TOKEN.t === "p" && TOKEN.v !== ")" && TOKEN.v !== "]";
  };
  const TEMPLATE = () => {
    while (i < source.length) {
      const CHAR = source[i];
      if (CHAR === "\\") {
        i += 2;
      } else if (CHAR === "`") {
        i++;
        TOKENS.push({ t: "x" });
        return;
      } else if (CHAR === "$" && source[i + 1] === "{") {
        i += 2;
        BRACES.push("template");
        TOKENS.push({ t: "p", v: "${" });
        return;
      } else {
        i++;
      }
    }
    fail(`unterminated template literal in ${file}`);
  };
  while (i < source.length) {
    const CHAR = source[i];
    if (SPACE.test(CHAR)) {
      i++;
    } else if (CHAR === "/" && source[i + 1] === "/") {
      const END = source.indexOf("\n", i);
      i = END < 0 ? source.length : END;
    } else if (CHAR === "/" && source[i + 1] === "*") {
      const END = source.indexOf("*/", i + 2);
      if (END < 0) {
        fail(`unterminated comment in ${file}`);
      }
      i = END + 2;
    } else if (CHAR === '"' || CHAR === "'") {
      let value = "";
      i++;
      while (source[i] !== CHAR) {
        if (i >= source.length || source[i] === "\n") {
          fail(`unterminated string in ${file}`);
        }
        if (source[i] === "\\") {
          i++;
        }
        value += source[i++];
      }
      i++;
      TOKENS.push({ t: "s", v: value });
    } else if (CHAR === "`") {
      i++;
      TEMPLATE();
    } else if (CHAR === "/" && REGEX_ALLOWED()) {
      let inClass = false;
      i++;
      while (source[i] !== "/" || inClass) {
        if (i >= source.length || source[i] === "\n") {
          fail(`unterminated regular expression in ${file}`);
        }
        if (source[i] === "\\") {
          i++;
        } else if (source[i] === "[") {
          inClass = true;
        } else if (source[i] === "]") {
          inClass = false;
        }
        i++;
      }
      i++;
      while (i < source.length && WORD_PART.test(source[i])) {
        i++;
      }
      TOKENS.push({ t: "x" });
    } else if (WORD_START.test(CHAR)) {
      const START = i++;
      while (i < source.length && WORD_PART.test(source[i])) {
        i++;
      }
      TOKENS.push({ t: "w", v: source.slice(START, i) });
    } else if (/\d/.test(CHAR) || CHAR === "." && /\d/.test(source[i + 1])) {
      while (i < source.length && /[\w.]/.test(source[i])) {
        i++;
      }
      TOKENS.push({ t: "x" });
    } else if (CHAR === "{") {
      i++;
      BRACES.push("brace");
      TOKENS.push({ t: "p", v: "{" });
    } else if (CHAR === "}") {
      i++;
      if (BRACES.pop() === "template") {
        TEMPLATE();
      } else {
        TOKENS.push({ t: "p", v: "}" });
      }
    } else {
      i++;
      TOKENS.push({ t: "p", v: CHAR });
    }
  }
  return TOKENS;
}
var IS = (token, type, value) => token?.t === type && (value === void 0 || token.v === value);
function moduleSpecifiers(source, file) {
  const TOKENS = tokenize(source, file);
  const FOUND = [];
  const FROM = (start) => {
    for (let j = start; j < TOKENS.length - 1; j++) {
      if (IS(TOKENS[j], "p", ";")) {
        return;
      }
      if (IS(TOKENS[j], "w", "from") && IS(TOKENS[j + 1], "s")) {
        FOUND.push(TOKENS[j + 1].v);
        return;
      }
    }
  };
  for (let i = 0; i < TOKENS.length; i++) {
    const TOKEN = TOKENS[i], NEXT = TOKENS[i + 1];
    if (IS(TOKENS[i - 1], "p", ".") || IS(NEXT, "p", ":")) {
      continue;
    }
    if (IS(TOKEN, "w", "import")) {
      if (IS(NEXT, "p", "(")) {
        if (IS(TOKENS[i + 2], "s") && (IS(TOKENS[i + 3], "p", ")") || IS(TOKENS[i + 3], "p", ","))) {
          FOUND.push(TOKENS[i + 2].v);
        }
      } else if (IS(NEXT, "s")) {
        FOUND.push(NEXT.v);
      } else if (!IS(NEXT, "p", ".")) {
        FROM(i + 1);
      }
    } else if (IS(TOKEN, "w", "export") && IS(NEXT, "p", "*")) {
      FROM(i + 1);
    } else if (IS(TOKEN, "w", "export") && IS(NEXT, "p", "{")) {
      let j = i + 2;
      while (j < TOKENS.length && !IS(TOKENS[j], "p", "}")) {
        j++;
      }
      if (IS(TOKENS[j + 1], "w", "from") && IS(TOKENS[j + 2], "s")) {
        FOUND.push(TOKENS[j + 2].v);
      }
    }
  }
  return FOUND;
}
function listModuleGraph({ root, entry, ...rest }) {
  if (Object.keys(rest).length > 0) {
    fail(`unknown option ${Object.keys(rest)[0]}`);
  }
  if (typeof root !== "string" || typeof entry !== "string" || !root || !entry) {
    fail("root and entry must be non-empty strings");
  }
  const ROOT = resolve(root);
  const ROOT_URL = pathToFileURL(ROOT + sep);
  const LOCAL = (url, from) => {
    const PATH = fileURLToPath(url);
    const RELATIVE = relative(ROOT, PATH);
    if (!RELATIVE || RELATIVE.startsWith("..") || resolve(ROOT, RELATIVE) !== PATH) {
      fail(`${from} imports a module outside root: ${url.pathname}`);
    }
    let file;
    try {
      file = statSync(PATH).isFile();
    } catch {
      file = false;
    }
    if (!file) {
      fail(`unresolved import in ${from}: ${RELATIVE.split(sep).join("/")}`);
    }
    return RELATIVE.split(sep).join("/") + url.search;
  };
  const FIRST = LOCAL(new URL(entry, ROOT_URL), "entry");
  const SEEN = /* @__PURE__ */ new Set([FIRST]);
  const ORDER = [FIRST];
  for (let index = 0; index < ORDER.length; index++) {
    const FILE = ORDER[index];
    const FILE_URL = new URL(FILE, ROOT_URL);
    for (const SPECIFIER of moduleSpecifiers(readFileSync(fileURLToPath(FILE_URL), "utf8"), FILE)) {
      if (EXTERNAL.test(SPECIFIER)) {
        continue;
      }
      if (!SPECIFIER.startsWith("./") && !SPECIFIER.startsWith("../")) {
        fail(`unsupported specifier in ${FILE}: ${SPECIFIER} (use ./ or ../)`);
      }
      const NEXT = LOCAL(new URL(SPECIFIER, FILE_URL), FILE);
      if (!SEEN.has(NEXT)) {
        SEEN.add(NEXT);
        ORDER.push(NEXT);
      }
    }
  }
  return ORDER;
}
export {
  listModuleGraph
};

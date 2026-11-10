#!/usr/bin/env node
// brandkit project check. Copied from the artcraft-brand skill (templates/project/check.mjs in the toolkit
// repository): change it there and copy it again, never here, so every site runs the same check.
//
// It checks that this project's brand folder says what it is, and that the site serves the kit as built.
// It reads brandkit.json beside this file (or the path given), and needs Node 18+ and nothing else.
//
//   node brand/check.mjs                         from anywhere: it finds brandkit.json beside itself
//   node brand/check.mjs path/to/brandkit.json
//   node brand/check.mjs --served <dir>          check a staged or built copy (targets with serve.via, or no serve.to)
//
// Exit 0 when nothing fails (warnings allowed), 1 when something fails, 2 when the manifest can't be read or holds a
// value of the wrong type.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const CHECK_VERSION = "brandkit.project/1 r3";
const FORMAT = "brandkit.project/1";
const KINDS = ["generated", "hand-made", "planned"];
const FRAMEWORKS = ["next-app-router", "static", "vite", "worker", "other", "unknown"];
const STATUSES = ["decided", "held", "not-recorded", "not-chosen"];
// Every key the format knows, per object, so a typo anywhere fails instead of switching a check off.
const KEYS = {
  "": ["format", "name", "kind", "owner", "waits_on", "decided", "spec", "kit", "site", "serve", "build", "guards",
    "deploy", "media", "notes"],
  decided: ["part", "status", "what", "by", "under", "date", "words", "record", "waits_on"],
  site: ["urls", "framework", "html", "layout", "snippet", "fonts"],
  "site.html": ["page", "theme_color", "color_scheme", "icons", "pending"],
  serve: ["from", "to", "via", "pending", "files", "omit"],
  "serve.files": ["from", "to"],
  "serve.omit": ["file", "why"],
  build: ["command", "cwd", "fonts", "tools"],
  font: ["family", "file", "path", "fetched", "bundled", "licence", "source", "sha256"],
  tool: ["name", "version", "path"],
  guards: ["path", "runs", "match", "wired"],
  deploy: ["on_merge", "after_deploy", "rules"],
  media: ["name", "recipe", "recipe_note", "outputs", "goes_to", "fonts", "tools", "source"],
};

// The type of every value, so a wrong type stops the check (exit 2) instead of switching part of it off.
const S = "string";
const TYPES = {
  "": { format: S, name: S, kind: S, owner: S, waits_on: S, spec: S, kit: S, notes: "texts", site: "object:site",
    build: "object:build", deploy: "object:deploy", serve: "objects:serve", decided: "objects:decided",
    guards: "objects:guards", media: "objects:media" },
  decided: Object.fromEntries(KEYS.decided.map((k) => [k, S])),
  site: { urls: "texts", framework: S, html: "pages", layout: S, snippet: S, fonts: "objects:font" },
  "site.html": { page: S, theme_color: "texts-or-objects", color_scheme: S, icons: "boolean", pending: S },
  serve: { from: S, to: S, via: S, pending: S, files: "files", omit: "objects:serve.omit" },
  "serve.files": { from: S, to: S },
  "serve.omit": { file: S, why: S },
  build: { command: S, cwd: S, fonts: "objects:font", tools: "objects:tool" },
  font: Object.fromEntries(KEYS.font.map((k) => [k, S])),
  tool: Object.fromEntries(KEYS.tool.map((k) => [k, S])),
  guards: { path: S, runs: S, match: S, wired: "boolean" },
  deploy: Object.fromEntries(KEYS.deploy.map((k) => [k, S])),
  media: { name: S, recipe: S, recipe_note: S, outputs: "texts", goes_to: S, fonts: "objects:font", tools: "objects:tool", source: S },
};
function typecheck(obj, kind, path) {
  const isObject = (v) => Boolean(v) && typeof v === "object" && !Array.isArray(v);
  for (const [key, value] of Object.entries(obj)) {
    const want = TYPES[kind][key];
    if (!want || value === undefined) continue;
    const here = path ? `${path}.${key}` : key;
    const bad = (what) => { throw new TypeError(`${here} should be ${what}, got ${JSON.stringify(value)?.slice(0, 40)}`); };
    const each = (v) => (Array.isArray(v) ? v : [v]);
    if (want === S) { if (typeof value !== "string") bad("text"); }
    else if (want === "boolean") { if (typeof value !== "boolean") bad("true or false"); }
    else if (want === "texts") { if (!each(value).every((v) => typeof v === "string")) bad("text or a list of text"); }
    else if (want === "texts-or-objects") { if (!each(value).every((v) => typeof v === "string" || isObject(v))) bad("a colour or a list of them"); }
    else if (want.startsWith("object:")) { if (!isObject(value)) bad("an object"); typecheck(value, want.slice(7), here); }
    else if (want.startsWith("objects:")) {
      each(value).forEach((v, i) => {
        if (!isObject(v)) bad("an object or a list of objects");
        typecheck(v, want.slice(8), Array.isArray(value) ? `${here}[${i}]` : here);
      });
    } else if (want === "files" || want === "pages") {
      each(value).forEach((v, i) => {
        if (typeof v === "string") return;
        if (!isObject(v)) bad(want === "files" ? "a list of names or {from, to}" : "a list of paths or page objects");
        typecheck(v, want === "files" ? "serve.files" : "site.html", `${here}[${i}]`);
      });
    }
  }
}

// --- arguments and manifest ----------------------------------------------------------------------------------
const argv = process.argv.slice(2);
let servedOverride = null;
const positional = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--served") servedOverride = resolve(argv[++i] ?? ".");
  else if (argv[i].startsWith("--served=")) servedOverride = resolve(argv[i].slice(9));
  else positional.push(argv[i]);
}
const HERE = dirname(fileURLToPath(import.meta.url));
const manifestPath = resolve(positional[0] ?? join(HERE, "brandkit.json"));
const BASE = dirname(manifestPath);
let m;
try {
  m = JSON.parse(readFileSync(manifestPath, "utf8"));
} catch (error) {
  console.error(`brandkit check: can't read ${manifestPath}: ${error.message}`);
  process.exit(2);
}
if (!m || typeof m !== "object" || Array.isArray(m)) {
  console.error(`brandkit check: ${manifestPath} is not a JSON object`);
  process.exit(2);
}

// --- helpers -------------------------------------------------------------------------------------------------
const results = [];
const ok = (what) => results.push(["ok", what]);
const fail = (what) => results.push(["FAIL", what]);
const warn = (what) => results.push(["warn", what]);
// The repository root: the nearest folder with .git, but never the home folder (on some Macs ~ is a repository).
const HOME = resolve(homedir());
const ROOT = (() => {
  for (let dir = BASE; ; dir = dirname(dir)) {
    if (dir === HOME) return null;
    if (existsSync(join(dir, ".git"))) return dir;
    if (dirname(dir) === dir) return null;
  }
})();
let rootGuessed = false;
// A path starting with "/" is from the repository root; any other is from this folder.
const at = (p) => {
  if (typeof p !== "string") throw new TypeError(`expected a path, got ${JSON.stringify(p)}`);
  if (!p.startsWith("/")) return resolve(BASE, p);
  if (!ROOT) rootGuessed = true;
  return resolve(ROOT ?? BASE, `.${p}`);
};
const atIn = (dir, p) => (String(p).startsWith("/") ? at(p) : resolve(dir, p));
const isFile = (p) => { try { return statSync(p).isFile(); } catch { return false; } };
const isDir = (p) => { try { return statSync(p).isDirectory(); } catch { return false; } };
const list = (v) => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]);
const sha256 = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
const posix = (p) => p.split(sep).join("/");
// A value init left as "TODO: …" (or empty) counts as missing.
const filled = (v) => typeof v === "string" && v.trim() !== "" && !/^\s*TODO\b/i.test(v) && !/\bTODO:/.test(v);
const short = (text, n = 110) => (String(text).length > n ? `${String(text).slice(0, n - 1)}…` : String(text));
// rel() prints an absolute path; shown() prints a path as written in the manifest.
const rel = (abs) => posix(relative(ROOT ?? BASE, abs)) || ".";
const shown = (p) => rel(at(p));
const inside = (child, parent) => child === parent || child.startsWith(parent + sep);
const real = (p) => { try { return realpathSync.native(p); } catch { return null; } };
// git says the path is ignored (a recipe's output folder); false without git or a repository.
const ignored = (p) => Boolean(ROOT) && spawnSync("git", ["-C", ROOT, "check-ignore", "-q", p]).status === 0;

function checkKeys(obj, kind, path) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return;
  for (const key of Object.keys(obj)) {
    if (!KEYS[kind].includes(key)) fail(`unknown key ${path ? `${path}.` : ""}${key} (a typo would switch a check off)`);
  }
}

// A small glob: * and ? within one path segment, ** across segments; brackets are literal (for [slug] folders).
// Patterns are relative to `base`, or to the repository root when they start with "/". The walk skips node_modules,
// .git and this brand folder (unless the pattern starts inside it). Returns absolute paths of files.
function expand(pattern, base = BASE) {
  if (!/[*?]/.test(pattern)) return [atIn(base, pattern)];
  const parts = pattern.split("/");
  const fixed = [];
  while (parts.length && !/[*?]/.test(parts[0])) fixed.push(parts.shift());
  const start = fixed.join("/") === "" ? (pattern.startsWith("/") ? at("/") : base) : atIn(base, fixed.join("/"));
  const segment = (part) => part.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]");
  let source = "";
  parts.forEach((part, i) => {
    const last = i === parts.length - 1;
    if (part === "**") source += last ? ".*" : "(?:[^/]+/)*";
    else source += segment(part) + (last ? "" : "/");
  });
  const rx = new RegExp(`^${source}$`);
  const out = [];
  const walk = (dir, rel) => {
    let entries = [];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      if (full === BASE && !inside(start, BASE)) continue;
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(full, childRel);
      else if (rx.test(childRel)) out.push(full);
    }
  };
  walk(start, "");
  return out.sort();
}

// Head tags read as HTML: comments dropped, attributes in any order, any quoting.
function tags(text, name) {
  const out = [];
  for (const [, body] of text.replace(/<!--[\s\S]*?-->/g, "").matchAll(new RegExp(`<${name}\\b([^>]*)>`, "gi"))) {
    const attrs = {};
    for (const [, key, raw] of body.matchAll(/([\w:-]+)\s*=\s*("[^"]*"|'[^']*'|[^\s"'>]+)/g)) {
      attrs[key.toLowerCase()] = raw.replace(/^["']|["']$/g, "").trim();
    }
    out.push(attrs);
  }
  return out;
}
const norm = (s) => String(s ?? "").toLowerCase().replace(/\s+/g, " ").trim();
const themeSet = (metas) => metas.filter((a) => norm(a.name) === "theme-color")
  .map((a) => `${norm(a.content)}${a.media ? ` @ ${norm(a.media)}` : ""}`).sort();
const schemes = (metas) => metas.filter((a) => norm(a.name) === "color-scheme").map((a) => norm(a.content));
// rel is a list of tokens: "alternate icon" and "shortcut icon" are icons too.
const relKind = (rel) => {
  const tokens = norm(rel).split(" ");
  if (tokens.some((t) => t.startsWith("apple-touch-icon"))) return "apple-touch-icon";
  for (const kind of ["manifest", "mask-icon"]) if (tokens.includes(kind)) return kind;
  return tokens.includes("icon") ? "icon" : null;
};

try {
// --- the manifest itself -------------------------------------------------------------------------------------
typecheck(m, "", "");
checkKeys(m, "", "");
if (m.format !== FORMAT) fail(`format is ${JSON.stringify(m.format)}, expected "${FORMAT}"`);
if (!filled(m.name)) fail("name is missing");
if (!KINDS.includes(m.kind)) fail(`kind is ${JSON.stringify(m.kind)}, expected one of ${KINDS.join(", ")}`);
const planned = m.kind === "planned";
const site = m.site ?? {};
checkKeys(site, "site", "site");
list(site.fonts).forEach((font, i) => checkKeys(font, "font", `site.fonts[${i}]`));
const urls = list(site.urls);
if (!urls.length) fail("site.urls names no live address");
for (const url of urls) {
  if (typeof url !== "string" || !/^https:\/\/[^\s/]+/.test(url)) fail(`site.urls: ${JSON.stringify(url)} is not an https address`);
}
const origins = urls.filter((u) => typeof u === "string").map((u) => u.replace(/^(https:\/\/[^/]+).*$/, "$1").toLowerCase());
if (site.framework !== undefined && !FRAMEWORKS.includes(site.framework)) {
  fail(`site.framework ${JSON.stringify(site.framework)} is not one of ${FRAMEWORKS.join(", ")}`);
}
if (planned && !filled(m.waits_on)) warn("kind is planned: say in waits_on what the kit waits for");

// Who chose the look, as recorded (the check verifies the shape, not the history). Any mention of Yu, unless the
// entry starts with an agent, makes it a decision by Yu: that needs Yu's own words, or a record file in this
// repository outside the brand folder. An agent's call starts with the agent and names its authority in `under`.
const decided = list(m.decided);
if (!decided.length) (planned ? warn : fail)("decided is missing: who chose the look, when, and where that is written down");
for (const [i, d] of decided.entries()) {
  const path = decided.length > 1 ? `decided[${i}]` : "decided";
  if (!d || typeof d !== "object" || Array.isArray(d)) { fail(`${path} is not an object`); continue; }
  checkKeys(d, "decided", path);
  const status = d.status ?? "decided";
  const label = d.part ? `${d.part}: ` : "";
  if (!STATUSES.includes(status)) { fail(`${path}.status ${JSON.stringify(status)} is not one of ${STATUSES.join(", ")}`); continue; }
  if (status !== "decided") {
    if (filled(d.waits_on) || filled(d.record)) ok(`${label}look ${status} (${short(filled(d.waits_on) ? d.waits_on : d.record, 80)})`);
    else warn(`${path}: status ${status} should say what it waits on (waits_on) or where that is recorded (record)`);
    continue;
  }
  const missing = ["by", "date", "record"].filter((key) => !filled(d[key]));
  if (missing.length) {
    (planned ? warn : fail)(`${path} needs ${missing.join(", ")}: who chose the look, when, and where that is written down`);
    continue;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d.date) || !(Date.parse(`${d.date}T00:00:00Z`) >= 0 && new Date(`${d.date}T00:00:00Z`).toISOString().startsWith(d.date))) fail(`${path}.date ${JSON.stringify(d.date)} is not a YYYY-MM-DD date`);
  const byYu = /\byu\b/i.test(d.by) && !/^\W*agents?\b/i.test(d.by);
  const hit = ROOT ? [at(d.record), resolve(ROOT, d.record)].find(isFile) : null;
  const recordFile = hit && inside(real(hit), real(ROOT)) && !inside(real(hit), real(BASE)) ? hit : null;
  const agentNamingYu = !byYu && /^\W*agents?\b/i.test(d.by) && /\byu\b/i.test(d.by);
  if (agentNamingYu && !filled(d.words) && !recordFile) fail(`${path}: by names Yu, which reads as Yu's decision: put the agent's authority in under, or give Yu's words or a record file`);
  else if (!byYu && /^\W*agents?\b/i.test(d.by) && !filled(d.under)) warn(`${path}: an agent's call should name its authority in under`);
  if (agentNamingYu && !filled(d.words) && !recordFile) {
    // reported above
  } else if (byYu && !filled(d.words) && !recordFile) {
    fail(`${path}: a decision by Yu needs Yu's own words (words) or a record file in this repository outside the brand folder (record); ${JSON.stringify(short(d.record, 60))} is neither`);
  } else {
    ok(`${label}look as recorded: ${d.what ? `${short(d.what, 60)}; ` : ""}by ${short(d.by, 60)}${filled(d.under) ? `, under ${short(d.under, 50)}` : ""} on ${d.date} (${short(d.record, 50)})`);
  }
}

for (const name of ["README.md", "CREDITS.md"]) {
  if (!isFile(at(name))) fail(`${name} missing beside brandkit.json`);
  else if (/\bTODO:/.test(readFileSync(at(name), "utf8"))) warn(`${name} still has TODO: lines to fill in`);
  else ok(`${name} present`);
}
const todos = [];
(function walk(value, path) {
  if (typeof value === "string") { if (/^\s*TODO\b/i.test(value) || /\bTODO:/.test(value)) todos.push(path); }
  else if (Array.isArray(value)) value.forEach((item, i) => walk(item, `${path}[${i}]`));
  else if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) walk(v, path ? `${path}.${k}` : k);
})(m, "");
if (todos.length) warn(`brandkit.json still has TODO at ${todos.join(", ")}`);
const build = m.build ?? {};
checkKeys(build, "build", "build");
list(build.fonts).forEach((font, i) => checkKeys(font, "font", `build.fonts[${i}]`));
list(build.tools).forEach((tool, i) => checkKeys(tool, "tool", `build.tools[${i}]`));
checkKeys(m.deploy, "deploy", "deploy");

// --- the kit -------------------------------------------------------------------------------------------------
const kitDir = m.kit === undefined ? null : at(m.kit);
const kitReady = Boolean(!planned && kitDir && isDir(kitDir));
let fingerprint = null;
if (planned) {
  if (kitDir && isDir(kitDir)) warn("kind is planned but the kit folder exists: set kind to generated or hand-made");
  else ok("no kit yet (planned)");
} else if (!kitReady) {
  fail(`kit folder ${m.kit ? shown(m.kit) : "(kit not set)"} not found: build it, or set kind to planned`);
}
if (m.kind === "generated") {
  const spec = m.spec === undefined ? null : at(m.spec);
  if (!spec || !isFile(spec)) fail(`spec ${m.spec ? shown(m.spec) : "(spec not set)"} not found: a generated kit needs its brand.json`);
  else ok(`spec ${shown(m.spec)} present`);
  if (kitReady) {
    try {
      const generator = JSON.parse(readFileSync(join(kitDir, "kit.json"), "utf8")).generator;
      if (generator) ok(`kit built by ${generator}`);
      else fail(`${rel(join(kitDir, "kit.json"))} names no generator`);
    } catch {
      fail(`${rel(join(kitDir, "kit.json"))} missing or not JSON: rebuild the kit with artcraft-brand`);
    }
    try {
      fingerprint = JSON.parse(readFileSync(join(kitDir, ".brandkit-fingerprint"), "utf8")).paths ?? null;
    } catch {
      const v = (/(\d+)\.(\d+)\s*$/.exec(JSON.parse(readFileSync(join(kitDir, "kit.json"), "utf8")).generator ?? "") ?? []).slice(1).map(Number);
      (v.length && (v[0] > 1 || v[1] >= 6) ? fail : warn)("the kit has no .brandkit-fingerprint: hand edits to it can't be told apart (rebuild with generator 1.6 or later)");
    }
    // A stale or hand-edited kit. The kit keeps the spec and marks it was built from in source/, and the
    // fingerprint records every file the generator wrote, source/ included.
    if (fingerprint) {
      const drifted = Object.entries(fingerprint)
        .filter(([key, value]) => key.startsWith("source/") && typeof value === "string" && value.startsWith("file "))
        .filter(([key, value]) => !isFile(join(kitDir, key)) || value !== `file ${sha256(join(kitDir, key))}`)
        .map(([key]) => key);
      if (drifted.length) fail(`the kit's ${drifted.join(", ")} changed after the build: rebuild the kit from it`);
    }
    const copy = join(kitDir, "source", "brand.json");
    if (spec && isFile(spec) && isFile(copy) && resolve(spec) !== resolve(copy)) {
      try {
        const a = JSON.parse(readFileSync(spec, "utf8"));
        const b = JSON.parse(readFileSync(copy, "utf8"));
        const marks = [];
        for (const key of ["svg", "small"]) {
          if (typeof a.mark?.[key] === "string" && typeof b.mark?.[key] === "string") {
            marks.push([resolve(dirname(spec), a.mark[key]), join(kitDir, "source", b.mark[key])]);
            a.mark[key] = "(mark)";
            b.mark[key] = "(mark)";
          }
        }
        const sorted = (v) => JSON.stringify(v, (k, x) => (x && typeof x === "object" && !Array.isArray(x)
          ? Object.fromEntries(Object.entries(x).sort(([p], [q]) => p.localeCompare(q))) : x));
        const changedMark = marks.find(([mine, theirs]) => isFile(mine) && isFile(theirs) && sha256(mine) !== sha256(theirs));
        const lostMark = marks.find(([mine]) => !isFile(mine));
        if (lostMark) fail(`${rel(lostMark[0])}, named by the spec, is missing`);
        else if (sorted(a) !== sorted(b)) fail(`${shown(m.spec)} changed since the kit was built: rebuild the kit`);
        else if (changedMark) fail(`${rel(changedMark[0])} changed since the kit was built: rebuild the kit`);
        else ok("the kit was built from the spec and marks as they are now");
      } catch (error) {
        fail(`can't compare the spec with the kit's copy: ${error.message}`);
      }
    }
  }
} else if (kitReady) {
  ok(`hand-made kit at ${shown(m.kit)}`);
}

// --- served files --------------------------------------------------------------------------------------------
const targets = list(m.serve);
if (!planned && !targets.length) fail("serve is not set: which kit files does the site serve, and from where?");
let servedUsed = false;
for (const [ti, target] of targets.entries()) {
  const path = targets.length > 1 ? `serve[${ti}]` : "serve";
  if (!target || typeof target !== "object" || Array.isArray(target)) { fail(`${path} is not an object`); continue; }
  checkKeys(target, "serve", path);
  const files = list(target.files);
  files.forEach((f, i) => { if (f && typeof f === "object") checkKeys(f, "serve.files", `${path}.files[${i}]`); });
  const names = files.flatMap((f) => (typeof f === "string" ? [f] : [f?.from, f?.to].filter(Boolean)));
  for (const [i, o] of list(target.omit).entries()) {
    checkKeys(o, "serve.omit", `${path}.omit[${i}]`);
    if (!o?.file || !filled(o.why)) fail(`${path}.omit[${i}] needs file and why`);
    else if (names.includes(o.file)) fail(`${path}: ${o.file} is both served and omitted`);
    else ok(`${o.file} left out on purpose: ${short(o.why, 80)}`);
  }
  if (target.pending !== undefined && typeof target.pending !== "string") warn(`${path}.pending should say what adoption waits on, as text`);
  if (planned) continue;
  const pending = filled(target.pending) ? target.pending : null;
  const from = target.from ?? (m.kind === "generated" && typeof m.kit === "string" ? join(m.kit, "web") : null);
  let to = target.to ?? null;
  if (servedOverride && (target.via || !target.to)) { to = servedOverride; servedUsed = true; }
  if (!from) { fail(`${path}.from is not set: where are the built files this site serves?`); continue; }
  const fromDir = at(from);
  if (!files.length) { fail(`${path}.files lists nothing`); continue; }
  const pairs = files.map((entry) => {
    const src = typeof entry === "string" ? entry : entry?.from;
    const dest = typeof entry === "string" ? entry : entry?.to ?? entry?.from;
    return { src, dest, kitFile: typeof src === "string" ? atIn(fromDir, src) : null };
  });
  for (const { src, kitFile } of pairs) {
    if (!src || !kitFile) { fail(`${path}.files has an entry with no name`); continue; }
    if (!isFile(kitFile)) {
      // A hand-made kit's recipe may write its outputs to an ignored folder: they exist only where it last ran.
      if (m.kind === "hand-made" && ignored(kitFile)) warn(`${rel(kitFile)} is not in this checkout: run the kit's recipe to compare it`);
      else fail(`${rel(kitFile)} is not there to serve`);
      continue;
    }
    if (fingerprint && kitDir && inside(kitFile, kitDir)) {
      const key = posix(relative(kitDir, kitFile));
      if (!(key in fingerprint)) fail(`${rel(kitFile)} was not written by the generator: rebuild, never add to the kit by hand`);
      else if (fingerprint[key] !== `file ${sha256(kitFile)}`) fail(`${rel(kitFile)} differs from what the generator wrote: rebuild, never edit the kit by hand`);
    }
  }
  if (!to) {
    if (filled(target.via)) warn(`${path}: served via ${short(target.via, 70)}; run \`node ${rel(join(BASE, "check.mjs"))} --served <staged folder>\` where it stages`);
    else fail(`${path}.to is not set: where does the site serve the files from?`);
    continue;
  }
  const toDir = to === servedOverride ? servedOverride : at(to);
  if (pending) warn(`${path}: adoption pending (${short(pending, 80)}); files not yet served are warnings until then`);
  for (const { src, dest, kitFile } of pairs) {
    if (!src || !kitFile || !isFile(kitFile)) continue;
    const servedFile = atIn(toDir, dest);
    if (!isFile(servedFile)) (pending ? warn : fail)(`${rel(servedFile)} is not served`);
    else if (!readFileSync(kitFile).equals(readFileSync(servedFile))) fail(`${rel(servedFile)} differs from ${rel(kitFile)}: copy it again or rebuild`);
    else ok(`${rel(servedFile)} matches ${rel(kitFile)}`);
  }
  const manifestPair = pairs.find((p) => typeof p.src === "string" && p.src.split("/").pop() === "site.webmanifest");
  const servedManifest = manifestPair ? atIn(toDir, manifestPair.dest) : null;
  if (servedManifest && isFile(servedManifest)) {
    let web = null;
    try { web = JSON.parse(readFileSync(servedManifest, "utf8")); } catch (error) { fail(`${rel(servedManifest)} is not JSON: ${error.message}`); }
    if (web) {
      const icons = Array.isArray(web.icons) ? web.icons : [];
      const notServed = icons.map((icon) => (typeof icon?.src === "string" ? icon.src.replace(/[?#].*$/, "") : null))
        .filter((src) => !src || !isFile(src.startsWith("/") ? resolve(toDir, `.${src}`) : resolve(dirname(servedManifest), src)))
        .map((src) => src ?? "(no src)");
      if (!icons.length) warn(`${rel(servedManifest)} lists no icons`);
      else if (notServed.length) (pending ? warn : fail)(`${rel(servedManifest)} names icons not served: ${notServed.join(", ")}`);
      else ok(`every icon in ${rel(servedManifest)} is served`);
    }
  }
}
if (servedOverride && !servedUsed) fail("--served was given, but no serve target has via or lacks to: nothing was checked there");

// --- head tags -----------------------------------------------------------------------------------------------
// Files that hold page heads (HTML, templates, worker modules). A file with several <head> sections is checked per
// section. Kit expectations come from the head snippet; an entry may name its own. While adoption is pending (the
// page's own pending, or the only serve target's), the page still has its old head, so mismatches are warnings.
const firstFrom = targets[0]?.from ?? (typeof m.kit === "string" ? join(m.kit, "web") : null);
const snippetPath = site.snippet ? at(site.snippet) : firstFrom ? join(at(firstFrom), "head-snippet.html") : null;
const snippet = snippetPath && isFile(snippetPath) && !planned ? readFileSync(snippetPath, "utf8") : null;
if (site.snippet && !isFile(at(site.snippet))) fail(`site.snippet ${shown(site.snippet)} not found`);
const allPending = targets.length > 0 && targets.every((t) => filled(t?.pending));
const pages = new Map();
const entries = list(site.html).map((entry, i) => ({ entry, i }));
for (const { entry, i } of [...entries.filter((e) => typeof e.entry === "string"), ...entries.filter((e) => typeof e.entry !== "string")]) {
  const want = typeof entry === "string" ? { page: entry } : entry;
  if (!want || typeof want !== "object" || Array.isArray(want)) { fail(`site.html[${i}] is neither a path nor an object`); continue; }
  checkKeys(want, "site.html", `site.html[${i}]`);
  if (typeof want.page !== "string") { fail(`site.html[${i}] names no page`); continue; }
  const found = expand(want.page).filter(isFile);
  if (!found.length) { fail(`site.html: ${want.page} matches no file`); continue; }
  for (const page of found) pages.set(page, { ...want, page });
}
if (pages.size && !snippet && !planned && [...pages.values()].some((w) => w.theme_color === undefined || w.icons !== false)) {
  fail("site.html is set but there is no head snippet to compare with (set site.snippet)");
}
if (snippet && fingerprint && kitDir && inside(snippetPath, kitDir)) {
  const key = posix(relative(kitDir, snippetPath));
  if (fingerprint[key] !== `file ${sha256(snippetPath)}`) fail(`${rel(snippetPath)} differs from what the generator wrote: pages are held to it, so rebuild, never edit it`);
}
const kitMetas = snippet ? tags(snippet, "meta") : [];
const kitLinks = snippet ? tags(snippet, "link") : [];
const linkKey = (a) => {
  let href = String(a.href ?? "").replace(/[?#].*$/, "");
  for (const origin of origins) {
    for (const prefix of [origin, origin.slice("https:".length)]) if (href.toLowerCase().startsWith(prefix + "/") || href.toLowerCase() === prefix) { href = href.slice(prefix.length) || "/"; break; }
  }
  return `${relKind(a.rel)} ${href}`;
};
for (const want of pages.values()) {
  const soft = filled(want.pending) || allPending ? warn : null;
  const missingSoft = soft ?? fail;
  const wrong = soft ?? fail;
  const text = readFileSync(want.page, "utf8").replace(/<!--[\s\S]*?-->/g, "");
  const blocks = text.match(/<head(?=[\s>])[\s\S]*?<\/head>/gi) ?? [];
  const heads = blocks.length ? blocks : [text];
  heads.forEach((head, h) => {
    const where = `${rel(want.page)}${heads.length > 1 ? ` (head ${h + 1})` : ""}`;
    const metas = tags(head, "meta");
    const wantTheme = want.theme_color !== undefined
      ? list(want.theme_color).map((t) => (typeof t === "string" ? norm(t) : `${norm(t?.color)}${t?.media ? ` @ ${norm(t.media)}` : ""}`)).sort()
      : snippet ? themeSet(kitMetas) : null;
    if (wantTheme) {
      const haveTheme = themeSet(metas);
      if (JSON.stringify(haveTheme) === JSON.stringify(wantTheme)) ok(`${where}: theme-color as expected`);
      else (haveTheme.length ? wrong : missingSoft)(`${where}: theme-color ${JSON.stringify(haveTheme)}, expected ${JSON.stringify(wantTheme)}`);
    }
    const wantScheme = want.color_scheme !== undefined ? norm(want.color_scheme) : snippet ? schemes(kitMetas)[0] : undefined;
    const haveScheme = schemes(metas);
    if (wantScheme) {
      if (haveScheme.length === 1 && haveScheme[0] === wantScheme) ok(`${where}: one color-scheme "${wantScheme}"`);
      else (haveScheme.length ? wrong : missingSoft)(`${where}: needs exactly one color-scheme "${wantScheme}", found ${JSON.stringify(haveScheme)}`);
    } else if (haveScheme.length > 1) wrong(`${where}: ${haveScheme.length} color-scheme metas`);
    if (snippet && want.icons !== false) {
      const kitIcons = kitLinks.filter((a) => relKind(a.rel)).map(linkKey);
      const have = tags(head, "link").filter((a) => relKind(a.rel)).map(linkKey);
      const lacking = kitIcons.filter((link) => !have.includes(link));
      const extra = have.filter((link) => !kitIcons.includes(link));
      if (lacking.length) missingSoft(`${where}: lacks the kit's ${lacking.join(", ")}`);
      if (extra.length) wrong(`${where}: links another icon: ${extra.map((l) => short(l, 60)).join(", ")}`);
      if (!lacking.length && !extra.length && kitIcons.length) ok(`${where}: icon links as the kit`);
    }
  });
}
// Source text without comments; strings (quoted or template) are kept whole, so "https://…" survives.
function stripComments(src) {
  let out = "";
  let quote = null;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      out += c;
      if (c === "\\") { out += src[i + 1] ?? ""; i++; } else if (c === quote) quote = null;
    } else if (c === '"' || c === "'" || c === "`") { quote = c; out += c; }
    else if (c === "/" && src[i + 1] === "/") { while (i < src.length && src[i] !== "\n") i++; out += "\n"; }
    else if (c === "/" && src[i + 1] === "*") { const end = src.indexOf("*/", i + 2); i = end < 0 ? src.length : end + 1; }
    else out += c;
  }
  return out;
}
// A Next.js layout writes the head from metadata and viewport: comments aside, it must carry the kit's theme colours
// and exactly the kit's colorScheme.
if (site.layout) {
  if (!isFile(at(site.layout))) fail(`site.layout ${shown(site.layout)} not found`);
  else if (snippet) {
    const layout = stripComments(readFileSync(at(site.layout), "utf8")).toLowerCase();
    const colours = kitMetas.filter((a) => norm(a.name) === "theme-color").map((a) => norm(a.content));
    const absent = colours.filter((c) => !layout.includes(c));
    const layoutSoft = allPending ? warn : fail;
    if (absent.length) layoutSoft(`${shown(site.layout)}: the layout lacks the kit's theme colours ${absent.join(", ")}`);
    else if (colours.length) ok(`${shown(site.layout)}: theme colours as the kit`);
    const scheme = schemes(kitMetas)[0];
    const found = [...layout.matchAll(/colorscheme\s*:\s*["'`]([^"'`]+)["'`]/g)].map((x) => norm(x[1]));
    if (scheme && found.some((s) => s !== scheme)) layoutSoft(`${shown(site.layout)}: colorScheme ${JSON.stringify(found)}, the kit says "${scheme}"`);
    else if (scheme && !found.length) layoutSoft(`${shown(site.layout)}: needs viewport.colorScheme "${scheme}"`);
    else if (scheme) ok(`${shown(site.layout)}: colorScheme "${scheme}"`);
  }
}

// --- guards --------------------------------------------------------------------------------------------------
// A guard is a test or check that holds the site to the kit. It counts when the file named in `runs` (a workflow,
// package.json or test) names the guard's path, or, for a runner that picks tests up by pattern, when the guard
// falls under `match` (a glob from the runs file's folder, or from the repository root when it starts with "/").
let running = 0;
for (const [i, guard] of list(m.guards).entries()) {
  if (!guard || typeof guard !== "object") { fail(`guards[${i}] is not an object`); continue; }
  checkKeys(guard, "guards", `guards[${i}]`);
  if (typeof guard.path !== "string" || !isFile(at(guard.path))) { fail(`guard ${typeof guard.path === "string" ? shown(guard.path) : `[${i}] (no path)`} not found`); continue; }
  const guardFile = at(guard.path);
  if (guard.wired === false) { warn(`guard ${rel(guardFile)} is run by hand only`); continue; }
  if (typeof guard.runs !== "string" || !isFile(at(guard.runs))) {
    warn(`guard ${rel(guardFile)}: runs should name the file that runs it (a CI workflow, package.json or test)`);
    continue;
  }
  const runsFile = at(guard.runs);
  if (runsFile === guardFile || inside(runsFile, BASE)) { fail(`guard ${rel(guardFile)}: runs can't be the guard itself or a file in the brand folder`); continue; }
  const text = readFileSync(runsFile, "utf8");
  const needles = [ROOT && posix(relative(ROOT, guardFile)), posix(relative(dirname(runsFile), guardFile))].filter(Boolean);
  if (needles.some((n) => text.includes(n))) { ok(`guard ${rel(guardFile)}, run by ${rel(runsFile)}`); running++; continue; }
  if (typeof guard.match === "string") {
    const pattern = /[*?]/.test(guard.match) ? guard.match : `${guard.match.replace(/\/$/, "")}/**`;
    const runner = /(^|[\\/])package\.json$|\.ya?ml$/.test(runsFile) && /\b(bun test|vitest|jest|tsx --test|node --test|playwright test|mocha|pytest)\b/.test(text);
    if (!runner) fail(`guard ${rel(guardFile)}: ${rel(runsFile)} is not a package.json or workflow that runs a test runner, so match ${guard.match} picks nothing up`);
    else if (expand(pattern, dirname(runsFile)).includes(guardFile)) {
      ok(`guard ${rel(guardFile)}, run by ${rel(runsFile)}, which picks up ${guard.match} (as recorded)`);
      running++;
    } else fail(`guard ${rel(guardFile)}: it doesn't fall under match ${guard.match}`);
    continue;
  }
  fail(`guard ${rel(guardFile)}: ${rel(runsFile)} doesn't name ${needles.join(" or ")} (for a runner that finds tests by pattern, set match)`);
}
if (!planned && !running) warn("nothing runs a guard automatically: add this check (or a sync test) to CI and record it in guards");

// --- media ---------------------------------------------------------------------------------------------------
for (const [i, piece] of list(m.media).entries()) {
  if (!piece || typeof piece !== "object" || Array.isArray(piece)) { fail(`media[${i}] is not an object`); continue; }
  checkKeys(piece, "media", `media[${i}]`);
  list(piece.fonts).forEach((font, j) => checkKeys(font, "font", `media[${i}].fonts[${j}]`));
  list(piece.tools).forEach((tool, j) => checkKeys(tool, "tool", `media[${i}].tools[${j}]`));
  const label = piece.name ?? `media[${i}]`;
  let missing = 0;
  if (piece.recipe !== undefined) {
    if (!isFile(at(piece.recipe))) { fail(`media "${label}": recipe ${shown(piece.recipe)} not found`); missing++; }
  } else if (!filled(piece.recipe_note)) warn(`media "${label}": no recipe, and no recipe_note saying how it was made`);
  const outputs = list(piece.outputs);
  for (const out of outputs) {
    if (!expand(out).filter(isFile).length) { fail(`media "${label}": ${out} matches no file`); missing++; }
  }
  if (!outputs.length && !filled(piece.source)) warn(`media "${label}": no outputs in this repository, and no source saying where they are`);
  if (!filled(piece.goes_to)) warn(`media "${label}": goes_to doesn't say where it is used`);
  if (!missing && (outputs.length || piece.recipe)) ok(`media "${label}": ${piece.recipe ? "recipe and " : ""}${outputs.length ? "outputs " : ""}present`);
}
if (rootGuessed) warn("no repository root was found (no .git above this folder): paths starting with / were read from this folder");
} catch (error) {
  fail(`brandkit.json holds a value of the wrong type: ${error.message}`);
  results.crashed = true;
}

// --- report --------------------------------------------------------------------------------------------------
const failed = results.filter(([state]) => state === "FAIL").length;
const warned = results.filter(([state]) => state === "warn").length;
console.log(`brandkit check (${CHECK_VERSION}) · ${m.name ?? "(no name)"} · ${rel(manifestPath)}`);
for (const [state, what] of results) console.log(`  ${state.padEnd(4)}  ${what}`);
console.log(`${failed ? "FAILED" : "passed"}: ${results.length - failed - warned} ok, ${warned} warnings, ${failed} failures`);
process.exit(results.crashed ? 2 : failed ? 1 : 0);

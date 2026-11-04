#!/usr/bin/env node
/**
 * Subsystem dependency inventory (analysis, not a gate).
 *
 * Groups every non-test TypeScript source under app/, components/, hooks/,
 * lib/, stores/, types/, packages/, plugins/ and cli/ into a subsystem key
 * (`lib/chat`, `components/chat`, `hooks/chat`, `stores/chat` all map to
 * `chat`), then reports per subsystem:
 *
 * - size (files, lines)
 * - fan-in / fan-out over value imports (type-only imports are counted apart)
 * - layer violations (lib -> hooks/components, lib -> foreign stores)
 * - touchpoints in the central registries (schema tables, settings nav,
 *   initializers, headless runtimes, build-options, search providers, slash
 *   commands, plugin API, app routes)
 * - fix-commit churn over the last 60 days
 * - membership in the largest import cycle (Tarjan SCC)
 *
 * Usage: node scripts/gates/convergence/subsystem-deps.mjs [--json out.json] [--md out.md]
 */

import { execFileSync } from "node:child_process"
import { readFileSync, writeFileSync } from "node:fs"
import { dirname, join, normalize, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import ts from "typescript"

import { createSubsystemClassifier } from "../lib/subsystems.mjs"

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..")
const args = process.argv.slice(2)
const argValue = (flag) => {
  const i = args.indexOf(flag)
  return i >= 0 ? args[i + 1] : undefined
}

const SOURCE_ROOTS = [
  "app",
  "components",
  "hooks",
  "lib",
  "stores",
  "types",
  "packages",
  "plugins",
  "cli/src",
]
const TEST_RE = /(\.test\.|\.spec\.|\.stories\.|__mocks__\/|\/fixtures\/|\.d\.ts$)/
// Shared plumbing: high fan-in by design, never a feature.
const FOUNDATION = new Set([
  "ui",
  "utils",
  "db",
  "i18n",
  "logger",
  "tauri",
  "types",
  "hooks-root",
  "lib-root",
  "components-root",
  "stores-root",
  "types-root",
  "app-root",
])

function listFiles() {
  const out = execFileSync("git", ["ls-files", "--", ...SOURCE_ROOTS], {
    cwd: ROOT,
    maxBuffer: 1 << 28,
  })
    .toString()
    .split("\n")
  return out.filter((f) => /\.(ts|tsx|mts|mjs)$/.test(f) && !TEST_RE.test(f))
}

const PACKAGE_DIRS = new Map()
function resolveSpecifier(spec, fromFile) {
  if (spec.startsWith("@/")) return spec.slice(2)
  if (spec.startsWith("@cognia/")) {
    const name = spec.slice("@cognia/".length).split("/")[0]
    return PACKAGE_DIRS.get(name) ?? `packages/${name}/src`
  }
  if (spec.startsWith(".")) return normalize(join(dirname(fromFile), spec))
  return null
}

function parseImports(file, text) {
  const out = []
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false)
  for (const st of sf.statements) {
    if (ts.isImportDeclaration(st) && ts.isStringLiteral(st.moduleSpecifier)) {
      const clause = st.importClause
      let typeOnly = Boolean(clause?.isTypeOnly)
      if (
        !typeOnly &&
        clause &&
        !clause.name &&
        clause.namedBindings &&
        ts.isNamedImports(clause.namedBindings)
      ) {
        const els = clause.namedBindings.elements
        typeOnly = els.length > 0 && els.every((e) => e.isTypeOnly)
      }
      out.push({ spec: st.moduleSpecifier.text, typeOnly })
    } else if (
      ts.isExportDeclaration(st) &&
      st.moduleSpecifier &&
      ts.isStringLiteral(st.moduleSpecifier)
    ) {
      out.push({ spec: st.moduleSpecifier.text, typeOnly: st.isTypeOnly })
    }
  }
  // Dynamic `import("x")` and `require("x")` calls are value imports; a
  // type-position `import("x").T` is an ImportTypeNode and is skipped.
  const visit = (node) => {
    if (
      ts.isCallExpression(node) &&
      node.arguments.length > 0 &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      const callee = node.expression
      if (
        callee.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(callee) && callee.text === "require")
      ) {
        out.push({ spec: node.arguments[0].text, typeOnly: false, dynamic: true })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return out
}

function countLines(text) {
  let n = 0
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++
  return n + 1
}

// ---------------------------------------------------------------- collect

const files = listFiles()
const { classify } = createSubsystemClassifier(files)
for (const f of execFileSync("git", ["ls-files", "--", "packages/*/package.json"], { cwd: ROOT })
  .toString()
  .split("\n")) {
  if (!f) continue
  try {
    const pkg = JSON.parse(readFileSync(join(ROOT, f), "utf8"))
    const dir = dirname(f)
    if (pkg.name?.startsWith("@cognia/")) PACKAGE_DIRS.set(pkg.name.slice(8), `${dir}/src`)
  } catch {}
}

const subs = new Map()
const sub = (key) => {
  let s = subs.get(key)
  if (!s) {
    s = {
      key,
      layers: {},
      files: 0,
      lines: 0,
      out: new Map(), // key -> {value, type, files:Set}
      inFiles: new Map(), // importer key -> count of value import statements
      violations: { libToUi: 0, libToForeignStore: 0, kernelToFeature: 0 },
      foreignStoreImports: new Map(),
      fixCommits: 0,
      tables: new Set(),
    }
    subs.set(key, s)
  }
  return s
}

const fileInfo = new Map()
const texts = new Map()
for (const f of files) {
  const c = classify(f)
  if (!c) continue
  let text
  try {
    text = readFileSync(join(ROOT, f), "utf8")
  } catch {
    continue
  }
  texts.set(f, text)
  fileInfo.set(f, c)
  const s = sub(c.key)
  s.files++
  s.lines += countLines(text)
  s.layers[c.layer] = (s.layers[c.layer] ?? 0) + 1
}

// File-level edges, for hub-file detection and registry touchpoints.
const fileTargets = new Map()
const libEdges = new Map() // lib-layer value edges between subsystems
for (const [f, c] of fileInfo) {
  const s = sub(c.key)
  const targets = new Map()
  for (const imp of parseImports(f, texts.get(f))) {
    const target = resolveSpecifier(imp.spec, f)
    if (!target) continue
    const tc = classify(target)
    if (!tc) continue
    const prev = targets.get(tc.key)
    if (!prev || (prev.typeOnly && !imp.typeOnly))
      targets.set(tc.key, { ...tc, typeOnly: imp.typeOnly, target })
    if (tc.key === c.key) continue
    let e = s.out.get(tc.key)
    if (!e) s.out.set(tc.key, (e = { value: 0, type: 0, files: new Set() }))
    if (imp.typeOnly) e.type++
    else {
      e.value++
      e.files.add(f)
    }
    if (!imp.typeOnly && c.layer === "lib" && tc.layer === "lib") {
      let set = libEdges.get(c.key)
      if (!set) libEdges.set(c.key, (set = new Map()))
      if (!set.has(tc.key)) set.set(tc.key, new Set())
      set.get(tc.key).add(f)
    }
    if (!imp.typeOnly) {
      if (c.layer === "lib" && (tc.layer === "hooks" || tc.layer === "components"))
        s.violations.libToUi++
      if (c.layer === "lib" && tc.layer === "stores") {
        s.violations.libToForeignStore++
        s.foreignStoreImports.set(tc.key, (s.foreignStoreImports.get(tc.key) ?? 0) + 1)
      }
    }
  }
  fileTargets.set(f, targets)
}
for (const s of subs.values()) {
  for (const [k, e] of s.out) {
    if (e.value > 0) sub(k).inFiles.set(s.key, e.files.size)
  }
}

// ---------------------------------------------------------- registries

const CORE_TABLES = (() => {
  const src = readFileSync(join(ROOT, "lib/data-governance/table-catalog.ts"), "utf8")
  const m = src.match(/CORE_TABLE_NAMES = \[([\s\S]*?)\]/)
  return new Set([...(m?.[1] ?? "").matchAll(/"([A-Za-z0-9_]+)"/g)].map((x) => x[1]))
})()
const tableUsers = new Map()
for (const [f, c] of fileInfo) {
  if (c.key === "db" || c.key === "data-governance") continue
  const text = texts.get(f)
  for (const m of text.matchAll(/\bdb\.([A-Za-z0-9_]+)\b|\.table\(\s*["']([A-Za-z0-9_]+)["']/g)) {
    const t = m[1] ?? m[2]
    if (!CORE_TABLES.has(t)) continue
    sub(c.key).tables.add(t)
    let u = tableUsers.get(t)
    if (!u) tableUsers.set(t, (u = new Set()))
    u.add(c.key)
  }
}
// lib/db/<x>.ts data modules: who imports each one.
const dbModuleUsers = new Map()
for (const [f, targets] of fileTargets) {
  const c = fileInfo.get(f)
  for (const t of targets.values()) {
    if (t.key !== "db" || c.key === "db") continue
    const mod = t.target.split("/")[2]?.replace(/\.(ts|tsx)$/, "")
    if (!mod) continue
    let u = dbModuleUsers.get(mod)
    if (!u) dbModuleUsers.set(mod, (u = new Map()))
    u.set(c.key, (u.get(c.key) ?? 0) + 1)
  }
}

const REGISTRIES = [
  {
    id: "initializers",
    label: "React initializers",
    match: (f) => f.startsWith("components/providers/initializers/"),
  },
  {
    id: "app-runtime",
    label: "app-runtime.tsx",
    match: (f) => f === "components/runtime/app-runtime.tsx",
  },
  { id: "headless", label: "headless runtimes", match: (f) => f.startsWith("lib/headless/") },
  {
    id: "build-options",
    label: "build-options.ts",
    match: (f) => f === "lib/claude/build-options.ts",
  },
  {
    id: "settings-nav",
    label: "settings nav + sections",
    match: (f) =>
      /^components\/settings\/(settings-nav-config|sections\/|settings-shell|settings-page)/.test(
        f
      ),
  },
  {
    id: "global-search",
    label: "global-search providers",
    match: (f) => f.startsWith("lib/global-search/providers/"),
  },
  { id: "slash", label: "slash commands", match: (f) => f.startsWith("lib/slash-commands/") },
  {
    id: "plugin-api",
    label: "plugin host API",
    match: (f) => f.startsWith("lib/plugin/api/") || f.startsWith("lib/plugin/bridge/"),
  },
  {
    id: "sidebar",
    label: "app shell/sidebar",
    match: (f) => /^components\/(sidebar|layout|shell|app-shell)\//.test(f),
  },
]
const registryTouch = new Map() // subsystem -> Map(registryId -> files)
const registrySizes = {}
for (const r of REGISTRIES) registrySizes[r.id] = { files: 0, subsystems: new Set() }
for (const [f, targets] of fileTargets) {
  const own = fileInfo.get(f).key
  for (const r of REGISTRIES) {
    if (!r.match(f)) continue
    registrySizes[r.id].files++
    for (const t of targets.values()) {
      if (t.typeOnly || t.key === own || FOUNDATION.has(t.key)) continue
      registrySizes[r.id].subsystems.add(t.key)
      let m = registryTouch.get(t.key)
      if (!m) registryTouch.set(t.key, (m = new Map()))
      m.set(r.id, (m.get(r.id) ?? 0) + 1)
    }
  }
}
const routes = new Map()
for (const f of fileInfo.keys()) {
  if (f.startsWith("app/") && /\/page\.tsx$/.test(f)) {
    const k = fileInfo.get(f).key
    routes.set(k, (routes.get(k) ?? 0) + 1)
  }
}

// Hub files: import the most distinct non-foundation subsystems.
const hubs = []
for (const [f, targets] of fileTargets) {
  const own = fileInfo.get(f).key
  const distinct = [...targets.values()].filter(
    (t) => !t.typeOnly && t.key !== own && !FOUNDATION.has(t.key) && !t.key.startsWith("pkg:")
  )
  if (distinct.length >= 12)
    hubs.push({ file: f, subsystems: distinct.length, lines: countLines(texts.get(f)) })
}
hubs.sort((a, b) => b.subsystems - a.subsystems)

// ------------------------------------------------------------- churn

try {
  const log = execFileSync(
    "git",
    ["log", "--since=60.days", "--no-merges", "--name-only", "--format=@@%s"],
    {
      cwd: ROOT,
      maxBuffer: 1 << 28,
    }
  ).toString()
  for (const block of log.split("@@").slice(1)) {
    const [subject, ...names] = block.split("\n")
    if (!/^fix[(:!]/.test(subject)) continue
    const hit = new Set()
    for (const n of names) {
      if (!n || TEST_RE.test(n)) continue
      const c = classify(n.startsWith("cli/") ? "cli/src/x" : n)
      if (c) hit.add(c.key)
    }
    for (const k of hit) if (subs.has(k)) subs.get(k).fixCommits++
  }
} catch {}

// --------------------------------------------------------------- SCC

function tarjan(nodes, edges) {
  let index = 0
  const idx = new Map(),
    low = new Map(),
    on = new Set(),
    stack = [],
    comps = []
  const strong = (v) => {
    idx.set(v, index)
    low.set(v, index++)
    stack.push(v)
    on.add(v)
    for (const w of edges(v)) {
      if (!idx.has(w)) {
        strong(w)
        low.set(v, Math.min(low.get(v), low.get(w)))
      } else if (on.has(w)) low.set(v, Math.min(low.get(v), idx.get(w)))
    }
    if (low.get(v) === idx.get(v)) {
      const comp = []
      let w
      do {
        w = stack.pop()
        on.delete(w)
        comp.push(w)
      } while (w !== v)
      comps.push(comp)
    }
  }
  for (const v of nodes) if (!idx.has(v)) strong(v)
  return comps
}
const featureKeys = [...subs.keys()].filter((k) => !FOUNDATION.has(k))
const valueEdges = (k) =>
  [...subs.get(k).out]
    .filter(([t, e]) => e.value > 0 && subs.has(t) && !FOUNDATION.has(t))
    .map(([t]) => t)
const sccs = tarjan(featureKeys, valueEdges).sort((a, b) => b.length - a.length)
const giant = new Set(sccs[0] ?? [])
// Same question on the runtime layer alone: lib/<a> -> lib/<b> value imports.
const libKeys = [...libEdges.keys()].filter((k) => !FOUNDATION.has(k))
const libSccs = tarjan(libKeys, (k) =>
  [...(libEdges.get(k)?.keys() ?? [])].filter((t) => libEdges.has(t) && !FOUNDATION.has(t))
).sort((a, b) => b.length - a.length)
// And with the UI aggregation hubs removed: what is left is feature-to-feature coupling.
const UI_HUBS = new Set([
  "settings",
  "initializers",
  "me",
  "shell",
  "desktop",
  "mobile",
  "global-search",
  "slash-commands",
  "headless",
  "runtime",
])
const coreSccs = tarjan(
  featureKeys.filter((k) => !UI_HUBS.has(k)),
  (k) => valueEdges(k).filter((t) => !UI_HUBS.has(t))
).sort((a, b) => b.length - a.length)

// ------------------------------------------------------------- report

const rows = []
for (const s of subs.values()) {
  const ca = [...s.inFiles.keys()].filter((k) => k !== s.key)
  const ce = [...s.out].filter(([, e]) => e.value > 0).map(([k]) => k)
  const caFeature = ca.filter((k) => !FOUNDATION.has(k))
  const ceFeature = ce.filter((k) => !FOUNDATION.has(k) && !k.startsWith("pkg:"))
  const touch = registryTouch.get(s.key) ?? new Map()
  rows.push({
    key: s.key,
    foundation: FOUNDATION.has(s.key),
    layers: s.layers,
    files: s.files,
    lines: s.lines,
    fanIn: ca.length,
    fanInFeature: caFeature.length,
    fanInFiles: [...s.inFiles.values()].reduce((a, b) => a + b, 0),
    fanOut: ce.length,
    fanOutFeature: ceFeature.length,
    instability: ca.length + ce.length ? +(ce.length / (ca.length + ce.length)).toFixed(2) : 0,
    typeOnlyOut: [...s.out].filter(([, e]) => e.value === 0 && e.type > 0).length,
    libToUi: s.violations.libToUi,
    libToForeignStore: s.violations.libToForeignStore,
    foreignStores: Object.fromEntries(
      [...s.foreignStoreImports].sort((a, b) => b[1] - a[1]).slice(0, 5)
    ),
    registryTouch: Object.fromEntries(touch),
    registryKinds: touch.size,
    routes: routes.get(s.key) ?? 0,
    tables: s.tables.size,
    sharedTables: [...s.tables].filter((t) => (tableUsers.get(t)?.size ?? 0) > 1).length,
    fixCommits60d: s.fixCommits,
    inGiantCycle: giant.has(s.key),
    outEdges: Object.fromEntries(
      [...s.out].filter(([, e]) => e.value > 0).map(([k, e]) => [k, e.files.size])
    ),
    importers: Object.fromEntries(
      [...s.inFiles].filter(([k]) => k !== s.key).sort((a, b) => b[1] - a[1])
    ),
    topIn: [...s.inFiles]
      .filter(([k]) => k !== s.key)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6),
    topOut: [...s.out]
      .filter(([, e]) => e.value > 0)
      .sort((a, b) => b[1].files.size - a[1].files.size)
      .slice(0, 6)
      .map(([k, e]) => [k, e.files.size]),
  })
}
rows.sort((a, b) => b.lines - a.lines)

const dbModules = [...dbModuleUsers].map(([mod, users]) => ({
  module: mod,
  users: users.size,
  top: [...users].sort((a, b) => b[1] - a[1])[0]?.[0],
}))
const sharedTables = [...tableUsers]
  .map(([t, u]) => ({ table: t, users: u.size }))
  .sort((a, b) => b.users - a.users)

const result = {
  generatedAt: new Date().toISOString(),
  head: execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: ROOT }).toString().trim(),
  totals: {
    files: fileInfo.size,
    subsystems: subs.size,
    featureSubsystems: featureKeys.length,
    giantCycle: giant.size,
    sccCount: sccs.length,
    libSubsystems: libKeys.length,
    libGiantCycle: libSccs[0]?.length ?? 0,
    giantCycleWithoutUiHubs: coreSccs[0]?.length ?? 0,
    coreTables: CORE_TABLES.size,
    tablesUsedByOneSubsystem: sharedTables.filter((t) => t.users === 1).length,
    tablesUsedByThreePlus: sharedTables.filter((t) => t.users >= 3).length,
    dbModules: dbModules.length,
    dbModulesSingleUser: dbModules.filter((d) => d.users === 1).length,
  },
  registries: Object.fromEntries(
    Object.entries(registrySizes).map(([k, v]) => [
      k,
      { files: v.files, subsystems: v.subsystems.size },
    ])
  ),
  giantCycle: [...giant].sort(),
  libGiantCycle: [...(libSccs[0] ?? [])].sort(),
  libEdges: Object.fromEntries(
    [...libEdges].map(([k, v]) => [k, Object.fromEntries([...v].map(([t, fs]) => [t, fs.size]))])
  ),
  hubs: hubs.slice(0, 30),
  sharedTables: sharedTables.slice(0, 30),
  dbModules,
  subsystems: rows,
}

const mdOut = argValue("--md")
if (mdOut) {
  const lines = [
    `<!-- generated by scripts/gates/convergence/subsystem-deps.mjs at ${result.head}; do not edit by hand -->`,
    "",
    "| 子系统 | 行数 | 文件 | 入向（功能） | 出向（功能） | 不稳定度 | lib→UI | lib→他人 store | 注册表种类 | 表 | 共享表 | 60 天 fix | 大环 |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | :---: |",
  ]
  for (const r of rows) {
    if (r.foundation || r.key.startsWith("pkg:") || r.key.startsWith("plugin:") || r.lines < 1000)
      continue
    lines.push(
      `| \`${r.key}\` | ${r.lines} | ${r.files} | ${r.fanInFeature} | ${r.fanOutFeature} | ${r.instability} | ${r.libToUi} | ${r.libToForeignStore} | ${r.registryKinds} | ${r.tables} | ${r.sharedTables} | ${r.fixCommits60d} | ${r.inGiantCycle ? "●" : ""} |`
    )
  }
  writeFileSync(mdOut, lines.join("\n") + "\n")
}

const jsonOut = argValue("--json")
if (jsonOut) writeFileSync(jsonOut, JSON.stringify(result, null, 1))
const t = result.totals
console.log(
  `files=${t.files} subsystems=${t.subsystems} feature=${t.featureSubsystems} giantCycle=${t.giantCycle} sccs=${t.sccCount}`
)
console.log(
  `lib subsystems=${t.libSubsystems} libGiantCycle=${t.libGiantCycle} giantWithoutUiHubs=${t.giantCycleWithoutUiHubs}`
)
console.log(
  `tables=${t.coreTables} oneUser=${t.tablesUsedByOneSubsystem} threePlus=${t.tablesUsedByThreePlus} dbModules=${t.dbModules} singleUser=${t.dbModulesSingleUser}`
)
console.log("registries", JSON.stringify(result.registries))

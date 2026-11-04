/**
 * ADR-0250 §11 candidate discovery. Detectors consume a cached source context,
 * never mutate it or the inventories, and nominate candidates, not decisions.
 * TypeScript is parsed syntactically: no program, checker, or tsc subprocess.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import ts from "typescript"
import { createHash } from "node:crypto"
import * as reg from "../check-headless-registry.mjs"
import { SEAM_OWNERS, isRendererSource } from "../check-host-parity.mjs"

const { resolveSpecifier, moduleImports, reachableFrom, BRAIN_ROOTS, INITIALIZER_DIR } = reg

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..")
const DB_ROOTS = ["lib", "packages", "cli", "plugins", "stores", "services"]
const CAP_ROOTS = [
  "lib",
  "packages",
  "cli/src",
  "sidecar/src",
  "plugins",
  "services/workspace-runtime",
  "crates",
  "src-tauri/src",
]
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".cache",
  ".next",
  "target",
  "dist",
  "build",
  "out",
])
const SOURCE_EXT = /\.(?:[cm]?[jt]sx?|rs)$/
const sorted = (values) => [...new Set(values)].sort()
const byKey = (rows) => rows.sort((a, b) => a.key.localeCompare(b.key))
const posix = (s) => s.replaceAll("\\", "/")

export function fingerprint(evidence) {
  return createHash("sha256")
    .update(evidence.replace(/\s+/g, " ").trim())
    .digest("hex")
    .slice(0, 16)
}

// Downstream graph consumers can reuse the same reader rather than inventing
// a static-only approximation of reachableFrom's import policy.
export { moduleImports }

export function isSourceFile(file) {
  return (
    SOURCE_EXT.test(file) &&
    !/\.(?:test|spec|stories)\./.test(file) &&
    !/\.d\.[cm]?ts$/.test(file) &&
    !/(?:^|\/)(?:__tests__|__mocks__|fixtures|test-utils)(?:\/|$)/.test(file) &&
    !(/\.rs$/.test(file) && /(?:^|\/)(?:tests|benches)(?:\/|$)/.test(file))
  )
}

export function walkSources(root, dirs) {
  const files = []
  const walk = (dir) => {
    if (!existsSync(join(root, dir))) return
    for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
      const file = posix(join(dir, entry.name))
      if (entry.isDirectory()) {
        if (
          !SKIP_DIRS.has(entry.name) &&
          !["__tests__", "__mocks__", "fixtures", "test-utils"].includes(entry.name)
        )
          walk(file)
      } else if (entry.isFile() && isSourceFile(file)) files.push(file)
    }
  }
  for (const dir of dirs) walk(dir)
  return sorted(files)
}

export function deriveOwner(file) {
  if (file.startsWith(`${INITIALIZER_DIR}/`)) return file
  if (file.startsWith("src-tauri/")) return "src-tauri"
  const parts = file.split("/")
  if (["cli", "sidecar"].includes(parts[0]) && parts[1] === "src")
    return parts.slice(0, 3).join("/")
  return parts.slice(0, 2).join("/")
}

/** Disk adapter shared by all detectors. The bounded AST cache limits RSS on the full repo. */
export function createContext(root = REPO_ROOT) {
  root = resolve(root)
  const reads = new Map(),
    trees = new Map(),
    walks = new Map()
  const ctx = {
    root,
    exists: (file) => existsSync(join(root, file)),
    read(file) {
      if (!reads.has(file)) reads.set(file, readFileSync(join(root, file), "utf8"))
      return reads.get(file)
    },
    ast(file) {
      if (!trees.has(file)) {
        if (trees.size >= 96) trees.delete(trees.keys().next().value)
        trees.set(file, ts.createSourceFile(file, ctx.read(file), ts.ScriptTarget.Latest, true))
      }
      return trees.get(file)
    },
    files(dirs) {
      const key = dirs.join("|")
      if (!walks.has(key)) walks.set(key, walkSources(root, dirs))
      return walks.get(key)
    },
  }
  return ctx
}

function visit(node, fn) {
  fn(node)
  ts.forEachChild(node, (child) => visit(child, fn))
}
function nameOf(node) {
  return node &&
    (ts.isIdentifier(node) || ts.isStringLiteralLike(node) || ts.isNumericLiteral(node))
    ? node.text
    : null
}
function unwrap(node) {
  while (
    node &&
    (ts.isAsExpression(node) ||
      ts.isTypeAssertionExpression(node) ||
      ts.isParenthesizedExpression(node) ||
      ts.isSatisfiesExpression(node) ||
      ts.isNonNullExpression(node) ||
      ts.isAwaitExpression(node))
  )
    node = node.expression
  return node
}

/** Resolve aliases against --root, delegating the in-repo TS graph to the existing gate. */
export function resolveModule(ctx, spec, from) {
  const absoluteFrom = join(ctx.root, from)
  const localSpec =
    spec.startsWith("@/") && ctx.root !== REPO_ROOT
      ? `./${posix(relative(dirname(absoluteFrom), join(ctx.root, spec.slice(2))))}`
      : spec
  const shared = resolveSpecifier(localSpec, absoluteFrom)
  if (shared && shared.startsWith(`${ctx.root}/`)) return posix(relative(ctx.root, shared))
  let base
  if (spec.startsWith("@/")) base = spec.slice(2)
  else if (spec.startsWith("."))
    base = posix(relative(ctx.root, resolve(dirname(absoluteFrom), spec)))
  else if (spec.startsWith("@cognia/")) {
    if (!ctx.packages) {
      ctx.packages = new Map()
      if (ctx.exists("packages"))
        for (const dir of readdirSync(join(ctx.root, "packages"), { withFileTypes: true })) {
          if (!dir.isDirectory() || !ctx.exists(`packages/${dir.name}/package.json`)) continue
          const pkg = JSON.parse(ctx.read(`packages/${dir.name}/package.json`))
          ctx.packages.set(pkg.name, { path: `packages/${dir.name}`, pkg })
        }
    }
    const [scope, pkgName, ...sub] = spec.split("/")
    const entry = ctx.packages.get(`${scope}/${pkgName}`)
    if (!entry) return null
    const exported = entry.pkg.exports?.[sub.length ? `./${sub.join("/")}` : "."]
    const targets = []
    const collect = (value) => {
      if (typeof value === "string") targets.push(value)
      else if (value && typeof value === "object") Object.values(value).forEach(collect)
    }
    collect(exported)
    for (const target of targets) {
      const candidate = `${entry.path}/${target.replace(/^\.\//, "")}`
      if (!candidate.includes("/dist/") && ctx.exists(candidate) && isSourceFile(candidate))
        return candidate
    }
    base = `${entry.path}/src/${sub.length ? sub.join("/") : "index"}`
  } else return null
  if (base.startsWith("../")) return null
  for (const candidate of [
    base,
    ...[".ts", ".tsx", ".js", ".mjs", "/index.ts", "/index.tsx", "/index.js"].map(
      (ext) => base + ext
    ),
  ]) {
    if (SOURCE_EXT.test(candidate) && ctx.exists(candidate)) return candidate
  }
  return null
}

/** Every import `file` makes, static or dynamic, flagged when type-only. The module gate reuses it. */
export function importsIn(ctx, file) {
  const imports = []
  visit(ctx.ast(file), (node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      const clause = ts.isImportDeclaration(node) ? node.importClause : node
      const bindings = ts.isImportDeclaration(node) ? clause?.namedBindings : node.exportClause
      const elements =
        (bindings && ts.isNamedImports(bindings)) || (bindings && ts.isNamedExports(bindings))
          ? bindings.elements
          : []
      const typeOnly =
        !!clause?.isTypeOnly ||
        (elements.length > 0 && elements.every((e) => e.isTypeOnly) && !clause?.name)
      imports.push({ spec: node.moduleSpecifier.text, kind: "static", typeOnly, node })
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require")) &&
      node.arguments[0] &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      imports.push({ spec: node.arguments[0].text, kind: "dynamic", typeOnly: false, node })
    } else if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteralLike(node.argument.literal)
    ) {
      imports.push({ spec: node.argument.literal.text, kind: "dynamic", typeOnly: true, node })
    }
  })
  return imports
}

function detectLibImports(ctx, targetDirs, imperative) {
  const rows = []
  for (const file of ctx.files(["lib"]).filter((f) => !f.endsWith(".rs"))) {
    const source = ctx.read(file)
    if (imperative && !/\.\s*(?:getState|setState|subscribe)\s*\(/.test(source)) continue
    if (!targetDirs.some((dir) => source.includes(dir))) continue
    const found = importsIn(ctx, file)
      .map((i) => ({ ...i, target: resolveModule(ctx, i.spec, file) }))
      .filter((i) => i.target && targetDirs.some((dir) => i.target.startsWith(`${dir}/`)))
    if (!found.length) continue
    const row = {
      key: file,
      owner: deriveOwner(file),
      note: "",
      imports: ["static", "dynamic"].filter((kind) => found.some((i) => i.kind === kind)),
    }
    if (imperative) row.stores = sorted(found.map((i) => i.target))
    else {
      row.targets = sorted(found.map((i) => i.target))
      row.typeOnly = found.every((i) => i.typeOnly)
    }
    rows.push(row)
  }
  return byKey(rows)
}

export function detectLibStoreImperative(ctx) {
  return detectLibImports(ctx, ["stores"], true)
}
export function detectLibUiImports(ctx) {
  return detectLibImports(ctx, ["hooks", "components"], false)
}

/** Same source domain and seam owners as host-parity class A. Its tracked-file
 * walker is private; walk disk here (including newly added source files).
 * Unlike the other inventories, retain class A's fixtures/d.ts source policy. */
export function detectTauriDynamicImports(ctx) {
  const owners = new Set(SEAM_OWNERS),
    rows = []
  const walk = (dir) => {
    if (!ctx.exists(dir)) return
    for (const entry of readdirSync(join(ctx.root, dir), { withFileTypes: true })) {
      const file = posix(join(dir, entry.name))
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(file)
      } else if (entry.isFile() && isRendererSource(file) && !owners.has(file)) {
        const imports = importsIn(ctx, file).filter(
          (imp) => /^@tauri-apps\/api\/(?:core|event)$/.test(imp.spec) && !imp.typeOnly
        )
        if (imports.some((imp) => imp.kind === "dynamic"))
          rows.push({
            key: file,
            file,
            owner: deriveOwner(file),
            note: "",
            staticAlsoInClassA: imports.some((imp) => imp.kind === "static"),
          })
      }
    }
  }
  for (const dir of ["lib", "components", "hooks", "stores", "app", "packages", "plugins"])
    walk(dir)
  return byKey(rows)
}

/** Normalize both B6 ledger versions. The override never rewrites B6's files. */
export function readExclusions(ctx = createContext()) {
  if (ctx.headlessExclusions) return ctx.headlessExclusions
  const override = process.env.CONVERGENCE_HEADLESS_EXCLUSIONS
  const file = "scripts/gates/headless-registry-exclusions.json"
  const raw = override
    ? JSON.parse(readFileSync(resolve(ctx.root, override), "utf8"))
    : ctx.root === REPO_ROOT
      ? reg.readExclusions()
      : ctx.exists(file)
        ? JSON.parse(ctx.read(file))
        : {}
  const version = raw.version ?? 1
  if (![1, 2].includes(version))
    throw new Error(`unsupported headless exclusions version: ${version}`)
  const entries = (rows) =>
    new Map(
      Object.entries(rows ?? {}).map(([key, row]) => [
        key,
        {
          ...row,
          symbols: Array.isArray(row.symbols) ? new Set(row.symbols) : "*",
        },
      ])
    )
  ctx.headlessExclusions = {
    version,
    excluded: entries(raw.initializers),
    uiOnly: entries(raw.uiOnly),
    pending: entries(raw.pending),
    pendingCeiling: raw.pendingCeiling,
  }
  return ctx.headlessExclusions
}

const hasSymbol = (entry, symbol) => entry?.symbols === "*" || !!entry?.symbols?.has(symbol)

const RUNTIME_ROOTS_FILE = "scripts/gates/convergence/runtime-roots.json"
export function runtimeRootCoverage(ctx) {
  if (ctx.runtimeCoverage) return ctx.runtimeCoverage
  const config = ctx.exists(RUNTIME_ROOTS_FILE)
    ? JSON.parse(ctx.read(RUNTIME_ROOTS_FILE))
    : { roots: [], notRuntime: [] }
  const invalid = [],
    listed = new Set()
  for (const category of ["roots", "notRuntime"]) {
    if (!Array.isArray(config[category])) {
      invalid.push(`${RUNTIME_ROOTS_FILE}: missing ${category} array`)
      continue
    }
    for (const row of config[category]) {
      if (
        typeof row?.file !== "string" ||
        !row.file.startsWith("components/") ||
        row.file.includes("..") ||
        !ctx.exists(row.file)
      )
        invalid.push(`${RUNTIME_ROOTS_FILE}: invalid or vanished file ${row?.file}`)
      if (typeof row?.reason !== "string" || row.reason.trim().length < 20)
        invalid.push(`${row?.file}: runtime root reason must have at least 20 characters`)
      if (listed.has(row?.file)) invalid.push(`${row.file}: duplicate runtime root classification`)
      listed.add(row?.file)
    }
  }
  for (const file of ctx.files(["components"])) {
    if (/^components\/(?:ui|ai-elements|providers)\//.test(file)) continue
    if (/-(?:initializer|provider|host)\.tsx$/.test(file) && !listed.has(file))
      invalid.push(`unlisted runtime root: ${file}`)
  }
  ctx.runtimeCoverage = {
    invalid,
    roots: (config.roots ?? [])
      .map((r) => r.file)
      .filter((f) => typeof f === "string" && ctx.exists(f)),
  }
  return ctx.runtimeCoverage
}
function runtimeRootFiles(ctx) {
  return sorted([
    ...ctx
      .files(["components/providers"])
      .filter(
        (f) =>
          f.endsWith(".tsx") &&
          (f.startsWith(`${INITIALIZER_DIR}/`) || dirname(f) === "components/providers")
      ),
    ...runtimeRootCoverage(ctx).roots,
  ])
}

function effectSources(ctx, root) {
  const files = new Set([root])
  // Explicit roots may own their effects through a custom hook (account sync
  // and the twin worker do). Follow only invoked custom hook imports, keeping
  // their evidence under the mounted root's identity.
  if (!runtimeRootCoverage(ctx).roots.includes(root)) return [...files]
  const stack = [root]
  while (stack.length) {
    const file = stack.pop(),
      called = new Set()
    visit(ctx.ast(file), (node) => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression))
        called.add(node.expression.text)
    })
    for (const imp of importsIn(ctx, file)) {
      if (!ts.isImportDeclaration(imp.node) || imp.typeOnly) continue
      const named = imp.node.importClause?.namedBindings
      if (
        !named ||
        !ts.isNamedImports(named) ||
        !named.elements.some((e) => /^use[A-Z]/.test(e.name.text) && called.has(e.name.text))
      )
        continue
      const dep = resolveModule(ctx, imp.spec, file)
      if (dep && /^(?:hooks|components)\//.test(dep) && !files.has(dep)) {
        files.add(dep)
        stack.push(dep)
      }
    }
  }
  return [...files]
}

function brainCalls(ctx, corpus) {
  const calls = new Set()
  const add = (file, symbol) => {
    calls.add(`${file}#${symbol}`)
    const found = symbolIn(ctx, file, symbol)
    if (found) calls.add(`${found.file}#${found.symbol ?? found.node.name?.text ?? symbol}`)
  }
  for (const absolute of corpus.keys()) {
    const file = posix(relative(ctx.root, absolute)),
      bindings = new Map(),
      namespaces = new Map()
    for (const imp of importsIn(ctx, file)) {
      const dep = resolveModule(ctx, imp.spec, file)
      if (!dep || imp.typeOnly) continue
      if (ts.isImportDeclaration(imp.node)) {
        const named = imp.node.importClause?.namedBindings
        if (named && ts.isNamedImports(named))
          for (const e of named.elements)
            if (!e.isTypeOnly)
              bindings.set(e.name.text, { file: dep, symbol: e.propertyName?.text ?? e.name.text })
        if (named && ts.isNamespaceImport(named)) namespaces.set(named.name.text, dep)
      } else if (ts.isCallExpression(imp.node)) {
        const bind = (pattern) => {
          if (ts.isObjectBindingPattern(pattern))
            for (const e of pattern.elements)
              bindings.set(nameOf(e.name), {
                file: dep,
                symbol: nameOf(e.propertyName) ?? nameOf(e.name),
              })
          else if (ts.isIdentifier(pattern)) namespaces.set(pattern.text, dep)
        }
        let parent = imp.node.parent
        if (ts.isAwaitExpression(parent)) parent = parent.parent
        if (ts.isVariableDeclaration(parent)) bind(parent.name)
        if (ts.isArrayLiteralExpression(parent) && ts.isCallExpression(parent.parent)) {
          const index = parent.elements.indexOf(imp.node)
          let declaration = parent.parent.parent
          if (ts.isAwaitExpression(declaration)) declaration = declaration.parent
          if (ts.isVariableDeclaration(declaration) && ts.isArrayBindingPattern(declaration.name)) {
            const element = declaration.name.elements[index]
            if (element && ts.isBindingElement(element)) bind(element.name)
          }
        }
        if (
          ts.isPropertyAccessExpression(parent) &&
          parent.name.text === "then" &&
          ts.isCallExpression(parent.parent)
        ) {
          const callback = parent.parent.arguments[0]
          if (callback && ts.isFunctionLike(callback) && callback.parameters[0])
            bind(callback.parameters[0].name)
        }
      }
    }
    visit(ctx.ast(file), (node) => {
      if (!ts.isCallExpression(node)) return
      const expr = node.expression
      if (ts.isIdentifier(expr)) {
        const b = bindings.get(expr.text)
        if (b) add(b.file, b.symbol)
        else if (symbolIn(ctx, file, expr.text)) add(file, expr.text)
      } else if (ts.isPropertyAccessExpression(expr)) {
        const receiver = unwrap(expr.expression)
        if (ts.isIdentifier(receiver) && namespaces.has(receiver.text))
          add(namespaces.get(receiver.text), expr.name.text)
        else if (
          ts.isCallExpression(receiver) &&
          receiver.expression.kind === ts.SyntaxKind.ImportKeyword &&
          ts.isStringLiteralLike(receiver.arguments[0]) &&
          !["then", "catch", "finally"].includes(expr.name.text)
        ) {
          const dep = resolveModule(ctx, receiver.arguments[0].text, file)
          if (dep) add(dep, expr.name.text)
        }
      }
    })
  }
  return calls
}

export function detectRuntimeInitializers(ctx) {
  // The shared graph functions have a fixed repository alias root. Only fixture
  // reads rewrite aliases to relative imports, preserving that exact algorithm.
  const readGraph = (absolute) => {
    const file = posix(relative(ctx.root, absolute))
    if (!isSourceFile(file)) return ""
    // The shared graph is text-based; normalize no-substitution templates so
    // its static/dynamic/require edges have the same literal policy as our AST.
    const source = ctx.read(file).replace(/`([^`$]*?)`/g, (_, value) => JSON.stringify(value))
    return ctx.root === REPO_ROOT
      ? source
      : source.replace(
          /(["'])@\/([^"']+)\1/g,
          (_, quote, path) =>
            `${quote}./${posix(relative(dirname(absolute), join(ctx.root, path)))}${quote}`
        )
  }
  const roots = ctx
    .files(BRAIN_ROOTS)
    .filter((f) => !f.endsWith(".rs"))
    .map((f) => join(ctx.root, f))
  // moduleImports and reachableFrom share their resolver; do not build a second
  // production reachability policy here.
  const reachable = reachableFrom(roots, readGraph)
  const corpus = new Map()
  for (const absolute of reachable) {
    const file = posix(relative(ctx.root, absolute))
    if (/^(?:components|hooks|app)\//.test(file) || !isSourceFile(file)) continue
    corpus.set(absolute, readGraph(absolute))
  }
  const brain = brainCalls(ctx, corpus)
  const exclusions = readExclusions(ctx)
  const rows = []
  for (const initializer of runtimeRootFiles(ctx)) {
    for (const file of effectSources(ctx, initializer)) {
      const ast = ctx.ast(file),
        bindings = new Map(),
        namespaces = new Map(),
        locals = new Map(),
        effects = []
      const reactEffects = new Set(["useEffect", "useLayoutEffect"])
      const bind = (pattern, mod) => {
        if (ts.isObjectBindingPattern(pattern))
          for (const e of pattern.elements) {
            const local = nameOf(e.name),
              symbol = nameOf(e.propertyName) ?? local
            if (local && symbol) bindings.set(local, { symbol, module: mod })
          }
        else if (ts.isIdentifier(pattern)) namespaces.set(pattern.text, mod)
      }
      // B6 v2 exports the common binding reader. Feature detection keeps this
      // module loadable beside v1; the AST extends it for templates, aliases,
      // stores/hooks and callbacks (and preserves same-symbol module identity).
      if (typeof reg.libBindings === "function") {
        const shared = reg.libBindings(ctx.read(file))
        for (const [local, { imported: symbol, spec }] of shared.named) {
          const mod = resolveModule(ctx, spec, file)
          if (mod) bindings.set(local, { symbol, module: mod })
        }
        for (const [local, spec] of shared.namespaces) {
          const mod = resolveModule(ctx, spec, file)
          if (mod) namespaces.set(local, mod)
        }
      }
      for (const imp of importsIn(ctx, file)) {
        if (imp.spec === "react" && ts.isImportDeclaration(imp.node)) {
          const named = imp.node.importClause?.namedBindings
          if (named && ts.isNamedImports(named))
            for (const e of named.elements)
              if (["useEffect", "useLayoutEffect"].includes(e.propertyName?.text ?? e.name.text))
                reactEffects.add(e.name.text)
        }
        if (imp.typeOnly) continue
        const mod = resolveModule(ctx, imp.spec, file)
        if (!mod || !/^(?:lib|stores|hooks)\//.test(mod)) continue
        if (ts.isImportDeclaration(imp.node)) {
          const clause = imp.node.importClause
          if (clause?.name)
            bindings.set(clause.name.text, { symbol: clause.name.text, module: mod })
          const named = clause?.namedBindings
          if (named && ts.isNamedImports(named))
            for (const e of named.elements) {
              if (!e.isTypeOnly)
                bindings.set(e.name.text, {
                  symbol: e.propertyName?.text ?? e.name.text,
                  module: mod,
                })
            }
          else if (named && ts.isNamespaceImport(named)) namespaces.set(named.name.text, mod)
        } else if (ts.isCallExpression(imp.node)) {
          let parent = imp.node.parent
          if (ts.isAwaitExpression(parent)) parent = parent.parent
          if (ts.isVariableDeclaration(parent)) bind(parent.name, mod)
          if (
            ts.isArrayLiteralExpression(parent) &&
            ts.isCallExpression(parent.parent) &&
            parent.parent.expression.getText(ast) === "Promise.all"
          ) {
            const index = parent.elements.indexOf(imp.node)
            let declaration = parent.parent.parent
            if (ts.isAwaitExpression(declaration)) declaration = declaration.parent
            if (
              ts.isVariableDeclaration(declaration) &&
              ts.isArrayBindingPattern(declaration.name)
            ) {
              const element = declaration.name.elements[index]
              if (element && ts.isBindingElement(element)) bind(element.name, mod)
            }
          }
          if (
            ts.isPropertyAccessExpression(parent) &&
            parent.name.text === "then" &&
            ts.isCallExpression(parent.parent)
          ) {
            const callback = parent.parent.arguments[0]
            if (
              callback &&
              (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) &&
              callback.parameters[0]
            )
              bind(callback.parameters[0].name, mod)
          }
        }
      }
      visit(ast, (node) => {
        if (ts.isFunctionDeclaration(node) && node.name) locals.set(node.name.text, node)
        if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
          let value = unwrap(node.initializer)
          if (
            ts.isCallExpression(value) &&
            ts.isIdentifier(value.expression) &&
            value.expression.text === "useCallback" &&
            value.arguments[0]
          )
            value = unwrap(value.arguments[0])
          if (ts.isArrowFunction(value) || ts.isFunctionExpression(value))
            locals.set(node.name.text, value)
        }
        if (
          ts.isCallExpression(node) &&
          ((ts.isIdentifier(node.expression) && reactEffects.has(node.expression.text)) ||
            (ts.isPropertyAccessExpression(node.expression) &&
              ["useEffect", "useLayoutEffect"].includes(node.expression.name.text)))
        )
          effects.push(node.arguments[0])
      })
      const importedCallback = (name) => {
        const b = bindings.get(name),
          found = b && symbolIn(ctx, b.module, b.symbol)
        return (
          found &&
          (ts.isFunctionLike(found.node) ||
            ts.isArrowFunction(unwrap(found.node)) ||
            ts.isFunctionExpression(unwrap(found.node)))
        )
      }
      const found = new Map(),
        seen = new Set()
      const callEvidence = new Map()
      const remember = (binding, node) => {
        const key = `${binding.module}#${binding.symbol}`
        found.set(key, binding)
        if (node) {
          while (
            node.parent &&
            node.parent.expression === node &&
            unwrap(node.parent) !== node.parent
          )
            node = node.parent
          if (ts.isCallExpression(node.parent) && node.parent.arguments.includes(node))
            node = node.parent
          const texts = callEvidence.get(key) ?? new Set()
          texts.add(node.getText(ast))
          callEvidence.set(key, texts)
        }
      }
      const follow = (node) => {
        node = unwrap(node)
        if (!node || seen.has(node)) return
        if (
          ts.isPropertyAccessExpression(node) &&
          ts.isIdentifier(unwrap(node.expression)) &&
          namespaces.has(unwrap(node.expression).text)
        ) {
          remember(
            { module: namespaces.get(unwrap(node.expression).text), symbol: node.name.text },
            node
          )
          return
        }
        if (ts.isIdentifier(node)) {
          if (bindings.has(node.text)) {
            const b = bindings.get(node.text)
            remember(b, node)
            return
          }
          if (locals.has(node.text)) return follow(locals.get(node.text))
        }
        seen.add(node)
        const scan = (child) => {
          if (ts.isFunctionDeclaration(child)) return
          if (
            ts.isVariableDeclaration(child) &&
            child.initializer &&
            (ts.isArrowFunction(unwrap(child.initializer)) ||
              ts.isFunctionExpression(unwrap(child.initializer)))
          )
            return
          if (ts.isCallExpression(child)) {
            const expr = unwrap(child.expression)
            if (ts.isIdentifier(expr)) {
              if (bindings.has(expr.text)) {
                const b = bindings.get(expr.text)
                remember(b, child)
              }
              if (locals.has(expr.text)) follow(locals.get(expr.text))
            } else if (ts.isPropertyAccessExpression(expr)) {
              const symbol = expr.name.text
              const receiver = unwrap(expr.expression)
              if (ts.isIdentifier(receiver) && namespaces.has(receiver.text)) {
                remember(
                  {
                    symbol,
                    module: namespaces.get(receiver.text),
                  },
                  child
                )
              } else if (
                ts.isCallExpression(receiver) &&
                receiver.expression.kind === ts.SyntaxKind.ImportKeyword &&
                receiver.arguments[0] &&
                ts.isStringLiteralLike(receiver.arguments[0]) &&
                /^@\/(?:lib|stores|hooks)\//.test(receiver.arguments[0].text)
              ) {
                const mod = resolveModule(ctx, receiver.arguments[0].text, file)
                if (mod && !["then", "catch", "finally"].includes(symbol))
                  remember({ symbol, module: mod }, child)
              }
            }
            // A local callback passed to a scheduler is reachable too.
            for (const rawArg of child.arguments) {
              const arg = unwrap(rawArg)
              if (
                (ts.isIdentifier(arg) && (locals.has(arg.text) || importedCallback(arg.text))) ||
                (ts.isPropertyAccessExpression(arg) &&
                  ts.isIdentifier(unwrap(arg.expression)) &&
                  namespaces.has(unwrap(arg.expression).text))
              )
                follow(arg)
            }
          }
          ts.forEachChild(child, scan)
        }
        if (ts.isFunctionLike(node) && node.body) scan(node.body)
        else scan(node)
      }
      effects.forEach(follow)
      if (typeof reg.effectCalls === "function") {
        for (const { symbol, spec } of reg.effectCalls(ctx.read(file))) {
          const mod = resolveModule(ctx, spec, file)
          if (mod && !found.has(`${mod}#${symbol}`)) {
            visit(ast, (node) => {
              if (
                ts.isCallExpression(node) &&
                ((ts.isIdentifier(node.expression) &&
                  bindings.get(node.expression.text)?.symbol === symbol &&
                  bindings.get(node.expression.text)?.module === mod) ||
                  (ts.isPropertyAccessExpression(node.expression) &&
                    ts.isIdentifier(node.expression.expression) &&
                    namespaces.get(node.expression.expression.text) === mod &&
                    node.expression.name.text === symbol))
              )
                remember({ symbol, module: mod }, node)
            })
          }
        }
      } else {
        // v1 has only a name-filtered effectSymbols reader. Preserve B6's
        // effect-shaped calls outside effects without inheriting that filter
        // for ordinary calls *inside* an effect.
        visit(ast, (node) => {
          if (!ts.isCallExpression(node)) return
          const expr = node.expression
          if (ts.isIdentifier(expr)) {
            const binding = bindings.get(expr.text)
            if (binding && reg.EFFECT_PATTERN.test(binding.symbol)) remember(binding, node)
          } else if (ts.isPropertyAccessExpression(expr) && ts.isIdentifier(expr.expression)) {
            const mod = namespaces.get(expr.expression.text),
              symbol = expr.name.text
            if (mod && reg.EFFECT_PATTERN.test(symbol)) remember({ symbol, module: mod }, node)
          }
        })
      }
      for (const { symbol, module: mod } of found.values()) {
        const origin = symbolIn(ctx, mod, symbol)
        const isInitializer = initializer.startsWith(`${INITIALIZER_DIR}/`)
        const pending = isInitializer && hasSymbol(exclusions.pending.get(initializer), symbol)
        const uiOnly =
          isInitializer &&
          [...exclusions.uiOnly].some(
            ([spec, entry]) => hasSymbol(entry, symbol) && resolveModule(ctx, spec, file) === mod
          )
        if (
          (!pending &&
            (brain.has(`${mod}#${symbol}`) ||
              (origin &&
                brain.has(
                  `${origin.file}#${origin.symbol ?? origin.node.name?.text ?? symbol}`
                )))) ||
          (isInitializer && hasSymbol(exclusions.excluded.get(initializer), symbol)) ||
          uiOnly
        )
          continue
        rows.push({
          key: `${initializer}#${symbol}@${mod}`,
          initializer,
          ...(initializer !== file ? { effectFile: file } : {}),
          symbol,
          module: mod,
          evidence: fingerprint(
            `${mod}\n${sorted(callEvidence.get(`${mod}#${symbol}`) ?? []).join("\n")}`
          ),
          ...(pending ? { pendingPhase: exclusions.pending.get(initializer).phase ?? "" } : {}),
          owner: initializer,
          note: "",
        })
      }
    }
  }
  return byKey([...new Map(rows.map((row) => [row.key, row])).values()])
}

function symbolIn(ctx, file, symbol, seen = new Set()) {
  ctx.symbols ??= new Map()
  const cacheKey = `${file}#${symbol}`
  if (ctx.symbols.has(cacheKey)) return ctx.symbols.get(cacheKey)
  const found = resolveSymbol(ctx, file, symbol, seen)
  if (found) ctx.symbols.set(cacheKey, found)
  return found
}
function resolveSymbol(ctx, file, symbol, seen = new Set()) {
  const key = `${file}#${symbol}`
  if (seen.has(key)) return null
  seen.add(key)
  const ast = ctx.ast(file)
  for (const statement of ast.statements) {
    if (symbol === "default") {
      if (ts.isExportAssignment(statement) && !statement.isExportEquals) {
        const value = unwrap(statement.expression)
        return ts.isIdentifier(value)
          ? symbolIn(ctx, file, value.text, seen)
          : { file, node: value, symbol: "default" }
      }
      if (
        ts.isFunctionDeclaration(statement) &&
        statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword)
      )
        return { file, node: statement, symbol: statement.name?.text ?? "default" }
    }
    if (
      (ts.isInterfaceDeclaration(statement) ||
        ts.isTypeAliasDeclaration(statement) ||
        ts.isClassDeclaration(statement) ||
        ts.isFunctionDeclaration(statement)) &&
      statement.name?.text === symbol
    )
      return { file, node: statement, symbol }
    if (ts.isVariableStatement(statement))
      for (const d of statement.declarationList.declarations)
        if (nameOf(d.name) === symbol) return { file, node: d.initializer ?? d, symbol }
    if (ts.isImportDeclaration(statement) && ts.isStringLiteralLike(statement.moduleSpecifier)) {
      const named = statement.importClause?.namedBindings
      const dep = resolveModule(ctx, statement.moduleSpecifier.text, file)
      if (dep && statement.importClause?.name?.text === symbol)
        return symbolIn(ctx, dep, "default", seen)
      if (dep && named && ts.isNamedImports(named))
        for (const e of named.elements)
          if (e.name.text === symbol)
            return symbolIn(ctx, dep, e.propertyName?.text ?? symbol, seen)
    }
  }
  for (const statement of ast.statements) {
    if (
      ts.isExportDeclaration(statement) &&
      !statement.moduleSpecifier &&
      statement.exportClause &&
      ts.isNamedExports(statement.exportClause)
    ) {
      for (const e of statement.exportClause.elements)
        if (e.name.text === symbol && e.propertyName?.text !== symbol)
          return symbolIn(ctx, file, e.propertyName?.text ?? symbol, seen)
    }
  }
  for (const statement of ast.statements)
    if (
      ts.isExportDeclaration(statement) &&
      statement.moduleSpecifier &&
      ts.isStringLiteralLike(statement.moduleSpecifier)
    ) {
      const dep = resolveModule(ctx, statement.moduleSpecifier.text, file)
      if (!dep) continue
      if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
        for (const e of statement.exportClause.elements)
          if (e.name.text === symbol)
            return symbolIn(ctx, dep, e.propertyName?.text ?? symbol, seen)
      } else if (!statement.exportClause) {
        const found = symbolIn(ctx, dep, symbol, seen)
        if (found) return found
      }
    }
  return null
}

function stringUnion(ctx, file, node, seen = new Set()) {
  if (!node) return []
  if (ts.isLiteralTypeNode(node) && ts.isStringLiteralLike(node.literal)) return [node.literal.text]
  if (ts.isUnionTypeNode(node))
    return sorted(node.types.flatMap((n) => stringUnion(ctx, file, n, new Set(seen))))
  if (ts.isTypeReferenceNode(node)) {
    const symbol = node.typeName.getText(),
      key = `${file}#${symbol}`
    if (seen.has(key) || seen.size > 12) return []
    seen.add(key)
    const found = symbolIn(ctx, file, symbol)
    if (found && ts.isTypeAliasDeclaration(found.node))
      return stringUnion(ctx, found.file, found.node.type, seen)
  }
  return []
}

/** Resolve fields, inherited/intersected shapes and status unions without a checker. */
export function resolveRowType(ctx, file, node, depth = 0, seen = new Set()) {
  if (!node || depth > 5) return null
  const result = { fields: new Set(), statuses: [] }
  const merge = (part) => {
    if (!part) return false
    for (const field of part.fields) result.fields.add(field)
    result.statuses.push(...part.statuses)
    return true
  }
  if (ts.isParenthesizedTypeNode(node)) return resolveRowType(ctx, file, node.type, depth, seen)
  if (ts.isInterfaceDeclaration(node) || ts.isTypeLiteralNode(node)) {
    for (const member of node.members) {
      const name = nameOf(member.name)
      if (!name) continue
      result.fields.add(name)
      if (["status", "state"].includes(name))
        result.statuses.push(...stringUnion(ctx, file, member.type))
    }
    for (const clause of node.heritageClauses ?? [])
      for (const parent of clause.types)
        if (!merge(resolveRowType(ctx, file, parent, depth + 1, new Set(seen)))) return null
    return result
  }
  if (ts.isIntersectionTypeNode(node) || ts.isUnionTypeNode(node)) {
    for (const part of node.types)
      if (!merge(resolveRowType(ctx, file, part, depth + 1, new Set(seen)))) return null
    return result
  }
  if (ts.isTypeAliasDeclaration(node)) return resolveRowType(ctx, file, node.type, depth, seen)
  if (
    ts.isImportTypeNode(node) &&
    node.qualifier &&
    ts.isLiteralTypeNode(node.argument) &&
    ts.isStringLiteralLike(node.argument.literal)
  ) {
    const dep = resolveModule(ctx, node.argument.literal.text, file)
    const found = dep && symbolIn(ctx, dep, node.qualifier.getText())
    return found ? resolveRowType(ctx, found.file, found.node, depth, seen) : null
  }
  if (ts.isTypeReferenceNode(node) || ts.isExpressionWithTypeArguments(node)) {
    const symbol = ts.isTypeReferenceNode(node)
      ? node.typeName.getText()
      : node.expression.getText()
    if (
      ["Partial", "Required", "Readonly", "Pick", "Omit"].includes(symbol) &&
      node.typeArguments?.[0]
    ) {
      const part = resolveRowType(ctx, file, node.typeArguments[0], depth, seen)
      if (!part) return null
      if (["Pick", "Omit"].includes(symbol)) {
        const names = stringUnion(ctx, file, node.typeArguments[1])
        part.fields = new Set(
          [...part.fields].filter((f) =>
            symbol === "Pick" ? names.includes(f) : !names.includes(f)
          )
        )
        if (![...part.fields].some((f) => ["state", "status"].includes(f))) part.statuses = []
      }
      return part
    }
    const key = `${file}#${symbol}`
    if (seen.has(key)) return null
    seen.add(key)
    const found = symbolIn(ctx, file, symbol)
    return found ? resolveRowType(ctx, found.file, found.node, depth, seen) : null
  }
  return null
}

function schemaObject(ctx, file, node, seen = new Set()) {
  node = unwrap(node)
  if (!node || seen.size > 15) return {}
  if (ts.isIdentifier(node)) {
    const key = `${file}#${node.text}`
    if (seen.has(key)) return {}
    seen.add(key)
    const found = symbolIn(ctx, file, node.text)
    return found ? schemaObject(ctx, found.file, found.node, seen) : {}
  }
  if (!ts.isObjectLiteralExpression(node)) return {}
  const result = {}
  for (const prop of node.properties) {
    if (ts.isSpreadAssignment(prop))
      Object.assign(result, schemaObject(ctx, file, prop.expression, new Set(seen)))
    else if (ts.isPropertyAssignment(prop) && nameOf(prop.name))
      result[nameOf(prop.name)] =
        unwrap(prop.initializer).kind === ts.SyntaxKind.NullKeyword
          ? null
          : prop.initializer.getText()
  }
  return result
}

function rootReceiver(node) {
  if (ts.isCallExpression(node)) return rootReceiver(node.expression)
  if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node))
    return rootReceiver(node.expression)
  return node.kind === ts.SyntaxKind.ThisKeyword ? "this" : nameOf(node)
}

function dexieBindings(ctx, file) {
  const classes = new Set(),
    namespaces = new Set()
  for (const imp of importsIn(ctx, file)) {
    if (imp.spec !== "dexie" || !ts.isImportDeclaration(imp.node)) continue
    const clause = imp.node.importClause
    if (clause?.name) classes.add(clause.name.text)
    const named = clause?.namedBindings
    if (named && ts.isNamedImports(named))
      for (const e of named.elements)
        if ((e.propertyName?.text ?? e.name.text) === "Dexie") classes.add(e.name.text)
    if (named && ts.isNamespaceImport(named)) namespaces.add(named.name.text)
  }
  return (expr) =>
    classes.has(expr.getText()) ||
    (ts.isPropertyAccessExpression(expr) &&
      namespaces.has(expr.expression.getText()) &&
      ["Dexie", "default"].includes(expr.name.text))
}
function tableRow(ctx, file, node, seen = new Set(), parameters = new Map()) {
  if (!node || seen.has(node)) return null
  seen.add(node)
  if (ts.isParenthesizedTypeNode(node)) return tableRow(ctx, file, node.type, seen, parameters)
  if (ts.isIntersectionTypeNode(node)) {
    for (const part of node.types) {
      const found = tableRow(ctx, file, part, new Set(seen), parameters)
      if (found) return found
    }
  }
  if (ts.isTypeAliasDeclaration(node)) return tableRow(ctx, file, node.type, seen, parameters)
  if (ts.isTypeReferenceNode(node) || ts.isExpressionWithTypeArguments(node)) {
    const name = (node.typeName ?? node.expression).getText()
    const direct = importsIn(ctx, file).some((imp) => {
      if (imp.spec !== "dexie" || !ts.isImportDeclaration(imp.node)) return false
      const defaultName = imp.node.importClause?.name?.text
      if (defaultName && [`${defaultName}.Table`, `${defaultName}.EntityTable`].includes(name))
        return true
      const bindings = imp.node.importClause?.namedBindings
      if (bindings && ts.isNamedImports(bindings))
        return bindings.elements.some(
          (e) =>
            e.name.text === name &&
            ["Table", "EntityTable"].includes(e.propertyName?.text ?? e.name.text)
        )
      return (
        bindings &&
        ts.isNamespaceImport(bindings) &&
        [`${bindings.name.text}.Table`, `${bindings.name.text}.EntityTable`].includes(name)
      )
    })
    if (direct && node.typeArguments?.[0]) {
      const row = node.typeArguments[0]
      return parameters.get(row.getText()) ?? { file, node: row }
    }
    const found = symbolIn(ctx, file, name)
    if (found) {
      const bindings = new Map(parameters)
      for (const [index, p] of (found.node.typeParameters ?? []).entries())
        if (node.typeArguments?.[index])
          bindings.set(
            p.name.text,
            parameters.get(node.typeArguments[index].getText()) ?? {
              file,
              node: node.typeArguments[index],
            }
          )
      return tableRow(ctx, found.file, found.node, seen, bindings)
    }
  }
  if (ts.isInterfaceDeclaration(node))
    for (const clause of node.heritageClauses ?? [])
      for (const type of clause.types) {
        const found = tableRow(ctx, file, type, new Set(seen), parameters)
        if (found) return found
      }
  return null
}
function databaseTableTypes(ctx, file, node, typed, seen = new Set()) {
  if (!node || seen.has(node)) return
  seen.add(node)
  if (
    ts.isAsExpression(node) ||
    ts.isTypeAssertionExpression(node) ||
    ts.isParenthesizedTypeNode(node)
  )
    return databaseTableTypes(ctx, file, node.type, typed, seen)
  if (ts.isIndexedAccessTypeNode(node)) {
    const holder = new Map()
    databaseTableTypes(ctx, file, node.objectType, holder, seen)
    if (ts.isLiteralTypeNode(node.indexType)) return holder.get(nameOf(node.indexType.literal))
    return
  }
  if (ts.isIntersectionTypeNode(node)) {
    for (const part of node.types) databaseTableTypes(ctx, file, part, typed, seen)
  } else if (ts.isTypeAliasDeclaration(node)) databaseTableTypes(ctx, file, node.type, typed, seen)
  else if (
    ts.isClassDeclaration(node) ||
    ts.isInterfaceDeclaration(node) ||
    ts.isTypeLiteralNode(node)
  ) {
    for (const member of node.members) {
      if (!member.type || !nameOf(member.name)) continue
      const resolved = tableRow(ctx, file, member.type)
      if (resolved) typed.set(nameOf(member.name), resolved)
      else if (ts.isIndexedAccessTypeNode(member.type)) {
        const row = databaseTableTypes(ctx, file, member.type, new Map(), new Set(seen))
        if (row) typed.set(nameOf(member.name), row)
      }
    }
    for (const c of node.heritageClauses ?? [])
      for (const t of c.types) databaseTableTypes(ctx, file, t, typed, seen)
  } else if (ts.isTypeReferenceNode(node) || ts.isExpressionWithTypeArguments(node)) {
    const found = symbolIn(
      ctx,
      file,
      (ts.isTypeReferenceNode(node) ? node.typeName : node.expression).getText()
    )
    if (found) databaseTableTypes(ctx, found.file, found.node, typed, seen)
  }
}

/** All Dexie databases, including constructor sites and schemas outside CogniaDB. */
export function discoverDexieTables(ctx) {
  if (ctx.dexieTables) return ctx.dexieTables
  const tables = []
  for (const file of ctx.files(DB_ROOTS).filter((f) => !f.endsWith(".rs"))) {
    if (!ctx.read(file).includes("dexie")) continue
    const isDexie = dexieBindings(ctx, file)
    const ast = ctx.ast(file),
      databases = []
    visit(ast, (node) => {
      if (
        ts.isClassDeclaration(node) &&
        node.heritageClauses?.some((c) => c.types.some((t) => isDexie(t.expression)))
      ) {
        databases.push({ name: node.name?.text ?? "anonymousDexie", node, handle: "this" })
      }
      if (ts.isNewExpression(node) && isDexie(node.expression)) {
        let enclosing = node.parent
        while (
          enclosing &&
          !ts.isVariableDeclaration(enclosing) &&
          !ts.isFunctionLike(enclosing) &&
          !ts.isPropertyAssignment(enclosing)
        )
          enclosing = enclosing.parent
        const handle =
          enclosing && ts.isVariableDeclaration(enclosing) ? nameOf(enclosing.name) : null
        databases.push({
          name:
            handle ?? nameOf(node.arguments?.[0]) ?? enclosing?.name?.getText() ?? "anonymousDexie",
          node: ast,
          handle,
          site: node,
          declaration: enclosing,
        })
      }
    })
    for (const db of databases) {
      const schema = {},
        typed = new Map()
      if (ts.isClassDeclaration(db.node)) databaseTableTypes(ctx, file, db.node, typed)
      if (db.declaration)
        visit(db.declaration, (node) => {
          if (
            ts.isAsExpression(node) ||
            ts.isTypeAssertionExpression(node) ||
            ts.isVariableDeclaration(node)
          )
            databaseTableTypes(ctx, file, node.type, typed)
        })
      visit(db.node, (node) => {
        if (
          !ts.isCallExpression(node) ||
          !ts.isPropertyAccessExpression(node.expression) ||
          node.expression.name.text !== "stores" ||
          !node.arguments[0]
        )
          return
        const receiver = rootReceiver(node.expression.expression)
        if (receiver !== db.handle) return
        if (db.site && node.getStart() < db.site.getStart()) return
        Object.assign(schema, schemaObject(ctx, file, node.arguments[0]))
      })
      for (const table of sorted([...Object.keys(schema), ...typed.keys()])) {
        if (schema[table] === null) continue
        const type = typed.get(table),
          typeNode = type?.node,
          row = resolveRowType(ctx, type?.file ?? file, typeNode)
        const database = `${db.name}@${file}`
        tables.push({
          key: `dexie:${database}/${table}`,
          owner: deriveOwner(file),
          note: "",
          database,
          file,
          table,
          rowType: typeNode?.getText() ?? null,
          rowFields: row ? sorted(row.fields) : null,
          rowStatuses: row ? sorted(row.statuses) : [],
        })
      }
    }
  }
  ctx.dexieTables = byKey(tables)
  return ctx.dexieTables
}

function words(name) {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z])([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
}
const QUEUE_WORDS = new Set([
  "outbox",
  "queue",
  "inbox",
  "job",
  "jobs",
  "delivery",
  "deliveries",
  "intent",
  "intents",
  "dispatch",
  "pending",
  "retry",
  "work",
])
const RETRY_FIELDS = new Set([
  "attempts",
  "attempt",
  "attemptcount",
  "retrycount",
  "retries",
  "failurecount",
])
const DUE_FIELDS = new Set([
  "nextattemptat",
  "nextretryat",
  "retryat",
  "dueat",
  "runat",
  "notbefore",
  "availableat",
  "scheduledfor",
  "visibleat",
])
const PENDING_STATES = new Set(["pending", "queued", "retry", "retrying", "deadletter"])

export function queueSignals(table, fields = [], statuses = []) {
  const compact = (field) => field.replaceAll("_", "").toLowerCase()
  const signals = []
  if (words(table).some((word) => QUEUE_WORDS.has(word))) signals.push("name")
  if (fields.some((f) => RETRY_FIELDS.has(compact(f)))) signals.push("retry-count")
  if (fields.some((f) => DUE_FIELDS.has(compact(f)))) signals.push("due-time")
  if (fields.some((f) => /lease|claimed|lockeduntil|lockowner/.test(compact(f))))
    signals.push("lease")
  if (statuses.some((s) => PENDING_STATES.has(s.toLowerCase()))) signals.push("status")
  return signals
}

/** Mask Rust comments/strings while retaining offsets, braces and code. */
function maskRust(source, keepStrings = false) {
  const chunks = []
  let cursor = 0,
    plain = 0
  while (cursor < source.length) {
    const start = cursor
    let end = cursor,
      comment = false
    if (source.startsWith("//", cursor)) {
      end = source.indexOf("\n", cursor)
      if (end < 0) end = source.length
      comment = true
    } else if (source.startsWith("/*", cursor)) {
      end = cursor + 2
      let depth = 1
      while (end < source.length && depth) {
        if (source.startsWith("/*", end)) {
          depth++
          end += 2
        } else if (source.startsWith("*/", end)) {
          depth--
          end += 2
        } else end++
      }
      comment = true
    } else {
      const raw =
        source[cursor] === "r" || source[cursor] === "b"
          ? source.slice(cursor).match(/^(?:br|r)(#*)"/)
          : null
      if (raw && (cursor === 0 || !/\w/.test(source[cursor - 1]))) {
        const delimiter = `"${raw[1]}`
        const close = source.indexOf(delimiter, cursor + raw[0].length)
        end = close < 0 ? source.length : close + delimiter.length
      } else if (source[cursor] === '"') {
        end = cursor + 1
        while (end < source.length) {
          if (source[end] === "\\") end += 2
          else if (source[end++] === '"') break
        }
      } else if (source[cursor] === "'") {
        const char = source.slice(cursor).match(/^'(?:\\(?:u\{[^}]+\}|x[\da-fA-F]{2}|.)|[^'\\\n])'/)
        if (char) end = cursor + char[0].length
      }
    }
    if (end > start) {
      chunks.push(
        source.slice(plain, start),
        keepStrings && !comment
          ? source.slice(start, end)
          : source.slice(start, end).replace(/[^\n]/g, " ")
      )
      cursor = end
      plain = end
    } else cursor++
  }
  chunks.push(source.slice(plain))
  return chunks.join("")
}
function closingBrace(source, open) {
  let depth = 1
  for (let i = open + 1; i < source.length; i++) {
    if (source[i] === "{") depth++
    if (source[i] === "}" && --depth === 0) return i
  }
  return source.length - 1
}

export function stripRustTests(source) {
  const masked = maskRust(source),
    ranges = []
  const pattern =
    /#\s*\[\s*cfg\s*\(\s*test\s*\)\s*\]\s*(?:#\[[^\]]*\]\s*)*(?:pub(?:\([^)]*\))?\s+)?mod\s+\w+\s*\{/g
  for (const match of masked.matchAll(pattern))
    ranges.push([match.index, closingBrace(masked, match.index + match[0].lastIndexOf("{")) + 1])
  let result = source
  for (const [start, end] of ranges.reverse())
    result =
      result.slice(0, start) + result.slice(start, end).replace(/[^\n]/g, " ") + result.slice(end)
  return result
}

function sqliteTables(ctx, includeAll = false) {
  const rows = new Map()
  for (const file of ctx.files(["crates", "src-tauri/src"]).filter((f) => f.endsWith(".rs"))) {
    const source = maskRust(stripRustTests(ctx.read(file)), true)
    const pattern =
      /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["`\[]?(\w+)["`\]]?\s*\(([\s\S]*?)\)\s*(?:;|["#])/gi
    for (const m of source.matchAll(pattern)) {
      const columns = [
        ...m[2].matchAll(
          /(?:^|,)\s*["`\[]?(\w+)["`\]]?\s+(?:TEXT|INTEGER|INT|BIGINT|REAL|BLOB|NUMERIC|VARCHAR|BOOLEAN)\b/gi
        ),
      ].map((x) => x[1])
      const statuses = [...m[2].matchAll(/\b(?:status|state)\b[^,]*?DEFAULT\s+'([^']+)'/gi)].map(
        (x) => x[1]
      )
      const signals = queueSignals(m[1], columns, statuses)
      if (!signals.length && !includeAll) continue
      const crate = file.startsWith("crates/") ? file.split("/")[1] : "src-tauri"
      const key = `sqlite:${crate}/${m[1]}`
      const prior = rows.get(key)
      rows.set(key, {
        key,
        owner: deriveOwner(file),
        note: "",
        database: `${crate}@${file}`,
        file,
        table: m[1],
        rowType: null,
        rowFields: sorted([...(prior?.rowFields ?? []), ...columns]),
        signals: ["name", "retry-count", "due-time", "lease", "status"].filter(
          (s) => signals.includes(s) || prior?.signals.includes(s)
        ),
      })
    }
  }
  return byKey([...rows.values()])
}

export function detectDurableQueues(ctx) {
  const rows = discoverDexieTables(ctx).flatMap((table) => {
    const signals = queueSignals(table.table, table.rowFields ?? [], table.rowStatuses)
    if (table.rowFields === null && !signals.length) signals.push("unresolved-row-type")
    return signals.length ? [withTableEvidence(ctx, { ...table, signals })] : []
  })
  return byKey([...rows, ...sqliteTables(ctx).map((table) => withTableEvidence(ctx, table))])
}

// Grepped production factories: MCP Semaphore, connector StartSemaphore and
// PlatformSendSemaphore, workflow ConcurrencyGate, council/ensemble mapLimited,
// deep-research mapLimit, PluginRateLimiter and pet createSpeakLimiter.
export const LIMITER_FACTORIES = [
  "Semaphore",
  "createSemaphore",
  "pLimit",
  "PQueue",
  "createLimiter",
  "StartSemaphore",
  "PlatformSendSemaphore",
  "ConcurrencyGate",
  "mapLimit",
  "mapLimited",
  "PluginRateLimiter",
  "createSpeakLimiter",
  "createTokenBucket",
]
function capName(name) {
  const list = words(name),
    joined = list.join(" ")
  return (
    list.some((w) =>
      /^(?:concurren\w*|parallel\w*|inflight|slots?|permits?|semaphore|workers?)$/.test(w)
    ) || /\b(?:in flight|turn limit|max active|max running)\b/.test(joined)
  )
}
function capProperty(name) {
  return /^(?:concurrency|globalConcurrency|maxConcurrency|maxConcurrent\w*|maxParallel\w*)$/i.test(
    name
  )
}
function numeric(node) {
  node = unwrap(node)
  if (!node) return null
  if (ts.isNumericLiteral(node)) return Number(node.text)
  if (
    ts.isPrefixUnaryExpression(node) &&
    node.operator === ts.SyntaxKind.MinusToken &&
    ts.isNumericLiteral(node.operand)
  )
    return -Number(node.operand.text)
  if (
    ts.isBinaryExpression(node) &&
    [ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken].includes(
      node.operatorToken.kind
    )
  )
    return numeric(node.right)
  return null
}
function capInitializer(node, name = "") {
  node = unwrap(node)
  if (!node) return false
  if (ts.isIdentifier(node) && node.text === "undefined") return false
  if (numeric(node) !== null) return true
  const admissionName =
    capProperty(name) ||
    (/max|concurren|parallel|(?:cap|limit|capacity|slots?)$/i.test(name) &&
      !/^(?:slots?|workers?)$/i.test(name))
  // A worker object, credential slot or in-flight row index is not an integer
  // bound. Keep unknown configured bounds, without promoting object lookups
  // merely because their variable name contains a broad vocabulary word.
  if (!admissionName && !(/(?:Count|Limit|Capacity)$/.test(name) && ts.isBinaryExpression(node)))
    return false
  return (
    !!node &&
    (ts.isNumericLiteral(node) ||
      ts.isPrefixUnaryExpression(node) ||
      ts.isBinaryExpression(node) ||
      ts.isIdentifier(node) ||
      ts.isCallExpression(node) ||
      ts.isPropertyAccessExpression(node) ||
      ts.isElementAccessExpression(node) ||
      ts.isConditionalExpression(node))
  )
}
// A cap decision follows its own value and the calls consuming its binding,
// not neighboring configuration fields in the same statement.
function capCallConsumers(node, into) {
  for (let p = node.parent; p && !ts.isFunctionLike(p); p = p.parent)
    if (ts.isCallExpression(p) || ts.isNewExpression(p)) into.add(unwrap(p.expression).getText())
}
function tsCapEvidence(ast, node) {
  const consumers = new Set()
  const initializer = unwrap(
    node.initializer ??
      (ts.isCallExpression(node) || ts.isNewExpression(node) ? node.arguments?.[0] : node)
  )
  capCallConsumers(initializer ?? node, consumers)
  let binding = node
  while (
    binding &&
    !ts.isVariableDeclaration(binding) &&
    !ts.isParameter(binding) &&
    !ts.isPropertyDeclaration(binding)
  ) {
    if (ts.isFunctionLike(binding)) {
      binding = null
      break
    }
    binding = binding.parent
  }
  if (binding && ts.isIdentifier(binding.name)) {
    const name = binding.name.text
    visit(ast, (ref) => {
      if (
        ts.isIdentifier(ref) &&
        ref !== binding.name &&
        ref.text === name &&
        valueDeclaration(ref, name) === binding
      )
        capCallConsumers(ref, consumers)
      if (
        ts.isPropertyDeclaration(binding) &&
        ts.isPropertyAccessExpression(ref) &&
        ref.name.text === name &&
        unwrap(ref.expression).kind === ts.SyntaxKind.ThisKeyword
      ) {
        const cls = (n) => {
          for (let p = n.parent; p; p = p.parent) if (ts.isClassLike(p)) return p
        }
        if (cls(ref) === cls(binding)) capCallConsumers(ref, consumers)
      }
    })
  }
  return fingerprint(
    JSON.stringify({ initializer: initializer?.getText() ?? "", consumers: sorted(consumers) })
  )
}
function rustInitializer(source, masked, start) {
  let end = start,
    depth = 0
  for (; end < masked.length; end++) {
    const ch = masked[end]
    if (depth === 0 && [",", ";", ")", "}"].includes(ch)) break
    if ("([{".includes(ch)) depth++
    if (")]}".includes(ch)) depth--
  }
  return source.slice(start, end).trim()
}
function rustCapUses(masked) {
  const stack = [],
    uses = []
  for (let i = 0; i < masked.length; i++) {
    const ch = masked[i]
    if (ch === "(") {
      const callee = masked
        .slice(Math.max(0, i - 180), i)
        .match(/([A-Za-z_]\w*(?:\s*(?:::|\.)\s*[A-Za-z_]\w*)*)\s*$/)?.[1]
        ?.replace(/\s+/g, "")
      stack.push(callee && !/^(?:if|while|for|match)$/.test(callee) ? callee : null)
    } else if (ch === ")") stack.pop()
    else if (/[A-Za-z_]/.test(ch) && !/[A-Za-z0-9_]/.test(masked[i - 1] ?? "")) {
      const name = masked.slice(i).match(/^\w+/)[0]
      const receiverCall = masked
        .slice(i)
        .match(/^\w+(?:\s*\.\s*\w+)+\s*(?=\()/)?.[0]
        ?.trim()
      uses.push({
        name,
        index: i,
        consumers: [...stack.filter(Boolean), ...(receiverCall ? [receiverCall] : [])],
      })
      i += name.length - 1
    }
  }
  return uses
}
function rustCapEvidence(initializer, uses, name, container) {
  return fingerprint(
    JSON.stringify({
      initializer,
      consumers: sorted(
        uses
          .filter(
            (u) =>
              u.name === name &&
              (!container || (u.index > container.start && u.index < container.end))
          )
          .flatMap((u) => u.consumers)
      ),
    })
  )
}
function lexicalBranch(node) {
  const branches = []
  for (let p = node.parent, child = node; p; child = p, p = p.parent) {
    if (ts.isCatchClause(p)) branches.unshift("catch")
    if (ts.isTryStatement(p) && child === p.tryBlock) branches.unshift("try")
    if (ts.isIfStatement(p))
      branches.unshift(
        `${child === p.elseStatement ? "else" : "if"}(${p.expression.getText().replace(/\s+/g, "")})`
      )
    if (ts.isCaseClause(p)) branches.unshift(`case(${p.expression.getText()})`)
    if (ts.isConditionalExpression(p))
      branches.unshift(
        `${child === p.whenFalse ? "false" : "true"}(${p.condition.getText().replace(/\s+/g, "")})`
      )
  }
  return branches.join("::") || "default"
}
function rustStatement(source, masked, index) {
  const boundary =
    Math.max(
      masked.lastIndexOf(";", index - 1),
      masked.lastIndexOf("{", index - 1),
      masked.lastIndexOf("}", index - 1)
    ) + 1
  const declarations = [...masked.slice(boundary, index).matchAll(/\b(?:let|const|static)\b/g)]
  const start = declarations.length ? boundary + declarations.at(-1).index : index
  let depth = 0,
    end = start
  for (; end < masked.length; end++) {
    const ch = masked[end]
    if (depth === 0 && (ch === ";" || ch === "," || ch === "}")) {
      if (ch === ";") end++
      break
    }
    if ("([{".includes(ch)) depth++
    if (")]}".includes(ch)) depth--
  }
  return source.slice(start, end)
}
function enclosingName(node) {
  const parts = []
  for (let p = node.parent; p; p = p.parent) {
    if (
      ts.isVariableDeclaration(p) ||
      ts.isFunctionDeclaration(p) ||
      ts.isMethodDeclaration(p) ||
      ts.isPropertyAssignment(p) ||
      ts.isClassDeclaration(p) ||
      ts.isPropertyDeclaration(p) ||
      ts.isModuleDeclaration(p)
    ) {
      const name = nameOf(p.name)
      if (name) parts.unshift(name)
    } else if (ts.isConstructorDeclaration(p)) parts.unshift("constructor")
  }
  return parts.join("::")
}

function rustScopes(masked) {
  const scopes = []
  for (const m of masked.matchAll(
    /\b(?:impl\s+(?:<[^>]*>\s*)?([^\n{]+)|(?:fn|mod|struct|enum)\s+(\w+)[^;{]*)\s*\{/g
  )) {
    const start = m.index + m[0].lastIndexOf("{")
    const name = m[1]
      ? m[1]
          .trim()
          .replace(/\s+where[\s\S]*/, "")
          .split(/\s+for\s+/)
          .pop()
          .replace(/<.*>/, "")
      : m[2]
    scopes.push({ name, start, end: closingBrace(masked, start) })
  }
  for (const m of masked.matchAll(/\b(?:const|static)\s+(\w+)\s*:[^;=]+=/g)) {
    const start = m.index + m[0].length
    let end = start,
      depth = 0
    for (; end < masked.length; end++) {
      if ("({[".includes(masked[end])) depth++
      else if (")}]".includes(masked[end])) depth--
      else if (masked[end] === ";" && depth === 0) break
    }
    scopes.push({ name: m[1], start, end })
  }
  return scopes.sort((a, b) => a.start - b.start)
}

export function detectCaps(ctx) {
  const rows = []
  for (const file of ctx.files(CAP_ROOTS)) {
    const source = ctx.read(file),
      candidates = []
    if (file.endsWith(".rs")) {
      const masked = maskRust(stripRustTests(source)),
        scopes = rustScopes(masked),
        uses = rustCapUses(masked)
      const scopeAt = (index) =>
        scopes
          .filter((s) => s.start < index && s.end > index)
          .map((s) => s.name)
          .join("::") || "module"
      for (const m of masked.matchAll(
        /\b(?:const|static)\s+(?:mut\s+)?(\w+)\s*:\s*(?:[iu](?:8|16|32|64|128|size)|(?:std::num::)?NonZeroUsize)\s*=\s*([^;]+);/g
      ))
        if (capName(m[1]))
          candidates.push({
            symbol: m[1],
            scope: scopeAt(m.index),
            line: masked.slice(0, m.index).split("\n").length,
            value: (() => {
              const literal = m[2]
                .trim()
                .match(/^(?:-?[\d_]+)(?:[iu](?:8|16|32|64|128|size))?$/)?.[0]
              const nonzero = m[2].match(/(?:NonZeroUsize)::new\(\s*([\d_]+)\s*\)/)?.[1]
              return literal
                ? Number(literal.replaceAll("_", "").replace(/[iu](?:8|16|32|64|128|size)$/, ""))
                : nonzero
                  ? Number(nonzero.replaceAll("_", ""))
                  : null
            })(),
            evidence: rustCapEvidence(
              rustInitializer(source, masked, m.index + m[0].indexOf("=") + 1),
              uses,
              m[1],
              scopes.filter((s) => s.start < m.index && s.end > m.index).at(-1)
            ),
          })
      for (const m of masked.matchAll(
        /\b(?:tokio\s*::\s*sync\s*::\s*)?Semaphore\s*::\s*(?:const_new|new)\s*\(|\bbuffer_unordered\s*\(/g
      )) {
        const constructor = m[0].includes("Semaphore")
          ? `Semaphore::${m[0].includes("const_new") ? "const_new" : "new"}`
          : "buffer_unordered"
        const arg = masked.slice(m.index + m[0].length).match(/^\s*([\d_]+)\s*[,)]/)
        const prefix = masked.slice(Math.max(0, masked.lastIndexOf(";", m.index) + 1), m.index)
        const field = prefix.match(
          /\b(\w+)\s*:\s*(?:(?:Arc|Mutex|RwLock)\s*::\s*new\s*\(\s*)?$/
        )?.[1]
        const local = prefix.match(
          /\blet\s+(?:mut\s+)?(\w+)(?:\s*:[^=;]+)?\s*=\s*(?:(?:Arc|Mutex|RwLock)::new\(\s*)?$/
        )?.[1]
        candidates.push({
          symbol: constructor,
          scope: (() => {
            const prefix = masked.slice(Math.max(0, masked.lastIndexOf(";", m.index) + 1), m.index)
            const field = prefix.match(
              /\b(\w+)\s*:\s*(?:(?:Arc|Mutex|RwLock)\s*::\s*new\s*\(\s*)?$/
            )?.[1]
            const local = prefix.match(
              /\blet\s+(?:mut\s+)?(\w+)(?:\s*:[^=;]+)?\s*=\s*(?:(?:Arc|Mutex|RwLock)::new\(\s*)?$/
            )?.[1]
            return [scopeAt(m.index), field ?? local].filter(Boolean).join("::")
          })(),
          line: masked.slice(0, m.index).split("\n").length,
          value: arg ? Number(arg[1].replaceAll("_", "")) : null,
          evidence: rustCapEvidence(
            rustInitializer(source, masked, m.index + m[0].length),
            uses,
            field ?? local,
            field ? null : scopes.filter((s) => s.start < m.index && s.end > m.index).at(-1)
          ),
        })
      }
      for (const m of masked.matchAll(/\b(max_concurrent\w*)\s*:\s*([\d_]+)\b/g))
        candidates.push({
          symbol: m[1],
          scope: scopeAt(m.index),
          line: masked.slice(0, m.index).split("\n").length,
          value: Number(m[2].replaceAll("_", "")),
          evidence: rustCapEvidence(m[2], uses, m[1], null),
        })
    } else {
      if (
        !/concurren|parallel|in.?flight|slots?|permits?|semaphore|workers?|turn.?limit|max.?active|max.?running|pLimit|PQueue|createLimiter|mapLimit|ConcurrencyGate|RateLimiter|SpeakLimiter|createTokenBucket/i.test(
          source
        )
      )
        continue
      visit(ctx.ast(file), (node) => {
        const previous = candidates.length
        if (
          ts.isVariableDeclaration(node) &&
          nameOf(node.name) &&
          capName(nameOf(node.name)) &&
          capInitializer(node.initializer, nameOf(node.name)) &&
          ts.isVariableDeclarationList(node.parent) &&
          node.parent.flags & ts.NodeFlags.Const
        )
          candidates.push({
            symbol: nameOf(node.name),
            scope: enclosingName(node),
            value: numeric(node.initializer),
          })
        if (
          (ts.isPropertyAssignment(node) ||
            ts.isParameter(node) ||
            ts.isPropertyDeclaration(node)) &&
          nameOf(node.name) &&
          capProperty(nameOf(node.name)) &&
          capInitializer(node.initializer, nameOf(node.name))
        )
          candidates.push({
            symbol: nameOf(node.name),
            scope: enclosingName(node),
            value: numeric(node.initializer),
          })
        if (
          ts.isBinaryExpression(node) &&
          !(ts.isPropertyAssignment(node.parent) && capProperty(nameOf(node.parent.name) ?? "")) &&
          !(ts.isVariableDeclaration(node.parent) && capName(nameOf(node.parent.name) ?? "")) &&
          [ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken].includes(
            node.operatorToken.kind
          ) &&
          ts.isPropertyAccessExpression(node.left) &&
          capProperty(node.left.name.text) &&
          capInitializer(node.right, node.left.name.text)
        )
          candidates.push({
            symbol: node.left.name.text,
            scope: enclosingName(node),
            value: numeric(node.right),
          })
        if (ts.isNewExpression(node) || ts.isCallExpression(node)) {
          const constructor = node.expression.getText().split(".").pop()
          if (LIMITER_FACTORIES.includes(constructor))
            candidates.push({
              symbol: constructor,
              scope: enclosingName(node),
              value: numeric(node.arguments?.[0]),
            })
        }
        for (const candidate of candidates.slice(previous)) {
          candidate.line = ctx.ast(file).getLineAndCharacterOfPosition(node.getStart()).line + 1
          candidate.evidence = tsCapEvidence(ctx.ast(file), node)
          candidate.branch = lexicalBranch(node)
        }
      })
    }
    const scopes = new Map()
    for (const candidate of candidates) {
      const identity = `${candidate.scope}/${candidate.symbol}`
      scopes.set(identity, (scopes.get(identity) ?? 0) + 1)
    }
    for (const candidate of candidates) {
      if (scopes.get(`${candidate.scope}/${candidate.symbol}`) > 1 && candidate.branch)
        candidate.scope = [candidate.scope, candidate.branch].filter(Boolean).join("::")
      const scope = candidate.scope === "module" ? "" : candidate.scope
      const symbol = `${scope ? `${scope}/` : ""}${candidate.symbol}`
      rows.push({
        key: `${file}#${symbol}`,
        owner: deriveOwner(file),
        note: "",
        file,
        symbol,
        value: candidate.value,
        line: candidate.line,
        language: file.endsWith(".rs") ? "rust" : "typescript",
        evidence: candidate.evidence,
      })
    }
  }
  return byKey(rows)
}

// Ledger entry points verified in lib/db/execution-runs.ts. appendRunEvent*
// includes the transaction variants and appendRunEventsInsideTransaction.
// Direct executionRuns writes are checked separately (the same write verbs).
export const LEDGER_WRITERS = [
  "createExecutionRun",
  "adoptExecutionRun",
  "createExecutionRunBinding",
  "putExecutionRunBinding",
  "updateExecutionRunBinding",
  "appendRunObservation",
]
const TABLE_WRITE_METHODS = "(?:add|put|bulkAdd|bulkPut|update|modify|upsert)"
function tableReceiver(node) {
  node = unwrap(node)
  if (ts.isPropertyAccessExpression(node)) return node.name.text
  if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression))
    return node.argumentExpression.text
  if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
    if (
      node.expression.name.text === "table" &&
      node.arguments[0] &&
      ts.isStringLiteralLike(node.arguments[0])
    )
      return node.arguments[0].text
    return tableReceiver(node.expression.expression)
  }
  return null
}
function ledgerBinding(ctx, file, symbol) {
  const found = symbolIn(ctx, file, symbol)
  return (
    found?.file === "lib/db/execution-runs.ts" &&
    (LEDGER_WRITERS.includes(found.symbol ?? found.node.name?.text ?? symbol) ||
      /^appendRunEvent\w*$/.test(found.symbol ?? found.node.name?.text ?? symbol))
  )
}
function resolveCallable(ctx, file, expression, from = expression, seen = new Set()) {
  const expr = unwrap(expression)
  if (!expr) return null
  const key = `${file}:${expr.pos}:${expr.end}`
  if (seen.has(key)) return null
  seen.add(key)
  if (ts.isFunctionLike(expr)) return { file, node: expr, symbol: nameOf(expr.name) ?? "default" }
  const resolveFound = (found) => {
    if (!found) return null
    const node = unwrap(found.node)
    return ts.isFunctionLike(node)
      ? { ...found, node }
      : resolveCallable(ctx, found.file, node, node, seen)
  }
  if (ts.isIdentifier(expr)) {
    const local = localFunction(ctx.ast(file), from, expr.text)
    if (local) return { file, node: local, symbol: expr.text }
    const declaration = valueDeclaration(from, expr.text)
    if (declaration) {
      if (ts.isParameter(declaration)) return null
      if (declaration.initializer)
        return resolveCallable(ctx, file, declaration.initializer, declaration, seen)
    }
    return resolveFound(symbolIn(ctx, file, expr.text))
  }
  if (ts.isPropertyAccessExpression(expr) || ts.isElementAccessExpression(expr)) {
    const receiver = unwrap(expr.expression),
      symbol = ts.isPropertyAccessExpression(expr)
        ? expr.name.text
        : nameOf(expr.argumentExpression)
    if (!ts.isIdentifier(receiver) || !symbol || shadowsImport(from, receiver.text)) return null
    for (const imp of importsIn(ctx, file)) {
      if (imp.typeOnly) continue
      const dep = resolveModule(ctx, imp.spec, file)
      if (!dep) continue
      if (ts.isImportDeclaration(imp.node)) {
        const named = imp.node.importClause?.namedBindings
        if (named && ts.isNamespaceImport(named) && named.name.text === receiver.text)
          return resolveFound(symbolIn(ctx, dep, symbol))
      } else {
        let parent = imp.node.parent
        while (parent && unwrap(parent) === imp.node) parent = parent.parent
        if (parent && ts.isVariableDeclaration(parent) && nameOf(parent.name) === receiver.text)
          return resolveFound(symbolIn(ctx, dep, symbol))
      }
    }
  }
  return null
}
function ledgerTarget(target) {
  return (
    target?.file === "lib/db/execution-runs.ts" &&
    (LEDGER_WRITERS.includes(target.symbol) || /^appendRunEvent\w*$/.test(target.symbol))
  )
}
function argumentIdentity(node) {
  node = unwrap(node)
  if (!node) return null
  if (ts.isIdentifier(node)) return node.text
  if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node))
    return argumentIdentity(node.expression)
  const identifiers = []
  visit(node, (n) => {
    if (
      ts.isIdentifier(n) &&
      !(ts.isPropertyAccessExpression(n.parent) && n.parent.name === n) &&
      !(ts.isPropertyAssignment(n.parent) && n.parent.name === n)
    )
      identifiers.push(n.text)
  })
  return sorted(identifiers)
}
function ledgerCallRecord(file, target, call) {
  return {
    file,
    callee: `${target.file}#${target.symbol}`,
    argumentRoot: argumentIdentity(call.arguments[0]),
    argument: unwrap(call.arguments[0])?.getText() ?? null,
  }
}
/** Resolve a citation's actual binding, never a same-spelled logger method. */
export function ledgerCitation(ctx, file, call, bridgeNames) {
  const target = resolveCallable(ctx, file, call.expression, call)
  if (!target || !call.arguments.length) return null
  if (ledgerTarget(target)) return ledgerCallRecord(file, target, call)
  if (!/^lib\/execution\//.test(target.file) || !bridgeNames.includes(target.symbol)) return null
  const proofs = [],
    seen = new Set()
  const inspect = (found) => {
    const key = `${found.file}:${found.node.pos}:${found.node.end}`
    if (seen.has(key)) return
    seen.add(key)
    const scan = (node) => {
      if (ts.isCallExpression(node)) {
        const callee = resolveCallable(ctx, found.file, node.expression, node)
        if (ledgerTarget(callee) && node.arguments.length)
          proofs.push(ledgerCallRecord(found.file, callee, node))
        else if (
          callee &&
          (callee.file === found.file ||
            (/^lib\/execution\//.test(callee.file) && bridgeNames.includes(callee.symbol)))
        )
          inspect(callee)
      }
      ts.forEachChild(node, (child) => {
        if (!ts.isFunctionLike(child)) scan(child)
      })
    }
    if (found.node.body) scan(found.node.body)
  }
  inspect(target)
  return proofs.length ? { ...ledgerCallRecord(file, target, call), proofs } : null
}
function functionUnit(node) {
  for (let p = node.parent; p; p = p.parent)
    if (ts.isFunctionLike(p) || ts.isSourceFile(p)) return p
}
function localFunction(ast, from, name) {
  // Resolve nearest lexical declaration; a same-named function in a sibling
  // scope cannot establish a call edge for the writer being examined.
  for (let p = from; p; p = p.parent) {
    const statements = ts.isBlock(p) || ts.isSourceFile(p) ? p.statements : []
    for (const statement of statements) {
      if (ts.isFunctionDeclaration(statement) && statement.name?.text === name) return statement
      if (ts.isVariableStatement(statement))
        for (const d of statement.declarationList.declarations) {
          const value = unwrap(d.initializer)
          if (
            nameOf(d.name) === name &&
            value &&
            (ts.isArrowFunction(value) || ts.isFunctionExpression(value))
          )
            return value
        }
    }
  }
  return null
}
function valueDeclaration(from, name) {
  for (let p = from.parent; p; p = p.parent) {
    if (ts.isFunctionLike(p)) {
      const parameter = p.parameters.find((param) => nameOf(param.name) === name)
      if (parameter) return parameter
    }
    if (ts.isBlock(p) || ts.isSourceFile(p))
      for (const statement of p.statements) {
        if (ts.isVariableStatement(statement)) {
          const declaration = statement.declarationList.declarations.find(
            (d) => nameOf(d.name) === name
          )
          if (declaration) return declaration
          for (const d of statement.declarationList.declarations)
            if (ts.isObjectBindingPattern(d.name)) {
              const e = d.name.elements.find((e) => nameOf(e.name) === name)
              if (e) return e
            }
        }
      }
  }
  return null
}
function shadowsImport(from, name) {
  for (let p = from.parent; p && !ts.isSourceFile(p); p = p.parent) {
    if (ts.isFunctionLike(p) && p.parameters.some((param) => nameOf(param.name) === name))
      return true
    if (ts.isBlock(p))
      for (const statement of p.statements) {
        if (ts.isFunctionDeclaration(statement) && statement.name?.text === name) return true
        if (
          ts.isVariableStatement(statement) &&
          statement.declarationList.declarations.some((d) => nameOf(d.name) === name)
        )
          return true
      }
  }
  return false
}
function dexieHandle(ctx, file, symbol) {
  const found = symbolIn(ctx, file, symbol)
  if (!found) return false
  const isDexie = dexieBindings(ctx, found.file),
    value = unwrap(found.node)
  if (ts.isNewExpression(value)) {
    if (isDexie(value.expression)) return true
    const cls = symbolIn(ctx, found.file, value.expression.getText())
    return (
      !!cls &&
      ts.isClassDeclaration(cls.node) &&
      cls.node.heritageClauses?.some(
        (c) =>
          c.token === ts.SyntaxKind.ExtendsKeyword &&
          c.types.some((t) => dexieBindings(ctx, cls.file)(t.expression))
      )
    )
  }
  return false
}
function functionKey(file, unit) {
  if (ts.isSourceFile(unit)) return `${file}#<module>`
  const scope = enclosingName(unit),
    own = nameOf(unit.name)
  const callback = ts.isCallExpression(unit.parent) ? unit.parent.expression.getText() : "callback"
  return `${file}#${[scope, own ?? (!scope ? `<${callback}>` : null)].filter(Boolean).join("::")}`
}
function exportedFunctionEntries(ctx) {
  if (ctx.exportedFunctionEntries) return ctx.exportedFunctionEntries
  const entries = (ctx.exportedFunctionEntries = new Set())
  const mark = (found) => {
    const node = unwrap(found?.node)
    if (node && ts.isFunctionLike(node)) entries.add(`${found.file}:${node.pos}:${node.end}`)
  }
  for (const file of ctx
    .files([...DB_ROOTS, "hooks", "components", "app", "sidecar/src"])
    .filter((f) => !f.endsWith(".rs"))) {
    if (!/\bexport\s*(?:\{|default\b)/.test(ctx.read(file))) continue
    for (const statement of ctx.ast(file).statements) {
      if (ts.isExportAssignment(statement) && !statement.isExportEquals) {
        const value = unwrap(statement.expression)
        mark(ts.isIdentifier(value) ? symbolIn(ctx, file, value.text) : { file, node: value })
      }
      if (
        ts.isExportDeclaration(statement) &&
        !statement.isTypeOnly &&
        statement.exportClause &&
        ts.isNamedExports(statement.exportClause)
      ) {
        const dep =
          statement.moduleSpecifier && ts.isStringLiteralLike(statement.moduleSpecifier)
            ? resolveModule(ctx, statement.moduleSpecifier.text, file)
            : file
        if (dep)
          for (const e of statement.exportClause.elements)
            if (!e.isTypeOnly) mark(symbolIn(ctx, dep, e.propertyName?.text ?? e.name.text))
      }
    }
  }
  return entries
}
function databaseIdentity(ctx, file, node, from = node, seen = new Set()) {
  if (!node) return null
  node = unwrap(node)
  const marker = `${file}:${node.pos}:${node.end}`
  if (seen.has(marker)) return null
  seen.add(marker)
  const again = (f, n, at = n) => databaseIdentity(ctx, f, n, at, new Set(seen))
  if (ts.isClassDeclaration(node)) return `${node.name?.text ?? "anonymousDexie"}@${file}`
  if (ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isPropertyDeclaration(node))
    return again(file, node.type) ?? again(file, node.initializer)
  if (ts.isTypeReferenceNode(node)) {
    const found = symbolIn(ctx, file, node.typeName.getText())
    if (found && ts.isClassDeclaration(found.node)) return `${found.node.name.text}@${found.file}`
    if (node.typeArguments?.length === 1) return again(file, node.typeArguments[0])
  }
  if (ts.isIdentifier(node)) {
    const local = valueDeclaration(from, node.text)
    if (local) return again(file, local)
    const found = symbolIn(ctx, file, node.text)
    if (found) return again(found.file, found.node)
  }
  if (ts.isNewExpression(node)) {
    if (dexieBindings(ctx, file)(node.expression)) {
      let declaration = node.parent
      while (
        declaration &&
        !ts.isVariableDeclaration(declaration) &&
        !ts.isFunctionLike(declaration)
      )
        declaration = declaration.parent
      return `${nameOf(declaration?.name) ?? nameOf(node.arguments?.[0]) ?? "anonymousDexie"}@${file}`
    }
    const found = symbolIn(ctx, file, node.expression.getText())
    if (found) return again(found.file, found.node)
  }
  if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
    const local = localFunction(ctx.ast(file), node, node.expression.text)
    const found = local ? { file, node: local } : symbolIn(ctx, file, node.expression.text)
    if (found) return again(found.file, found.node)
  }
  if (ts.isFunctionLike(node)) {
    const typed = again(file, node.type)
    if (typed) return typed
    let identity = null
    if (node.body)
      visit(node.body, (child) => {
        if (!identity && ts.isReturnStatement(child) && functionUnit(child) === node)
          identity = again(file, child.expression, child)
      })
    return identity
  }
  if (
    node.kind === ts.SyntaxKind.ThisKeyword ||
    (ts.isPropertyAccessExpression(node) && node.expression.kind === ts.SyntaxKind.ThisKeyword)
  ) {
    let cls = from.parent
    while (cls && !ts.isClassDeclaration(cls)) cls = cls.parent
    if (!cls) return null
    if (node.kind === ts.SyntaxKind.ThisKeyword) return `${cls.name?.text}@${file}`
    const member = cls.members.find((m) => nameOf(m.name) === node.name.text)
    if (member) return again(file, member)
  }
  return null
}
function tableAccess(node) {
  node = unwrap(node)
  if (ts.isPropertyAccessExpression(node)) return { table: node.name.text, handle: node.expression }
  if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression))
    return { table: node.argumentExpression.text, handle: node.expression }
  if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
    if (
      node.expression.name.text === "table" &&
      node.arguments[0] &&
      ts.isStringLiteralLike(node.arguments[0])
    )
      return { table: node.arguments[0].text, handle: node.expression.expression }
    return tableAccess(node.expression.expression)
  }
  return null
}
function lifecycleField(name) {
  return /^(?:status|state|phase|attempts?|attemptcount|retrycount|retries|nextattemptat|nextrunat|nextpollat|dueat|completedat|finishedat|endedat|error\w*|claim\w*|lease\w*|\w+lease)$/.test(
    (name ?? "").replaceAll("_", "").toLowerCase()
  )
}
function lifecycleExpressions(unit) {
  const expressions = new Set(),
    aliases = new Set(),
    nodes = []
  const scan = (node) => {
    nodes.push(node)
    ts.forEachChild(node, (child) => {
      if (!ts.isFunctionLike(child)) scan(child)
    })
  }
  if (ts.isFunctionLike(unit)) {
    for (const parameter of unit.parameters) scan(parameter)
    if (unit.body) scan(unit.body)
  } else scan(unit)
  const fieldNode = (node) =>
    !(node.parent && ts.isCallExpression(node.parent) && unwrap(node.parent.expression) === node) &&
    ((ts.isPropertyAccessExpression(node) && lifecycleField(node.name.text)) ||
      (ts.isElementAccessExpression(node) &&
        ts.isStringLiteralLike(node.argumentExpression) &&
        lifecycleField(node.argumentExpression.text)))
  const reads = (node) => {
    let relevant = false
    visit(node, (n) => {
      if (
        fieldNode(n) ||
        (ts.isIdentifier(n) && (lifecycleField(n.text) || aliases.has(valueDeclaration(n, n.text))))
      )
        relevant = true
    })
    return relevant
  }
  for (const node of nodes) {
    if (ts.isBindingElement(node) && lifecycleField(nameOf(node.propertyName) ?? nameOf(node.name)))
      aliases.add(node)
    if (ts.isVariableDeclaration(node) && node.initializer && reads(node.initializer))
      aliases.add(node)
  }
  const add = (node) => {
    let p = node
    while (
      p.parent &&
      (ts.isBinaryExpression(p.parent) ||
        ts.isPrefixUnaryExpression(p.parent) ||
        ts.isPostfixUnaryExpression(p.parent) ||
        ts.isConditionalExpression(p.parent) ||
        ts.isCallExpression(p.parent) ||
        ts.isPropertyAccessExpression(p.parent) ||
        unwrap(p.parent) === unwrap(p))
    )
      p = p.parent
    expressions.add(p.getText().replace(/\s+/g, " ").trim())
  }
  for (const node of nodes) {
    if (
      (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) &&
      lifecycleField(nameOf(node.name))
    )
      add(node)
    else if (fieldNode(node)) add(node)
    else if (
      ts.isIdentifier(node) &&
      (lifecycleField(node.text) || aliases.has(valueDeclaration(node, node.text)))
    ) {
      if (
        (ts.isPropertyAccessExpression(node.parent) && node.parent.name === node) ||
        ((ts.isPropertyAssignment(node.parent) || ts.isBindingElement(node.parent)) &&
          node.parent.name === node)
      )
        continue
      if (
        (ts.isVariableDeclaration(node.parent) || ts.isParameter(node.parent)) &&
        node.parent.name === node &&
        node.parent.initializer
      )
        expressions.add(`${node.text}=${node.parent.initializer.getText().replace(/\s+/g, " ")}`)
      else add(node)
    } else if (
      ts.isStringLiteralLike(node) &&
      lifecycleField(node.text) &&
      ts.isCallExpression(node.parent) &&
      ts.isPropertyAccessExpression(unwrap(node.parent.expression)) &&
      ["where", "orderBy"].includes(unwrap(node.parent.expression).name.text)
    )
      add(node)
  }
  return expressions
}
function writerFacts(ctx, file) {
  ctx.writerFacts ??= new Map()
  if (ctx.writerFacts.has(file)) return ctx.writerFacts.get(file)
  const ast = ctx.ast(file),
    imports = new Map(),
    namespaces = new Map(),
    units = new Map()
  const fact = (unit) => {
    if (!units.has(unit)) units.set(unit, { sites: new Map(), ledger: false, calls: new Set() })
    return units.get(unit)
  }
  for (const imp of importsIn(ctx, file)) {
    if (imp.typeOnly) continue
    const dep = resolveModule(ctx, imp.spec, file)
    if (!dep) continue
    if (ts.isCallExpression(imp.node)) {
      let p = imp.node.parent
      if (ts.isAwaitExpression(p)) p = p.parent
      if (ts.isVariableDeclaration(p)) {
        if (ts.isObjectBindingPattern(p.name))
          for (const e of p.name.elements)
            imports.set(nameOf(e.name), {
              file: dep,
              symbol: nameOf(e.propertyName) ?? nameOf(e.name),
            })
        else if (ts.isIdentifier(p.name)) namespaces.set(p.name.text, dep)
      }
    } else if (ts.isImportDeclaration(imp.node)) {
      const named = imp.node.importClause?.namedBindings
      if (named && ts.isNamedImports(named))
        for (const e of named.elements)
          if (!e.isTypeOnly)
            imports.set(e.name.text, { file: dep, symbol: e.propertyName?.text ?? e.name.text })
      if (named && ts.isNamespaceImport(named)) namespaces.set(named.name.text, dep)
    }
  }
  const tables = discoverDexieTables(ctx)
  visit(ast, (node) => {
    if (!ts.isCallExpression(node)) return
    const current = fact(functionUnit(node)),
      expr = unwrap(node.expression)
    if (ts.isArrowFunction(expr) || ts.isFunctionExpression(expr)) current.calls.add(expr)
    for (const rawArg of node.arguments) {
      const arg = unwrap(rawArg)
      if (ts.isArrowFunction(arg) || ts.isFunctionExpression(arg)) current.calls.add(arg)
      else if (ts.isIdentifier(arg)) {
        const local = localFunction(ast, node, arg.text)
        if (local) current.calls.add(local)
      }
    }
    if (ts.isIdentifier(expr)) {
      const local = localFunction(ast, node, expr.text)
      if (local) current.calls.add(local)
      else {
        const binding = imports.get(expr.text)
        if (
          binding &&
          !shadowsImport(node, expr.text) &&
          ledgerBinding(ctx, binding.file, binding.symbol)
        )
          current.ledger = true
      }
    } else if (ts.isPropertyAccessExpression(expr)) {
      if (
        ts.isIdentifier(expr.expression) &&
        namespaces.has(expr.expression.text) &&
        !shadowsImport(node, expr.expression.text) &&
        ledgerBinding(ctx, namespaces.get(expr.expression.text), expr.name.text)
      )
        current.ledger = true
      if (expr.expression.kind === ts.SyntaxKind.ThisKeyword) {
        let cls = node.parent
        while (cls && !ts.isClassDeclaration(cls)) cls = cls.parent
        const callee = cls?.members.find(
          (m) => ts.isMethodDeclaration(m) && nameOf(m.name) === expr.name.text
        )
        if (callee) current.calls.add(callee)
      }
      const access = tableAccess(expr.expression)
      if (!access) return
      const matches = tables.filter((t) => t.table === access.table)
      const write = new RegExp(`^${TABLE_WRITE_METHODS}$`).test(expr.name.text)
      const identity = databaseIdentity(ctx, file, access.handle, node)
      if (access.table === "executionRuns" && write && identity) current.ledger = true
      for (const table of matches) {
        // Unresolved handles may nominate an unproven writer, but can never
        // lend another receiver/database a positive ledger proof.
        if (identity && identity !== table.database) continue
        const key = table.key,
          prior = current.sites.get(key)
        current.sites.set(key, {
          write: write || !!prior?.write,
          known: !!identity && (prior?.known ?? true),
        })
      }
    }
  })
  for (const f of units.values()) for (const c of f.calls) fact(c)
  for (const [unit, f] of units) f.lifecycle = lifecycleExpressions(unit)
  const behavior = (unit, seen = new Set()) => {
    if (seen.has(unit)) return []
    seen.add(unit)
    const f = units.get(unit)
    return [...(f?.lifecycle ?? [])]
      .map((e) => `${functionKey(file, unit)}:${e}`)
      .concat([...(f?.calls ?? [])].flatMap((c) => behavior(c, seen)))
  }
  const reach = (unit, seen = new Set()) => {
    if (seen.has(unit)) return false
    seen.add(unit)
    const f = units.get(unit)
    return !!f && (f.ledger || [...f.calls].some((c) => reach(c, seen)))
  }
  const sites = (unit, seen = new Set()) => {
    if (seen.has(unit)) return new Map()
    seen.add(unit)
    const f = units.get(unit),
      all = new Map(f?.sites ?? [])
    for (const c of f?.calls ?? [])
      for (const [key, value] of sites(c, seen)) {
        const old = all.get(key)
        all.set(key, {
          write: value.write || !!old?.write,
          known: value.known && (old?.known ?? true),
        })
      }
    return all
  }
  const called = new Set([...units.values()].flatMap((f) => [...f.calls]))
  const exported = (unit) => {
    if (exportedFunctionEntries(ctx).has(`${file}:${unit.pos}:${unit.end}`)) return true
    let p = unit
    while (p && !ts.isSourceFile(p)) {
      if (p.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) return true
      if (ts.isBlock(p)) break
      p = p.parent
    }
    return (
      ts.isMethodDeclaration(unit) &&
      !unit.modifiers?.some((m) => m.kind === ts.SyntaxKind.PrivateKeyword)
    )
  }
  const result = new Map()
  for (const unit of units.keys()) {
    const key = functionKey(file, unit)
    for (const [table, site] of units.get(unit).sites) {
      if (!result.has(table))
        result.set(table, { writers: new Map(), consumers: new Set(), lifecycle: new Set() })
      for (const expression of behavior(unit)) result.get(table).lifecycle.add(expression)
      if (!site.write) result.get(table).consumers.add(key)
    }
    if (called.has(unit) && !exported(unit)) continue
    for (const [table, site] of sites(unit)) {
      if (!result.has(table))
        result.set(table, { writers: new Map(), consumers: new Set(), lifecycle: new Set() })
      for (const expression of behavior(unit)) result.get(table).lifecycle.add(expression)
      if (site.write) result.get(table).writers.set(key, site.known && reach(unit))
    }
  }
  // Recursive/private cycles with no externally visible root still contribute
  // their direct writers conservatively rather than disappearing.
  for (const [unit, f] of units)
    for (const [table, site] of f.sites)
      if (site.write && !result.get(table)?.writers.size)
        result.get(table).writers.set(functionKey(file, unit), site.known && reach(unit))
  ctx.writerFacts.set(file, result)
  return result
}
function tableFunctionFacts(ctx, table) {
  if (table.key.startsWith("dexie:")) {
    if (!ctx.tableFunctionFacts) {
      ctx.tableFunctionFacts = new Map()
      const names = discoverDexieTables(ctx).map((t) => t.table)
      for (const file of ctx
        .files([...DB_ROOTS, "hooks", "components", "app", "sidecar/src"])
        .filter((f) => !f.endsWith(".rs"))) {
        const source = ctx.read(file)
        if (!/\.\s*\w+\s*\(/.test(source) || !names.some((name) => source.includes(name))) continue
        for (const [key, value] of writerFacts(ctx, file)) {
          if (!ctx.tableFunctionFacts.has(key))
            ctx.tableFunctionFacts.set(key, {
              writers: new Map(),
              consumers: new Set(),
              lifecycle: new Set(),
            })
          const target = ctx.tableFunctionFacts.get(key)
          for (const [writer, linked] of value.writers) target.writers.set(writer, linked)
          for (const consumer of value.consumers) target.consumers.add(consumer)
          for (const expression of value.lifecycle) target.lifecycle.add(expression)
        }
      }
    }
    return (
      ctx.tableFunctionFacts.get(table.key) ?? {
        writers: new Map(),
        consumers: new Set(),
        lifecycle: new Set(),
      }
    )
  }
  const writers = new Map(),
    consumers = new Set(),
    lifecycle = new Set()
  if (table.file?.endsWith(".rs"))
    for (const file of ctx
      .files([
        table.file.startsWith("crates/")
          ? table.file.split("/").slice(0, 2).join("/")
          : "src-tauri/src",
      ])
      .filter((f) => f.endsWith(".rs"))) {
      if (!ctx.read(file).includes(table.table)) continue
      const masked = maskRust(stripRustTests(ctx.read(file)), true),
        scopes = rustScopes(maskRust(masked))
      for (const m of masked.matchAll(
        new RegExp(
          String.raw`\b(?:INSERT(?:\s+OR\s+\w+)?\s+INTO|UPDATE|DELETE\s+FROM|SELECT[^;]*?\bFROM)\s+${table.table}\b`,
          "gi"
        )
      )) {
        const scope =
          scopes
            .filter((s) => s.start < m.index && s.end > m.index)
            .map((s) => s.name)
            .join("::") || "<module>"
        const key = `${file}#${scope}`
        // SQL literals carry transition predicates/values; the surrounding
        // Rust expressions carry bound retry/lease parameters.
        const quoteStart = masked.lastIndexOf('"', m.index),
          quoteEnd = masked.indexOf('"', m.index + m[0].length)
        if (quoteStart >= 0 && quoteEnd > m.index)
          lifecycle.add(
            `${key}:${masked
              .slice(quoteStart + 1, quoteEnd)
              .replace(/\s+/g, " ")
              .trim()}`
          )
        const container = scopes.filter((s) => s.start < m.index && s.end > m.index).at(-1)
        const code = maskRust(stripRustTests(ctx.read(file)))
        const start = container?.start ?? 0,
          end = container?.end ?? code.length
        for (const token of code.slice(start, end).matchAll(/\b[A-Za-z_]\w*\b/g))
          if (lifecycleField(token[0])) {
            const expression = rustStatement(ctx.read(file), code, start + token.index)
              .replace(/\s+/g, " ")
              .trim()
            lifecycle.add(`${key}:${expression}`)
          }
        if (/^SELECT/i.test(m[0])) consumers.add(key)
        else writers.set(key, false)
      }
    }
  return { writers, consumers, lifecycle }
}
function withTableEvidence(ctx, table, extraConsumers = []) {
  const facts = tableFunctionFacts(ctx, table),
    writerFunctions = sorted(facts.writers.keys()),
    consumerFunctions = sorted(facts.consumers)
  for (const key of extraConsumers)
    if (!consumerFunctions.includes(key)) consumerFunctions.push(key)
  consumerFunctions.sort()
  return {
    ...table,
    writerFunctions,
    consumerFunctions,
    evidence: fingerprint(
      JSON.stringify({
        database: table.database,
        statuses: sorted(table.rowStatuses ?? []),
        lifecycle: sorted(facts.lifecycle ?? []),
        fields:
          table.rowFields === null
            ? [`<unresolved:${table.rowType ?? "unknown"}>`]
            : sorted(table.rowFields ?? []),
        writers: writerFunctions,
        consumers: consumerFunctions,
      })
    ),
  }
}
export function manualQueueCandidate(ctx, row) {
  if (row.key === "manual:file-grant-mirror") ctx.allSqliteTables ??= sqliteTables(ctx, true)
  const table =
    row.key === "manual:file-grant-mirror"
      ? ctx.allSqliteTables.find((t) => t.key === "sqlite:cognia-file-share/file_grants")
      : row.key === "manual:integration-event-projections"
        ? discoverDexieTables(ctx).find((t) => t.table === "integrationEvents")
        : null
  if (table)
    return {
      ...row,
      evidence: withTableEvidence(ctx, table, [`${row.file}#${row.symbol}`]).evidence,
    }
  return {
    ...row,
    evidence: fingerprint(
      JSON.stringify({
        database: row.file,
        fields: row.rowFields ?? [],
        writers: [`${row.file}#${row.symbol}`],
        consumers: [`${row.runner ?? row.file}#${row.symbol}`],
      })
    ),
  }
}

export function detectRunTables(ctx) {
  const candidates = discoverDexieTables(ctx).filter(
    (t) =>
      /^(?:runs?|attempts?|executions?|tasks?|jobs?|deliveries|submissions?|issues|queue)$/.test(
        words(t.table).at(-1) ?? ""
      ) ||
      (t.rowStatuses.length &&
        t.rowFields?.some((f) =>
          ["startedAt", "finishedAt", "completedAt", "endedAt"].includes(f)
        )) ||
      t.rowFields === null
  )
  return byKey(
    candidates.map((table) => {
      const referenceField =
        ["executionRunId", "runId", "ledgerRunId", "executionRun"].find((f) =>
          table.rowFields?.includes(f)
        ) ?? null
      const facts = tableFunctionFacts(ctx, table),
        unlinkedWriters = sorted(
          [...facts.writers].filter(([, linked]) => !linked).map(([key]) => key)
        )
      return {
        ...withTableEvidence(ctx, table),
        reference: !referenceField
          ? "none"
          : facts.writers.size && !unlinkedWriters.length
            ? "real"
            : "name-only",
        referenceField,
        writers: sorted([...facts.writers.keys()].map((key) => key.split("#")[0])),
        ledgerWriters: sorted(
          [...facts.writers].filter(([, linked]) => linked).map(([key]) => key.split("#")[0])
        ),
        unlinkedWriters,
      }
    })
  )
}

export const DETECTORS = {
  "runtime-initializers": detectRuntimeInitializers,
  "lib-store-imperative": detectLibStoreImperative,
  "lib-ui-imports": detectLibUiImports,
  "durable-queues": detectDurableQueues,
  caps: detectCaps,
  "run-tables": detectRunTables,
  "tauri-dynamic-imports": detectTauriDynamicImports,
}

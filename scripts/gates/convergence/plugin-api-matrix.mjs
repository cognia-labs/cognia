#!/usr/bin/env node
/** ADR-0250 §9 research inventory. No runtime imports, execution, or type checking of plugin code. */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs"
import { dirname, posix, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { spawnSync } from "node:child_process"
import ts from "typescript"

// Classification is policy, not a claim that today's implementations are headless.
// Explicit namespace lists make catalog additions fail until reviewed.
export const LAYER_RULES = {
  host: [
    "agent",
    "agentConfig",
    "ai",
    "artifact",
    "auth",
    "automation",
    "backup",
    "bots",
    "browser",
    "canvas",
    "capabilities",
    "characterPacks",
    "chat",
    "commands",
    "companion",
    "configuration",
    "connectors",
    "db",
    "decisions",
    "prompts",
    "dexie",
    "eval",
    "events",
    "export",
    "externalAgents",
    "fs",
    "git",
    "goals",
    "issues",
    "i18n",
    "import",
    "integrations",
    "lifecycle",
    "logger",
    "logs",
    "media",
    "memory",
    "network",
    "ocr",
    "perf",
    "permissions",
    "project",
    "python",
    "resources",
    "recorder",
    "sandbox",
    "scheduler",
    "secrets",
    "services",
    "securityScans",
    "session",
    "settings",
    "share",
    "shell",
    "sites",
    "storage",
    "subscription",
    "team",
    "templates",
    "terminal",
    "userScheduler",
    "uri",
    "vector",
    "workflow",
    "workspace",
    "nodeRuntime",
    "libraries",
    "files",
    "skills",
    "plans",
    "hooks",
  ],
  ui: [
    "a2ui",
    "clipboard",
    "contextMenu",
    "contextPanels",
    "editor",
    "extensions",
    "glance",
    "messagePart",
    "modal",
    "notifications",
    "pet",
    "quickActions",
    "remoteDesktop",
    "shortcuts",
    "theme",
    "toolResult",
    "tray",
    "ui",
    "webview",
    "window",
  ],
  uiResourceRegistration: {
    method: "^(register|create)",
    effects: ["host-owned", "returned-handle", "returned-disposer"],
    reason:
      "Registers a host-owned resource whose presentation or interaction belongs to a client.",
  },
  methodRules: [
    {
      namespaces: ["workspace"],
      method: "^getActiveRoot$",
      layer: "ui",
      reason: "Resolves the root of the project selected by the renderer's activeProjectId.",
    },
    {
      namespaces: ["project"],
      method: "^onProjectChange$",
      layer: "ui",
      reason: "Subscribes to changes in the project selected by a client, not all project data.",
    },
    {
      namespaces: ["session"],
      method: "^onSessionChange$",
      layer: "ui",
      reason: "Subscribes to the session selected by a client, not an explicit session id.",
    },
    {
      namespaces: ["team"],
      method: "^createTeam$",
      layer: "both",
      reason:
        "Creates host team data using the project selected by the renderer as implicit project context.",
    },
    {
      namespaces: ["commands"],
      method: "^(listCustomCommands|getCustomCommand|saveCustomCommand|deleteCustomCommand)$",
      layer: "both",
      reason:
        "Reads or writes host command files, defaulting cwd to the project selected in a client.",
    },
    {
      namespaces: ["automation"],
      method:
        "^(screenshot|listApps|getAppState|queryElements|findText|clickText|zoom|expandElement|performAction|click|mouseButton|type|paste|keys|holdKey|mouseMove|drag|scroll|windowOp|launchApp)$",
      layer: "both",
      reason:
        "Runs a host automation operation whose consent/PiP context falls back to the renderer's focused session.",
    },
    {
      namespaces: ["artifact"],
      method: "^(getActiveArtifact|openArtifact|closeArtifact|onArtifactChange)$",
      layer: "ui",
      reason: "Reads, reveals, closes or subscribes to the artifact selected in a client.",
    },
    {
      namespaces: ["artifact"],
      method: "^registerRenderer$",
      layer: "both",
      reason: "Registers an artifact renderer in the host registry for client rendering.",
    },
    {
      namespaces: ["canvas"],
      method:
        "^(getCurrentDocument|getContent|getSelection|openDocument|closeCanvas|onCanvasChange|onContentChange)$",
      layer: "ui",
      reason: "Reads, reveals or subscribes to the document/selection active in a client canvas.",
    },
    {
      namespaces: ["canvas"],
      method:
        "^(setContent|setSelection|insertText|replaceSelection|executeAction|executeActionStreaming|executePython)$",
      layer: "both",
      reason:
        "Changes document data using the active canvas/editor context and projects the result into that client.",
    },
    {
      namespaces: ["theme"],
      method:
        "^(setMode|setColorPreset|activateCustomTheme|activateRegisteredTheme|updateCustomTheme|deleteCustomTheme)$",
      layer: "both",
      reason: "Changes stored theme configuration and applies its client presentation.",
    },
    {
      namespaces: ["shell"],
      method: "^(open|showInFolder)$",
      layer: "ui",
      reason: "Opens an external application or reveals a file on the user's client.",
    },
    {
      namespaces: ["files"],
      method: "^(open|save)$",
      layer: "ui",
      reason: "Invokes the client's file chooser; attachment reads remain host data access.",
    },
    {
      namespaces: ["browser"],
      method: "^(openPane|isSurfaceVisible)$",
      layer: "ui",
      reason:
        "Opens or inspects the client's browser pane, rather than running browser automation.",
    },
    {
      namespaces: ["chat"],
      method: "^(addContextSelection|appendToComposer)$",
      layer: "ui",
      reason: "Changes the client's composer or selection state.",
    },
    {
      namespaces: ["chat"],
      method: "^(appendMessagePart|stageIntent|registerLinkMatcher)$",
      layer: "both",
      reason: "Records a chat contribution or intent that is projected into a client conversation.",
    },
    {
      namespaces: ["commands"],
      method:
        "^(registerSlashCommand|unregisterSlashCommand|saveCustomCommand|deleteCustomCommand)$",
      layer: "both",
      reason: "Changes the command registry consumed by the client's command UI.",
    },
    {
      namespaces: ["session"],
      method: "^(getCurrentSession|getCurrentSessionId|switchSession)$",
      layer: "ui",
      reason: "Reads or changes the session selected in a client.",
    },
    {
      namespaces: ["project"],
      method: "^(getCurrentProject|getCurrentProjectId|setActiveProject)$",
      layer: "ui",
      reason: "Reads or changes the project selected in a client.",
    },
    {
      namespaces: ["workflow"],
      method: "^(autoLayoutEditor|explainEditorLastRun|explainEditorValidation|resolveEditor)$",
      layer: "ui",
      reason: "Operates on an open workflow editor's state.",
    },
    {
      namespaces: ["workflow"],
      method: "^(mutateEditor|stageProposal)$",
      layer: "both",
      reason: "Writes workflow changes or a proposal and projects them into an open editor.",
    },
    {
      namespaces: ["export", "media"],
      method: "^(download|utils.downloadFile)$",
      layer: "ui",
      reason: "Starts a client-side file download.",
    },
    {
      namespaces: ["ocr"],
      method: "^(extractScreen|runSlashCommand)$",
      layer: "ui",
      reason: "Captures a client screen or invokes an interactive OCR command.",
    },
    {
      namespaces: ["permissions"],
      method: "^requestPermission$",
      layer: "both",
      reason: "Requests user consent in a client and records the resulting host grant.",
    },
  ],
}
export const PLACEMENT_RULES = {
  hostContainers: ["hooks", "tools", "scheduledTasks", "interceptors", "connectors"],
  clientProperties: ["render", "component", "Component", "view", "View"],
  callbackApis: [
    "scheduler.registerHandler",
    "commands.registerSlashCommand",
    "agent.registerTool",
    "agent.context.registerProvider",
    "chat.use",
    "connectors.onInbound",
    "connectors.onCallback",
    "events.on",
    "events.once",
    "events.bus.on",
    "events.bus.once",
    "events.ipc.on",
    "events.ipc.expose",
    "lifecycle.onDispose",
  ],
  standardCallbacks: [
    "map",
    "flatMap",
    "filter",
    "forEach",
    "reduce",
    "find",
    "some",
    "every",
    "then",
    "catch",
    "finally",
  ],
}
// WIT has a narrower, differently named surface. These are semantic equivalents,
// not signature/ABI parity. In particular notify != notification-center create,
// generate-text != chat, and emit-event != the workflow trigger author API.
export const WIT_ALIASES = {
  "secrets.set": ["secrets.store"],
  "process.exec": ["shell.execute"],
}
const PATHS = {
  catalog: "packages/plugin-contract/contract/catalog.json",
  context: "lib/plugin/core/context.ts",
  pythonCtx: "plugin-sdk/python/src/cognia/ctx.py",
  pythonMirror: "plugin-sdk/python/src/cognia/_generated_contract.py",
  router: "lib/plugin/python/host-request-router.ts",
  wit: "packages/plugin-sdk/wit/cognia-plugin.wit",
  frozen: "crates/cognia-plugin-runtime/frozen/v0_1/cognia-plugin.wit",
  overrides: "scripts/gates/convergence/plugin-api-layer-overrides.json",
  // Per-method detail is regenerated on demand into a gitignored path; only
  // the Markdown note is the committed, pinned snapshot.
  json: ".cache/convergence/plugin-api-matrix.json",
  md: "docs/research/plugin-api-matrix-2026-11-01.md",
}
const IGNORED_DIRS = new Set([
  "vendor",
  "node_modules",
  "dist",
  "build",
  "out",
  "target",
  "coverage",
  "__tests__",
  "tests",
  "test",
  "__pycache__",
  ".next",
  ".cache",
  ".venv",
  "venv",
])
export function isSource(path) {
  const parts = path.split("/")
  return (
    !parts.some((part) => IGNORED_DIRS.has(part) || part.startsWith(".")) &&
    /\.(?:[cm]?[jt]sx?|py)$/.test(path) &&
    !/(?:\.(?:test|spec)\.[^.]+|\.d\.[cm]?ts|(?:^|\/)(?:test|tests|conftest)\.[^/]+|(?:^|\/)test[-_][^/]+\.[^.]+|_test\.[^.]+)$/.test(
      path
    )
  )
}
function walk(root, base = "") {
  if (typeof root !== "string")
    return [...root.files.keys()]
      .filter(
        (path) =>
          (!base || path.startsWith(`${base}/`)) &&
          !path.split("/").some((part) => IGNORED_DIRS.has(part) || part.startsWith("."))
      )
      .sort()
  if (!existsSync(resolve(root, base))) return []
  return readdirSync(resolve(root, base), { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name, "en"))
    .flatMap((entry) => {
      const path = posix.join(base, entry.name)
      if (entry.isSymbolicLink() || IGNORED_DIRS.has(entry.name) || entry.name.startsWith("."))
        return []
      return entry.isDirectory() ? walk(root, path) : [path]
    })
}
const readSource = (root, path) =>
  typeof root === "string" ? readFileSync(resolve(root, path), "utf8") : root.files.get(path)
const hasSource = (root, path) =>
  typeof root === "string"
    ? existsSync(resolve(root, path)) && statSync(resolve(root, path)).isFile()
    : root.files.has(path)
function writeSource(root, path, content) {
  if (typeof root !== "string") root.files.set(path, content)
  else {
    mkdirSync(dirname(resolve(root, path)), { recursive: true })
    writeFileSync(resolve(root, path), content)
  }
}
const parseTs = (path, text) =>
  ts.createSourceFile(
    path,
    text,
    ts.ScriptTarget.Latest,
    true,
    /\.[jt]sx$/.test(path) ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  )
const nameOf = (node) =>
  node && (ts.isIdentifier(node) || ts.isStringLiteralLike(node) || ts.isNumericLiteral(node))
    ? node.text
    : undefined
const unwrap = (node) => {
  while (
    node &&
    (ts.isParenthesizedExpression(node) ||
      ts.isAsExpression(node) ||
      ts.isTypeAssertionExpression(node) ||
      ts.isNonNullExpression(node) ||
      ts.isSatisfiesExpression(node) ||
      ts.isAwaitExpression(node))
  )
    node = node.expression
  return node
}
const isFunction = (node) => ts.isFunctionLike(node) && !!node.body
function descendants(node, predicate, skipFunctions = false) {
  const found = []
  const visit = (child) => {
    if (predicate(child)) found.push(child)
    if (skipFunctions && isFunction(child)) return
    ts.forEachChild(child, visit)
  }
  ts.forEachChild(node, visit)
  return found
}
function bindings(pattern, target, trail = []) {
  if (ts.isIdentifier(pattern)) return [{ name: pattern.text, target, trail }]
  if (!ts.isObjectBindingPattern(pattern)) return []
  return pattern.elements.flatMap((element) =>
    element.dotDotDotToken
      ? []
      : bindings(element.name, target, [...trail, nameOf(element.propertyName ?? element.name)])
  )
}
function lookup(name, at) {
  for (let scope = at.parent; scope; scope = scope.parent) {
    if (isFunction(scope)) {
      const param = scope.parameters
        .flatMap((p) => bindings(p.name, p))
        .find((b) => b.name === name)
      if (param) return param
    }
    const statements = ts.isSourceFile(scope) || ts.isBlock(scope) ? scope.statements : undefined
    if (!statements) continue
    for (const statement of statements) {
      if (ts.isFunctionDeclaration(statement) && statement.name?.text === name)
        return { target: statement, trail: [] }
      if (ts.isVariableStatement(statement)) {
        const binding = statement.declarationList.declarations
          .flatMap((d) => bindings(d.name, d))
          .find((b) => b.name === name)
        if (binding) return binding
      }
      if (ts.isImportDeclaration(statement) && statement.importClause) {
        const clause = statement.importClause
        if (clause.name?.text === name) return { target: statement, imported: "default", trail: [] }
        if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
          const entry = clause.namedBindings.elements.find((e) => e.name.text === name)
          if (entry)
            return {
              target: statement,
              imported: (entry.propertyName ?? entry.name).text,
              trail: [],
            }
        }
      }
    }
  }
  return undefined
}
function modulePath(from, specifier, sources) {
  const externalTypes = {
    react: "node_modules/@types/react/index.d.ts",
    "lucide-react": "node_modules/lucide-react/dist/lucide-react.d.ts",
    csstype: "node_modules/csstype/index.d.ts",
  }
  const base = specifier.startsWith(".")
    ? posix.normalize(posix.join(posix.dirname(from), specifier))
    : specifier.startsWith("@/")
      ? specifier.slice(2)
      : specifier.startsWith("@cognia/")
        ? `packages/${specifier.slice(8).split("/")[0]}/src/${specifier.slice(8).split("/").slice(1).join("/") || "index"}`
        : externalTypes[specifier]
  if (!base) return undefined
  return [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.d.ts`,
    `${base}.js`,
    `${base}/index.ts`,
    `${base}/index.tsx`,
    ...(/\.js$/.test(base) ? [base.replace(/\.js$/, ".ts")] : []),
  ].find((p) => sources[p] !== undefined)
}

/** Resolve author signatures only; this creates no diagnostics, build, or emitted files. */
export function inspectJsonTransport(
  catalog,
  sources,
  { asyncIterableResultAdapter = false } = {}
) {
  const lib = `interface Array<T> { [n: number]: T } interface ReadonlyArray<T> { readonly [n: number]: T }
    interface Promise<T> { readonly __matrixValue?: T } interface PromiseLike<T> { readonly __matrixValue?: T }
    interface AsyncIterable<T> { readonly __matrixValue?: T } interface Iterable<T> { readonly __matrixValue?: T }
    type Record<K extends string | number | symbol, T> = { [P in K]: T };
    type Partial<T> = { [P in keyof T]?: T[P] }; type Required<T> = { [P in keyof T]-?: T[P] };
    type Readonly<T> = { readonly [P in keyof T]: T[P] }; type Pick<T, K extends keyof T> = { [P in K]: T[P] };
    type Exclude<T, U> = T extends U ? never : T; type Omit<T, K> = Pick<T, Exclude<keyof T, K>>;
    type NonNullable<T> = T & {}; type ReturnType<T extends (...args: any) => any> = T extends (...args: any) => infer R ? R : any;
    type Parameters<T extends (...args: any) => any> = T extends (...args: infer P) => any ? P : never;
    type Extract<T, U> = T extends U ? T : never; type Awaited<T> = T extends PromiseLike<infer U> ? Awaited<U> : T;`
  const texts = Object.keys(sources).some((path) => path.startsWith("__typescript_lib__/"))
    ? sources
    : { ...sources, "__matrix_lib.d.ts": lib }
  const files = Object.fromEntries(
    Object.entries(texts).map(([path, text]) => [path, parseTs(path, text)])
  )
  const host = {
    getSourceFile: (path) => files[path],
    getDefaultLibFileName: () => "__matrix_lib.d.ts",
    writeFile() {},
    getCurrentDirectory: () => "",
    getDirectories: () => [],
    fileExists: (path) => path in files,
    readFile: (path) => texts[path],
    getCanonicalFileName: (path) => path,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
    resolveModuleNames: (names, from) =>
      names.map((name) => {
        const path = modulePath(from, name, texts)
        return path
          ? {
              resolvedFileName: path,
              extension: path.endsWith(".tsx") ? ts.Extension.Tsx : ts.Extension.Ts,
            }
          : undefined
      }),
  }
  const program = ts.createProgram(
    Object.keys(files),
    { noLib: true, strictNullChecks: true, target: ts.ScriptTarget.Latest },
    host
  )
  const checker = program.getTypeChecker()
  const definitions = Object.values(files).flatMap((sf) =>
    sf.statements.filter((n) => ts.isInterfaceDeclaration(n) || ts.isTypeAliasDeclaration(n))
  )
  const result = {}
  for (const namespace of catalog.apiNamespaces) {
    if (!namespace.type) continue
    const matches = definitions.filter((n) => n.name.text === namespace.type)
    const declaration =
      matches.find((n) => n.getSourceFile().fileName.startsWith("packages/plugin-contract/src/")) ??
      matches[0]
    for (const method of namespace.methods) {
      const info = {
        inputCallbacks: [],
        outputCallbacks: [],
        nonJson: [],
        unresolved: [],
        adapters: [],
      }
      result[method.id] = info
      if (!declaration) {
        info.unresolved.push(`author type ${namespace.type}`)
        continue
      }
      let type = checker.getTypeAtLocation(declaration)
      let location = declaration
      for (const key of method.name.split(".")) {
        type = checker.getNonNullableType(type)
        const property = type.getProperty(key)
        if (!property) {
          type = undefined
          break
        }
        location = property.valueDeclaration ?? property.declarations?.[0] ?? declaration
        type = checker.getTypeOfSymbolAtLocation(property, location)
      }
      if (!type) {
        info.unresolved.push(`author member ${namespace.type}.${method.name}`)
        continue
      }
      const signatures = checker.getNonNullableType(type).getCallSignatures()
      if (!signatures.length) continue // Catalog also contains data properties such as dexie.rawDb.
      const visit = (value, path, side, seen = new Set()) => {
        if (!value || seen.has(value)) return
        if (seen.size >= 5000) {
          info.unresolved.push(`${path}: signature type graph exceeds the 5000-type analysis bound`)
          return
        }
        seen.add(value)
        if (value.intrinsicName === "error") {
          info.unresolved.push(`${path}: unresolved author type ${checker.typeToString(value)}`)
          return
        }
        if (value.isUnionOrIntersection()) {
          for (const part of value.types) visit(part, path, side, seen)
          return
        }
        if (value.getCallSignatures().length || value.getConstructSignatures().length) {
          info[side === "input" ? "inputCallbacks" : "outputCallbacks"].push(path)
          return
        }
        if (value.flags & (ts.TypeFlags.BigIntLike | ts.TypeFlags.ESSymbolLike)) {
          info.nonJson.push(`${path}: ${checker.typeToString(value)}`)
          return
        }
        if (
          value.flags &
          (ts.TypeFlags.Any |
            ts.TypeFlags.Unknown |
            ts.TypeFlags.TypeParameter |
            ts.TypeFlags.StringLike |
            ts.TypeFlags.NumberLike |
            ts.TypeFlags.BooleanLike |
            ts.TypeFlags.Null |
            ts.TypeFlags.Undefined |
            ts.TypeFlags.Void |
            ts.TypeFlags.Never)
        )
          return
        const name = value.symbol?.name ?? value.aliasSymbol?.name
        if (name === "Date" && side === "output") {
          info.adapters.push(`${path}: Date.toJSON emits an ISO string`)
          return
        }
        if (
          [
            "AbortSignal",
            "AbortController",
            "Blob",
            "File",
            "Date",
            "Map",
            "Set",
            "WeakMap",
            "WeakSet",
            "Uint8Array",
            "ArrayBuffer",
            "ReadableStream",
            "Response",
            "Request",
            "OffscreenCanvas",
            "HTMLCanvasElement",
            "CanvasRenderingContext2D",
            "ImageData",
            "ImageBitmap",
            "Node",
            "HTMLElement",
            "Event",
            "EventTarget",
            "Worker",
            "Buffer",
          ].includes(name)
        ) {
          info.nonJson.push(`${path}: ${name}`)
          return
        }
        const arguments_ =
          value.objectFlags & ts.ObjectFlags.Reference ? checker.getTypeArguments(value) : []
        if (
          ["AsyncIterable", "AsyncGenerator", "AsyncIterableIterator"].includes(name) &&
          (side !== "output" || !asyncIterableResultAdapter)
        ) {
          info.nonJson.push(`${path}: ${name} without JSON stream adapter`)
          return
        }
        if (
          ["Promise", "PromiseLike", "Array", "ReadonlyArray"].includes(name) ||
          (side === "output" &&
            ["AsyncIterable", "AsyncGenerator", "AsyncIterableIterator"].includes(name))
        ) {
          for (const argument of arguments_) visit(argument, `${path}[]`, side, seen)
          return
        }
        for (const property of value.getProperties()) {
          const at = property.valueDeclaration ?? property.declarations?.[0] ?? location
          visit(
            checker.getTypeOfSymbolAtLocation(property, at),
            `${path}.${property.name}`,
            side,
            seen
          )
        }
        for (const index of checker.getIndexInfosOfType(value))
          visit(index.type, `${path}[*]`, side, seen)
      }
      for (const signature of signatures) {
        for (const parameter of signature.parameters) {
          const at = parameter.valueDeclaration ?? parameter.declarations?.[0] ?? location
          visit(
            checker.getTypeOfSymbolAtLocation(parameter, at),
            `input.${parameter.name}`,
            "input"
          )
          for (const node of descendants(at, ts.isTypeReferenceNode)) {
            if (
              [
                "AbortSignal",
                "Blob",
                "File",
                "Uint8Array",
                "ArrayBuffer",
                "ReadableStream",
              ].includes(node.typeName.getText())
            )
              info.nonJson.push(`input.${parameter.name}: ${node.typeName.getText()}`)
          }
        }
        visit(checker.getReturnTypeOfSignature(signature), "return", "output")
      }
      for (const key of Object.keys(info)) info[key] = [...new Set(info[key])].sort()
    }
  }
  return result
}
function evidence(node) {
  const sf = node.getSourceFile()
  return `${sf.fileName}:${sf.getLineAndCharacterOfPosition(node.getStart()).line + 1}`
}

/** Static object-shape evaluator. Never searches unrelated object keys or interface declarations. */
export function inspectTypeScript(sources) {
  const files = Object.fromEntries(
    Object.entries(sources).map(([path, text]) => [path, parseTs(path, text)])
  )
  const cache = new Map()
  const unknown = (reason) => ({ kind: "unknown", reason })
  const object = (members = new Map(), incomplete = false) => ({
    kind: "object",
    members,
    incomplete,
  })
  function exported(path, name, seen = new Set()) {
    const sf = files[path]
    const key = `${path}:${name}`
    if (!sf || seen.has(key)) return undefined
    seen.add(key)
    for (const statement of sf.statements) {
      if (ts.isFunctionDeclaration(statement) && statement.name?.text === name) return statement
      if (ts.isVariableStatement(statement)) {
        const decl = statement.declarationList.declarations.find((d) => nameOf(d.name) === name)
        if (decl) return decl.initializer
      }
      if (ts.isExportDeclaration(statement) && statement.moduleSpecifier) {
        const next = modulePath(path, statement.moduleSpecifier.text, sources)
        if (!next || statement.isTypeOnly) continue
        if (!statement.exportClause) {
          const result = exported(next, name, seen)
          if (result) return result
        } else if (ts.isNamedExports(statement.exportClause)) {
          const entry = statement.exportClause.elements.find(
            (e) => e.name.text === name && !e.isTypeOnly
          )
          if (entry) return exported(next, (entry.propertyName ?? entry.name).text, seen)
        }
      }
    }
  }
  function member(shape, name) {
    return shape.kind === "object"
      ? (shape.members.get(name) ??
          unknown(shape.incomplete ? "unresolved object spread" : `missing property ${name}`))
      : unknown(shape.reason ?? `cannot traverse ${name}`)
  }
  function merge(shapes) {
    const result = object()
    for (const shape of shapes) {
      if (shape.kind !== "object") {
        result.incomplete = true
        continue
      }
      result.incomplete ||= shape.incomplete
      for (const [key, value] of shape.members) result.members.set(key, value)
    }
    return result
  }
  function evaluate(input, stack = new Set()) {
    const node = unwrap(input)
    if (!node) return unknown("no initializer")
    if (cache.has(node)) return cache.get(node)
    if (stack.has(node) || stack.size > 60) return unknown("recursive or deep factory")
    const next = new Set(stack).add(node)
    const ev = (value) => evaluate(value, next)
    let result
    if (
      node.kind === ts.SyntaxKind.NullKeyword ||
      (ts.isIdentifier(node) && node.text === "undefined")
    ) {
      result = { kind: "absent", reason: `Explicitly absent member at ${evidence(node)}` }
    } else if (isFunction(node)) result = { kind: "function", node, reason: evidence(node) }
    else if (ts.isObjectLiteralExpression(node)) {
      result = object()
      for (const property of node.properties) {
        if (ts.isSpreadAssignment(property)) result = merge([result, ev(property.expression)])
        else {
          const key = nameOf(property.name)
          if (!key) {
            result.incomplete = true
            continue
          }
          const value = isFunction(property)
            ? { kind: "function", node: property, reason: evidence(property) }
            : ev(ts.isShorthandPropertyAssignment(property) ? property.name : property.initializer)
          result.members.set(key, { ...value, declaredAt: evidence(property) })
        }
      }
    } else if (ts.isIdentifier(node)) {
      const binding = lookup(node.text, node)
      if (binding?.imported) {
        const path = modulePath(
          node.getSourceFile().fileName,
          binding.target.moduleSpecifier.text,
          sources
        )
        result = ev(exported(path, binding.imported))
      } else if (binding) {
        result = ev(
          ts.isVariableDeclaration(binding.target) ? binding.target.initializer : binding.target
        )
        for (const key of binding.trail) result = member(result, key)
      } else result = unknown(`unresolved identifier ${node.text}`)
    } else if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      result = member(
        ev(node.expression),
        ts.isPropertyAccessExpression(node) ? node.name.text : nameOf(node.argumentExpression)
      )
    } else if (ts.isCallExpression(node)) {
      const calleeName = ts.isIdentifier(node.expression)
        ? node.expression.text
        : node.expression.getText()
      const transparent = {
        guardNativeApi: 1,
        createGuardedAPI: 1,
        createApiGuardedAPI: 1,
        withGovernedPluginContext: 0,
        withPluginDisposableScope: 2,
      }
      if (calleeName in transparent) result = ev(node.arguments[transparent[calleeName]])
      else if (calleeName === "debugger_.createDebugContext") result = ev(node.arguments[1])
      else if (calleeName === "Object.assign") result = merge(node.arguments.map(ev))
      else {
        let fn = ev(node.expression)
        if (calleeName === "manager.createPluginServicesAPI") {
          const manager = files["lib/plugin/core/manager.ts"]
          const method =
            manager &&
            descendants(
              manager,
              (n) => ts.isMethodDeclaration(n) && nameOf(n.name) === "createPluginServicesAPI"
            )[0]
          if (method) fn = ev(method)
        }
        if (fn.kind !== "function") result = unknown(`unresolved factory ${calleeName}`)
        else {
          const body = fn.node.body
          const returns = ts.isBlock(body)
            ? descendants(body, ts.isReturnStatement, true)
                .map((r) => r.expression)
                .filter(Boolean)
            : [body]
          const rawShapes = returns.map(ev)
          const shapes = rawShapes.some((shape) => shape.kind !== "denied")
            ? rawShapes.filter((shape) => shape.kind !== "denied")
            : rawShapes
          if (shapes.length === 1) result = shapes[0]
          else if (shapes.length && shapes.every((s) => s.kind === "object")) {
            result = object(
              new Map(shapes[0].members),
              shapes.some((s) => s.incomplete)
            )
            for (const key of result.members.keys())
              if (shapes.some((s) => !s.members.has(key)))
                result.members.set(key, unknown("factory branches differ"))
          } else result = unknown(`factory ${calleeName} has dynamic or divergent returns`)
        }
      }
    } else if (
      ts.isNewExpression(node) &&
      node.expression.getText() === "Proxy" &&
      ts.isObjectLiteralExpression(unwrap(node.arguments?.[0])) &&
      unwrap(node.arguments[0]).properties.length === 0 &&
      descendants(node, ts.isThrowStatement).length > 0
    ) {
      result = {
        kind: "denied",
        reason: "Explicit capability-refusal branch; not a backing implementation.",
      }
    } else if (ts.isConditionalExpression(node)) {
      // Feature-gated availability is recorded in notes, not confused with an absent implementation.
      result =
        node.whenTrue.kind === ts.SyntaxKind.UndefinedKeyword ||
        node.whenTrue.getText() === "undefined"
          ? ev(node.whenFalse)
          : ev(node.whenTrue)
    } else if (
      ts.isBinaryExpression(node) &&
      [ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken].includes(
        node.operatorToken.kind
      )
    ) {
      const left = ev(node.left)
      result = left.kind === "unknown" ? ev(node.right) : left
    } else result = unknown(`dynamic expression at ${evidence(node)}`)
    cache.set(node, result)
    return result
  }
  function refusal(fn, seen = new Set()) {
    if (seen.has(fn)) return undefined
    seen = new Set(seen).add(fn)
    const describe = (node) => {
      const strings = [node, ...descendants(node, ts.isStringLiteralLike)]
        .filter(ts.isStringLiteralLike)
        .map((n) => n.text)
      return strings.length ? [...new Set(strings)].join("; ") : node.getText().slice(0, 180)
    }
    const expression = (input) => {
      const node = unwrap(input)
      if (!node) return undefined
      if (ts.isConditionalExpression(node)) {
        if (node.condition.kind === ts.SyntaxKind.TrueKeyword) return expression(node.whenTrue)
        if (node.condition.kind === ts.SyntaxKind.FalseKeyword) return expression(node.whenFalse)
        const left = expression(node.whenTrue),
          right = expression(node.whenFalse)
        return left && right ? `${left}; ${right}` : undefined
      }
      if (ts.isCallExpression(node)) {
        if (node.expression.getText() === "Promise.reject") return describe(node)
        if (node.expression.getText() === "Promise.resolve") return expression(node.arguments[0])
        const target = evaluate(node.expression)
        if (target.kind === "function") return refusal(target.node, seen)
      }
      if (ts.isObjectLiteralExpression(node)) {
        const properties = node.properties.filter(ts.isPropertyAssignment)
        if (
          properties.some(
            (p) =>
              ["ok", "success", "supported"].includes(nameOf(p.name)) &&
              p.initializer.kind === ts.SyntaxKind.TrueKeyword
          )
        )
          return undefined
        const failure = node.properties.some(
          (p) =>
            ts.isPropertyAssignment(p) &&
            ["ok", "success", "supported"].includes(nameOf(p.name)) &&
            p.initializer.kind === ts.SyntaxKind.FalseKeyword
        )
        const tags = properties.flatMap((p) =>
          nameOf(p.name) === "error" && ts.isObjectLiteralExpression(p.initializer)
            ? p.initializer.properties
            : [p]
        )
        const tagged = tags.some(
          (n) =>
            ts.isPropertyAssignment(n) &&
            ["code", "kind", "status", "reason"].includes(nameOf(n.name)) &&
            ts.isStringLiteralLike(n.initializer) &&
            /^(?:NOT_SUPPORTED|NOT_IMPLEMENTED|UNSUPPORTED(?:_PLATFORM)?|HOST_UNAVAILABLE|UNAVAILABLE|unsupported|not-supported|not-implemented|error|failure|denied)$/i.test(
              n.initializer.text
            )
        )
        if (failure || tagged) return describe(node)
      }
    }
    const terminal = (kind, reason) => ({ kind, reason })
    const statement = (node) => {
      if (ts.isBlock(node)) return sequence(node.statements)
      if (ts.isThrowStatement(node)) return [terminal("refuse", describe(node.expression))]
      if (ts.isReturnStatement(node)) {
        const reason = expression(node.expression)
        return [terminal(reason ? "refuse" : "success", reason)]
      }
      if (ts.isIfStatement(node)) {
        if (node.expression.kind === ts.SyntaxKind.TrueKeyword) return statement(node.thenStatement)
        if (node.expression.kind === ts.SyntaxKind.FalseKeyword)
          return node.elseStatement ? statement(node.elseStatement) : [terminal("fall")]
        return [
          ...statement(node.thenStatement),
          ...(node.elseStatement ? statement(node.elseStatement) : [terminal("fall")]),
        ]
      }
      if (ts.isSwitchStatement(node))
        return [
          ...node.caseBlock.clauses.flatMap((clause) => sequence(clause.statements)),
          ...(!node.caseBlock.clauses.some(ts.isDefaultClause) ? [terminal("fall")] : []),
        ]
      if (ts.isTryStatement(node)) {
        let outcomes = statement(node.tryBlock)
        if (node.catchClause && outcomes.some((o) => o.kind === "refuse"))
          outcomes = [
            ...outcomes.filter((o) => o.kind !== "refuse"),
            ...statement(node.catchClause.block),
          ]
        if (node.finallyBlock) {
          const final = statement(node.finallyBlock)
          outcomes = [
            ...final.filter((o) => o.kind !== "fall"),
            ...(final.some((o) => o.kind === "fall") ? outcomes : []),
          ]
        }
        return outcomes
      }
      if (ts.isExpressionStatement(node)) {
        const reason = expression(node.expression)
        if (reason) return [terminal("refuse", reason)]
      }
      return [terminal("fall")]
    }
    const sequence = (statements) => {
      let outcomes = [terminal("fall")]
      for (const node of statements) {
        if (!outcomes.some((o) => o.kind === "fall")) break
        outcomes = [...outcomes.filter((o) => o.kind !== "fall"), ...statement(node)]
      }
      return outcomes
    }
    const outcomes = ts.isBlock(fn.body)
      ? sequence(fn.body.statements)
      : [terminal(expression(fn.body) ? "refuse" : "success", expression(fn.body))]
    return outcomes.length && outcomes.every((o) => o.kind === "refuse")
      ? [...new Set(outcomes.map((o) => o.reason))].join("; ")
      : undefined
  }
  const sf = files[PATHS.context]
  let mounted = unknown("context module missing")
  if (sf) {
    const full = sf.statements.find(
      (s) => ts.isFunctionDeclaration(s) && s.name?.text === "createFullPluginContext"
    )
    const fn =
      full ??
      sf.statements.find(
        (s) => ts.isFunctionDeclaration(s) && s.name?.text === "createPluginContext"
      )
    if (fn?.body) {
      const fullObject = descendants(
        fn.body,
        (n) => ts.isVariableDeclaration(n) && nameOf(n.name) === "fullContext",
        true
      )[0]
      if (fullObject) mounted = evaluate(fullObject.initializer)
      else {
        const returned = descendants(fn.body, ts.isReturnStatement, true).at(-1)
        mounted = evaluate(returned?.expression)
      }
    }
  }
  return (namespace, method) => {
    let shape = mounted
    for (const key of namespace.factory
      .replace(/^context\.?/, "")
      .split(".")
      .filter(Boolean))
      shape = member(shape, key)
    for (const key of method.name.split(".")) {
      if (shape.kind === "object" && !shape.members.has(key) && !shape.incomplete)
        return { value: "no", reason: `Mounted ${namespace.factory} lacks ${method.name}.` }
      shape = member(shape, key)
    }
    if (shape.kind === "absent" || shape.kind === "denied")
      return { value: "no", reason: shape.reason }
    if (shape.kind === "function") {
      const reason = refusal(shape.node)
      if (reason)
        return {
          value: "no",
          reason: `Always refuses at ${shape.declaredAt ?? evidence(shape.node)}: ${reason}.`,
          refusal: reason,
        }
    }
    if (
      shape.kind !== "unknown" ||
      (shape.declaredAt && !shape.reason?.includes("branches differ"))
    ) {
      return {
        value: "yes",
        reason: `Mounted factory member at ${shape.declaredAt ?? shape.reason}.`,
      }
    }
    return { value: "unclear", reason: `${namespace.factory}.${method.name}: ${shape.reason}.` }
  }
}

export function classifyLayer(namespace, method, overrides = {}) {
  const override = overrides[method.id]
  if (override) {
    if (!["host", "ui", "both"].includes(override.layer) || !override.reason?.trim())
      throw new Error(`Invalid layer/reason for ${method.id}`)
    return { layer: override.layer, layerReason: override.reason }
  }
  for (const rule of LAYER_RULES.methodRules) {
    if (rule.namespaces.includes(namespace.id) && new RegExp(rule.method).test(method.name))
      return { layer: rule.layer, layerReason: rule.reason }
  }
  const layer = LAYER_RULES.ui.includes(namespace.id)
    ? "ui"
    : LAYER_RULES.host.includes(namespace.id)
      ? "host"
      : undefined
  if (!layer)
    throw new Error(`Unclassified namespace ${namespace.id}; add an explicit namespace rule.`)
  const registration = LAYER_RULES.uiResourceRegistration
  if (
    layer === "ui" &&
    new RegExp(registration.method).test(method.name) &&
    registration.effects.includes(method.resourceEffect?.kind)
  ) {
    return { layer: "both", layerReason: registration.reason }
  }
  return { layer, layerReason: "" }
}

export function parseWit(source) {
  const text = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "")
  const imports = new Set([...text.matchAll(/\bimport\s+([\w-]+)\s*;/g)].map((m) => m[1]))
  const camel = (value) => value.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())
  const ids = new Set()
  // Balanced braces: interfaces contain nested enum/record bodies.
  for (const match of text.matchAll(/\binterface\s+([\w-]+)\s*\{/g)) {
    if (!imports.has(match[1])) continue
    let end = match.index + match[0].length,
      depth = 1
    for (; end < text.length && depth; end++)
      depth += text[end] === "{" ? 1 : text[end] === "}" ? -1 : 0
    const body = text.slice(match.index + match[0].length, end - 1)
    for (const fn of body.matchAll(/\b([\w-]+)\s*:\s*func\s*\(/g)) {
      const id = `${camel(match[1])}.${camel(fn[1])}`
      ids.add(id)
      for (const alias of WIT_ALIASES[id] ?? []) ids.add(alias)
    }
  }
  return ids
}

// Python's stdlib AST avoids matching comments/strings and gives lexical aliases.
// Parse only: no plugin imports, eval, or execution. literal_eval reads the SDK data mirror.
const PYTHON_AST = String.raw`
import ast, json, sys
payload = json.load(sys.stdin)
trees = {p: ast.parse(s, filename=p) for p, s in payload.items()}
calls = []
def bind_names(target):
    if isinstance(target, ast.Name): return [target.id]
    if isinstance(target, (ast.Tuple, ast.List)): return [n for e in target.elts for n in bind_names(e)]
    return []
def path_of(node, scopes):
    if isinstance(node, ast.Name):
        for scope in reversed(scopes):
            if node.id in scope: return scope[node.id]
        return ['ctx'] if node.id in ('ctx', 'context') else [node.id] if node.id == 'cognia' else None
    if isinstance(node, ast.Attribute):
        base = path_of(node.value, scopes)
        return base + [node.attr] if base else None
    return None
class Visitor(ast.NodeVisitor):
    def __init__(self, path): self.path, self.scopes = path, [{}]
    def visit_ImportFrom(self, node):
        if node.module in ('cognia', 'cognia.ctx'):
            for a in node.names:
                if a.name == 'ctx': self.scopes[-1][a.asname or a.name] = ['ctx']
    def visit_Assign(self, node):
        self.visit(node.value)
        path = path_of(node.value, self.scopes)
        for target in node.targets:
            for name in bind_names(target): self.scopes[-1][name] = path
    def visit_AnnAssign(self, node):
        if node.value: self.visit(node.value)
        for name in bind_names(node.target): self.scopes[-1][name] = path_of(node.value, self.scopes)
    def visit_FunctionDef(self, node):
        # Python assigns function-local names for the whole scope, even before assignment.
        local = {}
        def assigned(n):
            if n is not node and isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef, ast.Lambda)): return
            if isinstance(n, ast.Name) and isinstance(n.ctx, ast.Store): local[n.id] = None
            for child in ast.iter_child_nodes(n): assigned(child)
        assigned(node)
        for a in node.args.posonlyargs + node.args.args + node.args.kwonlyargs:
            local[a.arg] = ['ctx'] if a.arg in ('ctx', 'context') else None
        self.scopes.append(local)
        for stmt in node.body: self.visit(stmt)
        self.scopes.pop()
    visit_AsyncFunctionDef = visit_FunctionDef
    def visit_Call(self, node):
        path = path_of(node.func, self.scopes)
        if path and path[:2] == ['cognia', 'ctx']: path = path[1:]
        if path and path[0] == 'ctx':
            calls.append(dict(path=self.path, segments=path[1:], line=node.lineno, column=node.col_offset + 1, execution='host', executionReason='Python process executes on the plugin host.'))
        self.generic_visit(node)
for path, tree in trees.items():
    if path.startswith('plugins/'): Visitor(path).visit(tree)

ctx_path = 'plugin-sdk/python/src/cognia/ctx.py'
ctx = trees.get(ctx_path)
mirror = trees.get('plugin-sdk/python/src/cognia/_generated_contract.py')
exposed, refused = set(), set()
if ctx:
    names = {n.id for n in ast.walk(ctx) if isinstance(n, ast.Name)}
    classes = {n.name: n for n in ctx.body if isinstance(n, ast.ClassDef)}
    attrs = {n.attr for n in ast.walk(ctx) if isinstance(n, ast.Attribute)}
    strings = {n.value for n in ast.walk(ctx) if isinstance(n, ast.Constant) and isinstance(n.value, str)}
    proxy_classes = all(name in classes and any(isinstance(n, ast.FunctionDef) and n.name == '__getattr__' for n in classes[name].body) for name in ('Ctx', 'HostNamespace'))
    if 'API_NAMESPACE_CONTRACTS' in names and '_python_namespaces' in names and proxy_classes and 'host_call' in attrs and mirror:
        entries = []
        for n in mirror.body:
            if isinstance(n, ast.Assign) and any(isinstance(t, ast.Name) and t.id == 'API_NAMESPACE_CONTRACTS' for t in n.targets):
                entries = ast.literal_eval(n.value)
        for ns in entries:
            if 'python' not in ns.get('runtimes', []): continue
            for method in ns.get('methods', []):
                if 'python' not in method.get('runtimes', ns['runtimes']): continue
                key = ns['id'] + '.' + method['name']
                exposed.add(key)
                if method.get('resourceEffect', {}).get('kind') == 'returned-disposer' and 'returned-disposer' in strings: refused.add(key)
    else:
        # Explicit class-based SDKs, including delegated sibling namespace modules.
        for path, tree in trees.items():
            if path.startswith('plugin-sdk/python/src/cognia/'):
                classes.update({n.name: n for n in tree.body if isinstance(n, ast.ClassDef)})
        def shape(class_name, prefix='', seen=None):
            seen = (seen or set()) | {class_name}
            cls = classes.get(class_name)
            if not cls: return
            for n in cls.body:
                if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)) and not n.name.startswith('_') and prefix:
                    exposed.add(prefix + '.' + n.name)
            for n in ast.walk(cls):
                if isinstance(n, (ast.Assign, ast.AnnAssign)) and isinstance(n.value, ast.Call) and isinstance(n.value.func, ast.Name):
                    for target in n.targets if isinstance(n, ast.Assign) else [n.target]:
                        if isinstance(target, ast.Attribute) and isinstance(target.value, ast.Name) and target.value.id == 'self' and n.value.func.id not in seen:
                            shape(n.value.func.id, (prefix + '.' if prefix else '') + target.attr, seen)
        shape('Ctx')
print(json.dumps(dict(calls=calls, exposed=sorted(exposed), refused=sorted(refused))))
`
function pythonAst(sources) {
  if (!Object.keys(sources).length) return { calls: [], exposed: [], refused: [] }
  const run = spawnSync("python3", ["-c", PYTHON_AST], {
    input: JSON.stringify(sources),
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  })
  if (run.status !== 0)
    throw new Error(`Python AST parser failed: ${run.error?.message ?? run.stderr}`)
  return JSON.parse(run.stdout)
}

// Value provenance and execution edges are separate: passing/storing a function
// moves a value, whereas only a call or a declared execution contract runs it.
function tsPluginCalls(sources, plugin) {
  const files = Object.fromEntries(Object.entries(sources).map(([p, s]) => [p, parseTs(p, s)]))
  const all = Object.values(files).flatMap((sf) => descendants(sf, () => true))
  const nodeIds = new Map(all.map((node, index) => [node, index]))
  const nodes = all
  const token = (kind, node) => `${kind}:${nodeIds.get(node)}`
  const nodeFor = (value) => nodes[Number(value.slice(2))]
  const nearest = (node) => {
    for (let n = node.parent; n; n = n.parent) if (isFunction(n)) return n
  }
  const callNodes = all.filter(ts.isCallExpression)
  const assignments = all.filter(
    (n) =>
      ts.isBinaryExpression(n) &&
      n.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(n.left)
  )
  const parameters = new Map(),
    functions = new Map(),
    edges = new Map(),
    escaped = new Set()
  const merge = (...sets) => new Set(sets.flatMap((set) => [...set]))
  const returns = (fn) =>
    ts.isBlock(fn.body)
      ? descendants(fn.body, ts.isReturnStatement, true)
          .map((r) => r.expression)
          .filter(Boolean)
      : [fn.body]
  const rootType = (node) => /\b(?:Full)?Plugin(?:Base)?Context\b/.test(node.type?.getText() ?? "")
  const propertyOf = (fn) =>
    nameOf(fn.name) ??
    (ts.isPropertyAssignment(fn.parent) || ts.isVariableDeclaration(fn.parent)
      ? nameOf(fn.parent.name)
      : undefined)
  for (const fn of all.filter(isFunction)) {
    const property = propertyOf(fn)
    const jsx =
      descendants(
        fn.body,
        (n) => ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n) || ts.isJsxFragment(n),
        true
      ).length > 0
    const jsxCallback = ts.isJsxExpression(fn.parent) && ts.isJsxAttribute(fn.parent.parent)
    const client = jsx || jsxCallback || PLACEMENT_RULES.clientProperties.includes(property)
    const host = ["activate", "deactivate"].includes(property)
    functions.set(fn, {
      placements: new Set(client ? ["client"] : host ? ["host"] : []),
      reason: client
        ? "Rendered JSX/view callback."
        : host
          ? "Plugin activation/deactivation entry point."
          : undefined,
    })
    for (const [i, parameter] of fn.parameters.entries()) {
      if (rootType(parameter) || (host && i === 0)) parameters.set(parameter, new Set(["p:"]))
    }
  }
  function exported(path, name, seen = new Set()) {
    const sf = files[path],
      key = `${path}:${name}`
    if (!sf || seen.has(key)) return undefined
    seen = new Set(seen).add(key)
    for (const statement of sf.statements) {
      if (
        ts.isFunctionDeclaration(statement) &&
        (statement.name?.text === name ||
          (name === "default" &&
            statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword)))
      )
        return statement
      if (ts.isExportAssignment(statement) && name === "default") return statement.expression
      if (ts.isVariableStatement(statement)) {
        const decl = statement.declarationList.declarations.find((d) => nameOf(d.name) === name)
        if (decl) return decl.initializer
      }
      if (ts.isExportDeclaration(statement) && statement.moduleSpecifier && !statement.isTypeOnly) {
        const next = modulePath(path, statement.moduleSpecifier.text, sources)
        if (!statement.exportClause) {
          const found = exported(next, name, seen)
          if (found) return found
        } else if (ts.isNamedExports(statement.exportClause)) {
          const entry = statement.exportClause.elements.find(
            (e) => e.name.text === name && !e.isTypeOnly
          )
          if (entry) return exported(next, (entry.propertyName ?? entry.name).text, seen)
        }
      }
    }
  }
  let memo = new Map()
  function member(values, key, seen, visited = new Set()) {
    const found = new Set()
    for (const value of values) {
      if (/^[pu]:/.test(value)) {
        const path = value.slice(2)
        if (path.split(".").length < 12) found.add(`${value[0]}:${path ? `${path}.` : ""}${key}`)
      } else if (value.startsWith("o:")) {
        const visitKey = `${value}:${key}`
        if (visited.has(visitKey)) {
          found.add(`u:${key}`)
          continue
        }
        const nextVisited = new Set(visited).add(visitKey)
        const object = nodeFor(value)
        if (ts.isArrayLiteralExpression(object)) {
          for (const item of object.elements)
            for (const result of evaluate(item, seen)) found.add(result)
        } else
          for (const property of object.properties) {
            const values_ = ts.isSpreadAssignment(property)
              ? member(evaluate(property.expression, seen), key, seen, nextVisited)
              : nameOf(property.name) === key
                ? evaluate(
                    isFunction(property)
                      ? property
                      : ts.isShorthandPropertyAssignment(property)
                        ? property.name
                        : property.initializer,
                    seen
                  )
                : []
            for (const result of values_) found.add(result)
          }
      }
    }
    return found
  }
  function evaluate(input, seen = new Set()) {
    const node = unwrap(input)
    if (!node || seen.has(node) || seen.size > 80) return new Set()
    if (memo.has(node)) return memo.get(node)
    seen = new Set(seen).add(node)
    const ev = (n) => evaluate(n, seen)
    let result = new Set()
    if (isFunction(node)) result.add(token("f", node))
    else if (ts.isObjectLiteralExpression(node) || ts.isArrayLiteralExpression(node))
      result.add(token("o", node))
    else if (ts.isIdentifier(node)) {
      const binding = lookup(node.text, node)
      if (binding?.imported) {
        result = ev(
          exported(
            modulePath(node.getSourceFile().fileName, binding.target.moduleSpecifier.text, sources),
            binding.imported
          )
        )
      } else if (binding && ts.isVariableDeclaration(binding.target)) {
        const declaration = binding.target
        const relevant = assignments.filter(
          (a) =>
            a.left.text === node.text &&
            lookup(a.left.text, a.left)?.target === declaration &&
            (nearest(a) !== nearest(node) || a.pos < node.pos)
        )
        // Same-scope sequential reassignment replaces the alias. Assignments
        // from another function are a points-to union; their order is unknown.
        const local = relevant.filter((a) => nearest(a) === nearest(node)).at(-1)
        result = local
          ? ev(local.right)
          : merge(ev(declaration.initializer), ...relevant.map((a) => ev(a.right)))
        if (!result.size && !declaration.initializer)
          result.add(rootType(declaration) ? "p:" : "u:")
        for (const key of binding.trail) result = member(result, key, seen)
      } else if (binding && ts.isParameter(binding.target)) {
        result = new Set(
          parameters.get(binding.target) ??
            (["ctx", "context"].includes(node.text) ? ["p:"] : ["u:"])
        )
        for (const key of binding.trail) result = member(result, key, seen)
      } else if (binding && isFunction(binding.target)) result.add(token("f", binding.target))
      else if (!binding) result.add(["ctx", "context"].includes(node.text) ? "p:" : "u:")
    } else if (node.kind === ts.SyntaxKind.ThisKeyword) result.add("u:")
    else if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const key = ts.isPropertyAccessExpression(node)
        ? node.name.text
        : nameOf(node.argumentExpression)
      if (key) result = member(ev(node.expression), key, seen)
    } else if (ts.isCallExpression(node)) {
      if (
        ts.isIdentifier(node.expression) &&
        ["definePlugin", "definePluginTool", "definePluginManifest"].includes(node.expression.text)
      )
        result = ev(node.arguments[0])
      else {
        for (const callee of ev(node.expression))
          if (callee.startsWith("f:")) {
            for (const returned of returns(nodeFor(callee))) result = merge(result, ev(returned))
          }
        if (!result.size) result.add("u:")
      }
    } else if (ts.isConditionalExpression(node))
      result = merge(ev(node.whenTrue), ev(node.whenFalse))
    else if (
      ts.isBinaryExpression(node) &&
      [
        ts.SyntaxKind.QuestionQuestionToken,
        ts.SyntaxKind.BarBarToken,
        ts.SyntaxKind.AmpersandAmpersandToken,
      ].includes(node.operatorToken.kind)
    )
      result = merge(ev(node.left), ev(node.right))
    memo.set(node, result)
    return result
  }
  // Finite points-to fixed point. Context path depth is bounded above to make
  // even recursive namespace forwarding converge without silently truncating rounds.
  function relevantValue(value, seen = new Set()) {
    if (/^[pf]:/.test(value)) return true
    if (!value.startsWith("o:") || seen.has(value)) return false
    seen = new Set(seen).add(value)
    const node = nodeFor(value)
    const children = ts.isArrayLiteralExpression(node)
      ? node.elements
      : node.properties.map((p) =>
          isFunction(p)
            ? p
            : ts.isSpreadAssignment(p)
              ? p.expression
              : ts.isShorthandPropertyAssignment(p)
                ? p.name
                : p.initializer
        )
    return children.some((child) => [...evaluate(child)].some((v) => relevantValue(v, seen)))
  }
  for (let changed = true, round = 0; changed;) {
    if (++round > 200) throw new Error(`Context propagation did not converge for ${plugin}`)
    changed = false
    memo = new Map()
    for (const call of callNodes)
      for (const target of evaluate(call.expression))
        if (target.startsWith("f:")) {
          const fn = nodeFor(target)
          for (const [i, parameter] of fn.parameters.entries()) {
            const current = parameters.get(parameter) ?? new Set()
            for (const value of evaluate(call.arguments[i]))
              if (!current.has(value) && relevantValue(value)) {
                current.add(value)
                changed = true
              }
            parameters.set(parameter, current)
          }
        }
  }
  memo = new Map()
  const addEdge = (from, to, reason) => {
    if (!from || !to) return
    if (!edges.has(from)) edges.set(from, new Map())
    edges.get(from).set(to, reason)
  }
  function functionValues(values, seen = new Set()) {
    const found = new Set()
    for (const value of values) {
      if (value.startsWith("f:")) found.add(nodeFor(value))
      else if (value.startsWith("o:") && !seen.has(value)) {
        const object = nodeFor(value),
          next = new Set(seen).add(value)
        const children = ts.isArrayLiteralExpression(object)
          ? object.elements
          : object.properties.map((p) =>
              isFunction(p)
                ? p
                : ts.isSpreadAssignment(p)
                  ? p.expression
                  : ts.isShorthandPropertyAssignment(p)
                    ? p.name
                    : p.initializer
            )
        for (const child of children)
          for (const fn of functionValues(evaluate(child), next)) found.add(fn)
      }
    }
    return found
  }
  function contributionCallbacks(values, from) {
    for (const value of values)
      if (value.startsWith("o:") && ts.isObjectLiteralExpression(nodeFor(value))) {
        const object = nodeFor(value)
        for (const property of object.properties) {
          const name = nameOf(property.name)
          const contents = evaluate(isFunction(property) ? property : property.initializer)
          if (
            /^on[A-Z]/.test(name ?? "") &&
            !/^on(?:Click|Change|Submit|Key|Mouse|Focus|Blur)/.test(name)
          ) {
            for (const fn of functionValues(contents))
              addEdge(from, fn, "Declared plugin lifecycle/hook execution contract.")
          }
          if (PLACEMENT_RULES.hostContainers.includes(name)) {
            for (const fn of functionValues(contents))
              if (!functions.get(fn)?.placements.has("client"))
                addEdge(from, fn, "Declared tool/hook/interceptor contribution execution contract.")
          }
        }
      }
  }
  for (const [fn, meta] of functions)
    if (meta.placements.has("host") && ["activate", "deactivate"].includes(propertyOf(fn))) {
      for (const returned of returns(fn)) contributionCallbacks(evaluate(returned), fn)
    }
  for (const call of callNodes) {
    const owner = nearest(call)
    for (const target of evaluate(call.expression))
      if (target.startsWith("f:"))
        addEdge(owner, nodeFor(target), "Actual local/imported function call.")
    const paths = [...evaluate(call.expression)]
      .filter((v) => v.startsWith("p:"))
      .map((v) => v.slice(2))
    const registration = paths.some((p) => PLACEMENT_RULES.callbackApis.includes(p))
    const builtin =
      (ts.isIdentifier(call.expression) &&
        ["setTimeout", "setInterval", "queueMicrotask"].includes(call.expression.text)) ||
      (ts.isPropertyAccessExpression(call.expression) &&
        PLACEMENT_RULES.standardCallbacks.includes(call.expression.name.text))
    if (registration || builtin)
      for (const argument of call.arguments)
        for (const fn of functionValues(evaluate(argument))) {
          addEdge(
            owner,
            fn,
            registration
              ? "Known host callback API execution contract."
              : "Standard callback-execution contract."
          )
        }
    if (ts.isIdentifier(call.expression) && call.expression.text === "definePlugin") {
      // Static plugin contributions have a real SDK execution contract too.
      for (const value of evaluate(call.arguments[0]))
        if (value.startsWith("o:")) {
          for (const property of nodeFor(value).properties)
            if (PLACEMENT_RULES.hostContainers.includes(nameOf(property.name))) {
              for (const fn of functionValues(evaluate(property.initializer)))
                if (!functions.get(fn)?.placements.has("client")) {
                  functions.get(fn)?.placements.add("host")
                  if (functions.has(fn))
                    functions.get(fn).reason = "Declared plugin contribution execution contract."
                }
            }
        }
    }
  }
  // Moving a nested function into a module slot does not execute it. A view
  // may later call it, but that escape is not proof of host execution.
  for (const assignment of assignments) {
    const declaration = lookup(assignment.left.text, assignment.left)?.target
    if (declaration && !nearest(declaration))
      for (const fn of functionValues(evaluate(assignment.right))) if (nearest(fn)) escaped.add(fn)
  }
  for (let changed = true; changed;) {
    changed = false
    for (const [from, targets] of edges)
      for (const [to, reason] of targets) {
        const source = functions.get(from),
          target = functions.get(to)
        if (!source || !target) continue
        for (const placement of source.placements)
          if (!target.placements.has(placement)) {
            target.placements.add(placement)
            target.reason = reason
            changed = true
          }
      }
  }
  return callNodes.flatMap((call) => {
    const owner = nearest(call),
      meta = functions.get(owner)
    const execution = meta?.placements.has("host")
      ? "host"
      : escaped.has(owner)
        ? "unclear"
        : meta?.placements.has("client")
          ? "client"
          : "unclear"
    const sf = call.getSourceFile(),
      position = sf.getLineAndCharacterOfPosition(call.getStart())
    return [...evaluate(call.expression)]
      .filter((value) => /^[pu]:/.test(value) && value.slice(2))
      .map((value) => ({
        segments: value.slice(2).split("."),
        path: sf.fileName,
        line: position.line + 1,
        column: position.character + 1,
        plugin,
        contextResolution: value.startsWith("p:") ? "known" : "unknown",
        execution,
        executionReason:
          escaped.has(owner) && execution === "unclear"
            ? "Closure stored outside its defining scope; no proven host execution."
            : (meta?.reason ??
              "No actual call or known callback-execution contract establishes placement."),
      }))
  })
}

export function scanPluginSources(root, catalog) {
  const methodPaths = new Map(
    catalog.apiNamespaces.flatMap((ns) =>
      ns.methods.map((m) => [`${ns.authorPath.replace(/^ctx\./, "")}.${m.name}`, m.id])
    )
  )
  const all = walk(root, "plugins")
  const manifests = all.filter((path) => path.endsWith("/plugin.json"))
  const calls = []
  for (const path of manifests) {
    const manifest = JSON.parse(readSource(root, path))
    if (!manifest.id) throw new Error(`Missing plugin id: ${path}`)
    const directory = posix.dirname(path)
    const files = all.filter(
      (file) =>
        file.startsWith(`${directory}/`) &&
        isSource(file) &&
        !manifests.some(
          (other) =>
            other !== path &&
            posix.dirname(other).startsWith(`${directory}/`) &&
            file.startsWith(`${posix.dirname(other)}/`)
        )
    )
    const sources = Object.fromEntries(files.map((file) => [file, readSource(root, file)]))
    const typescript = Object.fromEntries(
      Object.entries(sources).filter(([file]) => !file.endsWith(".py"))
    )
    const python = Object.fromEntries(
      Object.entries(sources).filter(([file]) => file.endsWith(".py"))
    )
    const found = [
      ...tsPluginCalls(typescript, manifest.id),
      ...pythonAst(python).calls.map((call) => ({
        ...call,
        plugin: manifest.id,
        contextResolution: "known",
      })),
    ]
    const unique = new Map()
    for (const call of found) {
      const path = call.segments.join(".")
      const id =
        methodPaths.get(path) ??
        (call.contextResolution === "unknown"
          ? [...methodPaths].find(([methodPath]) => path.endsWith(`.${methodPath}`))?.[1]
          : undefined)
      if (id) {
        const key = `${call.path}:${call.line}:${call.column}:${id}`
        if (!unique.has(key) || call.contextResolution === "known") {
          const { segments, ...site } = call
          unique.set(key, { id, ...site })
        }
      }
    }
    calls.push(...unique.values())
  }
  return calls.sort(
    (a, b) => a.path.localeCompare(b.path, "en") || a.line - b.line || a.column - b.column
  )
}

function pythonCoverage(root, catalog, tsSources) {
  const sdkFiles = walk(root, "plugin-sdk/python/src/cognia").filter((p) => isSource(p))
  const python = pythonAst(Object.fromEntries(sdkFiles.map((p) => [p, readSource(root, p)])))
  const routerSource = tsSources[PATHS.router] ?? ""
  const router = parseTs(PATHS.router, routerSource)
  const identifiers = new Set(descendants(router, ts.isIdentifier).map((n) => n.text))
  const strings = new Set(descendants(router, ts.isStringLiteralLike).map((n) => n.text))
  const dynamic =
    identifiers.has("PLUGIN_API_NAMESPACE_CONTRACTS") &&
    identifiers.has("getContext") &&
    identifiers.has("holder") &&
    descendants(
      router,
      (n) =>
        ts.isCallExpression(n) &&
        ts.isPropertyAccessExpression(n.expression) &&
        n.expression.name.text === "apply"
    ).length > 0
  const ids = catalog.apiNamespaces.flatMap((ns) => ns.methods.map((m) => m.id))
  const cases = new Set(descendants(router, ts.isCaseClause).map((n) => nameOf(n.expression)))
  const routed = dynamic ? ids : ids.filter((id) => cases.has(id))
  const refused = new Set(python.refused)
  if (dynamic && strings.has("returned-disposer")) {
    for (const ns of catalog.apiNamespaces)
      for (const m of ns.methods)
        if (m.resourceEffect?.kind === "returned-disposer") refused.add(m.id)
  }
  return {
    ...python,
    routed,
    refused: [...refused],
    transport: inspectJsonTransport(catalog, tsSources, {
      asyncIterableResultAdapter: identifiers.has("collapseAsyncIterable"),
    }),
  }
}

/** Pure row construction: all source discovery/parsing results are explicit inputs. */
export function buildMatrix({
  catalog,
  tsProvider = () => ({ value: "unclear", reason: "No host source evidence." }),
  python = {},
  currentWit = new Set(),
  frozenWit = new Set(),
  calls = [],
  overrides = {},
}) {
  const known = new Set(catalog.apiNamespaces.flatMap((ns) => ns.methods.map((m) => m.id)))
  if (known.size !== catalog.apiNamespaces.reduce((s, ns) => s + ns.methods.length, 0))
    throw new Error("Duplicate method id")
  for (const id of Object.keys(overrides))
    if (!known.has(id)) throw new Error(`Stale layer override: ${id}`)
  const exposed = new Set(python.exposed),
    routed = new Set(python.routed),
    refused = new Set(python.refused)
  return catalog.apiNamespaces.flatMap((namespace) =>
    namespace.methods.map((method) => {
      const tsResult = tsProvider(namespace, method)
      const runtimes = method.runtimes ?? namespace.runtimes
      const sites = calls
        .filter((call) => call.id === method.id && call.contextResolution !== "unknown")
        .map(({ id, ...call }) => call)
      const unknownSites = calls
        .filter((call) => call.id === method.id && call.contextResolution === "unknown")
        .map(({ id, ...call }) => call)
      const layer = classifyLayer(namespace, method, overrides)
      const transport = python.transport?.[method.id]
      const transportIssues = transport
        ? [
            ...transport.inputCallbacks.map((p) => `callback ${p}`),
            ...transport.outputCallbacks.map((p) => `callable ${p}`),
            ...transport.nonJson,
            ...transport.unresolved,
          ]
        : []
      let providedPython = "n/a",
        pyNote = ""
      if (runtimes.includes("python")) {
        if (refused.has(method.id)) {
          providedPython = "no"
          pyNote = "Python SDK/router explicitly refuses callback registration across NDJSON."
        } else if (transportIssues.length) {
          providedPython = "declared-only"
          pyNote =
            transport.unresolved.length &&
            !transport.inputCallbacks.length &&
            !transport.outputCallbacks.length &&
            !transport.nonJson.length
              ? `Python JSON transport is unverified: ${transport.unresolved.join(", ")}.`
              : `No Python SDK/host-router JSON callback/value adapter for ${transportIssues.join(", ")}.`
        } else if (exposed.has(method.id) && routed.has(method.id) && tsResult.value === "yes")
          providedPython = "yes"
        else {
          providedPython = "declared-only"
          pyNote = `Python declared; missing verified ${[!exposed.has(method.id) && "SDK exposure", !routed.has(method.id) && "host route", tsResult.value !== "yes" && "TS backing member"].filter(Boolean).join(", ")}.`
        }
      }
      const isUi = layer.layer !== "host"
      const hostSideUiCall = !isUi
        ? false
        : sites.some((s) => s.execution === "host")
          ? true
          : unknownSites.length || sites.some((s) => s.execution === "unclear")
            ? "unclear"
            : false
      return {
        id: method.id,
        namespace: namespace.id,
        authorPath: namespace.authorPath,
        method: method.name,
        stability: method.stability ?? namespace.stability,
        enforcement: method.enforcement ?? namespace.enforcement,
        risk: method.risk,
        consentTier: method.consentTier,
        requiredPermissions: method.requiredPermissions,
        headless: namespace.platforms.includes("headless"),
        runtimesDeclared: runtimes,
        providedTs: tsResult.value,
        providedPython,
        providedWasm: currentWit.has(method.id) ? "yes" : "no",
        tsRefusal: tsResult.refusal ?? null,
        jsonTransport: transport ?? null,
        frozenWasm: frozenWit.has(method.id) ? "yes" : "no",
        ...layer,
        firstPartyCallers: sites.length,
        firstPartyPlugins: [...new Set(sites.map((s) => s.plugin))].sort(),
        firstPartyUnknownCallers: unknownSites.length,
        firstPartyUnknownPlugins: [...new Set(unknownSites.map((s) => s.plugin))].sort(),
        hostSideUiCall,
        notes: [
          tsResult.reason,
          pyNote,
          hostSideUiCall === "unclear" &&
            "UI callers have unresolved context provenance or execution placement.",
        ].filter(Boolean),
        firstPartyCallSites: sites,
        firstPartyUnknownCallSites: unknownSites,
      }
    })
  )
}

export function summarize(rows) {
  const enums = {
    layer: ["host", "ui", "both"],
    providedTs: ["yes", "no", "unclear"],
    providedPython: ["yes", "no", "declared-only", "n/a"],
    providedWasm: ["yes", "no"],
    frozenWasm: ["yes", "no"],
    hostSideUiCall: ["true", "false", "unclear"],
  }
  const values = (key) =>
    Object.fromEntries(
      (enums[key] ?? [...new Set(rows.map((r) => String(r[key])))].sort()).map((v) => [
        v,
        rows.filter((r) => String(r[key]) === v).length,
      ])
    )
  return {
    methodsTotal: rows.length,
    layers: values("layer"),
    headlessDeclared: rows.filter((r) => r.headless).length,
    providedTs: values("providedTs"),
    providedPython: values("providedPython"),
    providedWasm: values("providedWasm"),
    frozenWasm: values("frozenWasm"),
    methodsWithCallers: rows.filter((r) => r.firstPartyCallers > 0).length,
    methodsWithoutCallers: rows.filter((r) => r.firstPartyCallers === 0).length,
    firstPartyCallSites: rows.reduce((s, r) => s + r.firstPartyCallers, 0),
    unknownFirstPartyCallSites: rows.reduce((s, r) => s + r.firstPartyUnknownCallers, 0),
    methodsWithUnknownCallers: rows.filter((r) => r.firstPartyUnknownCallers > 0).length,
    unresolvedExecutionCallSites: rows.reduce(
      (s, r) => s + r.firstPartyCallSites.filter((site) => site.execution === "unclear").length,
      0
    ),
    refusalOnlyMethods: rows.filter((r) => r.tsRefusal).length,
    callbackInputMethods: rows.filter((r) => r.jsonTransport?.inputCallbacks.length).length,
    callableReturnMethods: rows.filter((r) => r.jsonTransport?.outputCallbacks.length).length,
    nonJsonTransportMethods: rows.filter((r) => r.jsonTransport?.nonJson.length).length,
    unresolvedTransportMethods: rows.filter((r) => r.jsonTransport?.unresolved.length).length,
    hostSideUiCall: values("hostSideUiCall"),
  }
}
const cell = (value) =>
  String(Array.isArray(value) ? value.join(", ") : (value ?? ""))
    .replace(/\|/g, "\\|")
    .replace(/\n/g, " ")
function table(headers, rows) {
  return [headers, headers.map(() => "---"), ...rows]
    .map((row) => `| ${row.map(cell).join(" | ")} |`)
    .join("\n")
}
export function renderNote(existing, rows, namespaces = []) {
  const summary = summarize(rows)
  const coverage = (list, key) =>
    Object.entries(summarize(list)[key])
      .map(([k, n]) => `${k}: ${n}`)
      .join(", ")
  const namespaceIds = namespaces.length
    ? namespaces.map((n) => n.id)
    : [...new Set(rows.map((r) => r.namespace))]
  const generated = [
    "## Summary",
    table(
      ["Metric", "Count"],
      Object.entries(summary).map(([k, v]) => [
        k,
        typeof v === "object"
          ? Object.entries(v)
              .map(([key, count]) => `${key}: ${count}`)
              .join(", ")
          : v,
      ])
    ),
    "## Refusal-only TypeScript members",
    "The control-flow scan covers every mounted catalog member. Conditional guards with a success branch remain provided.",
    table(
      ["Method", "Refusal", "Evidence"],
      rows.filter((r) => r.tsRefusal).map((r) => [r.id, r.tsRefusal, r.notes[0]])
    ),
    "## Function/callback parameter inventory",
    "All namespaces are inspected, including methods unavailable to Python. Paths identify direct, aliased and nested callable inputs; these need a method-specific JSON callback adapter.",
    table(
      ["Method", "Callable input paths", "Callable return paths", "Python"],
      rows
        .filter((r) => r.jsonTransport?.inputCallbacks.length)
        .map((r) => [
          r.id,
          r.jsonTransport.inputCallbacks,
          r.jsonTransport.outputCallbacks,
          r.providedPython,
        ])
    ),
    "## Other JSON transport limitations",
    table(
      ["Method", "Callable returns / non-JSON values / unresolved signatures", "Python"],
      rows
        .filter(
          (r) =>
            r.jsonTransport &&
            (r.jsonTransport.outputCallbacks.length ||
              r.jsonTransport.nonJson.length ||
              r.jsonTransport.unresolved.length)
        )
        .map((r) => [
          r.id,
          [
            ...r.jsonTransport.outputCallbacks,
            ...r.jsonTransport.nonJson,
            ...r.jsonTransport.unresolved,
          ],
          r.providedPython,
        ])
    ),
    "## Namespaces",
    "Coverage reports exact status counts. Callers are known-context call sites / unresolved-context candidates, not plugin counts.",
    table(
      [
        "Namespace",
        "Methods",
        "Layer mix",
        "Headless",
        "TS / Python / WASM current (frozen)",
        "First-party callers",
      ],
      namespaceIds.map((id) => {
        const list = rows.filter((r) => r.namespace === id)
        const namespace = namespaces.find((n) => n.id === id)
        return [
          id,
          list.length,
          Object.entries(summarize(list).layers)
            .map(([k, n]) => `${k}: ${n}`)
            .join(", "),
          list[0]?.headless ?? namespace?.platforms.includes("headless") ?? false,
          `${coverage(list, "providedTs")} / ${coverage(list, "providedPython")} / ${coverage(list, "providedWasm")} (${coverage(list, "frozenWasm")})`,
          `${list.reduce((s, r) => s + r.firstPartyCallers, 0)} / ${list.reduce((s, r) => s + r.firstPartyUnknownCallers, 0)}`,
        ]
      })
    ),
    "## Host-side UI calls",
    "Only proven host callers appear here; unresolved placement is listed separately.",
    table(
      ["Method", "Layer", "Host calling plugins", "Host call sites"],
      rows
        .filter((r) => r.hostSideUiCall === true)
        .map((r) => [
          r.id,
          r.layer,
          [
            ...new Set(
              r.firstPartyCallSites.filter((s) => s.execution === "host").map((s) => s.plugin)
            ),
          ].sort(),
          r.firstPartyCallSites
            .filter((s) => s.execution === "host")
            .map((s) => `${s.path}:${s.line}`),
        ])
    ),
    "## Unresolved context candidates",
    "These syntactic namespace/method matches have no proven context source. They remain in JSON and are counted separately; they are not silently discarded or counted as proven callers.",
    table(
      ["Method", "Plugin", "Site", "Execution"],
      rows.flatMap((r) =>
        r.firstPartyUnknownCallSites.map((s) => [
          r.id,
          s.plugin,
          `${s.path}:${s.line}:${s.column}`,
          s.execution,
        ])
      )
    ),
    "## UI methods with unresolved caller placement",
    table(
      ["Method", "Calling plugins"],
      rows
        .filter((r) => r.hostSideUiCall === "unclear")
        .map((r) => [
          r.id,
          [...new Set([...r.firstPartyPlugins, ...r.firstPartyUnknownPlugins])].sort(),
        ])
    ),
    "## All contract methods",
    "The JSON additionally includes every call site's path, line, column, execution placement and detection reason.",
    table(
      [
        "ID",
        "Namespace",
        "Author path",
        "Method",
        "Stability",
        "Enforcement",
        "Risk",
        "Consent",
        "Permissions",
        "Headless",
        "Runtimes",
        "TS",
        "Python",
        "WASM",
        "Frozen WASM",
        "Layer",
        "Layer reason",
        "Known / unknown call sites",
        "Plugins",
        "Host-side UI",
        "Notes",
      ],
      rows.map((r) => [
        r.id,
        r.namespace,
        r.authorPath,
        r.method,
        r.stability,
        r.enforcement,
        r.risk,
        r.consentTier,
        r.requiredPermissions,
        r.headless,
        r.runtimesDeclared,
        r.providedTs,
        r.providedPython,
        r.providedWasm,
        r.frozenWasm,
        r.layer,
        r.layerReason,
        `${r.firstPartyCallers} / ${r.firstPartyUnknownCallers}`,
        r.firstPartyPlugins,
        r.hostSideUiCall,
        r.notes,
      ])
    ),
  ].join("\n\n")
  const start = "<!-- generated:start -->",
    end = "<!-- generated:end -->"
  const startAt = existing.indexOf(start),
    endAt = existing.indexOf(end)
  if (startAt >= 0 && (endAt < startAt || existing.indexOf(start, startAt + start.length) >= 0))
    throw new Error("Invalid generated Markdown markers")
  if (startAt < 0 && endAt >= 0) throw new Error("Invalid generated Markdown markers")
  return (
    (startAt >= 0 ? existing.slice(0, startAt) : `${existing.trimEnd()}\n\n`) +
    `${start}\n\n${generated}\n\n${end}` +
    (endAt >= 0 ? existing.slice(endAt + end.length) : "\n")
  )
}

export function generate(root) {
  const read = (path) => readSource(root, path)
  const catalog = JSON.parse(read(PATHS.catalog))
  // Separate research owner: counter.mjs inventories other convergence surfaces.
  const paths = [
    PATHS.context,
    PATHS.router,
    ...walk(root, "lib/plugin/api"),
    ...walk(root, "lib/plugin/core"),
    ...walk(root, "lib/plugin/messaging"),
    ...walk(root, "packages/plugin-contract/src/lib/plugin/core"),
    ...walk(root, "packages/plugin-contract/src/lib/plugin/api"),
    "lib/connectors/a2ui-bridge/surface-builder.ts",
    "packages/plugin-contract/src/lib/connectors/a2ui-bridge/surface-builder.ts",
    ...walk(root, "packages/plugin-contract/src/types"),
    ...walk(root, "packages/plugin-sdk/src/api"),
    ...walk(root, "packages/agent-contracts/src"),
    "packages/plugin-contract/src/templates/index.ts",
  ]
  const sources = Object.fromEntries(
    [...new Set(paths)].filter((p) => isSource(p) && hasSource(root, p)).map((p) => [p, read(p)])
  )
  // Follow signature dependencies, not the host's runtime import graph. In
  // particular React component aliases and lucide icon keys must resolve to
  // their real installed types instead of TypeScript's error/any fallback.
  for (const path of [
    "node_modules/@types/react/index.d.ts",
    "node_modules/@types/react/global.d.ts",
    "node_modules/lucide-react/dist/lucide-react.d.ts",
  ])
    if (hasSource(root, path)) sources[path] = read(path)
  if (typeof root === "string") {
    const libraryRoot = dirname(ts.getDefaultLibFilePath({ target: ts.ScriptTarget.ES2022 }))
    const libraries = ["lib.es2022.full.d.ts"]
    for (const name of libraries) {
      const key = `__typescript_lib__/${name}`
      if (key in sources) continue
      const text = readFileSync(resolve(libraryRoot, name), "utf8")
      sources[key] = text
      for (const reference of ts.preProcessFile(text).libReferenceDirectives)
        libraries.push(`lib.${reference.fileName}.d.ts`)
      for (const reference of ts.preProcessFile(text).referencedFiles)
        libraries.push(reference.fileName)
    }
  }
  const queue = Object.keys(sources)
  const available = new Proxy({}, { get: (_, path) => (hasSource(root, path) ? "" : undefined) })
  for (const path of queue) {
    const sf = parseTs(path, sources[path])
    const specs = descendants(sf, (n) => ts.isImportTypeNode(n))
      .map((n) => n.argument.literal?.text)
      .filter(Boolean)
    for (const statement of sf.statements) {
      if (
        ts.isImportDeclaration(statement) &&
        (path.endsWith(".d.ts") ||
          path.includes("/src/types/") ||
          statement.importClause?.isTypeOnly ||
          (statement.importClause?.namedBindings &&
            ts.isNamedImports(statement.importClause.namedBindings) &&
            statement.importClause.namedBindings.elements.some((n) => n.isTypeOnly)))
      )
        specs.push(statement.moduleSpecifier.text)
      if (
        ts.isExportDeclaration(statement) &&
        statement.moduleSpecifier &&
        (statement.isTypeOnly || path.includes("/src/types/") || path.endsWith(".d.ts"))
      )
        specs.push(statement.moduleSpecifier.text)
    }
    for (const spec of specs) {
      const resolved = modulePath(path, spec, available)
      if (resolved && /\.[cm]?tsx?$/.test(resolved) && !(resolved in sources)) {
        sources[resolved] = read(resolved)
        queue.push(resolved)
      }
    }
  }
  const rows = buildMatrix({
    catalog,
    tsProvider: inspectTypeScript(sources),
    python: pythonCoverage(root, catalog, sources),
    currentWit: parseWit(read(PATHS.wit)),
    frozenWit: parseWit(read(PATHS.frozen)),
    calls: scanPluginSources(root, catalog),
    overrides: JSON.parse(read(PATHS.overrides)),
  })
  return { rows, catalog }
}
export function main(args = process.argv.slice(2), root = process.cwd()) {
  if (args.some((arg) => !["--write", "--check"].includes(arg)) || args.length > 1)
    throw new Error("Usage: plugin-api-matrix.mjs [--write | --check]")
  const { rows, catalog } = generate(root)
  if (args.length) {
    if (!hasSource(root, PATHS.md))
      throw new Error(`Missing hand-written research header: ${PATHS.md}`)
    const artifacts = {
      [PATHS.json]: `${JSON.stringify(rows, null, 2)}\n`,
      [PATHS.md]: renderNote(readSource(root, PATHS.md), rows, catalog.apiNamespaces),
    }
    let stale = false
    for (const [path, expected] of Object.entries(artifacts)) {
      if (args[0] === "--write") writeSource(root, path, expected)
      else if (path === PATHS.json) continue
      else if (!hasSource(root, path) || readSource(root, path) !== expected) {
        console.error(`Stale: ${path}`)
        stale = true
      }
    }
    if (stale) return 1
  }
  console.log(
    JSON.stringify(
      {
        contractVersion: catalog.contractVersion,
        namespaces: catalog.apiNamespaces.length,
        ...summarize(rows),
      },
      null,
      2
    )
  )
  return 0
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main()
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}

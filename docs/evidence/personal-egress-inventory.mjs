/** Direct primitive inventory. Scans a superset of tool-reachable production code,
 * rather than relying on an incomplete static import graph or generated registry.
 * This is verification tooling, never imported into the exported application. */
import fs from "node:fs"
import path from "node:path"
import crypto from "node:crypto"
import { fileURLToPath } from "node:url"
import ts from "typescript"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const manifest = path.join(root, "lib/execution/personal-egress-network-sites.json")
const roots = [
  "app",
  "lib",
  "hooks",
  "components",
  "stores",
  "cli/src",
  "sidecar/src",
  "packages",
  "plugins",
]
const networkModule =
  /^(?:node:)?(?:https?|net|tls|dgram|http2|child_process)$|^(?:undici|ws|cross-fetch|node-fetch|axios|@tauri-apps\/plugin-http|@tauri-apps\/plugin-shell)(?:\/|$)/
const primitive =
  /^(?:fetch|fetchImpl|undiciFetch|proxyFetch|pinnedFetch|browserFetch|platformFetch|streamingFetch|request|createConnection|connect|connectTls|createSocket|WebSocket|EventSource|WebSocketStream|Socket|Agent|AgentCtor|EnvHttpProxyAgent|ProxyAgent|Pool|Client|spawn|spawnProcess|exec|execFile|execFileAsync|execSync|execFileSync|spawnSync)$/
const globals = new Set(["fetch", "WebSocket", "EventSource", "WebSocketStream"])

export function scan(file, text) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
  const modules = new Map()
  const aliases = new Map()
  const gates = new Set()
  const xhr = new Set()
  const shell = new Set()
  const addBindings = (bindings, module) => {
    if (!bindings) return
    if (ts.isObjectBindingPattern(bindings))
      for (const item of bindings.elements)
        modules.set(
          item.name.getText(source),
          `${module}:${item.propertyName?.getText(source) ?? item.name.getText(source)}`
        )
    else modules.set(bindings.getText(source), module)
  }
  const imports = (node) => {
    if (
      ts.isImportDeclaration(node) &&
      !node.importClause?.isTypeOnly &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      const mod = node.moduleSpecifier.text
      if (/(?:^@\/lib\/execution\/personal-egress$|(?:^|\/)personal-egress(?:\.ts)?$)/.test(mod)) {
        const bindings = node.importClause?.namedBindings
        if (bindings && ts.isNamedImports(bindings))
          for (const item of bindings.elements)
            if ((item.propertyName?.text ?? item.name.text) === "runPersonalEgressOperation")
              gates.add(item.name.text)
      }
      if (networkModule.test(mod)) {
        if (node.importClause?.name) modules.set(node.importClause.name.text, mod)
        const bindings = node.importClause?.namedBindings
        if (bindings && ts.isNamespaceImport(bindings)) modules.set(bindings.name.text, mod)
        else if (bindings)
          for (const item of bindings.elements)
            if (!item.isTypeOnly)
              modules.set(item.name.text, `${mod}:${item.propertyName?.text ?? item.name.text}`)
      }
    }
    if (
      (ts.isBindingElement(node) || ts.isParameter(node)) &&
      node.initializer &&
      ts.isIdentifier(node.name)
    )
      aliases.set(node.name.text, node.initializer.getText(source))
    if (ts.isVariableDeclaration(node) && node.initializer) {
      const init = node.initializer
      const call = ts.isAwaitExpression(init) ? init.expression : init
      if (
        ts.isIdentifier(node.name) &&
        ts.isNewExpression(call) &&
        /^(?:XMLHttpRequest|(?:window|globalThis)\.XMLHttpRequest)$/.test(
          call.expression.getText(source)
        )
      )
        xhr.add(node.name.text)
      if (
        ts.isIdentifier(node.name) &&
        ts.isCallExpression(call) &&
        /\.create$/.test(call.expression.getText(source)) &&
        /Command/.test(call.expression.getText(source))
      )
        shell.add(node.name.text)
      if (
        ts.isCallExpression(call) &&
        (call.expression.kind === ts.SyntaxKind.ImportKeyword ||
          call.expression.getText(source) === "require") &&
        call.arguments[0] &&
        ts.isStringLiteral(call.arguments[0]) &&
        networkModule.test(call.arguments[0].text)
      )
        addBindings(node.name, call.arguments[0].text)
      else if (ts.isObjectBindingPattern(node.name)) {
        for (const item of node.name.elements)
          if (ts.isIdentifier(item.name))
            aliases.set(
              item.name.text,
              `${init.getText(source)}.${item.propertyName?.getText(source) ?? item.name.text}`
            )
      } else if (ts.isIdentifier(node.name)) aliases.set(node.name.text, init.getText(source))
    }
    ts.forEachChild(node, imports)
  }
  imports(source)
  const resolve = (name, depth = 0) =>
    depth < 8 && aliases.has(name)
      ? resolve(aliases.get(name).replace(/\.bind\([\s\S]*\)$/, ""), depth + 1)
      : name
  const entries = []
  const owners = []
  const lexicalGate = (site) => {
    for (let node = site.parent; node; node = node.parent) {
      if (
        (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) &&
        ts.isCallExpression(node.parent) &&
        node.parent.arguments[1] === node &&
        gates.has(node.parent.expression.getText(source))
      )
        return "runPersonalEgressOperation"
    }
    return null
  }
  const visit = (node) => {
    const named =
      (ts.isFunctionDeclaration(node) ||
        ts.isMethodDeclaration(node) ||
        ts.isVariableDeclaration(node) ||
        ts.isPropertyAssignment(node)) &&
      node.name
    if (named) owners.push(node.name.getText(source))
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const expression = node.expression.getText(source)
      const resolved = resolve(expression)
      const first = resolved.split(/[.\[]/)[0]
      const last = resolved
        .split(/[.\[]/)
        .at(-1)
        ?.replace(/["'\]]/g, "")
      const imported = modules.get(first)
      const ipc =
        /(?:^|\.)(?:invoke|invokePluginApi|call)$/.test(resolved) &&
        node.arguments.some(
          (argument) =>
            ts.isStringLiteral(argument) &&
            /(?:proxy_http|browser_local_rpc|shell:|shell_|sandbox_|process_|mcp_|network_|http_|fetch|exec|spawn)/i.test(
              argument.text
            )
        )
      const dynamicIpc =
        /(?:^|\.)(?:invoke|transport\.call|invokePluginApi)$/.test(resolved) &&
        !node.arguments.some(ts.isStringLiteral)
      const browserPrimitive =
        /(?:^|\.)sendBeacon$/.test(resolved) ||
        (xhr.has(first) && last === "send") ||
        (shell.has(first) && /^(?:execute|spawn)$/.test(last ?? ""))
      // SDK/transport factory methods are classified whenever imported from a
      // network/process module, including aliases and namespace imports.
      const direct =
        ipc ||
        dynamicIpc ||
        browserPrimitive ||
        globals.has(resolved) ||
        /^(?:globalThis|window|self)\.(?:fetch|WebSocket|EventSource|WebSocketStream)$/.test(
          resolved
        ) ||
        (primitive.test(last ?? "") &&
          (imported || /(?:fetch|spawn|execFile|execSync|Socket|Agent|Pool)/i.test(last ?? ""))) ||
        (imported &&
          !/[.]?(?:promisify|setGlobalDispatcher|getGlobalDispatcher|isIP)$/.test(resolved))
      if (direct) {
        const kind = /(?:spawn|exec|child_process)/.test(`${imported ?? ""}:${resolved}`)
          ? "process"
          : "network"
        const normalized = node.getText(source).replace(/\s+/g, " ")
        const hash = crypto.createHash("sha256").update(normalized).digest("hex").slice(0, 12)
        const base = `${file}::${owners.join(">") || "module"}::${kind}::${hash}`
        const ordinal = entries.filter((entry) => entry.base === base).length + 1
        entries.push({
          base,
          key: `${base}:${ordinal}`,
          file,
          owner: owners.join(">") || "module",
          kind,
          primitive: imported ? `${imported} => ${expression}` : expression,
          line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
          lexicalGate: lexicalGate(node),
        })
      }
    }
    ts.forEachChild(node, visit)
    if (named) owners.pop()
  }
  visit(source)
  return entries.map(({ base: _base, ...entry }) => entry)
}

function files(directory) {
  if (!fs.existsSync(directory)) return []
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (
      ["node_modules", "dist", "target", ".next", "generated", "test-support", "fixtures"].includes(
        entry.name
      )
    )
      return []
    const full = path.join(directory, entry.name)
    if (entry.isDirectory()) return files(full)
    return /\.(?:[cm]?ts|tsx|[cm]?js|jsx)$/.test(entry.name) &&
      !/\.(?:test|spec|stories|d)\./.test(entry.name)
      ? [full]
      : []
  })
}
function check(actual, inventory) {
  const known = new Map(inventory.map((entry) => [entry.key, entry]))
  const keys = new Set(actual.map((entry) => entry.key))
  const errors = actual
    .filter(
      (entry) =>
        !new Set(["tool-gated", "host-system", "gated-here"]).has(
          known.get(entry.key)?.classification
        ) ||
        !known.get(entry.key)?.authority ||
        (known.get(entry.key)?.classification === "tool-gated" && !known.get(entry.key)?.entry) ||
        !known.get(entry.key)?.reason
    )
    .map((entry) => `Unclassified ${entry.key} (${entry.primitive})`)
  for (const entry of actual) {
    const prior = known.get(entry.key)
    if (
      (prior?.classification === "gated-here" || prior?.lexicalGate) &&
      (!entry.lexicalGate || entry.lexicalGate !== prior.lexicalGate)
    )
      errors.push(`Removed lexical egress gate ${entry.key}`)
  }
  errors.push(
    ...inventory.filter((entry) => !keys.has(entry.key)).map((entry) => `Stale ${entry.key}`)
  )
  if (known.size !== inventory.length) errors.push("Duplicate inventory key")
  return errors
}
if (process.argv.includes("--self-test")) {
  const fixture = `import * as http from 'node:https'; const { request: fromHttp } = http; const {fetch: fromGlobal} = globalThis; fromHttp('/'); fromGlobal('/'); import { request as send } from 'node:https'; import * as sock from 'node:net'; import {fetch as uf} from 'undici'; const {spawn: launch} = require('node:child_process'); const f = globalThis.fetch.bind(globalThis); send('/'); sock.connect(3); uf('/'); launch('curl', ['/']); f('/'); new WebSocket('wss://x');`
  const found = scan("fixture.ts", fixture)
  if (found.length !== 8 || found.filter((entry) => entry.kind === "process").length !== 1)
    throw new Error(`Alias/primitive detection failed: ${JSON.stringify(found)}`)
  const inventory = found.map((entry) => ({
    ...entry,
    classification: "host-system",
    authority: "fixture",
    reason: "Inventory test fixture",
  }))
  const guarded = `import {runPersonalEgressOperation as gate} from '@/lib/execution/personal-egress'; gate(ctx, () => fetch('/'));`
  const guardedSites = scan("app/fixture.ts", guarded).map((entry) => ({
    ...entry,
    classification: "gated-here",
    authority: "fixture",
    reason: "Inventory test fixture",
  }))
  if (
    guardedSites.length !== 1 ||
    !guardedSites[0].lexicalGate ||
    !check(
      scan("app/fixture.ts", guarded.replace("gate(ctx, () => fetch('/'))", "fetch('/')")),
      guardedSites
    ).some((error) => error.includes("Removed lexical"))
  )
    throw new Error("Removing a callback gate must fail")
  for (const sibling of [
    "gate(ctx, () => {}); fetch('/');",
    "function runPersonalEgressOperation() {} runPersonalEgressOperation(ctx, () => fetch('/'));",
  ])
    if (scan("fixture.ts", sibling).some((entry) => entry.lexicalGate))
      throw new Error("Sibling or fake gate accepted")
  const additional = scan(
    "app/fixture.ts",
    `import {Command} from '@tauri-apps/plugin-shell'; const command=Command.create('curl'); command.execute(); const xhr=new XMLHttpRequest(); xhr.send('private'); navigator.sendBeacon('/','private'); transport.call('browser_local_rpc', {}); invoke('proxy_http_request', {}); transport.call(commandName, {});`
  )
  if (additional.length !== 7)
    throw new Error(`IPC/shell/XHR/beacon detection failed: ${JSON.stringify(additional)}`)
  if (
    check(found, inventory).length ||
    check(scan("fixture.ts", fixture + "f('/');"), inventory).length !== 1
  )
    throw new Error("A second unclassified primitive must fail")
  if (
    !check(
      found,
      inventory.map((entry) => ({ ...entry, classification: "unreviewed" }))
    ).length ||
    !check(
      found,
      inventory.map((entry) => ({ ...entry, classification: "tool-gated", entry: undefined }))
    ).length
  )
    throw new Error("Unknown classes and unnamed tool entries must fail")
  console.log(
    "Inventory regression: aliases, callback containment, removed/fake/sibling gates, IPC, shell, XHR, beacon, app roots and duplicate calls pass"
  )
} else {
  const actual = roots
    .flatMap((directory) => files(path.join(root, directory)))
    .sort()
    .flatMap((file) => scan(path.relative(root, file), fs.readFileSync(file, "utf8")))
  if (process.argv.includes("--write")) {
    const document = fs.existsSync(manifest)
      ? JSON.parse(fs.readFileSync(manifest, "utf8"))
      : { sites: [], unresolved: [] }
    const prior = [...document.sites, ...(document.unresolved ?? [])]
    const known = new Map(prior.map((entry) => [entry.key, entry]))
    fs.writeFileSync(
      manifest,
      JSON.stringify(
        {
          ...document,
          scope:
            "All production sources in tool-capable workspaces (conservative superset of runtime reachability); dependency implementations remain behind their call sites",
          unresolved: [],
          sites: actual.map((entry) => ({
            ...known.get(entry.key),
            ...entry,
            classification: known.get(entry.key)?.classification ?? "",
            authority: known.get(entry.key)?.authority ?? "",
          })),
        },
        null,
        2
      ) + "\n"
    )
    console.log(`Wrote ${actual.length} sites for explicit review`)
  } else {
    const errors = check(actual, JSON.parse(fs.readFileSync(manifest, "utf8")).sites)
    if (errors.length) {
      console.error(errors.join("\n"))
      process.exitCode = 1
    } else
      console.log(
        `Direct primitive inventory: ${actual.length} classified sites; no unclassified or stale entries`
      )
  }
}

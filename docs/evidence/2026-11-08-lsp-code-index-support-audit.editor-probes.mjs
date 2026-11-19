import fs from "node:fs"
import vm from "node:vm"
import path from "node:path"
import assert from "node:assert/strict"
import { createRequire } from "node:module"

// Resolve the root compiler API; docs owns a different TypeScript package.
const ts = createRequire(new URL("../../package.json", import.meta.url))("typescript")

// Read-only audit probes: execute the checked-out modules; inject only boundaries.
const root = process.cwd()
const logger = new Proxy({}, { get: () => () => {} })

function loadSource(file, imports) {
  const source = fs.readFileSync(path.join(root, file), "utf8")
  const code = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText
  const sourceModule = { exports: {} }
  const requireBoundary = (id) => {
    if (id in imports) return imports[id]
    throw new Error(`unexpected import ${id}`)
  }
  vm.runInThisContext(`(function(require,module,exports){${code}\n})`, { filename: file })(
    requireBoundary,
    sourceModule,
    sourceModule.exports
  )
  return sourceModule.exports
}

const registrations = []
const existing = []
const userServers = loadSource("lib/plugin/lsp/lsp-user-servers.ts", {
  "./lsp-registry": {
    listLspServers: () => existing,
    registerLspServer: async (input) => {
      registrations.push(input)
      existing.push({ ownerId: input.ownerId, serverId: input.config.id, config: input.config })
    },
    unregisterLspServer: async () => {},
  },
})
const first = {
  id: "demo",
  name: "Demo",
  languages: ["typescript"],
  command: "old-server",
  transport: "socket",
  endpoint: "tcp://127.0.0.1:5100",
  startupTimeout: 1234,
  memoryLimitMb: 128,
  install: { npmPackage: "demo-server" },
}
await userServers.syncUserLspServers([first])
const syncResult = await userServers.syncUserLspServers([
  { ...first, command: "new-server", settings: { changed: true } },
])
const configResult = {
  probe: "config-update-and-forward",
  registrations: registrations.length,
  command: existing[0].config.command,
  syncResult,
  dropped: ["endpoint", "startupTimeout", "memoryLimitMb", "install"].filter(
    (key) => !(key in registrations[0].config)
  ),
}
assert.equal(configResult.registrations, 1)
assert.equal(configResult.command, "old-server")
assert.equal(configResult.syncResult.skipped, 1)
assert.deepEqual(configResult.dropped, ["endpoint", "startupTimeout", "memoryLimitMb", "install"])
console.log(JSON.stringify(configResult))

const pathToFileUri = (input) => `file://${input}`
const manager = loadSource("lib/plugin/vscode-shim/lsp-workspace-manager.ts", {
  "@cognia/logging": { loggers: { plugin: { child: () => logger } } },
  "@/lib/files/path-uri": { pathToFileUri },
})
manager.configureLspWorkspaceManager({
  appDataDir: async () => "/app",
  createDir: async () => {},
  writeFile: async () => {},
  removeDir: async () => {},
  joinPath: (...parts) => parts.join("/"),
  pathToFileUri,
})
manager.registerProjectWorkspace("/tmp/audit-project")
const registry = loadSource("lib/plugin/lsp/lsp-registry.ts", {
  "@cognia/logging": { loggers: { plugin: { child: () => logger } } },
  "@/lib/plugin/vscode-shim/lsp-binary-policy": {
    evaluateLspBinary: async () => ({ allowed: true }),
  },
  "@/lib/plugin/vscode-shim/lsp-workspace-manager": manager,
  "./lsp-monaco-runtime": { registerLspMonacoProviders: () => ({ dispose() {} }) },
  "@cognia/plugin-contract/lib/plugin/lsp/lsp-registry": {
    lspServerKey: (ownerId, serverId) => `${ownerId}:${serverId}`,
  },
})
let editorListener
const calls = []
const errors = []
const rejectionHandler = (error) => errors.push(error.message)
process.on("unhandledRejection", rejectionHandler)
const dispose = registry.configureLspRegistry({
  client: {
    start: async (input) => {
      calls.push({ op: "start", hasServerRequestHandler: !!input.onServerRequest })
      return { capabilities: {} }
    },
    stop: async () => {},
    didOpen: async () => calls.push({ op: "didOpen" }),
    didChange: async () => calls.push({ op: "didChange" }),
  },
  bridge: {
    setDiagnostics() {},
    onEditorChange: (listener) => {
      editorListener = listener
      return () => {}
    },
    getEditorById: () => ({
      getModel: () => ({ language: "typescript", getValue: () => "const answer = 43" }),
    }),
  },
  resolveWorkspaceFolders: manager.listWorkspaceFolders,
  now: Date.now,
})
await registry.registerLspServer({
  ownerId: "user",
  config: { id: "demo", name: "Demo", languages: ["typescript"], command: "server" },
  pluginPath: "/tmp",
  confirmedConsent: true,
})
editorListener({ kind: "open", editorId: "file-editor", uri: "file:///tmp/audit-project/main.ts" })
await new Promise((resolve) => setTimeout(resolve, 10))
editorListener({
  kind: "change-content",
  editorId: "file-editor",
  uri: "file:///tmp/audit-project/main.ts",
})
await new Promise((resolve) => setTimeout(resolve, 20))
assert.deepEqual(calls, [{ op: "start", hasServerRequestHandler: false }, { op: "didOpen" }])
assert.deepEqual(errors, [
  "lsp-workspace-manager: no materialised document for file:///tmp/audit-project/main.ts",
])
console.log(JSON.stringify({ probe: "real-project-didChange", calls, errors }))
await dispose()
process.off("unhandledRejection", rejectionHandler)

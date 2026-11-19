import assert from "node:assert/strict"
import crypto from "node:crypto"
import fs from "node:fs"
import { createRequire } from "node:module"
import os from "node:os"
import path from "node:path"
import vm from "node:vm"
const root = process.cwd()
const local = createRequire(path.join(root, "package.json"))
const host = createRequire(path.join(root, "sidecar/vscode-ext-host/package.json"))
const ts = local("typescript")
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "cognia-lsp-process-"))
const logging = { loggers: { plugin: { child: () => new Proxy({}, { get: () => () => {} }) } } }
function load(file, deps = {}, fallback = local) {
  const code = ts.transpileModule(fs.readFileSync(file, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText
  const sourceModule = { exports: {} }
  vm.runInThisContext("(function(require,module,exports){" + code + "\n})", { filename: file })(
    (id) => (id in deps ? deps[id] : fallback(id)),
    sourceModule,
    sourceModule.exports
  )
  return sourceModule.exports
}
const clientSrc = "sidecar/vscode-ext-host/src/"
const { CogniaLspClient } = load(
  clientSrc + "lsp-client.ts",
  {
    "./process-resource-monitor": load(clientSrc + "process-resource-monitor.ts", {}, host),
  },
  host
)
const p = load("lib/files/path-uri.ts")
const manager = load("lib/plugin/vscode-shim/lsp-workspace-manager.ts", {
  "@cognia/logging": logging,
  "@/lib/files/path-uri": p,
})
const approvalReads = []
const hash = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex")
const policy = load("lib/plugin/vscode-shim/lsp-binary-policy.ts", { "@/lib/db/schema": {} })
policy.configureLspBinaryPolicy({
  hashBinary: async (file) => hash(file),
  findApprovedBinary: async (owner, file) => {
    approvalReads.push({ owner, file })
    return { sha256: hash(file) }
  },
  appendAudit: async () => {},
  isUnsignedLspAllowed: async () => false,
})
const localLspTransport = {
  getRemoteLspTransport: () => null,
  subscribeRemoteLspTransport: () => () => {},
}
const registry = load("lib/plugin/lsp/lsp-registry.ts", {
  "@cognia/logging": logging,
  "@/lib/plugin/vscode-shim/lsp-binary-policy": policy,
  "@/lib/lsp/host-transport": localLspTransport,
  "@/lib/plugin/vscode-shim/lsp-workspace-manager": manager,
  "./lsp-monaco-runtime": { registerLspMonacoProviders: () => ({ dispose() {} }) },
  "@cognia/plugin-contract/lib/plugin/lsp/lsp-registry": load(
    "packages/plugin-contract/src/lib/plugin/lsp/lsp-registry.ts"
  ),
})
const userServers = load("lib/plugin/lsp/lsp-user-servers.ts", {
  "./lsp-registry": registry,
  "@/lib/lsp/host-transport": localLspTransport,
})
const config = load("lib/lsp/resolve-config.ts", {
  "./builtin-defaults": load("lib/lsp/builtin-defaults.ts"),
})
const reader = load("lib/lsp/project-file-reader.ts", {
  "@/lib/tauri": { isTauri: () => true },
  "@/lib/platform/detect": { isHeadlessHost: () => false },
  "@/lib/lsp/host-transport": localLspTransport,
  "@/lib/files/workspace-fs": {
    readWorkspaceFile: async (root, rel) => fs.readFileSync(path.join(root, rel), "utf8"),
  },
})
const { TauriLspClientAdapter } = load("lib/plugin/lsp/lsp-client-adapter-tauri.ts", {
  "@/lib/plugin/core/vscode-loader": { isVscodeHostAvailable: () => true },
  "@/lib/tauri": {},
  "@/lib/lsp/host-transport": localLspTransport,
  "@/lib/files/path-uri": p,
  "@/lib/plugin/vscode-shim/rpc-dispatcher": { registerMethod: () => () => {} },
  "@/lib/plugin/vscode-shim/lsp-protocol-adapter": {},
  "./lsp-registry": registry,
})
const clients = new Map(),
  ops = [],
  rejections = []
process.on("unhandledRejection", (error) => rejections.push(error.code ?? error.message))
const adapter = new TauriLspClientAdapter({
  invoke: async (_channel, method, input) => {
    const key = input.ownerId + ":" + input.serverId
    ops.push(method)
    if (method === "lsp:start") {
      const client = new CogniaLspClient({ ...input, startupTimeout: 2000 })
      clients.set(key, client)
      await client.start()
      return { capabilities: client.getServerCapabilities() }
    }
    if (method === "lsp:stop") return clients.get(key)?.stop()
    if (method === "lsp:didOpen")
      return clients.get(key).registerTextDocument(input.uri, input.languageId, input.text)
    if (method === "lsp:didChange")
      return clients.get(key).changeTextDocument(input.uri, input.text)
    throw new Error(method)
  },
})
let listener
let text = "const unsaved = 1"
const bridge = {
  setDiagnostics() {},
  onEditorChange: (fn) => {
    listener = fn
    return () => {}
  },
  getEditorById: () => ({ getModel: () => ({ language: "typescript", getValue: () => text }) }),
}
const project = { id: "project", path: path.join(temp, "project") }
let restricted = true
const { bootstrapLspRegistry, refreshEditorLspServers } = load("lib/plugin/lsp/lsp-bootstrap.ts", {
  "@/lib/plugin/vscode-shim/monaco-bridge": bridge,
  "@/lib/plugin/vscode-shim/lsp-workspace-manager": manager,
  "@/stores/settings/settings-store": {
    useSettingsStore: { getState: () => ({}), subscribe: () => () => {} },
  },
  "@/stores/project/project-store": {
    useProjectStore: {
      getState: () => ({ projects: [project], activeProjectId: project.id }),
      subscribe: () => () => {},
    },
  },
  "@/lib/workspace/roots": { primaryRootOf: (value) => value },
  "@/lib/workspace/trust-gate": { isWorkspaceRestricted: async () => restricted },
  "@/lib/plugin/vscode-shim/root-watchers": {},
  "@/lib/db/trusted-workspaces": {},
  "@/lib/lsp/resolve-config": config,
  "@/lib/lsp/project-file-reader": reader,
  "./lsp-registry": registry,
  "./lsp-user-servers": userServers,
  "./lsp-client-adapter-tauri": { getSystemLspClient: () => adapter },
})
const delay = () => new Promise((resolve) => setTimeout(resolve, 15))
async function until(condition) {
  for (let i = 0; i < 200; i++) {
    if (condition()) return
    await delay()
  }
  throw new Error("timed out")
}
function fixture(dir, identity) {
  fs.mkdirSync(dir, { recursive: true })
  const bin = path.join(dir, "audit-lsp")
  const rpcPath = JSON.stringify(host.resolve("vscode-jsonrpc/node"))
  fs.writeFileSync(
    bin,
    [
      "#!" + process.execPath,
      "const rpc = require(" + rpcPath + ");",
      "const conn = rpc.createMessageConnection(new rpc.StreamMessageReader(process.stdin), new rpc.StreamMessageWriter(process.stdout));",
      "const docs = new Map();",
      "conn.onRequest('initialize', () => ({ capabilities: { hoverProvider: true, auditIdentity: " +
        JSON.stringify(identity) +
        " }}));",
      "conn.onNotification('textDocument/didOpen', p => docs.set(p.textDocument.uri, p.textDocument.text));",
      "conn.onNotification('textDocument/didChange', p => docs.set(p.textDocument.uri, p.contentChanges[0].text));",
      "conn.onRequest('textDocument/hover', p => docs.get(p.textDocument.uri) ?? null);",
      "conn.onRequest('shutdown', () => null);",
      "conn.onNotification('exit', () => process.exit(0));",
      "conn.listen();",
    ].join("\n"),
    { mode: 0o755 }
  )
  return bin
}
try {
  const alternate = fixture(path.join(temp, "path"), "PATH executable")
  const approved = fixture(path.join(temp, "plugin"), "approved executable")
  const command = {
    id: "project-cmd",
    name: "Project fixture",
    languages: ["typescript"],
    command: alternate,
  }
  fs.mkdirSync(path.join(project.path, ".cognia"), { recursive: true })
  fs.writeFileSync(
    path.join(project.path, ".cognia/lsp.json"),
    JSON.stringify({ servers: [command] })
  )
  manager.registerProjectWorkspace(project.path)
  const uri = p.pathToFileUri(path.join(project.path, "main.ts"))
  const open = () => listener({ kind: "open", editorId: "file-editor", uri })
  const hover = () => clients.get("user:project-cmd").hover(uri, { line: 0, character: 0 })
  bootstrapLspRegistry({ client: adapter, bridge, subscribeChanges: () => () => {} })
  open()
  await refreshEditorLspServers()
  assert.equal(ops.includes("lsp:start"), false)
  restricted = false
  await refreshEditorLspServers()
  const projectRec = registry.listLspServers()[0]
  assert.equal(projectRec.capabilities.auditIdentity, "PATH executable")
  assert.deepEqual(approvalReads, [])
  assert.equal(await hover(), "const unsaved = 1")
  text = "const unsaved = 2"
  listener({ kind: "change-content", editorId: "file-editor", uri })
  await until(() => ops.includes("lsp:didChange"))
  assert.equal(await hover(), text)
  manager.registerProjectWorkspace(path.join(temp, "second-project"))
  await until(
    () => ops.filter((op) => op === "lsp:didOpen").length === 2 && projectRec.state === "running"
  )
  assert.equal(await hover(), text)
  console.log(
    "Restricted startup blocked. Open, edit and workspace restart kept current text over real stdio."
  )
  const [record] = await registry.registerPluginLspServers({
    pluginId: "sample.plugin",
    pluginPath: path.dirname(approved),
    servers: [
      {
        ...command,
        id: "plugin-cmd",
        command: "audit-lsp",
        env: { PATH: path.dirname(alternate) },
      },
    ],
  })
  assert.deepEqual(approvalReads, [{ owner: "sample.plugin", file: approved }])
  assert.equal(record.capabilities.auditIdentity, "approved executable")
  console.log("The approved plugin executable started despite an alternate PATH binary.")
} finally {
  await Promise.allSettled([...clients.values()].map((client) => client.stop()))
  await new Promise((resolve) => setTimeout(resolve, 100))
  assert.deepEqual(rejections, [])
  fs.rmSync(temp, { recursive: true, force: true })
}

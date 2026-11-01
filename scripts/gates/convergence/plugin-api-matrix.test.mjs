import assert from "node:assert/strict"
import { test } from "node:test"
import * as matrix from "./plugin-api-matrix.mjs"

import {
  buildMatrix,
  classifyLayer,
  generate,
  inspectTypeScript,
  main,
  parseWit,
  renderNote,
  scanPluginSources,
  summarize,
} from "./plugin-api-matrix.mjs"

const method = (namespace, name, extra = {}) => ({
  id: `${namespace}.${name}`,
  name,
  requiredPermissions: ["storage:read"],
  consentTier: "none",
  risk: "low",
  resourceEffect: { kind: "none" },
  ...extra,
})
const ns = (id, names, extra = {}) => ({
  id,
  authorPath: `ctx.${id}`,
  factory: `context.${id}`,
  stability: "stable",
  enforcement: "shadow",
  platforms: ["headless"],
  runtimes: ["frontend", "python"],
  methods: names.map((name) => method(id, name)),
  ...extra,
})
function fixture(t, files) {
  return {
    files: new Map(
      Object.entries(files).map(([path, content]) => [
        path,
        typeof content === "string" ? content : JSON.stringify(content),
      ])
    ),
  }
}

test("refusal-only members are no across throws, branch refusals and delegated refusals, preserving success paths", () => {
  const inspect = inspectTypeScript({
    "lib/plugin/core/context.ts": `
    function deny() { return Promise.reject(new Error('NOT_SUPPORTED')); }
    function createFullPluginContext() { return { shell: {
      spawn() { throw new Error('NOT_SUPPORTED'); },
      branches(flag) { if (flag) throw new Error('NOT_IMPLEMENTED'); else return deny(); },
      delegated: () => deny(),
      refusedValue: () => ({ ok: false, error: { code: 'NOT_SUPPORTED' } }),
      refusedPromise: () => Promise.resolve({ status: 'unsupported' }),
      literalBranch() { if (true) throw new Error('NOT_IMPLEMENTED'); },
      allowed(flag) { if (!flag) throw new Error('PERMISSION_DENIED'); return 42; },
      recovered() { try { throw new Error('NOT_SUPPORTED'); } catch { return 1; } },
      finalReturn() { try { throw new Error('NOT_SUPPORTED'); } finally { return 1; } },
      successData: () => ({ ok: true, payload: { status: 'unsupported' } }),
      successHandle: () => ({ run: () => ({ status: 'error' }) }),
    }}; }
  `,
  })
  for (const name of [
    "spawn",
    "branches",
    "delegated",
    "refusedValue",
    "refusedPromise",
    "literalBranch",
  ]) {
    const result = inspect(ns("shell", []), method("shell", name))
    assert.equal(result.value, "no", name)
    assert.match(result.reason, /NOT_SUPPORTED|NOT_IMPLEMENTED|unsupported/i, name)
  }
  for (const name of ["allowed", "recovered", "finalReturn", "successData", "successHandle"])
    assert.equal(inspect(ns("shell", []), method("shell", name)).value, "yes", name)
})

test("Python JSON transport finds aliased/nested callback inputs and callable returns, with no adapter", () => {
  const catalog = {
    apiNamespaces: [
      ns(
        "agent",
        ["registerExternalAgentAdapter", "run", "handle", "safe", "optional.listen", "unresolved"],
        { type: "PluginAgentAPI" }
      ),
    ],
  }
  const transport = matrix.inspectJsonTransport(catalog, {
    "contract.ts": `export type Factory = () => { run(): void }; export interface Options { onProgress?: (n: number) => void }`,
    "api.ts": `import type { Factory, Options } from './contract';
      interface PluginAgentAPI {
        registerExternalAgentAdapter(id: string, factory: Factory): void;
        run(options: Options): Promise<string>;
        handle(): { close(): void };
        safe(input: { name: string }): Promise<{ ok: boolean }>;
        optional?: { listen(callback: (s: string) => void): void };
        unresolved(value: MissingSdkType): void;
      }`,
  })
  const ids = catalog.apiNamespaces[0].methods.map((m) => m.id)
  const rows = buildMatrix({
    catalog,
    tsProvider: () => ({ value: "yes", reason: "fixture" }),
    python: { exposed: ids, routed: ids, transport },
  })
  for (const name of [
    "registerExternalAgentAdapter",
    "run",
    "handle",
    "optional.listen",
    "unresolved",
  ]) {
    const row = rows.find((r) => r.method === name)
    assert.equal(row.providedPython, "declared-only", name)
    assert.match(row.notes.join(" "), /JSON|callback|callable/i)
  }
  assert.equal(rows.find((r) => r.method === "safe").providedPython, "yes")
  assert.ok(
    transport["agent.registerExternalAgentAdapter"].inputCallbacks.some((p) =>
      p.includes("factory")
    )
  )
})

test("cyclic object spreads keep unresolved context candidates without recursing forever", (t) => {
  const root = fixture(t, {
    "plugins/p/plugin.json": { id: "cycle", type: "frontend" },
    "plugins/p/main.ts":
      "const cycle = { ...cycle }; function unresolved() { cycle.storage.get('unknown'); }",
  })
  const calls = scanPluginSources(root, { apiNamespaces: [ns("storage", ["get"])] })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].contextResolution, "unknown")
})

test("signature inventory prefers canonical author declarations over unresolved host aliases", () => {
  const catalog = {
    apiNamespaces: [ns("templates", ["subscribe"], { type: "PluginTemplatesAPI" })],
  }
  const transport = matrix.inspectJsonTransport(catalog, {
    "lib/plugin/api/templates-api.ts": "type PluginTemplatesAPI = MissingPublicAlias;",
    "packages/plugin-contract/src/templates/index.ts":
      "export interface PluginTemplatesAPI { subscribe(listener: () => void): () => void }",
  })
  assert.deepEqual(transport["templates.subscribe"].inputCallbacks, ["input.listener"])
  assert.deepEqual(transport["templates.subscribe"].unresolved, [])
})

test("context arguments propagate into arbitrary imported parameters and returned helpers; unresolved sites remain counted", (t) => {
  const catalog = {
    apiNamespaces: [ns("storage", ["get", "set"]), ns("integrations", ["publishEvent"])],
  }
  const root = fixture(t, {
    "plugins/p/plugin.json": { id: "propagation", type: "frontend" },
    "plugins/p/index.ts": `import { createSync, relay } from './sync';
      export default { activate(root: PluginContext) { const worker = createSync(root); worker.run(); relay(root); } };`,
    "plugins/p/sync.ts": `import { save } from './save';
      export function createSync(host: CalendarSyncHost) { const { storage } = host;
        return { run() { storage.get('real'); host.integrations.publishEvent({}); } }; }
      export function relay(other) { save(other); }`,
    "plugins/p/save.ts": `export function save(unusual) { const s = unusual.storage; s.set('real', 1); }`,
    "plugins/p/unknown.ts": `export function unresolved(missing: CalendarSyncHost) { missing.storage.get('unknown'); }`,
  })
  const calls = scanPluginSources(root, catalog)
  assert.equal(calls.filter((c) => c.contextResolution === "known").length, 3)
  assert.equal(calls.filter((c) => c.contextResolution === "unknown").length, 1)
  const rows = buildMatrix({ catalog, calls })
  assert.equal(summarize(rows).unknownFirstPartyCallSites, 1)
  assert.equal(rows.find((r) => r.id === "storage.get").firstPartyUnknownCallers, 1)
})

test("closure creation is not execution: stored view callbacks stay unclear, real calls and scheduler/tool contracts are host", (t) => {
  const root = fixture(t, {
    "plugins/p/plugin.json": { id: "closure", type: "frontend" },
    "plugins/p/index.ts": `import { publish } from './slot';
      export default { activate(ctx) {
        publish({ navigate: href => ctx.ui.navigate(href) });
        const real = () => ctx.ui.showToast('real'); real();
        const dormant = () => ctx.ui.showDialog('dormant');
        ctx.scheduler.registerHandler('task', () => ctx.ui.showToast('scheduled'));
        return { tools: [{ execute() { ctx.ui.showToast('tool'); } }] };
      }};`,
    "plugins/p/slot.ts": `let stored; export function publish(value) { stored = value; } export function read() { return stored; }`,
    "plugins/p/view.tsx": `import { read } from './slot'; export function View() { const host = read();
      return <button onClick={() => host.navigate('/settings')}>Go</button>; }`,
  })
  const catalog = {
    apiNamespaces: [
      ns("ui", ["navigate", "showToast", "showDialog"]),
      ns("scheduler", ["registerHandler"]),
    ],
  }
  const calls = scanPluginSources(root, catalog)
  assert.equal(calls.find((c) => c.id === "ui.navigate").execution, "unclear")
  assert.equal(calls.find((c) => c.id === "ui.showDialog").execution, "unclear")
  assert.equal(calls.filter((c) => c.id === "ui.showToast" && c.execution === "host").length, 3)
})

test("active-client roots, selection subscriptions and implicit project operations require client ownership", () => {
  for (const [namespace, name, expected] of [
    ["workspace", "getActiveRoot", "ui"],
    ["project", "onProjectChange", "ui"],
    ["session", "onSessionChange", "ui"],
    ["team", "createTeam", "both"],
    ["commands", "listCustomCommands", "both"],
    ["automation", "screenshot", "both"],
  ]) {
    const result = classifyLayer(ns(namespace, []), method(namespace, name))
    assert.equal(result.layer, expected, `${namespace}.${name}`)
    assert.ok(result.layerReason)
  }
  assert.equal(classifyLayer(ns("goals", []), method("goals", "getActiveForSession")).layer, "host")
})

test("TS counts direct, optional, destructured, renamed, nested and namespace aliases once", (t) => {
  const catalog = { apiNamespaces: [ns("storage", ["get"]), ns("agent", ["sessions.create"])] }
  const root = fixture(t, {
    "plugins/one/plugin.json": { id: "actual-one", type: "frontend", main: "src/index.ts" },
    "plugins/one/src/index.ts": `export const plugin = { activate(ctx) {
      ctx.storage.get('a'); context?.storage?.get?.('b');
      const { storage } = ctx; storage.get('c');
      const { storage: renamed } = ctx; renamed.get('d');
      const x = ctx.storage; x?.get('e');
      const { sessions } = ctx.agent; sessions.create();
      // ctx.storage.get('comment')
      const text = "ctx.storage.get('string')";
      function shadow(storage) { storage.get('not ctx'); }
      function shadowCtx(ctx) { const ctx2 = {}; ctx2.storage.get(); }
      { const storage = { get() {} }; storage.get('shadow'); }
    }};`,
    "plugins/one/src/ignored.test.ts": "ctx.storage.get()",
    "plugins/one/src/ignored.spec.tsx": "ctx.storage.get()",
    "plugins/one/src/test.ts": "ctx.storage.get()",
    "plugins/one/vendor/no.ts": "ctx.storage.get()",
    "plugins/one/node_modules/no.ts": "ctx.storage.get()",
    "plugins/one/dist/no.js": "ctx.storage.get()",
    "plugins/one/tests/no.ts": "ctx.storage.get()",
    "plugins/one/build/no.py": "ctx.storage.get()",
  })
  const calls = scanPluginSources(root, catalog)
  assert.equal(calls.filter((c) => c.id === "storage.get").length, 5)
  assert.equal(calls.filter((c) => c.id === "agent.sessions.create").length, 1)
  assert.ok(calls.every((c) => c.plugin === "actual-one" && c.execution === "host"))
})

test("Python AST counts sync, awaited, multiline, cognia.ctx and aliases; excludes strings/tests", (t) => {
  const root = fixture(t, {
    "plugins/py/plugin.json": { id: "py-id", type: "hybrid", pythonMain: "main.py" },
    "plugins/py/main.py": `from cognia import ctx
ctx.storage.get('a')
async def tool():
    await ctx.storage.get('b')
    x = ctx.storage
    await x.get('c')
    await cognia.ctx.storage.get(
        'd'
    )
    # ctx.storage.get('comment')
    text = "ctx.storage.get('string')"
def shadow(x):
    x.get('not ctx')
`,
    "plugins/py/test_main.py": "ctx.storage.get()",
    "plugins/py/helper_test.py": "ctx.storage.get()",
    "plugins/py/conftest.py": "ctx.storage.get()",
    "plugins/py/vendor/helper.py": "ctx.storage.get()",
  })
  const calls = scanPluginSources(root, { apiNamespaces: [ns("storage", ["get"])] })
  assert.equal(calls.length, 4)
  assert.ok(calls.every((c) => c.execution === "host"))
})

test("a reassigned TS namespace alias stops counting; unrelated ctx locals are excluded", (t) => {
  const root = fixture(t, {
    "plugins/p/plugin.json": { id: "reassigned", type: "frontend" },
    "plugins/p/index.ts": `function activate(ctx) {
      let x = ctx.storage; x.get('real'); x = unrelated; x.get('not ctx');
      { const ctx = { storage: { get() {} } }; ctx.storage.get('not ctx'); }
    }`,
  })
  assert.equal(scanPluginSources(root, { apiNamespaces: [ns("storage", ["get"])] }).length, 1)
})

test("TS follows the mounted factory, barrels, spreads, groups and guards, not unrelated methods/types", () => {
  const sources = {
    "lib/plugin/core/context.ts": `import { createStorageAPI } from '../api';
      function createPluginContext() { return { ui: { showToast() {} } }; }
      function createFullPluginContext() {
        const baseContext = createPluginContext();
        const contextAPI = { storage: createStorageAPI() };
        const fullContext = { ...baseContext, ...contextAPI, missing: externalFactory() };
        return fullContext;
      }`,
    "lib/plugin/api/index.ts": `export { createStorageAPI } from './storage-api'`,
    "lib/plugin/api/storage-api.ts": `interface Author { absent(): void }
      function unrelated() { return { absent() {} } }
      export function createStorageAPI() { const api = { async get() {}, group: { set: () => 1 } };
        return createGuardedAPI('id', api, {}); }`,
  }
  const inspect = inspectTypeScript(sources)
  assert.equal(inspect(ns("storage", []), method("storage", "get")).value, "yes")
  assert.equal(inspect(ns("storage", []), method("storage", "group.set")).value, "yes")
  assert.equal(inspect(ns("storage", []), method("storage", "absent")).value, "no")
  assert.equal(inspect(ns("ui", []), method("ui", "showToast")).value, "yes")
  assert.equal(inspect(ns("missing", []), method("missing", "get")).value, "unclear")
})

test("an explicitly undefined host member is not an implementation", () => {
  const inspect = inspectTypeScript({
    "lib/plugin/core/context.ts":
      "function createFullPluginContext() { return { storage: { get: undefined } }; }",
  })
  assert.equal(inspect(ns("storage", []), method("storage", "get")).value, "no")
})

test("caller lookup uses authorPath rather than catalog namespace spelling", (t) => {
  const root = fixture(t, {
    "plugins/p/plugin.json": { id: "author-path", type: "frontend" },
    "plugins/p/main.ts": "function activate(ctx) { const a = ctx.agentConfig; a.get(); }",
  })
  const calls = scanPluginSources(root, {
    apiNamespaces: [ns("config-contract", ["get"], { authorPath: "ctx.agentConfig" })],
  })
  assert.equal(calls[0].id, "config-contract.get")
})

test("WIT parses interfaces/imports, maps kebab case and explicit aliases; ignores guest exports/comments", () => {
  const wit = parseWit(`// interface storage { fake: func(); }
    interface clipboard { read-text: func(); }
    interface secrets { set: func(); }
    interface process { exec: func(); }
    interface ai { generate-text: func(); }
    interface unused { fake: func(); }
    world plugin { import clipboard; import secrets; import process; import ai;
      export init: func(); }`)
  assert.ok(wit.has("clipboard.readText"))
  assert.ok(wit.has("secrets.store"))
  assert.ok(wit.has("shell.execute"))
  assert.ok(wit.has("ai.generateText"))
  assert.ok(!wit.has("ai.chat"))
  assert.ok(!wit.has("unused.fake"))
  assert.ok(!wit.has("plugin.init"))
})

test("layer defaults, resource effects, per-method rules and reasoned overrides", () => {
  assert.equal(classifyLayer(ns("storage", []), method("storage", "set")).layer, "host")
  assert.equal(classifyLayer(ns("ui", []), method("ui", "showToast")).layer, "ui")
  const registration = classifyLayer(
    ns("contextPanels", []),
    method("contextPanels", "register", {
      resourceEffect: { kind: "returned-disposer" },
    })
  )
  assert.equal(registration.layer, "both")
  assert.ok(registration.layerReason)
  const routed = classifyLayer(ns("shell", []), method("shell", "open"))
  assert.equal(routed.layer, "ui")
  assert.ok(routed.layerReason)
  assert.deepEqual(
    classifyLayer(ns("storage", []), method("storage", "get"), {
      "storage.get": { layer: "both", reason: "Fixture projection" },
    }),
    { layer: "both", layerReason: "Fixture projection" }
  )
  assert.throws(
    () =>
      classifyLayer(ns("storage", []), method("storage", "get"), {
        "storage.get": { layer: "ui", reason: "" },
      }),
    /reason/
  )
})

test("matrix retains metadata, method runtime override and per-namespace headless; Python requires both ends", () => {
  const catalog = {
    apiNamespaces: [
      ns("storage", ["get", "set", "absent", "blocked"], {
        methods: [
          method("storage", "get"),
          method("storage", "set", { runtimes: ["frontend"] }),
          method("storage", "absent"),
          method("storage", "blocked", { resourceEffect: { kind: "returned-disposer" } }),
        ],
      }),
      ns("ui", ["showToast"], { platforms: ["desktop"] }),
    ],
  }
  const rows = buildMatrix({
    catalog,
    tsProvider: () => ({ value: "yes", reason: "fixture factory" }),
    python: {
      exposed: ["storage.get", "storage.blocked"],
      routed: ["storage.get"],
      refused: ["storage.blocked"],
    },
    currentWit: new Set(["storage.get"]),
    frozenWit: new Set(),
    calls: [
      {
        id: "ui.showToast",
        plugin: "py-plugin",
        path: "plugins/py/main.py",
        line: 1,
        column: 1,
        execution: "host",
      },
    ],
  })
  assert.equal(rows.length, 5)
  assert.deepEqual(rows[0].requiredPermissions, ["storage:read"])
  assert.equal(rows[0].stability, "stable")
  assert.equal(rows[0].enforcement, "shadow")
  assert.equal(rows[0].risk, "low")
  assert.equal(rows[0].consentTier, "none")
  assert.equal(rows[0].headless, true)
  assert.equal(rows[0].providedPython, "yes")
  assert.equal(rows[0].providedWasm, "yes")
  assert.equal(rows[0].frozenWasm, "no")
  assert.equal(rows[1].providedPython, "n/a")
  assert.deepEqual(rows[1].runtimesDeclared, ["frontend"])
  assert.equal(rows[2].providedPython, "declared-only")
  assert.equal(rows[3].providedPython, "no")
  assert.ok(rows[3].notes.some((note) => note.includes("explicitly refuses")))
  assert.equal(rows[4].headless, false)
  assert.equal(rows[4].hostSideUiCall, true)
  assert.equal(rows[4].firstPartyCallers, 1)
  assert.deepEqual(rows[4].firstPartyPlugins, ["py-plugin"])
  assert.equal(summarize(rows).methodsTotal, 5)
})

test("duplicate ids and stale layer overrides fail instead of silently dropping methods", () => {
  assert.throws(
    () => buildMatrix({ catalog: { apiNamespaces: [ns("storage", ["get", "get"])] } }),
    /Duplicate/
  )
  assert.throws(
    () =>
      buildMatrix({
        catalog: { apiNamespaces: [ns("storage", ["get"])] },
        overrides: { "storage.missing": { layer: "host", reason: "stale" } },
      }),
    /Stale/
  )
})

test("Python catalog proxy uses its actual mirror, method runtime filters and router callback refusal", (t) => {
  const catalog = {
    contractVersion: "fixture",
    apiNamespaces: [
      ns("storage", ["get", "absent", "blocked"], {
        methods: [
          method("storage", "get"),
          method("storage", "absent"),
          method("storage", "blocked", { resourceEffect: { kind: "returned-disposer" } }),
        ],
      }),
    ],
  }
  const mirror = structuredClone(catalog.apiNamespaces)
  mirror[0].methods = mirror[0].methods.filter((m) => m.name !== "absent")
  const root = fixture(t, {
    "packages/plugin-contract/contract/catalog.json": catalog,
    "lib/plugin/core/context.ts":
      "function createFullPluginContext() { return { storage: { get() {}, absent() {}, blocked() {} } }; }",
    "lib/plugin/python/host-request-router.ts": `const PLUGIN_API_NAMESPACE_CONTRACTS = [];
      function routePythonHostRequest(frame, getContext) {
        const namespace = PLUGIN_API_NAMESPACE_CONTRACTS.find(n => n.id === frame.method);
        if (namespace.resourceEffect.kind === 'returned-disposer') throw Error('refused');
        const holder = getContext(); const fn = holder[frame.method]; return fn.apply(holder, []);
      }`,
    "plugin-sdk/python/src/cognia/ctx.py": `from ._generated_contract import API_NAMESPACE_CONTRACTS
def _python_namespaces():
    return {n['id']: {m['name'] for m in n['methods'] if 'python' in m.get('runtimes', n['runtimes'])} for n in API_NAMESPACE_CONTRACTS if 'python' in n['runtimes']}
PYTHON_HOST_NAMESPACES = _python_namespaces()
class HostNamespace:
    def __getattr__(self, name):
        return self.runtime.host_call(name)
class Ctx:
    def __getattr__(self, namespace):
        return HostNamespace()
ctx = Ctx()
`,
    "plugin-sdk/python/src/cognia/_generated_contract.py": `API_NAMESPACE_CONTRACTS = ${JSON.stringify(mirror)}`,
    "packages/plugin-sdk/wit/cognia-plugin.wit": "world p {}",
    "crates/cognia-plugin-runtime/frozen/v0_1/cognia-plugin.wit": "world p {}",
    "scripts/gates/convergence/plugin-api-layer-overrides.json": {},
  })
  const { rows } = generate(root)
  assert.equal(rows.find((r) => r.method === "get").providedPython, "yes")
  assert.equal(rows.find((r) => r.method === "absent").providedPython, "declared-only")
  assert.equal(rows.find((r) => r.method === "blocked").providedPython, "no")
})

test("host placement follows activation/tool helpers across imports; rendered views stay client; unknown stays unclear", (t) => {
  const root = fixture(t, {
    "plugins/p/plugin.json": { id: "placement", type: "frontend", main: "src/index.tsx" },
    "plugins/p/src/index.tsx": `import { helper } from './helper';
      export default { activate(ctx) { helper(ctx); ctx.ui.showToast('activation');
        const View = () => <button onClick={() => ctx.ui.showToast('view')}>Hi</button>;
        return { tools: [{ execute() { ctx.ui.showDialog('tool'); } }] };
      }};`,
    "plugins/p/src/helper.ts": `export function helper(ctx) { ctx.ui.showToast('helper'); }`,
    "plugins/p/src/unknown.ts": `export function mystery(ctx) { ctx.ui.showDialog('unknown'); }`,
  })
  const catalog = { apiNamespaces: [ns("ui", ["showToast", "showDialog"])] }
  const calls = scanPluginSources(root, catalog)
  assert.equal(calls.filter((c) => c.execution === "host").length, 3)
  assert.equal(calls.filter((c) => c.execution === "client").length, 1)
  assert.equal(calls.filter((c) => c.execution === "unclear").length, 1)
  const rows = buildMatrix({ catalog, calls })
  assert.ok(rows.every((row) => row.hostSideUiCall === true))
  const unknown = buildMatrix({ catalog, calls: calls.filter((c) => c.execution === "unclear") })
  assert.equal(unknown.find((row) => row.method === "showDialog").hostSideUiCall, "unclear")
  const clientOnly = buildMatrix({ catalog, calls: calls.filter((c) => c.execution === "client") })
  assert.equal(clientOnly.find((row) => row.method === "showToast").hostSideUiCall, false)
})

test("regeneration preserves prose; deterministic tables contain all rows and evidence", () => {
  const rows = buildMatrix({ catalog: { apiNamespaces: [ns("storage", ["get"])] } })
  const prose = "# Custom note\n\nHand-written purpose.\n\n"
  const note = renderNote(prose + "<!-- generated:start -->\nstale\n<!-- generated:end -->\n", rows)
  assert.ok(note.startsWith(prose))
  assert.ok(note.includes("storage.get"))
  assert.ok(!note.includes("stale"))
  assert.equal(renderNote(note, rows), note)
})

test("CLI writes the gitignored JSON, checks only the committed note, and rejects unknown flags", (t) => {
  const root = fixture(t, {
    "packages/plugin-contract/contract/catalog.json": {
      contractVersion: "fixture",
      apiNamespaces: [ns("storage", ["get"])],
    },
    "lib/plugin/core/context.ts":
      "function createFullPluginContext() { return { storage: { get() {} } }; }",
    "plugin-sdk/python/src/cognia/ctx.py":
      "from .storage import Storage\nclass Ctx:\n    def __init__(self): self.storage = Storage()\nctx = Ctx()\n",
    "plugin-sdk/python/src/cognia/storage.py":
      "class Storage:\n    async def get(self): return 'fixture'\n",
    "lib/plugin/python/host-request-router.ts":
      "function route(frame) { switch(frame.method) { case 'storage.get': return ctx.storage.get(); } }",
    "packages/plugin-sdk/wit/cognia-plugin.wit":
      "interface storage { get: func(); } world p { import storage; }",
    "crates/cognia-plugin-runtime/frozen/v0_1/cognia-plugin.wit": "world p {}",
    "scripts/gates/convergence/plugin-api-layer-overrides.json": {},
    "docs/research/plugin-api-matrix-2026-11-01.md": "# Fixture\n\nPreserve this.\n",
  })
  t.mock.method(console, "log", () => {})
  t.mock.method(console, "error", () => {})
  const run = (...args) => {
    try {
      return { status: main(args, root) }
    } catch {
      return { status: 1 }
    }
  }
  assert.equal(run("--write").status, 0)
  const output = ".cache/convergence/plugin-api-matrix.json"
  const rows = JSON.parse(root.files.get(output))
  assert.equal(rows.length, 1)
  assert.equal(rows[0].providedPython, "yes")
  assert.equal(run("--check").status, 0)
  // The JSON is a regenerated by-product, not a committed snapshot.
  root.files.set(output, "[]\n")
  assert.equal(run("--check").status, 0)
  root.files.delete(output)
  assert.equal(run("--check").status, 0)
  assert.equal(run("--write").status, 0)
  const note = "docs/research/plugin-api-matrix-2026-11-01.md"
  root.files.set(note, root.files.get(note).replace("storage.get", "wrong.get"))
  assert.equal(run("--check").status, 1)
  assert.equal(run("--invalid").status, 1)
})

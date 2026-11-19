// Characterize observed defects without changing production code or installing servers.
// Run from the repository root: node --test docs/evidence/2026-11-08-lsp-code-index-support-audit.probes.mjs
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import test from "node:test"
import { createLspResolver } from "../../sidecar/src/services/lsp/resolver.ts"
import { makeLazyLspResolver } from "../../sidecar/src/services/lsp/lazy-resolver.ts"
import { createLspTools } from "../../sidecar/src/tools/builtin/lsp/index.ts"
import { wrapDefsWithConfinement } from "../../sidecar/src/tools/middleware/confinement.ts"
import { classifyToolCallConfinement } from "../../sidecar/src/policy/confinement/classify.ts"
import { assertToolCallWithinRoots } from "../../sidecar/src/policy/confinement/enforce.ts"

function fixture(t, { ensureCommand = (c) => c, overrides = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cognia-lsp-audit-"))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const opened = []
  const started = []
  const service = {
    async start(p) {
      started.push(p)
    },
    didOpen(p) {
      opened.push(p)
    },
    didChange() {},
    async request() {
      return null
    },
    async stop() {},
  }
  const resolver = createLspResolver({
    service,
    cwd: root,
    diagnosticsWaitMs: 0,
    ensureCommand,
    servers: [
      {
        id: "demo",
        command: "fake-server",
        extensions: [".ts", ".tsx", ".py", ".rs"],
        ...overrides,
      },
    ],
  })
  t.after(() => resolver.dispose())
  const file = path.join(root, "main.ts")
  fs.writeFileSync(file, "const a = 1")
  return { root, file, resolver, opened, started }
}

test("observed: agent sends extensions as languageId", async (t) => {
  const f = fixture(t)
  for (const ext of ["ts", "tsx", "py", "rs"]) {
    const file = path.join(f.root, `main.${ext}`)
    fs.writeFileSync(file, "")
    await f.resolver.touchFile(file)
  }
  assert.deepEqual(
    f.opened.map((p) => p.languageId),
    ["ts", "tsx", "py", "rs"]
  )
  assert.notDeepEqual(
    f.opened.map((p) => p.languageId),
    ["typescript", "typescriptreact", "python", "rust"]
  )
})

test("observed: agent drops transport, timeout, memory and workspace substitution", async (t) => {
  const f = fixture(t, {
    overrides: {
      transport: "socket",
      endpoint: "tcp://127.0.0.1:5007",
      startupTimeout: 1234,
      memoryLimitMb: 321,
      args: ["${workspaceFolder}/config"],
    },
  })
  await f.resolver.touchFile(f.file)
  assert.equal(f.started[0].transport, "stdio")
  assert.equal(f.started[0].endpoint, undefined)
  assert.equal(f.started[0].startupTimeout, undefined)
  assert.equal(f.started[0].memoryLimitMb, undefined)
  assert.equal(f.started[0].args[0], "${workspaceFolder}/config")
})

test("observed: missing server is reported as No diagnostics", async (t) => {
  const f = fixture(t, { ensureCommand: () => null })
  const tool = createLspTools(f.resolver).find((tool) => tool.name === "lsp_diagnostics")
  const result = await tool.handler({ file: f.file })
  assert.equal(result.isError, undefined)
  assert.equal(result.content[0].text, "No diagnostics.")
  assert.equal(f.started.length, 0)
})

test("observed: diagnostics cache survives a new document generation without new publish", async (t) => {
  const f = fixture(t)
  await f.resolver.touchFile(f.file)
  f.resolver.ingestDiagnostics({
    uri: pathToFileURL(f.file).href,
    diagnostics: [{ message: "old error", severity: 1 }],
  })
  fs.writeFileSync(f.file, "const a = 2")
  assert.deepEqual(await f.resolver.getDiagnostics(f.file), [{ message: "old error", severity: 1 }])
})

test("observed: first missing binary prevents all later resolution in same session", async (t) => {
  let calls = 0
  let available = false
  const f = fixture(t, {
    ensureCommand: () => {
      calls++
      return available ? "fake-server" : null
    },
  })
  assert.deepEqual(await f.resolver.touchFile(f.file), [])
  available = true
  assert.deepEqual(await f.resolver.touchFile(f.file), [])
  assert.equal(calls, 1)
})

test("observed: null LSP host creation is cached without retry", async () => {
  let calls = 0
  const host = makeLazyLspResolver(
    { sendOptions: { cwd: process.cwd(), lsp: { enabled: true } }, log() {} },
    async () => {
      calls++
      return null
    }
  )
  await assert.rejects(host.lspResolver.request("main.ts", "hover"), /LSP host unavailable/)
  await assert.rejects(host.lspResolver.request("main.ts", "hover"), /LSP host unavailable/)
  assert.equal(calls, 1)
  host.dispose()
})

test("observed: LSP file argument bypasses protected-path classification and backstop", async (t) => {
  const f = fixture(t)
  const protectedFile = path.join(f.root, ".ssh", "fixture.ts")
  fs.mkdirSync(path.dirname(protectedFile))
  fs.writeFileSync(protectedFile, "const fixtureOnlySecret = 123")
  const policy = { enabled: true, roots: [f.root] }
  assert.equal(
    classifyToolCallConfinement(policy, "read", { file_path: protectedFile }, f.root),
    "deny"
  )
  assert.equal(
    classifyToolCallConfinement(policy, "lsp_hover", { file: protectedFile }, f.root),
    null
  )
  const scope = { writableRoots: [f.root], network: false }
  assert.throws(
    () => assertToolCallWithinRoots(scope, "read", { file_path: protectedFile }, f.root),
    /sandbox refused/
  )
  const defs = wrapDefsWithConfinement(createLspTools(f.resolver), scope, f.root)
  const result = await defs
    .find((tool) => tool.name === "lsp_hover")
    .handler({ file: protectedFile, line: 1, character: 1 })
  assert.equal(result.isError, undefined)
  assert.equal(f.opened[0].text, "const fixtureOnlySecret = 123")
})

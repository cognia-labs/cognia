// Reproduce the additional correctness gaps from the 2026-11-09 review.
import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"
import { createIndexService } from "../../sidecar/src/services/code-graph/index-service.ts"
import { createLspResolver } from "../../sidecar/src/services/lsp/resolver.ts"
import { buildServers } from "../../sidecar/src/services/lsp/servers.ts"
import { createCodeGraphTools } from "../../sidecar/src/tools/builtin/code-graph/tools.ts"

async function tempRoot(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "cognia-lsp-review-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}

test("a normal edit can pair an old indexed symbol with newer source", async (t) => {
  const root = await tempRoot(t)
  const file = path.join(root, "main.ts")
  await writeFile(file, "export function previous() { return 1 }\n")
  const index = createIndexService({ root, forceMemory: true, now: () => 1000 })
  t.after(() => index.dispose())
  await index.ensureIndexed()
  const node = index.search("previous").find((row) => row.name === "previous")
  assert.ok(node)
  await writeFile(file, "export function current() { return 2 }\n")
  const tool = createCodeGraphTools(index).find((tool) => tool.name === "codegraph_node")
  const result = await tool.handler({ target: node.id })
  assert.equal(result.isError, undefined)
  const output = JSON.parse(result.content[0].text)
  assert.equal(output.name, "previous")
  assert.match(output.source, /function current\(/)
  assert.equal(index.stalenessBanner(), "")
})

test("native SQLite preserves broken incoming edges across a warm reopen", async (t) => {
  const root = await tempRoot(t)
  const a = path.join(root, "a.ts")
  await writeFile(a, "export function target() { return 1 }\n")
  await writeFile(
    path.join(root, "b.ts"),
    'import { target } from "./a"\nexport function caller() { return target() }\n'
  )
  let now = 1000
  let index = createIndexService({ root, now: () => now })
  t.after(() => index.dispose())
  await index.ensureIndexed()
  if (index.binding !== "sqlite") return t.skip("native SQLite unavailable")
  const callers = () => {
    const node = index.search("target").find((row) => row.name === "target")
    assert.ok(node)
    return index.callers(node.id).map((row) => row.node.name)
  }
  assert.deepEqual(callers(), ["caller"])
  await writeFile(a, "// line shift\nexport function target() { return 1 }\n")
  now += 2000
  assert.equal(await index.syncStale(), 1)
  assert.deepEqual(callers(), [])
  index.dispose()
  index = createIndexService({ root, now: () => now })
  await index.ensureIndexed()
  assert.equal(index.binding, "sqlite")
  assert.deepEqual(callers(), [])
})

test("the first matching server can mask a second server's provider", async (t) => {
  const root = await tempRoot(t)
  const file = path.join(root, "main.ts")
  await writeFile(file, "export const answer = 42\n")
  const started = []
  const requested = []
  const resolver = createLspResolver({
    cwd: root,
    ensureCommand: (command) => command,
    servers: [
      { id: "lint", command: "test-lint", extensions: [".ts"] },
      { id: "typescript", command: "test-ts", extensions: [".ts"] },
    ],
    service: {
      async start({ serverId }) {
        started.push(serverId.split("#")[0])
      },
      didOpen() {},
      didChange() {},
      async request({ serverId }) {
        const id = serverId.split("#")[0]
        requested.push(id)
        if (id === "lint") throw new Error("Method not found")
        return { contents: "const answer: 42" }
      },
      stop() {},
    },
  })
  t.after(() => resolver.dispose())
  await assert.rejects(resolver.request(file, "hover"), /Method not found/)
  assert.deepEqual(started, ["lint", "typescript"])
  assert.deepEqual(requested, ["lint"])
})

test("one malformed extensions field aborts construction of all servers", () => {
  assert.throws(
    () =>
      buildServers([
        { id: "valid", command: "test-ts", extensions: [".ts"] },
        { id: "invalid", command: "test-invalid", extensions: ".rs" },
      ]),
    /map is not a function/
  )
})

test("a versioned diagnostic can become stale while waiting in the debounce buffer", async () => {
  const { buildSync } = createRequire(new URL("../../sidecar/package.json", import.meta.url))(
    "esbuild"
  )
  const { outputFiles } = buildSync({
    entryPoints: [
      fileURLToPath(
        new URL("../../sidecar/vscode-ext-host/src/lsp-diagnostics-buffer.ts", import.meta.url)
      ),
    ],
    format: "esm",
    write: false,
  })
  const { DiagnosticsBuffer } = await import(
    `data:text/javascript;base64,${Buffer.from(outputFiles[0].contents).toString("base64")}`
  )
  let flush
  const emitted = []
  const buffer = new DiagnosticsBuffer((_key, params) => emitted.push(params.version), {
    setTimeout(cb) {
      flush = cb
      return 1
    },
    clearTimeout() {
      flush = undefined
    },
  })
  const uri = "file:///fixture/main.ts"
  buffer.ingest("owner:server", { uri, version: 1, diagnostics: [] }, 1)
  // The next version arrives after a v2 edit. Rejecting this stale frame leaves
  // the older pending v1 frame untouched, and didChange does not cancel it.
  buffer.ingest("owner:server", { uri, version: 1, diagnostics: [] }, 2)
  flush()
  assert.deepEqual(emitted, [1])
  buffer.dispose()
})

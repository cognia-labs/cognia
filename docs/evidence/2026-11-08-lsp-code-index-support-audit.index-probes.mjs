// Diagnostic probes: assert the current defects, rather than desired behavior.
// Run from the repository root with Node 26+.
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createIndexService } from "../../sidecar/src/services/code-graph/index-service.ts"

process.env.CODEGRAPH_WATCH_DEBOUNCE_MS = "100"
const outer = await fs.mkdtemp(path.join(os.tmpdir(), "cognia-index-audit-"))
const report = []
const services = []
try {
  let clock = 10000
  const root = path.join(outer, "freshness")
  await fs.mkdir(root)
  await fs.writeFile(path.join(root, "a.ts"), "export function target(){return 1}\n")
  await fs.writeFile(
    path.join(root, "b.ts"),
    "import {target} from './a'; export function caller(){return target()}\n"
  )
  const svc = createIndexService({ root, forceMemory: true, now: () => clock })
  services.push(svc)
  await svc.ensureIndexed()
  let target = svc.search("target").find((n) => n.name === "target")
  const before = svc.callers(target.id).map((r) => r.node?.name)
  assert.ok(before.includes("caller"))
  await fs.writeFile(path.join(root, "a.ts"), "// shift line\nexport function target(){return 1}\n")
  clock += 2000
  await svc.syncStale()
  target = svc.search("target").find((n) => n.name === "target")
  const after = svc.callers(target.id).map((r) => r.node?.name)
  assert.equal(after.length, 0)
  report.push({
    case: "cross-file-line-shift",
    before,
    after,
    unresolved: svc.status().unresolvedCount,
  })

  await fs.writeFile(
    path.join(root, "a.ts"),
    "/*" + "x".repeat(5 * 1024 * 1024) + "*/\nexport function replacedAfterOversize(){}"
  )
  clock += 2000
  await svc.syncStale()
  const stale = svc.search("target").some((n) => n.name === "target")
  const newSymbol = svc
    .search("replacedAfterOversize")
    .some((n) => n.name === "replacedAfterOversize")
  assert.equal(stale, true)
  assert.equal(newSymbol, false)
  assert.equal(svc.stalenessBanner(), "")
  report.push({
    case: "oversize-source-stale-graph",
    stale,
    newSymbol,
    banner: svc.stalenessBanner(),
  })

  const watchRoot = path.join(outer, "watch")
  await fs.mkdir(path.join(watchRoot, "ignored"), { recursive: true })
  await fs.writeFile(path.join(watchRoot, ".gitignore"), "ignored/\n")
  await fs.writeFile(path.join(watchRoot, "visible.ts"), "export function visible(){}")
  await fs.writeFile(
    path.join(watchRoot, "ignored", "private.ts"),
    "export function ignoredBefore(){}"
  )
  await fs.writeFile(
    path.join(outer, "outside.ts"),
    'export function outsideWorkspaceSecret(){ return "fixture-only" }'
  )
  // This is a direct, unconfined IndexService probe, not an OS-sandbox probe.
  const watcher = createIndexService({
    root: watchRoot,
    forceMemory: true,
    watch: true,
    now: () => 10000,
  })
  services.push(watcher)
  await watcher.ensureIndexed()
  assert.equal(watcher.status().watching, true, "requires supported recursive fs.watch")
  assert.equal(watcher.search("ignoredBefore").length, 0)
  await fs.writeFile(
    path.join(watchRoot, "ignored", "private.ts"),
    "export function ignoredAfter(){}"
  )
  await fs.symlink(path.join(outer, "outside.ts"), path.join(watchRoot, "link.ts"))
  await new Promise((resolve) => setTimeout(resolve, 350))
  await watcher.syncStale()
  const ignored = watcher.search("ignoredAfter").find((n) => n.name === "ignoredAfter")
  const outside = watcher
    .search("outsideWorkspaceSecret")
    .find((n) => n.name === "outsideWorkspaceSecret")
  assert.ok(ignored)
  assert.ok(outside)
  assert.match(watcher.snippetFor(outside), /fixture-only/)
  report.push({
    case: "watch-discovery-policy-drift",
    ignoredFile: ignored.file_path,
    externalSymlink: outside.file_path,
    externalSource: watcher.snippetFor(outside),
    sandboxTested: false,
  })

  console.log(JSON.stringify(report, null, 2))
} finally {
  for (const service of services) service.dispose()
  await fs.rm(outer, { recursive: true, force: true })
}

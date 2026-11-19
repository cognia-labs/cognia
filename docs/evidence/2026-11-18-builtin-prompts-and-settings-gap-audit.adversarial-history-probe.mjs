/**
 * Isolated chronology counterexample and control. Actual persistence module,
 * Dexie transactions and fake-indexeddb; only getDb, clock and ID randomness
 * are injected. Minimal table indexes match CogniaDB. No user DB or network.
 * Run: node docs/evidence/2026-11-18-builtin-prompts-and-settings-gap-audit.adversarial-history-probe.mjs
 */
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"
import path from "node:path"
import vm from "node:vm"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const require = createRequire(path.join(root, "package.json"))
require("fake-indexeddb/auto")
const Dexie = require("dexie").default
const ts = require("typescript")
const db = new Dexie("audit-prompt-history-isolated")
db.version(1).stores({
  promptOverrides: "&id, promptId, &[promptId+scope+targetId], updatedAt",
  promptOverrideRevisions: "&id, bindingId, promptId, createdAt",
})
let clock = 1800000000000
class ProbeDate extends Date {
  static now() {
    return clock
  }
}
const random = [0.5, 0.9, 0.1, 0.6, 0.8, 0.2]
const math = Object.create(Math)
math.random = () => {
  assert.ok(random.length, "all generated IDs have an explicit fixture")
  return random.shift()
}
const module = { exports: {} }
vm.runInNewContext(
  ts.transpileModule(readFileSync(path.join(root, "lib/db/prompt-overrides.ts"), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText,
  {
    module,
    exports: module.exports,
    Date: ProbeDate,
    Math: math,
    require: (id) => {
      assert.equal(id, "./schema")
      return { getDb: () => db }
    },
  }
)
const storage = module.exports
const input = (promptId, mutationId, expectedRev) => ({
  promptId,
  mutationId,
  expectedRev,
  target: { scope: "account", targetId: "" },
  origin: "editor",
  body: "Fixture",
  contractVersion: 1,
  baseDigest: "fixture",
  now: clock,
})
try {
  await db.open()
  const first = await storage.publishPromptOverride(input("same-ms", "publish", 0))
  const second = await storage.resetPromptOverride(input("same-ms", "reset", first.rev))
  const rows = await storage.listPromptOverrideRevisions(first.id)
  assert.equal(rows[0].kind, "published")
  assert.equal(rows[1].kind, "reset")
  assert.equal(rows[1].parentId, rows[0].id)
  assert.equal(second.rev, 2)
  assert.equal(second.activeRevisionId, null)
  console.log(
    JSON.stringify({
      probe: "history-same-ms",
      chronological: ["published", "reset"],
      returnedNewestFirst: Array.from(rows, (row) => row.kind),
      parentLinkConfirmsChronology: true,
      activePointerCorrect: true,
    })
  )

  const control = await storage.publishPromptOverride(input("different-ms", "publish", 0))
  clock += 1
  await storage.resetPromptOverride(input("different-ms", "reset", control.rev))
  const controlRows = await storage.listPromptOverrideRevisions(control.id)
  assert.equal(controlRows[0].kind, "reset")
  console.log(
    JSON.stringify({
      probe: "history-different-ms-control",
      returnedNewestFirst: Array.from(controlRows, (row) => row.kind),
    })
  )
} finally {
  await db.delete()
}

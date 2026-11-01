import { test } from "node:test"
import ts from "typescript"
import { runInNewContext } from "node:vm"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import {
  createContext,
  detectRunTables,
  detectRuntimeInitializers,
  detectCaps,
  manualQueueCandidate,
} from "./convergence/counter.mjs"
import { compareRatchet, readConfig } from "./check-baseline-growth.mjs"
import {
  main,
  reconcileInventory,
  rewriteInventory,
  computeMetrics,
  INVENTORIES,
} from "./check-convergence.mjs"

function fixture(t, files = {}) {
  const root = mkdtempSync(join(tmpdir(), "convergence-gate-"))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const write = (file, source) => {
    mkdirSync(dirname(join(root, file)), { recursive: true })
    writeFileSync(join(root, file), source)
  }
  for (const [file, source] of Object.entries(files)) write(file, source)
  return { root, write, ctx: createContext(root) }
}
const envelope = (name, members = [], excluded = []) => ({
  inventory: name,
  description: "Fixture inventory",
  generatedAt: { commit: "fixture", date: "2026-11-01" },
  metrics: computeMetrics(name, members),
  members,
  excluded,
})
const cap = {
  key: "lib/cap.ts#DEFAULT_CONCURRENCY",
  file: "lib/cap.ts",
  symbol: "DEFAULT_CONCURRENCY",
  owner: "lib/cap",
  note: "Confirmed admission cap",
  value: 2,
  language: "typescript",
  segment: "business",
  evidence: "0123456789abcdef",
}
function output() {
  const lines = []
  return { lines, log: (line) => lines.push(line), error: (line) => lines.push(line) }
}
function save(f, name, data) {
  f.write(`scripts/gates/convergence/inventories/${name}.json`, JSON.stringify(data))
}

test("new member is added debt and fails", (t) => {
  const { ctx } = fixture(t)
  const report = reconcileInventory("caps", [cap], envelope("caps"), ctx)
  assert.equal(report.ok, false)
  assert.deepEqual(report.added, [cap.key])
})
test("repaid member fails with baseline lock hint", (t) => {
  const f = fixture(t),
    out = output()
  save(f, "caps", envelope("caps", [cap]))
  assert.equal(main(["--root", f.root, "--inventory", "caps"], out), 1)
  assert.match(out.lines.join("\n"), /repaid — run `pnpm audit:convergence:baseline` to lock it in/)
})
test("baseline adds empty note, removes repaid, preserves owner, note and editorial fields", (t) => {
  const f = fixture(t, { "lib/cap.ts": "const DEFAULT_CONCURRENCY = 2; const MAX_PARALLEL = 3" })
  save(
    f,
    "caps",
    envelope("caps", [
      {
        ...cap,
        owner: "hand-owner",
        note: "Human confirmed this admission decision",
        phase: "phase-1",
      },
      { ...cap, key: "lib/gone.ts#OLD", symbol: "OLD" },
    ])
  )
  assert.equal(main(["--root", f.root, "--inventory", "caps", "--write-baseline"], output()), 0)
  const written = JSON.parse(
    readFileSync(join(f.root, "scripts/gates/convergence/inventories/caps.json"))
  )
  assert.equal(written.members.length, 2)
  assert.equal(written.members[0].owner, "hand-owner")
  assert.equal(written.members[0].phase, "phase-1")
  assert.equal(written.members[0].note, "Human confirmed this admission decision")
  assert.equal(written.members[1].note, "")
  assert.deepEqual(written.metrics, { members: 2, business: 1, native: 0, unclassified: 1 })
  assert.match(written.generatedAt.date, /^\d{4}-\d{2}-\d{2}$/)
  const out = output()
  assert.equal(main(["--root", f.root, "--inventory", "caps"], out), 1)
  assert.match(out.lines.join("\n"), /missing note/)
})
test("stale exclusion fails and baseline removes it", (t) => {
  const f = fixture(t),
    baseline = envelope(
      "caps",
      [],
      [{ key: cap.key, reason: "Explicit native resource lifecycle decision" }]
    )
  const report = reconcileInventory("caps", [], baseline, f.ctx)
  assert.equal(report.ok, false)
  assert.deepEqual(report.stale, [cap.key])
  assert.deepEqual(rewriteInventory("caps", [], baseline, {}, f.ctx).excluded, [])
})
test("short exclusion reason fails", (t) => {
  const { ctx } = fixture(t)
  const report = reconcileInventory(
    "caps",
    [cap],
    envelope("caps", [], [{ key: cap.key, reason: "short" }]),
    ctx
  )
  assert.match(report.invalid.join("\n"), /at least 20 characters/)
})
test("duplicate keys fail across members and exclusions", (t) => {
  const { ctx } = fixture(t)
  for (const baseline of [
    envelope("caps", [cap, cap]),
    envelope("caps", [cap], [{ key: cap.key, reason: "Long enough exclusion reason for fixture" }]),
  ])
    assert.match(
      reconcileInventory("caps", [cap], baseline, ctx).invalid.join("\n"),
      /duplicate key/
    )
})
test("missing owner and note fail", (t) => {
  const { ctx } = fixture(t)
  const report = reconcileInventory(
    "caps",
    [cap],
    envelope("caps", [{ ...cap, owner: "", note: "" }]),
    ctx
  )
  assert.match(report.invalid.join("\n"), /missing owner/)
  assert.match(report.invalid.join("\n"), /missing note/)
})
test("native caps require a resource; native with resource and business pass", (t) => {
  const { ctx } = fixture(t)
  for (const [row, expected] of [
    [{ ...cap, segment: "native" }, false],
    [{ ...cap, segment: "native", resource: "Python host process slots" }, true],
    [cap, true],
  ])
    assert.equal(reconcileInventory("caps", [cap], envelope("caps", [row]), ctx).ok, expected)
})
test("run reference drift fails and a justified override survives rewrites", (t) => {
  const f = fixture(t, {
    "lib/db.ts": `import Dexie, {Table} from "dexie"; interface Row {runId: string};
    class DB extends Dexie {jobs!: Table<Row, string>; constructor(){super("a"); this.version(1).stores({jobs: "id"})}}`,
    "lib/writer.ts": "db.jobs.add(row)",
    "lib/db/execution-runs.ts": "export function createExecutionRun(id){}",
    "lib/bridge.ts":
      'import {createExecutionRun as ensureRun} from "./db/execution-runs";ensureRun(plan.id)',
  })
  const [candidate] = detectRunTables(f.ctx)
  const row = {
    ...candidate,
    reference: "real",
    note: "lib/bridge.ts:1 ties this row to its ledger run",
  }
  assert.match(
    reconcileInventory(
      "run-tables",
      [candidate],
      envelope("run-tables", [row]),
      f.ctx
    ).invalid.join("\n"),
    /reference drift/
  )
  const override = rewriteInventory(
    "run-tables",
    [candidate],
    envelope("run-tables", [{ ...row, referenceOverride: "real" }]),
    {},
    f.ctx,
    { all: true }
  ).members[0]
  assert.equal(
    reconcileInventory("run-tables", [candidate], envelope("run-tables", [override]), f.ctx).ok,
    true
  )
  assert.equal(
    rewriteInventory("run-tables", [candidate], envelope("run-tables", [override]), {}, f.ctx)
      .members[0].reference,
    "real"
  )
  assert.equal(
    reconcileInventory(
      "run-tables",
      [candidate],
      envelope("run-tables", [{ ...override, note: "short" }]),
      f.ctx
    ).ok,
    false
  )
})
test("manual durable queues must retain their file and symbol", (t) => {
  const f = fixture(t, { "lib/queue.ts": "export function persistQueue() {}" })
  const row = {
    key: "manual:queue",
    file: "lib/queue.ts",
    symbol: "persistQueue",
    owner: "lib/queue",
    note: "Confirmed durable file-backed queue",
    runner: "lib/queue.ts",
    retry: "none",
    idempotency: "none",
  }
  row.evidence = manualQueueCandidate(f.ctx, row).evidence
  assert.equal(
    reconcileInventory("durable-queues", [], envelope("durable-queues", [row]), f.ctx).ok,
    true
  )
  assert.equal(
    rewriteInventory("durable-queues", [], envelope("durable-queues", [row]), {}, f.ctx).members
      .length,
    1
  )
  for (const invalid of [
    { ...row, symbol: "gone" },
    { ...row, file: "lib/gone.ts" },
  ])
    assert.match(
      reconcileInventory(
        "durable-queues",
        [],
        envelope("durable-queues", [invalid]),
        f.ctx
      ).invalid.join("\n"),
      /manual queue file\/symbol vanished/
    )
})
test("metrics cover all seven inventories and type-only imports", () => {
  assert.deepEqual(
    computeMetrics("runtime-initializers", [
      { initializer: "a" },
      { initializer: "a" },
      { initializer: "b" },
    ]),
    { members: 3, initializers: 2, pending: 0 }
  )
  assert.deepEqual(
    computeMetrics("lib-store-imperative", [
      { imports: ["static"] },
      { imports: ["dynamic"] },
      { imports: ["static", "dynamic"] },
    ]),
    { static: 2, all: 3 }
  )
  assert.deepEqual(
    computeMetrics("lib-ui-imports", [
      { imports: ["static"], typeOnly: true },
      { imports: ["dynamic"] },
      { imports: ["static"], typeOnly: false },
    ]),
    { static: 2, all: 3, staticExcludingTypeOnly: 1 }
  )
  assert.deepEqual(
    computeMetrics("durable-queues", [
      { key: "dexie:x" },
      { key: "sqlite:x" },
      { key: "manual:x" },
    ]),
    { members: 3, dexie: 1, sqlite: 1, manual: 1 }
  )
  assert.deepEqual(
    computeMetrics("run-tables", [
      { reference: "real" },
      { reference: "name-only" },
      { reference: "none" },
    ]),
    { members: 3, real: 1, nameOnly: 1, none: 1 }
  )
})
test("report and JSON are read-only, include metrics and unresolved rows, and exit zero", (t) => {
  const f = fixture(t, {
    "lib/db.ts":
      'import Dexie from "dexie"; const db = new Dexie("x"); db.version(1).stores({jobs: "id"})',
  })
  const out = output()
  assert.equal(
    main(["--root", f.root, "--inventory", "durable-queues", "--report", "--json"], out),
    0
  )
  const parsed = JSON.parse(out.lines[0])
  assert.equal(parsed.unresolvedRowTypes.length, 1)
  assert.equal(parsed.inventories["durable-queues"].added.length, 1)
  assert.ok(parsed.inventories["durable-queues"].metrics)
})
test("empty baseline writer creates all seven inventories and rejects bad flags", (t) => {
  const f = fixture(t)
  assert.equal(main(["--root", f.root, "--write-baseline"], output()), 0)
  for (const name of Object.keys(INVENTORIES))
    assert.equal(
      JSON.parse(readFileSync(join(f.root, `scripts/gates/convergence/inventories/${name}.json`)))
        .inventory,
      name
    )
  assert.equal(main(["--root", f.root], output()), 0)
  assert.equal(main(["--inventory", "unknown"], output()), 1)
  assert.equal(main(["--unknown"], output()), 1)
})
test("baseline writer preserves a malformed inventory instead of erasing its notes", (t) => {
  const f = fixture(t),
    path = "scripts/gates/convergence/inventories/caps.json"
  const source = '{"members": ["hand-edited unfinished note"'
  f.write(path, source)
  assert.equal(main(["--root", f.root, "--inventory", "caps", "--write-baseline"], output()), 1)
  assert.equal(readFileSync(join(f.root, path), "utf8"), source)
})

test("metrics use current detections minus exclusions, never stale baseline facts", (t) => {
  const { ctx } = fixture(t)
  const baseline = envelope(
    "caps",
    [cap],
    [{ key: "excluded", reason: "An explicitly excluded mechanical default" }]
  )
  assert.equal(reconcileInventory("caps", [], baseline, ctx).metrics.members, 0)
  const report = reconcileInventory(
    "caps",
    [cap, { ...cap, key: "new", segment: undefined }, { ...cap, key: "excluded" }],
    baseline,
    ctx
  )
  assert.deepEqual(report.metrics, { members: 2, business: 1, native: 0, unclassified: 1 })
})
test("ambiguous detected identities fail including baseline writes", (t) => {
  const f = fixture(t, { "lib/a.ts": "function a(){pLimit(1);pLimit(2)}" })
  save(f, "caps", envelope("caps"))
  const out = output()
  assert.equal(main(["--root", f.root, "--inventory", "caps"], out), 1)
  assert.match(out.lines.join("\n"), /ambiguous key/)
  assert.equal(main(["--root", f.root, "--inventory", "caps", "--write-baseline"], output()), 1)
})
test("runtime root coverage requires every outside initializer, provider and host to be classified", (t) => {
  const f = fixture(t, { "components/new/new-host.tsx": "export function Host(){return null}" })
  save(f, "runtime-initializers", envelope("runtime-initializers"))
  const out = output()
  assert.equal(main(["--root", f.root, "--inventory", "runtime-initializers"], out), 1)
  assert.match(out.lines.join("\n"), /unlisted runtime root.*new-host/)
  f.write(
    "scripts/gates/convergence/runtime-roots.json",
    JSON.stringify({
      roots: [],
      notRuntime: [
        { file: "components/new/new-host.tsx", reason: "UI-only dialog mounting and presentation" },
      ],
    })
  )
  assert.equal(main(["--root", f.root, "--inventory", "runtime-initializers"], output()), 0)
})
test("renamed cap scope repays the old member and adds a new one", (t) => {
  const f = fixture(t, { "lib/a.ts": "function c(){const MAX_CONCURRENT=2}" })
  save(f, "caps", envelope("caps", [{ ...cap, key: "lib/a.ts#b/MAX_CONCURRENT" }]))
  const out = output()
  main(["--root", f.root, "--inventory", "caps", "--json"], out)
  const report = JSON.parse(out.lines[0]).inventories.caps
  assert.deepEqual(report.added, ["lib/a.ts#c/MAX_CONCURRENT"])
  assert.deepEqual(report.repaid, ["lib/a.ts#b/MAX_CONCURRENT"])
})

test("two same-line Rust limiter sites remain ambiguous", (t) => {
  const f = fixture(t, { "crates/x/src/lib.rs": "fn a(){Semaphore::new(1);Semaphore::new(2);}" })
  save(f, "caps", envelope("caps"))
  const out = output()
  assert.equal(main(["--root", f.root, "--inventory", "caps"], out), 1)
  assert.match(out.lines.join("\n"), /ambiguous key/)
})

function runtimeDecisionFixture(t, version = 2, changes = {}) {
  const file = "components/providers/initializers/a.tsx"
  const decisions = {
    version,
    initializers: {
      [file]: { symbols: ["skip"], reason: "Native subscription requires a renderer." },
    },
    uiOnly: {
      "@/lib/a": { symbols: ["layout"], reason: "Pure renderer layout normalization only." },
    },
    pendingCeiling: 1,
    pending: {
      [file]: {
        symbols: ["boot"],
        phase: "phase 1",
        reason: "Account maintenance has no brain owner. Move its timer to the registry.",
      },
    },
    ...changes,
  }
  const f = fixture(t, {
    "lib/a.ts": "export function boot(){};export function skip(){};export function layout(){}",
    [file]:
      'import {useEffect} from "react";import {boot,skip,layout} from "@/lib/a";useEffect(()=>{boot();skip();layout()},[])',
    "scripts/gates/headless-registry-exclusions.json": JSON.stringify(decisions),
  })
  const rows = detectRuntimeInitializers(f.ctx).map((r) => ({
    ...r,
    note: 'pending:phase 1 "Account maintenance has no brain owner." Account timer debt in lib/a.ts.',
  }))
  return { ...f, rows, file }
}
for (const version of [1, 2])
  test(`v${version} decisions exclude decisions and retain matched pending`, (t) => {
    const f = runtimeDecisionFixture(t, version)
    assert.deepEqual(
      f.rows.map((r) => r.symbol),
      ["boot"]
    )
    const report = reconcileInventory(
      "runtime-initializers",
      f.rows,
      envelope("runtime-initializers", f.rows),
      f.ctx
    )
    assert.equal(report.ok, true, report.invalid.join("\n"))
    assert.equal(report.metrics.pending, 1)
  })
test("v2 pending not detected fails as a detector miss, including baseline writes", (t) => {
  const f = runtimeDecisionFixture(t, 2, {
    pending: {
      "components/providers/initializers/missing.tsx": {
        symbols: ["lost"],
        phase: "phase 1",
        reason: "Account recovery requires a brain owner.",
      },
    },
  })
  save(f, "runtime-initializers", envelope("runtime-initializers", f.rows))
  const out = output()
  assert.equal(main(["--root", f.root, "--inventory", "runtime-initializers"], out), 1)
  assert.match(out.lines.join("\n"), /lost.*detector miss/)
  assert.equal(
    main(["--root", f.root, "--inventory", "runtime-initializers", "--write-baseline"], output()),
    1
  )
})
test("v2 unadjudicated initializer members fail", (t) => {
  const f = runtimeDecisionFixture(t, 2, { pending: {}, pendingCeiling: 0 })
  const report = reconcileInventory(
    "runtime-initializers",
    f.rows,
    envelope("runtime-initializers", f.rows),
    f.ctx
  )
  assert.match(report.invalid.join("\n"), /boot.*unadjudicated/)
})
test("v2 pending requires membership, phase-prefixed note and quoted first sentence", (t) => {
  const f = runtimeDecisionFixture(t)
  for (const note of [
    "Confirmed account timer debt in lib/a.ts.",
    "pending:phase 1 Account maintenance has no brain owner.",
  ]) {
    const report = reconcileInventory(
      "runtime-initializers",
      f.rows,
      envelope(
        "runtime-initializers",
        f.rows.map((r) => ({ ...r, note }))
      ),
      f.ctx
    )
    assert.match(report.invalid.join("\n"), /pending note/)
  }
  const report = reconcileInventory(
    "runtime-initializers",
    f.rows,
    envelope(
      "runtime-initializers",
      [],
      f.rows.map((r) => ({ ...r, reason: "Mistakenly excluded host-neutral debt." }))
    ),
    f.ctx
  )
  assert.match(report.invalid.join("\n"), /pending.*must be a member/)
  assert.equal(report.metrics.pending, 1)
})
test("v2 pending ceiling must match current detected pending symbols", (t) => {
  const f = runtimeDecisionFixture(t, 2, { pendingCeiling: 2 })
  const report = reconcileInventory(
    "runtime-initializers",
    f.rows,
    envelope("runtime-initializers", f.rows),
    f.ctx
  )
  assert.match(report.invalid.join("\n"), /pending ceiling.*1.*2/)
})
test("headless exclusions env override is a read-only verification aid", (t) => {
  const f = runtimeDecisionFixture(t, 1)
  const path = join(f.root, "decisions-v2.json")
  f.write(
    "decisions-v2.json",
    JSON.stringify({ version: 2, initializers: {}, pending: {}, pendingCeiling: 0 })
  )
  const previous = process.env.CONVERGENCE_HEADLESS_EXCLUSIONS
  try {
    process.env.CONVERGENCE_HEADLESS_EXCLUSIONS = path
    const ctx = createContext(f.root),
      rows = detectRuntimeInitializers(ctx)
    const report = reconcileInventory(
      "runtime-initializers",
      rows,
      envelope("runtime-initializers", rows),
      ctx
    )
    assert.match(report.invalid.join("\n"), /unadjudicated/)
  } finally {
    if (previous === undefined) delete process.env.CONVERGENCE_HEADLESS_EXCLUSIONS
    else process.env.CONVERGENCE_HEADLESS_EXCLUSIONS = previous
  }
  assert.equal(
    JSON.parse(readFileSync(join(f.root, "scripts/gates/headless-registry-exclusions.json")))
      .version,
    1
  )
})

// Second-model reproductions: the persisted decisions are part of the gate contract.
test("review2 #1 stale persisted metrics cannot hide business-cap growth from compareRatchet", (t) => {
  const f = fixture(t),
    second = { ...cap, key: "lib/other.ts#MAX_WORKERS", symbol: "MAX_WORKERS" }
  const base = envelope("caps", [cap]),
    head = { ...envelope("caps", [cap, second]), metrics: base.metrics }
  const report = reconcileInventory("caps", [cap, second], head, f.ctx)
  assert.equal(report.ok, false)
  assert.match(report.invalid.join("\n"), /invalid: metrics/)
  const policy = readConfig().ratchets.find((r) => r.file.endsWith("/caps.json"))
  const fixed = rewriteInventory("caps", [cap, second], head, {}, f.ctx)
  const growth = compareRatchet(policy, base, fixed).find((r) => r.key === "business")
  assert.equal(growth.delta, 1)
  assert.equal(growth.status, "grew")
  for (const metrics of [undefined, { ...fixed.metrics, unexpected: 0 }, { business: 2 }])
    assert.match(
      reconcileInventory("caps", [cap, second], { ...fixed, metrics }, f.ctx).invalid.join("\n"),
      /invalid: metrics/
    )
})
test("review2 #2 evidence changes invalidate both a member note and an exclusion reason", (t) => {
  const a = fixture(t, { "lib/a.ts": "const MAX_WORKERS = 2;" }),
    b = fixture(t, { "lib/a.ts": "const MAX_WORKERS = 4;" })
  const old = detectCaps(a.ctx).map((r) => ({
      ...r,
      segment: "business",
      note: "Two plugin loads share this process-wide worker gate.",
    })),
    now = detectCaps(b.ctx)
  assert.match(old[0].evidence ?? "", /^[a-f0-9]{16}$/)
  for (const baseline of [
    envelope("caps", old),
    envelope(
      "caps",
      [],
      old.map((r) => ({ ...r, reason: "Default for a separately inventoried process gate." }))
    ),
  ])
    assert.match(
      reconcileInventory("caps", now, baseline, b.ctx).invalid.join("\n"),
      /evidence changed — re-review note\/reason/
    )
})
test("review2 #2 baseline preserves reviewed evidence until explicit key reconfirmation", (t) => {
  const f = fixture(t, { "lib/a.ts": "const MAX_WORKERS = 2;" })
  const [row] = detectCaps(f.ctx)
  save(
    f,
    "caps",
    envelope("caps", [
      { ...row, segment: "business", note: "Per-plugin task workers are admitted by this gate." },
    ])
  )
  const original = row.evidence
  f.write("lib/a.ts", "const MAX_WORKERS = 3;")
  assert.equal(main(["--root", f.root, "--inventory", "caps", "--write-baseline"], output()), 0)
  const path = join(f.root, "scripts/gates/convergence/inventories/caps.json")
  assert.equal(JSON.parse(readFileSync(path)).members[0].evidence, original)
  assert.equal(main(["--root", f.root, "--inventory", "caps"], output()), 1)
  assert.equal(
    main(
      ["--root", f.root, "--inventory", "caps", "--write-baseline", "--reconfirm", row.key],
      output()
    ),
    0
  )
  assert.notEqual(JSON.parse(readFileSync(path)).members[0].evidence, original)
  assert.equal(main(["--root", f.root, "--inventory", "caps"], output()), 0)
})
test("review2 #2 referenceOverride loses validity when its cited bridge line disappears", (t) => {
  const f = fixture(t, {
    "lib/db/execution-runs.ts": "export function createExecutionRun(id){}",
    "lib/bridge.ts":
      'import {createExecutionRun as ensureRun} from "./db/execution-runs";ensureRun(plan.id);',
  })
  const row = {
    key: "dexie:DB@lib/db.ts/plans",
    table: "plans",
    database: "DB@lib/db.ts",
    owner: "lib/db",
    reference: "none",
    evidence: "0123456789abcdef",
  }
  const member = {
    ...row,
    reference: "real",
    referenceOverride: "real",
    note: "lib/bridge.ts:1 derives the plan ledger row through ensureRun.",
  }
  member.evidence = rewriteInventory(
    "run-tables",
    [row],
    envelope("run-tables", [member]),
    {},
    f.ctx,
    { all: true }
  ).members[0].evidence
  assert.equal(
    reconcileInventory("run-tables", [row], envelope("run-tables", [member]), f.ctx).ok,
    true
  )
  f.write("lib/bridge.ts", "log(plan.id);")
  assert.match(
    reconcileInventory(
      "run-tables",
      [row],
      envelope("run-tables", [member]),
      createContext(f.root)
    ).invalid.join("\n"),
    /referenceOverride.*bridge/
  )
  const stale = reconcileInventory(
    "run-tables",
    [row],
    envelope("run-tables", [member]),
    createContext(f.root)
  )
  assert.equal(stale.metrics.real, 0)
  for (const source of ["// ensureRun(plan.id);", 'const text="ensureRun(plan.id)";']) {
    f.write("lib/bridge.ts", source)
    assert.match(
      reconcileInventory(
        "run-tables",
        [row],
        envelope("run-tables", [member]),
        createContext(f.root)
      ).invalid.join("\n"),
      /referenceOverride.*bridge/
    )
  }
})
for (const malformed of [
  {
    inventory: "caps",
    members: [{ note: "Do not discard this reviewed decision." }],
    excluded: [],
    metrics: {},
  },
  { inventory: "caps", members: [{ ...cap }, { ...cap }], excluded: [], metrics: {} },
  {
    inventory: "caps",
    members: { note: "Do not discard this reviewed decision." },
    excluded: [],
    metrics: {},
  },
])
  test(`review2 #8 baseline refuses structural decision loss: ${Array.isArray(malformed.members) ? malformed.members.length : "envelope"}`, (t) => {
    const f = fixture(t, { "lib/cap.ts": "const DEFAULT_CONCURRENCY=2;" })
    save(f, "caps", malformed)
    const path = join(f.root, "scripts/gates/convergence/inventories/caps.json"),
      before = readFileSync(path, "utf8")
    assert.equal(main(["--root", f.root, "--inventory", "caps", "--write-baseline"], output()), 1)
    assert.equal(readFileSync(path, "utf8"), before)
  })
test("review2 #9 evalTasks records the orchestrator's bounded jittered retry", () => {
  const inventory = JSON.parse(
    readFileSync(new URL("./convergence/inventories/durable-queues.json", import.meta.url))
  )
  const row = inventory.members.find((r) => r.table === "evalTasks")
  assert.match(row.retry, /custom:.*3.*500.*jitter/i)
  assert.match(row.note, /orchestrator\.ts:39\d/)
})
test("review2 #10 agentPlans records the live derived-id ledger bridge", () => {
  const inventory = JSON.parse(
    readFileSync(new URL("./convergence/inventories/run-tables.json", import.meta.url))
  )
  const row = inventory.members.find((r) => r.table === "agentPlans")
  assert.equal(row.reference, "real")
  assert.equal(row.referenceOverride, "real")
  assert.match(row.note, /agent-state-bridge\.ts:331/)
  assert.match(row.note, /ensureRun/)
})
test("review2 #11 human decisions name enforcement or consumption rather than detector templates", () => {
  for (const inventory of ["caps", "durable-queues", "run-tables"]) {
    const x = JSON.parse(
      readFileSync(new URL(`./convergence/inventories/${inventory}.json`, import.meta.url))
    )
    for (const r of [...x.members, ...x.excluded])
      assert.doesNotMatch(
        r.note || r.reason,
        /claims, drains or resumes|which bounds concurrent or per-window|detector currently proves|inventoried native backpressure with a separate owner/,
        r.key
      )
  }
})
test("review2 #13 WORKER_HELLO_VERSION is excluded as a protocol discriminator", () => {
  const x = JSON.parse(
    readFileSync(new URL("./convergence/inventories/caps.json", import.meta.url))
  )
  const row = x.excluded.find((r) => r.symbol === "WORKER_HELLO_VERSION")
  assert.match(row.reason, /protocol version|protocol-version/i)
  assert.match(row.reason, /ws_worker\.rs:1010/)
  assert.doesNotMatch(row.reason, /buffer|queued bytes/)
})

function review3Bridge(t, call = "ensureRun(plan.id)") {
  const f = fixture(t, {
    "lib/db/execution-runs.ts": "export function createExecutionRun(id){}",
    "lib/execution/bridge.ts": `import {createExecutionRun} from '../db/execution-runs';
function ensureRun(id){createExecutionRun(id)}
${call};`,
  })
  const row = {
    key: "dexie:DB@lib/db.ts/plans",
    table: "plans",
    database: "DB@lib/db.ts",
    owner: "lib/db",
    reference: "none",
    evidence: "0123456789abcdef",
  }
  const member = {
    ...row,
    referenceOverride: "real",
    reference: "real",
    note: "lib/execution/bridge.ts:3 links this plan identity through the reviewed ensureRun bridge.",
  }
  return {
    f,
    row,
    baseline: rewriteInventory("run-tables", [row], envelope("run-tables", [member]), {}, f.ctx, {
      all: true,
    }),
  }
}
for (const call of ["logger.ensureRun(plan.id)", "ensureRun(other.id)"])
  test("review3 #3 override rejects replacement " + call, (t) => {
    const { f, row, baseline } = review3Bridge(t)
    assert.equal(reconcileInventory("run-tables", [row], baseline, f.ctx).ok, true)
    f.write(
      "lib/execution/bridge.ts",
      `import {createExecutionRun} from '../db/execution-runs';
function ensureRun(id){createExecutionRun(id)}
${call};`
    )
    const report = reconcileInventory("run-tables", [row], baseline, createContext(f.root))
    assert.equal(report.ok, false)
    assert.match(
      report.invalid.join("\n"),
      call.startsWith("logger") ? /referenceOverride/ : /evidence changed/
    )
  })
test("review3 #3 imported ledger alias and re-export are valid override bindings", (t) => {
  const f = fixture(t, {
    "lib/db/execution-runs.ts": "export function createExecutionRun(id){}",
    "lib/ledger.ts": 'export {createExecutionRun as persist} from "./db/execution-runs"',
    "lib/bridge.ts": 'import {persist as write} from "./ledger";\nwrite(plan.id);',
  })
  const row = { key: "plans", reference: "none", owner: "lib", evidence: "0123456789abcdef" }
  const member = {
    ...row,
    reference: "real",
    referenceOverride: "real",
    note: "lib/bridge.ts:2 writes the canonical ledger for this plan identity.",
  }
  const base = rewriteInventory("run-tables", [row], envelope("run-tables", [member]), {}, f.ctx, {
    all: true,
  })
  assert.equal(reconcileInventory("run-tables", [row], base, f.ctx).ok, true)
})
test("review3 #3 a local same-named bridge outside lib/execution is rejected", (t) => {
  const f = fixture(t, {
    "lib/bridge.ts": "function ensureRun(x){return logger.log(x)};ensureRun(plan.id);",
  })
  const row = { key: "plans", reference: "none", owner: "lib", evidence: "0123456789abcdef" }
  const member = {
    ...row,
    reference: "real",
    referenceOverride: "real",
    note: "lib/bridge.ts:1 purports to write the canonical plan ledger.",
  }
  assert.match(
    reconcileInventory("run-tables", [row], envelope("run-tables", [member]), f.ctx).invalid.join(
      "\n"
    ),
    /referenceOverride/
  )
})

test("review3 #3 bridge implementation binds ledger argument but ignores unrelated statements", (t) => {
  const { f, row, baseline } = review3Bridge(t)
  const report = (body) => {
    f.write(
      "lib/execution/bridge.ts",
      `import {createExecutionRun} from '../db/execution-runs';
function ensureRun(id){${body}}
ensureRun(plan.id);`
    )
    return reconcileInventory("run-tables", [row], baseline, createContext(f.root))
  }
  assert.equal(report('createExecutionRun(id);console.log("unrelated")').ok, true)
  assert.match(report("createExecutionRun(other.id)").invalid.join("\n"), /evidence changed/)
  assert.match(report("logger.createExecutionRun(id)").invalid.join("\n"), /referenceOverride/)
})
for (const binding of [
  'import * as ledger from "./db/execution-runs";\n(ledger.createExecutionRun)(plan.id);',
  'import persist from "./ledger";\npersist(plan.id);',
])
  test("review3 #3 namespace and default re-export ledger bindings " + binding, (t) => {
    const f = fixture(t, {
      "lib/db/execution-runs.ts": "export function createExecutionRun(id){}",
      "lib/ledger.ts": 'export {createExecutionRun as default} from "./db/execution-runs";',
      "lib/bridge.ts": binding,
    })
    const row = { key: "plans", reference: "none", owner: "lib", evidence: "0123456789abcdef" }
    const member = {
      ...row,
      reference: "real",
      referenceOverride: "real",
      note: "lib/bridge.ts:2 writes the canonical ledger for this plan identity.",
    }
    const base = rewriteInventory(
      "run-tables",
      [row],
      envelope("run-tables", [member]),
      {},
      f.ctx,
      { all: true }
    )
    assert.equal(reconcileInventory("run-tables", [row], base, f.ctx).ok, true)
  })

for (const direction of ["download", "upload"])
  test(
    "review3 #7 SFTP " +
      direction +
      " duplicates across module instances, without a persistent claim",
    async () => {
      const source = readFileSync(
        new URL("../../lib/sftp/transfer-queue.ts", import.meta.url),
        "utf8"
      )
      const compiled = ts.transpileModule(source, {
        compilerOptions: {
          module: ts.ModuleKind.CommonJS,
          target: ts.ScriptTarget.ES2022,
          esModuleInterop: true,
        },
      }).outputText
      const row = {
        id: "one",
        status: "queued",
        direction,
        createdAt: 1,
        profileId: "p",
        remotePath: "/file",
        payload: new Uint8Array([1]),
      }
      let calls = 0,
        selections = 0
      const selected = [],
        downloads = []
      const table = {
        update: async (id, patch) => Object.assign(row, patch),
        where: () => ({
          equals: (status) => ({
            toArray: async () => [],
            sortBy: () =>
              new Promise((resolve) => {
                selected.push(() => resolve([{ ...row }]))
                if (++selections === 2) {
                  for (const done of selected) done()
                }
              }),
          }),
        }),
      }
      const perform = () => {
        calls++
        return new Promise((resolve) => downloads.push(resolve))
      }
      const load = () => {
        const mod = { exports: {} }
        runInNewContext(compiled, {
          module: mod,
          exports: mod.exports,
          require: (name) =>
            name === "dexie"
              ? class Dexie {}
              : name === "@/lib/db/schema"
                ? { getDb: () => ({ sftpTransfers: table }) }
                : name === "./client"
                  ? {
                      downloadSftpFile: perform,
                      uploadSftpFile: perform,
                      SftpTransferAbortedError: class extends Error {},
                    }
                  : {
                      isSftpTransferFinished: () => false,
                      SFTP_MAX_QUEUED_BYTES: 1e9,
                      SftpTransferTooLargeError: class extends Error {},
                    },
          AbortController,
          Blob,
          Uint8Array,
          setInterval: () => 1,
          clearInterval: () => {},
        })
        return mod.exports
      }
      const a = load(),
        b = load(),
        stopA = a.startSftpTransferPump({ requiresApproval: false }),
        stopB = b.startSftpTransferPump({ requiresApproval: false })
      for (let i = 0; i < 20; i++) await Promise.resolve()
      assert.equal(calls, 2)
      stopA()
      stopB()
      for (const done of downloads)
        done(
          direction === "download" ? new Blob(["x"]) : { complete: true, size: 1, declaredSize: 1 }
        )
      for (let i = 0; i < 20; i++) await Promise.resolve()
      const queue = JSON.parse(
        readFileSync(new URL("./convergence/inventories/durable-queues.json", import.meta.url))
      ).members.find((r) => r.table === "sftpTransfers")
      assert.match(queue.idempotency, /none.*module/i)
      assert.match(queue.note, /transfer-queue\.ts:181/)
      assert.doesNotMatch(queue.note, /status-guarded/i)
      assert.match(queue.note, /no cross-window idempotency or atomic claim/i)
    }
  )
for (const inventory of ["durable-queues", "run-tables"])
  test("review3 #8 dormant wikiBuildJobs excluded from " + inventory, () => {
    const x = JSON.parse(
      readFileSync(new URL(`./convergence/inventories/${inventory}.json`, import.meta.url))
    )
    assert.ok(!x.members.some((r) => r.table === "wikiBuildJobs"))
    const row = x.excluded.find((r) => r.table === "wikiBuildJobs")
    assert.match(row?.reason ?? "", /dormant/i)
    assert.match(row.reason, /no production (?:caller|consumer)/i)
    assert.doesNotMatch(row.reason, /orchestrator.*(?:executes|resumes)/i)
  })

import { strict as assert } from "node:assert"
import { execFileSync } from "node:child_process"
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
  existsSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, normalize, relative } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import { GATES } from "./check-all.mjs"

import {
  analyze,
  compareRatchet,
  exceptionCovers,
  measure,
  missingBaseIsFatal,
  readConfig,
  validateConfig,
  validateException,
} from "./check-baseline-growth.mjs"

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..")

// ── pure measuring ──────────────────────────────────────────────────────────

test("measure: length counts arrays and object keys", () => {
  assert.equal(
    measure({ files: ["a", "b"] }, { id: "f", kind: "length", path: "files" }).get("f"),
    2
  )
  assert.equal(
    measure({ m: { a: 1, b: 2, c: 3 } }, { id: "m", kind: "length", path: "m" }).get("m"),
    3
  )
  assert.equal(measure([1, 2, 3], { id: "r", kind: "length", path: "" }).get("r"), 3)
})

test("measure: sum adds every numeric leaf", () => {
  const doc = { "a.tsx": { projection: 2, cwd: 1 }, "b.tsx": { projection: 0, cwd: 4 } }
  assert.equal(measure(doc, { id: "v", kind: "sum", path: "" }).get("v"), 7)
})

test("measure: value reads one number and rejects non-numbers", () => {
  assert.equal(measure({ total: 9 }, { id: "t", kind: "value", path: "total" }).get("t"), 9)
  assert.throws(() => measure({ total: "9" }, { id: "t", kind: "value", path: "total" }))
})

test("measure: eachValue keys every leaf separately", () => {
  const out = measure(
    { ceilings: { opaque: 110, unconstrained: 3 } },
    { id: "c", kind: "eachValue", path: "ceilings" }
  )
  assert.deepEqual(
    [...out],
    [
      ["c:opaque", 110],
      ["c:unconstrained", 3],
    ]
  )
})

test("measure: sumLength sums arrays under a key", () => {
  const doc = { initializers: { a: { symbols: ["x", "y"] }, b: { symbols: ["z"], reason: "r" } } }
  assert.equal(
    measure(doc, { id: "s", kind: "sumLength", path: "initializers", key: "symbols" }).get("s"),
    3
  )
})

test("measure: a missing path yields nothing", () => {
  assert.equal(measure({}, { id: "x", kind: "length", path: "files" }).size, 0)
})

// ── comparison ──────────────────────────────────────────────────────────────

const RATCHET = {
  id: "b",
  file: "b.json",
  measures: [{ id: "files", kind: "length", path: "files" }],
}

test("compare: growth fails", () => {
  const rows = compareRatchet(RATCHET, { files: ["a"] }, { files: ["a", "b"] })
  assert.equal(rows[0].status, "grew")
  assert.equal(rows[0].delta, 1)
})

test("compare: shrinking and unchanged pass", () => {
  assert.equal(compareRatchet(RATCHET, { files: ["a", "b"] }, { files: ["a"] })[0].status, "shrank")
  assert.equal(compareRatchet(RATCHET, { files: ["a"] }, { files: ["b"] })[0].status, "ok")
})

test("compare: an exception covering the growth passes, a smaller one does not", () => {
  const ex = [{ file: "b.json", measure: "files", allowGrowth: 2, name: "x.json" }]
  const rows = compareRatchet(RATCHET, { files: [] }, { files: ["a", "b"] }, ex)
  assert.equal(rows[0].status, "excepted")
  assert.deepEqual(rows[0].allowedBy, ["x.json"])
  const small = [{ file: "b.json", measure: "files", allowGrowth: 1, name: "x.json" }]
  assert.equal(
    compareRatchet(RATCHET, { files: [] }, { files: ["a", "b"] }, small)[0].status,
    "grew"
  )
})

test("compare: an exception for another file does not apply", () => {
  const ex = [{ file: "other.json", measure: "files", allowGrowth: 5, name: "x.json" }]
  assert.equal(compareRatchet(RATCHET, { files: [] }, { files: ["a"] }, ex)[0].status, "grew")
})

test("compare: a file absent at the base is introduced", () => {
  assert.equal(compareRatchet(RATCHET, null, { files: ["a"] })[0].status, "introduced")
})

for (const [kind, target, extra] of [
  ["length", ["a"], {}],
  ["sum", { a: 1 }, {}],
  ["value", 1, {}],
  ["eachValue", { a: 1 }, {}],
  ["sumLength", [{ boundaries: ["ai"] }], { key: "boundaries" }],
]) {
  test(`compare: ${kind} cannot silently lose its measure path`, () => {
    const r = { ...RATCHET, measures: [{ id: "m", kind, path: "target", ...extra }] }
    const rows = compareRatchet(r, { target }, {})
    assert.ok(rows.some((row) => row.status === "removed"))
    const approved = compareRatchet(r, { target }, {}, [
      { file: r.file, measure: "m", allowRemoval: true, name: "removal.json" },
    ])
    assert.ok(approved.length > 0)
    assert.ok(approved.every((row) => row.status === "excepted"))
  })
}

test("compare: eachValue leaf removal requires a matching removal exception", () => {
  const r = { ...RATCHET, measures: [{ id: "ceilings", kind: "eachValue", path: "ceilings" }] }
  const base = { ceilings: { opaque: 110, other: 3 } }
  const head = { ceilings: { other: 3 } }
  assert.equal(
    compareRatchet(r, base, head).find((row) => row.key === "ceilings:opaque").status,
    "removed"
  )
  for (const exception of [
    { file: r.file, measure: "ceilings:other", allowRemoval: true },
    { file: "other.json", measure: "ceilings", allowRemoval: true },
    { file: r.file, measure: "ceilings", allowGrowth: 1000 },
  ])
    assert.equal(compareRatchet(r, base, head, [exception])[0].status, "removed")
  const rows = compareRatchet(r, base, head, [
    { file: r.file, measure: "ceilings:opaque", allowRemoval: true, name: "removal.json" },
  ])
  assert.equal(rows[0].status, "excepted")
})

test("compare: numeric leaves cannot become strings, null or non-finite numbers", () => {
  for (const kind of ["value", "sum", "eachValue"]) {
    const r = { ...RATCHET, measures: [{ id: "m", kind, path: "target" }] }
    for (const invalid of ["1000", null, NaN, Infinity, -Infinity]) {
      const target = kind === "value" ? invalid : { opaque: invalid }
      const base = { target: kind === "value" ? 110 : { opaque: 110 } }
      assert.throws(() => compareRatchet(r, base, { target }), /finite number/)
      assert.throws(
        () =>
          compareRatchet(r, base, { target }, [{ file: r.file, measure: "m", allowRemoval: true }]),
        /finite number/
      )
    }
  }
})

test("compare: sumLength rejects a non-array boundary list", () => {
  const r = { ...RATCHET, measures: [{ id: "m", kind: "sumLength", path: "", key: "boundaries" }] }
  assert.throws(() => compareRatchet(r, [{ boundaries: ["ai"] }], [{ boundaries: "ai" }]))
})

test("compare: replacing a numeric subtree or root with null is invalid, not removal", () => {
  for (const kind of ["sum", "eachValue"]) {
    const r = { ...RATCHET, measures: [{ id: "m", kind, path: "" }] }
    const exceptions = [{ file: r.file, measure: "m", allowRemoval: true }]
    for (const head of [null, { nested: null }, { nested: "disabled" }])
      assert.throws(
        () => compareRatchet(r, { nested: { limit: 1 } }, head, exceptions),
        /finite number/
      )
  }
})

test("measure: numeric aggregate overflow is rejected", () => {
  assert.throws(
    () => measure({ a: 1e308, b: 1e308 }, { id: "m", kind: "sum", path: "" }),
    /finite number/
  )
})

test("exceptionCovers: a measure id covers its eachValue leaves", () => {
  assert.ok(exceptionCovers("ceilings", "ceilings:opaque"))
  assert.ok(exceptionCovers("ceilings:opaque", "ceilings:opaque"))
  assert.ok(!exceptionCovers("ceilings:opaque", "ceilings:unconstrained"))
  assert.ok(!exceptionCovers("files", "filesExtra"))
})

// ── exception records ───────────────────────────────────────────────────────

const CONFIG = { ratchets: [RATCHET], notRatchets: [] }
const GOOD = {
  file: "b.json",
  measure: "files",
  allowGrowth: 1,
  owner: "lib/router-fusion",
  repaymentPhase: "1",
  reason: "fusion outbox stays until the durable queue primitive exists",
}

test("exception: a complete record is valid", () => {
  assert.deepEqual(validateException("2026-11-01-fusion-outbox.json", GOOD, CONFIG), [])
})

test("exception: allowRemoval is explicit and can replace allowGrowth", () => {
  const { allowGrowth, ...removal } = GOOD
  assert.deepEqual(
    validateException("2026-11-01-remove.json", { ...removal, allowRemoval: true }, CONFIG),
    []
  )
  for (const allowRemoval of [false, "true", 1, null]) {
    assert.ok(
      validateException("2026-11-01-remove.json", { ...removal, allowRemoval }, CONFIG).length
    )
  }
  assert.ok(
    validateException("2026-11-01-remove.json", { ...GOOD, allowRemoval: "true" }, CONFIG).length
  )
})

test("config: stable ratchet ids are mandatory and unique", () => {
  const { id, ...withoutId } = RATCHET
  assert.ok(validateConfig({ ratchets: [withoutId] }).some((p) => p.includes("id")))
  assert.ok(
    validateConfig({ ratchets: [RATCHET, { ...RATCHET, file: "other.json" }] }).some((p) =>
      p.includes("id")
    )
  )
})

test("exception: every missing field is reported", () => {
  for (const field of ["file", "measure", "allowGrowth", "owner", "repaymentPhase", "reason"]) {
    const record = { ...GOOD }
    delete record[field]
    const problems = validateException("2026-11-01-x.json", record, CONFIG)
    assert.ok(problems.length > 0, `missing ${field} must fail`)
  }
})

test("exception: bad name, unknown file or measure, bad phase, short reason fail", () => {
  assert.ok(validateException("fusion.json", GOOD, CONFIG).length)
  assert.ok(validateException("2026-11-01-x.json", { ...GOOD, file: "nope.json" }, CONFIG).length)
  assert.ok(validateException("2026-11-01-x.json", { ...GOOD, measure: "nope" }, CONFIG).length)
  assert.ok(validateException("2026-11-01-x.json", { ...GOOD, repaymentPhase: "5" }, CONFIG).length)
  assert.ok(validateException("2026-11-01-x.json", { ...GOOD, reason: "later" }, CONFIG).length)
  assert.ok(validateException("2026-11-01-x.json", { ...GOOD, allowGrowth: 0 }, CONFIG).length)
})

test("missing base is fatal only on CI pull-request and push runs", () => {
  assert.ok(missingBaseIsFatal({ CI: "true", GITHUB_EVENT_NAME: "pull_request" }))
  assert.ok(missingBaseIsFatal({ CI: "true", GITHUB_EVENT_NAME: "push" }))
  assert.ok(!missingBaseIsFatal({ CI: "true", GITHUB_EVENT_NAME: "schedule" }))
  assert.ok(!missingBaseIsFatal({}))
})

// ── end to end over a real git history ──────────────────────────────────────

function gitRepo() {
  const dir = mkdtempSync(join(tmpdir(), "baseline-growth-"))
  const run = (...args) =>
    execFileSync("git", args, {
      cwd: dir,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@t",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@t",
      },
    }).trim()
  run("init", "-q", "-b", "main")
  const write = (file, value) => {
    mkdirSync(dirname(join(dir, file)), { recursive: true })
    writeFileSync(join(dir, file), typeof value === "string" ? value : JSON.stringify(value))
  }
  const commit = (msg) => {
    run("add", "-A")
    run("commit", "-q", "-m", msg)
    return run("rev-parse", "HEAD")
  }
  return {
    dir,
    write,
    commit,
    cleanup: () => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }),
  }
}

const E2E_CONFIG = {
  ratchets: [
    {
      id: "x",
      file: "scripts/gates/x-baseline.json",
      measures: [{ id: "files", kind: "length", path: "files" }],
    },
  ],
  notRatchets: [],
}

test("e2e: growth against the base fails, shrinking passes", () => {
  const repo = gitRepo()
  try {
    repo.write("scripts/gates/baseline-growth.json", E2E_CONFIG)
    repo.write("scripts/gates/x-baseline.json", { files: ["a"] })
    const base = repo.commit("base")
    repo.write("scripts/gates/x-baseline.json", { files: ["a", "b"] })
    repo.commit("grow")
    const grown = analyze({ cwd: repo.dir, argBase: base, env: {} })
    assert.equal(grown.ok, false)
    assert.equal(grown.rows.find((r) => r.key === "files").status, "grew")

    repo.write("scripts/gates/x-baseline.json", { files: [] })
    repo.commit("shrink")
    assert.equal(analyze({ cwd: repo.dir, argBase: base, env: {} }).ok, true)
  } finally {
    repo.cleanup()
  }
})

test("e2e: a new exception record allows the growth; one already at the base does not", () => {
  const repo = gitRepo()
  try {
    repo.write("scripts/gates/baseline-growth.json", E2E_CONFIG)
    repo.write("scripts/gates/x-baseline.json", { files: ["a"] })
    const record = {
      file: "scripts/gates/x-baseline.json",
      measure: "files",
      allowGrowth: 1,
      owner: "lib/x",
      repaymentPhase: "1",
      reason: "the new file is repaid when phase 1 lands its primitive",
    }
    const base = repo.commit("base")
    repo.write("scripts/gates/x-baseline.json", { files: ["a", "b"] })
    repo.write("scripts/gates/baseline-exceptions/2026-11-01-x.json", record)
    const head = repo.commit("grow with exception")
    const excepted = analyze({ cwd: repo.dir, argBase: base, env: {} })
    assert.equal(excepted.ok, true, JSON.stringify(excepted.problems))
    assert.equal(excepted.rows[0].status, "excepted")

    // The same record, now part of the base, cannot excuse the next growth.
    repo.write("scripts/gates/x-baseline.json", { files: ["a", "b", "c"] })
    repo.commit("grow again")
    const reused = analyze({ cwd: repo.dir, argBase: head, env: {} })
    assert.equal(reused.ok, false)
    assert.equal(reused.rows[0].status, "grew")
  } finally {
    repo.cleanup()
  }
})

test("e2e: an exception record with a missing field fails even if it would cover the growth", () => {
  const repo = gitRepo()
  try {
    repo.write("scripts/gates/baseline-growth.json", E2E_CONFIG)
    repo.write("scripts/gates/x-baseline.json", { files: ["a"] })
    const base = repo.commit("base")
    repo.write("scripts/gates/x-baseline.json", { files: ["a", "b"] })
    repo.write("scripts/gates/baseline-exceptions/2026-11-01-x.json", {
      file: "scripts/gates/x-baseline.json",
      measure: "files",
      allowGrowth: 1,
      repaymentPhase: "1",
      reason: "missing the owner field on purpose in this test",
    })
    repo.commit("grow with incomplete exception")
    const result = analyze({ cwd: repo.dir, argBase: base, env: {} })
    assert.equal(result.ok, false)
    assert.ok(result.problems.some((p) => p.includes('"owner"')))
  } finally {
    repo.cleanup()
  }
})

test("e2e: a listed ratchet file missing at HEAD fails", () => {
  const repo = gitRepo()
  try {
    repo.write("scripts/gates/baseline-growth.json", E2E_CONFIG)
    repo.write("scripts/gates/other.json", {})
    const base = repo.commit("base")
    const result = analyze({ cwd: repo.dir, argBase: base, env: {} })
    assert.equal(result.ok, false)
    assert.ok(result.problems.some((p) => p.includes("missing at HEAD")))
  } finally {
    repo.cleanup()
  }
})

test("e2e: no resolvable base is reported as skipped", () => {
  const repo = gitRepo()
  try {
    repo.write("scripts/gates/baseline-growth.json", E2E_CONFIG)
    repo.write("scripts/gates/x-baseline.json", { files: [] })
    repo.commit("only")
    const result = analyze({ cwd: repo.dir, env: {} })
    assert.equal(result.skipped, true)
  } finally {
    repo.cleanup()
  }
})

// ── coverage of the real config ─────────────────────────────────────────────

test("e2e: a moved baseline retains its identity and cannot hide growth", () => {
  const repo = gitRepo()
  try {
    repo.write("scripts/gates/baseline-growth.json", E2E_CONFIG)
    repo.write("scripts/gates/x-baseline.json", { files: ["a"] })
    const base = repo.commit("base")
    rmSync(join(repo.dir, "scripts/gates/x-baseline.json"))
    const renamed = { ...E2E_CONFIG.ratchets[0], file: "scripts/gates/renamed-baseline.json" }
    repo.write("scripts/gates/baseline-growth.json", { ratchets: [renamed] })
    repo.write(renamed.file, { files: ["a", "b"] })
    const result = analyze({ cwd: repo.dir, argBase: base, env: {} })
    assert.equal(result.ok, false)
    assert.equal(result.rows[0].status, "grew")
    repo.write(renamed.file, { files: ["a"] })
    assert.equal(analyze({ cwd: repo.dir, argBase: base, env: {} }).ok, true)
    repo.write("scripts/gates/baseline-growth.json", { ratchets: [{ ...renamed, id: "new-id" }] })
    const unidentified = analyze({ cwd: repo.dir, argBase: base, env: {} })
    assert.equal(unidentified.ok, false)
    assert.ok(
      unidentified.rows.some((row) => row.status === "removed" && row.reason === "ratchet removed")
    )
  } finally {
    repo.cleanup()
  }
})

test("e2e: a removed ratchet needs a new allowRemoval record for every measure", () => {
  const repo = gitRepo()
  try {
    repo.write("scripts/gates/baseline-growth.json", E2E_CONFIG)
    repo.write("scripts/gates/x-baseline.json", { files: ["a"] })
    const base = repo.commit("base")
    repo.write("scripts/gates/baseline-growth.json", { ratchets: [] })
    const removed = analyze({ cwd: repo.dir, argBase: base, env: {} })
    assert.equal(removed.ok, false)
    assert.equal(removed.rows[0].reason, "ratchet removed")
    const { allowGrowth, ...record } = GOOD
    repo.write("scripts/gates/baseline-exceptions/2026-11-01-remove.json", {
      ...record,
      file: E2E_CONFIG.ratchets[0].file,
      allowRemoval: true,
    })
    const allowed = analyze({ cwd: repo.dir, argBase: base, env: {} })
    assert.equal(allowed.ok, true, JSON.stringify(allowed.problems))
    assert.equal(allowed.rows[0].status, "excepted")
    const approvedHead = repo.commit("approved removal")
    assert.equal(
      analyze({ cwd: repo.dir, argBase: approvedHead, env: {} }).ok,
      true,
      "historical removal records remain valid after the ratchet is gone"
    )
  } finally {
    repo.cleanup()
  }
})

test("e2e: changing an id at an existing path does not introduce the baseline", () => {
  const repo = gitRepo()
  try {
    repo.write("scripts/gates/baseline-growth.json", E2E_CONFIG)
    repo.write("scripts/gates/x-baseline.json", { files: ["a"] })
    const base = repo.commit("base")
    repo.write("scripts/gates/baseline-growth.json", {
      ratchets: [{ ...E2E_CONFIG.ratchets[0], id: "new-id" }],
    })
    repo.write("scripts/gates/x-baseline.json", { files: ["a", "b"] })
    const result = analyze({ cwd: repo.dir, argBase: base, env: {} })
    assert.equal(result.ok, false)
    assert.equal(result.rows[0].status, "grew")
  } finally {
    repo.cleanup()
  }
})

test("e2e: removing a measure from the config still needs its removal exception", () => {
  const repo = gitRepo()
  try {
    const original = {
      ...E2E_CONFIG.ratchets[0],
      measures: [
        ...E2E_CONFIG.ratchets[0].measures,
        { id: "ceilings", kind: "eachValue", path: "ceilings" },
      ],
    }
    repo.write("scripts/gates/baseline-growth.json", { ratchets: [original] })
    repo.write(original.file, { files: ["a"], ceilings: { opaque: 110 } })
    const base = repo.commit("base")
    repo.write("scripts/gates/baseline-growth.json", E2E_CONFIG)
    assert.equal(analyze({ cwd: repo.dir, argBase: base, env: {} }).ok, false)
    const { allowGrowth, ...record } = GOOD
    repo.write("scripts/gates/baseline-exceptions/2026-11-01-remove.json", {
      ...record,
      file: original.file,
      measure: "ceilings",
      allowRemoval: true,
    })
    const result = analyze({ cwd: repo.dir, argBase: base, env: {} })
    assert.equal(result.ok, true, JSON.stringify(result.problems))
  } finally {
    repo.cleanup()
  }
})

test("e2e: whole-file removal needs a new removal record, never an old one", () => {
  const repo = gitRepo()
  try {
    repo.write("scripts/gates/baseline-growth.json", E2E_CONFIG)
    repo.write(E2E_CONFIG.ratchets[0].file, { files: ["a"] })
    const { allowGrowth, ...record } = GOOD
    repo.write("scripts/gates/baseline-exceptions/2026-11-01-old.json", {
      ...record,
      file: E2E_CONFIG.ratchets[0].file,
      allowRemoval: true,
    })
    const base = repo.commit("base")
    rmSync(join(repo.dir, E2E_CONFIG.ratchets[0].file))
    assert.equal(analyze({ cwd: repo.dir, argBase: base, env: {} }).ok, false)
    repo.write("scripts/gates/baseline-exceptions/2026-11-01-new.json", {
      ...record,
      file: E2E_CONFIG.ratchets[0].file,
      allowRemoval: true,
    })
    const result = analyze({ cwd: repo.dir, argBase: base, env: {} })
    assert.equal(result.ok, true, JSON.stringify(result.problems))
    assert.deepEqual(result.rows[0].allowedBy, ["2026-11-01-new.json"])
  } finally {
    repo.cleanup()
  }
})

test("e2e: the first rollout still compares files when the base has no config", () => {
  const repo = gitRepo()
  try {
    repo.write("scripts/gates/x-baseline.json", { files: ["a"] })
    const base = repo.commit("before rollout")
    repo.write("scripts/gates/baseline-growth.json", E2E_CONFIG)
    repo.write("scripts/gates/x-baseline.json", { files: ["a", "b"] })
    assert.equal(analyze({ cwd: repo.dir, argBase: base, env: {} }).rows[0].status, "grew")
    repo.write("scripts/gates/baseline-growth.json", {
      ratchets: [{ ...E2E_CONFIG.ratchets[0], file: "new-baseline.json" }],
    })
    repo.write("new-baseline.json", { files: ["a"] })
    assert.equal(analyze({ cwd: repo.dir, argBase: base, env: {} }).rows[0].status, "introduced")
  } finally {
    repo.cleanup()
  }
})

test("real PII allowlist: adding a boundary to an existing entry fails", () => {
  const r = readConfig().ratchets.find(
    (r) => r.file === "scripts/gates/pii-boundary-allowlist.json"
  )
  const base = JSON.parse(readFileSync(join(REPO_ROOT, r.file), "utf8"))
  const head = structuredClone(base)
  head[0].boundaries.push("@ai-sdk/openai")
  assert.ok(compareRatchet(r, base, head).some((row) => row.status === "grew" && row.delta === 1))
})

test("real SDK performance baseline: doubling rawBytes fails", () => {
  const r = readConfig().ratchets.find(
    (r) => r.file === "packages/plugin-sdk/contract/performance-baseline.json"
  )
  const base = JSON.parse(readFileSync(join(REPO_ROOT, r.file), "utf8"))
  const head = structuredClone(base)
  head.chunk.rawBytes *= 2
  assert.ok(
    compareRatchet(r, base, head).some(
      (row) => row.key === "chunk:rawBytes" && row.status === "grew"
    )
  )
})

test("SDK performance references: gzip and every lifecycle latency are ratcheted", () => {
  const r = readConfig().ratchets.find(
    (r) => r.file === "packages/plugin-sdk/contract/performance-baseline.json"
  )
  const base = {
    budgets: { latencyRegressionRatio: 0.05, chunkRegressionRatio: 0.02 },
    chunk: { rawBytes: 100, gzipBytes: 50 },
    lifecycle: { activate: { p50Ms: 10, p95Ms: 20 } },
  }
  const head = structuredClone(base)
  head.chunk.gzipBytes *= 2
  head.lifecycle.activate.p50Ms *= 2
  head.lifecycle.activate.p95Ms *= 2
  assert.deepEqual(
    compareRatchet(r, base, head)
      .filter((r) => r.status === "grew")
      .map((r) => r.key),
    ["chunk:gzipBytes", "lifecycle:activate.p50Ms", "lifecycle:activate.p95Ms"]
  )
})

test("real runtime catalog: an added unpinned launch waiver fails", () => {
  const file = "protocol/external-agent-runtimes.json"
  const r = readConfig().ratchets.find((r) => r.file === file)
  assert.ok(r, "the runtime waiver must be listed")
  const base = JSON.parse(readFileSync(join(REPO_ROOT, file), "utf8"))
  const head = structuredClone(base)
  head.unpinnedLaunchWaivers.runtimes["qwen-code"] =
    "temporary unpinned launch until distribution is pinned"
  assert.ok(compareRatchet(r, base, head).some((row) => row.status === "grew"))
})

// Reviewed JSON inputs read by registered gates, including paths outside
// scripts/gates and files whose waiver is a field rather than their filename.
const GATE_DEBT_FILES = [
  "lib/usage/model-price-catalog.generated.json",
  "packages/plugin-contract/contract/api-surface-baseline.json",
  "packages/plugin-contract/contract/code-1.128-ide.json",
  "packages/plugin-sdk/contract/performance-baseline.json",
  "plugins/pi-latex-workbench/plugin.json",
  "protocol/companion-request-schemas.json",
  "protocol/companion-verbs.json",
  "protocol/external-agent-runtimes.json",
  "protocol/external-agent-security-policy.json",
  "protocol/headless-command-dispositions.json",
  "scripts/e2e/governance-exceptions.json",
  "scripts/gates/clippy-baseline.json",
  "scripts/gates/colocated-test-baseline.json",
  "scripts/gates/frozen-wasm-api.json",
  "scripts/gates/headless-registry-exclusions.json",
  "scripts/gates/host-parity-annotations.json",
  "scripts/gates/host-parity-baseline.json",
  "scripts/gates/identity-vocabulary-baseline.json",
  "scripts/gates/identity-wire-exceptions.json",
  "scripts/gates/invoke-arg-parity-baseline.json",
  "scripts/gates/llm-ledger-boundary-baseline.json",
  "scripts/gates/loading-states-baseline.json",
  "scripts/gates/network-egress-allowlist.json",
  "scripts/gates/pii-boundary-allowlist.json",
  "scripts/gates/pro-ide-perf-baseline.json",
  "scripts/gates/rpc-semantic-parity-baseline.json",
  "scripts/gates/rust-architecture-baseline.json",
  "scripts/gates/rust-architecture.json",
  "scripts/gates/sidecar-architecture-baseline.json",
  "scripts/gates/sidecar-architecture.json",
  "scripts/gates/static-export-allowlist.json",
  "scripts/gates/surface-baseline.json",
  "scripts/gates/unreachable-component-baseline.json",
  "scripts/gates/workspace-attribution-baseline.json",
  "scripts/i18n-baseline.json",
  "scripts/plugin/author-import-baseline.json",
  "scripts/plugin/sdk-standalone-baseline.json",
  "scripts/test/db-fixture-baseline.json",
  "scripts/test/db-fixture-exclusions.json",
]

function registeredDebtFiles({ cwd = REPO_ROOT, gates = GATES } = {}) {
  const seen = new Set()
  const found = new Set()
  const debt = /allowlist|waiver|exception|exclusion|ceiling|baseline/i
  function visit(name, dir = "") {
    const key = `${dir}:${name}`
    if (seen.has(key)) return
    seen.add(key)
    const scripts = JSON.parse(readFileSync(join(cwd, dir, "package.json"), "utf8")).scripts
    const command = scripts[name] ?? ""
    for (const match of command.matchAll(/[\w./-]+\.(?:mjs|cjs|js|ts)\b/g)) {
      const script = join(dir, match[0])
      if (/\.test\./.test(script) || !existsSync(join(cwd, script))) continue
      const source = readFileSync(join(cwd, script), "utf8")
      if (!/readFileSync|JSON\.parse/.test(source)) continue
      const context = (match) =>
        source.slice(0, match.index).split("\n").slice(-3).join("\n") + match[0]
      const refs = [...source.matchAll(/["'`]([^"'`\n]+\.json)["'`]/g)].map((m) => ({
        ref: m[1],
        context: context(m),
      }))
      for (const call of source.matchAll(/(?:join|resolve)\([^()]*\)/g)) {
        const parts = [...call[0].matchAll(/["']([^"']+)["']/g)].map((m) => m[1])
        if (parts.at(-1)?.endsWith(".json"))
          refs.push({ ref: join(...parts), context: context(call) })
      }
      for (const { ref, context } of refs) {
        const file = [join(dir, ref), ref, join(dirname(script), ref), join("scripts/gates", ref)]
          .map(normalize)
          .find((file) => existsSync(join(cwd, file)))
        if (!file || file === "scripts/gates/baseline-growth.json") continue
        const doc = JSON.parse(readFileSync(join(cwd, file), "utf8"))
        const metadata = [...Object.keys(doc), doc.note, doc.description, doc.$comment]
          .filter((v) => typeof v === "string")
          .join(" ")
        if (debt.test(`${file} ${metadata} ${context}`)) found.add(file)
      }
    }
    for (const match of command.matchAll(/pnpm\s+(?:run\s+)?([\w:-]+)/g)) visit(match[1], dir)
    for (const match of command.matchAll(
      /pnpm\s+(?:--dir|-C)\s+([\w./-]+)\s+(?:run\s+)?([\w:-]+)/g
    ))
      visit(match[2], join(dir, match[1]))
  }
  for (const gate of gates.filter((g) => g.group !== "gate-tests")) visit(gate.script)
  return [...found].sort()
}

test("registered gate debt JSON references cannot escape the committed coverage list", () => {
  assert.deepEqual(
    registeredDebtFiles().filter((file) => !GATE_DEBT_FILES.includes(file)),
    []
  )
})

test("coverage discovery sees comment-described waivers and workspace gate scripts", () => {
  const repo = gitRepo()
  try {
    repo.write("package.json", {
      scripts: { "audit:example": "pnpm --dir packages/example run check" },
    })
    repo.write("packages/example/package.json", { scripts: { check: "node scripts/check.mjs" } })
    repo.write(
      "packages/example/scripts/check.mjs",
      `
      // This temporary waiver may only shrink.
      const path = "../contract/policy.json"
      const record = JSON.parse(readFileSync(path, "utf8"))
    `
    )
    repo.write("packages/example/contract/policy.json", { entries: [] })
    assert.deepEqual(
      registeredDebtFiles({
        cwd: repo.dir,
        gates: [{ script: "audit:example", group: "audit" }],
      }),
      ["packages/example/contract/policy.json"]
    )
  } finally {
    repo.cleanup()
  }
})

test("every committed gate waiver or ceiling file has a ratchet or a reason", () => {
  const config = readConfig()
  for (const file of GATE_DEBT_FILES) {
    assert.ok(existsSync(join(REPO_ROOT, file)), file)
    const ratchet = config.ratchets.find((r) => r.file === file)
    const decision = config.notRatchets.find((r) => r.file === file)
    assert.ok(ratchet || decision?.reason.trim().length >= 20, `classify ${file}`)
  }
})

test("the real config is valid", () => {
  assert.deepEqual(validateConfig(readConfig()), [])
})

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "baseline-exceptions") continue
      walk(path, out)
    } else out.push(relative(REPO_ROOT, path))
  }
  return out
}

test("every *baseline* file under scripts/gates/ is listed as a ratchet or a non-ratchet", () => {
  const config = readConfig()
  const listed = new Set([...config.ratchets, ...config.notRatchets].map((r) => r.file))
  const candidates = walk(join(REPO_ROOT, "scripts/gates")).filter(
    (file) =>
      /baseline/i.test(file.split("/").pop()) &&
      file.endsWith(".json") &&
      file !== "scripts/gates/baseline-growth.json"
  )
  assert.ok(candidates.length >= 13, "the scan should see the known baseline files")
  const missing = candidates.filter((file) => !listed.has(file))
  assert.deepEqual(missing, [], `add these to scripts/gates/baseline-growth.json: ${missing}`)
})

test("every convergence inventory is listed as a ratchet", () => {
  const dir = join(REPO_ROOT, "scripts/gates/convergence/inventories")
  if (!existsSync(dir)) return
  const listed = new Set(readConfig().ratchets.map((r) => r.file))
  const missing = readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => `scripts/gates/convergence/inventories/${f}`)
    .filter((file) => !listed.has(file))
  assert.deepEqual(missing, [])
})

test("every listed ratchet file exists", () => {
  for (const { file } of readConfig().ratchets) {
    if (file.startsWith("scripts/gates/convergence/inventories/")) continue
    assert.ok(existsSync(join(REPO_ROOT, file)), `${file} is listed but missing`)
  }
})

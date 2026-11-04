import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import { createHash } from "node:crypto"
import { codeIndexBenchmark, canonical, validateFixture } from "./code-index-workers.mjs"

async function fixture() {
  const cache = path.resolve(".cache/code-index-workers")
  await fs.mkdir(cache, { recursive: true })
  const base = await fs.mkdtemp(path.join(cache, "harness-test-"))
  const directory = path.join(base, "fixture")
  await fs.mkdir(directory)
  const manifest = []
  for (const [name, text] of Object.entries({
    "a.ts": "export function first(){return second()} export function second(){return 1}",
    "b.ts": "export function third(){return 3}",
    "c.py": "def python_fn():\n    return 1\n",
  })) {
    const bytes = Buffer.from(text)
    await fs.writeFile(path.join(directory, name), bytes)
    manifest.push({
      path: name,
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    })
  }
  await fs.writeFile(path.join(base, "fixture.json"), JSON.stringify(manifest))
  return { base, directory, manifest }
}

test("invalid index contracts fail before processes or fixtures are created", async () => {
  for (const options of [
    {},
    { output: "unused", workers: [] },
    { output: "unused", workers: [1] },
    { output: "unused", iterations: 0 },
  ]) {
    await assert.rejects(codeIndexBenchmark(options), /invalid.*contract/)
  }
  assert.deepEqual(canonical({ z: { b: 2, a: 1 }, a: [2, 1] }), { a: [2, 1], z: { a: 1, b: 2 } })
})

test("fixture validation rejects extra source, cached indexes and altered bytes", async () => {
  const { directory, manifest } = await fixture()
  await validateFixture(directory, manifest)
  const extra = path.join(directory, "extra.ts")
  await fs.writeFile(extra, "export function extra(){}")
  await assert.rejects(validateFixture(directory, manifest), /inventory/)
  await fs.unlink(extra)
  await fs.mkdir(path.join(directory, ".cognia"))
  await assert.rejects(validateFixture(directory, manifest), /index cache/)
  await fs.rmdir(path.join(directory, ".cognia"))
  await fs.appendFile(path.join(directory, "a.ts"), "// changed")
  await assert.rejects(validateFixture(directory, manifest), /changed/)
})

test(
  "actual Node/Bun A/B probes validate results, worker execution, retirement and SQLite parity",
  { timeout: 45_000, skip: !process.env.COGNIA_TEST_BUN },
  async () => {
    const { base, directory } = await fixture()
    const report = await codeIndexBenchmark({
      output: path.join(base, "run"),
      fixture: directory,
      bun: process.env.COGNIA_TEST_BUN,
      iterations: 1,
      warmups: 0,
    })
    assert.deepEqual(report.failures, [])
    assert.equal(report.sourceUnchanged, true)
    assert.equal(report.samples.length, 4)
    for (const runtime of ["node", "bun"]) {
      const [serial, worker] = report.samples.filter((sample) => sample.runtime === runtime)
      assert.equal(worker.identity.bun !== null, runtime === "bun")
      assert.equal(serial.maxLiveWorkers, 0)
      assert.equal(worker.maxLiveWorkers, 2)
      assert.equal(worker.liveWorkers, 0)
      assert.equal(worker.workerErrors, 0)
      assert.equal(worker.extraction.worker, 6)
      assert.equal(worker.extraction.fallback, 0)
      assert.ok(worker.fullGraphSha256)
      assert.equal(worker.fullGraphSha256, serial.fullGraphSha256)
      for (const [index, phase] of worker.phases.entries()) {
        assert.equal(phase.signature.hash, serial.phases[index].signature.hash)
        assert.ok(phase.elapsedMs >= 0)
      }
    }
  }
)

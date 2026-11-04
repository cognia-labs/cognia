import { test } from "node:test"
import assert from "node:assert/strict"
import {
  summarize,
  treeRss,
  readySignal,
  launchArgs,
  processFootprint,
  benchmark,
} from "./host-js-runtime.mjs"

test("targeted reruns reject unknown, duplicate or empty process roles before spawning", async () => {
  for (const roles of [[], ["unknown"], ["brain", "brain"]]) {
    await assert.rejects(benchmark({ roles }), /roles must contain/)
  }
})

test(
  "physical footprint reads a live process and refuses an absent process",
  { skip: process.platform !== "darwin" },
  () => {
    assert.ok(processFootprint(process.pid) > 0)
    assert.throws(() => processFootprint(2147483647), /proc_pid_rusage failed/)
  }
)

test("Bun measurements cannot load ambient dotenv files and record role flags", () => {
  assert.deepEqual(launchArgs("brain", "node", "entry.mjs"), ["entry.mjs", "serve"])
  assert.deepEqual(launchArgs("sidecar", "node", "entry.mjs"), ["entry.mjs"])
  assert.deepEqual(launchArgs("brain", "bun", "entry.mjs"), ["--no-env-file", "entry.mjs", "serve"])
  assert.deepEqual(launchArgs("sidecar", "bun", "entry.mjs", ["--smol"]), [
    "--no-env-file",
    "--smol",
    "entry.mjs",
  ])
})

test("readiness uses the completed runtime bootstrap, not bridge or first output", () => {
  assert.equal(readySignal("brain", "serve: bridge connected (ws://localhost)"), false)
  assert.equal(readySignal("brain", "serve: runtimes up (scheduler)"), true)
  assert.equal(readySignal("sidecar", '{"type":"log","message":"ready"}'), false)
  assert.equal(readySignal("sidecar", '{"type":"ready"}'), true)
  assert.equal(readySignal("sidecar", "not JSON"), false)
})

test("RSS includes descendants in any ps order and refuses a missing process", () => {
  assert.deepEqual(treeRss("12 11 1024\n10 1 2048\n11 10 3072\n99 1 9999", 10), {
    processMiB: 2,
    treeMiB: 6,
  })
  assert.throws(() => treeRss("99 1 1000", 10), /disappeared/)
})

test("summaries retain outliers and handle even and odd trial counts", () => {
  assert.deepEqual(summarize([1, 100, 2, 3]), { min: 1, median: 2.5, mad: 1, p95: 100, max: 100 })
  assert.equal(summarize([3, 1, 2]).median, 2)
  assert.throws(() => summarize([]))
  assert.throws(() => summarize([NaN]))
})

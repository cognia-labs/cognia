import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import { firstRequestBenchmark, REQUEST_MODES } from "./host-first-request.mjs"

test("request benchmark rejects invalid modes and sample contracts before spawning", async () => {
  for (const options of [
    {},
    { output: "unused", modes: [] },
    { output: "unused", modes: ["unknown"] },
    { output: "unused", iterations: 0 },
  ]) {
    await assert.rejects(firstRequestBenchmark(options), /invalid.*contract/)
  }
})

test(
  "real Node/Bun first-request probes validate replies, proxy routing, CIDR and DNS refusals",
  { timeout: 90_000, skip: !process.env.COGNIA_TEST_BUN },
  async () => {
    const cache = path.resolve(".cache/bun-host-runtime")
    await fs.mkdir(cache, { recursive: true })
    const output = await fs.mkdtemp(path.join(cache, "request-harness-test-"))
    const report = await firstRequestBenchmark({
      output,
      bun: process.env.COGNIA_TEST_BUN,
      iterations: 1,
      warmups: 0,
    })
    assert.deepEqual(report.failures, [])
    assert.equal(report.sidecarSourceUnchanged, true)
    assert.equal(report.samples.length, REQUEST_MODES.length * 2)
    for (const sample of report.samples) {
      assert.ok(sample.firstRequestMs > 0)
      assert.ok(sample.firstFromSpawnMs > sample.firstRequestMs)
      assert.ok(sample.warmRequestMs > 0)
    }
  }
)

test(
  "a host requiring forced cleanup is a failed measurement",
  { timeout: 20_000, skip: !process.env.COGNIA_TEST_BUN },
  async () => {
    const cache = path.resolve(".cache/bun-host-runtime")
    await fs.mkdir(cache, { recursive: true })
    const output = await fs.mkdtemp(path.join(cache, "request-cleanup-test-"))
    const wrapper = path.join(output, "stuck-host.cjs")
    // Run the real host and forward IPC, but deliberately keep its supervisor
    // alive after the host exits. Timing replies alone must not count as success.
    await fs.writeFile(
      wrapper,
      `#!${process.execPath}
const {spawn}=require("node:child_process");
const child=spawn(${JSON.stringify(process.execPath)},process.argv.slice(2),{stdio:[0,1,2,"ipc"]});
process.on("message",message=>child.connected&&child.send(message));
child.on("message",message=>process.connected&&process.send(message));
setInterval(()=>{},1000);
`,
      { mode: 0o755 }
    )
    const report = await firstRequestBenchmark({
      output,
      node: wrapper,
      bun: process.env.COGNIA_TEST_BUN,
      iterations: 1,
      warmups: 0,
      modes: ["guard"],
    })
    assert.equal(report.failures.length, 1)
    assert.equal(report.failures[0].runtime, "node")
    assert.match(report.failures[0].error, /unclean host shutdown.*forced=true/)
    assert.equal(report.samples.length, 1)
    assert.equal(report.samples[0].runtime, "bun")
  }
)

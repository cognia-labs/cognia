import { test } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { cpuHotspots, startupTrace, memoryPreload } from "./host-js-profile.mjs"
import { trial } from "./host-js-runtime.mjs"

test("profile CLI reports invalid modes without an unsettled circular import", () => {
  const child = spawnSync(
    process.execPath,
    [new URL("./host-js-runtime.mjs", import.meta.url).pathname, "--profile", "unknown"],
    { encoding: "utf8", timeout: 5000 }
  )
  assert.equal(child.status, 1)
  assert.match(child.stderr, /unknown profile kind/)
  assert.doesNotMatch(child.stderr, /unsettled top-level await/)
})

test("CPU hotspots use sample duration and distinguish own from inclusive time", () => {
  const profile = {
    nodes: [
      { id: 1, callFrame: { functionName: "root" }, children: [2] },
      { id: 2, callFrame: { functionName: "work" } },
    ],
    samples: [1, 2, 2],
    timeDeltas: [1000, 2000, 7000],
  }
  const result = cpuHotspots(profile)
  assert.equal(result.totalMs, 10)
  assert.equal(result.frames[0].functionName, "work")
  assert.equal(result.frames[0].selfUs, 9000)
  assert.equal(result.frames[1].inclusiveUs, 10000)
  assert.throws(() => cpuHotspots({ ...profile, samples: [9], timeDeltas: [1] }), /unknown CPU/)
  assert.throws(() => cpuHotspots({ ...profile, timeDeltas: [] }), /counts differ/)
})

test("startup traces preserve completed ready and exclude shutdown work", () => {
  const trace = startupTrace(
    [
      { line: "unrelated log", elapsedMs: 3 },
      { line: "serve: bridge connected", elapsedMs: 10 },
      { line: "serve: runtimes up (scheduler)", elapsedMs: 30 },
      { line: "serve: stopped", elapsedMs: 50 },
    ],
    "brain/bun"
  )
  assert.equal(trace.traceEvents.length, 3)
  assert.equal(trace.traceEvents[1].dur, 10000)
  assert.equal(trace.traceEvents[2].ts, 10000)
  assert.equal(trace.traceEvents[2].dur, 20000)
})

test("profiles with missing idle samples flag long gaps instead of claiming CPU time", () => {
  const result = cpuHotspots({
    nodes: [{ id: 1, callFrame: { functionName: "work" } }],
    samples: [1, 1],
    timeDeltas: [1000, 5000000],
  })
  assert.equal(result.frames[0].selfSamples, 2)
  assert.equal(result.maxGapMs, 5000)
  assert.match(result.warning, /idle|CPU/)
})

test("out-of-order CPU timestamps retain sample counts but disable duration attribution", () => {
  const result = cpuHotspots({
    nodes: [{ id: 1, callFrame: { functionName: "work" } }],
    samples: [1, 1, 1],
    timeDeltas: [1000, -5, 1000],
  })
  assert.equal(result.frames[0].selfSamples, 3)
  assert.equal(result.frames[0].selfUs, null)
  assert.equal(result.negativeDeltas, 1)
  assert.match(result.warning, /out-of-order/)
})

for (const runtime of ["node", "bun"]) {
  const executable = runtime === "node" ? process.execPath : process.env.COGNIA_TEST_BUN
  test(
    `real ${runtime} profiling preserves ready, stderr milestones and loadable heap snapshots`,
    { skip: !executable },
    async () => {
      const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cognia-profile-test-"))
      try {
        const preload = path.join(directory, "preload.mjs")
        const entry = path.join(directory, "entry.mjs")
        await fs.writeFile(preload, memoryPreload(directory))
        await fs.writeFile(
          entry,
          'process.stderr.write("serve: fixture milestone\\n");process.stdout.write(JSON.stringify({type:"ready"})+"\\n");process.stdin.resume()'
        )
        const lines = []
        let sampled = false
        const result = await trial({
          role: "sidecar",
          runtime,
          executable,
          entry,
          fixtureUrl: "http://127.0.0.1:1",
          directory,
          idleMs: 0,
          runtimeArgs: ["--import", preload],
          onLine: (line) => lines.push(line),
          onSample: async ({ pid }) => {
            sampled = true
            process.kill(pid, "SIGUSR2")
            const deadline = Date.now() + 10000
            while (
              !(await fs.access(path.join(directory, "heap-complete.json")).then(
                () => true,
                () => false
              ))
            ) {
              if (Date.now() > deadline) throw new Error("snapshot timed out")
              await new Promise((resolve) => setTimeout(resolve, 20))
            }
          },
        })
        assert.equal(sampled, true)
        assert.equal(result.readyLine, '{"type":"ready"}')
        assert.ok(
          lines.some(
            (event) => event.stream === "stderr" && event.line === "serve: fixture milestone"
          )
        )
        const snapshot = JSON.parse(
          await fs.readFile(path.join(directory, "ready.heapsnapshot"), "utf8")
        )
        assert.ok(snapshot.snapshot.meta.node_fields.includes("self_size"))
        assert.ok(snapshot.nodes.length > 0)
      } finally {
        await fs.rm(directory, { recursive: true, force: true })
      }
    }
  )
}

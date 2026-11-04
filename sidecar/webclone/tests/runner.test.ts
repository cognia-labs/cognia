// Tests for the engine runner (job parsing + job execution). Imports the BUILT
// output. The convert path runs the real component extractor on a tiny local
// fixture (no network); the snapshot path is exercised via an SSRF-blocked URL
// so it fails fast without touching the network.

import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawnSync } from "node:child_process"

import { readJob, runJob } from "../dist/runner.js"
import { runPool } from "../dist/worker/pool.js"

test("runner worker deadlines do not keep a completed or failed process alive", () => {
  for (const rejects of [false, true]) {
    const source = `
      import { runPool } from ${JSON.stringify(new URL("../dist/worker/pool.js", import.meta.url).href)};
      const rejects = ${rejects};
      try {
        await runPool([async () => { if (rejects) throw new Error('fixture'); return 42; }], {concurrency:1,timeoutMs:60000});
        if (rejects) throw new Error('worker error was swallowed');
      } catch (error) {
        if (!rejects || error.message !== 'fixture') throw error;
      }
      console.log('settled');
    `
    const result = spawnSync(process.execPath, ["--input-type=module", "--eval", source], {
      encoding: "utf8",
      timeout: 3000,
    })
    assert.equal(result.status, 0, result.stderr || String(result.error))
    assert.match(result.stdout, /settled/)
  }
})

test("worker deadline still stops queued work and waits for the in-flight task", async () => {
  let release!: () => void
  let queued = false
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const running = runPool(
    [
      async () => {
        await gate
        return 42
      },
      async () => {
        queued = true
        return 99
      },
    ],
    { concurrency: 1, timeoutMs: 5 }
  )
  await new Promise((resolve) => setTimeout(resolve, 15))
  release()
  const result = await running
  assert.equal(queued, false)
  assert.equal(result[0], 42)
  assert.equal(1 in result, false)
})

test("a rejected pool cannot let a pending sibling start queued work after its deadline", async () => {
  let release!: () => void
  let queued = false
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const running = runPool(
    [
      async () => {
        throw new Error("worker failed")
      },
      async () => {
        await gate
        return 42
      },
      async () => {
        queued = true
        return 99
      },
    ],
    { concurrency: 2, timeoutMs: 5 }
  )
  await assert.rejects(running, /worker failed/)
  await new Promise((resolve) => setTimeout(resolve, 15))
  release()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(queued, false)
})

function tmp(prefix: any) {
  return mkdtempSync(join(tmpdir(), prefix))
}

test("readJob parses a job file and validates mode", () => {
  const dir = tmp("wc-readjob-")
  try {
    const jobPath = join(dir, "job.json")
    writeFileSync(
      jobPath,
      JSON.stringify({ mode: "snapshot", url: "https://example.com/", options: {} })
    )
    const job = readJob(["node", "runner.js", jobPath])
    assert.equal(job.mode, "snapshot")
    assert.equal(job.url, "https://example.com/")

    writeFileSync(jobPath, JSON.stringify({ mode: "bogus", options: {} }))
    assert.throws(() => readJob(["node", "runner.js", jobPath]), /Invalid job\.mode/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("runJob rejects snapshot without a url", async () => {
  const env = await runJob({ mode: "snapshot", options: { output: "/tmp/x.html" } })
  assert.equal(env.ok, false)
  assert.match(env.error!.message, /requires a url/)
})

test("runJob(snapshot) fails fast on an SSRF-blocked target", async () => {
  const dir = tmp("wc-ssrf-")
  try {
    const env = await runJob({
      mode: "snapshot",
      url: "http://169.254.169.254/latest/meta-data/",
      options: {
        output: join(dir, "out.html"),
        mode: "single",
        maxAssets: 5,
        concurrency: 2,
        timeout: 3000,
        retryCount: 0,
        inline: true,
        pretty: false,
      },
    })
    assert.equal(env.ok, false)
    assert.equal(env.error!.reason, "private-host")
    assert.equal(env.error!.name, "FetchTargetBlockedError")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("runJob(convert) extracts components from a local bundle fixture", async () => {
  const fixture = tmp("wc-convert-in-")
  const out = tmp("wc-convert-out-")
  try {
    // Minimal bundle: an index.html with a semantic component + inline style/logic.
    writeFileSync(
      join(fixture, "index.html"),
      `<!doctype html><html><head><style>.card{color:red}</style></head>` +
        `<body><header class="card" data-component="Hero"><h1>Hi</h1>` +
        `<button onclick="alert(1)">Go</button></header>` +
        `<script>let count = 0; function inc(){ count++ }</script></body></html>`
    )
    const env = await runJob({
      mode: "convert",
      options: {
        convertLocal: fixture,
        output: out,
        mode: "bundle",
        maxAssets: 0,
        concurrency: 1,
        timeout: 1000,
        retryCount: 0,
        inline: false,
        pretty: false,
        extractComponents: true,
        extractLogic: true,
      },
    })
    assert.equal(env.ok, true, JSON.stringify(env))
    assert.equal(env.result!.mode, "convert")
    assert.equal(env.result!.output, out)
    assert.ok(Array.isArray(env.result!.assets))
    // The extractor wrote a components/ directory with an index.json.
    const idx = readFileSync(join(out, "components", "index.json"), "utf8")
    assert.ok(idx.length > 0)
  } finally {
    rmSync(fixture, { recursive: true, force: true })
    rmSync(out, { recursive: true, force: true })
  }
})

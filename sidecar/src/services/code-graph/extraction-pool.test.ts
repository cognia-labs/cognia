import test from "node:test"
import assert from "node:assert/strict"
import { Worker } from "node:worker_threads"
import { once } from "node:events"
import fs from "node:fs/promises"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { createExtractionPool } from "./extraction-pool.ts"
import { extractFile } from "./extractor.ts"

const sourceCases = [
  [
    "a.ts",
    "export class Base {}\nexport class A extends Base { run() { return other(); } }\nfunction other() { return 1; }",
  ],
  ["b.tsx", "export function View() { return <div/>; }"],
  [
    "c.rs",
    "pub trait Run { fn run(&self); }\npub struct Runner {}\nimpl Run for Runner { fn run(&self) {} }",
  ],
  ["d.py", "def run():\n    return other()\ndef other():\n    return 1\n"],
] as const
const normalized = (value: unknown) =>
  JSON.parse(JSON.stringify(value), (key, item) => (key === "updated_at" ? undefined : item))

test("real workers reproduce every extractor field for all supported grammars", async () => {
  const pool = createExtractionPool()
  try {
    for (const [filePath, source] of sourceCases) {
      const actual = await pool.extract(filePath, source)
      assert.deepEqual(actual.errors, [])
      assert.deepEqual(normalized(actual), normalized(await extractFile(filePath, source)))
    }
  } finally {
    pool.dispose()
  }
})

test("idle workers retire, a later task restarts, and disposal refuses future work", async () => {
  const workers: Worker[] = []
  const exits: Promise<unknown>[] = []
  const pool = createExtractionPool({
    idleMs: 15,
    workerFactory: () => {
      const worker = new Worker(new URL("./extraction-pool.ts", import.meta.url), {
        workerData: { role: "cognia-code-graph-extraction" },
        execArgv: [],
      })
      workers.push(worker)
      exits.push(once(worker, "exit"))
      return worker
    },
  })
  assert.equal(workers.length, 0)
  await pool.extract("a.ts", "export function first() {}")
  assert.equal(workers.length, 2)
  await Promise.all(exits.slice())
  await pool.extract("b.py", "def second():\n    pass\n")
  assert.equal(
    workers.length,
    4,
    "two retired threads are replaced, never kept alongside the new pair"
  )
  pool.dispose()
  pool.dispose()
  await assert.rejects(pool.extract("late.ts", "function late(){}"), /disposed/)
  await Promise.all(exits)
})

test("a worker boot failure rejects all pending jobs and latches unavailable", async () => {
  const pool = createExtractionPool({
    workerFactory: () => {
      throw new Error("fixture boot failure")
    },
  })
  await assert.rejects(pool.extract("a.ts", "function a(){}"), /boot failure/)
  await assert.rejects(pool.extract("b.ts", "function b(){}"), /unavailable/)
  pool.dispose()
})

test("reentrant disposal inside a worker factory terminates the unregistered thread", async () => {
  const workers: Worker[] = []
  const exits: Promise<unknown>[] = []
  const pool = createExtractionPool({
    workerFactory: () => {
      const worker = new Worker(
        new URL(
          "data:text/javascript,import{parentPort}from'node:worker_threads';parentPort.on('message',()=>{});"
        ),
        { execArgv: [] }
      )
      workers.push(worker)
      exits.push(once(worker, "exit"))
      pool.dispose()
      return worker
    },
  })
  await assert.rejects(pool.extract("a.ts", "a"), /disposed/)
  assert.equal(workers.length, 1)
  await Promise.all(exits)
})

test("unresponsive workers time out and dispose rejects queued/in-flight work", async () => {
  const workers: Worker[] = []
  const factory = () => {
    const worker = new Worker(
      new URL(
        "data:text/javascript,import{parentPort}from'node:worker_threads';parentPort.on('message',()=>{});"
      ),
      { execArgv: [] }
    )
    workers.push(worker)
    return worker
  }
  const stalled = createExtractionPool({ taskTimeoutMs: 30, workerFactory: factory })
  const results = await Promise.allSettled([
    stalled.extract("a.ts", "a"),
    stalled.extract("b.ts", "b"),
  ])
  assert.ok(results.every((r) => r.status === "rejected" && /timed out/.test(String(r.reason))))
  stalled.dispose()
  const closing = createExtractionPool({ workerFactory: factory })
  const queued = [
    closing.extract("a.ts", "a"),
    closing.extract("b.ts", "b"),
    closing.extract("c.ts", "c"),
  ]
  const settled = Promise.allSettled(queued)
  closing.dispose()
  assert.ok(
    (await settled).every((r) => r.status === "rejected" && /disposed/.test(String(r.reason)))
  )
  await Promise.all(workers.map((w) => w.terminate()))
})

test(
  "relocated esbuild chunks execute the worker module on actual Node and Bun",
  { timeout: 30_000, skip: !process.env.COGNIA_TEST_BUN },
  async () => {
    const { loadEsbuild } = await import("../../../../scripts/build/esbuild-shared.mjs")
    const esbuild = await loadEsbuild()
    const cache = path.resolve(".cache/code-index-workers")
    await fs.mkdir(cache, { recursive: true })
    const base = await fs.mkdtemp(path.join(cache, "bundle-test-"))
    const built = path.join(base, "built"),
      relocated = path.join(base, "relocated")
    await esbuild.build({
      entryPoints: { index: new URL("./index-service.ts", import.meta.url).pathname },
      outdir: built,
      bundle: true,
      splitting: true,
      format: "esm",
      platform: "node",
      target: "node26",
      packages: "external",
      outExtension: { ".js": ".mjs" },
      logLevel: "silent",
    })
    await fs.copyFile(new URL("./schema.sql", import.meta.url), path.join(built, "schema.sql"))
    await fs.symlink(path.resolve("sidecar/node_modules"), path.join(built, "node_modules"), "dir")
    await fs.rename(built, relocated)
    const root = path.join(base, "repo")
    await fs.mkdir(root)
    await fs.writeFile(path.join(root, "a.ts"), "export function bundledWorker() { return 42; }")
    for (const [runtime, executable] of [
      ["node", process.execPath],
      ["bun", process.env.COGNIA_TEST_BUN],
    ] as const) {
      const source = `
      const assert=(await import("node:assert/strict")).default;
      const {createIndexService}=await import(${JSON.stringify(new URL(`file://${path.join(relocated, "index.mjs")}`).href)});
      let created=0,completed=0,fallback=0;process.on("worker",()=>created++);
      const svc=createIndexService({root:${JSON.stringify(root)},forceMemory:true,extractionWorkers:2,onExtraction:event=>{if(event==="worker")completed++;if(event==="fallback")fallback++}});
      try {await svc.ensureIndexed();assert.equal(created,2);assert.equal(completed,1);assert.equal(fallback,0);assert.ok(svc.search("bundledWorker").length)}finally{svc.dispose()}
    `
      execFileSync(
        executable!,
        [...(runtime === "bun" ? ["--no-env-file"] : []), "--input-type=module", "--eval", source],
        { timeout: 15_000, stdio: "pipe" }
      )
    }
  }
)

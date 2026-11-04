import test from "node:test"
import assert from "node:assert/strict"
import os from "node:os"
import fs from "node:fs"
import fsp from "node:fs/promises"
import path from "node:path"
import type { Worker } from "node:worker_threads"
import { execFileSync } from "node:child_process"

import { createIndexService } from "./index-service.ts"

test("explicit indexing workers are lazy, shared across sessions and preserve queries", async () => {
  const workers: Worker[] = []
  const observe = (worker: Worker) => workers.push(worker)
  process.on("worker", observe)
  const firstRoot = await tmpRepo({
    "format.ts": "export function format(s: string) { return s.trim(); }",
    "run.ts": "import {format} from './format'; export function run() { return format('x'); }",
  })
  const secondRoot = await tmpRepo({ "other.py": "def other():\n    return 1\n" })
  const first = createIndexService({ root: firstRoot, forceMemory: true, extractionWorkers: 2 })
  const second = createIndexService({ root: secondRoot, forceMemory: true, extractionWorkers: 2 })
  try {
    assert.equal(workers.length, 0)
    await Promise.all([first.ensureIndexed(), second.ensureIndexed()])
    assert.equal(workers.length, 2, "sessions share the same two threads")
    const format = first.search("format").find((n) => n.name === "format")!
    assert.ok(first.callers(format.id).some((row) => row.node?.name === "run"))
    assert.ok(second.search("other").some((n) => n.name === "other"))
    first.dispose()
    assert.ok(second.search("other").length)
  } finally {
    first.dispose()
    second.dispose()
    process.off("worker", observe)
    await Promise.all(workers.map((worker) => worker.terminate()))
    await fsp.rm(firstRoot, { recursive: true, force: true })
    await fsp.rm(secondRoot, { recursive: true, force: true })
  }
})

for (const [runtime, executable] of [
  ["node", process.execPath],
  ["bun", process.env.COGNIA_TEST_BUN],
] as const) {
  test(
    `actual ${runtime} worker indexing matches serial graphs and fails back without replaying writes`,
    { skip: !executable, timeout: 30_000 },
    () => {
      const source = `
      const assert=(await import("node:assert/strict")).default;
      const fs=await import("node:fs/promises");
      const os=await import("node:os");const path=await import("node:path");
      const {createIndexService}=await import(${JSON.stringify(new URL("./index-service.ts", import.meta.url).href)});
      const root=await fs.mkdtemp(path.join(os.tmpdir(),"cg-thread-parity-"));
      const files={"a.ts":"export function first(){return second()} export function second(){return 1}","b.tsx":"export function View(){return <div/>}","c.rs":"pub fn rust_fn() {}","d.py":"def python_fn():\\n    return 1\\n"};
      for(const [rel,text]of Object.entries(files))await fs.writeFile(path.join(root,rel),text);
      const normalize=value=>JSON.parse(JSON.stringify(value),(key,v)=>["updated_at","indexed_at","modified_at","root"].includes(key)?undefined:v);
      let clock=10000,created=0;
      const observe=()=>created++;process.on("worker",observe);
      const serial=createIndexService({root,forceMemory:true,extractionWorkers:0,now:()=>clock});
      const parallel=createIndexService({root,forceMemory:true,extractionWorkers:2,now:()=>clock});
      const snapshot=svc=>({status:normalize(svc.status()),files:normalize(svc.files()),queries:["first","second","View","rust_fn","python_fn","changed"].map(q=>svc.search(q).map(n=>({node:normalize(n),snippet:svc.snippetFor(n),calls:normalize(svc.callees(n.id)),callers:normalize(svc.callers(n.id))})))});
      try {
        await serial.ensureIndexed();assert.equal(created,0);
        await parallel.ensureIndexed();assert.equal(created,2);assert.deepEqual(snapshot(parallel),snapshot(serial));
        clock+=5000;await fs.writeFile(path.join(root,"a.ts"),"export function changed(){return 2}");await fs.unlink(path.join(root,"c.rs"));await fs.writeFile(path.join(root,"added.ts"),"export function added(){}");
        await serial.syncStale();await parallel.syncStale();assert.deepEqual(snapshot(parallel),snapshot(serial));
      } finally {serial.dispose();parallel.dispose();process.off("worker",observe)}
      let attempted=0;
      const crash=w=>{attempted++;if(attempted===1)void w.terminate()};process.on("worker",crash);
      const fallback=createIndexService({root,forceMemory:true,extractionWorkers:2,now:()=>clock});
      try {
        await fallback.ensureIndexed();assert.ok(fallback.search("changed").length);assert.equal(attempted,2);
        clock+=5000;await fs.writeFile(path.join(root,"a.ts"),"export function afterCrash(){}");await fallback.syncStale();
        assert.ok(fallback.search("afterCrash").length);assert.equal(attempted,2,"failed worker pool must stay disabled for this index");
      } finally {fallback.dispose();process.off("worker",crash);await fs.rm(root,{recursive:true,force:true})}
    `
      execFileSync(
        executable!,
        [...(runtime === "bun" ? ["--no-env-file"] : []), "--input-type=module", "--eval", source],
        { timeout: 25_000, stdio: "pipe", env: { ...process.env, COGNIA_CODE_INDEX_WORKERS: "0" } }
      )
    }
  )
}

test("dispose fences queued extraction and never recreates an index store", async () => {
  const root = await tmpRepo({ "a.ts": "export function cancelled() {}" })
  const service = createIndexService({ root, extractionWorkers: 2 })
  const pending = assert.rejects(service.ensureIndexed(), /disposed/)
  service.dispose()
  await pending
  await assert.rejects(service.ensureIndexed(), /disposed/)
  await assert.rejects(service.syncStale(), /disposed/)
  assert.equal(service.status().indexed, false)
  assert.equal(service.status().watching, false)
  await fsp.rm(root, { recursive: true, force: true })
})

test("dispose during actual worker startup refuses late index publication", async () => {
  const root = await tmpRepo({ "a.ts": "export function cancelledDuringStartup() {}" })
  const service = createIndexService({ root, extractionWorkers: 2 })
  const workers: Worker[] = []
  const observe = (worker: Worker) => {
    workers.push(worker)
    service.dispose()
  }
  process.on("worker", observe)
  try {
    await assert.rejects(service.ensureIndexed(), /disposed/)
    assert.equal(workers.length, 2, "Node reports worker startup after the pair is constructed")
    assert.equal(service.status().fileCount, 0)
    assert.equal(service.status().indexed, false)
    await assert.rejects(service.syncStale(), /disposed/)
  } finally {
    process.off("worker", observe)
    service.dispose()
    await Promise.all(workers.map((worker) => worker.terminate()))
    await fsp.rm(root, { recursive: true, force: true })
  }
})

async function tmpRepo(files: Record<string, string>): Promise<string> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-svc-"))
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel)
    await fsp.mkdir(path.dirname(abs), { recursive: true })
    await fsp.writeFile(abs, content)
  }
  return root
}

test("ensureIndexed builds the graph; status/search/context/callers work", async () => {
  const root = await tmpRepo({
    "src/fmt.ts": `export function format(s: string): string { return s.trim(); }\n`,
    "src/app.ts": `import { format } from "./fmt";\nexport function run(x: string) { return format(x); }\n`,
    "README.md": "# ignored\n",
  })
  const svc = createIndexService({ root, forceMemory: true })
  try {
    await svc.ensureIndexed()
    const st = svc.status()
    assert.equal(st.indexed, true)
    assert.equal(st.fileCount, 2) // only .ts files, not README.md
    assert.ok(st.nodeCount >= 2)
    assert.equal(st.languages.typescript, 2)

    // search finds format
    const hits = svc.search("format")
    const fmt = hits.find((h) => h.name === "format")
    assert.ok(fmt)

    // cross-file call resolved: run() calls format()
    const callers = svc.callers(fmt.id)
    assert.ok(callers.some((c) => c.node?.name === "run"))

    // verbatim snippet
    const node = svc.getNode(fmt.id)
    assert.match(svc.snippetFor(node), /return s\.trim/)

    // context composite
    const ctx = svc.context("how does run format input")
    assert.ok(ctx.entryPoints.length >= 1)
    assert.ok(ctx.relatedFiles.length >= 1)

    // files listing
    assert.equal(svc.files().length, 2)
  } finally {
    svc.dispose()
  }
})

test("Bun.file and Bun.CryptoHasher drive source hashing when available", async () => {
  const root = await tmpRepo({
    "native.ts": `export function nativeHash() { return true; }\n`,
  })
  const calls: [string, string | number][] = []
  class CryptoHasher {
    constructor(algorithm: string) {
      calls.push(["hasher", algorithm])
    }
    update(bytes: Uint8Array) {
      calls.push(["update", bytes.byteLength])
      return this
    }
    digest(encoding: string) {
      calls.push(["digest", encoding])
      return "bun-native-sha1"
    }
  }
  const bunRuntime = {
    CryptoHasher,
    file(abs: string) {
      calls.push(["file", path.basename(abs)])
      return {
        bytes: async () => new TextEncoder().encode(await fsp.readFile(abs, "utf8")),
      }
    },
  }
  const svc = createIndexService({ root, forceMemory: true, bunRuntime })
  try {
    await svc.ensureIndexed()
    assert.ok(svc.search("nativeHash").length >= 1)
    assert.deepEqual(calls.slice(0, 4), [
      ["file", "native.ts"],
      ["hasher", "sha1"],
      ["update", 46],
      ["digest", "hex"],
    ])
  } finally {
    svc.dispose()
  }
})

test("partial Bun hashing capabilities fall back to Node file IO and crypto", async () => {
  const root = await tmpRepo({
    "portable.ts": `export function portableHash() { return true; }\n`,
  })
  const partialBun = {
    file() {
      throw new Error("partial Bun.file must not be selected")
    },
  }
  const svc = createIndexService({ root, forceMemory: true, bunRuntime: partialBun })
  try {
    await svc.ensureIndexed()
    assert.ok(svc.search("portableHash").length >= 1)
  } finally {
    svc.dispose()
  }
})

test("syncStale picks up a content change and re-resolves", async () => {
  const root = await tmpRepo({
    "a.ts": `export function alpha() { return 1; }\n`,
  })
  const svc = createIndexService({ root, forceMemory: true, now: makeClock() })
  try {
    await svc.ensureIndexed()
    assert.equal(svc.search("beta").length, 0)
    await fsp.writeFile(path.join(root, "a.ts"), `export function beta() { return 2; }\n`)
    // advance throttle window by re-creating clock effect: now() jumps below.
    const changed = await svc.syncStale()
    assert.ok(changed >= 1)
    assert.ok(svc.search("beta").length >= 1)
    assert.equal(svc.search("alpha").length, 0) // old symbol gone
  } finally {
    svc.dispose()
  }
})

test("a deleted file is dropped from the index", async () => {
  const root = await tmpRepo({
    "keep.ts": `export function keep() {}\n`,
    "gone.ts": `export function gone() {}\n`,
  })
  const svc = createIndexService({ root, forceMemory: true, now: makeClock() })
  try {
    await svc.ensureIndexed()
    assert.equal(svc.status().fileCount, 2)
    await fsp.rm(path.join(root, "gone.ts"))
    await svc.syncStale()
    assert.equal(svc.status().fileCount, 1)
    assert.equal(svc.search("gone").length, 0)
  } finally {
    svc.dispose()
  }
})

test("persists to a real .cognia/codegraph.db across service instances (sqlite)", async () => {
  const root = await tmpRepo({ "x.ts": `export function persisted() {}\n` })
  const svc1 = createIndexService({ root })
  await svc1.ensureIndexed()
  const binding = svc1.status().binding
  svc1.dispose()
  // The db file should exist when sqlite is the backend.
  if (binding === "sqlite") {
    assert.ok(fs.existsSync(path.join(root, ".cognia", "codegraph.db")))
    const svc2 = createIndexService({ root })
    await svc2.ensureIndexed()
    assert.ok(svc2.search("persisted").length >= 1)
    svc2.dispose()
  }
})

test("stalenessBanner is empty when current", async () => {
  const root = await tmpRepo({ "a.ts": `export function a() {}\n` })
  const svc = createIndexService({ root, forceMemory: true })
  try {
    await svc.ensureIndexed()
    assert.equal(svc.stalenessBanner(), "")
  } finally {
    svc.dispose()
  }
})

/** Monotonic clock that always reports a time past the sync throttle. */
function makeClock() {
  let t = 0
  return () => {
    t += 5000
    return t
  }
}

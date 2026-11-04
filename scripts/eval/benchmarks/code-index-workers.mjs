// Controlled index workload. Parent RSS sampling remains independent of the
// indexed process's event loop; fixture copies and result checks are not timed.
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { spawn, execFileSync } from "node:child_process"
import { once } from "node:events"
import { createHash } from "node:crypto"
import { fileURLToPath, pathToFileURL } from "node:url"
import { summarize, processFootprint } from "./host-js-runtime.mjs"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..")
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export async function sourceIdentity() {
  const digest = createHash("sha256")
  async function visit(directory) {
    for (const entry of (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name)
    )) {
      const file = path.join(directory, entry.name)
      if (entry.isDirectory()) await visit(file)
      else if (!entry.name.includes(".test.") && /\.(ts|sql)$/.test(entry.name))
        digest.update(path.relative(root, file)).update(await fs.readFile(file))
    }
  }
  await visit(path.join(root, "sidecar/src/services/code-graph"))
  return digest.digest("hex")
}

/** Capture once; subsequent comparisons reuse this exact source snapshot. */
export async function prepareCodeIndexFixture(fixture) {
  await fs.mkdir(fixture, { recursive: true })
  const manifestPath = path.join(path.dirname(fixture), "fixture.json")
  try {
    return JSON.parse(await fs.readFile(manifestPath, "utf8"))
  } catch (error) {
    if (error.code !== "ENOENT") throw error
  }
  const paths = execFileSync(
    "rg",
    ["--files", "sidecar/src", "lib", "components", "crates", "scripts"],
    { cwd: root, encoding: "utf8" }
  )
    .trim()
    .split("\n")
  const manifest = []
  for (const [extension, target] of [
    [".ts", 96],
    [".tsx", 96],
    [".rs", 64],
    [".py", 16],
  ]) {
    const candidates = []
    for (const file of paths
      .filter((p) => p.endsWith(extension) && !p.includes(".test.") && !p.includes("/generated/"))
      .sort()) {
      const stat = await fs.stat(path.join(root, file))
      if (stat.size >= 100 && stat.size <= 96 * 1024) candidates.push(file)
    }
    const count = Math.min(target, candidates.length)
    for (let i = 0; i < count; i++) {
      const name =
        candidates[count === 1 ? 0 : Math.round((i * (candidates.length - 1)) / (count - 1))]
      const bytes = await fs.readFile(path.join(root, name)),
        destination = path.join(fixture, name)
      await fs.mkdir(path.dirname(destination), { recursive: true })
      await fs.writeFile(destination, bytes)
      manifest.push({
        path: name,
        bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      })
    }
  }
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n")
  return manifest
}

export function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])])
    )
  return value
}

export async function validateFixture(fixture, manifest) {
  if (!Array.isArray(manifest) || !manifest.length) throw new Error("invalid fixture manifest")
  const expected = new Set(manifest.map((entry) => entry.path))
  const actual = []
  async function visit(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name)
      if (entry.isSymbolicLink()) throw new Error("fixture contains a symbolic link")
      if (entry.isDirectory()) {
        if (entry.name === ".cognia") throw new Error("fixture contains an index cache")
        await visit(absolute)
      } else actual.push(path.relative(fixture, absolute).split(path.sep).join("/"))
    }
  }
  await visit(fixture)
  if (actual.length !== expected.size || actual.some((file) => !expected.has(file)))
    throw new Error("fixture inventory differs from manifest")
  for (const entry of manifest) {
    if (path.isAbsolute(entry.path) || entry.path.split(/[\\/]/).includes(".."))
      throw new Error("invalid fixture path")
    const bytes = await fs.readFile(path.join(fixture, entry.path))
    if (
      bytes.length !== entry.bytes ||
      createHash("sha256").update(bytes).digest("hex") !== entry.sha256
    )
      throw new Error(`fixture changed: ${entry.path}`)
  }
}

async function sqliteGraphHash(workspace) {
  const { loadSqliteBinding } = await import("../../../sidecar/src/services/code-graph/store.ts")
  const Database = loadSqliteBinding()
  if (!Database) throw new Error("SQLite inspection binding unavailable")
  const database = new Database(path.join(workspace, ".cognia/codegraph.db"))
  const graph = {}
  try {
    for (const table of ["files", "nodes", "edges", "unresolved_refs"]) {
      graph[table] = database
        .prepare(`SELECT * FROM ${table}`)
        .all()
        .map((row) => {
          for (const key of ["updated_at", "indexed_at", "modified_at"]) delete row[key]
          if (table === "edges" || table === "unresolved_refs") delete row.id
          return JSON.stringify(canonical(row))
        })
        .sort()
    }
  } finally {
    database.close()
  }
  return createHash("sha256").update(JSON.stringify(graph)).digest("hex")
}

function graphSignature(service) {
  const normalize = (value) =>
    JSON.parse(JSON.stringify(value), (key, item) =>
      ["updated_at", "indexed_at", "modified_at", "root"].includes(key) ? undefined : item
    )
  const files = service
    .files()
    .map(normalize)
    .sort((a, b) => a.path.localeCompare(b.path))
  const queries = Object.fromEntries(
    ["create", "parse", "render", "get", "main", "test", "benchmarkIncremental"].map((query) => [
      query,
      service.search(query, { limit: 50 }).map(normalize),
    ])
  )
  const status = service.status()
  const snapshot = canonical({
    files,
    queries,
    status: {
      fileCount: status.fileCount,
      nodeCount: status.nodeCount,
      edgeCount: status.edgeCount,
      unresolvedCount: status.unresolvedCount,
      languages: status.languages,
      binding: status.binding,
    },
  })
  return {
    snapshot,
    hash: createHash("sha256").update(JSON.stringify(snapshot)).digest("hex"),
    status: normalize(status),
  }
}

async function childMain(workspace) {
  const { createIndexService } =
    await import("../../../sidecar/src/services/code-graph/index-service.ts")
  let clock = 1_000_000
  let workerStarts = 0,
    liveWorkers = 0,
    maxLiveWorkers = 0,
    workerErrors = 0
  const extraction = { worker: 0, serial: 0, fallback: 0 }
  const observeWorker = (worker) => {
    workerStarts++
    liveWorkers++
    maxLiveWorkers = Math.max(maxLiveWorkers, liveWorkers)
    worker.on("exit", () => liveWorkers--)
    worker.on("error", () => workerErrors++)
  }
  process.on("worker", observeWorker)
  const service = createIndexService({
    root: workspace,
    watch: false,
    now: () => clock,
    fileOrder: "lexical",
    onExtraction: (event) => extraction[event]++,
  })
  let active,
    previous = performance.now()
  const heartbeat = setInterval(() => {
    const now = performance.now(),
      lag = Math.max(0, now - previous - 5)
    previous = now
    if (active) active.push(lag)
  }, 5)
  const phases = []
  const measure = async (name, action) => {
    await pause(20)
    active = []
    process.stdout.write(JSON.stringify({ type: "phase", name }) + "\n")
    const started = performance.now()
    const changed = await action()
    const elapsedMs = performance.now() - started
    await pause(12) // flush the final blocked timer without charging elapsed
    const lags = active
    active = null
    const { snapshot, ...signature } = graphSignature(service)
    await fs.writeFile(path.join(workspace, "..", `${name}-graph.json`), JSON.stringify(snapshot))
    const phase = {
      name,
      elapsedMs,
      changed: changed ?? null,
      maxTimerLagMs: Math.max(0, ...lags),
      over16Ms: lags.reduce((sum, lag) => sum + Math.max(0, lag - 16), 0),
      signature,
    }
    phases.push(phase)
    process.stdout.write(JSON.stringify({ type: "phase_end", ...phase }) + "\n")
  }
  try {
    await measure("cold", () => service.ensureIndexed())
    clock += 5000
    await measure("unchanged", () => service.syncStale())
    const files = service
      .files()
      .map((f) => f.path)
      .filter((p) => p.endsWith(".ts"))
      .sort()
      .slice(0, 24)
    for (const [i, rel] of files.entries())
      await fs.appendFile(
        path.join(workspace, rel),
        `\nexport function benchmarkIncremental${i}() { return ${i}; }\n`
      )
    await fs.writeFile(
      path.join(workspace, "benchmark-added.ts"),
      "export function benchmarkAdded() { return 42; }\n"
    )
    await fs.unlink(
      path.join(
        workspace,
        service
          .files()
          .map((f) => f.path)
          .sort()
          .find((file) => !files.includes(file))
      )
    )
    clock += 5000
    await measure("incremental", () => service.syncStale())
    await pause(1300) // retire idle worker pool before separately sampling idle RSS
    if (
      process.env.COGNIA_CODE_INDEX_WORKERS === "2" &&
      (!extraction.worker ||
        extraction.serial ||
        extraction.fallback ||
        workerErrors ||
        maxLiveWorkers !== 2 ||
        liveWorkers !== 0)
    )
      throw new Error(
        `worker measurement failed: ${JSON.stringify({ extraction, workerStarts, maxLiveWorkers, liveWorkers, workerErrors })}`
      )
    process.stdout.write(
      JSON.stringify({
        type: "result",
        phases,
        workerStarts,
        extraction,
        maxLiveWorkers,
        liveWorkers,
        workerErrors,
        identity: {
          node: process.versions.node,
          bun: process.versions.bun ?? null,
          executable: process.execPath,
        },
      }) + "\n"
    )
    process.stdin.resume()
    await once(process.stdin, "end")
  } finally {
    clearInterval(heartbeat)
    process.off("worker", observeWorker)
    service.dispose()
  }
}

async function trial({ executable, runtime, workers, directory, fixture }) {
  const home = await fs.mkdtemp(path.join(directory, `${runtime}-${workers}-`))
  const workspace = path.join(home, "repo")
  const copyStarted = performance.now()
  let fixtureCopyMode = "node-copy"
  if (process.platform === "darwin") {
    try {
      execFileSync("/bin/cp", ["-cR", fixture, workspace], { timeout: 60_000 })
      fixtureCopyMode = "apfs-clone"
    } catch {
      await fs.cp(fixture, workspace, { recursive: true })
    }
  } else await fs.cp(fixture, workspace, { recursive: true })
  const fixtureCopyMs = performance.now() - copyStarted
  const child = spawn(
    executable,
    [
      ...(runtime === "bun" ? ["--no-env-file"] : []),
      fileURLToPath(import.meta.url),
      "--child",
      workspace,
    ],
    {
      cwd: root,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        PATH: process.env.PATH,
        HOME: home,
        USERPROFILE: home,
        TMPDIR: os.tmpdir(),
        NODE_ENV: "production",
        NO_COLOR: "1",
        DO_NOT_TRACK: "1",
        COGNIA_CODE_INDEX_WORKERS: String(workers),
      },
    }
  )
  const exited = once(child, "exit")
  let buffer = "",
    stdout = "",
    stderr = "",
    phase = "initial",
    failure,
    result
  const rss = [],
    waiters = new Set()
  const wake = () => {
    for (const waiter of waiters) waiter()
  }
  child.on("error", (error) => {
    failure = error
    wake()
  })
  child.on("exit", (code, signal) => {
    if (!result) {
      failure = new Error(`index child exited ${code}/${signal}: ${stderr}`)
      wake()
    }
  })
  child.stderr.on("data", (bytes) => {
    stderr += bytes
  })
  child.stdout.on("data", (bytes) => {
    stdout += bytes
    buffer += bytes
    const lines = buffer.split("\n")
    buffer = lines.pop()
    for (const line of lines) {
      try {
        const frame = JSON.parse(line)
        if (frame.type === "phase") phase = frame.name
        if (frame.type === "phase_end") phase = "between"
        if (frame.type === "result") {
          result = frame
          phase = "idle"
          wake()
        }
      } catch {
        /* keep diagnostics in raw output */
      }
    }
  })
  const sampleRss = () => {
    try {
      const value =
        Number(
          execFileSync("ps", ["-o", "rss=", "-p", String(child.pid)], {
            encoding: "utf8",
            timeout: 3000,
          }).trim()
        ) / 1024
      if (value > 0) rss.push({ phase, value })
    } catch {
      /* exit is checked separately */
    }
  }
  const timer = setInterval(sampleRss, 50)
  let deadline
  try {
    await new Promise((resolve, reject) => {
      const check = () => {
        if (result || failure) {
          waiters.delete(check)
          if (failure) reject(failure)
          else resolve()
        }
      }
      deadline = setTimeout(() => {
        waiters.delete(check)
        reject(new Error("index trial timed out"))
      }, 180_000)
      waiters.add(check)
      check()
    })
    clearTimeout(deadline)
    clearInterval(timer)
    sampleRss()
    const footprintMiB = processFootprint(child.pid)
    if ((runtime === "bun") !== Boolean(result.identity.bun))
      throw new Error("index runtime identity mismatch")
    const phases = result.phases.map((p) => {
      const samples = rss.filter((s) => s.phase === p.name).map((s) => s.value)
      return { ...p, peakRssMiB: samples.length ? Math.max(...samples) : null }
    })
    return {
      runtime,
      workers,
      workerStarts: result.workerStarts,
      extraction: result.extraction,
      maxLiveWorkers: result.maxLiveWorkers,
      liveWorkers: result.liveWorkers,
      workerErrors: result.workerErrors,
      identity: result.identity,
      fullGraphSha256: null,
      home,
      fixtureCopyMode,
      fixtureCopyMs,
      phases,
      peakRssMiB: Math.max(...rss.map((s) => s.value)),
      idleRssMiB: rss.at(-1).value,
      idleFootprintMiB: footprintMiB,
      rss,
    }
  } finally {
    clearTimeout(deadline)
    clearInterval(timer)
    child.stdin.end()
    let forced = false
    const cleanup = setTimeout(() => {
      forced = true
      try {
        process.kill(-child.pid, "SIGKILL")
      } catch {
        child.kill("SIGKILL")
      }
    }, 5000)
    try {
      const [code, signal] = await exited
      if (forced || code !== 0 || signal) throw new Error(`unclean index exit ${code}/${signal}`)
    } finally {
      clearTimeout(cleanup)
      child.stdout.destroy()
      child.stderr.destroy()
      await fs.writeFile(path.join(home, "stdout.log"), stdout)
      await fs.writeFile(path.join(home, "stderr.log"), stderr)
    }
  }
}

export async function codeIndexBenchmark({
  output,
  fixture = path.join(root, ".cache/code-index-workers/fixture"),
  iterations = 10,
  warmups = 1,
  workers = [0, 2],
  node = process.execPath,
  bun = "/Users/bytedance/.bun/bin/bun",
} = {}) {
  if (
    !output ||
    !Number.isInteger(iterations) ||
    iterations < 1 ||
    !Number.isInteger(warmups) ||
    warmups < 0 ||
    !workers.length ||
    new Set(workers).size !== workers.length ||
    workers.some((n) => n !== 0 && n !== 2)
  )
    throw new Error("invalid code-index benchmark contract")
  await fs.mkdir(output, { recursive: true })
  const manifest = await prepareCodeIndexFixture(fixture)
  await validateFixture(fixture, manifest)
  const report = {
    measuredAt: new Date().toISOString(),
    sourceSha256: await sourceIdentity(),
    fixtureSha256: createHash("sha256")
      .update(await fs.readFile(path.join(path.dirname(fixture), "fixture.json")))
      .digest("hex"),
    node,
    bun,
    iterations,
    warmups,
    workers,
    samples: [],
    failures: [],
    summary: [],
  }
  for (let round = -warmups; round < iterations; round++) {
    for (const runtime of Math.abs(round) % 2 ? ["bun", "node"] : ["node", "bun"])
      for (const count of Math.abs(round) % 2 ? [...workers].reverse() : workers) {
        try {
          const sample = await trial({
            executable: runtime === "bun" ? bun : node,
            runtime,
            workers: count,
            directory: output,
            fixture,
          })
          process.stdout.write(
            `${runtime}/${count} ${round}: ${sample.phases.map((p) => `${p.name}=${p.elapsedMs.toFixed(1)}ms lag=${p.maxTimerLagMs.toFixed(1)}ms`).join(", ")}; RSS=${sample.peakRssMiB.toFixed(1)}MiB\n`
          )
          if (round >= 0) report.samples.push({ ...sample, round })
        } catch (error) {
          report.failures.push({ runtime, workers: count, round, error: String(error) })
          process.stderr.write(`${error}\n`)
        }
        await fs.writeFile(path.join(output, "results.json"), JSON.stringify(report, null, 2))
      }
  }
  for (const runtime of ["node", "bun"])
    for (const count of workers) {
      const samples = report.samples.filter((s) => s.runtime === runtime && s.workers === count)
      if (!samples.length) continue
      report.summary.push({
        runtime,
        workers: count,
        successful: samples.length,
        ...Object.fromEntries(
          ["peakRssMiB", "idleRssMiB", "idleFootprintMiB"].map((k) => [
            k,
            summarize(samples.map((s) => s[k])),
          ])
        ),
        phases: samples[0].phases.map((p) => ({
          name: p.name,
          ...Object.fromEntries(
            ["elapsedMs", "maxTimerLagMs", "over16Ms"].map((k) => [
              k,
              summarize(samples.map((s) => s.phases.find((x) => x.name === p.name)[k])),
            ])
          ),
        })),
      })
    }
  // Full-table inspection is deliberately outside every timed child and all
  // sampling rounds. Canonicalize each row once rather than inside sort.
  const verificationStarted = performance.now()
  for (const sample of report.samples) {
    if (sample.phases[0].signature.status.binding === "sqlite") {
      sample.fullGraphSha256 = await sqliteGraphHash(path.join(sample.home, "repo"))
    }
  }
  report.verificationMs = performance.now() - verificationStarted
  await validateFixture(fixture, manifest)
  report.sourceUnchanged = report.sourceSha256 === (await sourceIdentity())
  if (!report.sourceUnchanged)
    report.failures.push({ error: "code-index source changed during timing" })
  await fs.writeFile(path.join(output, "results.json"), JSON.stringify(report, null, 2))
  return report
}

if (process.argv[2] === "--child") await childMain(process.argv[3])
else if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const result = await codeIndexBenchmark({ output: path.resolve(process.argv[2]) })
  if (result.failures.length) process.exitCode = 1
}

#!/usr/bin/env node
// Compare fresh brain/sidecar processes on identical source and isolated data.
// The brain uses a loopback Host fixture, as serve-command.test.ts does: native
// RPCs return terminal 404s. These are empty-account boot measurements, not
// model latency, production Host parity, or OS-cache-cold measurements.
import fs from "node:fs/promises"
import http from "node:http"
import os from "node:os"
import path from "node:path"
import { spawn, execFileSync } from "node:child_process"
import { once } from "node:events"
import { fileURLToPath, pathToFileURL } from "node:url"
import { createRequire } from "node:module"
import { createHash } from "node:crypto"
import { cliEsbuildOptions, loadEsbuild } from "../../build/esbuild-shared.mjs"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..")

export function summarize(values) {
  if (values.length === 0 || values.some((value) => !Number.isFinite(value))) {
    throw new Error("measurements must be non-empty and finite")
  }
  const ordered = [...values].sort((a, b) => a - b)
  const middle = Math.floor(ordered.length / 2)
  const median = ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2
  const deviations = ordered.map((value) => Math.abs(value - median)).sort((a, b) => a - b)
  return {
    min: ordered[0],
    median,
    mad:
      ordered.length % 2 ? deviations[middle] : (deviations[middle - 1] + deviations[middle]) / 2,
    p95: ordered[Math.ceil(ordered.length * 0.95) - 1],
    max: ordered.at(-1),
  }
}

export function treeRss(output, rootPid) {
  const rows = output
    .trim()
    .split("\n")
    .map((line) => line.trim().split(/\s+/).map(Number))
    .filter((row) => row.length === 3 && row.every(Number.isFinite))
  const members = new Set([rootPid])
  let previous
  do {
    previous = members.size
    for (const [pid, ppid] of rows) if (members.has(ppid)) members.add(pid)
  } while (members.size !== previous)
  const own = rows.find(([pid]) => pid === rootPid)
  if (!own) throw new Error(`process ${rootPid} disappeared during RSS sampling`)
  return {
    processMiB: own[2] / 1024,
    treeMiB: rows.filter(([pid]) => members.has(pid)).reduce((sum, row) => sum + row[2], 0) / 1024,
  }
}

export function readySignal(role, line) {
  if (role === "brain") return line.startsWith("serve: runtimes up (")
  try {
    return JSON.parse(line).type === "ready"
  } catch {
    return false
  }
}

// macOS charges dirty/compressed memory through phys_footprint. RSS also
// includes clean/reclaimable pages; retain both instead of treating them as
// interchangeable. rusage_info_v2's ABI is from the installed macOS SDK.
export function processFootprint(pid) {
  if (process.platform !== "darwin") return null
  const bytes = Number(
    execFileSync(
      "python3",
      [
        "-c",
        `
import ctypes, sys
class Usage(ctypes.Structure):
    _fields_ = [("uuid", ctypes.c_uint8 * 16)] + [
        (name, ctypes.c_uint64) for name in (
            "user", "system", "pkg_idle", "interrupt", "pageins", "wired",
            "resident", "footprint", "start", "exit", "child_user", "child_system",
            "child_pkg", "child_interrupt", "child_pageins", "child_elapsed",
            "disk_read", "disk_written")]
lib = ctypes.CDLL("/usr/lib/libproc.dylib", use_errno=True)
lib.proc_pid_rusage.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_void_p]
usage = Usage()
if lib.proc_pid_rusage(int(sys.argv[1]), 2, ctypes.byref(usage)) != 0:
    raise OSError(ctypes.get_errno(), "proc_pid_rusage failed")
print(usage.footprint)
`,
        String(pid),
      ],
      { encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "pipe"] }
    )
  )
  if (!Number.isFinite(bytes) || bytes <= 0) throw new Error("invalid physical footprint")
  return bytes / 1024 ** 2
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// Host credentials come from the explicit environment, never a checkout's
// dotenv files. Additional flags allow isolated, recorded candidate probes.
export function launchArgs(role, runtime, entry, bunArgs = []) {
  return [
    ...(runtime === "bun" ? ["--no-env-file", ...bunArgs] : []),
    entry,
    ...(role === "brain" ? ["serve"] : []),
  ]
}

export async function sidecarSourceDigest() {
  const digest = createHash("sha256")
  const visit = async (directory) => {
    for (const entry of (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name)
    )) {
      const file = path.join(directory, entry.name)
      if (entry.isDirectory()) await visit(file)
      else if (!entry.name.includes(".test.") && /\.(?:ts|mjs|json|sql)$/.test(entry.name)) {
        digest.update(path.relative(root, file)).update(await fs.readFile(file))
      }
    }
  }
  await visit(path.join(root, "sidecar/src"))
  digest.update(await fs.readFile(path.join(root, "sidecar/agent-host.mjs")))
  digest.update(await fs.readFile(path.join(root, "sidecar/pnpm-lock.yaml")))
  return digest.digest("hex")
}

export async function hostFixture() {
  const { WebSocketServer } = createRequire(path.join(root, "cli/package.json"))("ws")
  const server = http.createServer((request, response) => {
    request.resume()
    response.writeHead(404, { "content-type": "application/json" })
    response.end(
      JSON.stringify({
        code: "unknown_command",
        message: "benchmark fixture has no native services",
      })
    )
  })
  const sockets = new Set()
  server.on("connection", (socket) => {
    sockets.add(socket)
    socket.on("close", () => sockets.delete(socket))
  })
  const ws = new WebSocketServer({ server, path: "/internal/bridge" })
  ws.on("connection", (socket) =>
    socket.on("message", (bytes) => {
      const frame = JSON.parse(String(bytes))
      if (frame.type === "hello")
        socket.send(
          JSON.stringify({
            v: frame.v,
            type: "hello_ack",
            serverVersion: "benchmark-fixture",
            protocol: frame.v,
            accountId: frame.accountId,
            catalogHash: frame.catalogHash,
            contractVersion: frame.contractVersion,
          })
        )
    })
  )
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    close: async () => {
      for (const client of ws.clients) client.terminate()
      for (const socket of sockets) socket.destroy()
      await new Promise((resolve) => ws.close(resolve))
      await new Promise((resolve) => server.close(resolve))
    },
  }
}

export async function trial({
  role,
  runtime,
  executable,
  entry,
  fixtureUrl,
  directory,
  idleMs,
  bunArgs,
  runtimeArgs = [],
  onLine,
  onSample,
}) {
  const home = await fs.mkdtemp(path.join(directory, `${role}-${runtime}-`))
  const env = {
    PATH: process.env.PATH,
    HOME: home,
    USERPROFILE: home,
    TMPDIR: os.tmpdir(),
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    NODE_ENV: "production",
    NO_COLOR: "1",
    DO_NOT_TRACK: "1",
    OTEL_SDK_DISABLED: "true",
    COGNIA_SERVER_URL: fixtureUrl,
    COGNIA_SERVICE_TOKEN: "benchmark-local-fixture-only",
    COGNIA_DATA_DIR: path.join(home, "data"),
    COGNIA_HOME: home,
    COGNIA_LOCAL_ACCOUNT_ID: "local_acct_runtime_benchmark",
    COGNIA_ACCOUNT_CONTENT_KEY: Buffer.alloc(32, 7).toString("hex"),
    COGNIA_ACCOUNT_SYNC: "0",
  }
  const started = performance.now()
  const systemLoadAtSpawn = os.loadavg()
  const args = [...runtimeArgs, ...launchArgs(role, runtime, entry, bunArgs)]
  const child = spawn(executable, args, {
    cwd: root,
    env,
    detached: process.platform !== "win32",
    stdio: ["pipe", "pipe", "pipe"],
  })
  const closed = once(child, "close")
  let stdout = "",
    stderr = "",
    partial = "",
    errorPartial = "",
    bridgeMs = null
  let readyResolve, readyReject
  const ready = new Promise((resolve, reject) => {
    readyResolve = resolve
    readyReject = reject
  })
  const deadline = setTimeout(
    () => readyReject(new Error(`${role}/${runtime} did not become ready in 90s`)),
    90_000
  )
  child.once("error", readyReject)
  child.once("exit", (code, signal) =>
    readyReject(new Error(`${role}/${runtime} exited before ready (${code}/${signal})`))
  )
  child.stdout.setEncoding("utf8").on("data", (chunk) => {
    stdout = (stdout + chunk).slice(-128 * 1024)
    partial += chunk
    const lines = partial.split("\n")
    partial = lines.pop()
    for (const line of lines) {
      onLine?.({ line, stream: "stdout", elapsedMs: performance.now() - started })
      if (line.startsWith("serve: bridge connected")) bridgeMs = performance.now() - started
      if (readySignal(role, line))
        readyResolve({ startupMs: performance.now() - started, readyLine: line })
    }
  })
  child.stderr.setEncoding("utf8").on("data", (chunk) => {
    stderr = (stderr + chunk).slice(-128 * 1024)
    if (onLine) {
      errorPartial += chunk
      const lines = errorPartial.split("\n")
      errorPartial = lines.pop()
      for (const line of lines)
        onLine({ line, stream: "stderr", elapsedMs: performance.now() - started })
    }
  })
  try {
    const result = await ready
    clearTimeout(deadline)
    const rss = []
    for (let elapsed = 0; elapsed <= idleMs; elapsed += 200) {
      rss.push(
        treeRss(
          execFileSync("ps", ["-axo", "pid=,ppid=,rss="], { encoding: "utf8", timeout: 3000 }),
          child.pid
        )
      )
      if (elapsed < idleMs) await pause(200)
    }
    const idleFootprintMiB = processFootprint(child.pid)
    const footprintAfterReadyMs = performance.now() - started - result.startupMs
    await onSample?.({ pid: child.pid, home, ...result })
    return {
      role,
      runtime,
      executable,
      args,
      systemLoadAtSpawn,
      home,
      ...result,
      bridgeMs,
      rss,
      idleProcessMiB: rss.at(-1).processMiB,
      idleTreeMiB: rss.at(-1).treeMiB,
      idleFootprintMiB,
      footprintAfterReadyMs,
      peakSampledTreeMiB: Math.max(...rss.map((sample) => sample.treeMiB)),
    }
  } finally {
    clearTimeout(deadline)
    child.stdin.end()
    if (role === "brain") child.kill("SIGTERM")
    const exited = await Promise.race([closed.then(() => true), pause(5000).then(() => false)])
    if (!exited) {
      try {
        process.kill(-child.pid, "SIGKILL")
      } catch {
        child.kill("SIGKILL")
      }
      await closed
    }
    await fs.writeFile(path.join(directory, `${role}-${runtime}.stdout.log`), stdout)
    await fs.writeFile(path.join(directory, `${role}-${runtime}.stderr.log`), stderr)
  }
}

export async function benchmark({
  iterations = 5,
  warmups = 1,
  idleMs = 1000,
  output = path.join(root, ".cache/bun-host-runtime/benchmark"),
  node = process.execPath,
  bun = "bun",
  bunArgs = {},
  roles = ["sidecar", "brain"],
} = {}) {
  if (process.platform === "win32")
    throw new Error("RSS benchmark currently requires macOS or Linux ps")
  if (
    !Number.isInteger(iterations) ||
    iterations < 1 ||
    !Number.isInteger(warmups) ||
    warmups < 0
  ) {
    throw new Error("iterations must be positive and warmups non-negative integers")
  }
  if (
    !roles.length ||
    new Set(roles).size !== roles.length ||
    roles.some((role) => !["brain", "sidecar"].includes(role))
  ) {
    throw new Error("roles must contain brain and/or sidecar without duplicates")
  }
  await fs.mkdir(output, { recursive: true })
  const bundleDir = path.join(output, "brain-bundle")
  const esbuild = await loadEsbuild()
  // This benchmark needs the real JS graph, not release assets/native helpers.
  const build = await esbuild.build({
    ...cliEsbuildOptions({
      root,
      entry: path.join(root, "cli/src/cli/entry.ts"),
      outdir: bundleDir,
      entryNames: "cognia-agent",
    }),
    logLevel: "warning",
    metafile: true,
  })
  await fs
    .symlink(path.join(root, "cli/node_modules"), path.join(bundleDir, "node_modules"), "dir")
    .catch((error) => {
      if (error.code !== "EEXIST") throw error
    })
  const fixture = await hostFixture()
  const identities = Object.fromEntries(
    Object.entries({ node, bun }).map(([name, executable]) => {
      const actual = JSON.parse(
        execFileSync(
          executable,
          [
            "--eval",
            "process.stdout.write(JSON.stringify({node:process.versions.node,bun:process.versions.bun,executable:process.execPath}))",
          ],
          { encoding: "utf8" }
        )
      )
      if ((name === "bun") !== Boolean(actual.bun))
        throw new Error(`${name} executable has the wrong runtime identity`)
      return [name, actual]
    })
  )
  const digest = createHash("sha256")
  for (const file of Object.keys(build.metafile.outputs).sort()) {
    digest
      .update(path.relative(bundleDir, path.resolve(root, file)))
      .update(await fs.readFile(path.resolve(root, file)))
  }
  const report = {
    measuredAt: new Date().toISOString(),
    platform: process.platform,
    arch: process.arch,
    cpu: os.cpus()[0].model,
    logicalCpus: os.cpus().length,
    iterations,
    warmups,
    idleMs,
    identities,
    bunArgs,
    roles,
    sidecarSourceSha256: await sidecarSourceDigest(),
    brainBundleSha256: digest.digest("hex"),
    workload:
      "fresh process, empty account, warm filesystem cache; brain uses loopback Host with terminal 404 native RPCs; no model calls",
    rssDefinition:
      "ps RSS in MiB; tree sums root and descendants, including shared pages more than once; sampled after ready, not a startup high-water mark",
    footprintDefinition:
      "macOS proc_pid_rusage rusage_info_v2 ri_phys_footprint in MiB, root process only, queried immediately after the ready + 1s RSS samples; null on other platforms; Python 3 required on macOS",
    versions: {
      node: execFileSync(node, ["--version"], { encoding: "utf8" }).trim(),
      bun: execFileSync(bun, ["--version"], { encoding: "utf8" }).trim(),
    },
    samples: [],
    failures: [],
    summary: [],
  }
  try {
    for (const role of roles) {
      for (let round = -warmups; round < iterations; round++) {
        const runtimes = Math.abs(round) % 2 ? ["bun", "node"] : ["node", "bun"]
        for (const runtime of runtimes) {
          const directory = path.join(
            output,
            `${role}-${round < 0 ? "warmup" : "sample"}-${Math.abs(round)}`
          )
          await fs.mkdir(directory, { recursive: true })
          try {
            const sample = await trial({
              role,
              runtime,
              executable: runtime === "node" ? node : bun,
              entry:
                role === "brain"
                  ? path.join(bundleDir, "cognia-agent.mjs")
                  : path.join(root, "sidecar/agent-host.mjs"),
              fixtureUrl: fixture.url,
              directory,
              idleMs,
              bunArgs: bunArgs[role],
            })
            process.stdout.write(
              `${role}/${runtime} ${round < 0 ? "warmup" : round}: ${sample.startupMs.toFixed(1)} ms, ${sample.idleTreeMiB.toFixed(1)} MiB\n`
            )
            if (round >= 0) report.samples.push({ ...sample, round })
          } catch (error) {
            report.failures.push({ role, runtime, round, error: String(error) })
            process.stderr.write(`${role}/${runtime}: ${error}\n`)
          }
          await fs.writeFile(path.join(output, "results.json"), JSON.stringify(report, null, 2))
        }
      }
    }
    for (const role of roles)
      for (const runtime of ["node", "bun"]) {
        const samples = report.samples.filter(
          (sample) => sample.role === role && sample.runtime === runtime
        )
        if (samples.length)
          report.summary.push({
            role,
            runtime,
            successful: samples.length,
            startupMs: summarize(samples.map((sample) => sample.startupMs)),
            idleTreeMiB: summarize(samples.map((sample) => sample.idleTreeMiB)),
            idleProcessMiB: summarize(samples.map((sample) => sample.idleProcessMiB)),
            idleFootprintMiB: samples.every((sample) => sample.idleFootprintMiB !== null)
              ? summarize(samples.map((sample) => sample.idleFootprintMiB))
              : null,
          })
      }
    const rosters = new Set(
      report.samples.filter((sample) => sample.role === "brain").map((sample) => sample.readyLine)
    )
    report.brainWorkloadParity = roles.includes("brain") ? rosters.size === 1 : null
    if (rosters.size > 1)
      report.failures.push({
        error: "Brain runtime rosters differ; timings are not comparable",
        rosters: [...rosters],
      })
    report.sidecarSourceUnchanged = report.sidecarSourceSha256 === (await sidecarSourceDigest())
    if (!report.sidecarSourceUnchanged)
      report.failures.push({
        error: "Sidecar source changed during measurement; rerun the comparison",
      })
    await fs.writeFile(path.join(output, "results.json"), JSON.stringify(report, null, 2))
    return report
  } finally {
    await fixture.close()
  }
}

async function main() {
  if (process.argv[2] === "--profile") {
    const { profileHostRuntimes } = await import("./host-js-profile.mjs")
    const report = await profileHostRuntimes({
      kind: process.argv[3] ?? "cpu",
      bundle: path.resolve(
        process.argv[4] ??
          ".cache/bun-host-runtime/optimization-final-verified/brain-bundle/cognia-agent.mjs"
      ),
      bun: process.env.COGNIA_TEST_BUN ?? "bun",
      ...(process.argv[5] ? { output: path.resolve(process.argv[5]) } : {}),
    })
    process.stdout.write(JSON.stringify(report, null, 2) + "\n")
    if (report.failures.length) process.exitCode = 1
  } else {
    const iterations = Number(process.argv[2] ?? 5)
    const report = await benchmark({ iterations, bun: process.env.COGNIA_TEST_BUN ?? "bun" })
    process.stdout.write(JSON.stringify(report.summary, null, 2) + "\n")
    if (report.failures.length) process.exitCode = 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  void main().catch((error) => {
    process.stderr.write(`${error.stack ?? error}\n`)
    process.exitCode = 1
  })
}

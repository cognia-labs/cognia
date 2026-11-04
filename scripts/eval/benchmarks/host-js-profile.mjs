// Diagnostic-only companion to the benchmark. Profilers never run in its
// ordinary timing loop. Reuse its environment, fixture and readiness contract.
import fs from "node:fs/promises"
import path from "node:path"
import { execFile, execFileSync } from "node:child_process"
import { promisify } from "node:util"
import { createHash } from "node:crypto"
import { fileURLToPath } from "node:url"
import { hostFixture, trial, sidecarSourceDigest } from "./host-js-runtime.mjs"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..")
const execute = promisify(execFile)
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function bundleDigest(bundle) {
  const directory = path.dirname(bundle)
  const files = []
  const visit = async (folder) => {
    for (const entry of await fs.readdir(folder, { withFileTypes: true })) {
      const file = path.join(folder, entry.name)
      if (entry.isDirectory()) await visit(file)
      else if (entry.isFile() && entry.name.endsWith(".mjs")) files.push(file)
    }
  }
  await visit(directory)
  const digest = createHash("sha256")
  for (const file of files.sort())
    digest.update(path.relative(directory, file)).update(await fs.readFile(file))
  return digest.digest("hex")
}

// Weight by sample durations, not hit counts; recursive frames count once in
// inclusive time. These are sampled stack durations, not process CPU accounting.
export function cpuHotspots(profile) {
  const { nodes, samples, timeDeltas } = profile
  if (!Array.isArray(samples) || samples.length !== timeDeltas?.length)
    throw new Error("CPU profile sample/duration counts differ")
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const parents = new Map()
  for (const node of nodes) for (const child of node.children ?? []) parents.set(child, node.id)
  const totals = new Map()
  const negativeDeltas = timeDeltas.filter((value) => value < 0).length
  let totalUs = 0
  const add = (id, field, weight) => {
    const node = byId.get(id)
    if (!node) throw new Error(`unknown CPU sample node ${id}`)
    const row = totals.get(id) ?? {
      ...node.callFrame,
      selfUs: 0,
      inclusiveUs: 0,
      selfSamples: 0,
      inclusiveSamples: 0,
    }
    row[field] += weight
    row[field === "selfUs" ? "selfSamples" : "inclusiveSamples"]++
    totals.set(id, row)
  }
  for (let index = 0; index < samples.length; index++) {
    const weight = timeDeltas[index]
    if (!Number.isFinite(weight)) throw new Error("invalid CPU sample duration")
    totalUs += weight
    add(samples[index], "selfUs", weight)
    const seen = new Set()
    for (let id = samples[index]; id !== undefined && !seen.has(id); id = parents.get(id)) {
      seen.add(id)
      add(id, "inclusiveUs", weight)
    }
  }
  if (negativeDeltas) {
    for (const row of totals.values()) row.selfUs = row.inclusiveUs = null
  }
  return {
    samples: samples.length,
    totalMs: totalUs / 1000,
    maxGapMs: timeDeltas.reduce((max, value) => Math.max(max, value), 0) / 1000,
    negativeDeltas,
    warning: negativeDeltas
      ? "Profile contains out-of-order sample timestamps; duration attribution is unavailable. Raw data is preserved; inspect sample counts."
      : !nodes.some((node) => node.callFrame.functionName === "(idle)") &&
          timeDeltas.some((value) => value > 20000)
        ? "No idle samples and gaps over 20ms: weighted self/inclusive durations include unsampled waits and cannot be treated as CPU time. Inspect sample counts, timeline and native CPU accounting."
        : null,
    frames: [...totals.values()].sort((a, b) =>
      negativeDeltas ? b.selfSamples - a.selfSamples : b.selfUs - a.selfUs
    ),
  }
}

export function startupTrace(milestones, name) {
  const traceEvents = [{ ph: "M", name: "thread_name", pid: 1, tid: 1, args: { name } }]
  let previous = 0
  for (const { line, elapsedMs } of milestones) {
    if (!line.startsWith("serve:") && !line.includes('"type":"ready"')) continue
    traceEvents.push({
      ph: "X",
      cat: "startup",
      name: `Until ${line}`,
      pid: 1,
      tid: 1,
      ts: previous * 1000,
      dur: (elapsedMs - previous) * 1000,
      args: { boundary: "parent-observed output; includes all work since previous milestone" },
    })
    previous = elapsedMs
    if (line.startsWith("serve: runtimes up (") || line.includes('"type":"ready"')) break
  }
  return { traceEvents, displayTimeUnit: "ms" }
}

export function memoryPreload(directory) {
  return `import fs from "node:fs";
import { writeHeapSnapshot } from "node:v8";
const directory = ${JSON.stringify(directory)};
process.on("SIGUSR2", async () => {
  try {
    const stats = { pid: process.pid, memory: process.memoryUsage() };
    if (process.versions.bun) stats.heap = (await import("bun:jsc")).heapStats();
    fs.writeFileSync(directory + "/heap-stats.json", JSON.stringify(stats));
    if (process.versions.bun) {
      fs.writeFileSync(directory + "/ready.heapsnapshot", Bun.generateHeapSnapshot("v8"));
    } else writeHeapSnapshot(directory + "/ready.heapsnapshot");
    fs.writeFileSync(directory + "/heap-complete.json", JSON.stringify({ ok: true }));
  } catch (error) {
    fs.writeFileSync(directory + "/heap-complete.json", JSON.stringify({ error: String(error) }));
  }
});`
}

export async function profileHostRuntimes({
  kind = "cpu",
  bundle,
  node = process.execPath,
  bun = "bun",
  output = path.join(root, `.cache/bun-host-runtime/hotspots-${kind}`),
  roles = kind === "cpu" ? ["sidecar", "brain"] : ["brain"],
  iterations = kind === "cpu" ? 2 : 1,
} = {}) {
  if (!["cpu", "heap", "native"].includes(kind)) throw new Error("unknown profile kind")
  if (!bundle) throw new Error("an existing verified brain bundle is required")
  if (
    !roles.length ||
    new Set(roles).size !== roles.length ||
    roles.some((role) => !["sidecar", "brain"].includes(role))
  )
    throw new Error("invalid profile roles")
  if (!Number.isInteger(iterations) || iterations < 1) throw new Error("invalid profile iterations")
  if (kind === "native" && process.platform !== "darwin")
    throw new Error("Instruments requires macOS")
  await fs.access(bundle)
  await fs.mkdir(output, { recursive: true })
  const report = {
    kind,
    measuredAt: new Date().toISOString(),
    bundle,
    diagnosticOnly:
      "Profiler overhead invalidates benchmark comparisons; empty-account fixture only",
    sidecarSourceSha256: await sidecarSourceDigest(),
    brainBundleSha256: await bundleDigest(bundle),
    identities: Object.fromEntries(
      Object.entries({ node, bun }).map(([runtime, executable]) => {
        const actual = JSON.parse(
          execFileSync(
            executable,
            [
              ...(runtime === "bun" ? ["--no-env-file"] : []),
              "--eval",
              "process.stdout.write(JSON.stringify({node:process.versions.node,bun:process.versions.bun,executable:process.execPath}))",
            ],
            { encoding: "utf8", timeout: 5000 }
          )
        )
        if ((runtime === "bun") !== Boolean(actual.bun))
          throw new Error(`wrong ${runtime} identity`)
        return [runtime, actual]
      })
    ),
    samples: [],
    failures: [],
  }
  const fixture = await hostFixture()
  try {
    for (const role of roles)
      for (let round = 0; round < iterations; round++) {
        for (const runtime of round % 2 ? ["bun", "node"] : ["node", "bun"]) {
          const directory = path.resolve(output, `${role}-${runtime}-${round}`)
          // Never overwrite previous captures, including partial failed runs.
          await fs.mkdir(directory)
          const milestones = []
          const runtimeArgs =
            kind === "cpu"
              ? ["--cpu-prof", `--cpu-prof-dir=${directory}`, "--cpu-prof-name=startup.cpuprofile"]
              : []
          if (kind === "heap") {
            const preload = path.join(directory, "snapshot.mjs")
            await fs.writeFile(preload, memoryPreload(directory))
            runtimeArgs.push("--import", preload)
          }
          try {
            const sample = await trial({
              role,
              runtime,
              executable: runtime === "node" ? node : bun,
              entry: role === "brain" ? bundle : path.join(root, "sidecar/agent-host.mjs"),
              fixtureUrl: fixture.url,
              directory,
              idleMs: 1000,
              runtimeArgs,
              onLine: (event) => {
                if (
                  milestones.length < 2048 &&
                  (event.line.startsWith("serve:") || event.line.includes('"type":"ready"'))
                )
                  milestones.push(event)
              },
              onSample:
                kind === "cpu"
                  ? undefined
                  : async ({ pid }) => {
                      if (process.platform === "darwin") {
                        const vmmap = await execute("vmmap", ["-summary", String(pid)], {
                          timeout: 15000,
                        })
                        await fs.writeFile(path.join(directory, "vmmap.txt"), vmmap.stdout)
                      }
                      if (kind === "heap") {
                        process.kill(pid, "SIGUSR2")
                        const deadline = Date.now() + 90000
                        while (true) {
                          const complete = await fs
                            .readFile(path.join(directory, "heap-complete.json"), "utf8")
                            .catch(() => null)
                          if (complete) {
                            const result = JSON.parse(complete)
                            if (result.error) throw new Error(result.error)
                            break
                          }
                          if (Date.now() > deadline) throw new Error("heap snapshot timed out")
                          await pause(200)
                        }
                      } else {
                        // Attach after readiness: this records idle allocations, not
                        // allocation stacks for objects created before attaching.
                        const capture = await execute(
                          "xcrun",
                          [
                            "xctrace",
                            "record",
                            "--template",
                            "Allocations",
                            "--attach",
                            String(pid),
                            "--time-limit",
                            "3s",
                            "--output",
                            path.join(directory, "idle.trace"),
                            "--no-prompt",
                          ],
                          { timeout: 60000 }
                        ).catch((error) => ({
                          stdout: error.stdout,
                          stderr: error.stderr,
                          error: error.message,
                        }))
                        await fs.writeFile(
                          path.join(directory, "instruments.json"),
                          JSON.stringify(capture, null, 2)
                        )
                        if (capture.error) throw new Error(capture.error)
                      }
                    },
            })
            if (kind === "cpu") {
              const profile = JSON.parse(
                await fs.readFile(path.join(directory, "startup.cpuprofile"), "utf8")
              )
              await fs.writeFile(
                path.join(directory, "cpu-summary.json"),
                JSON.stringify(cpuHotspots(profile), null, 2)
              )
            }
            report.samples.push({ ...sample, directory, round })
            process.stdout.write(`${kind} ${role}/${runtime}/${round}: captured\n`)
          } catch (error) {
            report.failures.push({ role, runtime, round, directory, error: String(error) })
          }
          await fs.writeFile(
            path.join(directory, "startup.trace.json"),
            JSON.stringify(startupTrace(milestones, `${role}/${runtime}`))
          )
          await fs.writeFile(
            path.join(directory, "milestones.json"),
            JSON.stringify(milestones, null, 2)
          )
          await fs.writeFile(path.join(output, "profiles.json"), JSON.stringify(report, null, 2))
        }
      }
  } finally {
    await fixture.close()
  }
  report.sidecarSourceUnchanged = report.sidecarSourceSha256 === (await sidecarSourceDigest())
  report.brainBundleUnchanged = report.brainBundleSha256 === (await bundleDigest(bundle))
  if (!report.sidecarSourceUnchanged || !report.brainBundleUnchanged)
    report.failures.push({ error: "source changed during profiling; rerun captures" })
  await fs.writeFile(path.join(output, "profiles.json"), JSON.stringify(report, null, 2))
  return report
}

// Fresh full-host request probes complement host-js-runtime's idle benchmark.
// Only loopback fixtures are contacted. No profiling or real provider keys.
import fs from "node:fs/promises"
import http from "node:http"
import os from "node:os"
import path from "node:path"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { fileURLToPath, pathToFileURL } from "node:url"
import { sidecarSourceDigest, summarize } from "./host-js-runtime.mjs"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
export const REQUEST_MODES = [
  "model",
  "model-proxy",
  "model-cidr",
  "guard",
  "guard-proxy",
  "dns-denied",
]

async function fixture() {
  const hits = []
  const server = http.createServer(async (req, res) => {
    for await (const _chunk of req) {
      /* drain */
    }
    hits.push(req.url)
    if (req.url.includes("/v1/")) {
      res.writeHead(200, { "content-type": "text/event-stream" })
      for (const [delta, finish_reason] of [
        [{ role: "assistant", content: "BENCH_PONG" }, null],
        [{}, "stop"],
      ]) {
        res.write(
          `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "scripted", choices: [{ index: 0, delta, finish_reason }] })}\n\n`
        )
      }
      res.end("data: [DONE]\n\n")
    } else res.end("guard-ok")
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const port = server.address().port
  return { server, hits, url: `http://127.0.0.1:${port}` }
}

async function sample({ runtime, executable, mode, directory, origin, preload }) {
  const home = await fs.mkdtemp(path.join(directory, `${runtime}-${mode}-`))
  const proxied = mode.endsWith("proxy") || mode === "model-cidr"
  const env = {
    PATH: process.env.PATH,
    HOME: home,
    USERPROFILE: home,
    TMPDIR: os.tmpdir(),
    NODE_ENV: "production",
    NO_COLOR: "1",
    DO_NOT_TRACK: "1",
    OTEL_SDK_DISABLED: "true",
    COGNIA_HOME: home,
    COGNIA_DATA_DIR: path.join(home, "data"),
    ...(proxied ? { HTTP_PROXY: origin.url, HTTPS_PROXY: origin.url } : {}),
    ...(mode === "model-cidr"
      ? {
          NO_PROXY: "127.0.0.0/8",
          HTTP_PROXY: "http://127.0.0.1:1",
          HTTPS_PROXY: "http://127.0.0.1:1",
        }
      : {}),
  }
  const started = performance.now()
  const child = spawn(
    executable,
    [
      ...(runtime === "bun" ? ["--no-env-file"] : []),
      "--import",
      preload,
      path.join(root, "sidecar/agent-host.mjs"),
    ],
    {
      cwd: root,
      env,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe", "ipc"],
    }
  )
  const exited = once(child, "exit")
  const frames = [],
    waiters = new Set()
  let stdout = "",
    stderr = "",
    partial = "",
    failure
  const publish = (frame) => {
    frames.push(frame)
    for (const waiter of waiters) waiter()
  }
  const fail = (error) => {
    failure = error
    for (const waiter of waiters) waiter()
  }
  child.once("error", fail)
  child.once("exit", (code, signal) => fail(new Error(`host exited ${code}/${signal}: ${stderr}`)))
  child.on("message", publish)
  child.stderr.on("data", (bytes) => {
    stderr += bytes
  })
  child.stdout.on("data", (bytes) => {
    stdout += bytes
    partial += bytes
    const lines = partial.split("\n")
    partial = lines.pop()
    for (const line of lines) {
      try {
        publish(JSON.parse(line))
      } catch {
        /* diagnostic line */
      }
    }
  })
  const wait = (predicate) =>
    new Promise((resolve, reject) => {
      const check = () => {
        const frame = frames.find(predicate)
        if (!frame && !failure) return
        clearTimeout(timer)
        waiters.delete(check)
        if (frame) resolve(frame)
        else reject(failure)
      }
      const timer = setTimeout(() => {
        waiters.delete(check)
        reject(new Error(`frame timeout: ${stderr}`))
      }, 20_000)
      waiters.add(check)
      check()
    })
  const hitStart = origin.hits.length
  try {
    await wait((f) => f.type === "ready")
    const readyMs = performance.now() - started
    const calls = []
    for (let round = 0; round < 2; round++) {
      const id = `${mode}-${round}`
      const sent = performance.now()
      if (mode.startsWith("model")) {
        child.stdin.write(
          JSON.stringify({
            type: "send",
            sessionId: id,
            prompt: "ping",
            options: {
              provider: "openai",
              model: "scripted",
              cwd: home,
              providerCredentials: {
                apiKey: "local-fixture",
                protocol: "openai",
                baseURL: `${origin.url}/v1`,
              },
            },
          }) + "\n"
        )
        const ended = await wait((f) => f.type === "session_ended" && f.sessionId === id)
        if (
          ended.error ||
          !JSON.stringify(frames.filter((f) => f.sessionId === id)).includes("BENCH_PONG")
        )
          throw new Error(`turn failed: ${JSON.stringify(ended)} ${stderr}`)
      } else {
        child.send({ id, url: `${origin.url}/guard`, denied: mode === "dns-denied" })
        const result = await wait((f) => f.probe === id)
        if (result.error) throw new Error(result.error)
      }
      calls.push({ requestMs: performance.now() - sent, fromSpawnMs: performance.now() - started })
    }
    const hits = origin.hits.slice(hitStart)
    if (mode === "dns-denied" ? hits.length !== 0 : hits.length !== 2)
      throw new Error(`unexpected fixture requests: ${JSON.stringify(hits)}`)
    if (mode.endsWith("proxy") && !hits.every((url) => url.startsWith("http://")))
      throw new Error("first request bypassed proxy")
    if (mode === "model-cidr" && !hits.every((url) => url.startsWith("/")))
      throw new Error("CIDR bypass failed")
    return {
      runtime,
      mode,
      readyMs,
      firstRequestMs: calls[0].requestMs,
      firstFromSpawnMs: calls[0].fromSpawnMs,
      warmRequestMs: calls[1].requestMs,
      hits,
    }
  } finally {
    await fs.writeFile(path.join(home, "stdout.log"), stdout)
    await fs.writeFile(path.join(home, "stderr.log"), stderr)
    const ending = new Promise((resolve) => child.stdin.end(resolve))
    await ending
    if (child.connected) child.disconnect()
    let forced = false
    const timeout = setTimeout(() => {
      forced = true
      try {
        process.kill(-child.pid, "SIGKILL")
      } catch {
        child.kill("SIGKILL")
      }
    }, 5000)
    let deadline
    try {
      const [code, signal] = await Promise.race([
        exited,
        new Promise((_, reject) => {
          deadline = setTimeout(() => reject(new Error("host shutdown timed out")), 8000)
        }),
      ])
      if (forced || code !== 0 || signal)
        throw new Error(`unclean host shutdown: ${code}/${signal}, forced=${forced}`)
    } finally {
      clearTimeout(timeout)
      clearTimeout(deadline)
      child.stdout.destroy()
      child.stderr.destroy()
    }
  }
}

export async function firstRequestBenchmark({
  output,
  node = process.execPath,
  bun = "bun",
  iterations = 5,
  warmups = 1,
  modes = REQUEST_MODES,
} = {}) {
  if (
    !output ||
    !Number.isInteger(iterations) ||
    iterations < 1 ||
    !Number.isInteger(warmups) ||
    warmups < 0 ||
    !modes.length ||
    new Set(modes).size !== modes.length ||
    modes.some((mode) => !REQUEST_MODES.includes(mode))
  )
    throw new Error("invalid request benchmark contract")
  await fs.mkdir(output, { recursive: true })
  const preload = path.join(output, "guard-probe.mjs")
  // A test-only IPC probe shares the real host's module cache, fetch interceptor
  // and ready boundary. It does not import the guard until after host ready.
  await fs.writeFile(
    preload,
    `let guard;
process.on("message", async ({id,url,denied}) => {
  try {
    const {createEgressGuard}=await import(${JSON.stringify(pathToFileURL(path.join(root, "sidecar/src/platform/net/egress-guard.ts")).href)});
    guard ??= createEgressGuard(denied ? {lookup:(_host,_opts,cb)=>cb(null,[{address:"127.0.0.1",family:4}])} : {allowPrivateNetwork:true});
    try {
      const response=await guard.fetch(denied ? "https://dns-denied.test/" : url,{method:"POST",body:"fixture-body"});
      if(denied) throw Error("private DNS was allowed");
      if(await response.text()!=="guard-ok") throw Error("guard response mismatch");
    } catch(error) { if(!denied || !String(error.cause?.message??error.message).includes("blocked")) throw error }
    process.send({probe:id});
  } catch(error) { process.send({probe:id,error:String(error)}) }
});
process.on("disconnect",()=>{void guard?.close()});
`
  )
  const report = {
    measuredAt: new Date().toISOString(),
    iterations,
    warmups,
    modes,
    node,
    bun,
    sidecarSourceSha256: await sidecarSourceDigest(),
    samples: [],
    failures: [],
    summary: [],
  }
  const origin = await fixture()
  try {
    for (const mode of modes)
      for (let round = -warmups; round < iterations; round++) {
        for (const runtime of Math.abs(round) % 2 ? ["bun", "node"] : ["node", "bun"]) {
          try {
            const result = await sample({
              runtime,
              executable: runtime === "bun" ? bun : node,
              mode,
              directory: output,
              origin,
              preload,
            })
            if (round >= 0) report.samples.push({ ...result, round })
            process.stdout.write(
              `${mode}/${runtime} ${round}: ready ${result.readyMs.toFixed(1)}, first ${result.firstRequestMs.toFixed(1)}, total ${result.firstFromSpawnMs.toFixed(1)} ms\n`
            )
          } catch (error) {
            report.failures.push({ runtime, mode, round, error: String(error) })
          }
          await fs.writeFile(path.join(output, "results.json"), JSON.stringify(report, null, 2))
        }
      }
    for (const mode of modes)
      for (const runtime of ["node", "bun"]) {
        const samples = report.samples.filter((s) => s.mode === mode && s.runtime === runtime)
        if (samples.length)
          report.summary.push({
            mode,
            runtime,
            successful: samples.length,
            ...Object.fromEntries(
              ["readyMs", "firstRequestMs", "firstFromSpawnMs", "warmRequestMs"].map((key) => [
                key,
                summarize(samples.map((s) => s[key])),
              ])
            ),
          })
      }
    report.sidecarSourceUnchanged = report.sidecarSourceSha256 === (await sidecarSourceDigest())
    if (!report.sidecarSourceUnchanged)
      report.failures.push({ error: "source changed during measurement" })
    await fs.writeFile(path.join(output, "results.json"), JSON.stringify(report, null, 2))
    return report
  } finally {
    origin.server.closeAllConnections()
    await new Promise((resolve) => origin.server.close(resolve))
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const report = await firstRequestBenchmark({
    output: path.resolve(process.argv[2]),
    bun: process.env.COGNIA_TEST_BUN ?? "bun",
  })
  if (report.failures.length) {
    console.error(report.failures)
    process.exitCode = 1
  }
}

// Tests for the web-clone tool orchestration (job building, output confinement,
// SSRF pre-check, and the child-process runner) with a fully injected fake
// spawn + fs. Separate subprocess cases exercise real Node/Bun runners against
// a loopback-only HTTP fixture and verify snapshot/convert output.

import { test } from "node:test"
import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { spawnSync, execFile } from "node:child_process"
import { promisify } from "node:util"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { buildJob, resolveRunnerSpawn, runEngine, snapshotSite } from "./run.ts"
import type { EngineDeps, RunnerEnvelope, WebcloneArgs, WebcloneJob } from "./run.ts"

/** The slice of a child process the runner drives. */
interface FakeChild extends EventEmitter {
  stdout: EventEmitter
  stderr: EventEmitter
  kill(): void
}

interface SpawnCall {
  file: string
  args: string[]
  opts: { env: NodeJS.ProcessEnv }
}

/** What the tests read from a runner envelope. */
type Envelope = RunnerEnvelope & {
  result?: { mode?: string }
  error?: { message?: string; reason?: string }
}

/** Deliberately incomplete arguments, for the validation tests. */
const partialArgs = (args: Record<string, unknown>) => args as unknown as WebcloneArgs

/** A job for runner tests, where the engine options do not matter. */
const bareJob = (options: Record<string, unknown> = {}) =>
  ({ mode: "snapshot", url: "https://x/", options }) as unknown as WebcloneJob

test("importing the orchestration does not load the snapshot/parser graph", () => {
  const source = `
    import { registerHooks } from 'node:module';
    registerHooks({ resolve(specifier, context, next) {
      const resolved = next(specifier, context);
      if (/webclone\\/dist\\/(?:assembler\\.js|parser\\/|transform\\/)/.test(resolved.url))
        throw new Error('eager snapshot engine import: ' + resolved.url);
      return resolved;
    }});
    const { buildJob } = await import(${JSON.stringify(new URL("./run.ts", import.meta.url).href)});
    if (typeof buildJob !== 'function') throw new Error('orchestration was not loaded');
  `
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", source], {
    encoding: "utf8",
    timeout: 10000,
  })
  assert.equal(result.status, 0, result.stderr || String(result.error))
})

function realCwd(prefix = "wc-tool-") {
  return mkdtempSync(join(tmpdir(), prefix))
}

/** A fake spawn whose child emits a scripted stdout envelope + close/error. */
function fakeSpawn({
  stdout = "",
  stderr = "",
  code = 0,
  error = null,
  hang = false,
}: {
  stdout?: string
  stderr?: string
  code?: number | null
  error?: Error | null
  hang?: boolean
} = {}) {
  const calls: SpawnCall[] = []
  const spawn = (file: string, args: string[], opts: SpawnCall["opts"]) => {
    calls.push({ file, args, opts })
    const child = new EventEmitter() as FakeChild
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.kill = () => {
      // Emulate a killed process closing with a non-zero-ish signal path.
      child.emit("close", null)
    }
    queueMicrotask(() => {
      if (error) {
        child.emit("error", error)
        return
      }
      if (hang) return // never closes on its own → exercises the timeout path
      if (stderr) child.stderr.emit("data", Buffer.from(stderr))
      if (stdout) child.stdout.emit("data", Buffer.from(stdout))
      child.emit("close", code)
    })
    return child
  }
  return { spawn: spawn as unknown as EngineDeps["spawn"], calls }
}

const memFs = () => ({ writeFile: async () => {}, unlink: async () => {}, mkdir: async () => {} })

function injected(
  spawnObj: { spawn: EngineDeps["spawn"] },
  extra: Partial<EngineDeps> & { timeoutMs?: number } = {}
) {
  return {
    spawn: spawnObj.spawn,
    fs: memFs(),
    tmpDir: tmpdir(),
    randomId: () => "test-id",
    runnerPath: "runner.js",
    nodeExec: "node",
    ...extra,
  }
}

// ---- buildJob -------------------------------------------------------------

test("buildJob requires cwd, output, and (for snapshot) url", () => {
  assert.throws(
    () => buildJob(partialArgs({ output: "o", url: "https://x" })),
    /cwd .* is required/
  )
  assert.throws(
    () => buildJob(partialArgs({ cwd: "/w", url: "https://x" })),
    /output path is required/
  )
  assert.throws(() => buildJob({ cwd: "/w", output: "o" }), /url is required/)
})

test("buildJob rejects bad mode / framework / frameworkHint", () => {
  const cwd = realCwd()
  try {
    assert.throws(
      () => buildJob({ cwd, output: "o.html", url: "https://x", mode: "zip" }),
      /mode must be one of/
    )
    assert.throws(
      () => buildJob({ cwd, output: "o", url: "https://x", framework: "qwik" }),
      /framework must be one of/
    )
    assert.throws(
      () => buildJob({ cwd, output: "o", url: "https://x", frameworkHint: "angular" }),
      /frameworkHint must be one of/
    )
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

test("buildJob confines output under cwd (path traversal blocked)", () => {
  const cwd = realCwd()
  try {
    assert.throws(
      () => buildJob({ cwd, output: "../escape.html", url: "https://x" }),
      /escapes root/
    )
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

test("buildJob builds a snapshot job with clamped tuning + confined output", () => {
  const cwd = realCwd()
  try {
    const job = buildJob({
      cwd,
      url: "https://example.com/",
      output: "site",
      mode: "bundle",
      maxAssets: 99999, // clamps to 5000
      concurrency: 0, // clamps to 1
      timeout: 10, // clamps to 1000
      pretty: true,
    })
    assert.equal(job.mode, "snapshot")
    assert.equal(job.url, "https://example.com/")
    assert.equal(job.options.maxAssets, 5000)
    assert.equal(job.options.concurrency, 1)
    assert.equal(job.options.timeout, 1000)
    assert.equal(job.options.pretty, true)
    assert.ok(job.options.output.startsWith(realpathSync(cwd)))
    assert.equal(job.options.extractComponents, false)
    assert.equal(job.options.frameworkCodegen, undefined)
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

test("buildJob: a framework implies component extraction + codegen options", () => {
  const cwd = realCwd()
  try {
    const job = buildJob({
      cwd,
      url: "https://example.com/",
      output: "site",
      framework: "react",
      codegenGenerateDrafts: true,
      codegenExtractShared: true,
    })
    assert.equal(job.options.extractComponents, true)
    assert.deepEqual(job.options.frameworkCodegen, {
      framework: "react",
      typescript: true,
      cssModules: false,
      generateDrafts: true,
      extractSharedLogic: true,
    })
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

test("buildJob consumes the built engine's canonical parsers", () => {
  const cwd = realCwd()
  try {
    const job = buildJob({
      cwd,
      url: "https://example.com/",
      output: "site",
      framework: "REACT",
      frameworkHint: "VUE",
    })
    assert.equal(job.options.frameworkCodegen!.framework, "react")
    assert.equal(job.options.frameworkHint, "vue")
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

test("buildJob builds a convert job from convertLocal", () => {
  const cwd = realCwd()
  try {
    const job = buildJob({ cwd, convertLocal: "snap", output: "gen", framework: "vue" })
    assert.equal(job.mode, "convert")
    assert.ok(job.options.convertLocal!.startsWith(realpathSync(cwd)))
    assert.ok(job.options.output.startsWith(realpathSync(cwd)))
    assert.equal(job.options.frameworkCodegen!.framework, "vue")
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

// ---- runEngine ------------------------------------------------------------

test("compiled executables self-exec the webclone role instead of treating themselves as Node", () => {
  assert.deepEqual(
    resolveRunnerSpawn({
      standalone: true,
      execPath: "/dist/cognia-agent",
      runnerPath: "/$bunfs/root/runner.js",
      jobPath: "/tmp/job.json",
      env: { PATH: "/usr/bin" },
    }),
    {
      command: "/dist/cognia-agent",
      args: ["/tmp/job.json"],
      env: { PATH: "/usr/bin", COGNIA_ROLE: "webclone" },
    }
  )
})

test("source runtimes keep spawning the physical webclone runner", () => {
  assert.deepEqual(
    resolveRunnerSpawn({
      standalone: false,
      execPath: "/usr/bin/node",
      runnerPath: "/repo/runner.js",
      jobPath: "/tmp/job.json",
      env: { PATH: "/usr/bin" },
    }),
    {
      command: "/usr/bin/node",
      args: ["/repo/runner.js", "/tmp/job.json"],
      env: { PATH: "/usr/bin" },
    }
  )
})

const OK_ENVELOPE = JSON.stringify({
  ok: true,
  result: {
    sourceUrl: "https://x/",
    timestamp: "t",
    mode: "snapshot",
    output: "/w/o",
    stats: {},
    assets: [],
  },
})

test("runEngine parses the runner's stdout envelope", async () => {
  const spawnObj = fakeSpawn({ stdout: OK_ENVELOPE + "\n", stderr: "chatter\n", code: 0 })
  const env: Envelope = await runEngine(bareJob(), injected(spawnObj))
  assert.equal(env.ok, true)
  assert.equal(env.result!.mode, "snapshot")
  // Spawned node with [runnerPath, jobPath].
  assert.equal(spawnObj.calls.length, 1)
  assert.equal(spawnObj.calls[0]!.file, "node")
  assert.equal(spawnObj.calls[0]!.args[0], "runner.js")
})

test("runEngine returns a failure envelope even on non-zero exit", async () => {
  const failEnv = JSON.stringify({ ok: false, error: { name: "X", message: "boom" } })
  const spawnObj = fakeSpawn({ stdout: failEnv + "\n", code: 1 })
  const env: Envelope = await runEngine(bareJob(), injected(spawnObj))
  assert.equal(env.ok, false)
  assert.equal(env.error!.message, "boom")
})

test("runEngine throws when the runner produces no output", async () => {
  const spawnObj = fakeSpawn({ stdout: "", stderr: "died\n", code: 1 })
  await assert.rejects(() => runEngine(bareJob(), injected(spawnObj)), /produced no result/)
})

test("runEngine throws on unparseable runner output", async () => {
  const spawnObj = fakeSpawn({ stdout: "not json\n", code: 0 })
  await assert.rejects(() => runEngine(bareJob(), injected(spawnObj)), /unparseable output/)
})

test("runEngine surfaces a spawn error as a thrown 'no result'", async () => {
  const spawnObj = fakeSpawn({ error: new Error("ENOENT") })
  await assert.rejects(() => runEngine(bareJob(), injected(spawnObj)), /produced no result/)
})

test("runEngine throws on timeout (killed child)", async () => {
  const spawnObj = fakeSpawn({ hang: true })
  await assert.rejects(
    () => runEngine(bareJob(), injected(spawnObj, { timeoutMs: 20 })),
    /timed out/
  )
})

// ---- snapshotSite (build + SSRF pre-check + run) ---------------------------

test("snapshotSite blocks a private target before spawning", async () => {
  const cwd = realCwd()
  const spawnObj = fakeSpawn({ stdout: OK_ENVELOPE + "\n" })
  try {
    const env: Envelope = await snapshotSite(
      { cwd, url: "http://127.0.0.1/", output: "o.html" },
      injected(spawnObj)
    )
    assert.equal(env.ok, false)
    assert.equal(env.error!.reason, "private-host")
    assert.equal(spawnObj.calls.length, 0, "must not spawn for a blocked target")
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

test("snapshotSite runs the engine for an allowed target", async () => {
  const cwd = realCwd()
  const spawnObj = fakeSpawn({ stdout: OK_ENVELOPE + "\n" })
  try {
    const env: Envelope = await snapshotSite(
      { cwd, url: "https://example.com/", output: "o.html", mode: "single" },
      injected(spawnObj)
    )
    assert.equal(env.ok, true)
    assert.equal(spawnObj.calls.length, 1)
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

test("snapshotSite allows a private target when allowPrivateHosts is set", async () => {
  const cwd = realCwd()
  const spawnObj = fakeSpawn({ stdout: OK_ENVELOPE + "\n" })
  try {
    const env: Envelope = await snapshotSite(
      { cwd, url: "http://127.0.0.1/", output: "o.html", allowPrivateHosts: true },
      injected(spawnObj)
    )
    assert.equal(env.ok, true)
    assert.equal(spawnObj.calls.length, 1)
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

for (const [runtime, executable] of [
  ["node", process.execPath],
  ["bun", process.env.COGNIA_TEST_BUN],
] as const) {
  test(
    `real ${runtime} snapshot and conversion preserve child isolation and guards`,
    {
      skip: !executable,
      timeout: 30000,
    },
    async () => {
      const cwd = realCwd("wc-runtime-")
      const requests: string[] = []
      const server = createServer((request, response) => {
        requests.push(request.url ?? "")
        response.writeHead(200, { "content-type": "text/html" })
        response.end(
          '<!doctype html><html><head><style>.card{color:red}</style></head><body><header class="card" data-component="Hero"><h1>Webclone fixture</h1><button onclick="increment()">Go</button></header><script>let count=0;function increment(){count++}</script></body></html>'
        )
      })
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/fixture`
      const source = `
      import assert from 'node:assert/strict';
      import fs from 'node:fs/promises';
      import path from 'node:path';
      const { snapshotSite } = await import(${JSON.stringify(new URL("./run.ts", import.meta.url).href)});
      const options = {timeoutMs:10000};
      const cwd = ${JSON.stringify(cwd)};
      const url = ${JSON.stringify(url)};
      const blocked = await snapshotSite({cwd,url,output:'blocked'});
      assert.equal(blocked.ok,false);
      assert.equal(blocked.error.reason,'private-host');
      await assert.rejects(snapshotSite({cwd,url,output:'../escape',allowPrivateHosts:true}),/escapes root/);
      const snapshot = await snapshotSite({cwd,url,output:'snapshot',mode:'bundle',allowPrivateHosts:true},options);
      assert.equal(snapshot.ok,true,JSON.stringify(snapshot));
      assert.equal(snapshot.result.mode,'snapshot');
      assert.match(await fs.readFile(path.join(cwd,'snapshot/index.html'),'utf8'),/Webclone fixture/);
      const converted = await snapshotSite({cwd,convertLocal:'snapshot',output:'converted',mode:'bundle',framework:'react',codegenGenerateDrafts:true},options);
      assert.equal(converted.ok,true,JSON.stringify(converted));
      assert.equal(converted.result.mode,'convert');
      const index = JSON.parse(await fs.readFile(path.join(cwd,'converted/components/index.json'),'utf8'));
      assert.ok(index && typeof index === 'object');
      const draft = await fs.readFile(path.join(cwd,'converted/components/__drafts__/react/src/App.tsx'),'utf8');
      assert.match(draft,/import|export/);
      const temporary = (await fs.readdir(cwd)).filter(file=>file.startsWith('webclone-job-'));
      assert.deepEqual(temporary,[],'job files must be removed');
      console.log(JSON.stringify({runtime:process.versions.bun?'bun':'node',snapshot:true,convert:true}));
    `
      try {
        const result = await promisify(execFile)(
          executable!,
          [
            ...(runtime === "bun" ? ["--no-env-file"] : []),
            "--input-type=module",
            "--eval",
            source,
          ],
          {
            cwd,
            encoding: "utf8",
            timeout: 25000,
            env: {
              PATH: process.env.PATH,
              HOME: cwd,
              USERPROFILE: cwd,
              TMPDIR: cwd,
              NODE_ENV: "production",
              NO_COLOR: "1",
            },
          }
        )
        assert.match(result.stdout, new RegExp(`"runtime":"${runtime}"`))
        assert.deepEqual(
          requests,
          ["/fixture"],
          "blocked target and local conversion must make no extra requests"
        )
      } finally {
        server.closeAllConnections()
        await new Promise<void>((resolve) => server.close(() => resolve()))
        rmSync(cwd, { recursive: true, force: true })
      }
    }
  )
}

import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { test } from "node:test"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { setTimeout } from "node:timers/promises"
import { activePluginArtifactLeases, withPluginArtifactLock } from "./plugin-artifact-lease.mjs"
import { runWithPluginArtifacts } from "./with-plugin-artifacts.mjs"

test("prepares before the real child starts and retains its lease until child exit", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "leased-compiler-"))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const marker = path.join(root, "active"),
    output = path.join(root, "compiled")
  const result = await runWithPluginArtifacts({
    root,
    args: [
      process.execPath,
      "-e",
      "const fs=require('fs');if(!fs.existsSync('active'))process.exit(7);fs.writeFileSync('compiled','done')",
    ],
    prepare: async ({ hold }) => {
      assert.equal(hold, true)
      fs.writeFileSync(marker, "leased")
      return {
        release() {
          assert.equal(fs.readFileSync(output, "utf8"), "done")
          fs.rmSync(marker)
        },
      }
    },
  })
  assert.equal(result.code, 0)
  assert.equal(fs.existsSync(marker), false)
})

test("a compiler failure releases the lease and preserves the child failure", async () => {
  let released = false
  const result = await runWithPluginArtifacts({
    args: [process.execPath, "-e", "process.exit(9)"],
    prepare: async () => ({
      release() {
        released = true
      },
    }),
  })
  assert.equal(result.code, 9)
  assert.equal(released, true)
  await assert.rejects(runWithPluginArtifacts({ args: [] }), /requires a command/)
  await assert.rejects(
    runWithPluginArtifacts({ args: ["cargo", "build"] }),
    /requires a Node entry/
  )
})

test("a missing compiler releases the lease even when command resolution fails", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "missing-plugin-compiler-"))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.writeFileSync(path.join(root, "package.json"), "{}")
  let released = false
  await assert.rejects(
    runWithPluginArtifacts({
      root,
      args: ["next", "build"],
      prepare: async () => ({
        release() {
          released = true
        },
      }),
    }),
    /Cannot find module/
  )
  assert.equal(released, true)
})

test(
  "killing the wrapper cannot discard the live compiler's process-family lease",
  { skip: process.platform === "win32" },
  async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "orphan-plugin-compiler-"))
    const access = path.join(root, ".cache/plugin-artifact-access")
    fs.mkdirSync(access, { recursive: true })
    const artifactSha256 = "a".repeat(64)
    fs.writeFileSync(path.join(access, "receipt.json"), JSON.stringify({ artifactSha256 }))
    const marker = path.join(root, "compiler.pid")
    const code = `import {runWithPluginArtifacts} from ${JSON.stringify(new URL("./with-plugin-artifacts.mjs", import.meta.url).href)}; await runWithPluginArtifacts({root:${JSON.stringify(root)},args:[process.execPath,'-e',${JSON.stringify(`require('fs').writeFileSync(${JSON.stringify(marker)},String(process.pid));setInterval(()=>{},1000)`)}],prepare:async()=>({artifactSha256:${JSON.stringify(artifactSha256)},release(){}})})`
    const wrapper = spawn(process.execPath, ["--input-type=module", "-e", code], {
      stdio: ["ignore", "ignore", "inherit"],
    })
    let compilerPid
    t.after(() => {
      if (wrapper.exitCode === null && wrapper.signalCode === null) wrapper.kill("SIGKILL")
      if (compilerPid) {
        try {
          process.kill(-compilerPid, "SIGKILL")
        } catch {}
      }
      fs.rmSync(root, { recursive: true, force: true })
    })
    const deadline = Date.now() + 5000
    while (!fs.existsSync(marker)) {
      if (Date.now() > deadline) assert.fail("Compiler did not start")
      await setTimeout(20)
    }
    compilerPid = Number(fs.readFileSync(marker, "utf8"))
    const exited = once(wrapper, "exit")
    wrapper.kill("SIGKILL")
    await exited
    process.kill(compilerPid, 0)
    await withPluginArtifactLock(root, (directory) => {
      const readers = activePluginArtifactLeases(directory)
      assert.ok(
        readers.some(
          (reader) =>
            reader.pid === compilerPid &&
            reader.processGroup &&
            reader.artifactSha256 === artifactSha256
        )
      )
    })
  }
)

for (const mode of [
  "normal",
  "crash",
  "orphan",
  "wrapper-crash",
  "guardian-crash",
  "custom-preload",
]) {
  test(
    `Windows compiler job recovers after ${mode}`,
    { skip: process.platform !== "win32", timeout: 60000 },
    async (t) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "windows-plugin-job-"))
      const access = path.join(root, ".cache/plugin-artifact-access")
      fs.mkdirSync(access, { recursive: true })
      const artifactSha256 = "a".repeat(64)
      fs.writeFileSync(path.join(access, "receipt.json"), JSON.stringify({ artifactSha256 }))
      const ready = path.join(root, "ready.json")
      const workerReady = path.join(root, "worker-ready")
      const unexpectedPreload = path.join(root, "unexpected-guardian-preload")
      const hasWorker = mode === "orphan" || mode === "wrapper-crash"
      const env = {
        ...process.env,
        COGNIA_PLUGIN_COMPILATION_LEASE: JSON.stringify({ root, artifactSha256 }),
      }
      if (mode === "custom-preload") {
        const preload = `import fs from 'node:fs';if(process.argv.some(arg=>arg.endsWith('powershell.exe'))){fs.writeFileSync(${JSON.stringify(unexpectedPreload)},'executed');throw Error('Guardian inherited compiler preload')}`
        for (const key of Object.keys(env))
          if (key.toUpperCase() === "NODE_OPTIONS") delete env[key]
        env.node_options = `--import=data:text/javascript,${encodeURIComponent(preload)}`
      }
      const source = `
      const fs = require('node:fs');
      let worker;
      if (${JSON.stringify(hasWorker)}) {
        worker = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(`require('node:fs').writeFileSync(${JSON.stringify(workerReady)}, 'ready');setInterval(()=>{},1000)`)}], {stdio:'ignore',detached:true});
        worker.unref();
      }
      fs.writeFileSync(${JSON.stringify(ready)}, JSON.stringify({pid:process.pid,worker:worker?.pid}));
      if (${JSON.stringify(mode)} === 'normal') process.exit(0);
      if (${JSON.stringify(mode)} === 'orphan') {
        const timer = setInterval(()=>{if(fs.existsSync(${JSON.stringify(workerReady)})){clearInterval(timer);process.exit(0)}},20);
      } else setInterval(()=>{},1000);
    `
      const args =
        mode === "wrapper-crash"
          ? [
              "--input-type=module",
              "-e",
              `import {runWithPluginArtifacts} from ${JSON.stringify(new URL("./with-plugin-artifacts.mjs", import.meta.url).href)}; await runWithPluginArtifacts({root:${JSON.stringify(root)},args:[process.execPath,'-e',${JSON.stringify(source)}],prepare:async()=>({artifactSha256:${JSON.stringify(artifactSha256)},release(){}})})`,
            ]
          : [
              "--import",
              new URL("./plugin-artifact-child-lease.mjs", import.meta.url).href,
              "-e",
              source,
            ]
      const compiler = spawn(process.execPath, args, {
        stdio: ["ignore", "ignore", "inherit"],
        env,
      })
      const exited = once(compiler, "exit")
      let workerPid, guardianPid
      const kill = (pid) => {
        if (pid) {
          try {
            process.kill(pid, "SIGKILL")
          } catch (error) {
            if (error.code !== "ESRCH") throw error
          }
        }
      }
      t.after(() => {
        if (compiler.exitCode === null && compiler.signalCode === null) compiler.kill("SIGKILL")
        kill(workerPid)
        kill(guardianPid)
        fs.rmSync(root, { recursive: true, force: true })
      })
      const deadline = Date.now() + 30000
      while (!fs.existsSync(ready) || (hasWorker && !fs.existsSync(workerReady))) {
        if (compiler.exitCode !== null || compiler.signalCode !== null)
          assert.fail("Compiler exited before Job attachment")
        if (Date.now() > deadline) assert.fail("Compiler did not start in its Windows Job")
        await setTimeout(20)
      }
      workerPid = JSON.parse(fs.readFileSync(ready, "utf8")).worker
      const file = fs.readdirSync(access).find((name) => /^reader-.*\.json$/.test(name))
      const lease = JSON.parse(fs.readFileSync(path.join(access, file), "utf8"))
      assert.ok(lease.windowsJob)
      assert.equal(lease.unconfirmedFamily, false)
      assert.equal(fs.existsSync(unexpectedPreload), false)
      guardianPid = lease.windowsJobOwner
      if (mode === "guardian-crash") kill(guardianPid)
      if (mode === "crash" || mode === "custom-preload" || mode === "wrapper-crash")
        compiler.kill("SIGKILL")
      await exited
      // Windows libuv may terminate the wrapper's entire nested compiler Job.
      // A zero lease is valid only when that worker is actually confirmed dead.
      let workerAlive = hasWorker
      if (mode === "wrapper-crash") {
        try {
          process.kill(workerPid, 0)
        } catch (error) {
          if (error.code !== "ESRCH") throw error
          workerAlive = false
        }
      }
      await withPluginArtifactLock(root, (directory) => {
        const readers = activePluginArtifactLeases(directory)
        assert.equal(readers.length, workerAlive ? 1 : 0)
      })
      if (workerAlive) {
        process.kill(workerPid, 0)
        kill(workerPid)
        workerPid = undefined
        await withPluginArtifactLock(root, (directory) => {
          assert.equal(activePluginArtifactLeases(directory).length, 0)
        })
      }
      workerPid = undefined
      // The guardian may already have exited after observing an empty job.
      guardianPid = undefined
    }
  )
}

test(
  "failed Windows guardian attachment prevents application imports",
  { skip: process.platform !== "win32", timeout: 60000 },
  async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "windows-plugin-job-failed-"))
    t.after(() => fs.rmSync(root, { recursive: true, force: true }))
    const access = path.join(root, ".cache/plugin-artifact-access")
    fs.mkdirSync(access, { recursive: true })
    const artifactSha256 = "a".repeat(64)
    fs.writeFileSync(path.join(access, "receipt.json"), JSON.stringify({ artifactSha256 }))
    const started = path.join(root, "application-imported")
    const preloadDir = path.join(root, "isolated-preload")
    fs.mkdirSync(preloadDir)
    for (const name of ["plugin-artifact-child-lease.mjs", "plugin-artifact-lease.mjs"])
      fs.copyFileSync(new URL(name, import.meta.url), path.join(preloadDir, name))
    fs.writeFileSync(
      path.join(preloadDir, "plugin-artifact-windows-job.ps1"),
      "param([string]$Mode,[string]$JobName,[int]$OwnerPid)\n[Console]::Error.WriteLine('fixture: attach denied')\nexit 1\n"
    )
    const compiler = spawn(
      process.execPath,
      [
        "--import",
        pathToFileURL(path.join(preloadDir, "plugin-artifact-child-lease.mjs")).href,
        "-e",
        `require('node:fs').writeFileSync(${JSON.stringify(started)},'started')`,
      ],
      {
        stdio: ["ignore", "ignore", "pipe"],
        env: {
          ...process.env,
          COGNIA_PLUGIN_COMPILATION_LEASE: JSON.stringify({ root, artifactSha256 }),
        },
      }
    )
    let diagnostic = ""
    compiler.stderr.on("data", (chunk) => {
      diagnostic += chunk
    })
    const [code] = await once(compiler, "exit")
    assert.notEqual(code, 0)
    assert.match(diagnostic, /Windows artifact job could not attach/)
    assert.match(diagnostic, /fixture: attach denied/)
    assert.equal(fs.existsSync(started), false)
  }
)

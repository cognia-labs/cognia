import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
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

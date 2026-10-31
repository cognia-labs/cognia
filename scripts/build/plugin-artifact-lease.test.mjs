import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { test } from "node:test"
import {
  withPluginArtifactLock,
  activePluginArtifactLeases,
  createPluginArtifactLease,
} from "./plugin-artifact-lease.mjs"

test("a live writer excludes another process; a killed writer is reaped before retry", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-lock-process-"))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const source = `import {withPluginArtifactLock} from ${JSON.stringify(new URL("./plugin-artifact-lease.mjs", import.meta.url).href)};await withPluginArtifactLock(${JSON.stringify(root)},async()=>{process.stdout.write('locked');await new Promise(()=>{setInterval(()=>{},1000)})})`
  const child = spawn(process.execPath, ["--input-type=module", "-e", source], {
    stdio: ["ignore", "pipe", "inherit"],
  })
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
  })
  const [ready] = await once(child.stdout, "data")
  assert.equal(ready.toString(), "locked")
  await assert.rejects(
    withPluginArtifactLock(root, () => assert.fail("must not acquire"), { timeoutMs: 80 }),
    /artifact_in_use/
  )
  const exited = once(child, "exit")
  child.kill("SIGKILL")
  await exited
  await withPluginArtifactLock(root, (directory) => {
    const release = createPluginArtifactLease(directory, "a".repeat(64))
    assert.equal(activePluginArtifactLeases(directory).length, 1)
    release()
    release()
    assert.equal(activePluginArtifactLeases(directory).length, 0)
    fs.writeFileSync(
      path.join(directory, "reader-dead.json"),
      JSON.stringify({ pid: child.pid, artifactSha256: "a".repeat(64) })
    )
    assert.equal(activePluginArtifactLeases(directory).length, 0)
  })
})

test("an exception releases the writer and invalid reader owners fail closed", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-lock-error-"))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  await assert.rejects(
    withPluginArtifactLock(root, () => {
      throw new Error("compiler failed")
    }),
    /compiler failed/
  )
  await withPluginArtifactLock(root, () => {})
  await withPluginArtifactLock(root, (directory) => {
    fs.writeFileSync(path.join(directory, "reader-invalid.json"), JSON.stringify({ pid: -1 }))
    assert.throws(() => activePluginArtifactLeases(directory), /Invalid plugin artifact lock owner/)
  })
})

test("an unconfirmed compiler family remains guarded after its leader exits normally", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-unknown-family-"))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const source = `import {withPluginArtifactLock,createPluginArtifactLease} from ${JSON.stringify(new URL("./plugin-artifact-lease.mjs", import.meta.url).href)};await withPluginArtifactLock(${JSON.stringify(root)},directory=>createPluginArtifactLease(directory,'a'.repeat(64),{unconfirmedFamily:true}))`
  const child = spawn(process.execPath, ["--input-type=module", "-e", source], {
    stdio: "ignore",
  })
  const [code] = await once(child, "exit")
  assert.equal(code, 0)
  await withPluginArtifactLock(root, (directory) => {
    const leases = activePluginArtifactLeases(directory)
    assert.equal(leases.length, 1)
    assert.equal(leases[0].pid, child.pid)
    assert.equal(leases[0].unconfirmedFamily, true)
  })
})

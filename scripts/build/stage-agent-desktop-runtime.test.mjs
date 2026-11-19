import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { test } from "node:test"
import {
  agentDesktopSourceDigest, digest, prepareAgentDesktopSource, readAgentDesktopPin,
  stageAgentDesktopRuntime, verifyAgentDesktopProfile, verifyAgentDesktopReceipt,
} from "./stage-agent-desktop-runtime.mjs"

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cognia-agent-desktop-"))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const cache = path.join(root, "cache")
  const input = path.join(root, "input", "source")
  fs.mkdirSync(input, { recursive: true })
  fs.mkdirSync(cache)
  fs.writeFileSync(path.join(input, "source.txt"), "upstream\n")
  const tar = spawnSync("tar", ["-czf", path.join(cache, "source.tgz"), "-C", path.dirname(input), "source"])
  assert.equal(tar.status, 0)
  const pin = { ...readAgentDesktopPin(), patchBytes: undefined,
    sourceSha256: digest(fs.readFileSync(path.join(cache, "source.tgz"))) }
  const patch = "diff --git a/source.txt b/source.txt\n--- a/source.txt\n+++ b/source.txt\n@@ -1 +1 @@\n-upstream\n+guarded\n"
  pin.patchSha256 = digest(patch)
  fs.mkdirSync(path.dirname(path.join(root, pin.patch)), { recursive: true })
  fs.writeFileSync(path.join(root, pin.patch), patch)
  fs.writeFileSync(path.join(root, "integrations/agent-desktop.json"), JSON.stringify(pin))
  return { root, cache, pin }
}

test("patched source is rebuilt from authenticated bytes after local source tampering", t => {
  const options = fixture(t)
  const first = prepareAgentDesktopSource(options)
  fs.writeFileSync(path.join(first.source, "source.txt"), "tampered")
  const second = prepareAgentDesktopSource(options)
  assert.equal(fs.readFileSync(path.join(second.source, "source.txt"), "utf8"), "guarded\n")
})

test("corrupt archive and corrupt patch are rejected before extraction/build", t => {
  const { root, cache, pin } = fixture(t)
  fs.appendFileSync(path.join(root, pin.patch), "corrupt")
  assert.throws(() => prepareAgentDesktopSource({ root, cache }), /patch integrity/)
  const other = fixture(t)
  fs.appendFileSync(path.join(other.cache, "source.tgz"), "corrupt")
  assert.throws(() => prepareAgentDesktopSource(other), /source integrity/)
})

test("concurrent patch edits cannot replace the already authenticated input", t => {
  const options = fixture(t)
  const run = (program, args, settings) => {
    if (program === "tar") fs.writeFileSync(path.join(options.root, options.pin.patch), "unverified patch")
    return spawnSync(program, args, settings)
  }
  const { source } = prepareAgentDesktopSource({ ...options, run })
  assert.equal(fs.readFileSync(path.join(source, "source.txt"), "utf8"), "guarded\n")
})

test("profile must name each required safety patch and the expected envelope", () => {
  const pin = readAgentDesktopPin()
  const version = { version: "2.6", ok: true, command: "version", data: {
    version: "1.2.0", os: "macos", target: "aarch64", cognia: {
      profile: pin.profile, windowBinding: "per-ax-mutation-v1", supervisorLease: "inherited-flock-v1",
      legacyHostCleanup: false, rendererActivation: false, rendererObservation: "partial-without-activation-v1",
    },
  } }
  verifyAgentDesktopProfile(version, pin)
  for (const key of ["windowBinding", "supervisorLease", "legacyHostCleanup", "rendererActivation", "rendererObservation"]) {
    const changed = structuredClone(version)
    delete changed.data.cognia[key]
    assert.throws(() => verifyAgentDesktopProfile(changed, pin), /profile mismatch/)
  }
  assert.throws(() => verifyAgentDesktopProfile({ ...version, version: "2.5" }, pin), /profile mismatch/)
})

test("native qualification rejects a different executable or test source", t => {
  const options = fixture(t)
  const { source, pin } = prepareAgentDesktopSource(options)
  const binary = path.join(options.cache, "agent-desktop")
  fs.writeFileSync(binary, "candidate")
  const receipt = { ...pin, patchBytes: undefined, sha256: digest("candidate"), sourceTreeSha256: agentDesktopSourceDigest(source) }
  fs.writeFileSync(path.join(options.cache, "receipt.json"), JSON.stringify(receipt))
  verifyAgentDesktopReceipt(binary, source, options.root)
  fs.writeFileSync(binary, "other candidate")
  assert.throws(() => verifyAgentDesktopReceipt(binary, source, options.root), /build receipt/)
  fs.writeFileSync(binary, "candidate")
  fs.writeFileSync(path.join(source, "source.txt"), "other guard")
  assert.throws(() => verifyAgentDesktopReceipt(binary, source, options.root), /build receipt/)
})

test("unsupported targets never start a download or build", () => {
  const result = stageAgentDesktopRuntime({ target: "x86_64-unknown-linux-gnu", run: () => { throw new Error("must not run") } })
  assert.equal(result.supported, false)
})

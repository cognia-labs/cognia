import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { test } from "node:test"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import {
  PLUGIN_NODE_VERSION,
  RUST_TARGET_NODE_PLATFORMS,
  archiveFor,
  cachedRuntimeProblem,
  canRunOnHost,
  executableTarget,
  parseArgs,
  pluginNodeTarget,
  runtimeStamp,
  verifyArchive,
  verifyExecutableTarget,
} from "./prepare-plugin-node.mjs"

/** A thin 64-bit Mach-O header with `cpu` as its cputype. */
function machO(cpu) {
  const bytes = Buffer.alloc(64)
  bytes.writeUInt32LE(0xfeedfacf, 0)
  bytes.writeUInt32LE(cpu, 4)
  return bytes
}

/** A universal Mach-O header with one slice per cputype. */
function fatMachO(...cpus) {
  const bytes = Buffer.alloc(8 + cpus.length * 20 + 16)
  bytes.writeUInt32BE(0xcafebabe, 0)
  bytes.writeUInt32BE(cpus.length, 4)
  cpus.forEach((cpu, index) => bytes.writeUInt32BE(cpu, 8 + index * 20))
  return bytes
}

/** A little-endian 64-bit ELF header with `machine` as its e_machine. */
function elf(machine) {
  const bytes = Buffer.alloc(64)
  bytes.writeUInt32BE(0x7f454c46, 0)
  bytes[4] = 2
  bytes[5] = 1
  bytes.writeUInt16LE(machine, 18)
  return bytes
}

/** A PE image whose COFF header names `machine`. */
function pe(machine) {
  const bytes = Buffer.alloc(0x100)
  bytes.writeUInt16LE(0x5a4d, 0)
  bytes.writeUInt32LE(0x80, 0x3c)
  bytes.writeUInt32LE(0x00004550, 0x80)
  bytes.writeUInt16LE(machine, 0x84)
  return bytes
}

const X64 = 0x01000007
const ARM64 = 0x0100000c

test("parseArgs supports verification and rejects unknown options", () => {
  assert.deepEqual(parseArgs([]), { check: false })
  assert.deepEqual(parseArgs(["--check"]), { check: true })
  assert.throws(() => parseArgs(["--unknown"]), /unknown option/i)
})

test("archiveFor pins every supported desktop target", () => {
  assert.match(archiveFor("darwin", "arm64").file, new RegExp(`v${PLUGIN_NODE_VERSION}`))
  assert.match(archiveFor("darwin", "x64").file, /darwin-x64\.tar\.xz$/)
  assert.match(archiveFor("linux", "arm64").file, /linux-arm64\.tar\.xz$/)
  assert.match(archiveFor("linux", "x64").file, /linux-x64\.tar\.xz$/)
  assert.match(archiveFor("win32", "arm64").file, /win-arm64\.zip$/)
  assert.match(archiveFor("win32", "x64").file, /win-x64\.zip$/)
  assert.throws(() => archiveFor("freebsd", "x64"), /Unsupported/)
})

test("verifyArchive rejects bytes that do not match the pinned digest", () => {
  assert.doesNotThrow(() =>
    verifyArchive(Buffer.from("verified"), "1c34f88707b55e6104c4eb20e71ffa3d33e414b71ef689a15fad0640d0ac58cb")
  )
  assert.throws(() => verifyArchive(Buffer.from("tampered"), "0".repeat(64)), /checksum mismatch/)
})

test("Tauri build and dev commands bundle the verified runtime and Agent host", () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
  const config = JSON.parse(readFileSync(resolve(root, "src-tauri/tauri.conf.json"), "utf8"))

  assert.match(config.build.beforeBuildCommand, /plugin-node:prepare/)
  assert.match(config.build.beforeDevCommand, /plugin-node:prepare/)
  assert.ok(config.bundle.resources.includes("resources/plugin-node/**/*"))
  assert.ok(config.bundle.resources.includes("../sidecar/agent-host.mjs"))
})

test("the runtime follows the Tauri build target, not the machine building it (PL11)", () => {
  // An Intel bundle built on an ARM Mac.
  assert.deepEqual(
    pluginNodeTarget({ rustTarget: "x86_64-apple-darwin", hostPlatform: "darwin", hostArch: "arm64" }),
    { platform: "darwin", arch: "x64" }
  )
  // No target triple: the build targets this machine.
  assert.deepEqual(pluginNodeTarget({ rustTarget: "", hostPlatform: "linux", hostArch: "arm64" }), {
    platform: "linux",
    arch: "arm64",
  })
  assert.throws(
    () => pluginNodeTarget({ rustTarget: "universal-apple-darwin" }),
    /Unsupported plugin Node runtime target universal-apple-darwin/
  )
  // Every triple maps onto a pinned archive.
  for (const { platform, arch } of Object.values(RUST_TARGET_NODE_PLATFORMS)) {
    assert.ok(archiveFor(platform, arch).sha256)
  }
})

test("every release target triple the CI matrix builds has a runtime", () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
  const workflow = readFileSync(resolve(root, ".github/workflows/build-tauri.yml"), "utf8")
  const targets = [...workflow.matchAll(/^\s*target: ([\w-]+)$/gm)].map((match) => match[1])
  assert.ok(targets.length > 0)
  for (const target of targets) assert.ok(RUST_TARGET_NODE_PLATFORMS[target], target)
})

test("executable headers name their platform and architecture", () => {
  assert.deepEqual(executableTarget(machO(X64)), { platform: "darwin", arches: ["x64"] })
  assert.deepEqual(executableTarget(machO(ARM64)), { platform: "darwin", arches: ["arm64"] })
  assert.deepEqual(executableTarget(fatMachO(X64, ARM64)), {
    platform: "darwin",
    arches: ["x64", "arm64"],
  })
  assert.deepEqual(executableTarget(elf(62)), { platform: "linux", arches: ["x64"] })
  assert.deepEqual(executableTarget(elf(183)), { platform: "linux", arches: ["arm64"] })
  assert.deepEqual(executableTarget(pe(0x8664)), { platform: "win32", arches: ["x64"] })
  assert.deepEqual(executableTarget(pe(0xaa64)), { platform: "win32", arches: ["arm64"] })
  assert.equal(executableTarget(Buffer.from("#!/bin/sh\necho v26.12.1\n")), null)
})

test("an executable for another architecture or platform is refused", () => {
  const intelMac = { platform: "darwin", arch: "x64" }
  assert.doesNotThrow(() => verifyExecutableTarget(machO(X64), intelMac, "node"))
  assert.throws(() => verifyExecutableTarget(machO(ARM64), intelMac, "node"), /darwin-arm64, not darwin-x64/)
  assert.throws(() => verifyExecutableTarget(elf(62), intelMac, "node"), /linux-x64, not darwin-x64/)
  assert.throws(
    () => verifyExecutableTarget(Buffer.from("echo v26"), intelMac, "node"),
    /not an executable/
  )
})

test("a cached runtime is reused only when its stamp, bytes and header match (ENV05)", () => {
  const dir = mkdtempSync(join(tmpdir(), "plugin-node-test-"))
  try {
    const target = { platform: "darwin", arch: "x64" }
    const binary = join(dir, "node")
    const stampPath = join(dir, ".cognia-plugin-node.json")
    const write = (bytes, stamp) => {
      writeFileSync(binary, bytes)
      writeFileSync(stampPath, JSON.stringify(stamp))
    }

    assert.match(cachedRuntimeProblem({ binary, stampPath, target }), /no runtime/)

    const good = machO(X64)
    write(good, runtimeStamp(target, good))
    assert.equal(cachedRuntimeProblem({ binary, stampPath, target }), null)

    // A script that prints the right version is no longer enough.
    const impostor = Buffer.from(`#!/bin/sh\necho v${PLUGIN_NODE_VERSION}\n`)
    write(impostor, runtimeStamp(target, good))
    assert.match(cachedRuntimeProblem({ binary, stampPath, target }), /changed since it was prepared/)

    // Stamped for this build but the wrong architecture.
    const arm = machO(ARM64)
    write(arm, runtimeStamp(target, arm))
    assert.match(cachedRuntimeProblem({ binary, stampPath, target }), /darwin-arm64, not darwin-x64/)

    // Prepared for another target, or from another archive.
    write(good, { ...runtimeStamp(target, good), target: "darwin-arm64" })
    assert.match(cachedRuntimeProblem({ binary, stampPath, target }), /target darwin-arm64/)
    write(good, { ...runtimeStamp(target, good), archiveSha256: "0".repeat(64) })
    assert.match(cachedRuntimeProblem({ binary, stampPath, target }), /archiveSha256/)

    // A runtime with no stamp was never verified by this script.
    rmSync(stampPath)
    assert.match(cachedRuntimeProblem({ binary, stampPath, target }), /no stamp/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("the version smoke runs only where the target binary can execute", () => {
  assert.equal(canRunOnHost({ platform: "darwin", arch: "x64" }, "darwin", "arm64"), false)
  assert.equal(canRunOnHost({ platform: "darwin", arch: "arm64" }, "darwin", "arm64"), true)
})

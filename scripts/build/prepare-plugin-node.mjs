/**
 * Prepare the pinned Node.js runtime the desktop bundles for plugins
 * (`src-tauri/resources/plugin-node`).
 *
 * The runtime is chosen for the build *target*, not the machine running the
 * build: Tauri hands every `before*Command` the target triple in
 * `TAURI_ENV_TARGET_TRIPLE`, so an Intel bundle built on an ARM Mac gets the
 * x64 Node it will run, not the builder's ARM one.
 *
 * A prepared runtime carries a stamp naming its version, target, the pinned
 * archive it came from and the digest of the binary taken from it. A cached
 * runtime is reused only when that stamp matches what this build pins, its
 * bytes still hash to the stamped digest and its executable header is the
 * target's architecture. `--version` is a smoke test on top, run only where
 * the binary can execute (the target is this machine's).
 */
import { createHash } from "node:crypto"
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { Command, CommanderError } from "commander"
import { execaSync } from "execa"
import { z } from "zod"

export const PLUGIN_NODE_VERSION = "26.12.1"

/** Written beside the runtime; see the module doc. */
export const STAMP_FILE = ".cognia-plugin-node.json"

export const PLUGIN_NODE_ARCHIVES = Object.freeze({
  "darwin-arm64": {
    file: `node-v${PLUGIN_NODE_VERSION}-darwin-arm64.tar.xz`,
    sha256: "18830bf448fe187c650dc28c98aa8c968ed1d40b6dd032c081e70a384a1bf660",
  },
  "darwin-x64": {
    file: `node-v${PLUGIN_NODE_VERSION}-darwin-x64.tar.xz`,
    sha256: "69316aaafb4dfcb25ac7b9a460f5c60928a37580284fde410144d0e6c8672d0f",
  },
  "linux-arm64": {
    file: `node-v${PLUGIN_NODE_VERSION}-linux-arm64.tar.xz`,
    sha256: "42aa04922591ee5d4dbc7740d452621acf28508239daa512f5ee8c47ee224fdb",
  },
  "linux-x64": {
    file: `node-v${PLUGIN_NODE_VERSION}-linux-x64.tar.xz`,
    sha256: "6170b2d474e1c626f43cff3adc118df9fe3b573258a4fc3d850c8dbc6b079bbd",
  },
  "win32-arm64": {
    file: `node-v${PLUGIN_NODE_VERSION}-win-arm64.zip`,
    sha256: "34567581ee63967b37afb6b7a0cc63a2d550a43d5d838adb75982d7e356f2e2c",
  },
  "win32-x64": {
    file: `node-v${PLUGIN_NODE_VERSION}-win-x64.zip`,
    sha256: "b3efd5c70cba3308ed46e7e699a9b8aac075bbc6b027fcb39c84c31acc25e2b4",
  },
})

export function archiveFor(platform = process.platform, arch = process.arch) {
  const archive = PLUGIN_NODE_ARCHIVES[`${platform}-${arch}`]
  if (!archive) {
    throw new Error(`Unsupported plugin Node runtime target: ${platform}-${arch}`)
  }
  return archive
}

/** Every Rust target triple the desktop is bundled for, as a Node archive platform/arch. */
export const RUST_TARGET_NODE_PLATFORMS = Object.freeze({
  "aarch64-apple-darwin": { platform: "darwin", arch: "arm64" },
  "x86_64-apple-darwin": { platform: "darwin", arch: "x64" },
  "aarch64-unknown-linux-gnu": { platform: "linux", arch: "arm64" },
  "x86_64-unknown-linux-gnu": { platform: "linux", arch: "x64" },
  "aarch64-pc-windows-msvc": { platform: "win32", arch: "arm64" },
  "x86_64-pc-windows-msvc": { platform: "win32", arch: "x64" },
})

/**
 * The platform/arch the bundled runtime must run on. `rustTarget` is the
 * triple Tauri builds for; without one the build targets this machine.
 */
export function pluginNodeTarget({
  rustTarget = process.env.TAURI_ENV_TARGET_TRIPLE ?? process.env.CARGO_BUILD_TARGET,
  hostPlatform = process.platform,
  hostArch = process.arch,
} = {}) {
  if (!rustTarget) return { platform: hostPlatform, arch: hostArch }
  const target = RUST_TARGET_NODE_PLATFORMS[rustTarget]
  if (!target) {
    throw new Error(
      `Unsupported plugin Node runtime target ${rustTarget}; build one of ${Object.keys(RUST_TARGET_NODE_PLATFORMS).join(", ")}`
    )
  }
  return target
}

export function verifyArchive(bytes, expectedSha256) {
  const actual = sha256Hex(bytes)
  if (actual !== expectedSha256) {
    throw new Error(`Plugin Node archive checksum mismatch: expected ${expectedSha256}, got ${actual}`)
  }
}

function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex")
}

// Mach-O cputype, ELF e_machine and PE Machine values of the two arches.
const MACH_O_CPU = Object.freeze({ 0x01000007: "x64", 0x0100000c: "arm64" })
const ELF_MACHINE = Object.freeze({ 62: "x64", 183: "arm64" })
const PE_MACHINE = Object.freeze({ 0x8664: "x64", 0xaa64: "arm64" })

/**
 * The platform and architectures an executable's header declares, or `null`
 * when it is none of Mach-O, ELF or PE. A universal Mach-O lists each slice.
 */
export function executableTarget(bytes) {
  if (bytes.length >= 8 && bytes.readUInt32LE(0) === 0xfeedfacf) {
    return { platform: "darwin", arches: [MACH_O_CPU[bytes.readUInt32LE(4)]].filter(Boolean) }
  }
  if (bytes.length >= 8 && bytes.readUInt32BE(0) === 0xcafebabe) {
    const count = bytes.readUInt32BE(4)
    // Java class files share the magic; their "count" is a version >= 45.
    if (count >= 45 || bytes.length < 8 + count * 20) return null
    const arches = []
    for (let slice = 0; slice < count; slice += 1) {
      const arch = MACH_O_CPU[bytes.readUInt32BE(8 + slice * 20)]
      if (arch) arches.push(arch)
    }
    return { platform: "darwin", arches }
  }
  if (bytes.length >= 20 && bytes.readUInt32BE(0) === 0x7f454c46) {
    // EI_DATA 1 is little-endian, 2 big-endian; e_machine follows the ident.
    const machine = bytes[5] === 2 ? bytes.readUInt16BE(18) : bytes.readUInt16LE(18)
    return { platform: "linux", arches: [ELF_MACHINE[machine]].filter(Boolean) }
  }
  if (bytes.length >= 0x40 && bytes.readUInt16LE(0) === 0x5a4d) {
    const header = bytes.readUInt32LE(0x3c)
    if (bytes.length < header + 6 || bytes.readUInt32LE(header) !== 0x00004550) return null
    return { platform: "win32", arches: [PE_MACHINE[bytes.readUInt16LE(header + 4)]].filter(Boolean) }
  }
  return null
}

/** Refuse an executable that will not run on `target`. */
export function verifyExecutableTarget(bytes, target, what) {
  const declared = executableTarget(bytes)
  if (!declared || declared.platform !== target.platform || !declared.arches.includes(target.arch)) {
    const found = declared ? `${declared.platform}-${declared.arches.join("+") || "unknown"}` : "not an executable"
    throw new Error(`${what} is ${found}, not ${target.platform}-${target.arch}`)
  }
}

/** The stamp a prepared runtime carries: what it is, and where it came from. */
export function runtimeStamp(target, binaryBytes) {
  return {
    version: PLUGIN_NODE_VERSION,
    target: `${target.platform}-${target.arch}`,
    archiveSha256: archiveFor(target.platform, target.arch).sha256,
    binarySha256: sha256Hex(binaryBytes),
  }
}

/**
 * Why the runtime at `binary` is not the one this build pins for `target`,
 * or `null` when it is. Never runs the binary.
 */
export function cachedRuntimeProblem({ binary, stampPath, target }) {
  if (!existsSync(binary)) return `no runtime at ${binary}`
  if (!existsSync(stampPath)) return `the runtime at ${binary} has no stamp`
  let stamp
  try {
    stamp = JSON.parse(readFileSync(stampPath, "utf8"))
  } catch {
    return `the runtime stamp at ${stampPath} is unreadable`
  }
  const bytes = readFileSync(binary)
  const expected = runtimeStamp(target, bytes)
  for (const field of ["version", "target", "archiveSha256"]) {
    if (stamp[field] !== expected[field]) {
      return `the runtime was prepared as ${field} ${stamp[field]}, this build pins ${expected[field]}`
    }
  }
  if (stamp.binarySha256 !== expected.binarySha256) {
    return `the runtime at ${binary} changed since it was prepared`
  }
  try {
    verifyExecutableTarget(bytes, target, `The runtime at ${binary}`)
  } catch (error) {
    return error.message
  }
  return null
}

/** Whether this machine can execute a `target` binary, so smoke-test it. */
export function canRunOnHost(target, hostPlatform = process.platform, hostArch = process.arch) {
  return target.platform === hostPlatform && target.arch === hostArch
}

function runtimeVersion(binary) {
  return execaSync(binary, ["--version"]).stdout.trim()
}

function smokeTest(binary, target) {
  if (!canRunOnHost(target)) return
  const version = runtimeVersion(binary)
  if (version !== `v${PLUGIN_NODE_VERSION}`) {
    throw new Error(`Prepared plugin Node runtime reports ${version}, not v${PLUGIN_NODE_VERSION}`)
  }
}

export async function preparePluginNode({ check = false, target = pluginNodeTarget() } = {}) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
  const destination = join(root, "src-tauri", "resources", "plugin-node")
  const executableName = target.platform === "win32" ? "node.exe" : "node"
  const binary = join(destination, "bin", executableName)
  const stampPath = join(destination, STAMP_FILE)
  const problem = cachedRuntimeProblem({ binary, stampPath, target })
  if (!problem) {
    smokeTest(binary, target)
    return binary
  }
  if (check) {
    throw new Error(`Verified plugin Node v${PLUGIN_NODE_VERSION} runtime is not ready: ${problem}`)
  }

  const archive = archiveFor(target.platform, target.arch)
  const work = mkdtempSync(join(tmpdir(), "cognia-plugin-node-"))
  try {
    const response = await fetch(`https://nodejs.org/dist/v${PLUGIN_NODE_VERSION}/${archive.file}`)
    if (!response.ok) {
      throw new Error(`Plugin Node download failed: HTTP ${response.status}`)
    }
    const bytes = Buffer.from(await response.arrayBuffer())
    verifyArchive(bytes, archive.sha256)
    const archivePath = join(work, archive.file)
    writeFileSync(archivePath, bytes)
    const extracted = execaSync("tar", ["-xf", archivePath, "-C", work], {
      all: true,
      reject: false,
    })
    if (extracted.exitCode !== 0 || extracted.signal) {
      throw new Error(`Plugin Node extraction failed: ${extracted.all}`)
    }

    const sourceRoot = join(work, basename(archive.file).replace(/\.(?:tar\.xz|zip)$/, ""))
    const sourceBinary = join(sourceRoot, executableName === "node.exe" ? "node.exe" : "bin/node")
    const binaryBytes = readFileSync(sourceBinary)
    verifyExecutableTarget(binaryBytes, target, `The Node binary in ${archive.file}`)
    const staging = join(dirname(destination), `.plugin-node-${process.pid}`)
    rmSync(staging, { recursive: true, force: true })
    mkdirSync(join(staging, "bin"), { recursive: true })
    copyFileSync(sourceBinary, join(staging, "bin", executableName))
    copyFileSync(join(sourceRoot, "LICENSE"), join(staging, "LICENSE"))
    if (target.platform !== "win32") {
      chmodSync(join(staging, "bin", executableName), 0o755)
    }
    writeFileSync(
      join(staging, STAMP_FILE),
      `${JSON.stringify(runtimeStamp(target, binaryBytes), null, 2)}\n`
    )
    rmSync(destination, { recursive: true, force: true })
    renameSync(staging, destination)
    smokeTest(binary, target)
    return binary
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

const cliSchema = z.object({ check: z.boolean().default(false) })

function createProgram() {
  return new Command()
    .name("pnpm plugin-node:prepare")
    .description("Prepare or verify Cognia's pinned plugin Node.js runtime.")
    .configureOutput({ writeErr: () => {} })
    .showHelpAfterError()
    .exitOverride()
    .option("--check", "Verify the pinned runtime without downloading it.")
}

export function parseArgs(argv) {
  const program = createProgram()
  try {
    program.parse(argv, { from: "user" })
  } catch (error) {
    if (error instanceof CommanderError && error.code === "commander.helpDisplayed") return null
    throw error
  }
  return cliSchema.parse(program.opts())
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const options = parseArgs(process.argv.slice(2))
  if (options) await preparePluginNode(options)
}

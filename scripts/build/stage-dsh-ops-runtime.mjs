/** Build the pinned, workspace-bound dsh-ops reader before packaging; never at runtime. */
import { randomUUID } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { spawnSync } from "node:child_process"
import { cargoBuildEnvironment, parseRustHost } from "./build-terminal-host-sidecar.mjs"
import { sha256 } from "./source-fingerprint.mjs"

export const OPS_SOURCE_REVISION = "fc11890f7668c9912fcde1df1ca89810e1cbc031"
export const OPS_SOURCE_SHA256 = "5ea69c53e94f07e9c15ea387fc7c5ce216cdd8a4290a2ae1b6fb06bee7978de4"
export const OPS_PATCH_VERSION = 1
const rootDefault = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")

export function opsPlatform(target) {
  if (!/^[a-zA-Z0-9_]+(?:-[a-zA-Z0-9_]+)+$/.test(target)) return undefined
  const arch = target.startsWith("aarch64-") ? "arm64" : target.startsWith("x86_64-") ? "x64" : undefined
  const platform = target.includes("-apple-darwin") ? "darwin" : target.includes("-linux-") ? "linux" : undefined
  return arch && platform ? `${platform}-${arch}` : undefined
}

/** Synchronize authenticated source bytes while preserving Cargo freshness. */
export function syncVerifiedSource(source, destination) {
  if (fs.existsSync(destination) && fs.lstatSync(destination).isSymbolicLink())
    throw new Error("dsh-ops build source must not be a symlink")
  fs.mkdirSync(destination, { recursive: true })
  const names = fs.readdirSync(source)
  for (const stale of fs.readdirSync(destination).filter(name => !names.includes(name)))
    fs.rmSync(path.join(destination, stale), { recursive: true, force: true })
  for (const name of names) {
    const from = path.join(source, name)
    const to = path.join(destination, name)
    const stat = fs.lstatSync(from)
    if (stat.isDirectory()) syncVerifiedSource(from, to)
    else if (stat.isFile()) {
      if (fs.existsSync(to) && fs.lstatSync(to).isSymbolicLink())
        throw new Error("dsh-ops build source must not be a symlink")
      const bytes = fs.readFileSync(from)
      if (!fs.existsSync(to) || !bytes.equals(fs.readFileSync(to))) fs.writeFileSync(to, bytes, { mode: stat.mode })
    } else throw new Error("dsh-ops source archive contains an unsupported file")
  }
}

/** Keep upstream no-follow traversal, starting at the authorized cwd rather than '/'. */
export function patchOpsPaths(source) {
  const start = source.indexOf("    let mut anchor = PathBuf::new(); let mut names = Vec::new();")
  const end = source.indexOf("    let mut parent = Dir::open_ambient_dir", start)
  if (start < 0 || end < start) throw new Error("Pinned dsh-ops path implementation changed")
  return source.slice(0, start) + `    let anchor = std::env::current_dir()?;
    let relative = path.strip_prefix(&anchor)
        .map_err(|_| Failure::new("PATH_RESTRICTED", "Path is outside the managed workspace"))?;
    let mut names = Vec::new();
    for component in relative.components() {
        match component {
            Component::Normal(name) => {
                let name = name.to_str().ok_or_else(|| Failure::new("INVALID_ARGUMENT", "Non-UTF8 path"))?;
                validate_name(name)?; names.push(name.to_owned());
            }
            _ => return Err(Failure::new("INVALID_ARGUMENT", "Worker paths must be lexically normalized")),
        }
    }
` + source.slice(end).replace("Dir::open_ambient_dir(&anchor, ambient_authority())", 'Dir::open_ambient_dir(".", ambient_authority())')
}

export function patchOpsCredentials(source) {
  const needle = String.raw`|\.env(\.|$))`
  if (!source.includes(needle)) throw new Error("Pinned dsh-ops credential policy changed")
  // Full path components, at any depth; applied by native recursion before reads.
  return source.replace(needle, String.raw`|\.env(\.|$)|(?:\.ssh|\.aws|\.azure|\.kube|\.npmrc|\.pypirc|\.netrc|_netrc|\.git-credentials|\.docker/config\.json|\.config/gcloud|\.dsh/\.credentials\.ya?ml)(/|$))`)
}

export function patchOpsReader(source) {
  const needle = "        let mut decoded = envelope::decode(&bytes)?;"
  if (!source.includes(needle)) throw new Error("Pinned dsh-ops worker protocol changed")
  return source.replace(needle, needle + `
        if !decoded.request.read_only || decoded.request.storage.is_some()
            || !matches!(decoded.request.tool.as_str(), "inspect_local_file" | "read_files" | "read_table" | "read_docx" | "read_pdf" | "glob" | "grep" | "diff" | "stat") {
            return Err(Failure::new("POLICY_DENIED", "Cognia's worker accepts fixed read-only operations without storage only"));
        }`)
}

export function stageDshOpsRuntime({ root = rootDefault, target = process.env.TAURI_ENV_TARGET_TRIPLE ?? process.env.CARGO_BUILD_TARGET, optional = false, run = spawnSync } = {}) {
  const exec = (command, args, options = {}) => {
    const result = run(command, args, { cwd: root, encoding: "utf8", ...options })
    if (result.status !== 0) throw new Error(`dsh-ops build failed: ${command}: ${result.stderr || result.error || result.status}`)
    return result.stdout
  }
  if (!target) {
    const rustc = run("rustc", ["-vV"], { cwd: root, encoding: "utf8" })
    if (rustc.status !== 0 && optional) return { supported: false, reason: "Rust toolchain unavailable" }
    if (rustc.status !== 0) throw new Error("dsh-ops native packaging requires Rust")
    target = parseRustHost(rustc.stdout)
  }
  const platform = opsPlatform(target)
  if (!platform) return { supported: false, target }
  const cache = path.join(root, ".cache", "dsh-ops-runtime", target)
  fs.mkdirSync(cache, { recursive: true })
  const lock = path.join(cache, "building")
  fs.mkdirSync(lock) // One owner; never mix parallel source/executable/receipt generations.
  try {
    const archive = path.join(cache, "source.tgz")
    if (!fs.existsSync(archive)) {
      const temporary = `${archive}.${randomUUID()}`
      try {
        exec("curl", ["--fail", "--location", "--proto", "=https", "--tlsv1.2", "--output", temporary,
          `https://codeload.github.com/T-Auto/dsh-ops/tar.gz/${OPS_SOURCE_REVISION}`])
        if (sha256(fs.readFileSync(temporary)) !== OPS_SOURCE_SHA256) throw new Error("dsh-ops source integrity mismatch")
        fs.renameSync(temporary, archive)
      } finally { fs.rmSync(temporary, { force: true }) }
    }
    if (sha256(fs.readFileSync(archive)) !== OPS_SOURCE_SHA256) throw new Error("dsh-ops source integrity mismatch")
    const source = path.join(cache, "source")
    const prepared = fs.mkdtempSync(path.join(cache, "prepared-"))
    try {
    exec("tar", ["-xzf", archive, "--strip-components=1", "-C", prepared,
      `dsh-ops-${OPS_SOURCE_REVISION}/native`, `dsh-ops-${OPS_SOURCE_REVISION}/LICENSE`])
    const paths = path.join(prepared, "native", "crates", "ops-files", "src", "file_path.rs")
    fs.writeFileSync(paths, patchOpsPaths(fs.readFileSync(paths, "utf8")))
    const reader = path.join(prepared, "native", "src", "main.rs")
    fs.writeFileSync(reader, patchOpsReader(fs.readFileSync(reader, "utf8")))
    const credentials = path.join(prepared, "native", "crates", "ops-protocol", "src", "lib.rs")
    fs.writeFileSync(credentials, patchOpsCredentials(fs.readFileSync(credentials, "utf8")))
    syncVerifiedSource(prepared, source)
    } finally { fs.rmSync(prepared, { recursive: true, force: true }) }
    const targetDir = path.join(cache, "target")
    exec("cargo", ["build", "--locked", "--release", "--target", target,
      "--manifest-path", path.join(source, "native", "Cargo.toml"), "--bin", "dsh-ops-worker"], {
      stdio: "inherit", env: { ...cargoBuildEnvironment(), CARGO_TARGET_DIR: targetDir },
    })
    const output = path.join(root, "packages", "agent-dsh", "runtime")
    const worker = fs.readFileSync(path.join(targetDir, target, "release", "dsh-ops-worker"))
    const receipt = { schemaVersion: 1, version: "0.4.4", target: platform, sourceRevision: OPS_SOURCE_REVISION,
      cogniaPatchVersion: OPS_PATCH_VERSION, sha256: sha256(worker) }
    for (const [name, bytes] of [["ops-worker", worker], ["ops-worker.json", JSON.stringify(receipt, null, 2) + "\n"],
      ["ops-worker.LICENSE", fs.readFileSync(path.join(source, "LICENSE"))]]) {
      const published = name.replace("ops-worker", `ops-worker-${platform}`)
      const temporary = path.join(output, `${published}.${randomUUID()}`)
      fs.writeFileSync(temporary, bytes, { mode: name === "ops-worker" ? 0o755 : 0o644, flag: "wx" })
      fs.renameSync(temporary, path.join(output, published))
    }
    return { supported: true, target, receipt }
  } finally { fs.rmdirSync(lock) }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = stageDshOpsRuntime()
  console.log(`dsh-ops reader: ${result.supported ? "prepared" : "unsupported"} (${result.target})`)
}

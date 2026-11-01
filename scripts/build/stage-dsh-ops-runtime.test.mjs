import assert from "node:assert/strict"
import { test } from "node:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { opsPlatform, patchOpsPaths, patchOpsReader, patchOpsCredentials, stageDshOpsRuntime, syncVerifiedSource } from "./stage-dsh-ops-runtime.mjs"

test("only Cognia's supported native target families are built", () => {
  assert.equal(opsPlatform("aarch64-apple-darwin"), "darwin-arm64")
  assert.equal(opsPlatform("x86_64-unknown-linux-gnu"), "linux-x64")
  assert.equal(opsPlatform("aarch64-unknown-linux-gnu"), "linux-arm64")
  assert.equal(stageDshOpsRuntime({ target: "x86_64-pc-windows-msvc" }).supported, false)
  assert.equal(opsPlatform("x86_64-unknown-linux-gnu/../../elsewhere"), undefined)
})

test("verified source refresh preserves unchanged mtimes and removes stale files", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cognia-ops-source-sync-"))
  try {
    const source = path.join(root, "source"), destination = path.join(root, "destination")
    fs.mkdirSync(source); fs.mkdirSync(destination)
    fs.writeFileSync(path.join(source, "same.rs"), "same")
    fs.writeFileSync(path.join(destination, "same.rs"), "same")
    fs.utimesSync(path.join(destination, "same.rs"), 1000, 1000)
    fs.writeFileSync(path.join(destination, "stale.rs"), "stale")
    syncVerifiedSource(source, destination)
    assert.equal(fs.statSync(path.join(destination, "same.rs")).mtimeMs, 1000000)
    assert.ok(!fs.existsSync(path.join(destination, "stale.rs")))
    fs.writeFileSync(path.join(source, "same.rs"), "changed")
    syncVerifiedSource(source, destination)
    assert.equal(fs.readFileSync(path.join(destination, "same.rs"), "utf8"), "changed")
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test("browser-only development may omit Rust while native packaging fails closed", () => {
  const missing = () => ({ status: null, error: new Error("ENOENT") })
  assert.equal(stageDshOpsRuntime({ optional: true, run: missing }).supported, false)
  assert.throws(() => stageDshOpsRuntime({ run: missing }), /requires Rust/)
})

test("the root patch retains no-follow opens and refuses outside-workspace paths", () => {
  const source = "prefix\n    let mut anchor = PathBuf::new(); let mut names = Vec::new();\nold root traversal\n    let mut parent = Dir::open_ambient_dir(&anchor, ambient_authority())?;\nparent.open_dir_nofollow(&component)?;\nsuffix"
  const patched = patchOpsPaths(source)
  assert.ok(patched.startsWith("prefix\n"))
  assert.ok(patched.endsWith("\nsuffix"))
  assert.match(patched, /path.strip_prefix\(&anchor\)/)
  assert.match(patched, /PATH_RESTRICTED/)
  assert.match(patched, /parent.open_dir_nofollow/)
  assert.match(patched, /Dir::open_ambient_dir\("\."/)
  assert.doesNotMatch(patched, /open_ambient_dir\(&anchor/)
  assert.doesNotMatch(patched, /old root traversal/)
  assert.throws(() => patchOpsPaths("unknown source"), /implementation changed/)
})

test("recursive native scans reject nested multi-component credential stores", () => {
  const patched = patchOpsCredentials(String.raw`original|\.env(\.|$))`)
  assert.match(patched, /gcloud/)
  assert.match(patched, /docker/)
  assert.throws(() => patchOpsCredentials("unknown source"), /policy changed/)
})

test("the native protocol refuses mutations, storage and tools outside the reader surface", () => {
  const patched = patchOpsReader("        let mut decoded = envelope::decode(&bytes)?;")
  assert.match(patched, /!decoded.request.read_only/)
  assert.match(patched, /decoded.request.storage.is_some/)
  assert.match(patched, /POLICY_DENIED/)
  assert.throws(() => patchOpsReader("unknown source"), /protocol changed/)
})

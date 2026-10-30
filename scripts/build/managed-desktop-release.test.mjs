import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { test } from "node:test"

import {
  PINNED_RELEASE_DIR,
  RELEASE_FILE,
  SOURCE_FILE,
  SOURCE_INPUTS,
  checkPinnedRelease,
  computeSourceDigest,
  createManagedDesktopRelease,
  parseArgs,
  pinRelease,
  validateRelease,
  verifyImageSources,
  writeRelease,
} from "./managed-desktop-release.mjs"

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
const IMAGE_CONTEXT = "crates/cognia-automation/src/cua_sandbox/image"
const digest = `sha256:${"a".repeat(64)}`
const imageRepository = "ghcr.io/cognia-test/cognia-managed-desktop"

test("release uses the published immutable digest and contains no runtime token", () => {
  const release = createManagedDesktopRelease({ imageRepository, digest })
  assert.equal(release.image, `${imageRepository}@${digest}`)
  assert.equal(release.imageDigest, digest)
  assert.equal(release.architecture, "linux/amd64")
  assert.equal(release.recipeRevision, "8")
  assert.equal(release.protocol, "computer-server-0.3.46")
  assert.equal(release.serverVersion, "0.3.46")
  assert.equal(release.startCommand, "sleep infinity")
  assert.match(release.readyCommand, /test -x \/usr\/local\/bin\/cognia-desktop/)
  assert.match(release.readyCommand, /test -x \/usr\/bin\/xclip/)
  assert.throws(() => validateRelease({ ...release, recipeRevision: "7" }), /release identity/)
  assert.equal(Object.keys(release).length, 8, "Host release loader rejects unknown fields")
  assert.doesNotMatch(JSON.stringify(release), /TOKEN|secret|latest/)
})

test("unpublished tags, malformed digests and repository substitutions refuse", () => {
  for (const invalid of [
    undefined,
    "",
    "latest",
    "sha256:abc",
    `sha256:${"A".repeat(64)}`,
    `${digest}\n`,
  ]) {
    assert.throws(() => createManagedDesktopRelease({ imageRepository, digest: invalid }))
  }
  for (const invalid of [
    undefined,
    "ghcr.io/Owner/cognia-managed-desktop",
    `${imageRepository}:latest`,
    `${imageRepository}@${digest}`,
    "https://ghcr.io/owner/cognia-managed-desktop",
    "ghcr.io/owner/other-image",
    "ghcr.io/a/../cognia-managed-desktop",
  ]) {
    assert.throws(() => createManagedDesktopRelease({ imageRepository: invalid, digest }))
  }
})

test("the actual pinned image and guest health agree with the release manifest", () => {
  verifyImageSources(ROOT)
  const host = readFileSync(
    resolve(ROOT, "crates/cognia-companion-rpc/src/managed_desktop_release.rs"),
    "utf8"
  )
  const release = createManagedDesktopRelease({ imageRepository, digest })
  assert.ok(host.includes(`pub const RECIPE: &str = "${release.recipeRevision}";`))
  assert.ok(host.includes(`pub const PROTOCOL: &str = "${release.protocol}";`))
})

test("recipe drift and mutable base prevent publication of a stale manifest", () => {
  const root = mkdtempSync(join(tmpdir(), "desktop-recipe-"))
  const context = resolve(root, IMAGE_CONTEXT)
  mkdirSync(context, { recursive: true })
  const dockerfile = readFileSync(resolve(ROOT, IMAGE_CONTEXT, "Dockerfile"), "utf8")
  const server = readFileSync(resolve(ROOT, IMAGE_CONTEXT, "server.py"), "utf8")
  try {
    writeFileSync(join(context, "server.py"), server)
    writeFileSync(
      join(context, "Dockerfile"),
      dockerfile.replace('cognia.cua.recipe="8"', 'cognia.cua.recipe="7"')
    )
    assert.throws(() => verifyImageSources(root), /identity/)
    writeFileSync(join(context, "Dockerfile"), dockerfile.replace(/@sha256:[0-9a-f]{64}/, ""))
    assert.throws(() => verifyImageSources(root), /digest pinned/)
    writeFileSync(join(context, "Dockerfile"), dockerfile.replace("test -x /usr/bin/xclip", "test -x /usr/bin/true"))
    assert.throws(() => verifyImageSources(root), /clipboard tool/)
    writeFileSync(join(context, "Dockerfile"), dockerfile)
    writeFileSync(
      join(context, "server.py"),
      server.replace('"recipeRevision": "8"', '"recipeRevision": "7"')
    )
    assert.throws(() => verifyImageSources(root), /health identity/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("CLI rejects missing, duplicate and unknown arguments before writing", () => {
  for (const args of [
    [],
    ["--image", imageRepository],
    ["--image", imageRepository, "--image", imageRepository],
    ["--image", "--digest"],
    ["--unknown", "x"],
  ]) {
    assert.throws(() => parseArgs(args))
  }
})

test("CLI writes the complete manifest and a rejected replacement keeps it intact", () => {
  const root = mkdtempSync(join(tmpdir(), "desktop-release-"))
  try {
    const output = join(root, "managed-desktop-release.json")
    const args = ["--image", imageRepository, "--digest", digest, "--output", output]
    const result = spawnSync(
      process.execPath,
      [resolve(ROOT, "scripts/build/managed-desktop-release.mjs"), ...args],
      { encoding: "utf8" }
    )
    assert.equal(result.status, 0, result.stderr)
    const bytes = readFileSync(output, "utf8")
    assert.deepEqual(JSON.parse(bytes), createManagedDesktopRelease({ imageRepository, digest }))
    assert.throws(() =>
      writeRelease(["--image", imageRepository, "--digest", "latest", "--output", output])
    )
    assert.equal(readFileSync(output, "utf8"), bytes)
    assert.deepEqual(readdirSync(root).sort(), [RELEASE_FILE, SOURCE_FILE])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("existing Images publication gate owns the release artifact and amd64 build", () => {
  const workflow = readFileSync(resolve(ROOT, ".github/workflows/images.yml"), "utf8")
  const job = workflow.split("  managed-desktop-image:\n")[1]?.split("\n  # ADR-0183:")[0]
  assert.ok(job, "managed desktop must be wired into Images")
  assert.match(job, /platforms: linux\/amd64/)
  assert.match(job, /context: \$\{\{ runner.temp \}\}\/managed-desktop-image/)
  assert.match(job, /cargo build --locked --release -p cognia-desktop-guest/)
  assert.match(job, /cargo test --locked -p cognia-desktop-guest/)
  assert.match(job, /managed-desktop-context\.mjs/)
  assert.match(job, /push: \$\{\{ needs.vars.outputs.should_push == 'true' \}\}/)
  assert.match(job, /DIGEST: \$\{\{ steps.build.outputs.digest \}\}/)
  assert.match(job, /name: managed-desktop-release\n/)
  assert.match(job, /if-no-files-found: error/)
  assert.equal(
    (job.match(/if: needs.vars.outputs.should_push == 'true'/g) ?? []).length,
    3,
    "login, manifest and artifact require the existing publish gate"
  )
})

/** A throwaway git root holding just the inputs the digest and checks read. */
function fakeRoot() {
  const root = mkdtempSync(join(tmpdir(), "managed-desktop-pin-"))
  const copy = (path) => {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), readFileSync(resolve(ROOT, path)))
  }
  for (const input of SOURCE_INPUTS.filter((path) => !path.startsWith("crates/cognia-desktop-guest") && !path.startsWith("crates/cognia-exec-sandbox"))) {
    copy(input)
  }
  for (const crate of ["cognia-desktop-guest", "cognia-exec-sandbox"]) {
    mkdirSync(join(root, "crates", crate, "src"), { recursive: true })
    writeFileSync(join(root, "crates", crate, "src", "lib.rs"), `// ${crate}\n`)
  }
  writeFileSync(join(root, "untracked-note.txt"), "never part of the digest\n")
  const git = (...args) => spawnSync("git", ["-C", root, ...args], { encoding: "utf8" })
  git("init", "-q")
  git("add", "--", ...SOURCE_INPUTS)
  return root
}

function publish(root, artifact) {
  writeRelease(["--image", imageRepository, "--digest", digest, "--output", join(artifact, RELEASE_FILE)], root)
}

test("the source digest covers tracked guest inputs only and moves with any of them", () => {
  const root = fakeRoot()
  try {
    const first = computeSourceDigest(root)
    assert.match(first.sourceDigest, /^sha256:[0-9a-f]{64}$/)
    assert.equal(first.files, 8)
    writeFileSync(join(root, "untracked-note.txt"), "changed\n")
    assert.deepEqual(computeSourceDigest(root), first)
    writeFileSync(join(root, "crates/cognia-desktop-guest/src/lib.rs"), "// changed guest\n")
    assert.notEqual(computeSourceDigest(root).sourceDigest, first.sourceDigest)
    // The existing crate input covers recipe-8's new module once tracked;
    // no parallel allowlist of individual guest source files is needed.
    const operations = "crates/cognia-desktop-guest/src/operations.rs"
    writeFileSync(join(root, operations), "// operation policy\n")
    assert.equal(spawnSync("git", ["-C", root, "add", "--", operations]).status, 0)
    const added = computeSourceDigest(root)
    assert.equal(added.files, first.files + 1)
    writeFileSync(join(root, operations), "// revised operation policy\n")
    assert.notEqual(computeSourceDigest(root).sourceDigest, added.sourceDigest)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("a published release pins only onto the sources it was built from", () => {
  const root = fakeRoot()
  const artifact = mkdtempSync(join(tmpdir(), "managed-desktop-artifact-"))
  try {
    assert.deepEqual(checkPinnedRelease(root), { state: "absent" })
    publish(root, artifact)
    const source = JSON.parse(readFileSync(join(artifact, SOURCE_FILE), "utf8"))
    assert.equal(source.imageDigest, digest)
    assert.equal(source.recipeRevision, "8")
    const pinned = pinRelease(artifact, root)
    assert.equal(pinned.imageDigest, digest)
    assert.equal(checkPinnedRelease(root).state, "pinned")
    // Guest code changed after publication: the gate refuses the stale pin.
    writeFileSync(join(root, "crates/cognia-exec-sandbox/src/lib.rs"), "// new confinement\n")
    assert.throws(() => checkPinnedRelease(root), /changed since sha256:a{64} was published/)
    // And an artifact built before the change cannot be pinned onto it.
    assert.throws(() => pinRelease(artifact, root), /publish the managed desktop image again/)
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(artifact, { recursive: true, force: true })
  }
})

test("a half pin, a tampered manifest or a foreign identity is refused", () => {
  const root = fakeRoot()
  const artifact = mkdtempSync(join(tmpdir(), "managed-desktop-artifact-"))
  try {
    publish(root, artifact)
    pinRelease(artifact, root)
    const pinnedDir = join(root, PINNED_RELEASE_DIR)
    const release = JSON.parse(readFileSync(join(pinnedDir, RELEASE_FILE), "utf8"))
    rmSync(join(pinnedDir, SOURCE_FILE))
    assert.throws(() => checkPinnedRelease(root), /together/)
    pinRelease(artifact, root)
    writeFileSync(join(pinnedDir, RELEASE_FILE), JSON.stringify({ ...release, recipeRevision: "6" }))
    assert.throws(() => checkPinnedRelease(root), /release identity/)
    assert.throws(() => validateRelease({ ...release, image: "ghcr.io/cognia-test/cognia-managed-desktop:latest" }))
    assert.throws(() => validateRelease({ ...release, extra: true }), /release identity/)
    assert.deepEqual(validateRelease(release), release)
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(artifact, { recursive: true, force: true })
  }
})

test("signed builds and the server image carry the pinned release directory", () => {
  const tauri = JSON.parse(readFileSync(resolve(ROOT, "src-tauri/tauri.conf.json"), "utf8"))
  assert.ok(tauri.bundle.resources.includes(`${PINNED_RELEASE_DIR.replace("src-tauri/", "")}/*`))
  const dockerfile = readFileSync(resolve(ROOT, "deploy/docker/Dockerfile.cognia-server"), "utf8")
  assert.match(
    dockerfile,
    new RegExp(`COPY ${PINNED_RELEASE_DIR}/ /usr/share/cognia/managed-desktop/`)
  )
  const server = readFileSync(resolve(ROOT, "crates/cognia-server/src/main.rs"), "utf8")
  assert.match(server, /MANAGED_DESKTOP_RELEASE_DIR: &str = "\/usr\/share\/cognia\/managed-desktop"/)
  const startup = readFileSync(resolve(ROOT, "src-tauri/src/startup/services.rs"), "utf8")
  assert.match(startup, new RegExp(`"${PINNED_RELEASE_DIR.replace("src-tauri/", "")}"`))
})

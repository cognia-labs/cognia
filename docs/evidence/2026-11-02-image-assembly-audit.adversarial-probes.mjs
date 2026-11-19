// Reproduce audit counterexamples, not product-health assertions.
// Run: node --test docs/evidence/2026-11-02-image-assembly-audit.adversarial-probes.mjs
// All mutations are in memory or disposable .cache fixtures. No container,
// registry operation, vendor installer, or shared Git-state mutation is run.
import assert from "node:assert/strict"
import { execFileSync, spawn, spawnSync } from "node:child_process"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { dirname, join, matchesGlob, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { test } from "node:test"
import { build } from "esbuild"
import { parse } from "yaml"

import {
  prepareBundle,
  readRepoInputs,
  validatePins,
} from "../../scripts/build/bundle-agent-versions.mjs"
import { createWebcloneBundlePlugin } from "../../scripts/build/lib/webclone-bundle-plugin.mjs"
import {
  SOURCE_INPUTS,
  checkPinnedRelease,
  computeSourceDigest,
  pinRelease,
  writeRelease,
} from "../../scripts/build/managed-desktop-release.mjs"
import {
  LAYOUT_BUILD_SCRIPTS,
  checkRuntimeStage,
  envAssignments,
  runChecks,
  stageText,
} from "../../scripts/gates/check-agent-host-image.mjs"
import {
  COMPOSE_FILES_WITH_IMAGES,
  checkComposeImagesPublished,
} from "../../scripts/gates/check-deploy-suite.mjs"

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
const CACHE = join(ROOT, ".cache/image-assembly-audit/2026-11-10-adversarial")
const read = (path) => readFileSync(join(ROOT, path), "utf8")
const workflow = read(".github/workflows/images.yml")
const dockerfile = read("deploy/docker/Dockerfile.cognia-server")
mkdirSync(CACHE, { recursive: true })

function fixture(callback) {
  const directory = mkdtempSync(join(CACHE, "probe-"))
  try {
    return callback(directory)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

async function asyncFixture(callback) {
  const directory = mkdtempSync(join(CACHE, "bundle-"))
  try {
    return await callback(directory)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

test("F1: the master inventory fails closed before selecting Codex", () => {
  const inputs = readRepoInputs(ROOT)
  const problems = validatePins(inputs)
  assert.equal(problems.length, 18)
  assert(problems.every((problem) => problem.includes("neither bundled nor marked unavailable")))
  fixture((out) => {
    assert.throws(
      () => prepareBundle(inputs, { runtimes: "codex-acp,codex-app-server", out }),
      /invalid master bundle pins/
    )
  })
  // Control: the pin validator responds to accounting for the omitted IDs.
  const accounted = structuredClone(inputs)
  for (const problem of problems) {
    accounted.pins.runtimes.push({ id: problem.split(" ")[0], unavailable: "Audit control only" })
  }
  assert.deepEqual(validatePins(accounted), [])
})

test("F2/F5: core image namespace substitutions escape the deploy gate", () => {
  const composeFiles = Object.fromEntries(
    COMPOSE_FILES_WITH_IMAGES.map((path) => [path, read(path)])
  )
  assert(Object.values(composeFiles).some((text) => text.includes("ghcr.io/maxqian888/")))
  assert.deepEqual(checkComposeImagesPublished({ composeFiles, imagesWorkflow: workflow }), [])
  const substituted = Object.fromEntries(
    Object.entries(composeFiles).map(([path, text]) => [
      path,
      text.replaceAll("ghcr.io/maxqian888/", "ghcr.io/not-the-publisher/"),
    ])
  )
  assert.deepEqual(
    checkComposeImagesPublished({ composeFiles: substituted, imagesWorkflow: workflow }),
    []
  )
  // Control: changing the image name, unlike its owner, is detected.
  const wrongName = {
    probe:
      "services:\n  server:\n    image: ghcr.io/not-the-publisher/not-a-published-image:latest\n",
  }
  assert(
    checkComposeImagesPublished({ composeFiles: wrongName, imagesWorkflow: workflow }).length > 0
  )
})

test("F4: six existing direct build inputs are absent from the Images PR filter", () => {
  const paths = parse(workflow).on.pull_request.paths
  for (const input of [
    "vendor/liteparse/src/lib.rs",
    "packages/agent-codex/catalog-data/codex-catalog.json",
    "package.json",
    "pnpm-lock.yaml",
    "scripts/build/build-cli-binary.mjs",
    "lib/browser/automation-core.injected.js",
  ]) {
    assert(existsSync(join(ROOT, input)), input)
    assert.deepEqual(
      paths.filter((glob) => matchesGlob(input, glob)),
      [],
      input
    )
  }
  assert(paths.some((glob) => matchesGlob("deploy/docker/Dockerfile.cognia-server", glob)))
})

test("F5: Full's effective USER and ENV can regress without runChecks noticing", () => {
  const sources = Object.fromEntries(LAYOUT_BUILD_SCRIPTS.map((path) => [path, read(path)]))
  assert.deepEqual(runChecks({ dockerfile, sources }), [])
  const marker = dockerfile.indexOf("FROM runtime-slim AS runtime-full")
  assert(marker > 0)
  const full = dockerfile
    .slice(marker)
    .replace(/USER 10001:10001\s*$/, "USER root\nENV NODE_ENV=development\n")
  assert(full.endsWith("ENV NODE_ENV=development\n"))
  const changed = dockerfile.slice(0, marker) + full
  assert.deepEqual(runChecks({ dockerfile: changed, sources }), [])
  const explicit = checkRuntimeStage(changed, "runtime-full")
  assert(explicit.some((problem) => problem.includes("NODE_ENV")))
  assert(!explicit.some((problem) => problem.includes("does not run as uid")))
  // Control: the same ENV regression in Slim is detected by the actual entry.
  const changedSlim = dockerfile.replace(/^ENV NODE_ENV=production/m, "ENV NODE_ENV=development")
  assert.notEqual(changedSlim, dockerfile)
  assert(
    runChecks({ dockerfile: changedSlim, sources }).some((problem) => problem.includes("NODE_ENV"))
  )
})

test("F6: the inherited install home disagrees with the global Cursor link", () => {
  assert.equal(envAssignments(stageText(dockerfile, "runtime-full")).get("HOME"), "/data")
  assert.match(
    read("deploy/runner/install-agents.sh"),
    /ln -sf \/root\/\.local\/bin\/cursor-agent \/usr\/local\/bin\/cursor-agent/
  )
  fixture((directory) => {
    const home = join(directory, "home")
    const payload = join(home, ".local/share/cursor-agent/versions/fixture/cursor-agent")
    mkdirSync(dirname(payload), { recursive: true })
    writeFileSync(payload, "#!/bin/sh\nexit 0\n", { mode: 0o755 })
    mkdirSync(join(home, ".local/bin"), { recursive: true })
    symlinkSync(payload, join(home, ".local/bin/cursor-agent"))
    const global = join(directory, "global-cursor-agent")
    symlinkSync("/root/.local/bin/cursor-agent", global)
    assert(existsSync(join(home, ".local/bin/cursor-agent")))
    assert.equal(readlinkSync(global), "/root/.local/bin/cursor-agent")
    assert.notEqual(readlinkSync(global), join(home, ".local/bin/cursor-agent"))
    // This fixture models a successful HOME-respecting installation; it does
    // not execute the current vendor installer or certify the final image.
  })
})

test("new gap: managed guest source pin ignores tracked build manifests, lock and toolchain", () => {
  fixture((directory) => {
    const root = join(directory, "repository")
    mkdirSync(root)
    const put = (path, text) => {
      mkdirSync(dirname(join(root, path)), { recursive: true })
      writeFileSync(join(root, path), text)
    }
    for (const input of SOURCE_INPUTS.filter(
      (path) =>
        !path.startsWith("crates/cognia-desktop-guest") &&
        !path.startsWith("crates/cognia-exec-sandbox")
    )) {
      put(input, read(input))
    }
    for (const crate of ["cognia-desktop-guest", "cognia-exec-sandbox"]) {
      put(`crates/${crate}/src/lib.rs`, `// ${crate} source fixture\n`)
    }
    for (const input of ["Cargo.toml", "Cargo.lock", "rust-toolchain.toml"]) put(input, read(input))
    const git = (...args) => execFileSync("git", ["-C", root, ...args], { stdio: "pipe" })
    git("init", "-q")
    git("add", "--", ...SOURCE_INPUTS, "Cargo.toml", "Cargo.lock", "rust-toolchain.toml")
    const artifact = join(directory, "artifact")
    writeRelease(
      [
        "--image",
        "ghcr.io/audit-fixture/cognia-managed-desktop",
        "--digest",
        `sha256:${"a".repeat(64)}`,
        "--output",
        join(artifact, "managed-desktop-release.json"),
      ],
      root
    )
    pinRelease(artifact, root)
    assert.equal(checkPinnedRelease(root).state, "pinned")
    const before = computeSourceDigest(root)
    const manifest = readFileSync(join(root, "Cargo.toml"), "utf8")
    const changedManifest = manifest.replace('uuid = { version = "1" }', 'uuid = { version = "2" }')
    assert.notEqual(changedManifest, manifest)
    put("Cargo.toml", changedManifest)
    put("Cargo.lock", 'version = 4\n[[package]]\nname = "uuid"\nversion = "2.0.0"\n')
    put("rust-toolchain.toml", '[toolchain]\nchannel = "nightly"\n')
    assert.deepEqual(computeSourceDigest(root), before)
    assert.equal(checkPinnedRelease(root).state, "pinned")
    // Control: touching an included guest source does invalidate the pin.
    put("crates/cognia-desktop-guest/src/lib.rs", "// changed guard source\n")
    assert.throws(() => checkPinnedRelease(root), /sources changed/)
  })
})

test("new gap: bundled Code supervisor requires an unstaged child entry", async () => {
  await asyncFixture(async (directory) => {
    const source = join(ROOT, "sidecar/src/tools/builtin/run-code/supervisor.ts")
    const outfile = join(directory, "root/app/brain/sidecar/claude-host.mjs")
    const result = await build({
      entryPoints: [source],
      outfile,
      metafile: true,
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node26",
      plugins: [
        {
          name: "expose-existing-child-path",
          setup(builder) {
            builder.onLoad({ filter: /run-code[\\/]supervisor\.ts$/ }, () => ({
              contents: readFileSync(source, "utf8") + "\nexport { CHILD_PATH };",
              loader: "ts",
              resolveDir: dirname(source),
            }))
          },
        },
      ],
    })
    const { CHILD_PATH } = await import(pathToFileURL(outfile).href)
    assert.equal(CHILD_PATH, join(dirname(outfile), "sandbox-child.ts"))
    assert(
      Object.keys(result.metafile.inputs).some((path) => path.endsWith("run-code/sandbox-child.ts"))
    )
    assert(!existsSync(CHILD_PATH))
    const missing = spawnSync(process.execPath, [CHILD_PATH], { encoding: "utf8", timeout: 3000 })
    assert.equal(missing.status, 1)
    assert.match(missing.stderr, /MODULE_NOT_FOUND/)
    // Control: the real child can send its IPC ready when staged separately.
    writeFileSync(CHILD_PATH, read("sidecar/src/tools/builtin/run-code/sandbox-child.ts"))
    const ready = await new Promise((resolveReady) => {
      const child = spawn(process.execPath, [CHILD_PATH], {
        env: { COGNIA_CODE_SANDBOX_CHILD: "1" },
        stdio: ["ignore", "ignore", "ignore", "ipc"],
      })
      const timer = setTimeout(() => {
        child.kill()
        resolveReady(false)
      }, 3000)
      child.once("message", (message) => {
        clearTimeout(timer)
        child.kill()
        resolveReady(message?.kind === "ready")
      })
      child.once("error", () => {
        clearTimeout(timer)
        resolveReady(false)
      })
    })
    assert.equal(ready, true)
  })
})

test(
  "new gap: bundled webclone runner path escapes the staged brain layout",
  {
    skip: !existsSync(join(ROOT, "sidecar/webclone/dist/runner.js")),
  },
  async () => {
    await asyncFixture(async (directory) => {
      const outfile = join(directory, "root/app/brain/sidecar/claude-host.mjs")
      const options = {
        bundle: true,
        platform: "node",
        format: "esm",
        target: "node26",
        banner: {
          js: 'import { createRequire as __cr } from "node:module"; const require = __cr(import.meta.url);',
        },
        plugins: [createWebcloneBundlePlugin({ root: ROOT })],
      }
      await build({
        ...options,
        entryPoints: [join(ROOT, "sidecar/src/tools/builtin/webclone/run.ts")],
        outfile,
      })
      const { RUNNER_PATH } = await import(pathToFileURL(outfile).href)
      assert(
        RUNNER_PATH.startsWith(directory + "/"),
        "all control writes must stay inside the fixture"
      )
      assert.equal(RUNNER_PATH, join(directory, "webclone/dist/runner.js"))
      assert.equal(
        new URL("../../../../webclone/dist/runner.js", "file:///app/brain/sidecar/claude-host.mjs")
          .pathname,
        "/webclone/dist/runner.js"
      )
      assert(!existsSync(RUNNER_PATH))
      const job = JSON.stringify({ mode: "snapshot", options: {} })
      const missing = spawnSync(process.execPath, [RUNNER_PATH], {
        input: job,
        encoding: "utf8",
        timeout: 3000,
      })
      assert.equal(missing.status, 1)
      assert.match(missing.stderr, /MODULE_NOT_FOUND/)
      // Control: invoke the real runner with an invalid job, so no network runs.
      await build({
        ...options,
        entryPoints: [join(ROOT, "sidecar/webclone/dist/runner.js")],
        outfile: RUNNER_PATH,
      })
      const staged = spawnSync(process.execPath, [RUNNER_PATH], {
        input: job,
        encoding: "utf8",
        timeout: 3000,
      })
      assert.equal(JSON.parse(staged.stdout).error.name, "BadJob")
      assert.doesNotMatch(staged.stderr, /MODULE_NOT_FOUND/)
    })
  }
)

// `node --test scripts/build/stage-plugin-artifacts.test.mjs`
//
// The consumer is the only way plugin output reaches the host build, so it is
// tested against hand-made sets in a host root that has no `plugins/` at all.

import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"

import { PLUGIN_ARTIFACT_MANIFEST, PLUGIN_ARTIFACT_SECTIONS } from "./plugin-artifact-format.mjs"
import {
  LOCAL_ARTIFACT_DIR,
  PLUGIN_ARTIFACTS_ENV,
  WEB_SECTIONS,
  readPluginArtifactSet,
  resolvePluginArtifactSet,
  stagePluginArtifacts as stage,
} from "./stage-plugin-artifacts.mjs"
import { valueSha256 } from "./plugin-artifact-contract.mjs"
import { build } from "esbuild"
import {
  prepareBuiltinPluginAssets,
  stageBuiltinPluginAssets,
} from "./lib/stage-builtin-plugin-assets.mjs"

const PROFILE = {
  schema: 1,
  name: "test",
  browser: [{ directory: "alpha", id: "alpha" }],
  desktop: { beta: { id: "beta" } },
  companions: [],
}
const AUTHORING = {
  sdkVersion: "1.0.0",
  uiVersion: "1.0.0",
  contractVersion: "1.0.0",
  kitSha256: "1".repeat(64),
  catalogSha256: "2".repeat(64),
  sharedModulesSha256: "3".repeat(64),
  styleContractSha256: "4".repeat(64),
  witSha256: "5".repeat(64),
  compilerContractSha256: "f".repeat(64),
  sdkSourceSha256: "8".repeat(64),
  uiSourceSha256: "9".repeat(64),
  githubKitSourceSha256: "c".repeat(64),
  lockfileSha256: "a".repeat(64),
}
const SOURCE = {
  repository: "test/plugins",
  revision: "1".repeat(40),
  sourceTreeSha256: "6".repeat(64),
  lockfileSha256: "7".repeat(64),
}
const ALPHA = { id: "alpha", version: "1.0.0", type: "frontend", main: "dist/index.js" }
const BETA = { id: "beta", version: "1.0.0", type: "python", pythonMain: "main.py" }
const CHUNK = "module.exports = 1"
const CHUNK_DIGEST = createHash("sha256").update(CHUNK).digest("hex")
const CHUNK_PATH = `builtin-plugins/alpha/${CHUNK_DIGEST}.cjs`
const WORKER = "worker"
const WORKER_DIGEST = createHash("sha256").update(WORKER).digest("hex")
const WORKER_PATH = `builtin-plugins/_shared/pdf.worker.${WORKER_DIGEST}.mjs`
const stagePluginArtifacts = (options) =>
  stage({
    profile: PROFILE,
    authoring: AUTHORING,
    contractCatalog: {
      pathFields: [
        { path: "extensions[].entry", runtime: "javascript" },
        { path: "pythonMain", requiredFor: ["python"], runtime: "python" },
      ],
    },
    ...options,
  })

function tempDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

const SET_FILES = {
  [CHUNK_PATH]: CHUNK,
  "builtin-plugins/alpha/resources/plugin.json": JSON.stringify(ALPHA),
  "builtin-plugins/alpha/resources/dist/index.js": CHUNK,
  [WORKER_PATH]: WORKER,
  "plugin-icons/alpha/assets/icon.png": "png",
  "desktop-plugins/beta/plugin.json": JSON.stringify(BETA),
  "desktop-plugins/beta/main.py": "print('beta')",
  "browser-builtin-assets.json": JSON.stringify({
    version: 1,
    sharedResources: {
      pdfWorker: {
        url: `/_cognia/builtin-plugins/_shared/pdf.worker.${WORKER_DIGEST}.mjs`,
        sha256: WORKER_DIGEST,
      },
    },
    entries: {
      alpha: {
        manifest: ALPHA,
        path: "builtin://alpha",
        asset: {
          url: `/_cognia/builtin-plugins/alpha/${CHUNK_DIGEST}.cjs`,
          sha256: CHUNK_DIGEST,
          resourcesUrl: "/_cognia/builtin-plugins/alpha/resources/",
          sharedModules: [],
        },
      },
    },
  }),
  "builtin-preboot-manifests.json": '{"version":1,"plugins":{}}\n',
  "bundled-plugins.json": '{"entries":{}}\n',
}

/** Write a set and its manifest; `files` overrides or (with `null`) removes entries. */
function writeSet(dir, files = {}, { manifestFiles, profile = PROFILE } = {}) {
  const contents = { ...SET_FILES, ...files }
  const desktop = {}
  for (const [relative, text] of Object.entries(contents)) {
    const match = /^desktop-plugins\/([^/]+)\/plugin\.json$/.exec(relative)
    if (!match || text === null) continue
    const manifest = JSON.parse(text)
    desktop[match[1]] = {
      id: manifest.id,
      version: manifest.version,
      files: Object.entries(contents)
        .filter(
          ([file, bytes]) => file.startsWith(`desktop-plugins/${match[1]}/`) && bytes !== null
        )
        .map(([file, bytes]) => ({
          path: file.slice(`desktop-plugins/${match[1]}/`.length),
          bytes: Buffer.byteLength(bytes),
          sha256: createHash("sha256").update(bytes).digest("hex"),
        })),
    }
  }
  if (!("bundled-plugins.json" in files))
    contents["bundled-plugins.json"] = JSON.stringify({ entries: desktop })
  const listed = {}
  for (const [relative, text] of Object.entries(contents)) {
    if (text === null) continue
    const file = path.join(dir, ...relative.split("/"))
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, text)
    listed[relative] = createHash("sha256").update(text).digest("hex")
  }
  fs.writeFileSync(
    path.join(dir, PLUGIN_ARTIFACT_MANIFEST),
    JSON.stringify({
      schema: 2,
      source: SOURCE,
      authoring: AUTHORING,
      profile: { name: profile.name, sha256: valueSha256(profile) },
      inventory: [
        {
          directory: "alpha",
          id: "alpha",
          version: ALPHA.version,
          type: ALPHA.type,
          manifestSha256: valueSha256(
            JSON.parse(contents["builtin-plugins/alpha/resources/plugin.json"] ?? JSON.stringify(ALPHA))
          ),
        },
        ...Object.entries(desktop).filter(([directory]) => directory !== "alpha").map(([directory, entry]) => ({
          directory,
          id: entry.id,
          version: entry.version,
          type: "python",
          manifestSha256: valueSha256(
            JSON.parse(contents[`desktop-plugins/${directory}/plugin.json`])
          ),
        })),
      ],
      files: manifestFiles ?? listed,
      modes: Object.fromEntries(Object.keys(manifestFiles ?? listed).map((file) => [file, 0o644])),
    })
  )
  return dir
}

function host(root, relative) {
  return path.join(root, ...relative.split("/"))
}

function noProduce() {
  throw new Error("must not produce")
}

for (const state of ["cold", "warm"])
  test(`${state} CLI input A is replaced with explicit B before real compilation and final layout copy`, async (t) => {
    const root = tempDir(t, "cli-artifact-order-"),
      outDir = tempDir(t, "cli-artifact-layout-")
    const a = writeSet(tempDir(t, "cli-set-a-"))
    if (state === "warm") await stagePluginArtifacts({ root, from: a, env: {} })
    else {
      const catalog = host(root, PLUGIN_ARTIFACT_SECTIONS.builtinIndex.host)
      fs.mkdirSync(path.dirname(catalog), { recursive: true })
      fs.writeFileSync(catalog, SET_FILES["browser-builtin-assets.json"])
    }
    const code = "module.exports = 2",
      digest = createHash("sha256").update(code).digest("hex")
    const index = JSON.parse(SET_FILES["browser-builtin-assets.json"])
    index.entries.alpha.asset.sha256 = digest
    index.entries.alpha.asset.url = `/_cognia/builtin-plugins/alpha/${digest}.cjs`
    const b = writeSet(tempDir(t, "cli-set-b-"), {
      [CHUNK_PATH]: null,
      [`builtin-plugins/alpha/${digest}.cjs`]: code,
      "builtin-plugins/alpha/resources/dist/index.js": code,
      "browser-builtin-assets.json": JSON.stringify(index),
    })
    const lease = await prepareBuiltinPluginAssets({
      root,
      env: { COGNIA_PLUGIN_ARTIFACTS: b },
      profile: PROFILE,
      authoring: AUTHORING,
      contractCatalog: { pathFields: [] },
    })
    try {
      const compiled = await build({
        absWorkingDir: root,
        stdin: {
          contents:
            "import catalog from './lib/plugin/core/browser-builtin-assets.generated.json'; export default catalog",
          resolveDir: root,
        },
        bundle: true,
        format: "cjs",
        platform: "node",
        write: false,
      })
      const cliModule = { exports: {} }
      new Function("module", "exports", compiled.outputFiles[0].text)(cliModule, cliModule.exports)
      assert.equal(cliModule.exports.default.entries.alpha.asset.sha256, digest)
      await assert.rejects(stagePluginArtifacts({ root, from: a, env: {} }), /artifact_in_use/)
      stageBuiltinPluginAssets({ root, outDir, artifactSha256: lease.artifactSha256 })
      assert.equal(
        fs.readFileSync(path.join(outDir, `_cognia/builtin-plugins/alpha/${digest}.cjs`), "utf8"),
        code
      )
      assert.equal(
        fs.existsSync(path.join(outDir, `_cognia/builtin-plugins/alpha/${CHUNK_DIGEST}.cjs`)),
        false
      )
    } finally {
      lease.release()
    }
  })

test("rejects a complete but empty set before changing the expected Host catalogs", async (t) => {
  const root = tempDir(t, "host-expected-")
  fs.mkdirSync(host(root, "lib/plugin/distribution"), { recursive: true })
  fs.writeFileSync(
    host(root, "lib/plugin/distribution/product-profile.json"),
    JSON.stringify({
      schema: 1,
      name: "test",
      browser: [{ directory: "alpha", id: "alpha" }],
      desktop: {},
      companions: [],
    })
  )
  const set = writeSet(tempDir(t, "empty-set-"), {
    [CHUNK_PATH]: null,
    "builtin-plugins/alpha/resources/plugin.json": null,
    "browser-builtin-assets.json": '{"version":1,"entries":{}}',
  })
  await assert.rejects(
    stagePluginArtifacts({ root, from: set, env: {} }),
    /catalog|profile|identity/i
  )
  assert.equal(fs.existsSync(host(root, PLUGIN_ARTIFACT_SECTIONS.builtinIndex.host)), false)
})

test("refuses self-consistent incompatible metadata and contradictory catalogs before any Host write", async (t) => {
  const baseIndex = JSON.parse(SET_FILES["browser-builtin-assets.json"])
  const cases = {
    preboot: {
      "builtin-preboot-manifests.json": '{"version":1,"plugins":{"alpha":{"version":"2"}}}',
    },
    "resource manifest": {
      "builtin-plugins/alpha/resources/plugin.json": JSON.stringify({ ...ALPHA, version: "2.0.0" }),
    },
    "entry digest": {
      "browser-builtin-assets.json": JSON.stringify({
        version: 1,
        entries: {
          alpha: {
            ...baseIndex.entries.alpha,
            asset: {
              ...baseIndex.entries.alpha.asset,
              entryHashes: { "dist/missing.js": "0".repeat(64) },
            },
          },
        },
      }),
    },
    "shared module": {
      "browser-builtin-assets.json": JSON.stringify({
        version: 1,
        entries: {
          alpha: {
            ...baseIndex.entries.alpha,
            asset: {
              ...baseIndex.entries.alpha.asset,
              sharedModules: ["@cognia/plugin-sdk/not-a-public-export"],
            },
          },
        },
      }),
    },
    "desktop membership": { "bundled-plugins.json": '{"entries":{}}' },
    "missing desktop main": { "desktop-plugins/beta/main.py": null },
    "unowned browser resource": { "builtin-plugins/not-curated/resources/extra.js": CHUNK },
    "stale browser chunk": { "builtin-plugins/alpha/extra.cjs": CHUNK },
    "incorrect shared worker identity": { [WORKER_PATH]: "different worker" },
    "missing shared worker": { [WORKER_PATH]: null },
  }
  for (const [label, files] of Object.entries(cases)) {
    const root = tempDir(t, "semantic-host-")
    const set = writeSet(tempDir(t, "semantic-set-"), files)
    await assert.rejects(
      stagePluginArtifacts({ root, from: set, env: {} }),
      /Plugin artifact contract/,
      label
    )
    assert.deepEqual(fs.readdirSync(root), [], label)
  }
  for (const field of ["authoring", "profile"]) {
    const root = tempDir(t, "identity-host-"),
      set = writeSet(tempDir(t, "identity-set-"))
    const manifestPath = path.join(set, PLUGIN_ARTIFACT_MANIFEST)
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"))
    manifest[field] =
      field === "authoring"
        ? { ...manifest.authoring, contractVersion: "999.0.0" }
        : { ...manifest.profile, sha256: "0".repeat(64) }
    fs.writeFileSync(manifestPath, JSON.stringify(manifest))
    await assert.rejects(stagePluginArtifacts({ root, from: set, env: {} }), /mismatch/)
    assert.deepEqual(fs.readdirSync(root), [])
  }
})

test("requires secondary contribution integrity before any Host write", async (t) => {
  const root = tempDir(t, "secondary-entry-host-")
  const plugin = { ...ALPHA, extensions: [{ entry: "dist/extension.js" }] }
  const index = JSON.parse(SET_FILES["browser-builtin-assets.json"])
  index.entries.alpha.manifest = plugin
  const set = writeSet(tempDir(t, "secondary-entry-set-"), {
    "builtin-plugins/alpha/resources/plugin.json": JSON.stringify(plugin),
    "builtin-plugins/alpha/resources/dist/extension.js": CHUNK,
    "browser-builtin-assets.json": JSON.stringify(index),
  })
  await assert.rejects(
    stagePluginArtifacts({ root, from: set, env: {} }),
    /missing entry integrity alpha\/dist\/extension\.js/
  )
  assert.deepEqual(fs.readdirSync(root), [])
})

test("desktop companions require every declared runtime provisioning input before any Host write", async (t) => {
  const plugin = { ...ALPHA, nodeRuntime: { directory: "runtime", entry: "probe.mjs" } }
  const profile = { ...PROFILE, companions: PROFILE.browser }
  const index = JSON.parse(SET_FILES["browser-builtin-assets.json"])
  index.entries.alpha.manifest = plugin
  const runtime = ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "probe.mjs"]
  const files = {
    "builtin-plugins/alpha/resources/plugin.json": JSON.stringify(plugin),
    "browser-builtin-assets.json": JSON.stringify(index),
    "desktop-plugins/alpha/plugin.json": JSON.stringify(plugin),
    "desktop-plugins/alpha/dist/index.js": CHUNK,
    ...Object.fromEntries(runtime.map((file) => [`desktop-plugins/alpha/runtime/${file}`, "fixture"])),
  }
  await stagePluginArtifacts({
    root: tempDir(t, "valid-runtime-host-"),
    from: writeSet(tempDir(t, "valid-runtime-set-"), files, { profile }),
    env: {},
    profile,
  })
  for (const missing of runtime) {
    const root = tempDir(t, "missing-runtime-host-")
    const set = writeSet(tempDir(t, "missing-runtime-set-"), {
      ...files,
      [`desktop-plugins/alpha/runtime/${missing}`]: null,
    }, { profile })
    await assert.rejects(
      stagePluginArtifacts({ root, from: set, env: {}, profile }),
      /desktop runtime resource alpha\/runtime\//
    )
    assert.deepEqual(fs.readdirSync(root), [])
  }
})

test("stages every section of an external set into the host tree without plugins/", async (t) => {
  const root = tempDir(t, "host-")
  const set = writeSet(tempDir(t, "set-"))
  const result = await stagePluginArtifacts({ root, from: set, env: {}, produce: noProduce })
  assert.equal(result.source, "external")
  assert.deepEqual(result.changed.sort(), Object.keys(PLUGIN_ARTIFACT_SECTIONS).sort())
  assert.equal(
    fs.readFileSync(host(root, `public/_cognia/builtin-plugins/alpha/${CHUNK_DIGEST}.cjs`), "utf8"),
    "module.exports = 1"
  )
  assert.equal(
    fs.readFileSync(host(root, "public/_cognia/plugin-icons/alpha/assets/icon.png"), "utf8"),
    "png"
  )
  assert.equal(
    fs.readFileSync(host(root, "src-tauri/resources/plugins/beta/main.py"), "utf8"),
    "print('beta')"
  )
  for (const name of ["builtinIndex", "prebootManifests", "desktopCatalog"]) {
    const section = PLUGIN_ARTIFACT_SECTIONS[name]
    assert.equal(
      fs.readFileSync(host(root, section.host), "utf8"),
      section.set === "bundled-plugins.json"
        ? fs.readFileSync(path.join(set, section.set), "utf8")
        : SET_FILES[section.set]
    )
  }
  assert.equal(fs.existsSync(path.join(root, "plugins")), false)
})

test("reads the set named by the environment variable", async (t) => {
  const root = tempDir(t, "host-")
  const set = writeSet(tempDir(t, "set-"))
  const resolved = await resolvePluginArtifactSet({
    root,
    env: { [PLUGIN_ARTIFACTS_ENV]: set },
    produce: noProduce,
  })
  assert.deepEqual(resolved, { dir: set, source: "external" })
})

test("an explicit set wins over plugin sources in the checkout", async (t) => {
  const root = tempDir(t, "host-")
  fs.mkdirSync(path.join(root, "plugins"))
  const set = writeSet(tempDir(t, "set-"))
  const resolved = await resolvePluginArtifactSet({ root, from: set, env: {}, produce: noProduce })
  assert.equal(resolved.source, "external")
})

test("produces into the local cache when only plugin sources are present", async (t) => {
  const root = tempDir(t, "host-")
  fs.mkdirSync(path.join(root, "plugins"))
  const calls = []
  const resolved = await resolvePluginArtifactSet({
    root,
    env: {},
    produce: async (options) => {
      calls.push(options)
      writeSet(options.outDir)
    },
  })
  assert.deepEqual(calls, [
    {
      root,
      pluginsRoot: path.join(root, "plugins"),
      outDir: path.join(root, LOCAL_ARTIFACT_DIR),
    },
  ])
  assert.deepEqual(resolved, { dir: path.join(root, LOCAL_ARTIFACT_DIR), source: "produced" })
})

test("with neither a set nor plugin sources, the build stops and says how to fix it", async (t) => {
  const root = tempDir(t, "host-")
  await assert.rejects(
    stagePluginArtifacts({ root, env: {}, produce: noProduce }),
    (error) => error.message.includes(PLUGIN_ARTIFACTS_ENV) && error.message.includes("produce.mjs")
  )
})

test("a set that fails verification changes nothing in the host tree", async (t) => {
  const cases = {
    "digest mismatch": (dir) => {
      writeSet(dir)
      fs.writeFileSync(path.join(dir, CHUNK_PATH), "tampered")
    },
    "missing file": (dir) => {
      writeSet(dir)
      fs.rmSync(path.join(dir, "plugin-icons/alpha/assets/icon.png"))
    },
    "unlisted file": (dir) => {
      writeSet(dir)
      fs.writeFileSync(path.join(dir, "builtin-plugins/alpha/extra.cjs"), "extra")
    },
    "path outside every section": (dir) => writeSet(dir, { "elsewhere/file.txt": "x" }),
    traversal: (dir) =>
      writeSet(dir, {}, { manifestFiles: { "builtin-plugins/../escape.txt": "0".repeat(64) } }),
    "missing catalog": (dir) => writeSet(dir, { "bundled-plugins.json": null }),
    "wrong schema": (dir) => {
      writeSet(dir)
      const manifestPath = path.join(dir, PLUGIN_ARTIFACT_MANIFEST)
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"))
      fs.writeFileSync(manifestPath, JSON.stringify({ ...manifest, schema: 1 }))
    },
    "no manifest": (dir) => {
      writeSet(dir)
      fs.rmSync(path.join(dir, PLUGIN_ARTIFACT_MANIFEST))
    },
  }
  for (const [label, make] of Object.entries(cases)) {
    const root = tempDir(t, "host-")
    const set = tempDir(t, "set-")
    make(set)
    await assert.rejects(
      stagePluginArtifacts({ root, from: set, env: {}, produce: noProduce }),
      Error,
      label
    )
    assert.deepEqual(fs.readdirSync(root), [], label)
  }
})

test("trees are mirrored, and an unchanged set rewrites nothing", async (t) => {
  const root = tempDir(t, "host-")
  const stale = host(root, "public/_cognia/builtin-plugins/old/gone.cjs")
  fs.mkdirSync(path.dirname(stale), { recursive: true })
  fs.writeFileSync(stale, "stale")
  const set = writeSet(tempDir(t, "set-"))
  await stagePluginArtifacts({ root, from: set, env: {} })
  assert.equal(fs.existsSync(stale), false)
  assert.equal(fs.existsSync(path.dirname(stale)), false)

  const watched = [
    host(root, `public/_cognia/builtin-plugins/alpha/${CHUNK_DIGEST}.cjs`),
    host(root, "src-tauri/resources/plugins/beta/main.py"),
    host(root, PLUGIN_ARTIFACT_SECTIONS.builtinIndex.host),
  ]
  const past = new Date("2020-01-01T00:00:00Z")
  for (const file of watched) fs.utimesSync(file, past, past)
  const again = await stagePluginArtifacts({ root, from: set, env: {} })
  assert.deepEqual(again.changed, [])
  for (const file of watched) assert.equal(fs.statSync(file).mtimeMs, past.getTime())
})

test("a changed desktop section replaces the whole staged tree", async (t) => {
  const root = tempDir(t, "host-")
  await stagePluginArtifacts({ root, from: writeSet(tempDir(t, "set-")), env: {} })
  const nextProfile = { ...PROFILE, desktop: { ...PROFILE.desktop, gamma: { id: "gamma" } } }
  const next = writeSet(
    tempDir(t, "set-"),
    {
      "desktop-plugins/beta/main.py": null,
      "desktop-plugins/beta/plugin.json": JSON.stringify({ ...BETA, pythonMain: "renamed.py" }),
      "desktop-plugins/beta/renamed.py": "print('renamed beta')",
      "desktop-plugins/gamma/plugin.json":
        '{"id":"gamma","version":"1.0.0","type":"python","pythonMain":"main.py"}',
      "desktop-plugins/gamma/main.py": "print('gamma')",
    },
    { profile: nextProfile }
  )
  const result = await stagePluginArtifacts({ root, from: next, env: {}, profile: nextProfile })
  assert.ok(result.changed.includes("desktopPlugins"))
  assert.deepEqual(fs.readdirSync(host(root, "src-tauri/resources/plugins")).sort(), [
    "beta",
    "gamma",
  ])
  assert.equal(fs.existsSync(host(root, "src-tauri/resources/plugins/beta/main.py")), false)
})

test("web-only staging leaves the installer section alone but still verifies it", async (t) => {
  assert.equal(WEB_SECTIONS.includes("desktopPlugins"), false)
  const root = tempDir(t, "host-")
  const set = writeSet(tempDir(t, "set-"))
  const result = await stagePluginArtifacts({ root, from: set, env: {}, sections: WEB_SECTIONS })
  assert.equal(result.changed.includes("desktopPlugins"), false)
  assert.equal(fs.existsSync(host(root, "src-tauri")), false)
  assert.ok(fs.existsSync(host(root, PLUGIN_ARTIFACT_SECTIONS.desktopCatalog.host)))

  fs.writeFileSync(path.join(set, "desktop-plugins/beta/main.py"), "tampered")
  await assert.rejects(
    stagePluginArtifacts({ root, from: set, env: {}, sections: WEB_SECTIONS }),
    /does not match/
  )
})

test("readPluginArtifactSet groups files by section", (t) => {
  const sections = readPluginArtifactSet(writeSet(tempDir(t, "set-")))
  assert.deepEqual([...sections.builtinChunks.keys()].sort(), [
    `_shared/pdf.worker.${WORKER_DIGEST}.mjs`,
    `alpha/${CHUNK_DIGEST}.cjs`,
    "alpha/resources/dist/index.js",
    "alpha/resources/plugin.json",
  ])
  assert.deepEqual([...sections.desktopCatalog.keys()], [""])
})

test("an artifact lease protects compilation and final copying from a second valid artifact", async (t) => {
  const root = tempDir(t, "leased-host-")
  const first = writeSet(tempDir(t, "leased-set-a-"))
  const held = await stagePluginArtifacts({ root, from: first, env: {}, hold: true })
  t.after(() => held.release?.())
  const before = fs.readFileSync(host(root, "src-tauri/resources/plugins/beta/main.py"), "utf8")
  const second = writeSet(tempDir(t, "leased-set-b-"), {
    "desktop-plugins/beta/main.py": "print('new valid artifact')",
  })
  await assert.rejects(stagePluginArtifacts({ root, from: second, env: {} }), /artifact_in_use/)
  assert.equal(
    fs.readFileSync(host(root, "src-tauri/resources/plugins/beta/main.py"), "utf8"),
    before
  )
  assert.equal(typeof held.release, "function")
  const shared = await stagePluginArtifacts({ root, from: first, env: {}, hold: true })
  shared.release()
  held.release()
  await stagePluginArtifacts({ root, from: second, env: {} })
  assert.equal(
    fs.readFileSync(host(root, "src-tauri/resources/plugins/beta/main.py"), "utf8"),
    "print('new valid artifact')"
  )
})

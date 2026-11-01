/** @jest-environment node */
import assert from "node:assert/strict"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runInNewContext } from "node:vm"
import { createRequire } from "node:module"
import { test as nodeTest } from "node:test"
import JSZip from "jszip"
import { buildPlugin } from "./build.mjs"

// Runs both under the repository Jest entry point and `node build.test.mjs`.
const test = process.env.JEST_WORKER_ID ? globalThis.test : nodeTest
const requireSdk = createRequire(new URL("../../packages/plugin-sdk/package.json", import.meta.url))

test("the reproducible install ZIP loads outside the checkout with only the public SDK", async () => {
  const outputDirectory = await mkdtemp(join(tmpdir(), "cognia-author-example-"))
  try {
    const { archivePath, entryPaths } = await buildPlugin({ outputDirectory })
    const bytes = await readFile(archivePath)
    const archive = await JSZip.loadAsync(bytes)
    assert.deepEqual(Object.keys(archive.files).sort(), ["dist/index.js", "plugin.json"])
    const manifest = JSON.parse(await archive.file("plugin.json").async("string"))
    for (const runtime of Object.values(manifest.runtimeCompatibility)) {
      if (runtime.entrypoint) assert.ok(archive.file(runtime.entrypoint))
    }
    const entry = await archive.file(manifest.main).async("string")
    assert.equal(entry, await readFile(entryPaths[manifest.main], "utf8"))
    const sdk = requireSdk("@cognia/plugin-sdk")
    const pluginModule = { exports: {} }
    runInNewContext(entry, {
      module: pluginModule,
      exports: pluginModule.exports,
      require: (id) => {
        assert.equal(id, "@cognia/plugin-sdk")
        return sdk
      },
    })
    const definition = pluginModule.exports.default
    assert.deepEqual(JSON.parse(JSON.stringify(definition.manifest)), manifest)
    assert.equal(typeof definition.activate, "function")
    await buildPlugin({ outputDirectory })
    assert.deepEqual(await readFile(archivePath), bytes)
  } finally {
    await rm(outputDirectory, { recursive: true, force: true })
  }
})

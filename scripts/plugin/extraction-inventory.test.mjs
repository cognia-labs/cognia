import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { collectExtractionInventory } from "./extraction-inventory.mjs"

test("records actual dirty source bytes, missing inputs, resource ownership and host test seams", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-inventory-"))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const contents = {
    "plugins/example/plugin.json": JSON.stringify({
      id: "example",
      version: "1.0.0",
      type: "frontend",
      screenshots: ["/plugins/example/image.png"],
    }),
    "plugins/example/src/index.test.ts": 'import { definePlugin } from "@cognia/plugin-sdk"',
    "plugins/example/src/host.test.ts":
      '/** @cognia-host-integration-test */\nimport { x } from "@/lib/x"',
    "public/plugins/example/image.png": "image",
    "scripts/build/build-example.mjs": "await stagePluginArtifacts()",
  }
  for (const [file, bytes] of Object.entries(contents)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
    fs.writeFileSync(path.join(root, file), bytes)
  }
  const options = {
    root,
    files: [...Object.keys(contents), "plugins/deleted.ts"],
    revision: "fixture",
    status: [" M plugins/example/plugin.json"],
  }
  const first = collectExtractionInventory(options)
  assert.equal(first.summary.plugins, 1)
  assert.equal(first.summary.hostTestFiles, 1)
  assert.equal(first.summary.publicMirrorFiles, 1)
  assert.deepEqual(first.plugins[0].legacyPublicPaths, ["/plugins/example/image.png"])
  assert.equal(first.tests.find((entry) => entry.path.endsWith("index.test.ts")).owner, "plugin")
  assert.equal(first.inputs["plugins/deleted.ts"].kind, "deleted")
  assert.equal(first.buildEntrypoints[0].line, 1)
  fs.writeFileSync(path.join(root, "public/plugins/example/image.png"), "changed")
  assert.notEqual(collectExtractionInventory(options).sourceTreeSha256, first.sourceTreeSha256)
  assert.throws(
    () => collectExtractionInventory({ ...options, files: ["../escape"] }),
    /escapes root/
  )
})

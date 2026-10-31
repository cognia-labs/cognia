import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import {
  createProductProfile,
  readProductProfile,
  PRODUCT_PROFILE_FILE,
  valueSha256,
} from "./plugin-artifact-contract.mjs"

test("profile export makes plugin identity explicit and detects later Host policy drift without source reads", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-profile-"))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const files = {
    "lib/plugin/distribution/browser-builtins.json": '["example"]',
    "lib/plugin/distribution/distribution.json": '{"bundled":{},"devOnly":{}}',
    "plugins/example/plugin.json": '{"id":"actual-id","type":"frontend"}',
  }
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
    fs.writeFileSync(path.join(root, file), content)
  }
  const profile = createProductProfile({ root })
  assert.deepEqual(profile.browser, [{ directory: "example", id: "actual-id" }])
  fs.writeFileSync(path.join(root, PRODUCT_PROFILE_FILE), JSON.stringify(profile))
  fs.rmSync(path.join(root, "plugins"), { recursive: true })
  assert.deepEqual(readProductProfile(root), profile)
  fs.writeFileSync(path.join(root, "lib/plugin/distribution/browser-builtins.json"), "[]")
  assert.throws(() => readProductProfile(root), /Host browser profile mismatch/)
})

test("canonical identity ignores object key order while preserving ordered profile selection", () => {
  assert.equal(valueSha256({ a: 1, b: 2 }), valueSha256({ b: 2, a: 1 }))
  assert.notEqual(valueSha256(["a", "b"]), valueSha256(["b", "a"]))
})

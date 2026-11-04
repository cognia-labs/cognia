import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import {
  createProductProfile,
  readHostAuthoringAbi,
  readHostAuthoringIdentity,
  readProductProfile,
  AUTHORING_KIT_PIN,
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

function authoringHost(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-authoring-abi-"))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const write = (relative, value) => {
    const file = path.join(root, relative)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, value)
  }
  for (const [file, content] of Object.entries({
    "packages/plugin-sdk/package.json": '{"version":"0.3.0","exports":{".":"./dist/index.js"}}',
    "packages/plugin-sdk/src/index.ts": 'export type { Context } from "@cognia/plugin-contract"',
    "packages/plugin-ui/package.json": '{"version":"0.1.0"}',
    "packages/plugin-ui/src/index.ts": "export {}",
    "packages/plugin-contract/package.json":
      '{"name":"@cognia/plugin-contract","exports":{".":"./src/index.ts"}}',
    "packages/plugin-contract/contract/catalog.json": '{"contractVersion":"1.0.0"}',
    "packages/plugin-contract/src/index.ts": 'export type { Context } from "./context"',
    "packages/plugin-contract/src/context.ts":
      "export interface Context { backup: { create(): void } }",
    "types/plugin/index.ts": 'export * from "@cognia/plugin-contract"',
    "lib/plugin/core/shared-modules.ts": "export {}",
    "lib/plugin/core/sdk-subpath-loaders.ts": "export {}",
    "app/globals.css": "",
    "lib/plugin/styles/plugin-stylesheet.ts": "export {}",
    "src-tauri/wit/cognia-plugin.wit": "package cognia:plugin;",
    "packages/github-bot-kit/package.json": '{"version":"0.0.0"}',
    "packages/github-bot-kit/src/index.ts": "export {}",
    "packages/github-bot-kit/tsup.config.ts": "export default {}",
    "pnpm-lock.yaml": "lockfileVersion: '9.0'",
    "tsconfig.json": '{"compilerOptions":{"target":"ES2022","strict":true}}',
  })) write(file, content)
  const initial = readHostAuthoringAbi(root)
  write(AUTHORING_KIT_PIN, JSON.stringify({ schema: 1, sha256: "1".repeat(64), authoring: initial }))
  assert.equal(readHostAuthoringIdentity(root).kitSha256, "1".repeat(64))
  return { root, write, initial }
}

for (const change of ["edit", "add", "remove", "package exports"])
  test(`rejects the pinned Kit when only contract ${change} changes, including a proof-time recheck`, (t) => {
    const { root, write, initial } = authoringHost(t)
    if (change === "edit")
      write(
        "packages/plugin-contract/src/context.ts",
        "export interface Context { backup: { create(): void; registerDestination(): void } }"
      )
    else if (change === "add")
      write("packages/plugin-contract/src/destinations.ts", "export interface Destination { id: string }")
    else if (change === "remove")
      fs.unlinkSync(path.join(root, "packages/plugin-contract/src/context.ts"))
    else
      write(
        "packages/plugin-contract/package.json",
        '{"name":"@cognia/plugin-contract","exports":{".":"./src/context.ts"}}'
      )
    const current = readHostAuthoringAbi(root)
    assert.equal(current.catalogSha256, initial.catalogSha256)
    assert.throws(() => readHostAuthoringIdentity(root), /Host authoring kit ABI/)
    assert.notEqual(current.sdkSourceSha256, initial.sdkSourceSha256)
    assert.deepEqual({ ...current, sdkSourceSha256: initial.sdkSourceSha256 }, initial)
  })

test("contract tests and documentation do not invalidate the distributed SDK identity", (t) => {
  const { root, write, initial } = authoringHost(t)
  write("packages/plugin-contract/src/context.test.ts", "test('new contract check', () => {})")
  write("packages/plugin-contract/README.md", "Updated contract contributor notes")
  assert.deepEqual(readHostAuthoringAbi(root), initial)
  assert.equal(readHostAuthoringIdentity(root).kitSha256, "1".repeat(64))
})

test("contract source symlinks cannot bypass authoring identity checks", (t) => {
  const { root } = authoringHost(t)
  fs.symlinkSync(
    path.join(root, "types/plugin"),
    path.join(root, "packages/plugin-contract/src/alias"),
    "junction"
  )
  assert.throws(() => readHostAuthoringIdentity(root), /symlink in authoring source/)
})

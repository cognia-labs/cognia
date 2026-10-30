import test from "node:test"
import assert from "node:assert/strict"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { nativeArtifact } from "./native.mjs"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const artifact = (executable) => ({
  reason: "compiler-artifact",
  target: {
    name: "connector-native-fixture",
    kind: ["bin"],
    src_path: path.join(root, "tests/bot-e2e/native-bridge.rs"),
  },
  executable,
})

test("uses Cargo's exact executable for explicit or configured build targets", () => {
  for (const directory of [
    "debug",
    "aarch64-apple-darwin/debug",
    "x86_64-unknown-linux-gnu/debug",
  ]) {
    const executable = path.join(root, "target", directory, "connector-native-fixture")
    assert.equal(nativeArtifact(artifact(executable)), executable)
  }
})

test("ignores dependencies, same-name foreign sources and non-executable artifacts", () => {
  const valid = artifact("/native/fixture")
  for (const message of [
    { ...valid, reason: "build-finished" },
    { ...valid, executable: null },
    { ...valid, target: { ...valid.target, kind: ["lib"] } },
    { ...valid, target: { ...valid.target, name: "another-bin" } },
    { ...valid, target: { ...valid.target, src_path: "/unrelated/native-bridge.rs" } },
  ])
    assert.equal(nativeArtifact(message), undefined)
})

test("Tauri lane requires the actual Wry fixture source and target", () => {
  const valid = artifact("/native/tauri-fixture")
  assert.equal(nativeArtifact(valid, true), undefined)
  valid.target.name = "connector-tauri-fixture"
  valid.target.src_path = path.join(root, "tests/bot-e2e/tauri-bridge.rs")
  assert.equal(nativeArtifact(valid, true), valid.executable)
  assert.equal(nativeArtifact(valid), undefined)
})

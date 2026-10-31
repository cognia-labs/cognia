import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { test } from "node:test"
import { createHash } from "node:crypto"
import {
  bootstrapAuthoringKit,
  verifyInstalledAuthoringPackages,
} from "./bootstrap-authoring-kit.mjs"

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex")
test("Node-only bootstrap verifies every file, reuses offline cache and preserves the old kit on failure", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kit-bootstrap-"))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const source = path.join(root, "source"),
    target = path.join(root, ".vendor/authoring-kit"),
    pinFile = path.join(root, "pin.json")
  fs.mkdirSync(source)
  fs.writeFileSync(path.join(source, "sdk.tgz"), "real package fixture")
  const manifest = JSON.stringify({
    schema: 1,
    packages: [{ file: "sdk.tgz" }],
    files: { "sdk.tgz": digest("real package fixture") },
  })
  fs.writeFileSync(path.join(source, "authoring-kit.json"), manifest)
  const pin = {
    schema: 1,
    sha256: digest(manifest),
    url: pathToFileURL(path.join(source, "authoring-kit.json")).href,
  }
  fs.writeFileSync(pinFile, JSON.stringify(pin))
  assert.equal((await bootstrapAuthoringKit({ pinFile, target })).cached, false)
  fs.rmSync(source, { recursive: true })
  assert.equal((await bootstrapAuthoringKit({ pinFile, target })).cached, true)
  fs.writeFileSync(pinFile, JSON.stringify({ ...pin, sha256: "0".repeat(64) }))
  await assert.rejects(bootstrapAuthoringKit({ pinFile, target }))
  assert.equal(fs.readFileSync(path.join(target, "sdk.tgz"), "utf8"), "real package fixture")
  fs.writeFileSync(pinFile, JSON.stringify(pin))
  fs.writeFileSync(path.join(target, "sdk.tgz"), "tampered")
  await assert.rejects(bootstrapAuthoringKit({ pinFile, target }))
})

test("bootstrap refuses traversal and an unowned target before replacement", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kit-bootstrap-path-"))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const bytes = JSON.stringify({ schema: 1, packages: [], files: { "../escape": digest("bad") } })
  fs.writeFileSync(path.join(root, "authoring-kit.json"), bytes)
  const pinFile = path.join(root, "pin.json"),
    target = path.join(root, "kit")
  fs.writeFileSync(
    pinFile,
    JSON.stringify({
      schema: 1,
      sha256: digest(bytes),
      url: pathToFileURL(path.join(root, "authoring-kit.json")).href,
    })
  )
  await assert.rejects(bootstrapAuthoringKit({ pinFile, target }), /Unsafe authoring kit path/)
  assert.equal(fs.existsSync(path.join(root, "escape")), false)
  fs.mkdirSync(target)
  fs.writeFileSync(path.join(target, "owned-by-user"), "preserve")
  await assert.rejects(bootstrapAuthoringKit({ pinFile, target }), /unowned/)
  assert.equal(fs.readFileSync(path.join(target, "owned-by-user"), "utf8"), "preserve")
})

test("a same-version package from another kit is rejected before production", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kit-installed-"))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.writeFileSync(path.join(root, "package.json"), "{}")
  const directory = path.join(root, "node_modules/@cognia/example")
  fs.mkdirSync(directory, { recursive: true })
  fs.writeFileSync(
    path.join(directory, "package.json"),
    JSON.stringify({ name: "@cognia/example", version: "1.0.0", main: "index.js" })
  )
  fs.writeFileSync(path.join(directory, "index.js"), "module.exports = 42")
  const manifest = {
    packages: [
      {
        name: "@cognia/example",
        version: "1.0.0",
        files: { "index.js": digest("module.exports = 42") },
      },
    ],
  }
  verifyInstalledAuthoringPackages(root, manifest)
  fs.writeFileSync(path.join(directory, "index.js"), "module.exports = 43")
  assert.throws(() => verifyInstalledAuthoringPackages(root, manifest), /differs from selected kit/)
})

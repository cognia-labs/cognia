import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import {
  stripSourceConditions,
  declarationDependencies,
  readAuthoringKit,
} from "./authoring-kit.mjs"
import { sha256 } from "../build/plugin-artifact-contract.mjs"

test("the distributed export map cannot select Host source", () => {
  assert.deepEqual(
    stripSourceConditions({
      ".": { "cognia-source": "./src/index.ts", import: "./dist/index.js" },
    }),
    { ".": { import: "./dist/index.js" } }
  )
})

test("declaration closure requires real local files and detects undeclared package roots", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "kit-types-"))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  fs.writeFileSync(
    path.join(directory, "index.d.ts"),
    'export * from "./missing.js"; import type { Node } from "react"'
  )
  assert.throws(() => declarationDependencies(directory), /Unclosed declaration/)
  fs.writeFileSync(path.join(directory, "missing.d.ts"), "export type Value = string")
  assert.deepEqual([...declarationDependencies(directory)], ["react"])
})

test("kit files and manifest pin are verified before contracts are used", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "kit-digests-"))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  fs.mkdirSync(path.join(directory, "contract"))
  const files = {}
  for (const name of ["catalog", "style", "product-profile", "compiler"]) {
    fs.writeFileSync(path.join(directory, `contract/${name}.json`), "{}")
    files[`contract/${name}.json`] = sha256("{}")
  }
  const manifest = JSON.stringify({ schema: 1, authoring: {}, packages: [], files })
  fs.writeFileSync(path.join(directory, "authoring-kit.json"), manifest)
  assert.equal(readAuthoringKit(directory, sha256(manifest)).authoring.kitSha256, sha256(manifest))
  assert.throws(() => readAuthoringKit(directory, "0".repeat(64)), /manifest digest/)
  fs.writeFileSync(path.join(directory, "contract/style.json"), '{"tampered":true}')
  assert.throws(() => readAuthoringKit(directory, sha256(manifest)), /file digest/)
})

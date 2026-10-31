import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { createPluginCompilerContract } from "./plugin-compiler-contract.mjs"
import { buildFrontendPlugin } from "../plugin/build-frontend-plugins.mjs"

test("a foreign ES2022 tsconfig cannot change the Host's legacy class-field semantics", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-compiler-contract-"))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  fs.writeFileSync(
    path.join(directory, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: { target: "ES2018", strict: true, paths: { "@/*": ["./*"] } },
    })
  )
  const contract = { ...createPluginCompilerContract(directory), inputs: [] }
  assert.equal(contract.compilerOptions.useDefineForClassFields, false)
  assert.equal(contract.compilerOptions.paths, undefined)
  fs.writeFileSync(
    path.join(directory, "tsconfig.json"),
    JSON.stringify({ compilerOptions: { target: "ES2022" } })
  )
  const plugin = path.join(directory, "plugins/example")
  fs.mkdirSync(path.join(plugin, "src"), { recursive: true })
  const manifest = { id: "example", version: "1.0.0", type: "frontend", main: "src/index.ts" }
  fs.writeFileSync(path.join(plugin, "plugin.json"), JSON.stringify(manifest))
  fs.writeFileSync(
    path.join(plugin, "src/dependency.cjs"),
    "exports.__esModule = true; exports.default = 42"
  )
  fs.writeFileSync(
    path.join(plugin, "src/index.ts"),
    `class Base { set value(v) { this.observed = v } }; class Child extends Base { value = 42 }; export const probe = () => new Child().observed; export const cjsDefault = () => import('./dependency.cjs').then(m => m.default); export default {manifest:{...${JSON.stringify(manifest)},name:String(new Child().observed)}}`
  )
  const release = await buildFrontendPlugin({
    root: directory,
    directory: "example",
    compilerContract: contract,
  })
  const pluginModule = { exports: {} }
  new Function("module", "exports", release.files.get("dist/index.js").toString())(
    pluginModule,
    pluginModule.exports
  )
  assert.equal(pluginModule.exports.probe(), 42)
  assert.equal(release.manifest.name, "42")
  assert.equal(pluginModule.exports.default.manifest.name, release.manifest.name)
  assert.equal(await pluginModule.exports.cjsDefault(), 42)
  fs.writeFileSync(path.join(directory, "package.json"), '{"type":"module"}')
  await assert.rejects(
    buildFrontendPlugin({ root: directory, directory: "example", compilerContract: contract }),
    /package type differs/
  )
})

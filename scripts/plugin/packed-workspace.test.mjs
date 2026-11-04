import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { assertIsolatedWorkspacePackages, packWorkspaceClosure } from "./packed-workspace.mjs"

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "packed-workspace-test-"))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const repository = join(root, "repository")
  const archives = join(root, "archives")
  mkdirSync(archives)
  function packageAt(name, dependencies = {}) {
    const directory = join(repository, "packages", name)
    mkdirSync(directory, { recursive: true })
    writeFileSync(
      join(directory, "package.json"),
      JSON.stringify({
        name: `@cognia/${name}`,
        version: "1.0.0",
        type: "module",
        dependencies,
        exports: { import: "./index.js", require: "./index.cjs" },
      })
    )
    return directory
  }
  return { root, repository, archives, packageAt }
}

test("packed dependencies resolve in ESM and CJS after the checkout is removed", (t) => {
  const { root, repository, archives, packageAt } = fixture(t)
  const dependency = packageAt("dependency")
  writeFileSync(join(dependency, "index.js"), "export const value = 42")
  writeFileSync(join(dependency, "index.cjs"), "exports.value = 42")
  const entry = packageAt("entry", { "@cognia/dependency": "1.0.0" })
  writeFileSync(join(entry, "index.js"), 'export { value } from "@cognia/dependency"')
  writeFileSync(join(entry, "index.cjs"), 'module.exports = require("@cognia/dependency")')
  const packed = packWorkspaceClosure(repository, "@cognia/entry", archives)
  const consumer = join(root, "consumer")
  mkdirSync(join(consumer, "node_modules", "@cognia"), { recursive: true })
  for (const [name, archive] of packed) {
    const destination = join(consumer, "node_modules", name)
    mkdirSync(destination)
    execFileSync("tar", ["-xzf", archive, "--strip-components=1", "-C", destination])
  }
  rmSync(repository, { recursive: true })
  assertIsolatedWorkspacePackages(consumer, packed.keys())
  execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      'import {value} from "@cognia/entry"; if(value!==42) process.exit(1)',
    ],
    { cwd: consumer }
  )
  execFileSync(
    process.execPath,
    ["-e", 'if(require("@cognia/entry").value!==42) process.exit(1)'],
    { cwd: consumer }
  )
})

test("rejects a dependency that resolves through a workspace symlink", (t) => {
  const { root, packageAt } = fixture(t)
  const source = packageAt("dependency")
  const consumer = join(root, "consumer")
  mkdirSync(join(consumer, "node_modules", "@cognia"), { recursive: true })
  symlinkSync(source, join(consumer, "node_modules", "@cognia/dependency"), "dir")
  assert.throws(
    () => assertIsolatedWorkspacePackages(consumer, ["@cognia/dependency"]),
    /escapes the consumer/
  )
})

test("rejects cyclic workspace dependencies before installing a consumer", (t) => {
  const { repository, archives, packageAt } = fixture(t)
  packageAt("entry", { "@cognia/dependency": "1.0.0" })
  packageAt("dependency", { "@cognia/entry": "1.0.0" })
  assert.throws(
    () => packWorkspaceClosure(repository, "@cognia/entry", archives),
    /Workspace dependency cycle/
  )
})

test("does not require optional native platform distributions for an SDK consumer", (t) => {
  const { repository, archives, packageAt } = fixture(t)
  const entry = packageAt("entry")
  writeFileSync(
    join(entry, "package.json"),
    JSON.stringify({
      name: "@cognia/entry",
      version: "1.0.0",
      optionalDependencies: { "@cognia/unsupported-native-host": "1.0.0" },
    })
  )
  const packed = packWorkspaceClosure(repository, "@cognia/entry", archives)
  assert.deepEqual([...packed.keys()], ["@cognia/entry"])
})

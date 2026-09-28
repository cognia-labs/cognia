import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { resolve } from "node:path"

import {
  BUILDER_ONLY_EXTERNALS,
  BUILD_SCRIPT_SURFACES,
  NO_BUILD_SCRIPT_SURFACES,
  NO_PACKAGE_JSON_SURFACES,
  REPO_ROOT,
  SDK_SUBPATH_WILDCARD,
  bundlerExternalsFor,
  expectedAuthorExternals,
  expectedBuilderExternals,
  findExternalsDrift,
  hasBuildScript,
  readBuildScriptExternals,
  readEsbuildExternals,
  readSharedModules,
  readSurfaceExternals,
} from "./lib/plugin-externals.mjs"

test("the repository's four externals surfaces agree", () => {
  assert.deepEqual(findExternalsDrift(), [])
})

test("each parser finds real entries rather than silently returning nothing", () => {
  // A stale parser that returns [] would make every comparison trivially pass.
  assert.ok(readSharedModules().includes("react"))
  assert.ok(readSharedModules().includes("@cognia/plugin-sdk"))
  assert.ok(readEsbuildExternals().includes("react-dom"))
  for (const surface of BUILD_SCRIPT_SURFACES) {
    assert.ok(readSurfaceExternals(surface).length > 0, `${surface.path} parsed no externals`)
  }
})

test("react-dom is externalised by the CLI, by author builds, and shared by neither", () => {
  // The host refuses to share react-dom: createPortal would let a slot
  // contribution escape both its extension slot and its scoped stylesheet.
  assert.ok(!readSharedModules().includes("react-dom"))

  // The CLI externalises it anyway — it builds over trees whose node_modules
  // may carry react-dom transitively, and bundling a second reconciler is
  // worse than a clear require()-time refusal.
  assert.ok(readEsbuildExternals().includes("react-dom"))
  assert.deepEqual(BUILDER_ONLY_EXTERNALS, ["react-dom"])

  // Author build scripts deliberately omit it so their own build fails at
  // BUILD time with "Could not resolve react-dom" — earlier and clearer.
  // Pinned on the template side by ts_template_uses_only_the_public_sdk.
  for (const surface of BUILD_SCRIPT_SURFACES) {
    assert.ok(
      !readSurfaceExternals(surface).includes("react-dom"),
      `${surface.path} must not externalise react-dom — see crates/cognia-cli/src/engine/template.rs`
    )
  }
})

test("the two expectations differ by exactly the builder-only set", () => {
  const bundler = bundlerExternalsFor(readSharedModules())
  assert.deepEqual(expectedAuthorExternals(), bundler)
  assert.deepEqual(expectedBuilderExternals(), [...bundler, ...BUILDER_ONLY_EXTERNALS])
})

test("named SDK subpaths fold into the one wildcard a bundler passes", () => {
  // The loader's exact-match check needs `api/effort-surface` named; esbuild
  // matches literally, so a bundler covers every subpath with the wildcard.
  assert.ok(readSharedModules().some((entry) => entry.startsWith("@cognia/plugin-sdk/")))
  assert.deepEqual(
    bundlerExternalsFor(["react", "@cognia/plugin-sdk", "@cognia/plugin-sdk/api/x"]),
    ["react", "@cognia/plugin-sdk", SDK_SUBPATH_WILDCARD]
  )
  assert.deepEqual(bundlerExternalsFor(["react", "@cognia/plugin-sdk"]), [
    "react",
    "@cognia/plugin-sdk",
  ])
  assert.ok(readEsbuildExternals().includes(SDK_SUBPATH_WILDCARD))
})

test("a quoted wildcard flag parses without its shell quoting", () => {
  // The template quotes the wildcard so no shell globs its `*`.
  assert.ok(
    readBuildScriptExternals("crates/cognia-plugin-template-ts/package.json").includes(
      SDK_SUBPATH_WILDCARD
    )
  )
})

test("every shared module is externalised by both layers", () => {
  // This is the direction that breaks loudly: an inlined shared module means a
  // second React instance and "Invalid hook call" inside the host's tree.
  for (const shared of bundlerExternalsFor(readSharedModules())) {
    assert.ok(readEsbuildExternals().includes(shared), `builder drops ${shared}`)
    for (const surface of BUILD_SCRIPT_SURFACES) {
      assert.ok(readSurfaceExternals(surface).includes(shared), `${surface.path} drops ${shared}`)
    }
  }
})

test("templates listed as having no build script still have none", () => {
  // If one gains a build script it must be added to BUILD_SCRIPT_SURFACES, or
  // a scaffolded author would run an unchecked externals set.
  for (const { path } of NO_BUILD_SCRIPT_SURFACES) {
    assert.equal(hasBuildScript(path), false, `${path} gained a build script`)
  }
})

test("templates listed as having no package.json still have none", () => {
  for (const dir of NO_PACKAGE_JSON_SURFACES) {
    assert.equal(
      existsSync(resolve(REPO_ROOT, dir, "package.json")),
      false,
      `${dir} gained a package.json — decide whether its build needs checking`
    )
  }
})

test("the host-private aliases are gone from the builder externals", () => {
  // They made every bundle that used them unloadable: assertNoHostPrivateImports
  // scans the bundle text before (0, eval) and refuses any surviving `@/`.
  assert.deepEqual(
    readEsbuildExternals().filter((entry) => entry.startsWith("@/")),
    []
  )
})

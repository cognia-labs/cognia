#!/usr/bin/env node
/**
 * Gate: every surface that restates the plugin bundler externals contract agrees.
 *
 * Exits 0 when the four copies match, 1 with the specific disagreement
 * otherwise. The contract, the surfaces, and why drift matters are documented in
 * `lib/plugin-externals.mjs`, shared with this gate's test so the two cannot
 * disagree about what is being checked.
 *
 * A Rust unit test already pins the builder against the TypeScript source of
 * truth (`externals_match_host_shared_modules` and
 * `host_shared_modules_match_the_typescript_source_of_truth` in
 * `crates/cognia-cli/src/engine/frontend_build.rs`). This gate exists because
 * two of the four surfaces are `package.json` build scripts that no Rust test
 * runs — and those are the ones a plugin author actually executes.
 */

import { findExternalsDrift } from "./lib/plugin-externals.mjs"

const problems = findExternalsDrift()

if (problems.length > 0) {
  console.error(
    `[plugin-externals] ${problems.length} surface(s) disagree about which modules a\n` +
      `plugin bundle must leave external. A missing entry gets inlined (a second React\n` +
      `throws "Invalid hook call"); an extra one is refused by createPluginRequire at\n` +
      `load time.\n`
  )
  for (const problem of problems) console.error(`  ${problem}\n`)
  process.exitCode = 1
} else {
  console.log("[plugin-externals] all bundler externals surfaces agree.")
}

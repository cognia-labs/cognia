#!/usr/bin/env node
/**
 * Write `protocol/external-agent-launch.json`, the engine launch table both
 * process hosts read (ADR-0217). Descriptors are authored in the integration
 * packages (`launch` in a package `./manifest`, an ACP vendor profile, or the
 * ACP package's plain engines) and in the host's runner list; the table rules
 * live in `lib/agent-ecosystem/launch-table.ts`. `--check` fails on drift
 * (run by `pnpm audit:external-agent-launch`).
 *
 * Usage:
 *   node scripts/build/gen-external-agent-launch.mjs          # write the table
 *   node scripts/build/gen-external-agent-launch.mjs --check  # fail if it drifted
 */

import { existsSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import { loadTsExports, readText, renderJson, REPO_ROOT, writeOrCheck } from "./lib/generated-json.mjs"

const TABLE = join(REPO_ROOT, "protocol/external-agent-launch.json")

export async function renderLaunchTable() {
  const { buildEngineLaunchTable, INTEGRATION_MANIFESTS, ACP_ENGINE_LAUNCH, RUNNER_LAUNCH_DESCRIPTORS } =
    await loadTsExports(`
      export { buildEngineLaunchTable } from "@/lib/agent-ecosystem/launch-table"
      export { INTEGRATION_MANIFESTS } from "@/lib/agent-ecosystem/catalog"
      export { ACP_ENGINE_LAUNCH } from "@cognia/agent-acp/launch"
      export { RUNNER_LAUNCH_DESCRIPTORS } from "@/lib/ai/agent/external/policy/launch-runners"
    `)
  const table = buildEngineLaunchTable(INTEGRATION_MANIFESTS, ACP_ENGINE_LAUNCH, RUNNER_LAUNCH_DESCRIPTORS)
  const current = existsSync(TABLE) ? readText(TABLE) : ""
  return { current, next: await renderJson(TABLE, table) }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { current, next } = await renderLaunchTable()
  process.exitCode = writeOrCheck(TABLE, current, next, {
    check: process.argv.includes("--check"),
    label: "gen-external-agent-launch",
    hint: "Edit the launch descriptor in its package, then run: pnpm gen:external-agent-launch",
  })
}

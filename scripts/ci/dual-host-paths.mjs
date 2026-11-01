import { readChangePlan } from "./change-plan.mjs"
import { appendFileSync } from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"

const prefixes = [
  "lib/headless/",
  "lib/runtime/",
  // The sample behaviour's own path: the chat controller and its SDK event
  // projection, the direct-chat ledger writers, the sidecar SDK runtime both
  // hosts spawn, and the paired client's transports.
  "lib/execution/",
  "sidecar/src/runtimes/claude-agent-sdk/",
  "crates/cognia-companion/",
  "crates/cognia-companion-contract/src/generated/",
  "protocol/",
  "packages/plugin-contract/contract/",
  "tests/dual-host/",
  "tests/real-e2e/",
  "deploy/compose/",
  ".github/actions/checkout-cognia-services/",
]
const exact = new Set([
  "deploy/docker/Dockerfile.cognia-server",
  ".github/workflows/dual-host.yml",
  "scripts/ci/dual-host-paths.mjs",
  "scripts/ci/dual-host-paths.test.mjs",
  "playwright.dual-host.config.ts",
  "playwright.config.ts",
  "playwright.web-headless.config.ts",
  "tests/e2e/mocks/anthropic/server.ts",
  "lib/dev/expose-test-globals.tsx",
  "hooks/chat/use-claude-chat-controller.ts",
  "hooks/chat/claude-chat-events.ts",
  "lib/db/execution-runs.ts",
  "lib/tauri/transport-companion.ts",
  "lib/tauri/transport-rtc.ts",
  "integrations/cognia-services.json",
  "package.json",
])

export function isDualHostPath(file) {
  return (
    exact.has(file) ||
    prefixes.some((prefix) => file.startsWith(prefix)) ||
    /^crates\/cognia-companion-[^/]+\//.test(file)
  )
}

export function shouldRunDualHost(files, mode = "incremental") {
  return mode === "full" || files.some(isDualHostPath)
}

/** A failed planner cannot prove irrelevance; a selected lane must actually succeed. */
export function dualHostRequiredPasses(relevanceResult, selected, laneResult) {
  return (
    relevanceResult === "success" &&
    (selected === "false" || (selected === "true" && laneResult === "success"))
  )
}

/**
 * "pass", "fail", or "warn": while the lane is report-only (blocking is not the
 * string "true"), a lane that should have passed yields "warn" instead of
 * failing the required job. A failed relevance planner always fails; it cannot
 * prove irrelevance and is not a harness bug.
 */
export function dualHostVerdict(relevanceResult, selected, laneResult, blocking) {
  if (dualHostRequiredPasses(relevanceResult, selected, laneResult)) return "pass"
  if (relevanceResult !== "success") return "fail"
  return blocking === "true" ? "fail" : "warn"
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const plan = readChangePlan(process.argv[2])
  const relevant = shouldRunDualHost(plan.changedFiles, plan.mode)
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `relevant=${relevant}\n`)
  process.stdout.write(`Dual-host lane: ${relevant ? "selected" : "unrelated"} (${plan.reason})\n`)
}

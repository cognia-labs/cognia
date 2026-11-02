import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"
import { parse } from "yaml"
import {
  isDualHostPath,
  shouldRunDualHost,
  dualHostRequiredPasses,
  dualHostVerdict,
} from "./dual-host-paths.mjs"

test("runtime, companion crates, contracts and harness inputs select the lane", () => {
  for (const path of [
    "lib/headless/bootstrap.ts",
    "lib/runtime/browser-vault.ts",
    "crates/cognia-companion/src/lib.rs",
    "crates/cognia-companion-security/src/lib.rs",
    "crates/cognia-companion-contract/src/generated/rpc.rs",
    "protocol/rpc.json",
    "packages/plugin-contract/contract/rpc.json",
    "tests/dual-host/chat-tool-turn.spec.ts",
    "tests/real-e2e/helpers/pairing.ts",
    "deploy/compose/docker-compose.yml",
    "deploy/docker/Dockerfile.cognia-server",
    "deploy/compose/Dockerfile.web",
    ".dockerignore",
    ".github/actions/plugin-artifact-set/action.yml",
    ".github/workflows/dual-host.yml",
    "scripts/ci/dual-host-paths.mjs",
    "playwright.dual-host.config.ts",
    "tests/e2e/mocks/anthropic/server.ts",
    "lib/dev/expose-test-globals.tsx",
    "integrations/cognia-services.json",
  ])
    assert.equal(isDualHostPath(path), true, path)
})

test("an ordinary incremental PR that edits the sample's chat or ledger path selects the lane", () => {
  for (const path of [
    "hooks/chat/use-claude-chat-controller.ts",
    "hooks/chat/claude-chat-events.ts",
    "lib/execution/direct-chat-run.ts",
    "lib/execution/sources/agent-turn.ts",
    "lib/db/execution-runs.ts",
    "sidecar/src/runtimes/claude-agent-sdk/options.ts",
    "lib/tauri/transport-companion.ts",
  ])
    assert.equal(shouldRunDualHost([path], "incremental"), true, path)
})

test("unrelated paths and similar prefixes do not select the lane", () => {
  for (const path of [
    "docs/README.md",
    "components/ui/button.tsx",
    "lib/runtime-other/file.ts",
    "crates/cognia-companionship/src/lib.rs",
    "packages/plugin-contract/contract-other/file.json",
    "deploy/docker/Dockerfile.cognia-server-other",
  ])
    assert.equal(isDualHostPath(path), false, path)
  assert.equal(shouldRunDualHost([]), false)
  assert.equal(shouldRunDualHost(["docs/README.md", "protocol/deleted.json"]), true)
})

test("unknown/full diffs run conservatively; skipped unrelated lanes pass", () => {
  assert.equal(shouldRunDualHost([], "full"), true)
  assert.equal(dualHostRequiredPasses("success", "false", "skipped"), true)
  assert.equal(dualHostRequiredPasses("success", "true", "success"), true)
  for (const result of ["failure", "cancelled", "skipped"]) {
    assert.equal(dualHostRequiredPasses("success", "true", result), false)
  }
  assert.equal(dualHostRequiredPasses("failure", "", "skipped"), false)
})

test("report-only mode warns on a failed lane; blocking mode fails it; a failed planner always fails", () => {
  assert.equal(dualHostVerdict("success", "true", "success", "false"), "pass")
  assert.equal(dualHostVerdict("success", "false", "skipped", "false"), "pass")
  for (const lane of ["failure", "cancelled"]) {
    assert.equal(dualHostVerdict("success", "true", lane, "false"), "warn")
    assert.equal(dualHostVerdict("success", "true", lane, undefined), "warn")
    assert.equal(dualHostVerdict("success", "true", lane, "true"), "fail")
  }
  assert.equal(dualHostVerdict("failure", "", "skipped", "false"), "fail")
})

test("the lane ships report-only, and the desktop parity step cannot fail the Tauri job", () => {
  const workflow = parse(
    readFileSync(new URL("../../.github/workflows/dual-host.yml", import.meta.url), "utf8")
  )
  assert.equal(workflow.env.DUAL_HOST_BLOCKING, "false")
  const step = workflow.jobs["dual-host-required"].steps.find(
    (s) => s.name === "Require the selected lane to succeed"
  )
  assert.match(step.run, /dualHostVerdict/)
  assert.match(step.env.DUAL_HOST_BLOCKING, /env\.DUAL_HOST_BLOCKING/)
  const desktop = parse(
    readFileSync(new URL("../../.github/workflows/test.yml", import.meta.url), "utf8")
  ).jobs["e2e-tauri"].steps.find((s) => s.run === "pnpm test:e2e:dual-host:desktop")
  assert.equal(desktop["continue-on-error"], true)
})

test("workflow always reports its required status and uses the slim minimal stack", () => {
  const workflow = parse(
    readFileSync(new URL("../../.github/workflows/dual-host.yml", import.meta.url), "utf8")
  )
  assert.ok(Object.hasOwn(workflow.on, "pull_request"))
  assert.equal(workflow.on.pull_request?.paths, undefined)
  assert.equal(workflow.on.push?.paths, undefined)
  const lane = workflow.jobs.lane
  assert.equal(lane["timeout-minutes"], 180)
  const runtime = lane.steps.findIndex(
    (step) => step.uses === "crazy-max/ghaction-github-runtime@v3"
  )
  const build = lane.steps.findIndex((step) => step.name === "Build cognia-server (runtime-slim)")
  assert.ok(runtime >= 0 && runtime < build, "raw Buildx has the Actions cache runtime")
  const runs = lane.steps.map((step) => step.run ?? "").join("\n")
  assert.match(runs, /--target runtime-slim/)
  assert.doesNotMatch(runs, /--target runtime-full|--profile web-headless-e2e|--profile collab/)
  assert.match(runs, /--cache-from "type=registry,ref=ghcr.io/)
  assert.match(runs, /--cache-from type=gha,scope=dual-host/)
  assert.match(runs, /--cache-to type=gha,scope=dual-host,mode=max/)
  assert.match(runs, /--profile server --profile tls up -d --wait cognia-server caddy/)
  // caddy depends on cognia-server: building it with only `tls` is an invalid project.
  assert.match(runs, /--profile server --profile tls build caddy/)
  assert.match(runs, /test:e2e:dual-host:web-headless/)
  // Both images take plugins only as the set produced before either builds.
  const produce = lane.steps.findIndex(
    (step) => step.uses === "./.github/actions/plugin-artifact-set"
  )
  const web = lane.steps.findIndex((step) => step.name === "Build same-origin Web/Caddy image")
  assert.ok(produce >= 0 && produce < build && produce < web, "plugin set precedes both images")
  assert.match(runs, /--build-context plugin-artifacts="\$PLUGIN_ARTIFACTS"/)
  assert.match(lane.steps[web].env.COGNIA_PLUGIN_ARTIFACTS_CONTEXT, /steps\.plugins\.outputs\.path/)
  assert.equal(lane.steps.find((step) => step.name === "Down").if, "always()")
  const required = workflow.jobs["dual-host-required"]
  assert.equal(required.if, "always()")
  assert.deepEqual(required.needs, ["relevance", "lane"])
  assert.match(
    required.steps.find((step) => step.name === "Require the selected lane to succeed").run,
    /dualHostVerdict/
  )
  const desktopWorkflow = parse(
    readFileSync(new URL("../../.github/workflows/test.yml", import.meta.url), "utf8")
  )
  const desktopSteps = desktopWorkflow.jobs["e2e-tauri"].steps
  const existing = desktopSteps.findIndex((step) => step.name === "Run Playwright tauri project")
  const parity = desktopSteps.findIndex((step) => step.run === "pnpm test:e2e:dual-host:desktop")
  assert.ok(existing >= 0 && parity > existing)
})

import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import test from "node:test"

import {
  EVAL_UI_BOUNDARIES,
  extractModuleReferences,
  findEvalUiBoundaryViolations,
  findPackageBoundaryViolations,
  findPackageManifestViolations,
  findAgentHostBoundaryViolations,
} from "./check-package-boundaries.mjs"

test("requires declarations for runtime exports and type-only package references", (t) => {
  const { root, write } = fixture(t, "")
  write(
    "packages/plugin-contract/package.json",
    JSON.stringify({ name: "@cognia/plugin-contract" })
  )
  write(
    "packages/plugin-contract/src/index.ts",
    [
      'export { normalizeCogniaModelBinding } from "@cognia/agent-contracts/external-agent"',
      'import type { Model } from "@cognia/provider-types"',
    ].join("\n")
  )
  assert.deepEqual(
    findPackageManifestViolations(root, ["plugin-contract"]).map(({ target }) => target),
    ["@cognia/agent-contracts", "@cognia/provider-types"]
  )
  write(
    "packages/plugin-contract/package.json",
    JSON.stringify({
      name: "@cognia/plugin-contract",
      dependencies: {
        "@cognia/agent-contracts": "workspace:*",
        "@cognia/provider-types": "workspace:*",
      },
    })
  )
  assert.deepEqual(findPackageManifestViolations(root, ["plugin-contract"]), [])
})

test("contract ownership cannot point back to SDK or configuration facades, even through types", (t) => {
  const { root, write } = fixture(t, "")
  write(
    "packages/plugin-contract/package.json",
    JSON.stringify({
      name: "@cognia/plugin-contract",
      dependencies: {
        "@cognia/plugin-sdk": "workspace:*",
        "@cognia/agent-config-types": "workspace:*",
      },
    })
  )
  write(
    "packages/plugin-contract/src/index.ts",
    [
      'export type { Pack } from "@cognia/plugin-sdk/api/character-pack"',
      'type Options = import("@cognia/agent-config-types").SendOptions',
    ].join("\n")
  )
  assert.deepEqual(
    findPackageManifestViolations(root, ["plugin-contract"]).map(({ rule }) => rule),
    ["contract-upper-layer-dependency", "contract-upper-layer-dependency"]
  )
})

test("rejects preset/runtime aliases, returned launch recipes and copied CLI vendor helpers", (t) => {
  const { root, write } = fixture(t, "export const portable = 1")
  write(
    "lib/ai/agent/external/manager.ts",
    'const preset = config.metadata?.preset; if (preset === "kimi") deleted.set(id, Date.now()); if(config.metadata.preset === "kimi") run(); switch(config.runtimeId){case "codex": run()} const runtime = resolve(config); if(runtime === "codex") project()'
  )
  write(
    "lib/ai/agent/external/config/gateway-task.ts",
    "export function project() { for (const runtime of runtimes) write(runtime) }"
  )
  write(
    "lib/ai/agent/external/config/pi-subagents.ts",
    "export function detect() { const supported = new Map(); while (enabled()) scan() }"
  )
  write(
    "cli/src/runtime/external/codex-model-catalog.ts",
    "export function buildCodexModelCatalog() { return JSON.stringify({models:[]}) }"
  )
  write(
    "cli/src/runtime/external/devin-mcp-config.ts",
    "function parseJsonc(raw) { return JSON.parse(raw) }"
  )
  const violations = findAgentHostBoundaryViolations(root)
  assert.equal(violations.filter((v) => v.rule === "manager-runtime-branch").length, 4)
  assert.ok(
    violations.some(
      (v) => v.file.endsWith("config/gateway-task.ts") && v.rule === "host-runtime-loop"
    )
  )
  assert.ok(
    violations.some(
      (v) => v.file.endsWith("config/pi-subagents.ts") && v.rule === "host-runtime-state"
    )
  )
  assert.ok(
    violations.some(
      (v) => v.file.endsWith("codex-model-catalog.ts") && v.rule === "native-compatibility-entry"
    )
  )
  assert.ok(violations.some((v) => v.rule === "host-vendor-configuration"))
})

test("permits bounded Host Pi traversal and package recipe delegation", (t) => {
  const { root, write } = fixture(t, "export const portable = 1")
  write(
    "lib/ai/agent/external/config/pi-subagents.ts",
    "async function hostDeps() { for (const path of grantedPaths) await host.read(path) }; export const detect = config => core(config, hostDeps)"
  )
  write(
    "lib/ai/agent/external/config/gateway-task.ts",
    "export const project = input => tools.buildGatewayTaskConfig(input)"
  )
  write(
    "cli/src/runtime/external/codex-model-catalog.ts",
    'export * from "@cognia/agent-codex/model-catalog"'
  )
  assert.deepEqual(findAgentHostBoundaryViolations(root), [])
})

test("rejects vendor imports, protocol branches and state machines returning to the app", (t) => {
  const { root, write } = fixture(t, "export const portable = 1")
  write("packages/agent-example/src/client.ts", "export class Vendor {}")
  write(
    "lib/ai/agent/external/manager.ts",
    'import { Vendor } from "../../../../packages/agent-example/src/client"; if (config.protocol === "example") run()'
  )
  write(
    "lib/ai/agent/external/integrations/new-vendor.ts",
    "class Daemon { private owners = new Map() }; while (ready()) probe()"
  )
  write(
    "lib/ai/agent/external/lifecycle/service.ts",
    "class Service { private leases = new Map(); connect() {} }"
  )
  write("cli/src/runtime/external/hermes-acp-bridge.ts", "export function run() { return spawn() }")
  write("cli/src/runtime/external/agent-path.ts", 'export * from "./legacy-path-driver"')
  const violations = findAgentHostBoundaryViolations(root)
  assert.ok(violations.some((item) => item.rule === "manager-vendor-import"))
  assert.ok(violations.some((item) => item.rule === "manager-protocol-branch"))
  assert.ok(violations.some((item) => item.rule === "host-runtime-state"))
  assert.ok(violations.some((item) => item.rule === "host-runtime-loop"))
  assert.ok(violations.some((item) => item.rule === "native-compatibility-entry"))
  assert.ok(violations.some((item) => item.file.endsWith("agent-path.ts")))
})

test("accepts Host port assembly and ignores comments, test fixtures and neutral imports", (t) => {
  const { root, write } = fixture(t, "export const portable = 1")
  write(
    "lib/ai/agent/external/manager.ts",
    'import type { Config } from "@cognia/agent-contracts"; // config.protocol === "vendor"'
  )
  write(
    "lib/ai/agent/external/integrations/acp.ts",
    "export const create = () => new Client({ processHost: host }); // new Map()"
  )
  write("lib/ai/agent/external/integrations/acp.test.ts", "class Fake { owners = new Map() }")
  write(
    "lib/ai/agent/external/lifecycle/service.ts",
    "export class Service extends Core { constructor(host) { super(host) } }"
  )
  write(
    "cli/src/runtime/external/hermes-acp-bridge.ts",
    'export * from "@cognia/agent-acp/hermes-acp-bridge"'
  )
  assert.deepEqual(findAgentHostBoundaryViolations(root), [])
})

function fixture(t, source) {
  const root = mkdtempSync(join(tmpdir(), "package-boundaries-"))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  function write(file, content) {
    mkdirSync(dirname(join(root, file)), { recursive: true })
    writeFileSync(join(root, file), content)
  }
  write(
    "tsconfig.json",
    JSON.stringify({
      compilerOptions: {
        moduleResolution: "bundler",
        paths: {
          "@/*": ["./*"],
          "@host/*": ["./lib/*"],
          "@cognia/other": ["./packages/other/src/index.ts"],
        },
      },
    })
  )
  write("packages/example/src/index.ts", source)
  write("packages/example/src/local.ts", "export const local = 1")
  write("packages/other/src/index.ts", "export const other = 2")
  write("lib/host.ts", "export const host = 3")
  return { root, write }
}

test("reads value, type, re-export, import-type, require and lazy module references", () => {
  const refs = extractModuleReferences(
    [
      'import { a } from "value"',
      'import type { B } from "types"',
      'export type { C } from "exported-type"',
      'export * from "exported-value"',
      'type D = import("import-type").D',
      'const lazy = import("lazy")',
      'const cjs = require("cjs")',
      'import legacy = require("legacy")',
      "const template = import(`template`)",
      '// import fake from "comment"',
      "const text = \"require('text')\"",
    ].join("\n")
  )
  assert.deepEqual(refs, [
    { specifier: "value", line: 1 },
    { specifier: "types", line: 2 },
    { specifier: "exported-type", line: 3 },
    { specifier: "exported-value", line: 4 },
    { specifier: "import-type", line: 5 },
    { specifier: "lazy", line: 6 },
    { specifier: "cjs", line: 7 },
    { specifier: "legacy", line: 8 },
    { specifier: "template", line: 9 },
  ])
})

test("rejects host imports through root aliases, custom aliases and relative paths", (t) => {
  const { root } = fixture(
    t,
    [
      'import { host } from "@/lib/host"',
      'export { host } from "../../../lib/host"',
      'type Host = import("@host/host").Host',
      'const host = import("../../../lib/host")',
    ].join("\n")
  )
  const violations = findPackageBoundaryViolations(root, ["example"])
  assert.deepEqual(
    violations.map(({ specifier, line, target }) => ({ specifier, line, target })),
    [
      { specifier: "@/lib/host", line: 1, target: "lib/host.ts" },
      { specifier: "../../../lib/host", line: 2, target: "lib/host.ts" },
      { specifier: "@host/host", line: 3, target: "lib/host.ts" },
      { specifier: "../../../lib/host", line: 4, target: "lib/host.ts" },
    ]
  )
})

test("permits local modules, other packages and external dependencies", (t) => {
  const { root, write } = fixture(
    t,
    [
      'import { local } from "./local"',
      'import { other } from "@cognia/other"',
      'import { external } from "external"',
    ].join("\n")
  )
  write("node_modules/external/package.json", '{"name":"external","types":"index.d.ts"}')
  write("node_modules/external/index.d.ts", "export declare const external: number")
  // This gate governs library source. Host integration tests have their own
  // owner and may need to exercise the application that supplies the adapter.
  write("packages/example/src/index.test.ts", 'import { host } from "@/lib/host"')
  assert.deepEqual(findPackageBoundaryViolations(root, ["example"]), [])
})

test("deleted direct host targets and similar directory prefixes cannot bypass the boundary", (t) => {
  const { root, write } = fixture(
    t,
    [
      'export * from "@/lib/deleted"',
      'export * from "../../../lib/missing"',
      'export * from "../../../packages-private/helper"',
    ].join("\n")
  )
  write("packages-private/helper.ts", "export const hidden = true")
  assert.deepEqual(
    findPackageBoundaryViolations(root, ["example"]).map((v) => v.target),
    ["lib/deleted", "lib/missing", "packages-private/helper.ts"]
  )
})

test("library source does not depend on the application tree", () => {
  assert.deepEqual(findPackageBoundaryViolations(), [])
})

test("eval UI rejects persistence/store paths through aliases, types and relative lazy imports", (t) => {
  const { root, write } = fixture(t, "")
  write(
    "components/eval/panel.tsx",
    [
      'import type { Row } from "@/lib/db/rows"',
      'const store = import("../../stores/account")',
      'export { host } from "@host/host"',
      'import { domain } from "@cognia/other"',
      'import { Card } from "@/components/ui/card"',
    ].join("\n")
  )
  const rules = [{ file: "components/eval/panel.tsx", forbidden: ["lib", "stores"] }]
  assert.deepEqual(
    findEvalUiBoundaryViolations(root, rules).map(({ target }) => target),
    ["lib/db/rows", "stores/account", "lib/host.ts"]
  )
})

test("selected eval views consume domain data and application use cases", () => {
  assert.deepEqual(findEvalUiBoundaryViolations(), [])
})

test("an eval UI store exception does not permit foreign or similarly named stores", (t) => {
  const { root, write } = fixture(t, "")
  write(
    "components/eval/panel.tsx",
    [
      'import { own } from "@/stores/eval/run"',
      'import { foreign } from "@/stores/settings/store"',
      'import { other } from "@/stores/eval-private/run"',
    ].join("\n")
  )
  const rules = [
    { file: "components/eval/panel.tsx", forbidden: ["stores"], allowed: ["stores/eval"] },
  ]
  assert.deepEqual(
    findEvalUiBoundaryViolations(root, rules).map(({ target }) => target),
    ["stores/settings/store", "stores/eval-private/run"]
  )
})

test("execution and review views cannot bypass their application service", (t) => {
  const { root, write } = fixture(t, "")
  write("lib/ai/eval/orchestrator.ts", "export const engine = 1")
  write("lib/ai/eval/review-service.ts", "export type Service = unknown")
  write("lib/ai/eval/finalization.ts", "export const finalize = 1")
  write(
    "components/eval/eval-lab-workspace.tsx",
    'const engine = import("../../lib/ai/eval/orchestrator")'
  )
  write(
    "components/eval/blind-review-panel.tsx",
    [
      'import type { Service } from "@/lib/ai/eval/review-service"',
      'import { finalize } from "@/lib/ai/eval/finalization"',
    ].join("\n")
  )
  const rules = EVAL_UI_BOUNDARIES.filter(({ file }) =>
    /(?:eval-lab-workspace|blind-review-panel)\.tsx$/.test(file)
  )
  assert.deepEqual(
    findEvalUiBoundaryViolations(root, rules)
      .map(({ target }) => target)
      .sort(),
    ["lib/ai/eval/finalization.ts", "lib/ai/eval/orchestrator.ts"]
  )
})

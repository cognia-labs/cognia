/**
 * Offline meeting-capability audit. Run from the repository root:
 * rtk proxy node docs/evidence/2026-11-17-meeting-participation-gap-audit.probes.mjs
 * Only local --version/--help CLI commands execute. No credentials or API calls.
 * This documents the audited boundary; it is not a product regression test.
 */
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import fs from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"

const require = createRequire(path.resolve("package.json"))
const ts = require("typescript")
const root = process.cwd()
const outputDirectory = path.join(root, ".cache/meeting-participation-audit-20261117")
fs.mkdirSync(outputDirectory, { recursive: true })
const sources = []

function loadSource(file, replacements = {}) {
  const source = fs.readFileSync(path.join(root, file), "utf8")
  sources.push({ path: file, sha256: createHash("sha256").update(source).digest("hex") })
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText
  const compiledModule = { exports: {} }
  const localRequire = (name) => {
    if (Object.hasOwn(replacements, name)) return replacements[name]
    if (name === "zod") return require(name)
    throw new Error(`Unexpected import in offline probe: ${name}`)
  }
  new Function("require", "module", "exports", compiled)(
    localRequire,
    compiledModule,
    compiledModule.exports
  )
  return compiledModule.exports
}

function help(args) {
  assert(args.includes("--help") || args.join(" ") === "--version")
  const result = spawnSync("lark-cli", args, { encoding: "utf8", timeout: 10000 })
  assert.equal(result.status, 0, result.stderr || String(result.error ?? "CLI failed"))
  return result.stdout + result.stderr
}

let processCalls = 0
const capabilities = loadSource("lib/skills/built-in/lark/capabilities.ts", {
  "@/lib/auth-providers/feishu/cli/process": {
    runLarkCliProcess() {
      processCalls += 1
      throw new Error("Offline audit must not spawn an authenticated CLI process")
    },
  },
})
const version = help(["--version"]).trim()
const commands = [
  "+meeting-join",
  "+meeting-leave",
  "+meeting-list-active",
  "+meeting-events",
  "+meeting-message-send",
  "+detail",
]
const results = []
for (const command of commands) {
  const output = help(["vc", command, "--help"])
  const args = ["vc", command]
  await assert.rejects(
    capabilities.assertLarkCliCommandAvailable(args),
    /not in the certified capability manifest/
  )
  results.push({
    command: args.join(" "),
    exposedByLocalCli: output.includes(command),
    rejectedByCogniaCapabilityGate: true,
  })
}
assert.equal(processCalls, 0)
assert.equal(Object.keys(capabilities.LARK_CLI_CAPABILITY_MANIFEST).length, 43)

const unexpectedCall = () => {
  throw new Error("Unexpected authenticated operation in offline probe")
}
const helpers = loadSource("lib/skills/built-in/lark/_helpers.ts", {
  "../registry": { registerBuiltInSkill: unexpectedCall },
  "@/lib/auth-providers/feishu/cli/auth-bridge": { resolveLarkAdapter: unexpectedCall },
  "@/lib/auth-providers/feishu/cli/exec-lark-cli": { execLarkCli: unexpectedCall },
  "./capabilities": capabilities,
  "../_shared/confirm-surface": { buildConfirmSurface: unexpectedCall },
})
const syntheticEventPage = {
  events: [{ event_id: "synthetic-event", payload: { text: "a".repeat(30000) } }],
  has_more: true,
  page_token: "synthetic-cursor",
}
const displayedPage = helpers.capLarkData(syntheticEventPage)
assert.equal(displayedPage.truncated, true)
assert.equal(displayedPage.page_token, undefined)
assert.equal(displayedPage.events, undefined)

const calendar = loadSource("plugins/feishu-calendar/src/api.ts")
const baseEvent = {
  summary: "Synthetic offline meeting schema probe",
  start_time: { timestamp: "1794877200" },
  end_time: { timestamp: "1794880800" },
}
assert.equal(calendar.eventCreateSchema.safeParse(baseEvent).success, true)
const withConference = calendar.eventCreateSchema.safeParse({
  ...baseEvent,
  vchat: { vc_type: "vc" },
})
assert.equal(withConference.success, false)
const fields = Object.keys(calendar.EVENT_CREATE_SCHEMA.properties)
const manifest = JSON.parse(
  fs.readFileSync(path.join(root, "plugins/feishu-calendar/plugin.json"), "utf8")
)
const report = {
  auditedAt: new Date().toISOString(),
  nodeVersion: process.version,
  typescriptVersion: ts.version,
  cliVersion: version,
  scope:
    "Local help and actual TypeScript functions evaluated with the process boundary disabled. No provider requests.",
  certifiedCommandCount: Object.keys(capabilities.LARK_CLI_CAPABILITY_MANIFEST).length,
  vcCommandsInManifest: Object.values(capabilities.LARK_CLI_CAPABILITY_MANIFEST).filter(
    (entry) => entry[0] === "vc"
  ).length,
  processCallsFromCapabilityProbe: processCalls,
  commands: results,
  modelDisplayCap: {
    limitChars: helpers.MAX_RESULT_DISPLAY_CHARS,
    rawChars: JSON.stringify(syntheticEventPage).length,
    resultKeys: Object.keys(displayedPage),
    structuredCursorPreserved: Object.hasOwn(displayedPage, "page_token"),
    note: "Intentional display bounding; ingest raw event data before applying this helper.",
  },
  calendar: {
    createFields: fields,
    vchatRejected: !withConference.success,
    vchatErrors: withConference.error.issues.map((issue) => ({
      code: issue.code,
      path: issue.path,
      keys: issue.keys,
    })),
    networkRules: manifest.networkAccess.rules,
    runtimeCompatibility: manifest.runtimeCompatibility,
  },
  sources,
}
fs.writeFileSync(
  path.join(outputDirectory, "capability-results.json"),
  `${JSON.stringify(report, null, 2)}\n`
)
console.log(JSON.stringify(report, null, 2))

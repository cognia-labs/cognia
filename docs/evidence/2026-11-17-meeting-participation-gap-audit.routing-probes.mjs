/**
 * Offline conditional-routing probe. Run from repository root:
 * rtk proxy node docs/evidence/2026-11-17-meeting-participation-gap-audit.routing-probes.mjs
 *
 * Evaluates the actual parser module and actual dispatchEnvelope initializer
 * extracted with the TypeScript AST. Unrelated imports and effects are replaced
 * with local fakes. No WebSocket, CLI subprocess, network, credentials or device.
 * This does not reproduce real dual-client delivery loss or a wire-level ACK.
 */
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { createRequire } from "node:module"

const root = process.cwd()
const require = createRequire(path.join(root, "package.json"))
const ts = require("typescript")
const outputDirectory = path.join(root, ".cache/meeting-research-20261118")
const sourcePaths = [
  "lib/connectors/adapters/lark/parse.ts",
  "lib/connectors/adapters/lark/index.ts",
  "lib/connectors/adapters/lark/transport-long-conn.ts",
  "crates/cognia-connectors/src/lark_ws.rs",
]
const sources = new Map(
  sourcePaths.map((file) => [file, fs.readFileSync(path.join(root, file), "utf8")])
)
const compilerOptions = { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
const unexpectedCalls = []
const unexpected =
  (name) =>
  (...args) => {
    unexpectedCalls.push({ name, argumentCount: args.length })
    throw new Error(`Unrelated dependency unexpectedly invoked: ${name}`)
  }
const moduleObject = { exports: {} }
const fakeRequire = (name) => {
  if (name === "@/types/connectors/event") {
    return { buildConversationKey: (...parts) => parts.join(":synthetic:") }
  }
  return new Proxy({}, { get: (_object, property) => unexpected(`${name}.${String(property)}`) })
}
new Function(
  "require",
  "module",
  "exports",
  ts.transpileModule(sources.get(sourcePaths[0]), {
    compilerOptions,
  }).outputText
)(fakeRequire, moduleObject, moduleObject.exports)
const { parseLarkEventEnvelope } = moduleObject.exports

const sourceFile = ts.createSourceFile(
  sourcePaths[1],
  sources.get(sourcePaths[1]),
  ts.ScriptTarget.Latest,
  true
)
function variableInitializer(name) {
  const matches = []
  function walk(node) {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === name &&
      node.initializer
    ) {
      matches.push(node.initializer.getText(sourceFile))
    }
    ts.forEachChild(node, walk)
  }
  walk(sourceFile)
  assert.equal(matches.length, 1, `Expected exactly one ${name} declaration`)
  return matches[0]
}
const informationalEvents = new Function(
  `return (${variableInitializer("LARK_INFORMATIONAL_EVENTS")})`
)()
const dispatchSource = ts.transpileModule(
  `module.exports = ${variableInitializer("dispatchEnvelope")}`,
  {
    compilerOptions,
  }
).outputText

function envelope(eventType, index, event = {}) {
  return {
    schema: "2.0",
    header: {
      event_id: `synthetic-event-${index}`,
      event_type: eventType,
      app_id: "cli_synthetic",
      tenant_key: "synthetic-tenant",
      create_time: "1794960000000",
    },
    event,
  }
}

async function observe(input) {
  const effects = {
    inboundActivity: 0,
    tenantMetadataBackfill: 0,
    gateCalls: 0,
    emitted: [],
    logs: [],
  }
  const bindings = {
    opts: { id: "synthetic-adapter", selfBotOpenId: "ou_synthetic_bot" },
    markInboundActivity: () => {
      effects.inboundActivity++
    },
    maybeBackfillTenantKey: async () => {
      effects.tenantMetadataBackfill++
    },
    loggers: {
      network: Object.fromEntries(
        ["info", "warn", "debug"].map((level) => [
          level,
          (message, fields) => {
            effects.logs.push({ level, message, eventType: fields?.eventType })
          },
        ])
      ),
    },
    parseLarkEventEnvelope,
    LARK_INFORMATIONAL_EVENTS: informationalEvents,
    gateInboundEvent: async () => {
      effects.gateCalls++
      return true
    },
    enrichLarkInboundMedia: async () => {},
    ctx: {
      emit: async (event) => {
        effects.emitted.push({ kind: event.kind, systemKind: event.systemKind })
      },
    },
  }
  const mod = { exports: {} }
  new Function(...Object.keys(bindings), "module", `let lastActivityAt = 0;\n${dispatchSource}`)(
    ...Object.values(bindings),
    mod
  )
  const parsed = parseLarkEventEnvelope(bindings.opts.id, bindings.opts.selfBotOpenId, input)
  await mod.exports(input)
  return {
    eventType: input.header.event_type,
    parseReturnedNull: parsed === null,
    effects,
  }
}

const vcEventTypes = [
  "vc.note.generated_v1",
  "vc.meeting.participant_meeting_started_v1",
  "vc.meeting.participant_meeting_joined_v1",
  "vc.meeting.participant_meeting_ended_v1",
]
const results = []
for (const [index, eventType] of vcEventTypes.entries()) {
  const result = await observe(
    envelope(eventType, index, {
      meeting_id: "synthetic-meeting-instance",
      meeting_no: "123456789",
      note_id: "synthetic-note",
    })
  )
  assert.equal(result.parseReturnedNull, true)
  assert.equal(result.effects.gateCalls, 0)
  assert.equal(result.effects.emitted.length, 0)
  assert.equal(result.effects.logs.filter((entry) => entry.level === "warn").length, 1)
  results.push(result)
}
const positiveControl = await observe(
  envelope("im.message.message_read_v1", "control", {
    message_id_list: ["om_synthetic"],
    reader: { reader_id: { open_id: "ou_synthetic_reader" } },
  })
)
assert.equal(positiveControl.parseReturnedNull, false)
assert.equal(positiveControl.effects.gateCalls, 1)
assert.deepEqual(positiveControl.effects.emitted, [
  { kind: "system", systemKind: "read_indicator" },
])
assert.equal(unexpectedCalls.length, 0)

const report = {
  auditedAt: new Date().toISOString(),
  nodeVersion: process.version,
  typescriptVersion: ts.version,
  scope:
    "Actual source parser and extracted dispatcher with fake side effects; no provider or wire-level ACK executed.",
  limitations: [
    "Same-app competing-client delivery loss is a conditional inference, not reproduced.",
    "Rust ordinary-event ACK behavior is established by source review only.",
    "Metadata activity/backfill effects are faked; no assertion is made that unknown envelopes cause zero metadata writes.",
    "Only the supported IM positive control uses a synthetic buildConversationKey import.",
  ],
  sources: [...sources].map(([file, source]) => ({
    path: file,
    sha256: createHash("sha256").update(source).digest("hex"),
  })),
  results,
  positiveControl,
  unexpectedCalls,
  vcEventsDroppedBeforeNormalizedBus: results.every(
    (result) => result.parseReturnedNull && result.effects.emitted.length === 0
  ),
}
fs.mkdirSync(outputDirectory, { recursive: true })
fs.writeFileSync(
  path.join(outputDirectory, "conditional-routing-results.json"),
  `${JSON.stringify(report, null, 2)}\n`
)
console.log(JSON.stringify(report, null, 2))

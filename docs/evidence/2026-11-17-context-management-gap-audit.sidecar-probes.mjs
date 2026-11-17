// Deterministic, network-free audit probes, separate from product regression tests.
// These assertions reproduce current defects; success does not mean product safety.
// Run from the repository root:
// node docs/evidence/2026-11-17-context-management-gap-audit.sidecar-probes.mjs

import assert from "node:assert/strict"
import fs from "node:fs"
import { createRequire } from "node:module"
import vm from "node:vm"
import { createCompactor } from "../../sidecar/src/runtimes/ai-sdk/compaction.ts"
import { estimateTokens } from "../../sidecar/src/context/compaction.ts"
import { capToolResults } from "../../sidecar/src/context/tool-result-cap.ts"
import { builtinToModelOutput } from "../../sidecar/src/tools/adapters/ai-sdk-output.ts"

const ts = createRequire(new URL("../../package.json", import.meta.url))("typescript")

function fixture(conversation, compaction = {}) {
  const starts = []
  const events = []
  const hooks = new Map()
  const state = {
    model: "test",
    lastInputTokens: 700,
    promptOverheadTokens: 0,
    frozenSummaryVersion: 0,
    ledgerSideCalls: 0,
    turnLedgerGate: null,
    activeAbortController: new AbortController(),
  }
  const compact = createCompactor({
    state,
    conversation,
    sendOptions: {
      compaction: {
        background: false,
        contextWindow: 1000,
        keepRecent: 2,
        maxSummaryTokens: 100,
        ...compaction,
      },
    },
    provider: "test",
    sessionId: "audit-session",
    sdkSessionId: "audit-sdk",
    protocolAdapter: {
      id: "audit-adapter",
      async start(args) {
        starts.push(args)
        return {
          usage: Promise.resolve(null),
          fullStream: (async function* () {
            yield { type: "text-delta", text: "Old work summarized." }
          })(),
        }
      },
    },
    pendingProtocolExecs: new Map(),
    pendingPluginHookCalls: hooks,
    emit(event) {
      if (event.type === "plugin_hook_exec") {
        hooks.get(event.execId)?.resolve({ result: {} })
      } else events.push(event)
    },
    log() {},
    isCancelled: () => false,
  })
  return { compact, starts, events }
}

function priorMessages() {
  return Array.from({ length: 6 }, (_, i) => ({
    role: i % 2 ? "assistant" : "user",
    content: `old message ${i} ${"x".repeat(80)}`,
  }))
}

function canonicalToolOutputEscapesTheCap() {
  const text = "x".repeat(4000)
  const output = builtinToModelOutput({ output: text })
  assert.equal(output.type, "text")
  assert.equal(output.value.length, 4000)
  const messages = [
    {
      role: "tool",
      content: [{ type: "tool-result", toolCallId: "read1", toolName: "read", output }],
    },
  ]
  const capped = capToolResults(messages, { maxToolResultTokens: 100 })
  assert.equal(capped[0], messages[0], "canonical wrapped output is unchanged")
  assert.equal(capped[0].content[0].output.value.length, 4000)
  return {
    outputShape: "builtinToModelOutput -> {type: text, value: string}",
    configuredCapTokens: 100,
    configuredApproximateCapChars: 400,
    beforeChars: 4000,
    afterChars: capped[0].content[0].output.value.length,
    sameMessageReference: true,
  }
}

async function retainedToolArgumentsAreNotBudgeted() {
  const conversation = [
    ...priorMessages(),
    {
      role: "assistant",
      content: [
        {
          type: "tool-call",
          toolCallId: "call1",
          toolName: "write_file",
          input: { content: "x".repeat(400_000) },
        },
      ],
    },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "call1",
          toolName: "write_file",
          output: { type: "text", value: "saved" },
        },
      ],
    },
  ]
  assert.equal(estimateTokens([conversation.at(-2)]), 0)
  const { compact, events } = fixture(conversation, { postCompactionTokenBudget: 500 })
  try {
    await compact({}, {}, { force: true })
    const boundary = events.find((event) => event.event?.subtype === "compact_boundary")
    assert.ok(boundary, "current implementation publishes the undercounted candidate")
    const args = conversation.find((message) => message.role === "assistant").content[0].input
    assert.equal(args.content.length, 400_000)
    assert.ok(boundary.event.compact_metadata.projected_input_tokens < 500)
    return {
      declaredInputWindow: 1000,
      declaredTarget: 500,
      publishedEstimatedTokens: estimateTokens(conversation),
      publishedSerializedChars: JSON.stringify(conversation).length,
      retainedToolArgsChars: args.content.length,
      boundaryPublished: true,
    }
  } finally {
    await compact.settle()
  }
}

async function mediaIsOmittedBeforeLossyReplacement() {
  // Synthetic media markers make loss visible without a real provider or parser.
  const fileMarker = "PDF_UNIQUE_ACCOUNT_CODE_7319"
  const imageMarker = "ONLY_IMAGE_CODE_9841"
  const conversation = [
    { role: "system", content: "Keep user constraints" },
    {
      role: "user",
      content: [
        { type: "text", text: "The attachment contains the only exact code. Preserve it." },
        {
          type: "file",
          mediaType: "application/pdf",
          data: fileMarker,
          filename: "code.pdf",
        },
        { type: "image", image: `data:image/png;base64,${imageMarker}` },
      ],
    },
    ...priorMessages(),
  ]
  const { compact, starts, events } = fixture(conversation)
  try {
    await compact({}, {}, { force: true })
    assert.equal(starts.length, 1)
    const summaryInput = JSON.stringify(starts[0].messages)
    assert.ok(summaryInput.includes("[file code.pdf]"))
    assert.ok(summaryInput.includes("[image]"))
    for (const marker of [fileMarker, imageMarker]) {
      assert.equal(summaryInput.includes(marker), false)
      assert.equal(JSON.stringify(conversation).includes(marker), false)
    }
    assert.ok(events.some((event) => event.event?.subtype === "compact_boundary"))
    return {
      summaryCalls: starts.length,
      mediaPlaceholdersOnly: true,
      mediaPayloadInSummaryInput: false,
      mediaPayloadRetainedAfterPublication: false,
      boundaryPublished: true,
    }
  } finally {
    await compact.settle()
  }
}

async function pluginContextHasNoDeadlineOrSizeLimit() {
  // Execute the actual resolver after TS transpilation; stub only its registry
  // and unused lazy-import dependencies, avoiding a browser/store bootstrap.
  let entries = []
  const source = fs.readFileSync(
    new URL("../../lib/plugin/agent-sdk/context-providers.ts", import.meta.url),
    "utf8"
  )
  const context = {
    exports: {},
    require(name) {
      return name.includes("context-provider-registry")
        ? { listContextProviderEntries: () => entries }
        : {}
    },
    Promise,
  }
  vm.runInNewContext(
    ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText,
    context
  )
  const resolve = context.exports.resolveContextContributions
  entries = [{ pluginId: "audit-plugin", entry: { provide: () => new Promise(() => {}) } }]
  const pending = resolve({ prompt: "audit" }, "audit-plugin")
  const settled = await Promise.race([
    pending.then(() => true),
    new Promise((done) => setTimeout(() => done(false), 50)),
  ])
  assert.equal(settled, false)
  entries = [{ pluginId: "audit-plugin", entry: { provide: () => "x".repeat(1_048_576) } }]
  const result = await resolve({ prompt: "audit" }, "audit-plugin")
  assert.equal(result.length, 1_048_576)
  return {
    neverSettlingProviderStillPendingAfterMs: 50,
    acceptedOutputCharsWithoutTruncation: result.length,
    cancellationSurface: "resolver and provider input expose no AbortSignal",
  }
}

console.log(
  JSON.stringify(
    {
      note: "Defect reproduction assertions; no real-provider or UI acceptance is claimed.",
      canonicalToolOutputEscapesTheCap: canonicalToolOutputEscapesTheCap(),
      retainedToolArgumentsAreNotBudgeted: await retainedToolArgumentsAreNotBudgeted(),
      mediaIsOmittedBeforeLossyReplacement: await mediaIsOmittedBeforeLossyReplacement(),
      pluginContextHasNoDeadlineOrSizeLimit: await pluginContextHasNoDeadlineOrSizeLimit(),
    },
    null,
    2
  )
)

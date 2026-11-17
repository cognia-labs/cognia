// Bounded adversarial characterization of current runtime boundaries.
// Synthetic inputs and fake streamText/summary adapters only: no network or tools execute.
// This separate file preserves the original audit probes under review.
// Run: node docs/evidence/2026-11-17-context-management-gap-audit.adversarial-runtime-probes.mjs

import assert from "node:assert/strict"
import { estimateTokens } from "../../sidecar/src/context/compaction.ts"
import { createCompactor } from "../../sidecar/src/runtimes/ai-sdk/compaction.ts"
import { dispatchAiSdk } from "../../sidecar/src/runtimes/ai-sdk/index.ts"
import {
  projectToolResultImages,
  toAiSdkUserContent,
  toolOutputHasImage,
} from "../../sidecar/src/runtimes/ai-sdk/messages.ts"
import { builtinToModelOutput } from "../../sidecar/src/tools/adapters/ai-sdk-output.ts"
import { composeBashBody } from "../../sidecar/src/tools/builtin/core-files/bash.ts"

// Valid, tiny PNG bytes. No claim about semantic image interpretation is made.
const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jtmYAAAAASUVORK5CYII="

function priorMessages() {
  return Array.from({ length: 6 }, (_, i) => ({
    role: i % 2 ? "assistant" : "user",
    content: `older ${i} ${"z".repeat(80)}`,
  }))
}

function summaryFixture(conversation, options = {}) {
  const starts = []
  const events = []
  const hooks = new Map()
  const compact = createCompactor({
    state: {
      model: "synthetic",
      lastInputTokens: 700,
      promptOverheadTokens: 0,
      frozenSummaryVersion: 0,
      ledgerSideCalls: 0,
      turnLedgerGate: null,
      activeAbortController: new AbortController(),
    },
    conversation,
    sendOptions: {
      compaction: {
        background: false,
        contextWindow: 8000,
        keepRecent: 2,
        maxSummaryTokens: 100,
        ...options,
      },
    },
    provider: "synthetic",
    sessionId: "audit-adversarial-summary",
    sdkSessionId: "audit-adversarial-sdk",
    protocolAdapter: {
      id: "fake-summary-no-network",
      async start(args) {
        starts.push(args)
        return {
          usage: Promise.resolve(null),
          fullStream: (async function* () {
            yield { type: "text-delta", text: "Synthetic summary." }
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

function canonicalToolImagesMissProjection() {
  const raw = { content: [{ type: "image", mimeType: "image/png", data: PNG }] }
  const output = builtinToModelOutput({ output: raw })
  assert.equal(output.type, "content")
  assert.equal(output.value[0].type, "file")
  const message = {
    role: "tool",
    content: [{ type: "tool-result", toolCallId: "image1", toolName: "read", output }],
  }
  const projected = projectToolResultImages([message])
  assert.equal(toolOutputHasImage(raw), true)
  assert.equal(toolOutputHasImage(output), false)
  assert.equal(projected.images.length, 0)
  assert.equal(projected.sanitized[0], message)
  return {
    rawMcpImageDetected: true,
    canonicalMapperImageDetected: false,
    projectedUserImages: 0,
    structuredImageLeftInToolOutput: true,
  }
}

async function newArgumentsPassTheActualNextSendGuard() {
  const contextWindow = 16_000
  const records = []
  const events = []
  const pair = [
    {
      role: "assistant",
      content: [
        {
          type: "tool-call",
          toolCallId: "call1",
          toolName: "audit_tool",
          input: { content: "x".repeat(20_000) },
        },
      ],
    },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "call1",
          toolName: "audit_tool",
          output: { type: "text", value: "y".repeat(24_000) },
        },
      ],
    },
  ]
  let finish
  const ended = new Promise((resolve) => (finish = resolve))
  let session
  session = dispatchAiSdk({
    provider: "openai",
    sessionId: "audit-adversarial-next-send",
    firstPrompt: "u".repeat(32_000),
    sendOptions: {
      model: "gpt-synthetic",
      providerCredentials: { apiKey: "synthetic-never-sent", protocol: "openai" },
      compaction: { enabled: true, contextWindow, fraction: 0.99, background: false },
      maxSteps: 2,
      aiSdkStepChunk: 1,
      pluginTools: [
        {
          name: "audit_tool",
          pluginId: "synthetic",
          description: "Never executes; the fake SDK returns synthetic messages.",
          jsonSchema: { type: "object", properties: { content: { type: "string" } } },
        },
      ],
    },
    emit(event) {
      events.push(event)
      if (event.type === "session_ended") finish()
    },
    log() {},
    streamText(args) {
      const first = records.length === 0
      const sent = structuredClone(args.messages)
      const record = {
        estimatedTokens: estimateTokens(sent),
        serializedChars: JSON.stringify(sent).length,
      }
      records.push(record)
      return {
        fullStream: (async function* () {
          if (first) {
            const step = {
              usage: { inputTokens: 8000, outputTokens: 5000 },
              content: [...pair[0].content, ...pair[1].content],
            }
            record.yieldForGrowingContext = args.stopWhen({ steps: [step] })
            yield { type: "finish-step", usage: step.usage, request: { messages: sent } }
            yield { type: "finish", finishReason: "tool-calls" }
          } else {
            yield { type: "text-delta", text: "done" }
            yield { type: "finish", finishReason: "stop" }
          }
        })(),
        usage: Promise.resolve({
          inputTokens: first ? 8000 : 14_000,
          outputTokens: first ? 5000 : 1,
        }),
        responseMessages: Promise.resolve(first ? pair : [{ role: "assistant", content: "done" }]),
        steps: Promise.resolve([{}]),
      }
    },
  })
  assert.ok(session)
  let timeout
  try {
    await Promise.race([
      ended,
      new Promise(
        (_, reject) =>
          (timeout = setTimeout(() => reject(new Error("runtime probe timed out")), 5000))
      ),
    ])
    assert.equal(records.length, 2)
    assert.equal(records[0].yieldForGrowingContext, true)
    assert.equal(records[1].estimatedTokens, 14_000)
    assert.ok(records[1].serializedChars / 4 > contextWindow)
    assert.equal(events.find((event) => event.type === "session_ended").error, undefined)
    return {
      contextWindow,
      firstInputTokens: 8000,
      generatedArgumentChars: 20_000,
      newToolResultChars: 24_000,
      ...records[1],
      sdkYieldSafeguardFired: true,
      nextSendReached: true,
      realProviderTokenCount: "not measured; serialization-size counterexample only",
    }
  } finally {
    clearTimeout(timeout)
    session.closeInput()
    await session.closed
  }
}

async function canonicalTextCapStillFailsInsideCompactor() {
  const output = builtinToModelOutput({ output: "x".repeat(4000) })
  const conversation = [
    ...priorMessages(),
    {
      role: "assistant",
      content: [{ type: "tool-call", toolCallId: "cap1", toolName: "read", input: {} }],
    },
    {
      role: "tool",
      content: [{ type: "tool-result", toolCallId: "cap1", toolName: "read", output }],
    },
  ]
  const { compact, events } = summaryFixture(conversation, { maxToolResultTokens: 100 })
  try {
    await compact({}, {}, { force: true })
    assert.ok(events.some((event) => event.event?.subtype === "compact_boundary"))
    const retained = conversation.find((message) => message.role === "tool")
    assert.equal(retained.content[0].output.value.length, 4000)
    return { configuredCapTokens: 100, retainedOutputChars: 4000, candidatePublished: true }
  } finally {
    await compact.settle()
  }
}

async function canonicalImageAndExtractedTextHaveDifferentSummaryCoverage() {
  const extractedText = "EXTRACTED_VISUAL_EVIDENCE_7319"
  const content = toAiSdkUserContent([
    { type: "text", text: extractedText },
    { type: "image", source: { type: "base64", media_type: "image/png", data: PNG } },
  ])
  assert.equal(content[1].type, "file")
  const conversation = [{ role: "user", content }, ...priorMessages()]
  const { compact, starts, events } = summaryFixture(conversation)
  try {
    await compact({}, {}, { force: true })
    const summaryInput = JSON.stringify(starts[0].messages)
    assert.equal(summaryInput.includes(extractedText), true)
    assert.equal(summaryInput.includes(PNG), false)
    assert.equal(summaryInput.includes("[file]"), true)
    assert.equal(JSON.stringify(conversation).includes(PNG), false)
    assert.ok(events.some((event) => event.event?.subtype === "compact_boundary"))
    return {
      productionUserMediaShape: "file",
      extractedTextReachesSummary: true,
      binaryImageReachesSummary: false,
      binaryImageRemainsActive: false,
      semanticRetention: "not measured; no vision model called",
    }
  } finally {
    await compact.settle()
  }
}

async function bashOffloadReferenceIsElidedBeforeSummarization() {
  const sourceRef = "/tmp/synthetic-audit-output.log"
  const { body } = composeBashBody({
    head: "h".repeat(12_000),
    tail: "t".repeat(18_000),
    total: 80_000,
    fullPath: sourceRef,
  })
  assert.equal(body.includes(sourceRef), true)
  const conversation = [
    {
      role: "assistant",
      content: [
        {
          type: "tool-call",
          toolCallId: "bash1",
          toolName: "bash",
          input: { command: "synthetic" },
        },
      ],
    },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "bash1",
          toolName: "bash",
          output: builtinToModelOutput({ output: body }),
        },
      ],
    },
    ...priorMessages(),
  ]
  const { compact, starts } = summaryFixture(conversation, { maxToolResultTokens: 100 })
  try {
    await compact({}, {}, { force: true })
    assert.equal(starts.length, 1)
    assert.equal(JSON.stringify(starts[0].messages).includes(sourceRef), false)
    return {
      bashPreviewAlreadyContainsReadbackRef: true,
      configuredCapTokens: 100,
      refReachesSummaryInput: false,
      spillFileCreated: false,
    }
  } finally {
    await compact.settle()
  }
}

console.log(
  JSON.stringify(
    {
      note: "Characterization only. No actual tools, model/network requests, or source stores were written.",
      canonicalToolImagesMissProjection: canonicalToolImagesMissProjection(),
      newArgumentsPassTheActualNextSendGuard: await newArgumentsPassTheActualNextSendGuard(),
      canonicalTextCapStillFailsInsideCompactor: await canonicalTextCapStillFailsInsideCompactor(),
      canonicalImageAndExtractedTextHaveDifferentSummaryCoverage:
        await canonicalImageAndExtractedTextHaveDifferentSummaryCoverage(),
      bashOffloadReferenceIsElidedBeforeSummarization:
        await bashOffloadReferenceIsElidedBeforeSummarization(),
    },
    null,
    2
  )
)

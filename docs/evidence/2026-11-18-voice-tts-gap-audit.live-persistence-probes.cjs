const rootRequire = require("node:module").createRequire(process.cwd() + "/package.json")
// Current installed SDK + current persistence/reducer source, with storage injected.
const fs = require("node:fs")
const assert = require("node:assert/strict")
const ts = rootRequire("typescript")
function load(file, mocks = {}) {
  const compiled = ts.transpileModule(fs.readFileSync(file, "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText
  const mod = { exports: {} }
  new Function("require", "module", "exports", compiled)(
    (name) => {
      if (name in mocks) return mocks[name]
      throw new Error("Unmocked dependency " + name)
    },
    mod,
    mod.exports
  )
  return mod.exports
}
const { createInitialLiveVoiceState, reduceLiveVoiceServerEvent } = load(
  "lib/voice/live/reducer.ts",
  {
    "@cognia/redact": {
      hasNoLeakingPii: () => true,
      hasNoLeakingPiiDeep: () => true,
      redactText: (text) => ({ redacted: text }),
    },
    "@cognia/provider-routing/error-classifier": {},
  }
)
const { createLiveVoiceTurnPersister, persistLiveVoiceTurns } = load(
  "lib/voice/live/persist-turns.ts"
)
const provenance = { provider: "google", modelOrResource: "synthetic-model", region: "global" }

;(async () => {
  const { createGoogle } = await import(rootRequire.resolve("@ai-sdk/google"))
  const provider = createGoogle({ apiKey: "synthetic-unused" })
  let stored = []
  const storage = {
    loadExisting: async () => stored,
    persist: async (_id, messages) => {
      stored = messages
    },
  }
  const persister = createLiveVoiceTurnPersister({
    sessionId: "chat-1",
    startedAt: 1000,
    provenance,
    ...storage,
  })
  const first = provider.experimental_realtime("synthetic-model")
  let state = createInitialLiveVoiceState()
  for (const frame of [
    { text: "hello ", finished: false },
    { text: "world", finished: true },
  ]) {
    const event = first.parseServerEvent({ serverContent: { inputTranscription: frame } })
    state = reduceLiveVoiceServerEvent(state, event)
    await persister.append(state.turns)
  }
  await persister.flush(state.turns)
  assert.equal(state.turns[0].text, "hello world")
  assert.equal(stored[0].parts[0].text, "hello")
  console.log(
    JSON.stringify({
      probe: "Google partial/final same ID",
      visibleFinal: state.turns[0].text,
      storedFinal: stored[0].parts[0].text,
      messageId: stored[0].id,
    })
  )

  const second = provider.experimental_realtime("synthetic-model")
  const nextEvent = second.parseServerEvent({
    serverContent: { inputTranscription: { text: "second conversation", finished: true } },
  })
  let nextState = reduceLiveVoiceServerEvent(createInitialLiveVoiceState(), nextEvent)
  const secondPersister = createLiveVoiceTurnPersister({
    sessionId: "chat-1",
    startedAt: 2000,
    provenance,
    ...storage,
  })
  await secondPersister.append(nextState.turns)
  assert.equal(stored.length, 1)
  assert.equal(stored[0].parts[0].text, "second conversation")
  console.log(
    JSON.stringify({
      probe: "Google new call reuses item IDs",
      messageCountAfterTwoCalls: stored.length,
      storedText: stored[0].parts[0].text,
      messageId: stored[0].id,
    })
  )

  stored = []
  for (const callId of ["first-tool", "second-tool"]) {
    await persistLiveVoiceTurns({
      sessionId: "chat-2",
      startedAt: 1000,
      provenance,
      turns: [],
      toolRecords: [{ callId, name: "synthetic", status: "completed", durationMs: 10 }],
      ...storage,
    })
  }
  assert.equal(stored.length, 1)
  assert.equal(stored[0].parts[0].toolCallId, "second-tool")
  console.log(
    JSON.stringify({
      probe: "new call replaces prior tool audit",
      auditMessageCount: stored.length,
      retainedCallIds: stored[0].parts.map((part) => part.toolCallId),
    })
  )
})().catch((error) => {
  console.error(error)
  process.exitCode = 1
})

import assert from "node:assert/strict"
// Reproduces helper-level observations only; native delivery acceptance is separate.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { resolve } from "node:path"
import vm from "node:vm"
import { buildSync } from "esbuild"

const root = process.cwd()
const ts = createRequire(resolve(root, "package.json"))("typescript")
const out = resolve(root, ".cache/sidechat-adversarial-context")
mkdirSync(out, { recursive: true })
const purePath = resolve(out, "pure.cjs")
buildSync({
  stdin: {
    contents: `export * from "./lib/chat/session-aside-context"; export * from "./lib/context-workbench/aside-context-dispatch";`,
    resolveDir: root,
    sourcefile: "sidechat-adversarial-context-entry.ts",
    loader: "ts",
  },
  bundle: true,
  platform: "node",
  format: "cjs",
  outfile: purePath,
  logLevel: "silent",
})
const api = createRequire(import.meta.url)(purePath)
const message = (id, role, text) => ({ id, role, parts: [{ type: "text", text }] })
const parent = [message("p1", "user", "The synthetic launch code is MAPLE.")]
const initial = api.prepareAsideContext(parent)
const cursor = { ...initial.cursor, sdkSessionId: "sdk-existing" }
const observations = []

// Run the exact function declaration, extracted by the TypeScript parser.
// Dependency stubs represent only private in-memory rows and transport controls.
const sourcePath = resolve(root, "hooks/chat/claude-chat-send-options.ts")
const source = readFileSync(sourcePath, "utf8")
const ast = ts.createSourceFile(sourcePath, source, ts.ScriptTarget.Latest, true)
const declaration = ast.statements.find(
  (node) => ts.isFunctionDeclaration(node) && node.name?.text === "prepareTranscriptRuntimeSend"
)
assert.ok(declaration)
const compiled = ts.transpileModule(declaration.getText(ast), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText
const preparation = (canonical, sessionPatch = {}) => {
  const session = {
    id: "aside",
    sdkSessionId: "sdk-existing",
    runtimePersonalVisibilityDigest: "public",
    ...sessionPatch,
  }
  const effects = []
  const context = {
    exports: {},
    getDb: () => ({ name: "synthetic-memory-only" }),
    getSession: async () => ({ ...session }),
    updateSession: async (_id, patch) => {
      effects.push(["update", patch])
      Object.assign(session, patch)
    },
    listMessages: async () => canonical,
    selectVisibleMessages: (messages) => messages,
    preparePersonalHistory: async (_id, messages) => ({
      messages,
      withheldMessageIds: [],
      visibilityDigest: "public",
    }),
    assertPersonalContextReaders: async () => {},
    isExternalAgentProviderId: () => false,
    invalidateTranscriptRuntime: async () => {
      effects.push(["invalidate"])
      session.runtimeTranscriptInvalidated = "new-generation"
    },
    mcpRuntimeConfigurationMatches: () => true,
    gateWorkbenchProviderPayload: (payload) => payload,
    renderBranchSeed: (messages) => ({
      content: messages.map((m) => m.parts.map((p) => p.text).join("")).join("\n"),
    }),
  }
  vm.runInNewContext(compiled, context, { filename: sourcePath })
  return { run: context.exports.prepareTranscriptRuntimeSend, effects, session }
}

{
  const saved = []
  const dispatch = api.createAsideContextDispatch(
    initial.cursor,
    async (value) => {
      saved.push(value)
    },
    "sdk-existing",
    "new-turn"
  )
  await dispatch.dispatched()
  assert.equal(saved.length, 1)
  // A later asynchronous provider failure/cancellation cannot roll this back.
  dispatch.cancel()
  const next = api.prepareAsideContext(parent, {
    cursor: saved[0],
    resumeSdkSessionId: "sdk-existing",
  })
  assert.equal(next.context, "")
  observations.push({
    id: "resume-ack-without-provider-event",
    savedWithoutSdkEvent: saved,
    nextContextAfterCancel: next.context,
  })
}

{
  const cleared = api.prepareAsideContext([], { cursor, resumeSdkSessionId: "sdk-existing" })
  assert.equal(cleared.header, api.ASIDE_REFERENCE_HEADER)
  assert.equal(cleared.cursor.parentMessageId, null)
  const canonical = [message("a-user", "user", "What is the launch code?")]
  const native = preparation(canonical)
  const opts = await native.run(
    "aside",
    { provider: "anthropic", resumeSessionId: "sdk-existing", turnId: "a-user" },
    { currentMessageId: "a-user" }
  )
  assert.equal(opts.resumeSessionId, "sdk-existing")
  assert.deepEqual(native.effects, [])
  observations.push({
    id: "parent-clear-retains-native-provider-history",
    clearedContext: cleared.context,
    resumeSessionId: opts.resumeSessionId,
    sideHistoryRetired: native.effects.some(([name]) => name === "invalidate"),
  })
}

{
  const canonical = [
    message("a-user", "user", "What is the launch code?"),
    message("a-answer", "assistant", "The launch code is MAPLE."),
  ]
  const native = preparation(canonical)
  const opts = await native.run(
    "aside",
    { provider: "anthropic", resumeSessionId: "sdk-existing", turnId: "a-user" },
    { currentMessageId: "a-user", replacesHistory: true }
  )
  assert.equal(opts.resumeSessionId, "sdk-existing")
  assert.equal(opts.appendSystemPrompt, undefined)
  assert.deepEqual(native.effects, [])
  const regeneratedContext = api.prepareAsideContext(parent, {
    cursor,
    resumeSdkSessionId: opts.resumeSessionId,
  })
  assert.equal(regeneratedContext.context, "")
  observations.push({
    id: "native-regenerate-retains-answer-being-replaced",
    resumeSessionId: opts.resumeSessionId,
    sideHistoryRetired: native.effects.some(([name]) => name === "invalidate"),
    regeneratedParentContext: regeneratedContext.context,
  })
}

writeFileSync(resolve(out, "observations.json"), JSON.stringify(observations, null, 2) + "\n")
console.log(JSON.stringify(observations, null, 2))

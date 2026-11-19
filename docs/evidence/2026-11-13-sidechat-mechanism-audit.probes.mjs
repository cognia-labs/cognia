/**
 * Audit probes assert observed behavior, including gaps, rather than a fixed contract.
 * All inputs are synthetic. No provider, native shell, or user database is used.
 * Run from the repository root:
 *   node docs/evidence/2026-11-13-sidechat-mechanism-audit.probes.mjs
 */
import assert from "node:assert/strict"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { createRequire } from "node:module"
import { resolve } from "node:path"
import { buildSync } from "esbuild"

const root = process.cwd()
const output = resolve(root, ".cache/sidechat-mechanism-audit")
mkdirSync(output, { recursive: true })
const bundlePath = resolve(output, "pure-probes.cjs")
buildSync({
  stdin: {
    contents: `
      export * from "./lib/chat/session-aside-context";
      export * from "./lib/context-workbench/resource-session";
      export * from "./lib/chat/session-exposure";
      export * from "./lib/context-workbench/provider-context";
    `,
    resolveDir: root,
    sourcefile: "sidechat-audit-entry.ts",
    loader: "ts",
  },
  bundle: true,
  platform: "node",
  format: "cjs",
  outfile: bundlePath,
  logLevel: "silent",
})
const api = createRequire(import.meta.url)(bundlePath)
const observations = []
const check = (id, run) => {
  const detail = run()
  observations.push({ id, reproduced: true, ...detail })
}
const message = (id, text) => ({ id, role: "user", parts: [{ type: "text", text }] })

check("promotion-retains-an-id-rejected-as-nested", () => {
  const id = api.resourceWorkbenchSessionId({ kind: "session", sessionId: "parent" })
  const promoted = { id, ...api.promoteEmbeddedSessionPatch() }
  assert.equal(promoted.kind, "direct")
  assert.equal(api.isEmbeddedSession(promoted), false)
  const binding = api.surfaceBindingForContextResource({ kind: "session", sessionId: id })
  assert.equal(binding, null)
  return { promotedId: id, promotedKind: promoted.kind, binding }
})

check("durable-aside-excluded-from-reference-and-search-channel", () => {
  const aside = { kind: "resource-workbench", visibility: "embedded" }
  const search = api.isSessionExposed(aside, "global-search")
  const sync = api.isSessionExposed(aside, "authenticated-project-sync")
  assert.equal(search, false)
  assert.equal(sync, true)
  return { globalSearchAndMentionChannel: search, authenticatedSyncChannel: sync }
})

check("parent-file-part-is-omitted", () => {
  const context = api.buildAsideContext([
    {
      id: "attachment",
      role: "user",
      parts: [
        {
          type: "file",
          mediaType: "image/png",
          filename: "architecture.png",
          url: "data:image/png;base64,U1lOVEhFVElD",
        },
      ],
    },
    message("question", "What is wrong with this diagram?"),
  ])
  assert.equal(context, "User: What is wrong with this diagram?")
  assert.equal(context.includes("architecture.png"), false)
  return { context, fileRepresented: false }
})

check("legacy-image-has-only-a-text-placeholder", () => {
  const context = api.buildAsideContext([
    {
      id: "legacy-image",
      role: "user",
      parts: [{ type: "image", alt: "Synthetic diagram", image: "synthetic-image-content" }],
    },
  ])
  assert.equal(context, "User: [image: Synthetic diagram]")
  return { context, imageDataPreserved: false }
})

check("formatted-source-is-flattened", () => {
  const context = api.buildAsideContext([message("yaml", "root:\n  child: true\nother: false")])
  assert.equal(context, "User: root: child: true other: false")
  return { context, indentationPreserved: false }
})

check("bounded-context-does-not-disclose-parent-message-omission", () => {
  const messages = Array.from({ length: 25 }, (_, i) => message(`m${i}`, `sentinel-${i}`))
  const context = api.buildAsideContext(messages)
  assert.equal(context.includes("sentinel-0"), false)
  assert.equal(context.includes("sentinel-24"), true)
  assert.equal(/omitted|truncated/i.test(context), false)
  const long = api.buildAsideContext([message("long", "X".repeat(9000))])
  assert.equal(long.length, 8000)
  assert.equal(long.startsWith("User:"), false)
  return { retainedMessages: 24, omissionMarker: false, longMessageLosesRoleLabel: true }
})

check("incremental-delivery-requires-the-matching-sdk-resume", () => {
  const messages = [message("parent-1", "Original context")]
  const initial = api.prepareAsideContext(messages)
  const cursor = { ...initial.cursor, sdkSessionId: "synthetic-sdk" }
  const resumed = api.prepareAsideContext(messages, { cursor, resumeSdkSessionId: "synthetic-sdk" })
  const rebuilt = api.prepareAsideContext(messages, { cursor })
  assert.equal(resumed.context, "")
  assert.equal(rebuilt.context, initial.context)
  return { resumedChars: resumed.context.length, rebuiltChars: rebuilt.context.length }
})

writeFileSync(
  resolve(output, "pure-probe-results.json"),
  JSON.stringify(observations, null, 2) + "\n"
)
console.log(
  JSON.stringify(
    { probes: observations.length, reproduced: observations.length, observations },
    null,
    2
  )
)

// Reuse the existing engine's controlled provider fixture, retaining the real
// redactor and actual AI SDK message conversion. Generated tests stay in .cache.
let fixture = readFileSync(resolve(root, "lib/ai/chat/standalone-engine.test.ts"), "utf8")
  .split("const personalHistoryMessage =")[0]
  .replaceAll('"./resolve-standalone-provider"', '"@/lib/ai/chat/resolve-standalone-provider"')
  .replaceAll('"./standalone-engine"', '"@/lib/ai/chat/standalone-engine"')
const mockStart = fixture.indexOf('jest.mock("@cognia/redact", () => ({')
const mockEnd = fixture.indexOf("\n\nconst mockResolve", mockStart)
assert.ok(mockStart >= 0 && mockEnd > mockStart, "Standalone fixture extraction drifted")
fixture = fixture.slice(0, mockStart) + fixture.slice(mockEnd)
const securityTests = `
import { gateWorkbenchProviderPayload } from "@/lib/context-workbench/provider-payload"
import { withWorkbenchMessageContext } from "@/lib/context-workbench/provider-context"
import { hasNoLeakingPiiDeep } from "@cognia/redact"

it("audit positive control blocks derived assistant email before the stream seam", async () => {
  jest.mocked(convertToModelMessages).mockImplementation(jest.requireActual("ai").convertToModelMessages)
  const stream = jest.fn(fakeStream([]))
  const { promise, events } = run({
    messages: [
      { id: "a", role: "assistant", parts: [{ type: "text", text: "Contact jane@example.com" }] },
      { id: "q", role: "user", parts: [{ type: "text", text: "Who should I contact?" }] },
    ],
    streamTextImpl: stream as never,
  })
  await promise
  expect(stream).not.toHaveBeenCalled()
  expect(events.at(-1)).toMatchObject({ error: expect.stringContaining("derived context contains private data") })
})

it("audit reproduced sidechat parent email survives final standalone gate", async () => {
  jest.mocked(convertToModelMessages).mockImplementation(jest.requireActual("ai").convertToModelMessages)
  const context = "Assistant: Contact jane@example.com"
  const messages: UIMessage[] = [
    { id: "q", role: "user", parts: [{ type: "text", text: "Who should I contact?" }] },
  ]
  const gated = gateWorkbenchProviderPayload({
    content: "Who should I contact?",
    messages: withWorkbenchMessageContext(messages, context),
    sendOptions: {},
  }, context)
  expect(hasNoLeakingPiiDeep(gated)).toBe(true)
  // Reproduce the controller's message overwrite after its earlier gate.
  gated.messages = withWorkbenchMessageContext(messages, context)
  const stream = jest.fn(fakeStream([]))
  const { promise, events } = run({
    messages: gated.messages,
    sendOptions: { systemPrompt: "Answer side question", permissionMode: "plan", toolSurface: "none" },
    streamTextImpl: stream as never,
  })
  await promise
  expect(stream).toHaveBeenCalledTimes(1)
  const request = stream.mock.calls[0][0] as unknown as { messages: unknown }
  expect(JSON.stringify(request.messages)).toContain("jane@example.com")
  expect(hasNoLeakingPiiDeep(request.messages)).toBe(false)
  expect(events.at(-1)).toMatchObject({ type: "session_ended" })
  console.log(JSON.stringify({
    probe: "standalone-sidechat-final-gate", providerCalls: 0,
    fakeStreamCalls: stream.mock.calls.length,
    syntheticEmailReachedFakeStream: true, fullPayloadPiiSafe: false,
  }))
})
`
writeFileSync(resolve(output, "standalone-pii-bypass.test.ts"), fixture + securityTests)
writeFileSync(
  resolve(output, "jest.probe.config.ts"),
  `
import buildConfig from "../../jest.config.ts"
export default async () => {
  const config = await buildConfig()
  const base = (config.projects as any[])[0]
  return {
    ...config, rootDir: process.cwd(),
    projects: [{
      ...base, rootDir: process.cwd(), testEnvironment: "jsdom",
      roots: ["<rootDir>/.cache/sidechat-mechanism-audit"],
      testMatch: ["<rootDir>/.cache/sidechat-mechanism-audit/standalone-pii-bypass.test.ts"],
      testPathIgnorePatterns: ["/node_modules/"],
      modulePathIgnorePatterns: ["/node_modules/"],
      cacheDirectory: "<rootDir>/.cache/sidechat-mechanism-audit/jest-cache",
    }],
  }
}
`
)
if (process.argv.includes("--standalone")) {
  const result = spawnSync(
    "pnpm",
    [
      "test",
      "--config",
      ".cache/sidechat-mechanism-audit/jest.probe.config.ts",
      "--runInBand",
      "--no-coverage",
    ],
    { cwd: root, encoding: "utf8" }
  )
  writeFileSync(
    resolve(output, "standalone-pii-probe.log"),
    (result.stdout ?? "") + (result.stderr ?? "")
  )
  process.stdout.write(result.stdout ?? "")
  process.stderr.write(result.stderr ?? "")
  if (result.error) throw result.error
  process.exitCode = result.status ?? 1
} else {
  console.log(
    "Standalone fixtures generated; rerun this script with --standalone to execute the fake-provider tests."
  )
}

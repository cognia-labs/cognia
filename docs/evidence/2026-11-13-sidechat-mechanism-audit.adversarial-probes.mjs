/** Synthetic adversarial probes. No product edits, real providers or user DB. */
import assert from "node:assert/strict"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { spawnSync } from "node:child_process"

const root = process.cwd()
const output = resolve(root, ".cache/sidechat-adversarial-root")
mkdirSync(output, { recursive: true })
const fixture = readFileSync(resolve(root, "lib/claude/build-options-aside.test.ts"), "utf8")
  .split('describe("session-bound aside capability grants"')[0]
  .replaceAll('"./build-options"', '"@/lib/claude/build-options"')
assert.ok(fixture.includes("const resolve ="), "Existing resolver fixture drifted")

writeFileSync(
  resolve(output, "parent-ceiling.test.ts"),
  fixture +
    `
it("REPRO: current parent allowlist is absent from a previously open aside until parent resolves", async () => {
  const tightenedParent = { ...parent, toolFilter: { mode: "allow" as const, tools: ["Grep"] } }
  jest.mocked(getSession).mockResolvedValue(tightenedParent)
  const existingAside = aside({ toolFilter: { mode: "all" } })
  const before = await resolve(existingAside)
  expect(before.allowedTools).toContain("Read")
  expect(before.claudeAgentSdk?.tools).toContain("Read")
  const actualParent = await resolve(tightenedParent)
  expect(actualParent.allowedTools).toEqual(["Grep"])
  const after = await resolve(existingAside)
  expect(after.allowedTools).not.toContain("Read")
  expect(after.claudeAgentSdk?.tools).not.toContain("Read")
  console.log(JSON.stringify({
    probe: "fresh-parent-allowlist", parentAllows: actualParent.allowedTools,
    asideAllowsReadBeforeParentResend: before.allowedTools?.includes("Read"),
    asideAllowsReadAfterParentResend: after.allowedTools?.includes("Read"),
  }))
})

it("REPRO: unlocked aside keeps a tool newly denied by the parent until parent resolves", async () => {
  const tightenedParent = { ...parent, toolFilter: { mode: "deny" as const, tools: ["Write"] } }
  jest.mocked(getSession).mockResolvedValue(tightenedParent)
  const existingAside = aside({ asideWriteAccess: true, toolFilter: { mode: "all" } })
  const before = await resolve(existingAside)
  expect(before.permissionMode).toBe("acceptEdits")
  expect(before.disallowedTools ?? []).not.toContain("Write")
  const actualParent = await resolve(tightenedParent)
  expect(actualParent.disallowedTools).toContain("Write")
  const after = await resolve(existingAside)
  expect(after.disallowedTools).toContain("Write")
  console.log(JSON.stringify({
    probe: "fresh-parent-denylist", parentDenies: actualParent.disallowedTools,
    asideBeforeParentResend: before.disallowedTools ?? [],
    asideAfterParentResend: after.disallowedTools,
  }))
})
`
)
const nativeFixture = readFileSync(
  resolve(root, "hooks/chat/claude-chat-send-options.test.ts"),
  "utf8"
)
  .split('describe("prepareTranscriptRuntimeSend"')[0]
  .replaceAll('"./claude-chat-send-options"', '"@/hooks/chat/claude-chat-send-options"')
assert.ok(
  nativeFixture.includes("prepareTranscriptRuntimeSend"),
  "Native fixture extraction drifted"
)
writeFileSync(
  resolve(output, "native-regenerate.test.ts"),
  nativeFixture +
    `
beforeEach(() => {
  jest.clearAllMocks()
  jest.mocked(getDb).mockReturnValue({ name: "synthetic-audit" } as never)
  jest.mocked(getSession).mockResolvedValue({
    id: "aside", kind: "resource-workbench", sdkSessionId: "retained-sdk",
    runtimeTranscriptGeneration: "g1",
  } as never)
  jest.mocked(listMessages).mockResolvedValue([
    { id: "q", role: "user", parts: [{ type: "text", text: "Explain this choice" }] },
    { id: "old-a", role: "assistant", parts: [{ type: "text", text: "Previous answer" }] },
  ])
})

it("REPRO: native replacement flag keeps the SDK history containing the old answer", async () => {
  const prepared = await prepareTranscriptRuntimeSend("aside", {
    provider: "anthropic", resumeSessionId: "retained-sdk", turnId: "q",
  }, { currentMessageId: "q", replacesHistory: true })
  expect(prepared.resumeSessionId).toBe("retained-sdk")
  expect(invalidateTranscriptRuntime).not.toHaveBeenCalled()
  expect(updateSession).not.toHaveBeenCalled()
  expect(prepared.appendSystemPrompt).toBeUndefined()
  console.log(JSON.stringify({ probe: "native-replacement-ignored", retainedSdk: prepared.resumeSessionId }))
})

it("control: injection protection forces native history rebuilding", async () => {
  const prepared = await prepareTranscriptRuntimeSend("aside", {
    provider: "anthropic", resumeSessionId: "retained-sdk", turnId: "q",
    contentSafety: { injectionProtection: true },
  }, { currentMessageId: "q", replacesHistory: true })
  expect(prepared.resumeSessionId).toBeUndefined()
  expect(updateSession).toHaveBeenCalledWith("aside", {
    sdkSessionId: undefined, forkedFromSdkSessionId: undefined,
  })
})
`
)

writeFileSync(
  resolve(output, "jest.config.ts"),
  `
import buildConfig from "../../jest.config.ts"
export default async () => {
  const config = await buildConfig()
  const base = (config.projects as any[]).find((project) => project.displayName === "node")
  return { ...config, rootDir: process.cwd(), projects: [{
    ...base, rootDir: process.cwd(), testEnvironment: "jsdom",
    roots: ["<rootDir>/.cache/sidechat-adversarial-root"],
    testMatch: ["<rootDir>/.cache/sidechat-adversarial-root/*.test.ts"],
    testPathIgnorePatterns: ["/node_modules/"],
    modulePathIgnorePatterns: ["/node_modules/"],
    cacheDirectory: "<rootDir>/.cache/sidechat-adversarial-root/jest-cache",
  }] }
}
`
)
const result = spawnSync(
  "pnpm",
  [
    "test",
    "--config",
    ".cache/sidechat-adversarial-root/jest.config.ts",
    "--runInBand",
    "--no-coverage",
  ],
  { cwd: root, encoding: "utf8" }
)
writeFileSync(resolve(output, "results.log"), (result.stdout ?? "") + (result.stderr ?? ""))
process.stdout.write(result.stdout ?? "")
process.stderr.write(result.stderr ?? "")
if (result.error) throw result.error
process.exitCode = result.status ?? 1

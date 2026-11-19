/** Account-free boundary probes. Product source is read, never changed. */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, relative, resolve } from "node:path"
import { spawnSync } from "node:child_process"

const root = process.cwd()
const output = resolve(root, ".cache/handoff-dispatch-audit")
mkdirSync(output, { recursive: true })
function fixture(file, cases) {
  const source = readFileSync(resolve(root, file), "utf8").replace(
    /(["'])(\.{1,2}\/[^"']+)\1/g,
    (_match, quote, target) =>
      `${quote}@/${relative(root, resolve(root, dirname(file), target))}${quote}`
  )
  writeFileSync(resolve(output, file.split("/").at(-1)), `${source}\n${cases}\n`)
}

fixture(
  "lib/plugin/agent-sdk/dispatch.test.ts",
  `
jest.mock("@/lib/db/settings", () => ({ getSettings: jest.fn(async () => undefined) }))
describe("audit probe external dispatch boundaries", () => {
  beforeEach(() => {
    externalCreatePreset.mockReturnValue({ id: "audit-external", metadata: { preset: "codex" } })
    externalExecute.mockResolvedValue({ success: true, finalResponse: "audit complete" })
  })
  const externalDef = () => ({ ...subagent, tools: undefined, externalPresetId: "codex" })
  it("OBSERVED toolsEnabled false is not translated for the external engine", async () => {
    const result = await dispatchSubagent(externalDef(), "inspect fixture", { toolsEnabled: false })
    const options = externalExecute.mock.calls[0][2]
    expect(options.allowedTools).toBeUndefined()
    expect(options.toolsEnabled).toBeUndefined()
    expect(result.toolsAvailable).toBe(true)
  })
  it("OBSERVED a definition allowlist is passed as a soft option without an enforceable ceiling", async () => {
    await dispatchSubagent({ ...externalDef(), tools: ["Read"], disallowedTools: ["Bash"], maxTurns: 2 }, "inspect fixture")
    const options = externalExecute.mock.calls[0][2]
    expect(options.allowedTools).toEqual(["Read"])
    expect(options.permissionCeiling).toBeUndefined()
    expect(options.maxSteps).toBeUndefined()
    const { enforceExternalPermissionCeiling } = jest.requireActual("@/lib/ai/agent/external/policy/permission-ceiling")
    expect(enforceExternalPermissionCeiling(options, "acp", undefined)).toBe(options)
  })
  it("OBSERVED parent deny list and sandbox restriction are absent from the engine request", async () => {
    await dispatchSubagent(externalDef(), "inspect fixture", {
      _permissionCeiling: { disallowedTools: ["Bash"], sandboxPolicy: "read-only", permissionMode: "plan" },
    })
    const options = externalExecute.mock.calls[0][2]
    expect(options.permissionMode).toBe("plan")
    expect(options.disallowedTools).toBeUndefined()
    expect(options.sandboxPolicy).toBeUndefined()
    expect(options.nativePolicy).toBeUndefined()
  })
  it("OBSERVED definition MCP servers bypass the parent server intersection", async () => {
    externalResolveMcp.mockResolvedValueOnce([{ name: "child-only", command: "fixture-mcp", args: [] }])
    await dispatchSubagent({ ...externalDef(), mcpServerIds: ["child-only"] }, "inspect fixture", {
      _permissionCeiling: { mcpServers: [{ name: "parent-only" }] },
    })
    expect(externalExecute.mock.calls[0][2].context.custom.mcpServers[0].name).toBe("child-only")
  })
  it("OBSERVED external execution continues beyond the subtree deadline", async () => {
    const deadline = Date.now() + 100
    externalExecute.mockImplementationOnce(async (_id, _prompt, options) => {
      expect(options.timeout).toBeUndefined()
      await new Promise(resolve => setTimeout(resolve, 160))
      expect(options.signal?.aborted ?? false).toBe(false)
      return { success: true, finalResponse: "after deadline" }
    })
    const result = await dispatchSubagent(externalDef(), "inspect fixture", { _deadlineMs: deadline })
    expect(Date.now()).toBeGreaterThan(deadline)
    expect(result.text).toBe("after deadline")
  })
  it("OBSERVED settings read failure permits dispatch", async () => {
    jest.requireMock("@/lib/db/settings").getSettings
      .mockRejectedValueOnce(new Error("fixture settings unavailable"))
    await dispatchSubagent(externalDef(), "inspect fixture")
    expect(externalExecute).toHaveBeenCalledTimes(1)
  })
})
`
)

fixture(
  "lib/ai/agent/execution/delegation/dispatch-agent-handler.test.ts",
  `
describe("audit probe renderer control ownership and retry", () => {
  async function startVictim() {
    mockGetDef.mockReturnValue({ id: "coder", name: "coder", description: "fixture", prompt: "fixture" } as never)
    const text = await runDispatchAgentTool({
      sessionId: "victim-chat", args: { subagentId: "coder", prompt: "fixture task", background: true },
    })
    const id = text.match(/runId: ([a-zA-Z0-9_-]+)/)?.[1]
    expect(id).toBeTruthy()
    await waitFor(() => mockDispatch.mock.calls[0])
    return id!
  }
  it("OBSERVED unrelated session can cancel a live renderer run by id", async () => {
    mockDispatch.mockImplementation((_def, _prompt, options) => new Promise((_resolve, reject) => {
      options?.abortSignal?.addEventListener("abort", () => reject(new Error("fixture aborted")))
    }))
    const id = await startVictim()
    const signal = mockDispatch.mock.calls[0][2]?.abortSignal
    const result = await runDispatchAgentTool({ sessionId: "unrelated-chat", args: { cancel: id } })
    expect(result).toContain("Cancelled run")
    expect(signal?.aborted).toBe(true)
    await waitFor(() => countRunningRendererBackgroundRuns() === 0 ? true : undefined)
  })
  it("OBSERVED unrelated session reaches the collect result before personal visibility", async () => {
    mockDispatch.mockResolvedValue(ok("NONPERSONAL VICTIM RESULT"))
    const id = await startVictim()
    const result = await runDispatchAgentTool({ sessionId: "unrelated-chat", args: { collect: id } })
    expect(result).toContain("NONPERSONAL VICTIM RESULT")
    expect(preparePersonalDerivedHistory).toHaveBeenCalledWith("unrelated-chat",
      expect.arrayContaining([expect.objectContaining({ content: expect.stringContaining("NONPERSONAL VICTIM RESULT") })]),
      expect.anything())
  })
  it("OBSERVED a foreground tool-capable transient failure reruns the whole attempt", async () => {
    mockGetSettings.mockResolvedValue({ subagentNesting: { enabled: true, maxDepth: 2, tokenBudget: 0, timeoutMs: 0, dispatchMaxRetries: 1 } } as never)
    let effects = 0
    mockDispatch.mockImplementation(async () => {
      effects += 1
      if (effects === 1) return { ...ok("effect happened"), finishReason: "error", errorEnvelope: {
        code: "network", retryable: true, message: "fixture lost ack", retryAfterMs: 1,
      } } as never
      return ok("second attempt")
    })
    await runDispatchAgentTool({ sessionId: "owner-chat", args: { subagentId: "coder", prompt: "fixture write", toolsEnabled: true } })
    expect(effects).toBe(2)
  })
})
`
)

fixture(
  "cli/src/agent/subagent-runner.test.ts",
  `
describe("audit probe CLI definition fidelity", () => {
  it("OBSERVED externalPresetId survives discovery but does not select the child backend", async () => {
    const observed: unknown[] = []
    const deps: RunCliSubagentDeps = {
      config: cfg({ agentBackend: "builtin" }), home: "/unused", cwd: "/work",
      gate: createPermissionGate({ yes: true }), mcpServers: [], approvedTools: new Set(), disabledMcpTools: new Set(),
      resolveOptions: jest.fn(async ctx => { observed.push(ctx); return {} }), resolveHooks: () => undefined,
      capture: jest.fn(async () => captureResult()), closeSession: jest.fn(async () => undefined), mintId: () => "audit",
    }
    const configured = jest.requireMock("@/cli/src/agent/configured-plugin-tool-handle").makeConfiguredCliPluginToolHandle
    configured.mockClear()
    await runCliSubagent(def({ externalPresetId: "codex", externalAgentConfigId: "exact-codex" }), "fixture", "owner", deps)
    expect(configured.mock.calls[0][0].agentBackend).toBe("builtin")
    expect(deps.capture).toHaveBeenCalledTimes(1)
    expect(observed.length).toBeGreaterThan(0)
  })
})
`
)

fixture(
  "lib/thread-handoff/orchestrator.test.ts",
  `
describe("audit probe handoff target requirements", () => {
  it("OBSERVED an earlier deployment with the same model wins over an explicit provider override", async () => {
    const frame = await buildThreadHandoffOffer(
      { ...session, providerOverride: "explicit-provider", model: "common-model" },
      { hostRef: "cloud", kind: "cloud" }, 1000,
      { messages: [], deployments: [
        { id: "wrong-deployment", providerRef: "wrong-provider", models: [{ id: "common-model" }],
          credentialProfileRef: { kind: "secret-store", secretId: "wrong-credential" } },
        { id: "explicit-provider", providerRef: "right-provider", models: [{ id: "common-model" }] },
      ] as never },
    )
    expect(frame.ticket.requirements.providerRefs).toEqual(["wrong-provider", "wrong-deployment"])
    expect(frame.ticket.requirements.credentialProfileRefs).toEqual(["secret-store:wrong-credential"])
    expect(frame.ticket.continuation.providerOverride).toBe("explicit-provider")
  })
  it("OBSERVED an external agent session is labeled cognia and carries no target runtime requirement", async () => {
    const frame = await buildThreadHandoffOffer(
      { ...session, sdkSessionId: undefined, externalAgentSession: { agentId: "codex-config", sessionId: "native-codex" } } as never,
      { hostRef: "cloud", kind: "cloud" }, 1000, { messages: [], deployments: [] },
    )
    expect(frame.envelope.header.sourceRuntime).toBe("cognia")
    expect(frame.ticket.continuation.sourceRuntime).toBe("cognia")
    expect(frame.ticket.requirements.hostOperations).toEqual([])
    expect(frame.ticket.continuation.fidelity).toBe("contextual")
    expect(frame.ticket.continuation).not.toHaveProperty("externalAgentSession")
  })
  it("OBSERVED historical tasks plans and checkpoints are omitted from the cross-host envelope", async () => {
    const historicalState = {
      tasks: [{ taskId: "task-1", title: "Still pending", status: "pending" }],
      plans: [{ planId: "plan-1", text: "Check the remaining files" }],
      checkpoints: [{ checkpointId: "checkpoint-1", summary: "Review incomplete" }],
    }
    const frame = await buildThreadHandoffOffer(
      { ...session, importCanonicalState: historicalState } as never,
      { hostRef: "cloud", kind: "cloud" }, 1000, { messages: [], deployments: [] },
    )
    expect(frame.envelope).not.toHaveProperty("tasks")
    expect(frame.envelope).not.toHaveProperty("plans")
    expect(frame.envelope).not.toHaveProperty("checkpoints")
    expect(frame.ticket.continuation.seedTranscript).toBeUndefined()
  })
})
`
)

fixture(
  "packages/agent-a2a/src/client.test.ts",
  `
describe("audit probe A2A task versus turn completion", () => {
  it.each(["input-required", "auth-required"])("OBSERVED %s becomes a successful generic result with no paused-task state", async state => {
    const ctx = {}
    const mapped = mapA2aResult({ id: "task-awaiting", contextId: "context-1", status: {
      state, message: { role: "agent", parts: [{ text: "Please supply the missing input" }] },
    } } as never, ctx)
    expect(mapped.done).toBe(true)
    expect(ctx).toMatchObject({ taskId: "task-awaiting" })
    const { BaseProtocolAdapter } = jest.requireActual("@cognia/agent-runtime-kit/base-adapter")
    const result = await BaseProtocolAdapter.prototype.execute.call({
      async *prompt() { yield* mapped.events },
      generateMessageId: () => "fixture-assistant",
    }, "fixture-session", { id: "fixture-message", role: "user", content: "fixture", timestamp: new Date() })
    expect(result.success).toBe(true)
    expect(result.finalResponse).toContain("Please supply")
    expect(result).not.toHaveProperty("taskState")
    expect(result).not.toHaveProperty("pendingInterrupt")
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
  const base = (config.projects as any[]).find(project => project.displayName === "node" || project.displayName?.name === "node")
  if (!base) throw new Error("node Jest project not found")
  return { ...config, projects: [{ ...base, rootDir: process.cwd(),
    roots: ["<rootDir>/.cache/handoff-dispatch-audit"],
    testMatch: ["<rootDir>/.cache/handoff-dispatch-audit/*.test.ts"],
    testPathIgnorePatterns: ["/node_modules/"], modulePathIgnorePatterns: ["/node_modules/"],
    cacheDirectory: "<rootDir>/.cache/handoff-dispatch-audit/jest-cache",
  }] }
}
`
)
const result = spawnSync(
  "pnpm",
  [
    "test",
    "--config",
    ".cache/handoff-dispatch-audit/jest.config.ts",
    "--runInBand",
    "--no-coverage",
    "-t",
    "audit probe",
  ],
  {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, pnpm_config_verify_deps_before_run: "false" },
  }
)
writeFileSync(resolve(output, "probes.log"), (result.stdout ?? "") + (result.stderr ?? ""))
process.stdout.write(result.stdout ?? "")
process.stderr.write(result.stderr ?? "")
if (result.error) throw result.error
process.exitCode = result.status ?? 1

import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { spawnSync } from "node:child_process"

const root = fileURLToPath(new URL("../../", import.meta.url))
const directory = path.join(root, ".cache", "agents-squads-adversarial-audit")
mkdirSync(directory, { recursive: true })

// Reuse the repository's test setup without changing its suites. A witness
// passes when the observed behavior is present, including the reported bugs.
function fixture(id, original, scenario, anchor) {
  const base = path.dirname(original)
  const source = readFileSync(path.join(root, original), "utf8").replace(
    /(["'])(\.\.?\/[^"'\n]+)\1/g,
    (_, quote, relative) => quote + "@/" + path.posix.normalize(base + "/" + relative) + quote
  )
  if (anchor && !source.includes(anchor)) throw new Error("Missing fixture anchor in " + original)
  const content = anchor
    ? source.replace(anchor, anchor + "\n" + scenario)
    : source + "\n" + scenario
  const filename = path.join(
    directory,
    id + (original.endsWith(".tsx") ? ".audit.tsx" : ".audit.ts")
  )
  writeFileSync(filename, content)
  return filename
}

const probes = {
  f02: () =>
    fixture(
      "f02",
      "lib/squads/agent-team-runtime.test.ts",
      String.raw`
it.each(["before start", "after the DAG snapshot"])(
  "Audit witness F02: dispatches a task cancelled %s",
  async (timing) => {
    const tasks = [task("first"), task("cancelled", ["first"])]
    if (timing === "before start") tasks[1] = { ...tasks[1]!, status: "cancelled" }
    const answer = {
      channel: "text", text: "synthetic output",
      usage: { promptTokens: 5, completionTokens: 3, totalTokens: 8 },
    }
    const executor = executeAgent as jest.Mock
    executor.mockReset()
    executor.mockResolvedValue(answer)
    executor.mockImplementationOnce(async () => {
      if (timing === "after the DAG snapshot") tasks[1] = { ...tasks[1]!, status: "cancelled" }
      return answer
    })
    const deps = buildDeps(baseTeam, tasks, [lead, worker("w1")])
    const result = await runTeamLifecycle("team-1", deps)
    expect(result.status).toBe("completed")
    expect(executor).toHaveBeenCalledTimes(2)
    expect(deps._taskStatuses.cancelled).toBe("completed")
  }, 12_000
)
`
    ),
  f04: () =>
    fixture(
      "f04",
      "lib/workflow/runtime/orchestrator.test.ts",
      String.raw`
it("Audit witness F04: even an immediate budget approval stalls the real scheduler at zero", async () => {
  const { createBudgetGuard } = await import("@/lib/squads/gates/budget-guard")
  const concurrency = createConcurrencyController(1)
  const guard = createBudgetGuard({
    runId: "audit-budget",
    limit: 100,
    onCritical: "pause_for_review",
    notifier: { notify: jest.fn() } as never,
  })
  guard.on("pause_for_review", () => concurrency.reduceTo(0))
  const ran: string[] = []
  registerNodeExecutor({
    kind: "test.async" as never,
    typeVersion: 1,
    execute: async ({ stepId }) => {
      ran.push(stepId)
      if (stepId === "a") {
        guard.add({ totalTokens: 96 } as never)
        guard.extendLimit(50)
      }
      return { output: {} }
    },
  })
  const workflow = buildAsyncWorkflow(["a", "b"], [["a", "b"]], 1)
  const result = await runWorkflow({ workflow, trigger, concurrency })
  expect(ran).toEqual(["a"])
  expect(guard.status()).toMatchObject({ used: 96, limit: 150, level: "ok" })
  expect(concurrency.get()).toBe(0)
  expect(result).toMatchObject({ status: "failed", error: { code: "orchestration_stalled" } })
}, 12_000)
`,
      'describe("runWorkflow — concurrent scheduling", () => {'
    ),
  f05: () =>
    fixture(
      "f05-settle",
      "lib/squads/room-handoff/settle.test.ts",
      String.raw`
it("Audit witness F05: copies the latest result to two completed attempts within 60 seconds", async () => {
  const w = world()
  w.delegations.push(delegation())
  w.attempts.set("execution:delegation:room-handoff:tu-1", [
    teamRun("execution:team:r1", "completed", NOW - 30_000),
    teamRun("execution:team:r2", "completed", NOW - 1_000),
  ])
  w.setMessages([proposalReply({ ...started, squadRunId: "execution:team:r2" })])
  w.deps.squadResult = () => ({ finalResult: "only the second result", completedAt: NOW - 1_000 })
  await expect(reconcileRoomHandoffs()).resolves.toBe(2)
  expect(w.reported.map(({ runId, resultText }) => [runId, resultText])).toEqual([
    ["squad-handoff:execution:team:r1", "only the second result"],
    ["squad-handoff:execution:team:r2", "only the second result"],
  ])
})
`,
      'describe("reconcileRoomHandoffs", () => {'
    ),
  f05boot: () =>
    fixture(
      "f05-boot",
      "lib/background-tasks/runtime-room-lane.test.ts",
      String.raw`
jest.mock("@/lib/squads/room-handoff/settle", () => ({ reconcileRoomHandoffs: jest.fn() }))

it("Audit witness F05: room boot consumes an existing outbox and never enters handoff reconciliation", async () => {
  const { reconcileRoomHandoffs } = await import("@/lib/squads/room-handoff/settle")
  listBackgroundTaskRecords.mockResolvedValueOnce([])
  const stopEmpty = await start()
  expect(reconcileRoomHandoffs).not.toHaveBeenCalled()
  expect(attemptBackgroundResultDelivery).not.toHaveBeenCalled()
  stopEmpty()
  listBackgroundTaskRecords.mockResolvedValueOnce([
    { kind: "squad-handoff", deliveryState: "pending", sessionId: "room-1" },
  ])
  const stopOwed = await start()
  expect(attemptBackgroundResultDelivery).toHaveBeenCalledWith("room-1")
  expect(reconcileRoomHandoffs).not.toHaveBeenCalled()
  stopOwed()
})
`
    ),
  f06: () =>
    fixture(
      "f06",
      "lib/squads/durable/durable-control.test.ts",
      String.raw`
const auditChildSteer = jest.fn()
jest.mock("@/lib/squads/durable/durable-runtime", () => ({
  ...jest.requireActual("@/lib/squads/durable/durable-runtime"),
  getDurableTeamCoordinator: () => ({ steer: auditChildSteer }),
}))

it.each([
  ["rejected", { status: "delivered", receiptIds: [] }],
  ["queued", { status: "delivered", receiptIds: ["audit-queued"] }],
])("Audit witness F06: top-level steer says delivered when child is %s", async (caseName, expected) => {
  if (caseName === "rejected") auditChildSteer.mockRejectedValueOnce(new Error("simulated refusal"))
  else auditChildSteer.mockResolvedValueOnce({ id: "audit-queued", status: "queued" })
  const { installExecutionRunControlHandlers } = await import("@/lib/execution/control-handlers")
  const { steerExecutionRun } = await import("@/lib/execution/steer")
  const handlers = installExecutionRunControlHandlers()
  try {
    const result = await steerExecutionRun(
      { id: "execution:team:run-1", sourceId: "run-1", kind: "team", status: "running" } as never,
      { target: { runId: "execution:team:run-1" }, origin: "person", content: "Use the next draft" }
    )
    expect(result).toEqual(expected)
  } finally {
    handlers.dispose()
  }
})
`,
      'describe("durable AgentTeam run controls", () => {'
    ),
  f07: () =>
    fixture(
      "f07",
      "lib/claude/build-options.test.ts",
      String.raw`
it("Audit witness F07: external profile offered by picker is absent in direct turn options", async () => {
  const { buildChatMentionTargets } = await import("@/lib/chat/mentions/agent-targets")
  const templateId = "audit-external-profile"
  useSubagentRuntimeStore.getState().addTemplate({
    id: templateId,
    name: "Audit External Profile",
    description: "Synthetic fixture without an external runner",
    category: "general",
    taskTemplate: "review {{x}}",
    config: { systemPrompt: "Review a sample.", externalPresetId: "audit-preset" },
    isBuiltIn: false,
  })
  try {
    const target = buildChatMentionTargets().find((entry) => entry.name === "Audit External Profile")
    expect(target).toBeDefined()
    const effective = await resolveSendOptions({
      character: makeChar({ id: "c1" }),
      targetAgentId: target!.id,
    })
    expect(effective.agents?.[target!.id]).toBeUndefined()
    expect(effective.agent).toBeUndefined()
  } finally {
    useSubagentRuntimeStore.getState().deleteTemplate(templateId)
  }
})
`
    ),
  f07markdown: () =>
    fixture(
      "f07-markdown",
      "lib/chat/mentions/markdown-agent-targets.test.ts",
      String.raw`
it("Audit witness F07: hidden and disabled Markdown profiles enter the picker and SDK map", async () => {
  const { buildMarkdownAgents, markdownAgentsToSdkMap } = await import("@/lib/agents/markdown-agents")
  const files = [
    file("hidden-fixture", "---\ndescription: Hidden\nhidden: true\n---\nfixture"),
    file("disabled-fixture", "---\ndescription: Disabled\ndisabled: true\n---\nfixture"),
  ]
  expect(markdownAgentTargets(files).map(({ id }) => id)).toEqual(["hidden-fixture", "disabled-fixture"])
  const map = markdownAgentsToSdkMap(buildMarkdownAgents(files).agents)
  expect(map["hidden-fixture"].hidden).toBe(true)
  expect(map["disabled-fixture"].disabled).toBe(true)
})
`
    ),
  f08: () =>
    fixture(
      "f08",
      "lib/agent/composition/verified-fresh-agent.test.ts",
      String.raw`
it("Audit witness F08: late arming drops a settled answer and browser transport rejects agent_send", async () => {
  const { WebStubTransport } = await import("@/lib/tauri/transport-web")
  const fake = fakeStore({
    [MAIN_ID]: {
      status: "idle",
      errorDiagnostic: null,
      messages: [text("audit-user", "user", "question"), text("audit-reply", "assistant", "done")],
    },
  })
  const deps = followupDeps(fake.store)
  const armed = await armVerifiedFreshAgentFollowup({ sessionId: MAIN_ID, request: "question", cwd: null }, deps)
  if (!armed.armed) throw new Error("expected watcher to arm")
  await armed.settled
  expect(deps.run).not.toHaveBeenCalled()
  expect(verificationAvailableOn("web-standalone")).toBe(true)
  await expect(new WebStubTransport().call("agent_send")).rejects.toMatchObject({ code: "no_host_transport" })
})
`
    ),
  f10: () =>
    fixture(
      "f10",
      "lib/squads/auto/auto-orchestrate.test.ts",
      String.raw`
it("Audit witness F10: a simple single-send recommendation calls all three model stages", async () => {
  const complete = jest.fn(async () => '{"recommendedPattern":"single_agent_recommended"}')
  const proposal = await planAutoOrchestration({
    objective: "Summarize one supplied paragraph",
    catalog: EMPTY_CAPABILITY_CATALOG,
    twinRoster: [],
    client: { complete },
  })
  expect(proposal.executor?.kind).toBe("single-send")
  expect(complete).toHaveBeenCalledTimes(3)
  expect(proposal.roster.length).toBeGreaterThan(1)
  expect(proposal.tasks.length).toBeGreaterThan(0)
})
`
    ),
  f10ui: () =>
    fixture(
      "f10-ui",
      "components/squads/auto-compose-dialog.test.tsx",
      String.raw`
it.each(["quick", "approve"])("Audit witness F10: %s materializes a single-send proposal", async (route) => {
  const { onComposed } = setup()
  const single = {
    ...proposal,
    executor: { kind: "single-send", fromPattern: "single_agent_recommended", confidence: 1, reason: "fixture" },
  }
  mockPlan.mockResolvedValueOnce(single as never)
  typeObjective("Summarize")
  if (route === "quick") fireEvent.click(screen.getByTestId("auto-compose-quick"))
  else {
    fireEvent.click(screen.getByTestId("auto-compose-submit"))
    fireEvent.click(await screen.findByTestId("auto-compose-approve"))
  }
  await waitFor(() => expect(mockMaterialize).toHaveBeenCalledWith(single, expect.any(Object)))
  expect(onComposed).toHaveBeenCalledWith("team-9")
})
`
    ),
  rest: () => {
    const target = path.join(directory, "direct.audit.ts")
    writeFileSync(
      target,
      String.raw`
import { createRunBudgetGovernor } from "@/lib/ai/agent/execution/run-budget-governor"
import { customModeFileSchema } from "@/cli/src/config/agent-mode"

it("Audit witness F03: a new governor for the same run loses its usage and extension", () => {
  const options = { runId: "audit-same-run", limit: 100, onCritical: "notify", notifier: { notify: jest.fn() } } as const
  const live = createRunBudgetGovernor(options as never)
  live.allocate("audit-child").add({ totalTokens: 96 } as never)
  live.guard.extendLimit(50)
  expect(live.totals()).toMatchObject({ usedTokens: 96, limit: 150 })
  const reopened = createRunBudgetGovernor(options as never)
  expect(reopened.totals()).toMatchObject({ usedTokens: 0, limit: 100 })
  expect(reopened.children()).toEqual([])
})

it("Audit witness F11: CLI rejects the GUI envelope and accepts the flat format", () => {
  const mode = { name: "Review", permissionMode: "plan" }
  expect(customModeFileSchema.safeParse(mode).success).toBe(true)
  expect(customModeFileSchema.safeParse({ version: "1.0", type: "custom-mode", mode }).success).toBe(false)
})
`
    )
    return target
  },
}

const names = process.argv.slice(2)
const selected = names.length > 0 ? names : Object.keys(probes)
const files = selected.map((name) => {
  if (!Object.hasOwn(probes, name)) throw new Error("Unknown probe: " + name)
  return probes[name]()
})

const config = path.join(directory, "jest.audit.config.mjs")
writeFileSync(
  config,
  String.raw`
import buildConfig from "../../jest.config.ts"
import { fileURLToPath } from "node:url"

export default async () => {
  const config = await buildConfig()
  const projects = config.projects
    .filter(({ displayName }) => ["node", "jsdom"].includes(displayName.name ?? displayName))
    .map((project) => ({
      ...project,
      rootDir: process.cwd(),
      roots: [fileURLToPath(new URL(".", import.meta.url))],
      testPathIgnorePatterns: ["/node_modules/"],
      modulePathIgnorePatterns: project.modulePathIgnorePatterns.filter((pattern) => !pattern.includes(".cache")),
      testMatch: [(project.displayName.name ?? project.displayName) === "jsdom" ? "**/*.audit.tsx" : "**/*.audit.ts"],
    }))
  return { ...config, rootDir: process.cwd(), projects }
}
`
)
const outcome = spawnSync(
  "pnpm",
  [
    "test",
    "--",
    "--config",
    config,
    "--runInBand",
    "--runTestsByPath",
    ...files,
    "-t",
    "Audit witness",
  ],
  {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, pnpm_config_verify_deps_before_run: "false" },
    timeout: 60_000,
  }
)

if (outcome.error) console.error(outcome.error.message)
process.exitCode = outcome.status ?? 1

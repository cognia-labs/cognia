/** @jest-environment jsdom */
import "fake-indexeddb/auto"
import { beginCapturedTurn } from "@/lib/policy/action-review/captured-turns"
import { getDb, __resetDbForTesting } from "@/lib/db/schema"
import { getExecutionRun } from "@/lib/db/execution-runs"
import { getBackgroundTaskRecord } from "@/lib/db/background-tasks"
import { redispatchBackgroundRun } from "@/lib/background-tasks/redispatch"
import { startAcceptedRendererBackgroundRun } from "@/lib/background-tasks/renderer-subagent-registry"
import {
  startToolExecutionRun,
  finishToolExecutionRun,
  LOCAL_PERSON_RUN,
} from "@/lib/execution/acting-authority"
import { assertLarkActingIdentity } from "@/lib/auth-providers/feishu/cli/acting-identity"
import { dispatchSubagent } from "@/lib/plugin/agent-sdk/dispatch"
import { runDispatchAgentTool } from "./dispatch-agent-handler"
import { resolveCaller, startDispatchRun } from "./dispatch-run"
import {
  registerDispatchContext,
  __clearAllDispatchContextsForTesting,
} from "./dispatch-context-registry"
import { getSettings } from "@/lib/db/settings"

jest.mock("@/lib/plugin/agent-sdk/dispatch", () => ({ dispatchSubagent: jest.fn() }))
jest.mock("./subagents", () => ({
  getDispatchableSubagentDef: () => ({ id: "reader", name: "Reader", prompt: "Read", tools: [] }),
}))
jest.mock("@/lib/db/settings", () => ({
  getSettings: jest.fn(async () => ({ subagentNesting: { maxDepth: 2, tokenBudget: 0 } })),
}))
jest.mock("@/lib/device/device-identity", () => ({ getDeviceId: async () => "test-host" }))
jest.mock("@/lib/workspace/session-cwd", () => ({ resolveSessionCwd: async () => undefined }))
jest.mock("@/lib/tauri", () => ({ isTauri: () => false }))
jest.mock("@/lib/ai/agent/execution/host-environment", () => ({
  resolveAgentExecutionEnvironment: () => ({ pairedHost: false, isHeadlessHost: false }),
}))
jest.mock("@/lib/plugin/registries/hook-registry", () => ({ listEnabledHookPlugins: () => [] }))
jest.mock("@/lib/background-tasks/renderer-subagent-registry", () => ({
  startAcceptedRendererBackgroundRun: jest.fn(),
  journalRendererForegroundRun: async (_id: string, _meta: unknown, result: Promise<unknown>) =>
    result,
}))

const personalChecks = new Map<string, boolean>()

beforeEach(async () => {
  jest.clearAllMocks()
  __clearAllDispatchContextsForTesting()
  personalChecks.clear()
  await getDb().delete()
  __resetDbForTesting()
  await getDb().sessions.put({ id: "desktop", title: "Desktop", createdAt: 1, updatedAt: 1 })
  jest.mocked(dispatchSubagent).mockImplementation(async (_target, prompt, options) => {
    try {
      await assertLarkActingIdentity("lark", {
        sessionId: "desktop",
        executionRunId: `execution:job:${options?._runId}`,
      })
      personalChecks.set(prompt, true)
    } catch {
      personalChecks.set(prompt, false)
    }
    return { text: "done", channel: "text", toolsAvailable: false }
  })
})

afterEach(async () => {
  const active = await getDb().executionRuns.where("sessionId").equals("desktop").toArray()
  for (const run of active) await finishToolExecutionRun(run.id)
})

async function settleBackground() {
  const calls = jest.mocked(startAcceptedRendererBackgroundRun).mock.calls
  await calls.at(-1)![2]
}

async function interrupt(runId: string) {
  const record = (await getBackgroundTaskRecord(runId))!
  await getDb().backgroundTasks.update(runId, {
    status: "interrupted",
    ownerLease: { ...record.ownerLease!, expiresAt: 0 },
  })
  return (await getBackgroundTaskRecord(runId))!
}

async function admit(background = true, executionRunId?: string) {
  const result = await startDispatchRun({
    subagentId: "reader",
    prompt: "original",
    toolsEnabled: false,
    background,
    parentSessionId: "desktop",
    caller: await resolveCaller("desktop"),
    ...(executionRunId !== undefined ? { executionRunId } : {}),
  })
  expect(result.error).toBeUndefined()
  if (background) await settleBackground()
  return result
}

it.each(["auto", "manual"] as const)(
  "persists the original parent and uses its finished automated identity on %s recovery during a new local turn",
  async (kind) => {
    await startToolExecutionRun("desktop", { runId: "automated-root" })
    const original = await admit()
    expect((await getBackgroundTaskRecord(original.runId))?.recovery).toMatchObject({
      parentExecutionRunId: "automated-root",
    })
    await finishToolExecutionRun("automated-root")
    await startToolExecutionRun("desktop", {
      runId: "new-local",
      localAuthorization: LOCAL_PERSON_RUN,
    })
    const record = await interrupt(original.runId)
    const result = await redispatchBackgroundRun(record, { kind })
    if (!result.ok) throw new Error(result.message)
    await settleBackground()
    expect(await getExecutionRun(`execution:job:${result.runId}`)).toMatchObject({
      parentRunId: "automated-root",
      actingIdentity: { trigger: "external-event", rootRunId: "automated-root" },
    })
    expect(personalChecks.get("original")).toBe(false)
  }
)

it("keeps a finished local parent's identity on recovery during an automated turn", async () => {
  await startToolExecutionRun("desktop", {
    runId: "local-root",
    localAuthorization: LOCAL_PERSON_RUN,
  })
  const original = await admit()
  await finishToolExecutionRun("local-root")
  await startToolExecutionRun("desktop", { runId: "new-automated" })
  const result = await redispatchBackgroundRun(await interrupt(original.runId), { kind: "auto" })
  if (!result.ok) throw new Error(result.message)
  await settleBackground()
  expect(await getExecutionRun(`execution:job:${result.runId}`)).toMatchObject({
    parentRunId: "local-root",
    actingIdentity: { trigger: "local", rootRunId: "local-root" },
  })
  expect(personalChecks.get("original")).toBe(true)
})

// The child's row is the launcher's, written from the admission pin: a local
// run that started in the session since cannot become its parent.
it("keeps the admitted automated parent when a local run starts before dispatch", async () => {
  await startToolExecutionRun("desktop", { runId: "automated-root" })
  await finishToolExecutionRun("automated-root")
  await startToolExecutionRun("desktop", {
    runId: "new-local",
    localAuthorization: LOCAL_PERSON_RUN,
  })
  const child = await admit(true, "automated-root")
  expect(await getExecutionRun(`execution:job:${child.runId}`)).toMatchObject({
    parentRunId: "automated-root",
    actingIdentity: { trigger: "external-event", rootRunId: "automated-root" },
  })
  expect(personalChecks.get("original")).toBe(false)
})

it("allows a normal background child of a local turn", async () => {
  await startToolExecutionRun("desktop", {
    runId: "local-root",
    localAuthorization: LOCAL_PERSON_RUN,
  })
  const original = await admit()
  expect(await getExecutionRun(`execution:job:${original.runId}`)).toMatchObject({
    parentRunId: "local-root",
    actingIdentity: { trigger: "local", authorizingPrincipal: { kind: "local-person" } },
  })
  expect(personalChecks.get("original")).toBe(true)
})

it("freezes the originating approval channel into dispatch and durable recovery", async () => {
  const end = beginCapturedTurn("desktop", {
    turnId: "bot-turn",
    outboundPolicy: { unattended: true },
  })
  try {
    await startToolExecutionRun("desktop", { runId: "bot-origin" })
    const result = await admit()
    expect(jest.mocked(dispatchSubagent).mock.calls.at(-1)?.[2]?._approvalRoute).toMatchObject({
      rootSessionId: "desktop",
      approvalOrigin: { unattended: true },
    })
    expect((await getBackgroundTaskRecord(result.runId))?.recovery).toMatchObject({
      approvalOrigin: { unattended: true },
      parentExecutionRunId: "bot-origin",
    })
  } finally {
    end()
  }
})

it.each(["missing-pin", "missing-run"])(
  "recovers %s without borrowing the active local run",
  async (missing) => {
    await startToolExecutionRun("desktop", { runId: "old-root" })
    const original = await admit()
    await finishToolExecutionRun("old-root")
    const record = (await getBackgroundTaskRecord(original.runId))!
    const recovery = { ...record.recovery! }
    if (missing === "missing-pin") Reflect.deleteProperty(recovery, "parentExecutionRunId")
    else await getDb().executionRuns.delete("old-root")
    await getDb().backgroundTasks.update(original.runId, { recovery })
    await interrupt(original.runId)
    await startToolExecutionRun("desktop", {
      runId: "new-local",
      localAuthorization: LOCAL_PERSON_RUN,
    })
    const result = await redispatchBackgroundRun((await getBackgroundTaskRecord(original.runId))!, {
      kind: "auto",
    })
    if (!result.ok) throw new Error(result.message)
    await settleBackground()
    const child = await getExecutionRun(`execution:job:${result.runId}`)
    expect(child?.parentRunId).toBeUndefined()
    expect(child?.actingIdentity?.trigger).toBe("external-event")
    expect(personalChecks.get("original")).toBe(false)
  }
)

it.each([false, true])(
  "uses the IPC run for a fresh dispatch (background=%s)",
  async (background) => {
    await startToolExecutionRun("desktop", { runId: "issuer" })
    await finishToolExecutionRun("issuer")
    await startToolExecutionRun("desktop", {
      runId: "new-local",
      localAuthorization: LOCAL_PERSON_RUN,
    })
    await runDispatchAgentTool({
      sessionId: "desktop",
      executionRunId: "issuer",
      args: { subagentId: "reader", prompt: "IPC dispatch", background },
    })
    if (background) await settleBackground()
    const children = await getDb().executionRuns.where("parentRunId").equals("issuer").toArray()
    expect(children).toHaveLength(1)
    expect(personalChecks.get("IPC dispatch")).toBe(false)
  }
)

it("does not borrow a local run for an unknown correlated IPC request", async () => {
  await startToolExecutionRun("desktop", {
    runId: "new-local",
    localAuthorization: LOCAL_PERSON_RUN,
  })
  const child = await admit(false, "")
  expect((await getExecutionRun(`execution:job:${child.runId}`))?.parentRunId).toBeUndefined()
  expect(personalChecks.get("original")).toBe(false)
})

it("pins a nested caller's job run instead of the session's active local root", async () => {
  await startToolExecutionRun("desktop", { runId: "automated-root" })
  await startToolExecutionRun("desktop", {
    runId: "execution:job:parent",
    parentRunId: "automated-root",
  })
  await startToolExecutionRun("desktop", {
    runId: "new-local",
    localAuthorization: LOCAL_PERSON_RUN,
  })
  registerDispatchContext("desktop", {
    selfRunId: "parent",
    depth: 1,
    maxDepth: 3,
    parentChain: ["parent"],
  })
  const child = await admit()
  expect(await getExecutionRun(`execution:job:${child.runId}`)).toMatchObject({
    parentRunId: "execution:job:parent",
  })
  expect(personalChecks.get("original")).toBe(false)
})

it("pins before asynchronous admission even when a local turn starts while settings load", async () => {
  await startToolExecutionRun("desktop", { runId: "automated-root" })
  const caller = await resolveCaller("desktop")
  let release!: () => void
  let entered!: () => void
  const loading = new Promise<void>((resolve) => {
    entered = resolve
  })
  const blocked = new Promise<void>((resolve) => {
    release = resolve
  })
  jest.mocked(getSettings).mockImplementationOnce(async () => {
    entered()
    await blocked
    return { subagentNesting: { maxDepth: 2, tokenBudget: 0 } } as never
  })
  const dispatch = startDispatchRun({
    subagentId: "reader",
    prompt: "original",
    toolsEnabled: false,
    background: true,
    parentSessionId: "desktop",
    caller,
  })
  await loading
  await finishToolExecutionRun("automated-root")
  await startToolExecutionRun("desktop", {
    runId: "new-local",
    localAuthorization: LOCAL_PERSON_RUN,
  })
  release()
  const child = await dispatch
  await settleBackground()
  expect(await getExecutionRun(`execution:job:${child.runId}`)).toMatchObject({
    parentRunId: "automated-root",
  })
  expect(personalChecks.get("original")).toBe(false)
})

it("resumes a background task with its pinned parent while a new local turn is active", async () => {
  await startToolExecutionRun("desktop", { runId: "old-root" })
  const original = await admit()
  await finishToolExecutionRun("old-root")
  await getDb().backgroundTasks.update(original.runId, { status: "done" })
  await startToolExecutionRun("desktop", {
    runId: "new-local",
    localAuthorization: LOCAL_PERSON_RUN,
  })
  await runDispatchAgentTool({
    sessionId: "desktop",
    args: { resume: original.runId, prompt: "continue" },
  })
  const record = (await getBackgroundTaskRecord(original.runId))!
  expect(record.resumedByRunId).toBeDefined()
  expect(await getExecutionRun(`execution:job:${record.resumedByRunId}`)).toMatchObject({
    parentRunId: "old-root",
  })
  const checks = [...personalChecks.values()]
  expect(checks).toEqual([false, false])
})

/** @jest-environment jsdom */
import "fake-indexeddb/auto"

const executeAgentMock = jest.fn()
jest.mock("@/lib/ai/agent/agent-executor", () => ({
  executeAgent: (...args: unknown[]) => executeAgentMock(...args),
}))

const externalExecuteMock = jest.fn()
jest.mock("@/lib/ai/agent/external/manager", () => ({
  getExternalAgentManager: () => ({ execute: externalExecuteMock }),
}))

const placeDispatchedAgentMock = jest.fn(async (..._args: unknown[]) => undefined)
jest.mock("@/lib/sandbox/host-agent-placement", () => ({
  placeDispatchedAgent: (...args: unknown[]) => placeDispatchedAgentMock(...args),
}))

// A Job Center stand-in: one controller per registered id, like the real one.
const registered = new Map<string, AbortController>()
const registerAgentMock = jest.fn((id: string, _options: unknown) => {
  if (registered.has(id)) throw new Error("Background agent already registered")
  const controller = new AbortController()
  registered.set(id, controller)
  return controller.signal
})
const finishAgentMock = jest.fn((id: string, _outcome: unknown) => registered.delete(id))
jest.mock("@/lib/ai/agent/background-agent-manager", () => ({
  getBackgroundAgentManager: () => ({
    registerAgent: (id: string, options: unknown) => registerAgentMock(id, options),
    finishAgent: (id: string, outcome: unknown) => finishAgentMock(id, outcome),
  }),
}))

const ports = new Map<string, unknown>()
jest.mock("@/lib/modules/ports", () => ({
  loadPort: async (id: string) => ports.get(id) ?? null,
}))

import {
  __resetAgentTraceEmitterForTesting,
  setAgentTraceWriter,
} from "@cognia/agent-trace/emitter"
import type { AgentCapabilityGrantV1 } from "@cognia/agent-config-types/agent-capability-grant"
import { __resetDbForTesting, getDb } from "@/lib/db/schema"
import { createExecutionRun, getExecutionRun } from "@/lib/db/execution-runs"
import type { AgentTraceSpan } from "@/types/agent-trace/span"
import type { ChildRunOutcome, StartedChildEngine } from "@/types/execution/child-run"
import type { ExecutionRun } from "@/types/execution/run"
import type { SquadLaunchInput, SquadLaunchResult } from "@/types/modules/ports/squad-launch"
import type { TwinAnswerInput } from "@/types/modules/ports/twin-answer"
import {
  childJobExecutionRunId,
  grantFieldsSet,
  launchChildRun,
  startAgentEngine,
  type LaunchChildRunResult,
} from "./launch-child-run"

const PARENT_ID = "execution:team:run_team_parent"

async function seedParent(overrides: Partial<ExecutionRun> = {}): Promise<void> {
  await createExecutionRun({
    id: PARENT_ID,
    kind: "team",
    sourceId: "run_team_parent",
    sessionId: "session-parent",
    title: "Squad run",
    status: "running",
    currentRevision: 0,
    startedAt: 1,
    updatedAt: 1,
    ...overrides,
  })
}

function started(result: LaunchChildRunResult) {
  if (!result.started) throw new Error(`expected a started child, got ${result.reason}`)
  return result
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const grant = (fields: Partial<AgentCapabilityGrantV1>): AgentCapabilityGrantV1 => ({
  schemaVersion: 1,
  source: { kind: "agent-team", id: "squad-1" },
  ...fields,
})

let spans: AgentTraceSpan[]

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  executeAgentMock.mockReset()
  externalExecuteMock.mockReset()
  placeDispatchedAgentMock.mockReset()
  placeDispatchedAgentMock.mockImplementation(async () => undefined)
  registerAgentMock.mockClear()
  finishAgentMock.mockClear()
  registered.clear()
  ports.clear()
  __resetAgentTraceEmitterForTesting()
  spans = []
  setAgentTraceWriter((span) => spans.push(span))
})

describe("grantFieldsSet", () => {
  it("lists the fields a grant sets, never its version or source", () => {
    expect(grantFieldsSet(grant({}))).toEqual([])
    expect(grantFieldsSet(grant({ tools: { deny: ["Bash"] }, model: undefined }))).toEqual([
      "tools",
    ])
  })
})

describe("launchChildRun: agent", () => {
  it("writes the child's job row under its parent before the engine starts, then settles it", async () => {
    await seedParent()
    let rowAtStart: ExecutionRun | undefined
    executeAgentMock.mockImplementation(async () => {
      rowAtStart = await getExecutionRun(childJobExecutionRunId("child-1"))
      return { text: "the answer", channel: "sidecar", toolsAvailable: true }
    })

    const launched = started(
      await launchChildRun({
        parentRunId: PARENT_ID,
        target: { kind: "agent", prompt: "do the thing", systemPrompt: "be brief" },
        title: "team-delegation:d1",
        childId: "child-1",
      })
    )

    expect(launched.executionRunId).toBe("execution:job:child-1")
    await expect(launched.outcome).resolves.toEqual({ status: "completed", text: "the answer" })
    expect(rowAtStart).toMatchObject({
      kind: "job",
      parentRunId: PARENT_ID,
      // The parent's conversation, when the caller names none.
      sessionId: "session-parent",
      title: "team-delegation:d1",
      status: "running",
    })
    expect(executeAgentMock).toHaveBeenCalledWith(
      "do the thing",
      expect.objectContaining({ systemPrompt: "be brief", abortSignal: expect.any(AbortSignal) })
    )
    const row = await getExecutionRun(launched.executionRunId)
    expect(row?.status).toBe("completed")
    expect(row?.actingIdentity?.trigger).toBe("child")
  })

  it("parents the child on its delegation when it belongs to one", async () => {
    await seedParent()
    await seedParent({ id: "execution:delegation:dl-1", kind: "delegation", sourceId: "dl-1" })
    executeAgentMock.mockResolvedValue({ text: "", channel: "sidecar", toolsAvailable: true })
    const launched = started(
      await launchChildRun({
        parentRunId: PARENT_ID,
        delegationRunId: "execution:delegation:dl-1",
        target: { kind: "agent", prompt: "p" },
        title: "t",
      })
    )
    await launched.outcome
    expect((await getExecutionRun(launched.executionRunId))?.parentRunId).toBe(
      "execution:delegation:dl-1"
    )
  })

  it("refuses a parent that has no row and writes nothing", async () => {
    const result = await launchChildRun({
      parentRunId: "execution:team:missing",
      target: { kind: "agent", prompt: "p" },
      title: "t",
      childId: "orphan",
    })
    expect(result).toEqual({
      started: false,
      reason: "parent_not_found",
      detail: "execution:team:missing",
    })
    expect(await getExecutionRun(childJobExecutionRunId("orphan"))).toBeUndefined()
    expect(executeAgentMock).not.toHaveBeenCalled()
  })

  it("hands the grants to executeAgent, which applies every field", async () => {
    executeAgentMock.mockResolvedValue({ text: "ok", channel: "sidecar", toolsAvailable: true })
    const grants = [grant({ tools: { deny: ["Bash"] }, instructions: ["cite sources"] })]
    const launched = started(
      await launchChildRun({ target: { kind: "agent", prompt: "p" }, grants, title: "t" })
    )
    await launched.outcome
    expect(executeAgentMock.mock.calls[0][1].capabilityGrants).toEqual(grants)
  })

  it("settles a thrown run as failed, on the row and in the outcome", async () => {
    executeAgentMock.mockRejectedValue(new Error("provider down"))
    const launched = started(
      await launchChildRun({ target: { kind: "agent", prompt: "p" }, title: "t" })
    )
    await expect(launched.outcome).resolves.toEqual({ status: "failed", error: "provider down" })
    expect((await getExecutionRun(launched.executionRunId))?.status).toBe("failed")
  })

  it("refuses to start once the signal is aborted, and writes nothing", async () => {
    const controller = new AbortController()
    controller.abort()
    const result = await launchChildRun({
      target: { kind: "agent", prompt: "p" },
      title: "t",
      childId: "never",
      signal: controller.signal,
    })
    expect(result).toEqual({ started: false, reason: "cancelled" })
    expect(await getExecutionRun(childJobExecutionRunId("never"))).toBeUndefined()
  })

  it("stops the engine on abort and settles the row cancelled", async () => {
    executeAgentMock.mockImplementation(
      (_prompt: string, config: { abortSignal: AbortSignal }) =>
        new Promise((_resolve, reject) =>
          config.abortSignal.addEventListener("abort", () => reject(new Error("aborted")))
        )
    )
    const controller = new AbortController()
    const launched = started(
      await launchChildRun({
        target: { kind: "agent", prompt: "p" },
        title: "t",
        signal: controller.signal,
      })
    )
    controller.abort(new Error("team delegation cancelled"))
    await expect(launched.outcome).resolves.toMatchObject({ status: "cancelled" })
    expect((await getExecutionRun(launched.executionRunId))?.status).toBe("cancelled")
  })

  it("registers a background child in the Job Center only after its row exists, and settles the entry", async () => {
    let rowAtRegistration: ExecutionRun | undefined
    registerAgentMock.mockImplementationOnce((id: string) => {
      void getExecutionRun(childJobExecutionRunId(id)).then((row) => {
        rowAtRegistration = row
      })
      const controller = new AbortController()
      registered.set(id, controller)
      return controller.signal
    })
    executeAgentMock.mockResolvedValue({ text: "done", channel: "sidecar", toolsAvailable: true })
    const launched = started(
      await launchChildRun({
        target: {
          kind: "agent",
          prompt: "summarise",
          background: { label: "team-delegation:d1", kind: "team-delegation" },
        },
        title: "team-delegation:d1",
        childId: "bg_1",
      })
    )
    await launched.outcome
    expect(rowAtRegistration?.id).toBe("execution:job:bg_1")
    expect(registerAgentMock).toHaveBeenCalledWith("bg_1", {
      label: "team-delegation:d1",
      kind: "team-delegation",
      prompt: "summarise",
    })
    expect(finishAgentMock).toHaveBeenCalledWith("bg_1", { text: "done" })
  })

  it("stops a background child cancelled from the Job Center", async () => {
    executeAgentMock.mockImplementation(
      (_prompt: string, config: { abortSignal: AbortSignal }) =>
        new Promise((_resolve, reject) =>
          config.abortSignal.addEventListener("abort", () => reject(new Error("aborted")))
        )
    )
    const launched = started(
      await launchChildRun({
        target: {
          kind: "agent",
          prompt: "p",
          background: { label: "team-delegation:d2", kind: "team-delegation" },
        },
        title: "t",
        childId: "bg_2",
      })
    )
    registered.get("bg_2")!.abort()
    await expect(launched.outcome).resolves.toMatchObject({ status: "cancelled" })
    expect(finishAgentMock).toHaveBeenCalledWith(
      "bg_2",
      expect.objectContaining({ error: expect.any(String) })
    )
    expect((await getExecutionRun(launched.executionRunId))?.status).toBe("cancelled")
  })

  it("fails a child whose Job Center id is taken without settling the other entry", async () => {
    registered.set("bg_taken", new AbortController())
    const launched = started(
      await launchChildRun({
        target: {
          kind: "agent",
          prompt: "p",
          background: { label: "team-delegation:d3", kind: "team-delegation" },
        },
        title: "t",
        childId: "bg_taken",
      })
    )
    await expect(launched.outcome).resolves.toMatchObject({ status: "failed" })
    expect(finishAgentMock).not.toHaveBeenCalled()
    expect(executeAgentMock).not.toHaveBeenCalled()
  })
})

describe("launchChildRun: a caller's own agent engine", () => {
  it("writes the row first, runs the caller's engine and settles the row from its outcome", async () => {
    await seedParent()
    let rowAtRun: ExecutionRun | undefined
    const run = jest.fn(async (signal: AbortSignal) => {
      rowAtRun = await getExecutionRun(childJobExecutionRunId("dispatch-1"))
      expect(signal.aborted).toBe(false)
      return { status: "completed" as const, text: "dispatched answer" }
    })
    const launched = started(
      await launchChildRun({
        parentRunId: PARENT_ID,
        sessionId: "chat-1",
        target: { kind: "agent", label: "coder", engine: { run } },
        title: "coder",
        childId: "dispatch-1",
      })
    )
    await expect(launched.outcome).resolves.toEqual({
      status: "completed",
      text: "dispatched answer",
    })
    expect(rowAtRun).toMatchObject({
      parentRunId: PARENT_ID,
      sessionId: "chat-1",
      status: "running",
    })
    expect((await getExecutionRun(launched.executionRunId))?.status).toBe("completed")
    expect(spans[0]).toMatchObject({ providerName: "cognia.subagent", agentId: "coder" })
    // The caller keeps its own journal: no Job Center entry from here.
    expect(registerAgentMock).not.toHaveBeenCalled()
  })

  it("refuses grants, which the caller's engine does not apply", async () => {
    const run = jest.fn()
    await expect(
      launchChildRun({
        target: { kind: "agent", label: "coder", engine: { run } },
        grants: [grant({ model: "m" })],
        title: "coder",
      })
    ).resolves.toEqual({ started: false, reason: "grant_not_honoured", detail: "model" })
    expect(run).not.toHaveBeenCalled()
  })

  it("aborts the engine's signal on a stop and fails a throwing engine", async () => {
    const controller = new AbortController()
    let seen: AbortSignal | undefined
    const stopped = started(
      await launchChildRun({
        target: {
          kind: "agent",
          label: "coder",
          engine: {
            run: (signal) =>
              new Promise((resolve) => {
                seen = signal
                signal.addEventListener("abort", () => resolve({ status: "cancelled" }))
              }),
          },
        },
        title: "coder",
        signal: controller.signal,
      })
    )
    controller.abort()
    await expect(stopped.outcome).resolves.toEqual({ status: "cancelled" })
    expect(seen?.aborted).toBe(true)
    expect((await getExecutionRun(stopped.executionRunId))?.status).toBe("cancelled")

    const thrown = started(
      await launchChildRun({
        target: {
          kind: "agent",
          label: "coder",
          engine: {
            run: async () => {
              throw new Error("dispatch crashed")
            },
          },
        },
        title: "coder",
      })
    )
    await expect(thrown.outcome).resolves.toEqual({ status: "failed", error: "dispatch crashed" })
  })

  it("starts unparented when asked to, for a pin whose row is gone", async () => {
    const launched = started(
      await launchChildRun({
        parentRunId: "execution:tool:gone",
        missingParent: "unparented",
        target: {
          kind: "agent",
          label: "coder",
          engine: { run: async () => ({ status: "completed" as const }) },
        },
        title: "coder",
      })
    )
    await launched.outcome
    expect((await getExecutionRun(launched.executionRunId))?.parentRunId).toBeUndefined()
  })
})

describe("launchChildRun: external", () => {
  it("refuses a grant the external harness would ignore, before writing anything", async () => {
    const result = await launchChildRun({
      target: { kind: "external", agentId: "codex", prompt: "p" },
      grants: [grant({ tools: { deny: ["Bash"] } })],
      title: "t",
      childId: "ext-1",
    })
    expect(result).toEqual({ started: false, reason: "grant_not_honoured", detail: "tools" })
    expect(await getExecutionRun(childJobExecutionRunId("ext-1"))).toBeUndefined()
  })

  it("places the agent, runs it in the working directory and returns its answer", async () => {
    externalExecuteMock.mockResolvedValue({ success: true, finalResponse: "patched" })
    const launched = started(
      await launchChildRun({
        target: {
          kind: "external",
          agentId: "claude-code",
          prompt: "fix it",
          systemPrompt: "sys",
          workingDirectory: "/repo",
        },
        // A grant that sets nothing is not a widening.
        grants: [grant({})],
        title: "t",
      })
    )
    await expect(launched.outcome).resolves.toEqual({ status: "completed", text: "patched" })
    expect(placeDispatchedAgentMock).toHaveBeenCalledWith("claude-code", "/repo", expect.anything())
    expect(externalExecuteMock).toHaveBeenCalledWith(
      "claude-code",
      "fix it",
      expect.objectContaining({ systemPrompt: "sys", workingDirectory: "/repo" })
    )
    expect((await getExecutionRun(launched.executionRunId))?.status).toBe("completed")
  })

  it("fails on a placement refusal without running the agent", async () => {
    placeDispatchedAgentMock.mockRejectedValue(new Error("environment refused"))
    const launched = started(
      await launchChildRun({
        target: { kind: "external", agentId: "codex", prompt: "p" },
        title: "t",
      })
    )
    await expect(launched.outcome).resolves.toEqual({
      status: "failed",
      error: "environment refused",
    })
    expect(externalExecuteMock).not.toHaveBeenCalled()
  })

  it("reports the agent's own failure", async () => {
    externalExecuteMock.mockResolvedValue({ success: false, error: "boom" })
    const launched = started(
      await launchChildRun({
        target: { kind: "external", agentId: "codex", prompt: "p" },
        title: "t",
      })
    )
    await expect(launched.outcome).resolves.toEqual({ status: "failed", error: "boom" })
  })

  it("ends the run at its deadline and says so", async () => {
    externalExecuteMock.mockImplementation(
      (_id: string, _prompt: string, options: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) =>
          options.signal.addEventListener("abort", () => reject(new Error("timed out")))
        )
    )
    const launched = started(
      await launchChildRun({
        target: { kind: "external", agentId: "codex", prompt: "p", timeoutMs: 5 },
        title: "t",
      })
    )
    await expect(launched.outcome).resolves.toEqual({
      status: "failed",
      error: "timed out",
      timedOut: true,
    })
    expect((await getExecutionRun(launched.executionRunId))?.status).toBe("failed")
  })

  it("does not start the agent when stopped during placement", async () => {
    const placement = deferred<undefined>()
    placeDispatchedAgentMock.mockImplementation(() => placement.promise)
    const controller = new AbortController()
    const launched = started(
      await launchChildRun({
        target: { kind: "external", agentId: "codex", prompt: "p" },
        title: "t",
        signal: controller.signal,
      })
    )
    controller.abort()
    placement.resolve(undefined)
    await expect(launched.outcome).resolves.toMatchObject({ status: "cancelled" })
    expect(externalExecuteMock).not.toHaveBeenCalled()
  })
})

describe("launchChildRun: twin", () => {
  it("answers through the twin-answer port with the grants", async () => {
    const start = jest.fn((_input: TwinAnswerInput): StartedChildEngine => ({
      outcome: Promise.resolve({ status: "completed", text: "as the twin" }),
      stop: jest.fn(),
    }))
    ports.set("twin-answer", { start })
    const grants = [grant({ knowledgeBases: { add: ["kb-1"] } })]
    const launched = started(
      await launchChildRun({
        target: { kind: "twin", twinId: "twin-1", question: "what now?", systemPrompt: "base" },
        grants,
        title: "t",
      })
    )
    await expect(launched.outcome).resolves.toEqual({ status: "completed", text: "as the twin" })
    expect(start).toHaveBeenCalledWith({
      twinId: "twin-1",
      question: "what now?",
      systemPrompt: "base",
      grants,
    })
    expect((await getExecutionRun(launched.executionRunId))?.status).toBe("completed")
  })

  it("fails the child when no module provides the port", async () => {
    const launched = started(
      await launchChildRun({
        target: { kind: "twin", twinId: "twin-1", question: "q" },
        title: "t",
      })
    )
    await expect(launched.outcome).resolves.toEqual({
      status: "failed",
      error: "engine_unavailable: twin-answer",
    })
    expect((await getExecutionRun(launched.executionRunId))?.status).toBe("failed")
  })

  it("forwards a stop to the twin's engine", async () => {
    const outcome = deferred<ChildRunOutcome>()
    const stop = jest.fn(() => outcome.resolve({ status: "cancelled" }))
    ports.set("twin-answer", { start: () => ({ outcome: outcome.promise, stop }) })
    const controller = new AbortController()
    const launched = started(
      await launchChildRun({
        target: { kind: "twin", twinId: "twin-1", question: "q" },
        title: "t",
        signal: controller.signal,
      })
    )
    controller.abort(new Error("team delegation cancelled"))
    await launched.outcome
    expect(stop).toHaveBeenCalledWith("team delegation cancelled")
  })
})

describe("launchChildRun: squad", () => {
  it("is refused when no module provides the port", async () => {
    await expect(
      launchChildRun({
        target: { kind: "squad", squadId: "s2", brief: "", origin: "delegation" },
        title: "t",
      })
    ).resolves.toEqual({ started: false, reason: "engine_unavailable", detail: "squad-launch" })
  })

  it("passes the Squad's refusal through", async () => {
    ports.set("squad-launch", {
      start: async (): Promise<SquadLaunchResult> => ({
        started: false,
        reason: "already_running",
      }),
    })
    await expect(
      launchChildRun({
        target: { kind: "squad", squadId: "s2", brief: "", origin: "delegation" },
        title: "t",
      })
    ).resolves.toEqual({ started: false, reason: "engine_refused", detail: "already_running" })
  })

  it("links the Squad run to its parent, writes no job row and forwards a stop", async () => {
    await seedParent()
    const outcome = deferred<ChildRunOutcome>()
    const stop = jest.fn(() => outcome.resolve({ status: "cancelled" }))
    const start = jest.fn(async (_input: SquadLaunchInput): Promise<SquadLaunchResult> => ({
      started: true,
      executionRunId: "execution:team:run_team_child",
      squadRunId: "run_team_child",
      outcome: outcome.promise,
      stop,
    }))
    ports.set("squad-launch", { start })
    const controller = new AbortController()
    const launched = started(
      await launchChildRun({
        parentRunId: PARENT_ID,
        target: { kind: "squad", squadId: "s2", brief: "", origin: "delegation", ultracode: true },
        title: "t",
        signal: controller.signal,
      })
    )
    expect(launched).toMatchObject({
      childId: "run_team_child",
      executionRunId: "execution:team:run_team_child",
    })
    // The parent's conversation is not handed on: the Squad would project
    // its progress into a thread that did not ask for it.
    expect(start).toHaveBeenCalledWith({
      squadId: "s2",
      brief: "",
      origin: "delegation",
      launchedByRunId: PARENT_ID,
      ultracode: true,
    })
    controller.abort()
    await expect(launched.outcome).resolves.toEqual({ status: "cancelled" })
    expect(stop).toHaveBeenCalled()
    expect(await getDb().executionRuns.where("kind").equals("job").count()).toBe(0)
  })
})

describe("dispatch span", () => {
  it("records one finished span per child with its dispatch latency and no prompt or answer", async () => {
    await seedParent()
    executeAgentMock.mockResolvedValue({
      text: "secret answer",
      channel: "sidecar",
      toolsAvailable: true,
    })
    const launched = started(
      await launchChildRun({
        parentRunId: PARENT_ID,
        target: { kind: "agent", prompt: "secret prompt" },
        title: "t",
        surface: "agent-team",
      })
    )
    await launched.outcome
    expect(spans).toHaveLength(1)
    const [span] = spans
    expect(span).toMatchObject({
      operationName: "invoke_agent",
      providerName: "cognia.subagent",
      surface: "agent-team",
      runId: launched.executionRunId,
      sessionId: "session-parent",
      status: "ok",
      handoff: { fromAgent: PARENT_ID, toAgent: launched.executionRunId },
      metadata: expect.objectContaining({
        role: "child-run",
        targetKind: "agent",
        outcome: "completed",
        parentRunId: PARENT_ID,
      }),
    })
    const dispatch = span.events?.find((event) => event.name === "child.dispatch")
    expect(dispatch?.attributes).toEqual({ targetKind: "agent", latencyMs: expect.any(Number) })
    expect(JSON.stringify(span)).not.toMatch(/secret/)
  })

  it("marks a failed child with a code, not its error text", async () => {
    externalExecuteMock.mockResolvedValue({ success: false, error: "secret failure" })
    const launched = started(
      await launchChildRun({
        target: { kind: "external", agentId: "codex", prompt: "p" },
        title: "t",
      })
    )
    await launched.outcome
    expect(spans[0]).toMatchObject({
      providerName: "cognia.external",
      status: "error",
      errorType: "child_failed",
      // Unparented and without a conversation: filed under its own run.
      sessionId: launched.executionRunId,
    })
    expect(JSON.stringify(spans[0])).not.toMatch(/secret/)
  })
})

describe("startAgentEngine", () => {
  it("never starts a run stopped before executeAgent loaded", async () => {
    const engine = startAgentEngine({ prompt: "p" })
    engine.stop("early")
    await expect(engine.outcome).resolves.toMatchObject({ status: "cancelled" })
    expect(executeAgentMock).not.toHaveBeenCalled()
  })
})

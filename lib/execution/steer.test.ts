import type { ExecutionRun } from "@/types/execution/run"

const runs = new Map<string, ExecutionRun>()
const mockSteerSession = jest.fn(async (..._args: unknown[]) => ({ accepted: true as const }))

jest.mock("@/lib/db/execution-runs", () => ({
  getExecutionRun: async (id: string) => runs.get(id),
  listChildExecutionRuns: async (parentRunId: string) =>
    [...runs.values()].filter((run) => run.parentRunId === parentRunId),
  listExecutionRuns: async (query: { sessionId?: string; kinds?: string[] }) =>
    [...runs.values()].filter(
      (run) =>
        (!query.sessionId || run.sessionId === query.sessionId) &&
        (!query.kinds || query.kinds.includes(run.kind))
    ),
}))
jest.mock("@/lib/claude/ipc", () => ({
  steerSession: (...args: unknown[]) => mockSteerSession(...args),
}))

import {
  __resetSteerForTesting,
  liveSessionSquadRun,
  registerRemoteSessionSteerLane,
  registerRunSteerEngine,
  registerSessionSteerLane,
  steerRun,
  type SessionSteerLane,
} from "./steer"

function run(id: string, patch: Partial<ExecutionRun> = {}): ExecutionRun {
  const value: ExecutionRun = {
    id,
    kind: "agent-turn",
    sourceId: id,
    title: "t",
    status: "running",
    currentRevision: 1,
    startedAt: 1,
    updatedAt: 1,
    ...patch,
  }
  runs.set(id, value)
  return value
}

function lane(busy: boolean | undefined): SessionSteerLane & { queued: unknown[] } {
  const queued: unknown[] = []
  return {
    queued,
    busy: () => busy,
    queueDerived: (sessionId, input) => {
      queued.push({ sessionId, ...input })
      return `entry-${queued.length}`
    },
  }
}

const WAKEUP = { source: "wakeup" as const, producer: "issue-wakeup" as const }

beforeEach(() => {
  runs.clear()
  mockSteerSession.mockReset()
  mockSteerSession.mockResolvedValue({ accepted: true })
  __resetSteerForTesting()
})

describe("steerRun: a conversation's turn", () => {
  it("delivers a person's input live into the sidecar, with the command's fields", async () => {
    await expect(
      steerRun({
        target: { sessionId: "s1" },
        origin: "person",
        content: "use staging",
        sourceMessageId: "om-1",
        priority: "next",
        commandId: "cmd-1",
      })
    ).resolves.toEqual({ status: "delivered", receiptIds: [] })
    expect(mockSteerSession).toHaveBeenCalledWith("s1", "use staging", "om-1", {
      priority: "next",
      commandId: "cmd-1",
    })
  })

  it("reports the PII gate's refusal as that, and any other refusal as no live lane", async () => {
    mockSteerSession.mockRejectedValueOnce(new Error("rejected by the renderer PII gate"))
    await expect(
      steerRun({ target: { sessionId: "s1" }, origin: "person", content: "x" })
    ).resolves.toEqual({ status: "degraded", reason: "pii_blocked" })
    mockSteerSession.mockRejectedValueOnce(new Error("no active query"))
    await expect(
      steerRun({ target: { sessionId: "s1" }, origin: "person", content: "x" })
    ).resolves.toEqual({ status: "degraded", reason: "provider_unsupported" })
  })

  it("holds a derived input for a busy conversation's boundary instead of going live", async () => {
    const chat = lane(true)
    registerSessionSteerLane(chat)
    await expect(
      steerRun({
        target: { sessionId: "s1" },
        origin: "derived",
        content: "Wakeup brief",
        derived: { ...WAKEUP, dedupeKey: "k" },
      })
    ).resolves.toEqual({ status: "queued", entryId: "entry-1" })
    expect(chat.queued).toEqual([
      {
        sessionId: "s1",
        text: "Wakeup brief",
        source: "wakeup",
        producer: "issue-wakeup",
        dedupeKey: "k",
      },
    ])
    expect(mockSteerSession).not.toHaveBeenCalled()
  })

  it("has no turn for a derived input to join when the conversation is idle", async () => {
    registerSessionSteerLane(lane(false))
    await expect(
      steerRun({ target: { sessionId: "s1" }, origin: "derived", content: "b", derived: WAKEUP })
    ).resolves.toEqual({ status: "degraded", reason: "no_active_run" })
    expect(mockSteerSession).not.toHaveBeenCalled()
  })

  it("leaves a derived input to the sidecar where no chat runtime knows the conversation", async () => {
    registerSessionSteerLane(lane(undefined))
    await expect(
      steerRun({ target: { sessionId: "s1" }, origin: "derived", content: "b", derived: WAKEUP })
    ).resolves.toEqual({ status: "delivered", receiptIds: [] })
    expect(mockSteerSession).toHaveBeenCalledWith("s1", "b", undefined, {})
  })

  it("never lets a person's input wait in the derived queue", async () => {
    const chat = lane(true)
    registerSessionSteerLane(chat)
    await steerRun({ target: { sessionId: "s1" }, origin: "person", content: "now" })
    expect(chat.queued).toEqual([])
    expect(mockSteerSession).toHaveBeenCalled()
  })

  it("asks a remote lane first, and falls through when it does not carry the conversation", async () => {
    const remote = jest.fn(async (sessionId: string) =>
      sessionId === "shared" ? { status: "delivered" as const, receiptIds: ["evt-1"] } : null
    )
    registerRemoteSessionSteerLane({ steer: remote })
    await expect(
      steerRun({ target: { sessionId: "shared" }, origin: "person", content: "x" })
    ).resolves.toEqual({ status: "delivered", receiptIds: ["evt-1"] })
    expect(mockSteerSession).not.toHaveBeenCalled()
    await steerRun({ target: { sessionId: "local" }, origin: "person", content: "x" })
    expect(mockSteerSession).toHaveBeenCalledWith("local", "x", undefined, {})
  })

  it("sends input to the Squad run the conversation is holding for", async () => {
    run("execution:team:r1", { kind: "team", sessionId: "s1", sourceId: "r1" })
    const team = jest.fn(async () => ({ status: "delivered" as const, receiptIds: ["rcpt"] }))
    registerRunSteerEngine("team", team)
    await expect(
      steerRun({ target: { sessionId: "s1" }, origin: "person", content: "focus on auth" })
    ).resolves.toEqual({ status: "delivered", receiptIds: ["rcpt"] })
    expect(team).toHaveBeenCalledWith(
      expect.objectContaining({ id: "execution:team:r1" }),
      expect.objectContaining({ target: { runId: "execution:team:r1" }, content: "focus on auth" })
    )
    expect(mockSteerSession).not.toHaveBeenCalled()
  })
})

describe("liveSessionSquadRun", () => {
  it("finds the conversation's own live Squad turn, and a retry's replacement", async () => {
    run("execution:team:done", { kind: "team", sessionId: "s1", status: "completed" })
    await expect(liveSessionSquadRun("s1")).resolves.toBeUndefined()
    run("execution:team:retry", {
      kind: "team",
      sessionId: "s1",
      parentRunId: "execution:team:done",
    })
    await expect(liveSessionSquadRun("s1")).resolves.toMatchObject({ id: "execution:team:retry" })
  })

  it("ignores a Squad another run launched as its child", async () => {
    run("execution:team:child", {
      kind: "team",
      sessionId: "s1",
      parentRunId: "execution:delegation:d1",
    })
    await expect(liveSessionSquadRun("s1")).resolves.toBeUndefined()
  })
})

describe("steerRun: a run row", () => {
  it("answers run_not_found for an unknown run", async () => {
    await expect(
      steerRun({ target: { runId: "nope" }, origin: "person", content: "x" })
    ).resolves.toEqual({ status: "run_not_found" })
  })

  it("steers an agent-turn row through its conversation", async () => {
    run("execution:agent:a1", { sessionId: "s9" })
    await steerRun({ target: { runId: "execution:agent:a1" }, origin: "person", content: "x" })
    expect(mockSteerSession).toHaveBeenCalledWith("s9", "x", undefined, {})
  })

  it("degrades an agent-turn row with no conversation", async () => {
    run("execution:agent:a2")
    await expect(
      steerRun({ target: { runId: "execution:agent:a2" }, origin: "person", content: "x" })
    ).resolves.toEqual({ status: "degraded", reason: "no_active_run" })
  })

  it("refuses a kind with no steer", async () => {
    run("execution:job:j1", { kind: "job" })
    await expect(
      steerRun({ target: { runId: "execution:job:j1" }, origin: "person", content: "x" })
    ).resolves.toEqual({ status: "unsupported_for_kind", kind: "job" })
  })

  it("fans a delegation's input out to its live children, steered when any one took it", async () => {
    run("execution:delegation:d1", { kind: "delegation" })
    run("execution:agent:c1", { parentRunId: "execution:delegation:d1", sessionId: "c1" })
    run("execution:agent:c2", { parentRunId: "execution:delegation:d1", sessionId: "c2" })
    run("execution:agent:c3", {
      parentRunId: "execution:delegation:d1",
      sessionId: "c3",
      status: "completed",
    })
    mockSteerSession.mockImplementation(async (sessionId: unknown) => {
      if (sessionId === "c1") throw new Error("closed")
      return { accepted: true }
    })
    await expect(
      steerRun({ target: { runId: "execution:delegation:d1" }, origin: "person", content: "x" })
    ).resolves.toEqual({ status: "delivered", receiptIds: [] })
    expect(mockSteerSession.mock.calls.map((call) => call[0]).sort()).toEqual(["c1", "c2"])
  })

  it("degrades a delegation when no child took it, with the last child's reason", async () => {
    run("execution:delegation:d2", { kind: "delegation" })
    await expect(
      steerRun({ target: { runId: "execution:delegation:d2" }, origin: "person", content: "x" })
    ).resolves.toEqual({ status: "degraded", reason: "no_active_run" })
    run("execution:agent:c4", { parentRunId: "execution:delegation:d2", sessionId: "c4" })
    mockSteerSession.mockRejectedValue(new Error("PII"))
    await expect(
      steerRun({ target: { runId: "execution:delegation:d2" }, origin: "person", content: "x" })
    ).resolves.toEqual({ status: "degraded", reason: "pii_blocked" })
  })

  it("reports an engine that threw as a degradation, never a throw", async () => {
    run("execution:team:t1", { kind: "team" })
    registerRunSteerEngine("team", async () => {
      throw new Error("coordinator down")
    })
    await expect(
      steerRun({ target: { runId: "execution:team:t1" }, origin: "person", content: "x" })
    ).resolves.toEqual({ status: "degraded", reason: "provider_unsupported" })
  })

  it("unregisters only its own engine", async () => {
    run("execution:team:t2", { kind: "team" })
    const first = registerRunSteerEngine("team", async () => ({
      status: "delivered",
      receiptIds: ["a"],
    }))
    registerRunSteerEngine("team", async () => ({ status: "delivered", receiptIds: ["b"] }))
    first()
    await expect(
      steerRun({ target: { runId: "execution:team:t2" }, origin: "person", content: "x" })
    ).resolves.toEqual({ status: "delivered", receiptIds: ["b"] })
  })
})

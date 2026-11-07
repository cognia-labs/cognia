import {
  isJobOutboxKind,
  jobDeliveryState,
  jobExitFromSettledFrame,
  outboxRecordFromJobExit,
  outboxRecordFromMonitor,
  supervisorIdOf,
} from "./job-settlement"

const exit = {
  jobId: "job-1",
  status: "exited",
  exitCode: 2,
  endedAtMs: 9_000,
  startedAtMs: 1_000,
  command: "pnpm test",
  label: "tests",
  outputTail: "1 failed\n",
  delivery: { sessionId: "chat-1", runId: "execution:agent:r1", notify: "on_exit" as const },
}

describe("outboxRecordFromJobExit", () => {
  it("records an agent-started shell's end, settled, for its conversation", () => {
    expect(outboxRecordFromJobExit(exit, "renderer")).toEqual({
      runId: "shell-job:job-1",
      kind: "shell-job",
      subagentId: "",
      prompt: "pnpm test",
      sessionId: "chat-1",
      host: "renderer",
      status: "error",
      startedAt: 1_000,
      settledAt: 9_000,
      resultText: "1 failed\n",
      error: "exited with code 2",
      label: "tests",
      mode: "background",
      deliveryState: "pending",
      job: {
        kind: "shell-job",
        runId: "execution:agent:r1",
        status: "exited",
        exitCode: 2,
        command: "pnpm test",
        outputTail: "1 failed\n",
        notify: "on_exit",
      },
    })
    expect(outboxRecordFromJobExit({ ...exit, exitCode: 0 }, "cli")).toMatchObject({
      status: "done",
      host: "cli",
    })
  })

  it("owes nothing for a job nobody's conversation started, or one still running", () => {
    expect(outboxRecordFromJobExit({ ...exit, delivery: undefined }, "renderer")).toBeNull()
    expect(outboxRecordFromJobExit({ ...exit, status: "running" }, "renderer")).toBeNull()
  })

  it("starts at its end when the supervisor did not say when it started", () => {
    expect(outboxRecordFromJobExit({ ...exit, startedAtMs: 0 }, "renderer")?.startedAt).toBe(9_000)
  })
})

describe("jobDeliveryState", () => {
  const shell = outboxRecordFromJobExit(exit, "renderer")!.job!

  it("skips what the agent asked not to hear, or stopped itself", () => {
    expect(jobDeliveryState({ ...shell, notify: "none" } as typeof shell)).toBe("skipped")
    for (const stoppedBy of ["agent", "owner", "shutdown"] as const) {
      expect(jobDeliveryState({ ...shell, status: "killed", stoppedBy } as typeof shell)).toBe(
        "skipped"
      )
    }
  })

  it("reports a shell a person stopped", () => {
    expect(
      jobDeliveryState({ ...shell, status: "killed", stoppedBy: "person" } as typeof shell)
    ).toBe("pending")
  })
})

describe("outboxRecordFromMonitor", () => {
  const monitor = {
    id: "mon-1",
    status: "expired",
    condition: { kind: "shellPredicate", command: "curl -f localhost:3000", program: "/bin/sh" },
    createdAtMs: 1_000,
    settledAtMs: 61_000,
    detail: "deadline passed",
    delivery: { sessionId: "chat-1", state: "pending" as const },
  }

  it("records a settled watch's verdict", () => {
    expect(outboxRecordFromMonitor(monitor, "renderer")).toMatchObject({
      runId: "monitor:mon-1",
      kind: "monitor",
      status: "error",
      error: "monitor expired",
      prompt: "`curl -f localhost:3000` succeeds",
      deliveryState: "pending",
      job: { kind: "monitor", status: "expired", deliveredInline: false },
    })
  })

  it("skips a verdict the blocking call returned inline, or a cancelled watch", () => {
    expect(
      outboxRecordFromMonitor(
        { ...monitor, status: "fired", delivery: { sessionId: "chat-1", state: "inline" } },
        "renderer"
      )?.deliveryState
    ).toBe("skipped")
    expect(
      outboxRecordFromMonitor({ ...monitor, status: "cancelled" }, "renderer")?.deliveryState
    ).toBe("skipped")
    expect(outboxRecordFromMonitor({ ...monitor, status: "waiting" }, "renderer")).toBeNull()
  })
})

it("maps an entry back to the supervisor's id", () => {
  expect(supervisorIdOf({ runId: "shell-job:job-1", kind: "shell-job" })).toBe("job-1")
  expect(supervisorIdOf({ runId: "monitor:mon-1", kind: "monitor" })).toBe("mon-1")
  expect(isJobOutboxKind("subagent")).toBe(false)
  expect(isJobOutboxKind("monitor")).toBe(true)
})

describe("jobExitFromSettledFrame", () => {
  it("reads an in-process shell's end from its frame and nothing else", () => {
    expect(
      jobExitFromSettledFrame({
        type: "background_job_settled",
        sessionId: "chat-1",
        settlement: exit,
      })
    ).toBe(exit)
    expect(jobExitFromSettledFrame({ type: "event", settlement: exit })).toBeNull()
    expect(
      jobExitFromSettledFrame({ type: "background_job_settled", settlement: { jobId: 1 } })
    ).toBeNull()
    expect(jobExitFromSettledFrame(null)).toBeNull()
  })
})

import type { AgentTeamChildRun } from "@cognia/agent-orchestration"
import { WorkerDetachedError } from "../workers/worker-rpc-pool"
import { deriveSquadChildStop, summarizeSquadStop } from "./squad-stop-status"

const now = 10_000
const child = (overrides: Partial<AgentTeamChildRun> = {}): AgentTeamChildRun => ({
  id: "child-1",
  runId: "run-1",
  teamId: "team-1",
  teammateId: "mate-1",
  taskId: "task-1",
  repositoryId: "primary",
  status: "needs_input",
  attempt: 2,
  dispatchEpoch: 3,
  createdAt: 1,
  updatedAt: 1,
  resourceUsage: {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    wallTimeMs: 0,
    toolTimeMs: 0,
    attempts: 2,
    failures: 0,
  },
  ...overrides,
})
const stop = (state: "requested" | "unconfirmed" | "confirmed") => ({
  state,
  epoch: 3,
  requestedAt: 1,
})
const fence = {
  fenceCapable: true,
  lastRenewalSentAt: 1_000,
  leaseTtlMs: 5_000,
  fenceGraceMs: 1_000,
}

describe("deriveSquadChildStop", () => {
  it("shows no stop when none was requested or proved", () => {
    expect(deriveSquadChildStop(child(), now)).toEqual({ state: "none", controlLost: false })
  })

  it("shows a requested stop as stopping", () => {
    expect(deriveSquadChildStop(child({ stop: stop("requested") }), now).state).toBe("requested")
  })

  it("keeps an unconfirmed stop unconfirmed", () => {
    expect(deriveSquadChildStop(child({ stop: stop("unconfirmed") }), now).state).toBe(
      "unconfirmed"
    )
  })

  it("shows a current-epoch Worker acknowledgement as stopped", () => {
    const proof = { kind: "ack" as const, epoch: 3, at: 5_000 }
    expect(deriveSquadChildStop(child({ stop: { ...stop("confirmed"), proof } }), now)).toEqual({
      state: "stopped",
      proof,
      controlLost: false,
    })
  })

  it("shows a valid persisted fence-expiry proof", () => {
    const proof = { kind: "fence-expiry" as const, epoch: 3, at: 7_000 }
    expect(
      deriveSquadChildStop(child({ ...fence, stop: { ...stop("confirmed"), proof } }), now).proof
    ).toEqual(proof)
  })

  it("derives fence expiry at the deadline without changing the stored child", () => {
    const record = child({ ...fence, stop: stop("unconfirmed") })
    expect(deriveSquadChildStop(record, 6_999).state).toBe("unconfirmed")
    expect(deriveSquadChildStop(record, 7_000).proof?.kind).toBe("fence-expiry")
    expect(record.stop?.state).toBe("unconfirmed")
  })

  it.each(["requested", "unconfirmed"] as const)(
    "shows control lost for a detached remote %s stop",
    (state) => {
      const record = child({
        stop: stop(state),
        status: "failed",
        hostRef: "device:a",
        remoteSessionId: "remote-1",
        // The persisted text is the pool's own detach error: pin the coupling.
        error: new WorkerDetachedError("worker-1", "socket_closed").message,
      })
      expect(deriveSquadChildStop(record, now)).toEqual({ state, controlLost: true })
    }
  )

  it("does not use a stale epoch or an unproved confirmed stop as evidence", () => {
    expect(
      deriveSquadChildStop(
        child({
          stop: { ...stop("confirmed"), epoch: 2, proof: { kind: "ack", epoch: 2, at: 1 } },
        }),
        now
      ).state
    ).toBe("none")
    expect(deriveSquadChildStop(child({ stop: stop("confirmed") }), now).state).toBe("unconfirmed")
  })

  it("does not invent fence proof for a legacy Worker or a completed child without a disposal receipt", () => {
    expect(
      deriveSquadChildStop(child({ ...fence, fenceCapable: false, stop: stop("unconfirmed") }), now)
        .proof
    ).toBeUndefined()
    expect(
      deriveSquadChildStop(child({ ...fence, status: "completed", stop: stop("unconfirmed") }), now)
        .proof
    ).toBeUndefined()
  })
})

describe("summarizeSquadStop", () => {
  it("shows a confirmed run stop even when the run never had children", () => {
    expect(summarizeSquadStop({ stop: stop("confirmed") }, [], now).state).toBe("stopped")
  })

  it("exposes unconfirmed stops even without a run-level stop intent", () => {
    expect(summarizeSquadStop({}, [child({ stop: stop("unconfirmed") })], now).state).toBe(
      "unconfirmed"
    )
  })

  it("keeps a run stopping while any child lacks proof", () => {
    expect(summarizeSquadStop({ stop: stop("requested") }, [child()], now).state).toBe("requested")
  })

  it("summarizes derived and acknowledged proof kinds once all children stopped", () => {
    const children = [
      child({ ...fence, stop: stop("unconfirmed") }),
      child({
        id: "child-2",
        stop: { ...stop("confirmed"), proof: { kind: "ack", epoch: 3, at: 1 } },
      }),
    ]
    expect(summarizeSquadStop({ stop: stop("unconfirmed") }, children, now)).toEqual({
      state: "stopped",
      proofKinds: ["fence-expiry", "ack"],
      controlLost: false,
    })
  })

  it("does not call an active run stopped just because one child stopped", () => {
    expect(summarizeSquadStop({}, [child({ ...fence }), child()], now).state).toBe("none")
  })
})

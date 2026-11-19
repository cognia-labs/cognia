import {
  parseExecutionAssociation,
  resolveExecutionAssociation,
  associationMatches,
} from "./execution-correlation"
import { startSpan, endSpan } from "@cognia/agent-trace/emitter"

describe("explicit performance execution associations", () => {
  it("rejects malformed identities and ignores scope overrides", () => {
    expect(
      parseExecutionAssociation({
        version: 1,
        relationship: "explicit",
        runId: "r",
        accountId: "other",
      })
    ).toEqual({ version: 1, relationship: "explicit", runId: "r" })
    expect(
      parseExecutionAssociation({ version: 1, relationship: "explicit", traceId: "bad\ntrace" })
    ).toBeNull()
    expect(
      parseExecutionAssociation({ version: 2, relationship: "explicit", runId: "r" })
    ).toBeNull()
    expect(parseExecutionAssociation({ version: 1, relationship: "explicit" })).toBeNull()
  })

  it("resolves canonical run identity from the selected database and distinguishes ended runs", async () => {
    const run = { id: "r", sessionId: "s", startedAt: 10, status: "running" }
    const db = {
      executionRuns: { get: jest.fn(async () => run) },
      agentTraces: { where: () => ({ equals: () => ({ toArray: async () => [] }) }) },
    }
    await expect(resolveExecutionAssociation(db as never, { runId: "r" })).resolves.toEqual({
      active: true,
      association: {
        version: 1,
        relationship: "explicit",
        runId: "r",
        sessionId: "s",
        executionStartedAt: 10,
      },
    })
    run.status = "completed"
    await expect(resolveExecutionAssociation(db as never, { runId: "r" })).resolves.toEqual(
      expect.objectContaining({ active: false })
    )
  })

  it("never infers an association from timestamps or joins imported capture ids", () => {
    const association = { version: 1, relationship: "explicit", runId: "r", traceId: "t" } as const
    expect(associationMatches(association, { runId: "other" })).toBe(false)
    expect(associationMatches(association, { runId: "r" })).toBe(true)
    expect(associationMatches(association, { traceId: "t" })).toBe(true)
    expect(associationMatches(null, { runId: "r" })).toBe(false)
  })

  it("uses the canonical run terminal state when its trace root is still pending", async () => {
    const handle = startSpan({
      traceId: "t",
      spanId: "s",
      sessionId: "s",
      operationName: "invoke_agent",
      providerName: "openai",
      surface: "chat",
    })
    let canonicalRun:
      { id: string; status: string; startedAt: number; endedAt: number } | undefined = {
      id: "r",
      status: "completed",
      startedAt: 1,
      endedAt: 2,
    }
    const db = {
      executionRuns: {
        get: jest.fn(async () => canonicalRun),
      },
      agentTraces: {
        where: () => ({
          equals: () => ({
            toArray: async () => [
              { traceId: "t", spanId: "s", runId: "r", status: "pending", startTime: 1 },
            ],
          }),
        }),
      },
    }
    await expect(resolveExecutionAssociation(db as never, { traceId: "t" })).resolves.toEqual(
      expect.objectContaining({
        active: false,
        association: expect.objectContaining({ runId: "r", traceId: "t" }),
      })
    )
    expect(db.executionRuns.get).toHaveBeenCalledWith("r")
    canonicalRun = undefined
    await expect(resolveExecutionAssociation(db as never, { traceId: "t" })).resolves.toEqual(
      expect.objectContaining({ active: true })
    )
    endSpan(handle.spanId)
    await expect(resolveExecutionAssociation(db as never, { traceId: "t" })).resolves.toEqual(
      expect.objectContaining({ active: false })
    )
  })
})

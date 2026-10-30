import { checkActingAuthority, meetRunAuthority, type ExecutionRun } from "./run"

it("exports optional phase-1 identity and authority next to ExecutionRun", () => {
  const legacy: ExecutionRun = {
    id: "run",
    kind: "agent-turn",
    sourceId: "source",
    title: "Run",
    status: "queued",
    currentRevision: 0,
    startedAt: 0,
    updatedAt: 0,
  }
  expect(checkActingAuthority(legacy.actingIdentity, 0)).toEqual({ ok: false, reason: "missing" })
  expect(meetRunAuthority({ schemaVersion: 1 }, { schemaVersion: 1, maxTurns: 2 })).toEqual({
    schemaVersion: 1,
    maxTurns: 2,
  })
  expect(JSON.parse(JSON.stringify(legacy))).not.toHaveProperty("actingIdentity")
})

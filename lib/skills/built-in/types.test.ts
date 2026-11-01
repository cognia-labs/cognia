import type { BuiltInSkillContext } from "./types"

it("represents unknown senders separately from a set of verified contributors", () => {
  const unknown: BuiltInSkillContext = { sessionId: "im", actingSenders: "unknown" }
  const known: BuiltInSkillContext = {
    sessionId: "im",
    executionRunId: "exact-host-run",
    actingSenders: [{ remoteUserId: "open-id", principalId: "principal-id", unionId: "union-id" }],
  }
  expect(unknown.actingSenders).toBe("unknown")
  expect(known.executionRunId).toBe("exact-host-run")
  expect(known.actingSenders).toEqual([
    { remoteUserId: "open-id", principalId: "principal-id", unionId: "union-id" },
  ])
})

it("keeps an explicit Lark routing request separate from the IM binding", () => {
  const context: BuiltInSkillContext = {
    sessionId: "desktop",
    larkAdapterId: "cai_school",
  }
  expect(context.larkAdapterId).toBe("cai_school")
  expect(context.imBinding).toBeUndefined()
})

it("carries an exact Host delivery identity without inventing a local-person admission", () => {
  const context: BuiltInSkillContext = {
    sessionId: "s",
    executionRunId: "delivered-run",
    delivery: true,
  }
  expect(context.executionRunId).toBe("delivered-run")
  expect(context.delivery).toBe(true)
  expect(context.personalLane).toBeUndefined()
})

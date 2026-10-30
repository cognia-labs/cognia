import type { BuiltInSkillContext } from "./types"

it("represents unknown senders separately from a set of verified contributors", () => {
  const unknown: BuiltInSkillContext = { sessionId: "im", actingSenders: "unknown" }
  const known: BuiltInSkillContext = {
    sessionId: "im",
    actingSenders: [{ remoteUserId: "open-id", principalId: "principal-id", unionId: "union-id" }],
  }
  expect(unknown.actingSenders).toBe("unknown")
  expect(known.actingSenders).toEqual([
    { remoteUserId: "open-id", principalId: "principal-id", unionId: "union-id" },
  ])
})

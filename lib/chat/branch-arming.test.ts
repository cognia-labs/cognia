import type { UIMessage } from "ai"

import {
  applyArmedBranchReply,
  armBranchReply,
  armedBranchReply,
  disarmBranchReply,
  resetBranchReplyArmsForTests,
  stampBranchReply,
} from "./branch-arming"

const user = (id: string, metadata?: Record<string, unknown>): UIMessage =>
  ({ id, role: "user", parts: [{ type: "text", text: id }], metadata }) as UIMessage
const assistant = (id: string, metadata?: Record<string, unknown>): UIMessage =>
  ({ id, role: "assistant", parts: [{ type: "text", text: id }], metadata }) as UIMessage

const metaOf = (message: UIMessage | undefined) =>
  (message as { metadata?: Record<string, unknown> } | undefined)?.metadata ?? {}

afterEach(() => resetBranchReplyArmsForTests())

describe("stampBranchReply", () => {
  it("puts a regenerate's tag on the reply the event appended, and says which", () => {
    const current = [user("u1"), assistant("a0", { branchGroupId: "u1", branchIndex: 0 })]
    const applied = [...current, assistant("a1")]
    const { messages, tagged } = stampBranchReply(current, applied, {
      tag: { groupId: "u1", index: 1 },
    })
    expect(metaOf(messages[2])).toEqual({ branchGroupId: "u1", branchIndex: 1 })
    expect(tagged).toEqual({ groupId: "u1", messageId: "a1" })
  })

  it("keeps the tag while the event only edits rows in place or appends no reply", () => {
    const current = [user("u1")]
    expect(stampBranchReply(current, current, { tag: { groupId: "u1", index: 1 } })).toEqual({
      messages: current,
    })
    const withQuestion = [...current, user("u2")]
    expect(
      stampBranchReply(current, withQuestion, { tag: { groupId: "u1", index: 1 } }).tagged
    ).toBeUndefined()
  })

  it("hangs every new row off an edit's replacement, but no row from before the event", () => {
    const current = [user("u1"), user("u1-edit"), user("steer")]
    const applied = [...current, assistant("a1"), assistant("a2", { branchOwnerId: "nearer" })]
    const { messages } = stampBranchReply(current, applied, { owner: "u1-edit" })
    expect(metaOf(messages[2])).toEqual({})
    expect(metaOf(messages[3])).toEqual({ branchOwnerId: "u1-edit" })
    expect(metaOf(messages[4])).toEqual({ branchOwnerId: "nearer" })
  })

  it("returns the rows untouched with nothing armed", () => {
    const current = [user("u1")]
    const applied = [...current, assistant("a1")]
    expect(stampBranchReply(current, applied, {}).messages).toBe(applied)
  })
})

describe("the Host's arms", () => {
  it("spends a regenerate's tag on its turn's first reply, then nothing more", () => {
    armBranchReply("s1", { turnId: "t1", tag: { groupId: "u1", index: 2 } })
    const current = [user("u1")]
    const first = applyArmedBranchReply("s1", "t1", current, [...current, assistant("a1")], false)
    expect(first.tagged).toEqual({ groupId: "u1", messageId: "a1" })
    const second = applyArmedBranchReply(
      "s1",
      "t1",
      first.messages,
      [...first.messages, assistant("a2")],
      false
    )
    expect(second.tagged).toBeUndefined()
    expect(metaOf(second.messages[2])).toEqual({})
    expect(armedBranchReply("s1", "t1")).toBeUndefined()
  })

  it("keeps an edit's owner for the whole turn and drops it when the turn ends", () => {
    armBranchReply("s1", { turnId: "t1", owner: "u2" })
    const current = [user("u2")]
    const mid = applyArmedBranchReply("s1", "t1", current, [...current, assistant("a1")], false)
    expect(metaOf(mid.messages[1])).toEqual({ branchOwnerId: "u2" })
    expect(armedBranchReply("s1", "t1")).toEqual({ turnId: "t1", owner: "u2" })
    applyArmedBranchReply("s1", "t1", mid.messages, mid.messages, true)
    expect(armedBranchReply("s1", "t1")).toBeUndefined()
  })

  it("never stamps a frame of another turn", () => {
    armBranchReply("s1", { turnId: "t1", tag: { groupId: "u1", index: 1 } })
    const current = [user("u1")]
    const applied = [...current, assistant("a1")]
    expect(applyArmedBranchReply("s1", "t2", current, applied, false).messages).toBe(applied)
    expect(armedBranchReply("s1", "t1")).toBeDefined()
    // A frame without a turn id is read as the armed turn's.
    expect(applyArmedBranchReply("s1", undefined, current, applied, false).tagged).toBeDefined()
  })

  it("forgets a session's arm when told, and an empty arm is no arm", () => {
    armBranchReply("s1", { turnId: "t1", owner: "u1" })
    disarmBranchReply("s1")
    expect(armedBranchReply("s1", "t1")).toBeUndefined()
    armBranchReply("s1", { turnId: "t1" })
    expect(armedBranchReply("s1", "t1")).toBeUndefined()
  })
})

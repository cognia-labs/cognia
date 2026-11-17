import type { StoredMessage } from "@cognia/agent-config-types"

import {
  hostStateBranchRejection,
  hostStateBranchReplyArm,
  planEditBranch,
  planRegenerateBranch,
} from "./host-state-branch"

const row = (
  id: string,
  role: StoredMessage["role"],
  metadata?: Record<string, unknown>
): StoredMessage =>
  ({
    id,
    sessionId: "s1",
    role,
    parts: [{ type: "text", text: id }],
    createdAt: 1,
    ...(metadata ? { metadata } : {}),
  }) as StoredMessage

const metaOf = (rows: StoredMessage[], id: string) =>
  rows.find((candidate) => candidate.id === id)?.metadata ?? {}

describe("hostStateBranchRejection", () => {
  const rows = [
    row("u1", "user"),
    row("a1", "assistant"),
    row("u2", "user"),
    row("a2", "assistant"),
  ]

  it("takes a regenerate of the last question only", () => {
    expect(
      hostStateBranchRejection(rows, { messageId: "u2", branch: { kind: "regenerate" } })
    ).toBe(null)
    expect(
      hostStateBranchRejection(rows, { messageId: "u1", branch: { kind: "regenerate" } })?.code
    ).toBe("host_state_regenerate_anchor_moved")
    expect(
      hostStateBranchRejection([], { messageId: "u1", branch: { kind: "regenerate" } })?.code
    ).toBe("host_state_message_not_found")
  })

  it("takes an edit of any question of the session, never of a reply", () => {
    const edit = (editsMessageId: string) =>
      hostStateBranchRejection(rows, {
        messageId: "new",
        branch: { kind: "edit", editsMessageId },
      })
    expect(edit("u1")).toBe(null)
    expect(edit("a1")?.code).toBe("host_state_message_not_found")
    expect(edit("gone")?.code).toBe("host_state_message_not_found")
  })
})

describe("planRegenerateBranch", () => {
  it("makes the replies siblings in one group and drops what is not a reply", () => {
    const rows = [
      row("u1", "user", { turnAdmission: { state: "failed", code: "x" } }),
      row("a1", "assistant"),
      row("sys", "system"),
      row("a2", "assistant", { branchGroupId: "u1", branchIndex: 4 }),
    ]
    const plan = planRegenerateBranch(rows, "u1")!
    expect(plan.groupId).toBe("u1")
    expect(plan.deleteIds).toEqual(["sys"])
    expect(metaOf(plan.upserts, "a1")).toEqual({ branchGroupId: "u1", branchIndex: 0 })
    // A reply already in the group keeps its slot.
    expect(plan.upserts.some((candidate) => candidate.id === "a2")).toBe(false)
    // Re-running the turn is the retry of what its row recorded.
    expect(metaOf(plan.upserts, "u1")).not.toHaveProperty("turnAdmission")
  })

  it("refuses an anchor that is not the last question", () => {
    expect(
      planRegenerateBranch([row("u1", "user"), row("a1", "assistant"), row("u2", "user")], "u1")
    ).toBeNull()
  })
})

describe("planEditBranch", () => {
  it("joins the original to a group and hangs its replies off it", () => {
    const rows = [row("u0", "user"), row("u1", "user"), row("a1", "assistant")]
    const plan = planEditBranch(rows, "u1")!
    expect(plan.groupId).toBe("edit::u1")
    expect(plan.index).toBe(1)
    expect(metaOf(plan.upserts, "u1")).toEqual({ branchGroupId: "edit::u1", branchIndex: 0 })
    expect(metaOf(plan.upserts, "a1")).toEqual({ branchOwnerId: "u1" })
    // Rows before the edit are not touched.
    expect(plan.upserts.map((candidate) => candidate.id)).toEqual(["u1", "a1"])
  })

  it("takes the next slot of a question edited before", () => {
    const rows = [
      row("u1", "user", { branchGroupId: "edit::u1", branchIndex: 0 }),
      row("u1b", "user", { branchGroupId: "edit::u1", branchIndex: 1 }),
    ]
    expect(planEditBranch(rows, "u1b")).toMatchObject({ groupId: "edit::u1", index: 2 })
    expect(planEditBranch(rows, "missing")).toBeNull()
  })
})

describe("hostStateBranchReplyArm", () => {
  it("gives a regenerate's reply the group's next slot", () => {
    const rows = [
      row("u1", "user"),
      row("a1", "assistant", { branchGroupId: "u1", branchIndex: 0 }),
      row("a2", "assistant", { branchGroupId: "u1", branchIndex: 1 }),
    ]
    expect(
      hostStateBranchReplyArm(rows, { messageId: "u1", branch: { kind: "regenerate" } })
    ).toEqual({ tag: { groupId: "u1", index: 2 } })
  })

  it("hangs an edit's replies off the replacement", () => {
    expect(
      hostStateBranchReplyArm([], {
        messageId: "u1b",
        branch: { kind: "edit", editsMessageId: "u1" },
      })
    ).toEqual({ owner: "u1b" })
  })
})

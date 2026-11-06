import type { AssigneeOption } from "@/components/issues/assignee-picker"
import { statusCategoryOf } from "@/types/issues"
import type { IssueProject } from "@/types/issues"
import type { UnifiedIssueItem } from "@/types/issues/unified"
import { FULL_ISSUE_CAPABILITIES, READ_ONLY_ISSUE_CAPABILITIES } from "@/types/issues/unified"
import type { LabelRow } from "@/types/labels"
import {
  assigneeOptionsForItems,
  buildIssueMenuSections,
  canDeleteIssue,
  type IssueMenuSection,
} from "./menu-model"

function item(over: Partial<UnifiedIssueItem> = {}): UnifiedIssueItem {
  const kind = over.kind ?? "local"
  return {
    unifiedId: `${kind}:i1`,
    kind,
    sourceId: "i1",
    identifier: "MERC-1",
    title: "Ship it",
    status: "todo",
    statusCategory: statusCategoryOf("todo"),
    priority: "none",
    labelIds: [],
    order: 0,
    createdAt: 1,
    updatedAt: 1,
    origin: { deepLinkHref: "/issues" },
    capabilities: kind === "local" ? FULL_ISSUE_CAPABILITIES : READ_ONLY_ISSUE_CAPABILITIES,
    ...over,
  }
}

const label = (id: string, name: string): LabelRow => ({
  id,
  scope: "issue",
  name,
  sortOrder: 0,
  createdAt: 0,
  updatedAt: 0,
})

const project = (id: string, name: string): IssueProject => ({
  id,
  projectId: "w1",
  key: "MERC",
  name,
  status: "in_progress",
  priority: "medium",
  resources: [],
  createdAt: 0,
  updatedAt: 0,
})

const scout: AssigneeOption = {
  key: "agent:a1",
  actor: { kind: "agent", id: "a1", label: "Scout" },
  group: "agent",
}

function build(over: Partial<Parameters<typeof buildIssueMenuSections>[0]> = {}) {
  return buildIssueMenuSections({
    item: item(),
    running: false,
    labels: [],
    projects: [],
    assigneeOptions: [],
    ...over,
  })
}

const section = (sections: IssueMenuSection[], id: string) =>
  sections.find((candidate) => candidate.id === id)

describe("buildIssueMenuSections", () => {
  describe("shape", () => {
    it("always offers status, priority and assignee", () => {
      expect(build().map((s) => s.id)).toEqual(["status", "priority", "assignee"])
    })

    it("omits a section with nothing to offer rather than opening onto an empty panel", () => {
      expect(section(build(), "labels")).toBeUndefined()
      expect(section(build(), "project")).toBeUndefined()
    })

    it("adds labels and containers once there are some", () => {
      const sections = build({ labels: [label("l1", "bug")], projects: [project("p1", "Mercury")] })
      expect(sections.map((s) => s.id)).toEqual([
        "status",
        "priority",
        "assignee",
        "labels",
        "project",
      ])
    })

    it("offers all six statuses and all five priorities", () => {
      expect(section(build(), "status")!.entries).toHaveLength(6)
      expect(section(build(), "priority")!.entries).toHaveLength(5)
    })

    it("prepends unassign to the assignee list", () => {
      const entries = section(build({ assigneeOptions: [scout] }), "assignee")!.entries
      expect(entries.map((e) => e.id)).toEqual(["none", "agent:a1"])
    })
  })

  describe("actions", () => {
    it("carries a status action per column", () => {
      const done = section(build(), "status")!.entries.find((e) => e.id === "done")
      expect(done?.action).toEqual({ kind: "status", to: "done" })
    })

    it("carries a priority action", () => {
      const urgent = section(build(), "priority")!.entries.find((e) => e.id === "urgent")
      expect(urgent?.action).toEqual({ kind: "priority", to: "urgent" })
    })

    it("carries the actor itself, not just its key", () => {
      const entries = section(build({ assigneeOptions: [scout] }), "assignee")!.entries
      expect(entries[1].action).toEqual({ kind: "assignee", to: scout.actor })
      expect(entries[0].action).toEqual({ kind: "assignee", to: null })
    })

    it("adds a label the issue does not carry", () => {
      const entries = section(build({ labels: [label("l1", "bug")] }), "labels")!.entries
      expect(entries[0].action).toEqual({ kind: "addLabel", labelId: "l1" })
    })

    it("removes one it already carries — the same row flips meaning", () => {
      const entries = section(
        build({ item: item({ labelIds: ["l1"] }), labels: [label("l1", "bug")] }),
        "labels"
      )!.entries
      expect(entries[0].action).toEqual({ kind: "removeLabel", labelId: "l1" })
    })

    it("carries a container move", () => {
      const entries = section(build({ projects: [project("p1", "Mercury")] }), "project")!.entries
      expect(entries[0].action).toEqual({ kind: "project", issueProjectId: "p1" })
    })
  })

  describe("checked state", () => {
    it("ticks the issue's current status and priority", () => {
      const sections = build({ item: item({ status: "in_review", priority: "high" }) })
      expect(section(sections, "status")!.entries.find((e) => e.checked)?.id).toBe("in_review")
      expect(section(sections, "priority")!.entries.find((e) => e.checked)?.id).toBe("high")
    })

    it("ticks unassigned when there is no assignee", () => {
      const entries = section(build({ assigneeOptions: [scout] }), "assignee")!.entries
      expect(entries.find((e) => e.checked)?.id).toBe("none")
    })

    it("ticks the current assignee instead", () => {
      const entries = section(
        build({ item: item({ assignee: scout.actor }), assigneeOptions: [scout] }),
        "assignee"
      )!.entries
      expect(entries.find((e) => e.checked)?.id).toBe("agent:a1")
    })

    it("ticks an applied label and the current container", () => {
      const sections = build({
        item: item({ labelIds: ["l1"], issueProjectId: "p1" }),
        labels: [label("l1", "bug"), label("l2", "chore")],
        projects: [project("p1", "Mercury"), project("p2", "Venus")],
      })
      expect(
        section(sections, "labels")!
          .entries.filter((e) => e.checked)
          .map((e) => e.id)
      ).toEqual(["l1"])
      expect(
        section(sections, "project")!
          .entries.filter((e) => e.checked)
          .map((e) => e.id)
      ).toEqual(["p1"])
    })
  })

  describe("capability gating", () => {
    it("enables everything for a local row at rest", () => {
      const sections = build({ labels: [label("l1", "bug")], projects: [project("p1", "Mercury")] })
      expect(sections.every((s) => s.entries.every((e) => !e.disabled))).toBe(true)
    })

    it("disables everything for a federated row, and hides nothing", () => {
      const sections = build({
        item: item({ kind: "github" }),
        labels: [label("l1", "bug")],
        projects: [project("p1", "Mercury")],
      })
      expect(sections.map((s) => s.id)).toHaveLength(5)
      expect(sections.every((s) => s.entries.every((e) => e.disabled))).toBe(true)
    })

    it("locks only the run-owned status transitions while a run is in flight", () => {
      const sections = build({ running: true })
      const status = section(sections, "status")!.entries
      expect(status.find((e) => e.id === "in_progress")?.disabled).toBe(true)
      expect(status.find((e) => e.id === "done")?.disabled).toBe(false)
      // A non-status edit is unaffected.
      expect(section(sections, "priority")!.entries.every((e) => e.disabled)).toBe(false)
    })

    it("honours a single missing capability bit", () => {
      const sections = build({
        item: item({ capabilities: { ...FULL_ISSUE_CAPABILITIES, canAssign: false } }),
        assigneeOptions: [scout],
      })
      expect(section(sections, "assignee")!.entries.every((e) => e.disabled)).toBe(true)
      expect(section(sections, "priority")!.entries.every((e) => !e.disabled)).toBe(true)
    })
  })
})

describe("canDeleteIssue", () => {
  it("allows a local row", () => {
    expect(canDeleteIssue(item(), false)).toBe(true)
  })

  it("refuses a federated row", () => {
    expect(canDeleteIssue(item({ kind: "github" }), false)).toBe(false)
  })

  it("still allows deleting a running issue — the run does not own the row's existence", () => {
    expect(canDeleteIssue(item(), true)).toBe(true)
  })
})

describe("buildIssueMenuSections on a shared row (ADR-0149 §10)", () => {
  const ADA = "usr_aaaaaaaaaaaaaaaaaaaaaaaa"
  const me: AssigneeOption = {
    key: "human:self",
    actor: { kind: "human", label: "Me" },
    group: "human",
  }
  const sharedItem = (over: Partial<UnifiedIssueItem> = {}) =>
    item({ kind: "collab", capabilities: FULL_ISSUE_CAPABILITIES, ...over })
  const assignee = (sections: IssueMenuSection[]) => section(sections, "assignee")!.entries

  it("greys out Me with the refusal when nobody is signed in", () => {
    const entries = assignee(
      build({ item: sharedItem(), assigneeOptions: [me, scout], collabSelfUserId: null })
    )
    expect(entries.find((entry) => entry.id === "human:self")).toMatchObject({
      disabled: true,
      collabRefusal: "anonymous-human",
    })
    // An agent and unassign still name someone (or no one) the plane accepts.
    expect(entries.find((entry) => entry.id === "agent:a1")).toMatchObject({ disabled: false })
    expect(entries.find((entry) => entry.id === "agent:a1")).not.toHaveProperty("collabRefusal")
    expect(entries.find((entry) => entry.id === "none")).toMatchObject({ disabled: false })
  })

  it("offers Me once someone is signed in, and ticks it for their own id", () => {
    const entries = assignee(
      build({
        item: sharedItem({ assignee: { kind: "human", id: ADA, label: "Ada" } }),
        assigneeOptions: [me, scout],
        collabSelfUserId: ADA,
      })
    )
    expect(entries.find((entry) => entry.id === "human:self")).toMatchObject({
      disabled: false,
      checked: true,
    })
  })

  it("does not narrow while who is signed in is unknown, nor on a local row", () => {
    expect(
      assignee(build({ item: sharedItem(), assigneeOptions: [me] })).find(
        (entry) => entry.id === "human:self"
      )
    ).toMatchObject({ disabled: false })
    expect(
      assignee(build({ assigneeOptions: [me], collabSelfUserId: null })).find(
        (entry) => entry.id === "human:self"
      )
    ).toMatchObject({ disabled: false })
  })
})

describe("assigneeOptionsForItems", () => {
  const BOB = "usr_bbbbbbbbbbbbbbbbbbbbbbbb"
  const bob: AssigneeOption = {
    key: `human:${BOB}`,
    actor: { kind: "human", id: BOB, label: "Bob" },
    group: "member",
  }
  const shared = (id: string) =>
    item({
      kind: "collab",
      sourceId: id,
      unifiedId: `collab:${id}`,
      capabilities: FULL_ISSUE_CAPABILITIES,
    })

  it("adds the workspace's members when every item is shared", () => {
    expect(assigneeOptionsForItems([shared("a"), shared("b")], [scout], [bob])).toEqual([
      scout,
      bob,
    ])
  })

  it("keeps members away from a local issue and from a mixed selection", () => {
    expect(assigneeOptionsForItems([item()], [scout], [bob])).toEqual([scout])
    expect(assigneeOptionsForItems([shared("a"), item()], [scout], [bob])).toEqual([scout])
    expect(assigneeOptionsForItems([], [scout], [bob])).toEqual([scout])
  })

  it("hands back the base list itself when there is nobody to add", () => {
    const base = [scout]
    expect(assigneeOptionsForItems([shared("a")], base)).toBe(base)
  })

  it("lets a shared row take a member and ticks the current one", () => {
    const entries = section(
      build({
        item: shared("a"),
        assigneeOptions: assigneeOptionsForItems([shared("a")], [scout], [bob]),
        collabSelfUserId: null,
      }),
      "assignee"
    )!.entries
    expect(entries.find((entry) => entry.id === bob.key)).toMatchObject({ disabled: false })
    const assigned = section(
      build({
        item: { ...shared("a"), assignee: bob.actor },
        assigneeOptions: [scout, bob],
        collabSelfUserId: null,
      }),
      "assignee"
    )!.entries
    expect(assigned.find((entry) => entry.id === bob.key)).toMatchObject({ checked: true })
  })
})

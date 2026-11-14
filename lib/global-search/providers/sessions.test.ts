import { prepareOwnerDerivedHistory } from "@/lib/execution/personal-visibility"
jest.mock("@/lib/execution/personal-visibility", () => ({
  prepareOwnerDerivedHistory: jest.fn(async (messages: unknown[]) => ({
    messages,
    withheldMessageIds: [],
    readers: [],
    visibilityDigest: "test",
  })),
}))

import type { ChatSession } from "@cognia/agent-config-types"

import { makeProviderInput, makeTestContext, TEST_NOW } from "../testing"
import { sessionToItem, sessionsProvider, visibleSessions } from "./sessions"

const session = (
  over: Partial<ChatSession> & {
    archivedAt?: number | null
    lastMessagePreview?: string
    lastMessageAt?: number
  }
): ChatSession =>
  ({
    id: "s",
    title: "Untitled",
    createdAt: TEST_NOW - 10,
    updatedAt: TEST_NOW - 5,
    ...over,
  }) as ChatSession

const sessions: ChatSession[] = [
  session({ id: "a", title: "Deploy pipeline", projectId: "p1", updatedAt: TEST_NOW - 1 }),
  session({
    id: "b",
    title: "Prod deploy notes",
    projectId: "p2",
    updatedAt: TEST_NOW - 2,
    archivedAt: TEST_NOW,
  }),
  session({ id: "c", title: "Chit chat", projectId: "p1", kind: "team", updatedAt: TEST_NOW - 3 }),
  session({ id: "d", title: "hidden", kind: "subagent", updatedAt: TEST_NOW }),
  session({
    id: "e",
    title: "",
    updatedAt: TEST_NOW - 4,
    lastMessagePreview: "  last words ",
    lastMessageAt: TEST_NOW,
  }),
  // Platform-bound (IM) conversations belong to the inbox provider.
  session({
    id: "im",
    title: "Deploy bot DM",
    projectId: "p1",
    updatedAt: TEST_NOW,
    platformBinding: {
      platform: "telegram",
      adapterId: "a1",
      conversationKey: "telegram:a1:1",
      conversationRef: { platform: "telegram", adapterId: "a1" },
    },
  }),
]

const ctx = (over = {}) =>
  makeTestContext({
    sessions,
    workspaces: [{ id: "p1", name: "One" } as never, { id: "p2", name: "Two" } as never],
    ...over,
  })

describe("sessions provider", () => {
  it("hides subagent transcripts, archived sessions and IM-bound sessions by default", () => {
    const rows = visibleSessions(ctx(), {})
    expect(rows.map((s) => s.id)).toEqual(["a", "c", "e"])
    expect(visibleSessions(ctx(), { archived: true }).map((s) => s.id)).toEqual([
      "a",
      "b",
      "c",
      "e",
    ])
    // Even a title hit does not surface a platform-bound session here.
    expect(visibleSessions(ctx(), {}).some((s) => s.id === "im")).toBe(false)
  })

  it("restricts to the active workspace with workspace:current, keeping shared rows", () => {
    // `e` names no workspace. The chat list shows it in every workspace, so a
    // scoped search that dropped it made it unfindable from all of them.
    expect(visibleSessions(ctx(), { workspace: "current" }).map((s) => s.id)).toEqual([
      "a",
      "c",
      "e",
    ])
    // No active project → no restriction.
    expect(
      visibleSessions(ctx({ activeProjectId: null }), { workspace: "current" }).map((s) => s.id)
    ).toEqual(["a", "c", "e"])
  })

  it("ranks title hits and includes archived ones only when asked", async () => {
    const out = await sessionsProvider.search(makeProviderInput("deploy", { ctx: ctx() }))
    expect(out.items.map((i) => i.title)).toEqual(["Deploy pipeline"])
    expect(out.items[0]!.titlePositions).toEqual([0, 1, 2, 3, 4, 5])
    expect(out.items[0]!.meta).toBe("One")
    expect(out.items[0]!.action).toEqual({ type: "open-session", sessionId: "a" })
    // Scoped to the active workspace by default, so the archived conversation
    // in another workspace stays out until the search is widened.
    const withArchived = await sessionsProvider.search(
      makeProviderInput("is:archived deploy", { ctx: ctx() })
    )
    expect(withArchived.items.map((i) => i.title)).toEqual(["Deploy pipeline"])

    const everywhere = await sessionsProvider.search(
      makeProviderInput("is:archived workspace:all deploy", { ctx: ctx() })
    )
    expect(everywhere.items.map((i) => i.title)).toEqual(["Deploy pipeline", "Prod deploy notes"])
    expect(everywhere.items[1]!.extra?.archived).toBe(true)
  })

  it("matches session ids as keywords", async () => {
    const out = await sessionsProvider.search(makeProviderInput("c", { ctx: ctx() }))
    expect(out.items.map((i) => i.id)).toContain("session:c")
  })

  it("suggests the freshest conversations, newest first, with descending scores", async () => {
    const items = await sessionsProvider.suggest!({
      ctx: ctx(),
      limit: 2,
      signal: new AbortController().signal,
    })
    // "e" has lastMessageAt = NOW → freshest.
    expect(items.map((i) => i.id)).toEqual(["session:e", "session:a"])
    expect(items[0]!.score).toBeGreaterThan(items[1]!.score)
    expect(items[0]!.title).toBe("globalSearch.untitledConversation")
    expect(items[0]!.subtitle).toBe("last words")
  })

  it("marks the active session, uses the team icon and hides meta with one workspace", () => {
    const item = sessionToItem(
      sessions[2]!,
      ctx({ activeSessionId: "c", workspaces: [{ id: "p1", name: "One" } as never] }),
      0.5
    )
    expect(item.extra?.current).toBe(true)
    expect(item.meta).toBeUndefined()
    expect(item.icon && "lucide" in item.icon).toBe(true)
    expect(item.timestamp).toBe(TEST_NOW - 3)
  })
})

it("labels a side chat by its parent and carries the parent in its open action", async () => {
  const parent = session({ id: "parent", title: "Research", projectId: "p1" })
  const aside = session({
    id: "aside",
    title: "Counterexample",
    kind: "resource-workbench",
    surfaceBinding: { kind: "session", sessionId: "parent" },
  })
  const context = ctx({ sessions: [parent, aside] })
  const out = await sessionsProvider.search(makeProviderInput("counterexample", { ctx: context }))
  expect(out.items).toHaveLength(1)
  expect(out.items[0]).toMatchObject({
    title: "Counterexample",
    subtitle: 'globalSearch.sideChatOf:{"title":"Research"}',
    action: { type: "open-session", sessionId: "aside", parentSessionId: "parent" },
  })
  for (const excluded of [
    { ...parent, archivedAt: TEST_NOW },
    { ...parent, projectId: "other" },
    { ...parent, platformBinding: sessions.find((s) => s.id === "im")!.platformBinding },
  ]) {
    expect(
      visibleSessions(ctx({ sessions: [excluded, aside] }), { workspace: "current" })
    ).not.toContainEqual(aside)
  }
  expect(visibleSessions(ctx({ sessions: [aside] }), {})).toEqual([])
})

it("keeps a parent's personal-history-hidden scope closed to aside title discovery", async () => {
  jest.mocked(prepareOwnerDerivedHistory).mockResolvedValueOnce({
    withheldMessageIds: ["parent"],
    messages: [],
    readers: [],
    visibilityDigest: "private",
  })
  const rows = [
    session({ id: "parent", title: "Parent" }),
    session({
      id: "aside",
      title: "Needle",
      kind: "resource-workbench",
      surfaceBinding: { kind: "session", sessionId: "parent" },
    }),
  ]
  const out = await sessionsProvider.search(
    makeProviderInput("needle", { ctx: ctx({ sessions: rows }) })
  )
  expect(out.items).toEqual([])
})

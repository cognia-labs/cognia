/**
 * @jest-environment jsdom
 */
import "fake-indexeddb/auto"
import { renderHook, waitFor } from "@testing-library/react"
import { __resetDbForTesting, getDb } from "@/lib/db/schema"
import { resetAttentionForTests } from "@/lib/attention/attention-store"
import {
  buildPersonalResponsibilities,
  sortPersonalResponsibilities,
  usePersonalResponsibilities,
} from "./use-personal-responsibilities"

beforeEach(async () => {
  resetAttentionForTests()
  await getDb().delete()
  __resetDbForTesting()
})

describe("buildPersonalResponsibilities & usePersonalResponsibilities (F10)", () => {
  it("prioritizes urgent SLA & HITL asks ahead of high drafts/blocked commitments and normal Radar suggestions", () => {
    const now = 100_000
    const items = buildPersonalResponsibilities({
      drafts: [
        {
          id: "d1",
          conversationKey: "lark:b1:c1",
          sessionId: "s1",
          segments: [{ type: "text", text: "Draft reply" }],
          status: "pending",
          createdAt: 5_000,
          updatedAt: 5_000,
        },
      ],
      attention: [
        {
          id: "run:int_1",
          source: "run",
          kind: "run-approval",
          title: "Approve Bash",
          openedAt: 6_000,
          stale: false,
        },
      ],
      dbSnapshot: {
        now,
        sessionTitles: new Map([["lark:b1:c1", "VIP Support"]]),
        overdueOverrides: [
          {
            id: "co1",
            conversationKey: "lark:b1:c1",
            sessionId: "s1",
            nextResponseDueAt: now - 180_000,
            createdAt: 1_000,
            updatedAt: 1_000,
          },
        ],
        recoveryJobs: [],
        blockedGoals: [
          {
            id: "g1",
            sessionId: "s1",
            objective: "Ship Q4 memo",
            safeObjective: "Ship Q4 memo",
            status: "paused",
            createdAt: 2_000,
            updatedAt: 3_000,
          } as never,
        ],
        failedTasks: [],
        radarSuggestions: [
          {
            reportId: "r1",
            generatedAt: 9_000,
            suggestionId: "r1:action:0",
            actionIndex: 0,
            text: "Consolidate weekly notes",
            verdict: "Fragmented reading",
          },
        ],
      },
    })

    expect(items.map((i) => i.kind)).toEqual([
      "sla_overdue",
      "hitl_approval",
      "outbound_draft",
      "blocked_commitment",
      "radar_suggestion",
    ])
    expect(sortPersonalResponsibilities(items)[0]?.id).toBe("sla:lark:b1:c1")
  })

  it("reactively aggregates live Dexie records across drafts, overdue SLAs, stalled jobs, goals, and Radar", async () => {
    const db = getDb()
    const now = Date.now()
    await db.connectorDrafts.put({
      id: "d_live",
      conversationKey: "telegram:t1:chat1",
      sessionId: "s_live",
      segments: [{ type: "text", text: "Hello" }],
      status: "pending",
      createdAt: now - 1000,
      updatedAt: now - 1000,
    })
    await db.conversationOverrides.put({
      id: "co_live",
      conversationKey: "telegram:t1:chat1",
      sessionId: "s_live",
      nextResponseDueAt: now - 120_000,
      createdAt: now - 5000,
      updatedAt: now - 5000,
    })
    await db.radarReports.put({
      id: "rad_1",
      scope: "self",
      generatedAt: now - 500,
      windowDays: 14,
      itemCount: 5,
      heatmap: [],
      verdict: "Good",
      atAGlance: [],
      infoDiet: "",
      subconscious: "",
      graveyard: [],
      blindSpots: "",
      actions: ["Review roadmap"],
      suggestions: [{ id: "rad_1:action:0", actionIndex: 0, status: "pending" }],
      topicCloud: [],
    })

    const { result } = renderHook(() => usePersonalResponsibilities())
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.items.map((item) => item.kind)).toEqual([
      "sla_overdue",
      "outbound_draft",
      "radar_suggestion",
    ])
    expect(result.current.countsByKind.outbound_draft).toBe(1)
    expect(result.current.countsByKind.sla_overdue).toBe(1)
    expect(result.current.countsByKind.radar_suggestion).toBe(1)
  })
})

/** @jest-environment node */
import type { ChatSession } from "@cognia/agent-config-types"
import type { UIMessage } from "ai"
import {
  __setRoomHandoffTranscriptDepsForTesting,
  patchRoomHandoffMessage,
  readRoomHandoffTranscript,
  roomHandoffTranscriptKind,
  type RoomHandoffTranscriptDeps,
} from "./transcript"
import { withHandoffDecision } from "./proposal"

const team = { id: "team-room", kind: "team", teamId: "t-1" } as ChatSession
const im = {
  id: "im-room",
  platformBinding: { platform: "lark", adapterId: "a1", conversationKey: "k", scopeKind: "group" },
} as unknown as ChatSession
const dm = {
  id: "im-dm",
  platformBinding: {
    platform: "lark",
    adapterId: "a1",
    conversationKey: "k2",
    scopeKind: "private",
  },
} as unknown as ChatSession

const decision = (decidedAt: number) => ({
  status: "declined" as const,
  decidedAt,
  decidedBy: { kind: "local" as const },
})

function world() {
  const rows = new Map<string, UIMessage>([
    [
      "m1",
      {
        id: "m1",
        role: "assistant",
        parts: [{ type: "text", text: "On it." }],
        metadata: { senderId: "ava" },
      } as unknown as UIMessage,
    ],
  ])
  const sessions = new Map([team, im, dm].map((session) => [session.id, session]))
  const deps: RoomHandoffTranscriptDeps = {
    getSession: jest.fn(async (id: string) => sessions.get(id)),
    runnerRead: jest.fn(async () => [{ id: "runner" } as UIMessage]),
    runnerPatch: jest.fn(async () => true),
    storeRead: jest.fn(async () => [...rows.values()]),
    storePatchMetadata: jest.fn(async (_roomId, messageId, patch) => {
      // Slow enough that two unqueued patches would read the same row.
      await new Promise((resolve) => setTimeout(resolve, 5))
      const row = rows.get(messageId)!
      rows.set(messageId, {
        ...row,
        metadata: { ...(row.metadata as object), ...patch },
      } as UIMessage)
    }),
  }
  __setRoomHandoffTranscriptDepsForTesting(deps)
  return { deps, rows }
}

afterEach(() => __setRoomHandoffTranscriptDepsForTesting(null))

describe("room hand-off transcripts", () => {
  it("names the runner for a team room, the store for an IM group, and none otherwise", async () => {
    await expect(roomHandoffTranscriptKind(team)).resolves.toBe("runner")
    await expect(roomHandoffTranscriptKind(im)).resolves.toBe("im")
    await expect(roomHandoffTranscriptKind(dm)).resolves.toBeNull()
    await expect(roomHandoffTranscriptKind({ id: "c", kind: "chat" } as never)).resolves.toBeNull()
    await expect(roomHandoffTranscriptKind(undefined)).resolves.toBeNull()
  })

  it("reads a team room through its runner and an IM group from the store", async () => {
    const w = world()
    await expect(readRoomHandoffTranscript("team-room")).resolves.toEqual([{ id: "runner" }])
    await expect(readRoomHandoffTranscript("im-room")).resolves.toHaveLength(1)
    await expect(readRoomHandoffTranscript("im-dm")).resolves.toEqual([])
    expect(w.deps.storeRead).toHaveBeenCalledTimes(1)
  })

  it("patches a team room through its runner", async () => {
    const w = world()
    const apply = withHandoffDecision("tu-1", decision(1))
    await expect(patchRoomHandoffMessage("team-room", "m1", apply)).resolves.toBe(true)
    expect(w.deps.runnerPatch).toHaveBeenCalledWith("team-room", "m1", apply)
    expect(w.deps.storePatchMetadata).not.toHaveBeenCalled()
  })

  it("writes only the decisions on an IM reply, one patch after another", async () => {
    const w = world()
    const results = await Promise.all([
      patchRoomHandoffMessage("im-room", "m1", withHandoffDecision("tu-1", decision(1))),
      patchRoomHandoffMessage("im-room", "m1", withHandoffDecision("tu-2", decision(2))),
    ])
    expect(results).toEqual([true, true])
    expect(w.rows.get("m1")?.metadata).toEqual({
      senderId: "ava",
      squadHandoffs: { "tu-1": decision(1), "tu-2": decision(2) },
    })
    expect((w.deps.storePatchMetadata as jest.Mock).mock.calls[0][2]).toEqual({
      squadHandoffs: { "tu-1": decision(1) },
    })
  })

  it("writes nothing for a decision already held, a missing reply or a room without hand-offs", async () => {
    const w = world()
    await patchRoomHandoffMessage("im-room", "m1", withHandoffDecision("tu-1", decision(1)))
    await expect(
      patchRoomHandoffMessage("im-room", "m1", withHandoffDecision("tu-1", decision(9)))
    ).resolves.toBe(true)
    expect(w.deps.storePatchMetadata).toHaveBeenCalledTimes(1)
    await expect(
      patchRoomHandoffMessage("im-room", "gone", withHandoffDecision("tu-1", decision(1)))
    ).resolves.toBe(false)
    await expect(
      patchRoomHandoffMessage("im-dm", "m1", withHandoffDecision("tu-1", decision(1)))
    ).resolves.toBe(false)
  })
})

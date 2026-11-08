/** @jest-environment jsdom */

import type { ChatSession, SharedSession } from "@cognia/agent-config-types"
import { CollabConflictError, CollabError } from "./client"
import {
  applySharedRoomInstructions,
  canManageSharedRoomSettings,
  isRoomAsleepRefusal,
  sharedRoomRunInstructions,
  sharedRoomSettingsFromRemote,
  shouldRequestSharedReply,
  updateSharedRoomSettings,
  withSharedRoomInstructions,
} from "./shared-room-settings"

const binding = { orgId: "org", workspaceId: "ws", sessionId: "remote", policyRevision: 1 }
const shared = (roomSettings?: ChatSession["roomSettings"]) =>
  ({
    id: "local",
    collaboration: { ...binding, syncCursor: 0 },
    roomSettings,
  }) as Pick<ChatSession, "id" | "collaboration" | "roomSettings">

describe("sharedRoomSettingsFromRemote", () => {
  it("lays the server's reply mode and instructions over this machine's own switch", () => {
    expect(
      sharedRoomSettingsFromRemote(
        { replyMode: "auto", roomInstructions: "Be brief." },
        { memory: false, replyMode: "asleep", instructions: "old" }
      )
    ).toEqual({ memory: false, replyMode: "auto", instructions: "Be brief." })
  })

  it("reads a server older than the setting as one that answers only when asked", () => {
    expect(sharedRoomSettingsFromRemote({}, { memory: true, instructions: "stale" })).toEqual({
      memory: true,
      replyMode: "mention_only",
    })
    expect(sharedRoomSettingsFromRemote({ replyMode: "loud" as never }, undefined).replyMode).toBe(
      "mention_only"
    )
  })
})

describe("who may change a room's settings", () => {
  it("is an owner or a maintainer", () => {
    expect(canManageSharedRoomSettings("owner")).toBe(true)
    expect(canManageSharedRoomSettings("maintainer")).toBe(true)
    expect(canManageSharedRoomSettings("member")).toBe(false)
    expect(canManageSharedRoomSettings("viewer")).toBe(false)
    expect(canManageSharedRoomSettings(null)).toBe(false)
  })
})

describe("shouldRequestSharedReply", () => {
  it("asks for a reply to every human turn of an auto room that steered nothing", () => {
    expect(shouldRequestSharedReply(shared({ replyMode: "auto" }), "none")).toBe(true)
    expect(shouldRequestSharedReply(shared({ replyMode: "auto" }), "steered")).toBe(false)
    expect(shouldRequestSharedReply(shared({ replyMode: "auto" }), "queued")).toBe(false)
    expect(shouldRequestSharedReply(shared({ replyMode: "mention_only" }), "none")).toBe(false)
    expect(shouldRequestSharedReply(shared({ replyMode: "asleep" }), "none")).toBe(false)
    expect(shouldRequestSharedReply(shared(), "none")).toBe(false)
    expect(
      shouldRequestSharedReply({ roomSettings: { replyMode: "auto" } } as ChatSession, "none")
    ).toBe(false)
  })
})

describe("the room's instructions on a shared run", () => {
  it("append the section after what the prompt already says", () => {
    const room = shared({ instructions: "Answer in English." })
    expect(sharedRoomRunInstructions(room)).toBe("## Room instructions\n\nAnswer in English.")
    expect(withSharedRoomInstructions(undefined, room)).toBe(
      "## Room instructions\n\nAnswer in English."
    )
    expect(withSharedRoomInstructions("Base.", room)).toBe(
      "Base.\n\n## Room instructions\n\nAnswer in English."
    )
    expect(withSharedRoomInstructions("Base.", shared())).toBe("Base.")
    expect(
      withSharedRoomInstructions("Base.", { roomSettings: { instructions: "x" } } as ChatSession)
    ).toBe("Base.")
  })
})

describe("applySharedRoomInstructions", () => {
  it("adds the section where the run's prompt lives, and nothing for a room without any", () => {
    const room = shared({ instructions: "Be brief." })
    const section = "## Room instructions\n\nBe brief."
    expect(applySharedRoomInstructions({ appendSystemPrompt: "A" }, room)).toEqual({
      appendSystemPrompt: `A\n\n${section}`,
    })
    expect(applySharedRoomInstructions({ systemPrompt: "S", model: "m" }, room)).toEqual({
      systemPrompt: `S\n\n${section}`,
      model: "m",
    })
    expect(applySharedRoomInstructions({}, room)).toEqual({ appendSystemPrompt: section })
    const untouched = { appendSystemPrompt: "A" }
    expect(applySharedRoomInstructions(untouched, shared())).toBe(untouched)
  })
})

describe("isRoomAsleepRefusal", () => {
  it("names the server's asleep refusal and nothing else", () => {
    expect(
      isRoomAsleepRefusal(new CollabConflictError("conflict", { reason: "room_asleep" }))
    ).toBe(true)
    expect(isRoomAsleepRefusal(new CollabConflictError("conflict", { revision: 3 }))).toBe(false)
    expect(isRoomAsleepRefusal(new CollabError(409, "conflict"))).toBe(false)
    expect(isRoomAsleepRefusal(new Error("room_asleep"))).toBe(false)
  })
})

describe("updateSharedRoomSettings", () => {
  const remote = (revision: number, extra: Partial<SharedSession> = {}) =>
    ({ id: "remote", orgId: "org", revision, ...extra }) as SharedSession

  function context(client: Record<string, jest.Mock>) {
    return async () =>
      ({
        orgId: "org",
        userId: "usr",
        localAccountId: "acct",
        client: { baseUrl: "https://collab.test", ...client },
      }) as never
  }

  beforeEach(() => localStorage.clear())

  it("writes against the current revision and mirrors the answer at once", async () => {
    const getSharedSession = jest.fn(async () => remote(4))
    const updateSharedRoomSettingsCall = jest.fn(async () =>
      remote(5, { replyMode: "auto", roomInstructions: "Be brief." })
    )
    const writeLocal = jest.fn(async () => undefined)
    await updateSharedRoomSettings(
      shared({ memory: false }),
      { replyMode: "auto", instructions: "  Be brief.  " },
      {
        resolveContext: context({
          getSharedSession,
          updateSharedRoomSettings: updateSharedRoomSettingsCall,
        }),
        writeLocal,
        operationId: () => "op",
      }
    )
    expect(updateSharedRoomSettingsCall).toHaveBeenCalledWith("org", "remote", {
      replyMode: "auto",
      roomInstructions: "Be brief.",
      operationId: "op",
      baseRevision: 4,
    })
    expect(writeLocal).toHaveBeenCalledWith("local", {
      memory: false,
      replyMode: "auto",
      instructions: "Be brief.",
    })
  })

  it("retries once against the row a conflict returned", async () => {
    const updateSharedRoomSettingsCall = jest
      .fn()
      .mockRejectedValueOnce(new CollabConflictError("conflict", remote(7)))
      .mockResolvedValueOnce(remote(8, { replyMode: "asleep" }))
    await updateSharedRoomSettings(
      shared(),
      { replyMode: "asleep" },
      {
        resolveContext: context({
          getSharedSession: jest.fn(async () => remote(6)),
          updateSharedRoomSettings: updateSharedRoomSettingsCall,
        }),
        writeLocal: jest.fn(async () => undefined),
        operationId: () => "op",
      }
    )
    expect(updateSharedRoomSettingsCall.mock.calls[1][2]).toEqual({
      replyMode: "asleep",
      operationId: "op:retry",
      baseRevision: 7,
    })
  })

  it("passes a refusal through without writing anything locally", async () => {
    const writeLocal = jest.fn(async () => undefined)
    await expect(
      updateSharedRoomSettings(
        shared(),
        { replyMode: "auto" },
        {
          resolveContext: context({
            getSharedSession: jest.fn(async () => remote(1)),
            updateSharedRoomSettings: jest.fn(async () => {
              throw new CollabError(403, "forbidden")
            }),
          }),
          writeLocal,
        }
      )
    ).rejects.toThrow("forbidden")
    expect(writeLocal).not.toHaveBeenCalled()
  })

  it("refuses a session this connection does not serve", async () => {
    await expect(
      updateSharedRoomSettings(
        shared(),
        { replyMode: "auto" },
        { resolveContext: async () => null }
      )
    ).rejects.toThrow("Shared session connection is unavailable")
  })
})

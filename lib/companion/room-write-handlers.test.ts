const getHostRoomRunnerMock = jest.fn()
jest.mock("@/lib/chat/room/runner-host", () => ({
  getHostRoomRunner: () => getHostRoomRunnerMock(),
}))
jest.mock("@/lib/accounts/active-account-id", () => ({
  getActiveAccountId: () => "acct-local",
}))
const readHostPersonMock = jest.fn()
jest.mock("@/lib/identity/host-person", () => ({
  readHostPerson: (...args: unknown[]) => readHostPersonMock(...args),
}))
const getPairedDeviceMock = jest.fn()
jest.mock("@/lib/db/paired-devices", () => ({
  getPairedDevice: (...args: unknown[]) => getPairedDeviceMock(...args),
}))

import {
  resolveRoomAuthor,
  roomSend,
  roomSquadHandoffDecide,
  roomStop,
} from "./room-write-handlers"
import { roomSendRefusalOf } from "./room-send-client"
import type { RoomRunner, RoomSendOptions } from "@/lib/chat/room/runner"

function fakeRunner() {
  let release: () => void = () => {}
  const pending = new Promise<void>((resolve) => {
    release = resolve
  })
  const runner = {
    send: jest.fn((_content: unknown, opts: RoomSendOptions) => {
      opts.onAccepted?.()
      return pending
    }),
    regenerate: jest.fn((_session: string, onAccepted?: () => void) => {
      onAccepted?.()
      return pending
    }),
    editAndResend: jest.fn(
      (_session: string, _message: string, _content: unknown, opts: RoomSendOptions) => {
        opts.onAccepted?.()
        return pending
      }
    ),
    stop: jest.fn(async () => undefined),
    stopMember: jest.fn(async () => undefined),
  }
  return { runner: runner as unknown as RoomRunner, calls: runner, release }
}

const deps = (runner: RoomRunner) => ({
  runner: () => runner,
  hostUserId: async () => "usr_host",
  deviceLabel: async (id: string) => (id === "dev-1" ? "Pixel 9" : undefined),
})

beforeEach(() => {
  getHostRoomRunnerMock.mockReset()
  readHostPersonMock.mockReset()
  getPairedDeviceMock.mockReset()
})

describe("resolveRoomAuthor", () => {
  it("names the host's bound person and records the device as provenance", async () => {
    await expect(resolveRoomAuthor("dev-1", deps(fakeRunner().runner))).resolves.toEqual({
      kind: "human",
      id: "usr_host",
      displayName: "Pixel 9",
      source: "device:dev-1",
    })
  })

  it("falls back to the local account when the host is bound to nobody", async () => {
    const author = await resolveRoomAuthor("dev-9", {
      hostUserId: async () => null,
      deviceLabel: async () => undefined,
    })
    expect(author).toEqual({ kind: "human", id: "acct-local", source: "device:dev-9" })
  })

  it("reads the person and the device label through the production lookups by default", async () => {
    readHostPersonMock.mockResolvedValue({ userId: "usr_a", canonicalUserId: "usr_canon" })
    getPairedDeviceMock.mockResolvedValue({ label: "Desk phone" })
    await expect(resolveRoomAuthor("dev-2")).resolves.toEqual({
      kind: "human",
      id: "usr_canon",
      displayName: "Desk phone",
      source: "device:dev-2",
    })
    expect(readHostPersonMock).toHaveBeenCalledWith("acct-local")
    expect(getPairedDeviceMock).toHaveBeenCalledWith("dev-2")
  })

  it("survives a failing person or device lookup", async () => {
    readHostPersonMock.mockRejectedValue(new Error("no identity table"))
    getPairedDeviceMock.mockRejectedValue(new Error("no devices table"))
    await expect(resolveRoomAuthor("dev-3")).resolves.toEqual({
      kind: "human",
      id: "acct-local",
      source: "device:dev-3",
    })
  })
})

describe("roomSend", () => {
  it("refuses a payload without a session or without the injected caller", async () => {
    const { runner } = fakeRunner()
    await expect(roomSend({ content: "x", callerDeviceId: "d" }, deps(runner))).rejects.toThrow(
      "room_send.sessionId is required"
    )
    await expect(roomSend({ sessionId: "room-1", content: "x" }, deps(runner))).rejects.toThrow(
      "room_send.callerDeviceId is required"
    )
  })

  it("accepts the turn before it finishes and stamps the caller as author", async () => {
    const { runner, calls, release } = fakeRunner()
    const result = await roomSend(
      {
        sessionId: "room-1",
        callerDeviceId: "dev-1",
        content: "hello team",
        attachmentManifest: [{ id: "att-1" }],
        webSearchContext: { query: "q" },
      },
      deps(runner)
    )
    expect(result).toEqual({ accepted: true })
    expect(calls.send).toHaveBeenCalledWith("hello team", {
      sessionId: "room-1",
      onAccepted: expect.any(Function),
      onRefused: expect.any(Function),
      attachmentManifest: [{ id: "att-1" }],
      webSearchContext: { query: "q" },
      author: { kind: "human", id: "usr_host", displayName: "Pixel 9", source: "device:dev-1" },
    })
    release()
  })

  it("parses template provenance without accepting sender metadata from the client", async () => {
    const { runner, calls, release } = fakeRunner()
    const templateRun = {
      templateId: "review",
      version: "1",
      text: "Review {{target}}",
      params: { target: { kind: "text" as const, value: "workflow" } },
    }
    await roomSend(
      {
        sessionId: "room-1",
        callerDeviceId: "dev-1",
        content: "review",
        templateRun: { ...templateRun, author: { id: "forged" } },
      },
      deps(runner)
    )
    expect(calls.send).toHaveBeenCalledWith(
      "review",
      expect.objectContaining({
        templateRun,
        author: expect.objectContaining({ id: "usr_host" }),
      })
    )
    await expect(
      roomSend(
        {
          sessionId: "room-1",
          callerDeviceId: "dev-1",
          content: "review",
          templateRun: { templateId: "invalid" },
        },
        deps(runner)
      )
    ).rejects.toThrow(/templateRun/)
    release()
  })

  it("forwards a reply reference and refuses a malformed one", async () => {
    const { runner, calls, release } = fakeRunner()
    const replyTo = { messageId: "m-1", preview: "the plan" }
    await roomSend(
      { sessionId: "room-1", callerDeviceId: "dev-1", content: "answer", replyTo },
      deps(runner)
    )
    expect(calls.send).toHaveBeenCalledWith("answer", expect.objectContaining({ replyTo }))
    await expect(
      roomSend(
        { sessionId: "room-1", callerDeviceId: "dev-1", content: "x", replyTo: { preview: "p" } },
        deps(runner)
      )
    ).rejects.toThrow(/replyTo/)
    release()
  })

  it("accepts content blocks and rejects anything else", async () => {
    const { runner, calls, release } = fakeRunner()
    const blocks = [{ type: "text", text: "see this" }]
    await roomSend({ sessionId: "room-1", callerDeviceId: "dev-1", content: blocks }, deps(runner))
    expect(calls.send).toHaveBeenCalledWith(
      blocks,
      expect.objectContaining({ sessionId: "room-1" })
    )
    await expect(
      roomSend({ sessionId: "room-1", callerDeviceId: "dev-1", content: 42 }, deps(runner))
    ).rejects.toThrow("room_send.content must be a string or blocks")
    release()
  })

  /**
   * A shared room is the collaboration server's (ADR-0252): the runner turns
   * the turn away at its door, and the companion must learn that reason, not
   * a bare "not accepted". The bridge keeps a failure's message only, so the
   * refusal rides the message.
   */
  it("fails a turn the runner refuses with the refusal the companion reads back", async () => {
    const refusing = {
      send: jest.fn(async (_content: unknown, opts: RoomSendOptions) => {
        opts.onRefused?.("roomRunsOnServer")
      }),
      regenerate: jest.fn(
        async (
          _session: string,
          _onAccepted?: () => void,
          _onNotResent?: (names: readonly string[]) => void,
          onRefused?: (reason: "roomRunsOnServer" | "teamSessionMissing") => void
        ) => {
          onRefused?.("roomRunsOnServer")
        }
      ),
      editAndResend: jest.fn(
        async (_session: string, _message: string, _content: unknown, opts: RoomSendOptions) => {
          opts.onRefused?.("teamSessionMissing")
        }
      ),
    } as unknown as RoomRunner
    const sent = roomSend(
      { sessionId: "room-1", callerDeviceId: "dev-1", content: "hi" },
      deps(refusing)
    )
    await expect(sent).rejects.toThrow("room_send refused: roomRunsOnServer")
    expect(roomSendRefusalOf(await sent.catch((error: unknown) => error))).toBe("roomRunsOnServer")
    await expect(
      roomSend({ sessionId: "room-1", callerDeviceId: "dev-1", regenerate: true }, deps(refusing))
    ).rejects.toThrow("room_send refused: roomRunsOnServer")
    await expect(
      roomSend(
        { sessionId: "room-1", callerDeviceId: "dev-1", content: "x", editMessageId: "u-1" },
        deps(refusing)
      )
    ).rejects.toThrow("room_send refused: teamSessionMissing")
  })

  it("routes regenerate and edit to their own runner actions", async () => {
    const { runner, calls, release } = fakeRunner()
    await expect(
      roomSend({ sessionId: "room-1", callerDeviceId: "dev-1", regenerate: true }, deps(runner))
    ).resolves.toEqual({ accepted: true })
    expect(calls.regenerate).toHaveBeenCalledWith(
      "room-1",
      expect.any(Function),
      expect.any(Function),
      expect.any(Function)
    )
    expect(calls.send).not.toHaveBeenCalled()

    await roomSend(
      { sessionId: "room-1", callerDeviceId: "dev-1", content: "fixed", editMessageId: "u-1" },
      deps(runner)
    )
    expect(calls.editAndResend).toHaveBeenCalledWith(
      "room-1",
      "u-1",
      "fixed",
      expect.objectContaining({
        onAccepted: expect.any(Function),
        author: expect.objectContaining({ source: "device:dev-1" }),
      })
    )
    await expect(
      roomSend(
        { sessionId: "room-1", callerDeviceId: "dev-1", content: "x", editMessageId: 7 },
        deps(runner)
      )
    ).rejects.toThrow("room_send.editMessageId must be a string when present")
    release()
  })

  it("tells the companion which files a regenerate or an edit could not resend", async () => {
    // The runner names them before it accepts the turn; they ride the acceptance.
    const { runner, calls, release } = fakeRunner()
    calls.regenerate.mockImplementationOnce(
      (
        _session: string,
        onAccepted?: () => void,
        onNotResent?: (filenames: readonly string[]) => void
      ) => {
        onNotResent?.(["clip.mp4"])
        onAccepted?.()
        return new Promise<void>(() => {})
      }
    )
    await expect(
      roomSend({ sessionId: "room-1", callerDeviceId: "dev-1", regenerate: true }, deps(runner))
    ).resolves.toEqual({ accepted: true, notResent: ["clip.mp4"] })

    calls.editAndResend.mockImplementationOnce(
      (
        _session: string,
        _message: string,
        _content: unknown,
        opts: RoomSendOptions & { onNotResent?: (filenames: readonly string[]) => void }
      ) => {
        opts.onNotResent?.(["photo.png"])
        opts.onAccepted?.()
        return new Promise<void>(() => {})
      }
    )
    await expect(
      roomSend(
        { sessionId: "room-1", callerDeviceId: "dev-1", content: "again", editMessageId: "u-1" },
        deps(runner)
      )
    ).resolves.toEqual({ accepted: true, notResent: ["photo.png"] })
    release()
  })

  it("uses the process-wide host runner when no runner is injected", async () => {
    const { runner, calls, release } = fakeRunner()
    getHostRoomRunnerMock.mockReturnValue(runner)
    readHostPersonMock.mockResolvedValue(null)
    getPairedDeviceMock.mockResolvedValue(undefined)
    await roomSend({ sessionId: "room-1", callerDeviceId: "dev-1", content: "hi" })
    expect(getHostRoomRunnerMock).toHaveBeenCalled()
    expect(calls.send).toHaveBeenCalledWith(
      "hi",
      expect.objectContaining({
        author: { kind: "human", id: "acct-local", source: "device:dev-1" },
      })
    )
    release()
  })

  it("waits for actual admission and reports early refusals", async () => {
    let admit!: () => void
    let finish!: () => void
    const completion = new Promise<void>((resolve) => {
      finish = resolve
    })
    const runner = {
      send: jest.fn((_content, opts) => {
        admit = opts.onAccepted
        return completion
      }),
    } as unknown as RoomRunner
    let settled = false
    const result = roomSend(
      { sessionId: "room-1", callerDeviceId: "dev-1", content: "hi" },
      deps(runner)
    ).then((value) => {
      settled = true
      return value
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(settled).toBe(false)
    admit()
    await expect(result).resolves.toEqual({ accepted: true })
    finish()
    runner.send = jest.fn(async () => undefined)
    await expect(
      roomSend({ sessionId: "room-1", callerDeviceId: "dev-1", content: "hi" }, deps(runner))
    ).resolves.toEqual({ accepted: false })
    runner.send = jest.fn(async () => {
      throw new Error("ROOM_BUSY")
    })
    await expect(
      roomSend({ sessionId: "room-1", callerDeviceId: "dev-1", content: "hi" }, deps(runner))
    ).rejects.toThrow("ROOM_BUSY")
  })

  it("does not fail the RPC when the detached turn later rejects", async () => {
    const consoleError = jest.spyOn(console, "error").mockImplementation(() => {})
    const runner = {
      send: jest.fn(async (_content: unknown, opts: RoomSendOptions) => {
        opts.onAccepted?.()
        throw new Error("member exploded")
      }),
    } as unknown as RoomRunner
    await expect(
      roomSend({ sessionId: "room-1", callerDeviceId: "dev-1", content: "hi" }, deps(runner))
    ).resolves.toEqual({ accepted: true })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(consoleError).toHaveBeenCalledWith("room turn failed after admission", expect.any(Error))
    consoleError.mockRestore()
  })
})

describe("room_send reference metadata", () => {
  it("forwards citations and the preamble summary to the runner", async () => {
    const { runner, calls, release } = fakeRunner()
    const citations = [
      { kind: "entity", id: "session:source_a", label: "Sprint planning" },
      { kind: "file", id: "src/a.ts", raw: "@src/a.ts" },
    ]
    const promptPreamble = {
      sections: ["references"],
      references: [{ kind: "entity", entityKind: "session", title: "Sprint planning" }],
    }
    await roomSend(
      {
        sessionId: "room-1",
        callerDeviceId: "dev-1",
        content: "with refs",
        citations,
        promptPreamble,
      },
      deps(runner)
    )
    expect(calls.send).toHaveBeenCalledWith(
      "with refs",
      expect.objectContaining({ citations, promptPreamble })
    )
    release()
  })

  it("rejects a citations list with a malformed entry rather than narrowing it", async () => {
    const { runner, calls, release } = fakeRunner()
    await expect(
      roomSend(
        {
          sessionId: "room-1",
          callerDeviceId: "dev-1",
          content: "x",
          citations: [
            { kind: "file", id: "ok.ts" },
            { kind: "bogus", id: "x" },
          ],
        },
        deps(runner)
      )
    ).rejects.toThrow(/citations/)
    await expect(
      roomSend(
        {
          sessionId: "room-1",
          callerDeviceId: "dev-1",
          content: "x",
          citations: "not-a-list",
        },
        deps(runner)
      )
    ).rejects.toThrow(/citations/)
    expect(calls.send).not.toHaveBeenCalled()
    release()
  })

  it("rejects a preamble that is not a summary, forwards a valid one", async () => {
    const { runner, calls, release } = fakeRunner()
    await expect(
      roomSend(
        {
          sessionId: "room-1",
          callerDeviceId: "dev-1",
          content: "x",
          promptPreamble: "not-an-object",
        },
        deps(runner)
      )
    ).rejects.toThrow(/promptPreamble/)
    await expect(
      roomSend(
        {
          sessionId: "room-1",
          callerDeviceId: "dev-1",
          content: "x",
          promptPreamble: { sections: "nope", references: [] },
        },
        deps(runner)
      )
    ).rejects.toThrow(/promptPreamble/)
    expect(calls.send).not.toHaveBeenCalled()
    release()
  })

  it("omits both fields when the payload carries none", async () => {
    const { runner, calls, release } = fakeRunner()
    await roomSend({ sessionId: "room-1", callerDeviceId: "dev-1", content: "plain" }, deps(runner))
    expect(calls.send).toHaveBeenCalledWith(
      "plain",
      expect.not.objectContaining({ citations: expect.anything() })
    )
    expect(calls.send).toHaveBeenCalledWith(
      "plain",
      expect.not.objectContaining({ promptPreamble: expect.anything() })
    )
    release()
  })
})

describe("roomStop", () => {
  it("stops the room and waits for the interrupt acks", async () => {
    const { runner, calls } = fakeRunner()
    await expect(
      roomStop({ sessionId: "room-1", callerDeviceId: "dev-1" }, deps(runner))
    ).resolves.toBeNull()
    expect(calls.stop).toHaveBeenCalledWith("room-1")
  })

  it("refuses without a session or a verified caller", async () => {
    const { runner } = fakeRunner()
    await expect(roomStop({ callerDeviceId: "dev-1" }, deps(runner))).rejects.toThrow(
      "room_stop.sessionId is required"
    )
    await expect(roomStop({ sessionId: "room-1" }, deps(runner))).rejects.toThrow(
      "room_stop.callerDeviceId is required"
    )
  })
})

describe("picked members and a single-member stop (ADR-0177 batch 3)", () => {
  it("forwards the composer's pick and refuses a malformed one", async () => {
    const { runner, calls } = fakeRunner()
    await roomSend(
      { sessionId: "room-1", callerDeviceId: "dev-1", content: "go", targetMemberIds: ["b", "a"] },
      deps(runner)
    )
    expect(calls.send).toHaveBeenCalledWith(
      "go",
      expect.objectContaining({ targetMemberIds: ["b", "a"] })
    )
    await roomSend(
      { sessionId: "room-1", callerDeviceId: "dev-1", content: "go", targetMemberIds: [] },
      deps(runner)
    )
    expect(calls.send).toHaveBeenLastCalledWith(
      "go",
      expect.not.objectContaining({ targetMemberIds: expect.anything() })
    )
    await expect(
      roomSend(
        { sessionId: "room-1", callerDeviceId: "dev-1", content: "go", targetMemberIds: [1] },
        deps(runner)
      )
    ).rejects.toThrow(/targetMemberIds/)
  })

  it("stops one member when the payload names one, the room otherwise", async () => {
    const { runner, calls } = fakeRunner()
    await roomStop(
      { sessionId: "room-1", callerDeviceId: "dev-1", characterId: "ava" },
      deps(runner)
    )
    expect(calls.stopMember).toHaveBeenCalledWith("room-1", "ava")
    expect(calls.stop).not.toHaveBeenCalled()
    await roomStop({ sessionId: "room-1", callerDeviceId: "dev-1" }, deps(runner))
    expect(calls.stop).toHaveBeenCalledWith("room-1")
    await expect(
      roomStop({ sessionId: "room-1", callerDeviceId: "dev-1", characterId: "" }, deps(runner))
    ).rejects.toThrow(/characterId/)
  })
})

describe("roomSquadHandoffDecide (ADR-0252 §4)", () => {
  const decide = jest.fn(async (..._args: unknown[]) => ({
    ok: true as const,
    decision: { status: "declined" as const, decidedAt: 1, decidedBy: { kind: "local" as const } },
  }))
  const handoffDeps = (port: unknown = { decide }) => ({
    squadHandoff: async () => port as never,
  })
  beforeEach(() => decide.mockClear())

  it("decides as the calling device, through the Squad module's decision", async () => {
    await expect(
      roomSquadHandoffDecide(
        {
          sessionId: "room-1",
          toolUseId: "tu-1",
          decision: "confirm",
          squadId: "sq-2",
          callerDeviceId: "dev-1",
        },
        handoffDeps()
      )
    ).resolves.toMatchObject({ ok: true })
    expect(decide).toHaveBeenCalledWith(
      { roomId: "room-1", toolUseId: "tu-1", decision: "confirm", squadId: "sq-2" },
      { kind: "device", deviceId: "dev-1" }
    )
  })

  it("refuses a malformed request before deciding anything", async () => {
    const base = {
      sessionId: "room-1",
      toolUseId: "tu-1",
      decision: "decline",
      callerDeviceId: "d",
    }
    const { callerDeviceId: _device, ...unverified } = base
    await expect(roomSquadHandoffDecide(unverified, handoffDeps())).rejects.toThrow(
      /callerDeviceId is required/
    )
    await expect(roomSquadHandoffDecide({ ...base, toolUseId: "" }, handoffDeps())).rejects.toThrow(
      /toolUseId is required/
    )
    await expect(
      roomSquadHandoffDecide({ ...base, decision: "maybe" }, handoffDeps())
    ).rejects.toThrow(/must be "confirm" or "decline"/)
    await expect(roomSquadHandoffDecide({ ...base, squadId: 5 }, handoffDeps())).rejects.toThrow(
      /squadId must be a Squad id/
    )
    await expect(roomSquadHandoffDecide(base, handoffDeps(null))).rejects.toThrow(
      /no Squads on this host/
    )
    expect(decide).not.toHaveBeenCalled()
  })
})

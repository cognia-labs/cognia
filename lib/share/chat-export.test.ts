import { assertChatShareAccess, buildChatShare, buildMultiChatShare } from "./chat-export"
import type { ChatSession } from "@cognia/agent-config-types"
import { assertPersonalShareSnapshot } from "./personal-snapshot"

const sortBy = jest.fn().mockResolvedValue([{ id: "m1" }])
const anyOf = jest.fn(() => ({ sortBy }))
const getCharacter = jest.fn()
const getSession = jest.fn()
const runRows = jest.fn().mockResolvedValue([])
const testDb = {
  messages: { where: () => ({ equals: () => ({ sortBy }), anyOf }) },
  characters: { get: getCharacter },
  sessions: { get: getSession },
  executionRuns: { where: () => ({ equals: (id: string) => ({ toArray: () => runRows(id) }) }) },
}
// Exporters are written in the reader's locale; the global next-intl mock
// resolves keys against the generated en.json.
jest.mock("@/lib/export/labels", () => {
  const actual = jest.requireActual("@/lib/export/labels")
  const { useTranslations: englishTranslator } = jest.requireMock("next-intl")
  return {
    ...actual,
    loadExportLabels: async () =>
      actual.exportLabelsFrom(englishTranslator("export.document"), "en"),
  }
})
jest.mock("@/lib/db/schema", () => ({
  getDb: () => testDb,
}))

const renderSingleExport = jest.fn((_arg: unknown) => ({
  content: "RENDERED",
  mimeType: "text/html",
  filename: "x.html",
}))
jest.mock("@/lib/export/single", () => ({
  renderSingleExport: (arg: unknown) => renderSingleExport(arg),
}))

const materializeChatShareMedia = jest.fn(async (messages: unknown[]) => ({
  messages,
  attachments: [] as unknown[],
  unavailable: 0,
}))
jest.mock("./chat-media", () => ({
  materializeChatShareMedia: (messages: unknown[]) => materializeChatShareMedia(messages),
}))

const session = { id: "s1", title: "My chat" } as ChatSession
const assertSharedSessionExport = jest.fn()
jest.mock("@/lib/collab/shared-session-access", () => ({
  assertSharedSessionExport: (...args: unknown[]) => assertSharedSessionExport(...args),
}))
const recordPersonalSinkReceipt = jest.fn().mockResolvedValue(undefined)
const readRunPersonalTaint = jest.fn().mockResolvedValue({ verified: true, marks: [] })
jest.mock("@/lib/execution/personal-sink", () => ({
  ...jest.requireActual("@/lib/execution/personal-sink"),
  recordPersonalSinkReceipt: (...args: unknown[]) => recordPersonalSinkReceipt(...args),
  readRunPersonalTaint: (...args: unknown[]) => readRunPersonalTaint(...args),
}))

beforeEach(() => {
  jest.clearAllMocks()
  sortBy.mockResolvedValue([{ id: "m1" }])
  assertSharedSessionExport.mockResolvedValue(undefined)
  getCharacter.mockResolvedValue(undefined)
  getSession.mockResolvedValue(session)
  runRows.mockResolvedValue([])
  readRunPersonalTaint.mockResolvedValue({ verified: true, marks: [] })
})

describe("buildChatShare", () => {
  it("withholds a retained private title after all marked source messages were deleted", async () => {
    sortBy.mockResolvedValueOnce([])
    runRows.mockResolvedValue([{ id: "retained-private-run" }])
    readRunPersonalTaint.mockResolvedValue({
      verified: true,
      marks: [{ person: { kind: "local-person" }, source: "lark-user", markedAt: 1 }],
    })
    const build = await buildChatShare({
      format: "html",
      session: { ...session, title: "private generated title" },
    })
    expect(build.payload.title).toBe("Conversation")
    expect(renderSingleExport).toHaveBeenCalledWith(
      expect.objectContaining({ session: expect.objectContaining({ title: "Conversation" }) })
    )
    expect(recordPersonalSinkReceipt).toHaveBeenCalledWith(
      { sessionId: "s1", sessionDerived: true },
      [{ kind: "local-person" }],
      "withhold",
      "private generated title",
      { kind: "public-share", sessionId: "s1", artifact: "title" }
    )
  })

  it("refuses a cached snapshot when later Host run marks change its public visibility", async () => {
    const build = await buildChatShare({ format: "html", session })
    runRows.mockResolvedValue([{ id: "later-marked-run" }])
    readRunPersonalTaint.mockResolvedValue({
      verified: true,
      marks: [{ person: { kind: "local-person" }, source: "lark-user", markedAt: 1 }],
    })
    await expect(assertPersonalShareSnapshot(build.payload)).rejects.toThrow("snapshot changed")
    expect(recordPersonalSinkReceipt).toHaveBeenCalledWith(
      { sessionId: "s1", sessionDerived: true },
      [{ kind: "local-person" }],
      "withhold",
      JSON.stringify(build.payload),
      { kind: "public-share", sessionId: "s1", artifact: "cached-snapshot" }
    )
  })

  it("keeps source-parent run marks on a branch title whose private rows were deleted", async () => {
    sortBy.mockResolvedValue([])
    getSession.mockImplementation(async (id: string) =>
      id === "parent" ? { ...session, id } : session
    )
    runRows.mockImplementation(async (id: string) =>
      id === "parent" ? [{ id: "parent-private-run" }] : []
    )
    readRunPersonalTaint.mockResolvedValue({
      verified: true,
      marks: [{ person: { kind: "local-person" }, source: "lark-user", markedAt: 1 }],
    })
    const build = await buildChatShare({
      format: "html",
      session: {
        ...session,
        branchSeed: { kind: "summary", content: "private seed" },
        parentSessionId: "parent",
      },
    })
    expect(build.payload.title).toBe("Conversation")
    expect(readRunPersonalTaint).toHaveBeenCalledWith({
      sessionId: "parent",
      executionRunId: "parent-private-run",
    })
  })
  it("withholds legacy connector history and its title before resolving share media", async () => {
    const privateMessage = {
      id: "legacy-private",
      sessionId: "s1",
      role: "assistant",
      createdAt: 1,
      parts: [
        { type: "text", text: "Private owner summary" },
        { type: "file", url: "cognia-media:private", mediaType: "image/png" },
      ],
    }
    sortBy.mockResolvedValueOnce([privateMessage])
    const build = await buildChatShare({
      format: "html",
      session: { ...session, platformBinding: { adapterId: "lark-owner" } } as ChatSession,
    })
    const messages = materializeChatShareMedia.mock.calls[0][0]
    expect(messages).toEqual([
      expect.objectContaining({
        id: "legacy-private",
        parts: [{ type: "text", text: "[Withheld: personal content of Host owner]" }],
      }),
    ])
    expect(JSON.stringify(messages)).not.toContain("cognia-media:private")
    expect(build.payload.title).toBe("Conversation")
    expect(recordPersonalSinkReceipt).toHaveBeenCalledWith(
      { sessionId: "s1", sessionDerived: true },
      [{ kind: "local-person" }],
      "withhold",
      JSON.stringify(privateMessage.parts),
      { kind: "public-share", sessionId: "s1", messageId: "legacy-private" }
    )
  })

  it("withholds explicit personal rows in a multi-conversation snapshot", async () => {
    sortBy.mockResolvedValueOnce([
      {
        id: "private",
        sessionId: "s1",
        parts: [{ type: "text", text: "private content" }],
        metadata: {
          personalMarks: [{ person: { kind: "local-person" }, source: "lark-user", markedAt: 1 }],
        },
      },
      { id: "ordinary", sessionId: "s2", parts: [{ type: "text", text: "ordinary" }] },
    ])
    await buildMultiChatShare({
      sessions: [session, { ...session, id: "s2" }],
      title: "Selection",
      copy: {
        count: "2",
        navigationLabel: "Conversations",
        previous: "Previous",
        next: "Next",
        frameTitle: "Conversation",
      },
    })
    expect(JSON.stringify(materializeChatShareMedia.mock.calls[0][0])).not.toContain(
      "private content"
    )
    expect(JSON.stringify(materializeChatShareMedia.mock.calls[0][0])).toContain("ordinary")
    expect(recordPersonalSinkReceipt).toHaveBeenCalledTimes(2)
  })

  it("rejects unauthorized shared exports before reading the local transcript", async () => {
    assertSharedSessionExport.mockRejectedValueOnce(new Error("forbidden"))
    await expect(buildChatShare({ format: "html", session })).rejects.toThrow("forbidden")
    expect(sortBy).not.toHaveBeenCalled()
    expect(renderSingleExport).not.toHaveBeenCalled()
  })
  it("fetches messages, renders, and wraps as a chat payload", async () => {
    const { payload, attachments } = await buildChatShare({ format: "html", session })
    expect(attachments).toEqual([])
    expect(sortBy).toHaveBeenCalledWith("createdAt")
    expect(renderSingleExport).toHaveBeenCalledWith(
      expect.objectContaining({ format: "html", session, messages: [{ id: "m1" }] })
    )
    expect(payload).toEqual({
      kind: "chat-html",
      mime: "text/html",
      data: "RENDERED",
      encoding: "utf8",
      title: "My chat",
    })
  })

  it("falls back to a default title when the session has none", async () => {
    const { payload } = await buildChatShare({
      format: "text",
      session: { id: "s2", title: "" } as ChatSession,
    })
    expect(payload.title).toBe("Conversation")
  })

  it("attaches encrypted structured provenance for a twin-bound conversation", async () => {
    getCharacter.mockResolvedValueOnce({ id: "character-1", twinId: "twin-1" })
    const { payload } = await buildChatShare({
      format: "text",
      session: { id: "s3", title: "Twin", characterId: "character-1" } as ChatSession,
    })
    expect(payload.provenance).toEqual([
      { source: "digital-twin", sourceId: "twin-1", disclosure: "ai-generated" },
    ])
  })
})

describe("buildChatShare media and branches (ADR-0222)", () => {
  it("renders the materialized transcript and hands its attachments over", async () => {
    const attachment = { path: "/attachments/big.png", name: "big.png", mime: "image/png" }
    materializeChatShareMedia.mockResolvedValueOnce({
      messages: [{ id: "m1-resolved" }],
      attachments: [attachment],
      unavailable: 2,
    })
    const build = await buildChatShare({ format: "jsonl", session, includeAllBranches: true })
    expect(materializeChatShareMedia).toHaveBeenCalledWith([{ id: "m1" }])
    expect(renderSingleExport).toHaveBeenCalledWith(
      expect.objectContaining({ messages: [{ id: "m1-resolved" }], includeAllBranches: true })
    )
    expect(build.attachments).toEqual([attachment])
    expect(build.unavailableMedia).toBe(2)
  })
})

describe("buildMultiChatShare", () => {
  it("rejects the entire selection before reading any transcript when one source denies export", async () => {
    assertSharedSessionExport
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("forbidden"))
    await expect(
      buildMultiChatShare({
        sessions: [session, { ...session, id: "denied" }],
        title: "Selection",
        copy: {
          count: "2",
          navigationLabel: "Conversations",
          previous: "Previous",
          next: "Next",
          frameTitle: "Conversation",
        },
      })
    ).rejects.toThrow("forbidden")
    expect(anyOf).not.toHaveBeenCalled()
    expect(renderSingleExport).not.toHaveBeenCalled()
  })

  it("bounds outstanding authorization requests for large selections", async () => {
    const release: Array<() => void> = []
    let active = 0
    let peak = 0
    assertSharedSessionExport.mockImplementation(() => {
      active += 1
      peak = Math.max(peak, active)
      return new Promise<void>((resolve) =>
        release.push(() => {
          active -= 1
          resolve()
        })
      )
    })
    const check = assertChatShareAccess(
      Array.from({ length: 17 }, (_, id) => ({ ...session, id: String(id) }))
    )
    while (assertSharedSessionExport.mock.calls.length < 17 || release.length) {
      release.splice(0).forEach((resolve) => resolve())
      await Promise.resolve()
    }
    await check
    expect(peak).toBeLessThanOrEqual(8)
    expect(assertSharedSessionExport).toHaveBeenCalledTimes(17)
  })

  it("preserves selection order while reusing the single-conversation renderer", async () => {
    const sessions = [
      { id: "s1", title: "First" },
      { id: "s2", title: "Second" },
    ] as ChatSession[]
    sortBy.mockResolvedValueOnce([
      { id: "m-first", sessionId: "s1" },
      { id: "m-second", sessionId: "s2" },
    ])
    renderSingleExport
      .mockReturnValueOnce({
        content: "<html><body>FIRST TRANSCRIPT</body></html>",
        mimeType: "text/html",
        filename: "first.html",
      })
      .mockReturnValueOnce({
        content: "<html><body>SECOND TRANSCRIPT</body></html>",
        mimeType: "text/html",
        filename: "second.html",
      })

    const { payload } = await buildMultiChatShare({
      sessions,
      title: "Selected conversations",
      copy: {
        count: "2 conversations",
        navigationLabel: "Shared conversations",
        previous: "Previous conversation",
        next: "Next conversation",
        frameTitle: "Conversation",
      },
    })

    expect(anyOf).toHaveBeenCalledWith(["s1", "s2"])
    expect(sortBy).toHaveBeenCalledTimes(1)
    expect(renderSingleExport).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        format: "html",
        session: sessions[0],
        messages: [{ id: "m-first", sessionId: "s1" }],
      })
    )
    expect(renderSingleExport).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        format: "html",
        session: sessions[1],
        messages: [{ id: "m-second", sessionId: "s2" }],
      })
    )
    expect(payload).toMatchObject({
      kind: "chat-animated",
      mime: "text/html",
      encoding: "utf8",
      title: "Selected conversations",
    })
    expect(payload.data.match(/<iframe/g)).toHaveLength(1)
    expect(payload.data.indexOf("FIRST TRANSCRIPT")).toBeLessThan(
      payload.data.indexOf("SECOND TRANSCRIPT")
    )
  })

  it("escapes session data before embedding it in the executable bundle", async () => {
    sortBy.mockResolvedValueOnce([])
    renderSingleExport.mockReturnValueOnce({
      content: "</script><img src=x onerror=alert(1)>",
      mimeType: "text/html",
      filename: "unsafe.html",
    })

    const { payload } = await buildMultiChatShare({
      sessions: [{ id: "unsafe", title: "</script><img src=x>" } as ChatSession],
      title: "</script><img src=x>",
      copy: {
        count: "1 conversation",
        navigationLabel: "Shared conversations",
        previous: "Previous conversation",
        next: "Next conversation",
        frameTitle: "Conversation",
      },
    })

    expect(payload.data).not.toContain("</script><img src=x")
    expect(payload.data).toContain("\\u003c/script\\u003e")
    expect(payload.data).toContain("&lt;/script&gt;&lt;img src=x&gt;")
  })
})

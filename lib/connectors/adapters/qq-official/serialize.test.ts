import type { OutboundRequest } from "@/types/connectors/outbound"
import type { MessageSegment } from "@/types/connectors/segment"
import {
  __resetQQMsgSeqForTesting,
  buildQQContent,
  decodeQQMessageId,
  encodeQQMessageId,
  parseQQEmojiType,
  QQ_MAX_PASSIVE_REPLIES,
  QQ_PASSIVE_WINDOW_MS,
  QQ_TYPING_INPUT_SECONDS,
  qqPassiveMsgSeq,
  qqPassiveReplyCount,
  registerQQPassiveReply,
  serializeDelete,
  serializeOutbound,
  serializeOutboundParts,
  serializeReaction,
  serializeTyping,
} from "./serialize"
import type { QQScene } from "./parse"

function req(
  scene: QQScene | undefined,
  sceneId: string | undefined,
  segments: MessageSegment[],
  extra: Partial<OutboundRequest> = {},
  msgId?: string,
  receivedAt?: number
): OutboundRequest {
  return {
    conversationRef: {
      platform: "qq-official",
      adapterId: "qq-1",
      scene,
      sceneId,
      msgId,
      ...(receivedAt !== undefined ? { receivedAt } : {}),
    },
    segments,
    metadata: { idempotencyKey: "k" },
    ...extra,
  }
}

const HI: MessageSegment[] = [{ type: "text", text: "hi" }]

beforeEach(() => {
  __resetQQMsgSeqForTesting()
})

describe("buildQQContent", () => {
  it("flattens text/markdown/media into plain text", () => {
    expect(
      buildQQContent([
        { type: "text", text: "a" },
        { type: "markdown", md: "**b**" },
        { type: "image", url: "https://e/p.png" },
      ])
    ).toBe("a\n**b**\n[image] https://e/p.png")
  })
})

describe("serializeOutbound", () => {
  it.each(["group", "c2c"] as const)(
    "prepares native %s URL and explicit inline file uploads",
    (scene) => {
      const file = {
        type: "file" as const,
        url: "https://cdn.example.org/report.pdf",
        name: "report.pdf",
        mimeType: "application/pdf",
        sizeBytes: 4,
      }
      expect(serializeOutbound(req(scene, "target", [file], {}, "trigger"), false)).toMatchObject({
        payload: { msg_type: 7, msg_id: "trigger" },
        upload: {
          path: `/v2/${scene === "group" ? "groups" : "users"}/target/files`,
          payload: { file_type: 4, file_name: "report.pdf", url: file.url, srv_send_msg: false },
        },
      })
      for (const source of ["data:application/pdf;base64,AP+AQQ=="]) {
        const call = serializeOutbound(
          req(scene, "target", [{ ...file, url: source }], {}, "trigger"),
          false
        )!
        expect(call.upload).toMatchObject({
          payload: { file_type: 4, srv_send_msg: false },
          binary: { fileName: "report.pdf" },
        })
        expect(call.upload!.payload).not.toHaveProperty("url")
      }
      const inline = serializeOutbound(
        req(scene, "target", [{ ...file, dataBase64: "AP+AQQ==" }], {}, "trigger"),
        false
      )!
      expect(inline.upload).toMatchObject({
        binary: { sourceUrl: "data:application/pdf;base64,AP+AQQ==" },
      })
    }
  )

  it("validates file limits, names and inline sources before reserving a passive slot", () => {
    for (const file of [
      { url: "https://cdn.example.org/a", name: "", sizeBytes: 1 },
      { url: "https://cdn.example.org/a", name: "a\nsecret", sizeBytes: 1 },
      { url: "https://cdn.example.org/a", name: "a", sizeBytes: 200_000_001 },
      { url: "data:application/pdf;base64,%%%", name: "a", sizeBytes: 1 },
      { url: "https://user:secret@cdn.example.org/a", name: "a", sizeBytes: 1 },
    ])
      expect(() =>
        serializeOutboundParts(
          req(
            "group",
            "target",
            [{ type: "file", mimeType: "application/pdf", ...file }],
            {},
            "trigger"
          )
        )
      ).toThrow()
    expect(qqPassiveReplyCount("trigger")).toBe(0)
    expect(() =>
      serializeOutbound(
        req(
          "channel",
          "target",
          [
            {
              type: "file",
              url: "https://cdn.example.org/a",
              name: "a",
              mimeType: "application/pdf",
              sizeBytes: 1,
            },
          ],
          {},
          "trigger"
        )
      )
    ).toThrow(/does not support file/)
  })

  it.each(["group", "c2c"] as const)(
    "uses the same native quote on every %s Markdown/media part and on retry",
    (scene) => {
      const request = req(
        scene,
        "target",
        [
          { type: "reply", messageId: "current", snippet: "do not duplicate this preview" },
          { type: "markdown", md: "**before**" },
          { type: "image", url: "https://cdn.example.org/p.png" },
          { type: "text", text: "after" },
        ],
        {},
        "current"
      )
      request.conversationRef.qqMsgIndex = "REFIDX_current=="
      const calls = serializeOutboundParts(request)
      expect(calls).toHaveLength(3)
      for (const call of calls) {
        expect(call.payload).toMatchObject({
          msg_id: "current",
          message_reference: { message_id: "REFIDX_current==" },
        })
        expect(JSON.stringify(call)).not.toContain("do not duplicate this preview")
      }
      expect(serializeOutboundParts(request).map((call) => call.payload.msg_seq)).toEqual(
        calls.map((call) => call.payload.msg_seq)
      )
      expect(qqPassiveReplyCount("current")).toBe(3)
      expect(calls.flatMap((call) => call.downgrades ?? [])).not.toContainEqual(
        expect.objectContaining({ from: "reply" })
      )
    }
  )

  it.each(["group", "c2c"] as const)(
    "keeps %s quote targets separate from passive authorization",
    (scene) => {
      const request = req(
        scene,
        "target",
        HI,
        { replyTo: { messageId: "older-message" } },
        "current-trigger",
        Date.now()
      )
      request.conversationRef.qqQuoteIndex = "REFIDX_older=="
      const call = serializeOutbound(request)!
      expect(call.payload).toMatchObject({
        msg_id: "current-trigger",
        message_reference: { message_id: "REFIDX_older==" },
      })
      expect(qqPassiveReplyCount("older-message")).toBe(0)
      expect(qqPassiveReplyCount("current-trigger")).toBe(1)
      request.conversationRef.receivedAt = Date.now() - QQ_PASSIVE_WINDOW_MS[scene] - 1
      expect(() => serializeOutbound(request)).toThrow(/expired/)
      delete request.conversationRef.msgId
      expect(() => serializeOutbound(request)).toThrow(/passive reply context/)
    }
  )

  it.each(["group", "c2c"] as const)("quotes the current %s event using its own index", (scene) => {
    const request = req(
      scene,
      "target",
      [{ type: "markdown", md: "**answer**" }],
      { replyTo: { messageId: "trigger" } },
      "trigger"
    )
    request.conversationRef.qqMsgIndex = "REFIDX_trigger=="
    expect(serializeOutbound(request)?.payload).toMatchObject({
      msg_id: "trigger",
      msg_type: 2,
      message_reference: { message_id: "REFIDX_trigger==" },
    })
    delete request.conversationRef.qqMsgIndex
    expect(() => serializeOutbound(request)).toThrow(/quote index/)
  })

  it.each(["group", "c2c"] as const)(
    "serializes native %s Markdown without a conflicting text body",
    (scene) => {
      const md = "# Heading\n\n**bold** [link](https://example.com)\n\n- item"
      const call = serializeOutbound(
        req(scene, "target", [{ type: "markdown", md }], {}, "inbound")
      )!
      expect(call.payload).toEqual({
        msg_type: 2,
        markdown: { content: md },
        msg_id: "inbound",
        msg_seq: qqPassiveMsgSeq("k"),
      })
      expect(call.upload).toBeUndefined()
    }
  )

  it.each(["group", "c2c"] as const)("escapes literal text beside %s Markdown", (scene) => {
    const call = serializeOutbound(
      req(
        scene,
        "target",
        [
          { type: "text", text: "[literal](https://example.com) *not bold*" },
          { type: "markdown", md: "**actual bold**" },
        ],
        {},
        "inbound"
      )
    )!
    expect(call.payload.markdown).toEqual({
      content: "\\[literal\\](https://example.com) \\*not bold\\*\n**actual bold**",
    })
    expect(call.payload).not.toHaveProperty("content")
  })

  it.each(["channel", "direct"] as const)(
    "keeps %s Markdown as a reported text fallback",
    (scene) => {
      const call = serializeOutbound(
        req(scene, "target", [{ type: "markdown", md: "**fallback**" }], {}, "inbound")
      )!
      expect(call.payload).toEqual({ content: "**fallback**", msg_id: "inbound" })
      expect(call.downgrades).toContainEqual({
        from: "markdown",
        to: "text",
        reason: "qq_markdown_scene_unsupported",
      })
    }
  )

  it.each(["group", "c2c"] as const)(
    "splits %s Markdown and media in order with stable retry keys",
    (scene) => {
      const input = req(
        scene,
        "target",
        [
          { type: "markdown", md: "**before**" },
          { type: "image", url: "https://cdn.example.org/a.png" },
          { type: "markdown", md: "_after_" },
        ],
        {},
        "mixed"
      )
      const preview = serializeOutboundParts(input, false)
      expect(preview.map((call) => call.payload.msg_type)).toEqual([2, 7, 2])
      expect(preview[0].payload.markdown).toEqual({ content: "**before**" })
      expect(preview[1].payload).not.toHaveProperty("markdown")
      expect(preview[2].payload.markdown).toEqual({ content: "_after_" })
      expect(qqPassiveReplyCount("mixed")).toBe(0)
      expect(serializeOutboundParts(input)).toEqual(preview)
      expect(serializeOutboundParts(input)).toEqual(preview)
      expect(qqPassiveReplyCount("mixed")).toBe(3)
    }
  )

  it("preflights the C2C reply budget after Markdown/media splitting", () => {
    const input = req(
      "c2c",
      "user",
      [
        { type: "markdown", md: "first" },
        { type: "image", url: "https://cdn.example.org/a.png" },
        { type: "markdown", md: "second" },
        { type: "image", url: "https://cdn.example.org/b.png" },
        { type: "markdown", md: "third" },
      ],
      {},
      "over-budget"
    )
    expect(() => serializeOutboundParts(input)).toThrow("4-reply")
    expect(qqPassiveReplyCount("over-budget")).toBe(0)
  })

  it("rejects whitespace-only Markdown without reserving a reply", () => {
    expect(() =>
      serializeOutboundParts(
        req("group", "target", [{ type: "markdown", md: " \n\t" }], {}, "empty-md")
      )
    ).toThrow(/Markdown.*empty/)
    expect(qqPassiveReplyCount("empty-md")).toBe(0)
  })

  it("preflights every multipart reply without spending slots or dropping trailing text", () => {
    const input = req(
      "group",
      "GO",
      [
        { type: "image", url: "https://cdn.example.org/a.png" },
        { type: "text", text: "after image" },
      ],
      {},
      "m1"
    )
    const preview = serializeOutboundParts(input, false)
    expect(qqPassiveReplyCount("m1")).toBe(0)
    expect(preview.map((part) => part.payload.msg_type)).toEqual([7, 0])
    expect(preview[1].payload.content).toBe("after image")
    expect(serializeOutboundParts(input)).toEqual(preview)
    expect(qqPassiveReplyCount("m1")).toBe(2)
    expect(serializeOutboundParts(input)).toEqual(preview)
    expect(qqPassiveReplyCount("m1")).toBe(2)
  })
  it("rejects an over-cap multipart message atomically", () => {
    const input = req(
      "group",
      "GO",
      Array.from({ length: 6 }, (_, i) => ({
        type: "image" as const,
        url: `https://cdn.example.org/${i}.png`,
      })),
      {},
      "m1"
    )
    expect(() => serializeOutboundParts(input)).toThrow("5-reply")
    expect(qqPassiveReplyCount("m1")).toBe(0)
  })
  it("rejects non-public URLs, non-SILK voice, unsupported channel video, and empty input", () => {
    expect(() =>
      serializeOutboundParts(
        req("group", "GO", [{ type: "image", url: "http://127.0.0.1/x" }], {}, "m1")
      )
    ).toThrow("public")
    expect(() =>
      serializeOutboundParts(
        req(
          "group",
          "GO",
          [{ type: "voice", url: "https://cdn.example.org/x", mimeType: "audio/mpeg" }],
          {},
          "m1"
        )
      )
    ).toThrow("SILK")
    expect(() =>
      serializeOutboundParts(
        req("channel", "CH", [{ type: "video", url: "https://cdn.example.org/x" }], {}, "m1")
      )
    ).toThrow("does not support")
    expect(() => serializeOutboundParts(req("group", "GO", [], {}, "m1"))).toThrow("empty")
  })
  it.each(["group", "c2c", "channel", "direct"] as const)(
    "rejects removed proactive sends in %s",
    (scene) => {
      expect(() => serializeOutbound(req(scene, "target", HI))).toThrow("proactive")
    }
  )
  it("addresses a group message and threads the inbound msg_id as a passive reply", () => {
    const call = serializeOutbound(req("group", "GO", HI, {}, "m1"))
    expect(call).toEqual({
      path: "/v2/groups/GO/messages",
      payload: { content: "hi", msg_type: 0, msg_id: "m1", msg_seq: qqPassiveMsgSeq("k") },
    })
  })

  it("addresses a c2c message", () => {
    const call = serializeOutbound(req("c2c", "UO", HI, {}, "m2"))
    expect(call?.path).toBe("/v2/users/UO/messages")
    expect(call?.payload.msg_type).toBe(0)
    expect(call?.payload.msg_seq).toBe(qqPassiveMsgSeq("k"))
  })

  it("addresses a channel message without msg_type or msg_seq", () => {
    const call = serializeOutbound(req("channel", "CH", HI, {}, "m3"))
    expect(call?.path).toBe("/channels/CH/messages")
    expect(call?.payload).not.toHaveProperty("msg_type")
    expect(call?.payload).not.toHaveProperty("msg_seq")
    expect(call?.payload.msg_id).toBe("m3")
  })

  it("addresses a direct (dms) message", () => {
    const call = serializeOutbound(req("direct", "GUILD", HI, {}, "direct-msg"))
    expect(call?.path).toBe("/dms/GUILD/messages")
  })

  it("retains legacy explicit msg_id behavior for guild channels", () => {
    const call = serializeOutbound(
      req("channel", "GO", HI, { replyTo: { messageId: "explicit" } }, "captured")
    )
    expect(call?.payload.msg_id).toBe("explicit")
  })
  it("retains legacy guild timestamp handling for explicit different IDs", () => {
    expect(
      serializeOutbound(req("channel", "GO", HI, { replyTo: { messageId: "different" } }, "old", 1))
        ?.payload.msg_id
    ).toBe("different")
  })

  it("returns null for an unaddressable ref", () => {
    expect(serializeOutbound(req(undefined, undefined, [{ type: "text", text: "x" }]))).toBeNull()
  })
})

describe("qqPassiveMsgSeq", () => {
  it("is deterministic, positive and inside the 16-bit range", () => {
    const seq = qqPassiveMsgSeq("job-1")
    expect(seq).toBe(qqPassiveMsgSeq("job-1"))
    expect(Number.isInteger(seq)).toBe(true)
    expect(seq).toBeGreaterThanOrEqual(1)
    expect(seq).toBeLessThanOrEqual(65535)
    expect(qqPassiveMsgSeq("job-1")).not.toBe(qqPassiveMsgSeq("job-2"))
  })
})

describe("serializeOutbound — msg_seq", () => {
  it.each(["c2c", "group"] as const)(
    "enforces the %s reply budget and permits retries",
    (scene) => {
      const limit = scene === "c2c" ? 4 : 5
      for (let i = 0; i < limit; i++) {
        expect(
          serializeOutbound(
            req(scene, "target", HI, { metadata: { idempotencyKey: `reply-${i}` } }, "budget")
          )
        ).not.toBeNull()
      }
      expect(() =>
        serializeOutbound(
          req(scene, "target", HI, { metadata: { idempotencyKey: "overflow" } }, "budget")
        )
      ).toThrow(`${limit}-reply`)
      expect(
        serializeOutbound(
          req(scene, "target", HI, { metadata: { idempotencyKey: "reply-0" } }, "budget")
        )
      ).not.toBeNull()
      expect(qqPassiveReplyCount("budget")).toBe(limit)
    }
  )

  it("rejects a five-part C2C reply before reserving any slots", () => {
    const input = req(
      "c2c",
      "user",
      Array.from({ length: 5 }, (_, i) => ({
        type: "image" as const,
        url: `https://cdn.example.org/${i}.png`,
      })),
      {},
      "multipart-c2c"
    )
    expect(() => serializeOutboundParts(input)).toThrow("4-reply")
    expect(qqPassiveReplyCount("multipart-c2c")).toBe(0)
  })

  const withKey = (key: string, msgId = "m1", scene: QQScene = "group", sceneId = "GO") =>
    req(scene, sceneId, HI, { metadata: { idempotencyKey: key } }, msgId)

  it("derives msg_seq from the idempotency key so distinct replies get distinct seqs", () => {
    const first = serializeOutbound(withKey("job-a"))
    const second = serializeOutbound(withKey("job-b"))
    const third = serializeOutbound(withKey("job-c"))
    expect(first?.payload.msg_seq).toBe(qqPassiveMsgSeq("job-a"))
    expect(second?.payload.msg_seq).toBe(qqPassiveMsgSeq("job-b"))
    expect(third?.payload.msg_seq).toBe(qqPassiveMsgSeq("job-c"))
    expect(new Set([first, second, third].map((c) => c?.payload.msg_seq)).size).toBe(3)
  })

  it("a retry (same idempotency key) re-sends the same msg_id + msg_seq pair", () => {
    const first = serializeOutbound(withKey("job-a"))
    const retry = serializeOutbound(withKey("job-a"))
    expect(retry?.payload).toEqual(first?.payload)
    expect(qqPassiveReplyCount("m1")).toBe(1)
  })

  it("keeps independent reply counts per msg_id", () => {
    serializeOutbound(withKey("job-a", "m1"))
    serializeOutbound(withKey("job-b", "m1"))
    const other = serializeOutbound(withKey("job-c", "m2", "c2c", "UO"))
    expect(other?.payload.msg_seq).toBe(qqPassiveMsgSeq("job-c"))
    expect(qqPassiveReplyCount("m1")).toBe(2)
    expect(qqPassiveReplyCount("m2")).toBe(1)
  })

  it("rejects a sixth distinct passive reply without removing its context", () => {
    for (let i = 1; i <= QQ_MAX_PASSIVE_REPLIES.group; i++) {
      const call = serializeOutbound(withKey(`job-${i}`))
      expect(call?.payload.msg_seq).toBe(qqPassiveMsgSeq(`job-${i}`))
    }
    expect(() => serializeOutbound(withKey("job-6"))).toThrow("5-reply")
    // The rejected job does not consume a slot; a retry of an earlier job still passes.
    expect(qqPassiveReplyCount("m1")).toBe(QQ_MAX_PASSIVE_REPLIES.group)
    expect(serializeOutbound(withKey("job-1"))?.payload.msg_seq).toBe(qqPassiveMsgSeq("job-1"))
  })

  it("falls back to a per-send synthetic key when the request has no idempotency key", () => {
    const first = serializeOutbound(withKey("", "m1"))
    const second = serializeOutbound(withKey("", "m1"))
    expect(first?.payload.msg_id).toBe("m1")
    expect(second?.payload.msg_id).toBe("m1")
    expect(first?.payload.msg_seq).not.toBe(second?.payload.msg_seq)
    expect(qqPassiveReplyCount("m1")).toBe(2)
  })

  it("evicts the oldest msg_ids when the bounded map overflows", () => {
    serializeOutbound(withKey("job-a", "evict-me"))
    // Push 300 other msg_ids through — "evict-me" falls off the front.
    for (let i = 0; i < 300; i++) {
      serializeOutbound(withKey(`job-${i}`, `other-${i}`))
    }
    expect(qqPassiveReplyCount("evict-me")).toBe(0)
    serializeOutbound(withKey("job-z", "evict-me"))
    expect(qqPassiveReplyCount("evict-me")).toBe(1)
  })

  it("refreshes recency on reuse so hot msg_ids survive eviction", () => {
    serializeOutbound(withKey("job-a", "hot"))
    for (let i = 0; i < 299; i++) {
      serializeOutbound(withKey(`job-${i}`, `filler-${i}`))
    }
    // Touch "hot" again — moves it to the back of the eviction queue.
    serializeOutbound(withKey("job-b", "hot"))
    expect(qqPassiveReplyCount("hot")).toBe(2)
    for (let i = 0; i < 200; i++) {
      serializeOutbound(withKey(`job2-${i}`, `filler2-${i}`))
    }
    serializeOutbound(withKey("job-c", "hot"))
    expect(qqPassiveReplyCount("hot")).toBe(3)
  })

  it("registerQQPassiveReply is idempotent per key and counts distinct keys", () => {
    expect(registerQQPassiveReply("mx", "k1")).toBe(1)
    expect(registerQQPassiveReply("mx", "k1")).toBe(1)
    expect(registerQQPassiveReply("mx", "k2")).toBe(2)
    expect(qqPassiveReplyCount("mx")).toBe(2)
  })
})

describe("serializeOutbound — passive window expiry", () => {
  afterEach(() => {
    jest.restoreAllMocks()
  })

  it("keeps msg_id when the group window (5 min) has not elapsed", () => {
    const now = 1_000_000_000
    jest.spyOn(Date, "now").mockReturnValue(now)
    const call = serializeOutbound(req("group", "GO", HI, {}, "m1", now - 4 * 60_000))
    expect(call?.payload.msg_id).toBe("m1")
  })

  it("rejects replies once the group window has elapsed", () => {
    const now = 1_000_000_000
    jest.spyOn(Date, "now").mockReturnValue(now)
    expect(() =>
      serializeOutbound(req("group", "GO", HI, {}, "m1", now - QQ_PASSIVE_WINDOW_MS.group - 1))
    ).toThrow("reply window")
  })

  it("uses the 60-minute window for c2c", () => {
    const now = 1_000_000_000
    jest.spyOn(Date, "now").mockReturnValue(now)
    const fresh = serializeOutbound(req("c2c", "UO", HI, {}, "m1", now - 30 * 60_000))
    expect(fresh?.payload.msg_id).toBe("m1")
    expect(() => serializeOutbound(req("c2c", "UO", HI, {}, "m2", now - 61 * 60_000))).toThrow(
      "reply window"
    )
  })

  it("rejects an expired msg_id on channel sends too", () => {
    const now = 1_000_000_000
    jest.spyOn(Date, "now").mockReturnValue(now)
    expect(() => serializeOutbound(req("channel", "CH", HI, {}, "m3", now - 6 * 60_000))).toThrow(
      "reply window"
    )
  })

  it("treats refs without receivedAt as fresh (pre-existing rows)", () => {
    const call = serializeOutbound(req("group", "GO", HI, {}, "m1"))
    expect(call?.payload.msg_id).toBe("m1")
  })
})

describe("encodeQQMessageId / decodeQQMessageId", () => {
  it("round-trips every scene", () => {
    for (const scene of ["group", "c2c", "channel", "direct"] as const) {
      const id = encodeQQMessageId(scene, "S:1", "MSG")
      expect(id).toBe(`${scene}:S:1:MSG`)
      expect(decodeQQMessageId(id)).toEqual({ scene, sceneId: "S", id: "1:MSG" })
    }
    expect(decodeQQMessageId("channel:CH:m9")).toEqual({
      scene: "channel",
      sceneId: "CH",
      id: "m9",
    })
  })

  it("returns null for bare ids, unknown scenes and truncated composites", () => {
    expect(decodeQQMessageId("m9")).toBeNull()
    expect(decodeQQMessageId("guild:CH:m9")).toBeNull()
    expect(decodeQQMessageId("group:GO")).toBeNull()
    expect(decodeQQMessageId("group:GO:")).toBeNull()
    expect(decodeQQMessageId(":GO:m")).toBeNull()
    expect(decodeQQMessageId("group::m")).toBeNull()
  })
})

describe("serializeDelete", () => {
  it("maps each scene to its recall endpoint (hidetip=false on guild scenes)", () => {
    expect(serializeDelete({ scene: "group", sceneId: "GO", id: "m1" })).toEqual({
      method: "DELETE",
      path: "/v2/groups/GO/messages/m1",
    })
    expect(serializeDelete({ scene: "c2c", sceneId: "UO", id: "m1" }).path).toBe(
      "/v2/users/UO/messages/m1"
    )
    expect(serializeDelete({ scene: "channel", sceneId: "CH", id: "m1" }).path).toBe(
      "/channels/CH/messages/m1?hidetip=false"
    )
    expect(serializeDelete({ scene: "direct", sceneId: "G", id: "m1" }).path).toBe(
      "/dms/G/messages/m1?hidetip=false"
    )
  })

  it("URL-encodes ids", () => {
    expect(serializeDelete({ scene: "group", sceneId: "a/b", id: "c d" }).path).toBe(
      "/v2/groups/a%2Fb/messages/c%20d"
    )
  })
})

describe("serializeReaction / parseQQEmojiType", () => {
  it("builds PUT for add and DELETE for remove on the channel reaction path", () => {
    expect(serializeReaction("CH", "m1", "1:4", "add")).toEqual({
      method: "PUT",
      path: "/channels/CH/messages/m1/reactions/1/4",
    })
    expect(serializeReaction("CH", "m1", "2:128512", "remove")).toEqual({
      method: "DELETE",
      path: "/channels/CH/messages/m1/reactions/2/128512",
    })
  })

  it("rejects emoji types that are not <type>:<id>", () => {
    expect(() => parseQQEmojiType("👍")).toThrow(/<type>:<id>/)
    expect(() => parseQQEmojiType(":4")).toThrow(/<type>:<id>/)
    expect(() => parseQQEmojiType("1:")).toThrow(/<type>:<id>/)
    expect(parseQQEmojiType("1:4")).toEqual({ type: "1", id: "4" })
  })
})

describe("serializeTyping", () => {
  it("builds the c2c input_notify passive reply", () => {
    expect(serializeTyping("UO", "in-1", 77)).toEqual({
      method: "POST",
      path: "/v2/users/UO/messages",
      payload: {
        msg_type: 6,
        input_notify: { input_type: 1, input_second: QQ_TYPING_INPUT_SECONDS },
        msg_id: "in-1",
        msg_seq: 77,
      },
    })
  })
})

describe("QQ text alternatives", () => {
  it.each(["group", "c2c", "channel", "direct"] as const)(
    "preserves mention, reply, poll and location in %s",
    (scene) => {
      const call = serializeOutbound(
        req(
          scene,
          "target",
          [
            { type: "mention", userId: "u", displayName: "Alice" },
            { type: "reply", messageId: "prior", snippet: "context" },
            { type: "poll", question: "Pick", options: ["A", "B"] },
            { type: "location", lat: 1, lon: 2, name: "Office" },
          ],
          {},
          "m1"
        )
      )
      expect(call?.payload.content).toBe("@Alice\n> context\nPick\n- A\n- B\n[location 1,2 Office]")
      expect(call?.downgrades).toEqual(
        ["mention", "reply", "poll", "location"].map((from) => ({
          from,
          to: "text",
          reason: `qq_${from}_text_alternative`,
        }))
      )
    }
  )
  it("rejects a trailing opaque card before reserving any multipart reply slot", () => {
    const input = req(
      "group",
      "target",
      [
        { type: "image", url: "https://example.com/a.jpg" },
        { type: "card", card: { kind: "custom", payload: { title: "opaque" } } },
      ],
      {},
      "m1"
    )
    expect(() => serializeOutboundParts(input)).toThrow(/opaque cards/)
    expect(qqPassiveReplyCount("m1")).toBe(0)
  })
  it("keeps text alternatives with native media and subsequent messages", () => {
    const input = req(
      "group",
      "target",
      [
        { type: "mention", userId: "u" },
        { type: "image", url: "https://example.com/a.jpg" },
        { type: "reply", messageId: "prior", snippet: "after" },
      ],
      {},
      "m1"
    )
    const calls = serializeOutboundParts(input)
    expect(calls[0]).toMatchObject({
      payload: { content: "@u", msg_type: 7 },
      upload: { payload: { file_type: 1 } },
      downgrades: [{ from: "mention" }],
    })
    expect(calls[1]).toMatchObject({
      payload: { content: "> after", msg_type: 0 },
      downgrades: [{ from: "reply" }],
    })
  })
})

it.each(["group", "c2c"] as const)(
  "uses event_id exclusively for %s interaction replies and budgets",
  (scene) => {
    const input = req(scene, "target", HI, {}, undefined, Date.now())
    input.conversationRef.eventId = "press-1"
    const call = serializeOutbound(input)!
    expect(call.payload.event_id).toBe("press-1")
    expect(call.payload).not.toHaveProperty("msg_id")
    expect(qqPassiveReplyCount("event:press-1")).toBe(1)
    input.conversationRef.msgId = "message"
    expect(() => serializeOutbound(input)).toThrow(/exclusive|ambiguous/i)
  }
)

it.each(["group", "c2c"] as const)(
  "preserves %s native keyboard ordering, quotes and preflight budgets",
  (scene) => {
    const card: MessageSegment = {
      type: "card",
      card: {
        kind: "qq-keyboard",
        payload: {
          markdown: { content: "**Choose**" },
          keyboard: {
            content: {
              rows: [
                {
                  buttons: [
                    {
                      id: "b",
                      render_data: { label: "Help" },
                      action: { type: 2, data: "/help", permission: { type: 2 } },
                    },
                  ],
                },
              ],
            },
          },
        },
      },
    }
    const input = req(
      scene,
      "target",
      [{ type: "text", text: "before" }, card, { type: "text", text: "after" }],
      {},
      "inbound",
      Date.now()
    )
    input.conversationRef.qqQuoteIndex = "REFIDX_quote=="
    input.replyTo = { messageId: "parent" }
    const calls = serializeOutboundParts(input, false)
    expect(calls.map((call) => call.payload.msg_type)).toEqual([0, 2, 0])
    expect(calls[1]!.payload).toMatchObject({
      markdown: { content: "**Choose**" },
      keyboard: expect.any(Object),
      message_reference: { message_id: "REFIDX_quote==" },
    })
    expect(calls.every((call) => !call.payload.keyboard || call === calls[1])).toBe(true)
    expect(qqPassiveReplyCount("inbound")).toBe(0)
    for (let i = 0; i < (scene === "group" ? 3 : 2); i++)
      registerQQPassiveReply("inbound", `used:${i}`)
    expect(() => serializeOutboundParts(input)).toThrow(/limit/)
    expect(qqPassiveReplyCount("inbound")).toBe(scene === "group" ? 3 : 2)
  }
)

import { parseQQDispatch, stripChannelMention, type QQDispatch } from "./parse"

const ADAPTER = "qq-1"
const SELF = "bot-app-id"

function dispatch(t: string, d: QQDispatch["d"]): QQDispatch {
  return { t, op: 0, s: 1, d }
}

describe("stripChannelMention", () => {
  it("removes a leading channel @mention", () => {
    expect(stripChannelMention("<@!123456> hello there")).toBe("hello there")
    expect(stripChannelMention("<@987> hi")).toBe("hi")
  })
  it("leaves plain content untouched", () => {
    expect(stripChannelMention("just text")).toBe("just text")
  })
})

describe("parseQQDispatch", () => {
  it.each([
    [12, { feature_id: "help" }, { kind: "menu", featureId: "help" }],
    [
      13,
      { message_id: "reply", feedback_opt: "LIKE", checked: 1 },
      { kind: "feedback", vote: "positive", selected: true, messageId: "c2c:user:reply" },
    ],
    [14, {}, { kind: "session_reset" }],
    [15, { action: "ENTER_STORY" }, { kind: "story", action: "enter" }],
    [16, { action: "model-1" }, { kind: "model_change", action: "model-1" }],
    [
      18,
      { authorize_data: { scope: "c2c_push", opt_scene: "dialog" } },
      { kind: "authorization", scope: "proactive", source: "dialog", state: "unknown" },
    ],
    [20, {}, { kind: "authorization", state: "unknown" }],
  ])(
    "normalizes native type%s as shared non-message interaction metadata",
    (type, resolved, interaction) => {
      const out = parseQQDispatch(ADAPTER, SELF, {
        op: 0,
        t: "INTERACTION_CREATE",
        id: "outer",
        d: {
          id: "press",
          type,
          scene: "c2c",
          chat_type: 2,
          user_openid: "user",
          timestamp: new Date().toISOString(),
          data: { type, resolved: { ...resolved, auth_token: "never-retain" } },
        },
      } as never)!
      expect(out).toMatchObject({
        kind: "system",
        interaction,
        segments: type === 13 ? [{ type: "emoji", code: "👍" }] : [],
        plainText: "",
        canReplyToMessage: false,
      })
      expect(out).not.toHaveProperty("deliveryPermissionChange")
      expect(out.conversationRef).not.toHaveProperty("msgId")
      expect(JSON.stringify(out)).not.toContain("never-retain")
      if (type === 13)
        expect(out).toMatchObject({
          systemKind: "reaction_added",
          replacesMessageId: "c2c:user:reply",
        })
      if (type === 12) expect(out.passiveEvent).toMatchObject({ id: "press" })
      else expect(out).not.toHaveProperty("passiveEvent")
    }
  )
  it("routes a deselected negative feedback through the existing reaction removal contract", () => {
    expect(
      parseQQDispatch(ADAPTER, SELF, {
        op: 0,
        t: "INTERACTION_CREATE",
        d: {
          id: "unlike",
          type: 13,
          scene: "c2c",
          user_openid: "user",
          timestamp: new Date().toISOString(),
          data: { resolved: { message_id: "reply", feedback_opt: "UNLIKE", checked: 0 } },
        },
      } as never)
    ).toMatchObject({
      systemKind: "reaction_removed",
      replacesMessageId: "c2c:user:reply",
      segments: [{ type: "emoji", code: "👎" }],
      interaction: { kind: "feedback", vote: "negative", selected: false },
    })
  })
  it("parses group authorization without turning a scope observation into consent", () => {
    const out = parseQQDispatch(ADAPTER, SELF, {
      op: 0,
      t: "INTERACTION_CREATE",
      d: {
        id: "group-grant",
        type: 19,
        scene: "group",
        group_openid: "group",
        group_member_openid: "operator",
        timestamp: new Date().toISOString(),
        data: { resolved: { authorize_data: { scope: "group_push", opt_scene: "setting" } } },
      },
    } as never)!
    expect(out).toMatchObject({
      systemKind: "interaction",
      interaction: {
        kind: "authorization",
        state: "unknown",
        scope: "proactive",
        source: "settings",
      },
    })
    expect(out).not.toHaveProperty("deliveryPermissionChange")
  })
  it.each([
    {
      type: 12,
      scene: "group",
      group_openid: "g",
      group_member_openid: "u",
      data: { resolved: { feature_id: "x" } },
    },
    { type: 13, data: { resolved: { message_id: "x", feedback_opt: "LIKE", checked: 2 } } },
    { type: 18, data: { resolved: { authorize_data: { scope: "group_push" } } } },
    { type: 15, data: { resolved: { action: "arbitrary" } } },
    { type: 14, data: { type: 16 } },
  ])("rejects malformed or contradictory interactions: %j", (fields) => {
    expect(
      parseQQDispatch(ADAPTER, SELF, {
        op: 0,
        t: "INTERACTION_CREATE",
        d: {
          id: "press",
          scene: "c2c",
          user_openid: "user",
          timestamp: new Date().toISOString(),
          ...fields,
        },
      } as never)
    ).toBeNull()
  })
  it.each(["MESSAGE_AUDIT_PASS", "MESSAGE_AUDIT_REJECT"])(
    "normalizes %s to a scoped common delivery status",
    (t) => {
      const out = parseQQDispatch(ADAPTER, SELF, {
        op: 0,
        t,
        id: "audit-event",
        d: {
          audit_id: "audit",
          guild_id: "guild",
          channel_id: "channel",
          create_time: new Date(Date.now() - 1000).toISOString(),
          audit_time: new Date().toISOString(),
          ...(t.endsWith("PASS") ? { message_id: "delivered" } : {}),
          auth_token: "never-retain",
        },
      } as never)!
      expect(out).toMatchObject({
        kind: "system",
        systemKind: "delivery_status",
        deliveryStatus: {
          receiptId: "audit",
          status: t.endsWith("PASS") ? "delivered" : "rejected",
          ...(t.endsWith("PASS") ? { platformMessageId: "channel:channel:delivered" } : {}),
        },
      })
      expect(out).not.toHaveProperty("passiveEvent")
      expect(out).not.toHaveProperty("deliveryPermissionChange")
      expect(JSON.stringify(out)).not.toContain("never-retain")
    }
  )
  it("preserves bounded friend-add referral metadata separately from delivery authority", () => {
    const out = parseQQDispatch(ADAPTER, SELF, {
      op: 0,
      t: "FRIEND_ADD",
      id: "friend-event",
      d: {
        openid: "user",
        timestamp: 1784570600,
        scene: 2003,
        scene_param: "campaign_123",
        short_code: "short",
        author: { union_openid: "cross-app-secret" },
        auth_token: "token-secret",
      },
    } as never)!
    expect(out).toMatchObject({
      kind: "system",
      systemKind: "lifecycle",
      referral: { source: "2003", state: "campaign_123" },
      channelData: { friendAdd: { scene: 2003, shortCode: "short" } },
      plainText: "",
      segments: [],
      passiveEvent: { id: "friend-event" },
    })
    expect(out.conversationRef).not.toHaveProperty("msgId")
    expect(out).not.toHaveProperty("deliveryPermissionChange")
    expect(JSON.stringify(out)).not.toMatch(/cross-app-secret|token-secret/)
  })
  it.each(["x".repeat(33), "bad\nstate", { callback_data: "forged" }])(
    "does not expose malformed attribution or reinterpret it as authority: %j",
    (state) => {
      const out = parseQQDispatch(ADAPTER, SELF, {
        op: 0,
        t: "FRIEND_ADD",
        d: {
          openid: "user",
          timestamp: 1784570600,
          scene: 2004,
          scene_param: state,
          short_code: "x".repeat(513),
        },
      } as never)!
      expect(out).toMatchObject({ referral: { source: "2004" } })
      expect(out.referral).not.toHaveProperty("state")
      expect(out.channelData?.friendAdd).not.toHaveProperty("shortCode")
      expect(out).not.toHaveProperty("passiveEvent")
      expect(out).not.toHaveProperty("deliveryPermissionChange")
    }
  )
  it("ignores friend-only attribution fields on other lifecycle events", () => {
    const out = parseQQDispatch(ADAPTER, SELF, {
      op: 0,
      t: "C2C_MSG_RECEIVE",
      id: "event",
      d: { openid: "user", timestamp: 1784570600, scene: 2003, scene_param: "campaign" },
    } as never)!
    expect(out).not.toHaveProperty("referral")
  })
  it("preserves native event authority and consent without fabricating a message or AI turn", () => {
    const time = Math.floor(Date.now() / 1000)
    const out = parseQQDispatch(ADAPTER, SELF, {
      op: 0,
      t: "C2C_MSG_RECEIVE",
      id: "event",
      d: { openid: "user", timestamp: time, auth_token: "secret" },
    } as never)!
    expect(out).toMatchObject({
      kind: "system",
      systemKind: "lifecycle",
      originEventId: "event",
      canReplyToMessage: false,
      deliveryPermissionChange: { proactive: true },
      conversationRef: { scene: "c2c", sceneId: "user", eventId: "event", receivedAt: time * 1000 },
    })
    expect(out.conversationRef).not.toHaveProperty("msgId")
    expect(JSON.stringify(out)).not.toContain("secret")
    const join = parseQQDispatch(ADAPTER, SELF, {
      op: 0,
      t: "GROUP_JOIN_REQUEST",
      id: "join",
      d: {
        group_openid: "group",
        member_openid: "member",
        join_request_id: "request",
        apply_at: new Date().toISOString(),
        auto_approved: { strategy_id: "policy" },
      },
    } as never)!
    expect(join).toMatchObject({
      kind: "system",
      systemKind: "lifecycle",
      channelData: { joinRequest: { id: "request", autoApproved: true } },
    })
    expect(join).not.toHaveProperty("passiveEvent")
    expect(join.conversationRef).not.toHaveProperty("eventId")
  })
  it("preserves ASR and prefers a checked converted WAV source without losing the original", () => {
    const event = parseQQDispatch(
      ADAPTER,
      SELF,
      dispatch("C2C_MESSAGE_CREATE", {
        id: "voice",
        author: { user_openid: "user" },
        attachments: [
          {
            url: "https://gchat.qpic.cn/original.silk",
            content_type: "voice",
            voice_wav_url: "https://gchat.qpic.cn/converted.wav",
            asr_refer_text: "Turn left",
          },
        ],
      } as never)
    )!
    expect(event.segments).toEqual(
      expect.arrayContaining([
        {
          type: "voice",
          url: "https://gchat.qpic.cn/converted.wav",
          rawUrl: "https://gchat.qpic.cn/original.silk",
          mimeType: "audio/wav",
          transcript: "Turn left",
        },
      ])
    )
    expect(event.plainText).toContain("Turn left")
  })
  it("bounds element count and total structured text without deduplicating legitimate repeated content", () => {
    const event = parseQQDispatch(
      ADAPTER,
      SELF,
      dispatch("C2C_MESSAGE_CREATE", {
        id: "bounded",
        author: { user_openid: "user" },
        message_type: 101,
        msg_elements: Array.from({ length: 200 }, () => ({ content: "repeated" })),
      })
    )!
    expect(event.segments.length).toBe(127)
    expect(event.plainText.match(/repeated/g)).toHaveLength(127)
    const large = parseQQDispatch(
      ADAPTER,
      SELF,
      dispatch("C2C_MESSAGE_CREATE", {
        id: "large",
        author: { user_openid: "user" },
        msg_elements: Array.from({ length: 4 }, () => ({ content: "x".repeat(40_000) })),
      })
    )!
    expect(large.plainText.length).toBe(65_536)
  })

  it.each(["GROUP_MESSAGE_CREATE", "C2C_MESSAGE_CREATE"])(
    "separates native quote indexes, passive IDs and quoted content in %s",
    (t) => {
      const event = parseQQDispatch(
        ADAPTER,
        SELF,
        dispatch(t, {
          id: "real-trigger",
          group_openid: "group",
          author: { user_openid: "user" },
          content: "my answer",
          message_type: 103,
          message_scene: {
            source: "default",
            ext: [
              "msg_idx=REFIDX_current==",
              "ref_msg_idx=REFIDX_parent==",
              "auth_token=must-not-persist",
            ],
          },
          msg_elements: [
            {
              msg_idx: "REFIDX_parent==",
              content: "quoted text",
              attachments: [{ url: "https://cdn.example.org/old.png", content_type: "image/png" }],
            },
          ],
        } as never)
      )!
      expect(event.messageId).toBe("real-trigger")
      expect(event.conversationRef).toMatchObject({
        msgId: "real-trigger",
        qqMsgIndex: "REFIDX_current==",
        qqReplyIndex: "REFIDX_parent==",
      })
      expect(event.replyTo).toEqual({
        messageId: "qq-ref:REFIDX_parent%3D%3D",
        snippet: "quoted text\n[image] https://cdn.example.org/old.png",
      })
      expect(event.segments).toEqual([
        {
          type: "reply",
          messageId: "qq-ref:REFIDX_parent%3D%3D",
          snippet: "quoted text\n[image] https://cdn.example.org/old.png",
        },
        { type: "text", text: "my answer" },
      ])
      expect(JSON.stringify(event)).not.toContain("must-not-persist")
      expect(JSON.stringify(event)).not.toContain("auth_token")
      expect(event.replyTo?.parentSenderId).toBeUndefined()
    }
  )

  it("retains nested chat records and safe ARK data without granting quoted/card media to the model", () => {
    const event = parseQQDispatch(
      ADAPTER,
      SELF,
      dispatch("C2C_MESSAGE_CREATE", {
        id: "records",
        author: { user_openid: "user" },
        message_type: 102,
        msg_elements: [
          null,
          { content: "first", msg_elements: [{ content: "first" }] },
          {
            message_type: 3,
            ark_data: {
              ark_type: "miniapp",
              ark_name: "Mini app",
              fields: {
                title: "Title",
                desc: "Description",
                source: "Source",
                jump_url: "https://example.org/open",
                preview: "https://cdn.example.org/card.png",
                auth_token: "secret",
                arbitrary: "not-content",
              },
            },
          },
        ],
      } as never)
    )!
    expect(event.plainText.match(/first/g)).toHaveLength(2)
    expect(event.plainText).toContain("Title")
    expect(event.plainText).toContain("Description")
    expect(event.plainText).toContain("https://example.org/open")
    expect(event.segments.every((segment) => segment.type === "text")).toBe(true)
    expect(JSON.stringify(event)).not.toMatch(/secret|not-content/)
  })

  it("does not guess conflicting scene indexes or crash on malformed/deep structured fields", () => {
    let nested: object = { content: "too deep" }
    for (let i = 0; i < 30; i++) nested = { msg_elements: [nested] }
    const event = parseQQDispatch(
      ADAPTER,
      SELF,
      dispatch("C2C_MESSAGE_CREATE", {
        id: "malformed",
        author: { user_openid: "user" },
        content: "kept",
        message_scene: { ext: [null, "msg_idx=first", "msg_idx=second", "ref_msg_idx="] },
        msg_elements: [null, "invalid", nested, { content: "valid sibling" }],
        ark_data: {
          fields: {
            title: {},
            jump_url: "javascript:alert(1)",
            preview: "https://user:password@example.org/private",
          },
        },
      } as never)
    )!
    expect(event.conversationRef.qqMsgIndex).toBeUndefined()
    expect(event.replyTo).toBeUndefined()
    expect(event.plainText).toContain("valid sibling")
    expect(event.plainText).not.toContain("too deep")
    expect(JSON.stringify(event)).not.toMatch(/javascript:|password/)
  })

  it.each(["GROUP_MESSAGE_CREATE", "MESSAGE_CREATE"])(
    "preserves unmentioned %s messages for storage and applies the normal response policy",
    (t) => {
      const out = parseQQDispatch(
        ADAPTER,
        SELF,
        dispatch(t, {
          id: "full-1",
          group_openid: "GROUP",
          channel_id: "CHANNEL",
          author: { id: "sender", member_openid: "member" },
          content: "<@123> hello someone else",
        })
      )
      expect(out).toMatchObject({
        kind: "create",
        plainText: "<@123> hello someone else",
        mentions: { selfMentioned: false, users: [] },
      })
    }
  )

  it.each(["GROUP_MESSAGE_CREATE", "MESSAGE_CREATE"])(
    "recognizes a verified bot identity in %s mention metadata",
    (t) => {
      const data = {
        id: "full-at",
        group_openid: "GROUP",
        channel_id: "CHANNEL",
        content: "hello",
        mentions: [null, { id: SELF }, { id: "other" }],
      }
      const wire = dispatch(t, data as unknown as QQDispatch["d"])
      expect(parseQQDispatch(ADAPTER, SELF, wire)?.mentions).toEqual({
        selfMentioned: true,
        users: [SELF, "other"],
      })
      expect(parseQQDispatch(ADAPTER, "", wire)?.mentions.selfMentioned).toBe(false)
    }
  )

  it.each(["PUBLIC_MESSAGE_DELETE", "MESSAGE_DELETE", "DIRECT_MESSAGE_DELETE"])(
    "normalizes the official %s recall notification",
    (t) => {
      const event = parseQQDispatch(ADAPTER, SELF, {
        op: 0,
        t,
        d: {
          message: {
            id: "parent",
            channel_id: "channel",
            guild_id: "guild",
            author: { id: "original-author" },
          },
          op_user: { id: "user" },
        },
      })
      expect(event).toMatchObject({
        kind: "delete",
        replacesMessageId: "parent",
        segments: [],
        plainText: "",
        sender: { remoteUserId: "user" },
      })
      expect(event?.conversationKey).toBe(
        `qq-official:${ADAPTER}:${t === "DIRECT_MESSAGE_DELETE" ? "guild" : "channel"}`
      )
    }
  )
  it("contains malformed timestamps without losing valid text", () => {
    expect(
      parseQQDispatch(
        ADAPTER,
        SELF,
        dispatch("C2C_MESSAGE_CREATE", {
          id: "bad-time",
          author: { user_openid: "user" },
          timestamp: { toString: null },
          content: "kept",
        } as never)
      )?.plainText
    ).toBe("kept")
  })
  it("parses a group @ message", () => {
    const out = parseQQDispatch(
      ADAPTER,
      SELF,
      dispatch("GROUP_AT_MESSAGE_CREATE", {
        id: "m1",
        content: "hi bot",
        group_openid: "GROUP_OPENID",
        author: { member_openid: "MEMBER_OPENID" },
        timestamp: "2024-05-05T12:00:00+00:00",
      })
    )
    expect(out).not.toBeNull()
    expect(out!.conversationRef).toMatchObject({
      scene: "group",
      sceneId: "GROUP_OPENID",
      msgId: "m1",
    })
    expect(out!.conversationKey).toBe(`qq-official:${ADAPTER}:GROUP_OPENID`)
    expect(out!.channel.kind).toBe("group")
    expect(out!.sender.remoteUserId).toBe("MEMBER_OPENID")
    expect(out!.mentions.selfMentioned).toBe(true)
    expect(out!.plainText).toBe("hi bot")
  })

  it("parses a C2C private message", () => {
    const out = parseQQDispatch(
      ADAPTER,
      SELF,
      dispatch("C2C_MESSAGE_CREATE", {
        id: "m2",
        content: "private hi",
        author: { user_openid: "USER_OPENID" },
      })
    )
    expect(out!.conversationRef).toMatchObject({ scene: "c2c", sceneId: "USER_OPENID" })
    expect(out!.channel.kind).toBe("private")
  })

  it("parses a guild channel @ message and strips the mention", () => {
    const out = parseQQDispatch(
      ADAPTER,
      SELF,
      dispatch("AT_MESSAGE_CREATE", {
        id: "m3",
        content: "<@!12345> channel hi",
        channel_id: "CHANNEL_1",
        guild_id: "GUILD_1",
        author: { id: "AUTHOR_1", username: "Bob" },
      })
    )
    expect(out!.conversationRef).toMatchObject({ scene: "channel", sceneId: "CHANNEL_1" })
    expect(out!.plainText).toBe("channel hi")
    expect(out!.sender.displayName).toBe("Bob")
  })

  it("parses a direct (dms) message", () => {
    const out = parseQQDispatch(
      ADAPTER,
      SELF,
      dispatch("DIRECT_MESSAGE_CREATE", {
        id: "m4",
        content: "dm hi",
        guild_id: "DMS_GUILD",
        author: { id: "AUTHOR_2" },
      })
    )
    expect(out!.conversationRef).toMatchObject({ scene: "direct", sceneId: "DMS_GUILD" })
    expect(out!.channel.kind).toBe("private")
  })

  it("stamps the local receipt time on the conversationRef for the passive window", () => {
    const before = Date.now()
    const out = parseQQDispatch(
      ADAPTER,
      SELF,
      dispatch("C2C_MESSAGE_CREATE", {
        id: "m-ts",
        content: "hi",
        author: { user_openid: "USER_OPENID" },
      })
    )
    const after = Date.now()
    const receivedAt = out!.conversationRef.receivedAt as number
    expect(receivedAt).toBeGreaterThanOrEqual(before)
    expect(receivedAt).toBeLessThanOrEqual(after)
  })

  it("maps image attachments to image segments with a plainText placeholder", () => {
    const out = parseQQDispatch(
      ADAPTER,
      SELF,
      dispatch("GROUP_AT_MESSAGE_CREATE", {
        id: "m-img",
        content: "",
        group_openid: "GO",
        author: { member_openid: "MO" },
        attachments: [
          {
            url: "gchat.qpic.cn/gchatpic/pic.jpg",
            content_type: "image/jpeg",
            filename: "pic.jpg",
            size: 1234,
            width: 640,
            height: 480,
          },
        ],
      })
    )
    expect(out!.segments).toEqual([
      {
        type: "image",
        url: "https://gchat.qpic.cn/gchatpic/pic.jpg",
        alt: "pic.jpg",
        mimeType: "image/jpeg",
        width: 640,
        height: 480,
      },
    ])
    // An image-only message no longer reaches the AI loop as empty text.
    expect(out!.plainText).toContain("[image]")
  })

  it("maps non-image attachments to file segments and keeps the text segment first", () => {
    const out = parseQQDispatch(
      ADAPTER,
      SELF,
      dispatch("C2C_MESSAGE_CREATE", {
        id: "m-file",
        content: "see attached",
        author: { user_openid: "UO" },
        attachments: [
          {
            url: "https://files.example/doc.pdf",
            content_type: "application/pdf",
            filename: "doc.pdf",
            size: 999,
          },
        ],
      })
    )
    expect(out!.segments).toEqual([
      { type: "text", text: "see attached" },
      {
        type: "file",
        url: "https://files.example/doc.pdf",
        name: "doc.pdf",
        mimeType: "application/pdf",
        sizeBytes: 999,
      },
    ])
    expect(out!.plainText).toContain("[file:doc.pdf]")
  })

  it("skips attachments without a url and defaults missing file metadata", () => {
    const out = parseQQDispatch(
      ADAPTER,
      SELF,
      dispatch("GROUP_AT_MESSAGE_CREATE", {
        id: "m-att",
        content: "",
        group_openid: "GO",
        attachments: [{ content_type: "image/png" }, { url: "cdn.example/blob" }],
      })
    )
    expect(out!.segments).toEqual([
      {
        type: "file",
        url: "https://cdn.example/blob",
        name: "attachment",
        mimeType: "application/octet-stream",
        sizeBytes: 0,
      },
    ])
  })

  it("returns null for unknown events or missing ids", () => {
    expect(parseQQDispatch(ADAPTER, SELF, dispatch("READY", { id: "x" }))).toBeNull()
    expect(
      parseQQDispatch(ADAPTER, SELF, dispatch("GROUP_AT_MESSAGE_CREATE", { content: "no id" }))
    ).toBeNull()
    expect(
      parseQQDispatch(ADAPTER, SELF, dispatch("GROUP_AT_MESSAGE_CREATE", { id: "m", content: "x" }))
    ).toBeNull() // missing group_openid
  })
})
it("preserves official voice/video attachments and message references", () => {
  const out = parseQQDispatch(
    ADAPTER,
    SELF,
    dispatch("C2C_MESSAGE_CREATE", {
      id: "m1",
      author: { user_openid: "u" },
      content: "reply",
      message_reference: { message_id: "previous" },
      attachments: [
        null,
        { url: "//cdn.example/voice", content_type: "voice" },
        { url: "cdn.example/video", content_type: "video/mp4" },
        { url: "javascript:alert(1)", content_type: "image/png" },
      ],
    } as unknown as NonNullable<QQDispatch["d"]>)
  )
  expect(out?.segments).toEqual([
    { type: "reply", messageId: "previous", snippet: "" },
    { type: "text", text: "reply" },
    { type: "voice", url: "https://cdn.example/voice", mimeType: undefined },
    { type: "video", url: "https://cdn.example/video", mimeType: "video/mp4" },
  ])
  expect(out?.replyTo).toEqual({ messageId: "previous", snippet: "" })
})

it.each(["AT_MESSAGE_CREATE", "DIRECT_MESSAGE_CREATE"])(
  "preserves actual author avatar for %s",
  (event) => {
    const url = "https://qqchannel-profile-1251316161.file.myqcloud.com/profile.png"
    const result = parseQQDispatch(
      ADAPTER,
      SELF,
      dispatch(event, {
        id: "portrait",
        channel_id: "channel",
        guild_id: "guild",
        content: "hello",
        author: { id: "opaque-user", avatar: url },
      })
    )
    expect(result?.sender).toMatchObject({
      remoteUserId: "opaque-user",
      remoteIdType: "channel_user",
      avatarUrl: url,
    })
  }
)

it("does not promote arbitrary group message fields or ARK content into an author portrait", () => {
  const result = parseQQDispatch(
    ADAPTER,
    SELF,
    dispatch("GROUP_AT_MESSAGE_CREATE", {
      id: "group",
      group_openid: "group-openid",
      content: "kept",
      author: { member_openid: "opaque", avatar: "https://q1.qlogo.cn/arbitrary" },
    })
  )
  expect(result?.sender.avatarUrl).toBeUndefined()
  expect(result?.sender.remoteIdType).toBe("group_openid")
})
it("normalizes messages without loading the media enrichment runtime", () => {
  try {
    jest.isolateModules(() => {
      jest.doMock("../_shared/inbound-media", () => {
        throw new Error("pure parser loaded media runtime")
      })
      const { parseQQDispatch } = jest.requireActual("./parse")
      expect(
        parseQQDispatch("qq-test", "bot", {
          op: 0,
          t: "C2C_MESSAGE_CREATE",
          d: { id: "message", content: "test", author: { user_openid: "user" } },
        })
      ).toMatchObject({ plainText: "test" })
    })
  } finally {
    jest.dontMock("../_shared/inbound-media")
  }
})

import test from "node:test"
import assert from "node:assert/strict"
import { createDriver } from "./index.mjs"
import { withFakePlatform } from "./fake-platform.mjs"

const values = {
  bearerToken: "official-observer-test-token",
  targetConversationId: "987654",
  targetBotUin: "123456",
  driverUserUin: "654321",
  conversationKind: "group",
}
const item = (id, user, text, segments = [], extra = {}) => ({
  message_id: id,
  user_id: user,
  time: 1700000001,
  message: [...segments, { type: "text", data: { text } }],
  ...extra,
})
const ok = (data) => ({ json: { status: "ok", retcode: 0, data } })
const routes = (history = () => []) => ({
  "POST /get_login_info": () => ok({ user_id: 654321 }),
  "POST /get_group_msg_history": () => ok({ messages: history() }),
  "POST /get_friend_msg_history": () => ok({ messages: history() }),
})
const driverFor = (baseUrl, overrides = {}, options = {}) =>
  createDriver("qq-official", {
    values: { ...values, apiBase: baseUrl, ...overrides },
    now: () => 1700000000000,
    ...options,
  })

test("Official observer authenticates as the human and retains a distinct platform", async () => {
  await withFakePlatform(routes(), async ({ baseUrl, callsTo }) => {
    const driver = driverFor(baseUrl)
    assert.equal(driver.platform, "qq-official")
    assert.equal(driver.acceptanceScope.kind, "client-visible-text-smoke")
    assert.ok(driver.acceptanceScope.excludes.includes("stream-completion"))
    assert.ok(driver.acceptanceScope.excludes.includes("official-app-identity-mapping"))
    assert.equal(driver.conversationId, "group:987654")
    assert.ok((await driver.doctor()).every((c) => c.ok))
    assert.equal(
      callsTo("POST /get_login_info")[0].headers.authorization,
      "Bearer official-observer-test-token"
    )
    const lease = await driver.prepare()
    assert.equal(lease.platform, "qq-official")
    assert.equal(lease.conversationId, driver.conversationId)
  })
})

test("Official observer rejects the bot account and never uses it as the human", async () => {
  await withFakePlatform(
    { ...routes(), "POST /get_login_info": () => ok({ user_id: 123456 }) },
    async ({ baseUrl }) => {
      assert.ok((await driverFor(baseUrl).doctor()).some((c) => !c.ok))
      assert.throws(() => driverFor(baseUrl, { driverUserUin: "123456" }), /human.*differ/i)
    }
  )
})

test("Official group verifies mention then quote with mention without API sends", async () => {
  let messages = []
  const prompts = []
  await withFakePlatform(
    routes(() => messages),
    async ({ baseUrl, calls }) => {
      const driver = driverFor(
        baseUrl,
        {},
        {
          log: (prompt) => {
            prompts.push(prompt)
            messages.push(
              item(prompts.length * 2 - 1, 654321, `marker${prompts.length}`, [
                { type: "at", data: { qq: "123456" } },
                ...(prompts.length === 2 ? [{ type: "reply", data: { id: "2" } }] : []),
              ]),
              item(prompts.length * 2, 123456, `marker${prompts.length}`)
            )
          },
        }
      )
      const lease = await driver.prepare()
      const first = await driver.injectMention(lease, "marker1")
      assert.equal(first.action, "group-mention")
      const replies = await driver.pollTargetMessages(lease)
      const second = await driver.replyToTarget(lease, replies[0], "marker2")
      assert.equal(second.messageId, "3")
      assert.equal(second.action, "group-quote-with-mention")
      assert.match(prompts[1], /@123456/)
      assert.deepEqual(
        (await driver.pollTargetMessages(lease)).map((m) => m.messageId),
        ["4"]
      )
      assert.ok((await driver.cleanup(lease)).skipped)
      assert.ok(calls.every((c) => !/send_|delete_/.test(c.pathname)))
    }
  )
})

test("Official group quote without a real mention cannot satisfy an addressed probe", async () => {
  let messages = []
  let clock = 1700000000000
  await withFakePlatform(
    routes(() => messages),
    async ({ baseUrl }) => {
      const driver = driverFor(
        baseUrl,
        {},
        {
          humanTimeoutMs: 1,
          now: () => clock++,
          sleepImpl: async () => {},
          log: () => {
            messages = [item(3, 654321, "marker", [{ type: "reply", data: { id: "2" } }])]
          },
        }
      )
      const lease = await driver.prepare()
      await assert.rejects(driver.replyToTarget(lease, { messageId: "2" }, "marker"), /timed out/)
    }
  )
})

test("Official C2C uses the human observer's peer history and does not require @", async () => {
  let messages = []
  let turn = 0
  await withFakePlatform(
    routes(() => messages),
    async ({ baseUrl, callsTo, calls }) => {
      const driver = driverFor(
        baseUrl,
        {
          conversationKind: "c2c",
          targetConversationId: "123456",
        },
        {
          log: () => {
            ++turn
            messages.push(
              item(
                turn * 2 - 1,
                654321,
                `marker${turn}`,
                turn === 2 ? [{ type: "reply", data: { id: "2" } }] : []
              ),
              item(turn * 2, 123456, `marker${turn}`)
            )
          },
        }
      )
      assert.equal(driver.conversationId, "c2c:123456")
      assert.ok((await driver.doctor()).every((c) => c.ok))
      const lease = await driver.prepare()
      assert.equal((await driver.injectMention(lease, "marker1")).action, "c2c-text")
      const [reply] = await driver.pollTargetMessages(lease)
      assert.equal((await driver.replyToTarget(lease, reply, "marker2")).action, "c2c-quote")
      assert.equal((await driver.pollTargetMessages(lease))[0].messageId, "4")
      assert.equal(callsTo("POST /get_group_msg_history").length, 0)
      assert.equal(callsTo("POST /get_friend_msg_history")[0].body.user_id, "123456")
      assert.ok(calls.every((c) => !/send_|delete_/.test(c.pathname)))
    }
  )
})

test("Official C2C rejects a peer that differs from the configured target", () => {
  assert.throws(
    () =>
      driverFor("http://127.0.0.1:1", {
        conversationKind: "c2c",
        targetConversationId: "555555",
      }),
    /peer.*target/i
  )
  assert.throws(() => driverFor("http://127.0.0.1:1", { conversationKind: "guild" }), /group.*c2c/)
})

test("unavailable C2C history fails doctor rather than passing a group fallback", async () => {
  await withFakePlatform(
    {
      ...routes(),
      "POST /get_friend_msg_history": () => ({ json: { status: "failed", retcode: 1404 } }),
    },
    async ({ baseUrl, callsTo }) => {
      const checks = await driverFor(baseUrl, {
        conversationKind: "c2c",
        targetConversationId: "123456",
      }).doctor()
      assert.ok(checks.some((c) => !c.ok))
      assert.equal(callsTo("POST /get_group_msg_history").length, 0)
    }
  )
})

test("Official observer rejects malformed identity and cross-conversation history", async () => {
  for (const bad of [
    item(1, undefined, "reply"),
    item(1, 123456, "reply", [], { group_id: "other-group" }),
    item("", 123456, "reply"),
    item("not-a-message-id", 123456, "reply"),
    item(0, 123456, "reply"),
    item(1, 123456, "reply", [], { time: null }),
    item(1, 123456, "reply", [], { time: 1700000000000 }),
  ]) {
    await withFakePlatform(
      routes(() => [bad]),
      async ({ baseUrl }) => {
        await assert.rejects(driverFor(baseUrl).prepare(), /history|conversation/)
      }
    )
  }
})

test("Official C2C rejects explicit history for a different peer", async () => {
  for (const extra of [
    { peer_id: "999999" },
    { target_id: "999999" },
    { peer_id: "123456", user_id: 999999 },
  ]) {
    await withFakePlatform(
      routes(() => [item(1, 654321, "marker", [], extra)]),
      async ({ baseUrl }) => {
        await assert.rejects(
          driverFor(baseUrl, { conversationKind: "c2c", targetConversationId: "123456" }).prepare(),
          /conversation|peer/
        )
      }
    )
  }
})

test("Official observer rejects contradictory sender, recipient and message metadata", async () => {
  for (const extra of [
    { target_id: "654321" },
    { self_id: "999999" },
    { message_type: "group" },
    { sender: { user_id: "999999" } },
    { post_type: "notice" },
  ]) {
    await withFakePlatform(
      routes(() => [item(-12, 654321, "marker", [], extra)]),
      async ({ baseUrl }) => {
        await assert.rejects(
          driverFor(baseUrl, { conversationKind: "c2c", targetConversationId: "123456" }).prepare(),
          /conversation|sender|identity|type/
        )
      }
    )
  }
})

test("Official C2C retains valid negative client message IDs", async () => {
  let messages = []
  await withFakePlatform(
    routes(() => messages),
    async ({ baseUrl }) => {
      const driver = driverFor(
        baseUrl,
        { conversationKind: "c2c", targetConversationId: "123456" },
        {
          log: () => {
            messages = [
              item(-12, 654321, "marker", [], {
                target_id: "123456",
                self_id: "654321",
                message_type: "private",
                post_type: "message_sent",
              }),
            ]
          },
        }
      )
      const lease = await driver.prepare()
      assert.equal((await driver.injectMention(lease, "marker")).messageId, "-12")
    }
  )
})

test("Official identity cannot be configured as a missing-value string", () => {
  assert.throws(() => driverFor("http://127.0.0.1:1", { driverUserUin: "undefined" }), /UIN/)
})

test("C2C pagination refuses ambiguous same-second boundaries instead of comparing sender-local sequences", async () => {
  let messages = []
  await withFakePlatform(
    routes(() => messages),
    async ({ baseUrl }) => {
      const driver = driverFor(baseUrl, { conversationKind: "c2c", targetConversationId: "123456" })
      const lease = await driver.prepare()
      messages = Array.from({ length: 100 }, (_, i) =>
        item(i + 1, i % 2 ? 123456 : 654321, "reply", [], { real_seq: String(100 - i) })
      )
      await assert.rejects(driver.pollTargetMessages(lease), /ambiguous same-second boundary/)
      assert.equal(lease.seen.size, 0)
    }
  )
})

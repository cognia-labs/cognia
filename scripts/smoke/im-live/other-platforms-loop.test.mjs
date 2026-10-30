// Compose the existing live CLI with real HTTP, model fixture and report files.
// Platform APIs and the responding target are stand-ins, not provider evidence.
import test from "node:test"
import assert from "node:assert/strict"
import { createRequire } from "node:module"
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"

import { main } from "./index.mjs"
import { STATUS } from "./diagnose.mjs"
import { withFakePlatform } from "./drivers/fake-platform.mjs"
import { snowflakeForTime } from "./drivers/discord.mjs"

globalThis.require ??= createRequire(import.meta.url)
const { createMockAnthropicServer } = await import("../../../tests/e2e/mocks/anthropic/server.ts")
const SECRET = "other-im-synthetic-secret"
const CONTROL = "other-im-control-token"
const EVIDENCE = path.resolve(".cache/test-results/im-observers")

function wirePlatform(platform, respond, behaviour) {
  const messages = []
  const probes = []
  let sequence = 0
  const denied = behaviour === "doctor-denied"
  const cleanupDenied = behaviour === "cleanup-denied"
  const failure = (json) => ({ status: 403, json })
  const page = (items, cursor, key, tokenKey) => {
    if (cursor) return { [key]: items.slice(1) }
    return { [key]: items.slice(0, 1), ...(items.length > 1 ? { [tokenKey]: "next" } : {}) }
  }

  if (platform === "slack") {
    const channel = "C0OTHERQA",
      target = "U0TARGET",
      user = "U0DRIVER"
    let timestamp = 0n
    const nextTs = () => {
      const clock = BigInt(Date.now()) * 1000n
      timestamp = clock > timestamp ? clock : timestamp + 1n
      return `${timestamp / 1_000_000n}.${String(timestamp % 1_000_000n).padStart(6, "0")}`
    }
    const paged = (items, cursor) => {
      const result = page(items, cursor, "messages", "next")
      return {
        ok: true,
        messages: result.messages,
        ...(result.next ? { has_more: true, response_metadata: { next_cursor: result.next } } : {}),
      }
    }
    return {
      messages,
      probes,
      env: {
        IM_LIVE_SLACK_DRIVER_USER_TOKEN: SECRET,
        IM_LIVE_SLACK_TARGET_CHANNEL_ID: channel,
        IM_LIVE_SLACK_TARGET_BOT_USER_ID: target,
      },
      baseKey: "IM_LIVE_SLACK_API_BASE",
      routes: {
        "POST /auth.test": () => ({
          json: { ok: true, user_id: user, user: "driver", team: "QA" },
        }),
        "POST /conversations.info": () => ({
          json: { ok: true, channel: { id: channel, is_member: !denied } },
        }),
        "POST /chat.postMessage": ({ body }) => {
          const ts = nextTs()
          probes.push({ id: ts, body })
          messages.push({ ts, user, text: body.text, thread_ts: body.thread_ts })
          respond(body.text, (text) =>
            messages.push({
              ts: nextTs(),
              user: target,
              bot_id: "B0TARGET",
              text,
              thread_ts: body.thread_ts ?? ts,
            })
          )
          return { json: { ok: true, ts } }
        },
        "POST /conversations.history": ({ body }) => ({
          json: paged(
            messages.filter((m) => !m.thread_ts && Number(m.ts) > Number(body.oldest)),
            body.cursor
          ),
        }),
        "POST /conversations.replies": ({ body }) => ({
          json: paged(
            messages.filter((m) => m.ts === body.ts || m.thread_ts === body.ts),
            body.cursor
          ),
        }),
        "POST /chat.delete": ({ body }) => ({
          json:
            cleanupDenied && messages.some((m) => m.ts === body.ts && m.user === target)
              ? { ok: false, error: `cant_delete_message ${SECRET}` }
              : { ok: true },
        }),
      },
      verify(calls) {
        for (const call of calls.filter((call) => call.pathname !== "/auth.test")) {
          assert.equal(call.body.channel, channel, `wrong Slack conversation for ${call.pathname}`)
        }
        assert.equal(probes[0].body.text.startsWith(`<@${target}> `), true)
        assert.equal(probes[1].body.thread_ts, probes[0].id)
        assert.ok(!probes[1].body.text.includes(`<@${target}>`))
      },
    }
  }

  if (platform === "discord") {
    const channel = "1100000000000000001",
      target = "1200000000000000002"
    const nextId = () => (BigInt(snowflakeForTime(Date.now())) + BigInt(++sequence)).toString()
    return {
      messages,
      probes,
      env: {
        IM_LIVE_DISCORD_DRIVER_BOT_TOKEN: SECRET,
        IM_LIVE_DISCORD_TARGET_CHANNEL_ID: channel,
        IM_LIVE_DISCORD_TARGET_BOT_USER_ID: target,
      },
      baseKey: "IM_LIVE_DISCORD_API_BASE",
      routes: {
        "GET /users/@me": () => ({ json: { id: "1300000000000000003", username: "driver" } }),
        [`GET /channels/${channel}`]: () =>
          denied
            ? failure({ message: `Missing Access ${SECRET}` })
            : { json: { id: channel, type: 0 } },
        [`GET /channels/${channel}/messages`]: ({ query }) => ({
          json: messages
            .filter((m) => !query.after || BigInt(m.id) > BigInt(query.after))
            .slice()
            .reverse()
            .slice(0, Number(query.limit)),
        }),
        [`POST /channels/${channel}/messages`]: ({ body }) => {
          const sent = {
            id: nextId(),
            content: body.content,
            timestamp: new Date().toISOString(),
            author: { id: "1300000000000000003" },
          }
          probes.push({ id: sent.id, body })
          messages.push(sent)
          respond(body.content, (text) =>
            messages.push({
              id: nextId(),
              author: { id: target, bot: true },
              content: text,
              timestamp: new Date().toISOString(),
              message_reference: { message_id: sent.id },
            })
          )
          return { json: sent }
        },
        [`DELETE /channels/${channel}/messages/:id`]: ({ params }) =>
          cleanupDenied && messages.some((m) => m.id === params.id && m.author.id === target)
            ? failure({ message: `Missing Permissions ${SECRET}` })
            : { status: 204 },
      },
      verify() {
        assert.ok(probes[0].body.content.startsWith(`<@${target}> `))
        const firstReply = messages.find((m) => m.author.id === target)
        assert.equal(probes[1].body.message_reference.message_id, firstReply.id)
        assert.equal(probes[1].body.message_reference.channel_id, channel)
        assert.ok(!probes[1].body.content.includes(`<@${target}>`))
      },
    }
  }

  if (platform === "lark") {
    const chat = "oc_otherqa",
      target = "ou_target",
      app = "cli_target",
      thread = "omt_qa"
    return {
      messages,
      probes,
      env: {
        IM_LIVE_LARK_DRIVER_APP_ID: "cli_driver",
        IM_LIVE_LARK_DRIVER_APP_SECRET: SECRET,
        IM_LIVE_LARK_TARGET_CHAT_ID: chat,
        IM_LIVE_LARK_TARGET_BOT_OPEN_ID: target,
        IM_LIVE_LARK_TARGET_APP_ID: app,
      },
      baseKey: "IM_LIVE_LARK_API_BASE",
      routes: {
        "POST /auth/v3/tenant_access_token/internal": () => ({
          json: { code: 0, tenant_access_token: "synthetic-tenant-token" },
        }),
        "GET /bot/v3/info": () => ({ json: { code: 0, bot: { open_id: "ou_driver" } } }),
        [`GET /im/v1/chats/${chat}`]: () => ({ json: { code: 0, data: { name: "QA" } } }),
        "GET /im/v1/messages": ({ query }) => {
          if (denied) return { json: { code: 99991672, msg: `history forbidden ${SECRET}` } }
          const items = query.container_id_type === "thread" ? messages : []
          const result = page(items, query.page_token, "items", "page_token")
          return {
            json: {
              code: 0,
              data: { ...result, ...(result.page_token ? { has_more: true } : {}) },
            },
          }
        },
        "POST /im/v1/messages": ({ body }) => send(body),
        "POST /im/v1/messages/:id/reply": ({ body, params }) => send(body, params.id),
        "DELETE /im/v1/messages/:id": ({ params }) => ({
          json:
            cleanupDenied && messages.some((m) => m.message_id === params.id)
              ? { code: 230002, msg: `no permission ${SECRET}` }
              : { code: 0 },
        }),
      },
      verify(calls) {
        assert.equal(probes[0].body.receive_id, chat)
        assert.ok(probes.every((probe) => probe.body.msg_type === "text"))
        assert.equal(
          calls.find((call) => call.key === "POST /im/v1/messages").query.receive_id_type,
          "chat_id"
        )
        assert.ok(
          JSON.parse(probes[0].body.content).text.startsWith(`<at user_id="${target}"></at>`)
        )
        assert.equal(probes[1].replyTo, messages[0].message_id)
        assert.ok(!JSON.parse(probes[1].body.content).text.includes("<at"))
        assert.notEqual(probes[0].body.uuid, probes[1].body.uuid)
      },
    }
    function send(body, replyTo) {
      const sent = {
        message_id: `om_probe${++sequence}`,
        create_time: String(Date.now()),
        thread_id: thread,
      }
      probes.push({ id: sent.message_id, body, replyTo })
      respond(JSON.parse(body.content).text, (text) =>
        messages.push({
          message_id: `om_reply${++sequence}`,
          create_time: String(Date.now()),
          thread_id: thread,
          sender: { id: app, sender_type: "app", id_type: "app_id" },
          body: { content: JSON.stringify({ text }) },
        })
      )
      return { json: { code: 0, data: sent } }
    }
  }

  const room = "!qa:example.test",
    target = "@target:example.test",
    v3 = "/_matrix/client/v3",
    roomPath = encodeURIComponent(room)
  return {
    messages,
    probes,
    env: {
      IM_LIVE_MATRIX_DRIVER_ACCESS_TOKEN: SECRET,
      IM_LIVE_MATRIX_TARGET_ROOM_ID: room,
      IM_LIVE_MATRIX_TARGET_USER_ID: target,
    },
    baseKey: "IM_LIVE_MATRIX_HOMESERVER",
    routes: {
      [`GET ${v3}/account/whoami`]: () => ({ json: { user_id: "@driver:example.test" } }),
      [`GET ${v3}/joined_rooms`]: () => ({ json: { joined_rooms: denied ? [] : [room] } }),
      [`GET ${v3}/rooms/${roomPath}/state/m.room.encryption`]: () => ({
        status: 404,
        json: { errcode: "M_NOT_FOUND" },
      }),
      [`PUT ${v3}/rooms/${roomPath}/send/m.room.message/:txn`]: ({ body }) => {
        const id = `$probe${++sequence}`
        probes.push({ id, body })
        respond(body.body, (text) =>
          messages.push({
            type: "m.room.message",
            event_id: `$reply${++sequence}`,
            room_id: room,
            sender: target,
            origin_server_ts: Date.now(),
            content: {
              msgtype: "m.text",
              body: text,
              "m.relates_to": { "m.in_reply_to": { event_id: id } },
            },
          })
        )
        return { json: { event_id: id } }
      },
      [`GET ${v3}/rooms/${roomPath}/messages`]: ({ query }) => ({
        json: page(messages.slice().reverse(), query.from, "chunk", "end"),
      }),
      [`PUT ${v3}/rooms/${roomPath}/redact/:id/:txn`]: ({ params }) =>
        cleanupDenied && messages.some((m) => m.event_id === params.id)
          ? failure({ errcode: "M_FORBIDDEN", error: `cannot redact ${SECRET}` })
          : { json: { event_id: `$redact${++sequence}` } },
    },
    verify() {
      assert.deepEqual(probes[0].body["m.mentions"], { user_ids: [target] })
      assert.deepEqual(probes[1].body["m.mentions"], { user_ids: [] })
      assert.equal(probes[1].body["m.relates_to"]["m.in_reply_to"].event_id, messages[0].event_id)
    },
  }
}

async function runLoop(platform, behaviour) {
  mkdirSync(EVIDENCE, { recursive: true })
  const outputDir = mkdtempSync(path.resolve(".cache/im-other-loop-"))
  const previous = process.env.E2E_ANTHROPIC_CONTROL_TOKEN
  process.env.E2E_ANTHROPIC_CONTROL_TOKEN = CONTROL
  const fixture = createMockAnthropicServer()
  const pending = [],
    failures = []
  const respond = (text, post) => {
    if (behaviour === "bypass-model") {
      post(`bypassed ${text}`)
      return
    }
    pending.push(
      (async () => {
        const response = await fetch(`${fixture.baseUrl}/v1/messages`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: "claude-opus-5",
            max_tokens: 64,
            messages: [{ role: "user", content: [{ type: "text", text }] }],
          }),
        })
        assert.equal(response.status, 200)
        const answer = (await response.json()).content[0].text
        post(answer)
        if (behaviour === "duplicate" && text.includes(":turn-2")) post(answer)
      })().catch((error) => failures.push(error))
    )
  }
  const wire = wirePlatform(platform, respond, behaviour)
  await fixture.start(0)
  try {
    return await withFakePlatform(wire.routes, async ({ baseUrl, calls }) => {
      const errors = []
      const exitCode = await main({
        argv: ["--platform", platform],
        env: {
          ...wire.env,
          [wire.baseKey]: baseUrl,
          IM_LIVE_OUTPUT_DIR: outputDir,
          IM_LIVE_FIXTURE_URL: fixture.baseUrl,
          IM_LIVE_FIXTURE_TOKEN: CONTROL,
          IM_LIVE_TURN_TIMEOUT_MS: behaviour === "bypass-model" ? "300" : "10000",
          IM_LIVE_DUPLICATE_WINDOW_MS: "20",
        },
        loadEnv: () => ({ loaded: false }),
        log: () => {},
        logError: (text) => errors.push(text),
      })
      await Promise.all(pending)
      assert.deepEqual(failures, [])
      const runDir = readdirSync(outputDir).find((entry) => /^[0-9a-f]{16}$/.test(entry))
      assert.ok(runDir, errors.join("\n"))
      const serialized = readFileSync(path.join(outputDir, runDir, `${platform}.json`), "utf8")
      const report = JSON.parse(serialized)
      writeFileSync(
        path.join(EVIDENCE, `${platform}-${behaviour}.json`),
        JSON.stringify(
          {
            evidenceKind: "im-live-harness-integration",
            platformAndTarget: "local-stand-ins",
            scenario: behaviour,
            report,
          },
          null,
          2
        ) + "\n"
      )
      assert.ok(
        !serialized.includes(SECRET),
        "credentials must not reach evidence even in failures"
      )
      assert.ok(!serialized.includes(CONTROL))
      assert.ok(!serialized.includes("mock-anthropic-echo"), "reply bodies must not reach evidence")
      assert.deepEqual(readdirSync(path.join(outputDir, ".locks")), [])
      return { exitCode, report, calls, wire, errors }
    })
  } finally {
    await Promise.all(pending)
    await fixture.stop()
    rmSync(outputDir, { recursive: true, force: true })
    if (previous === undefined) delete process.env.E2E_ANTHROPIC_CONTROL_TOKEN
    else process.env.E2E_ANTHROPIC_CONTROL_TOKEN = previous
  }
}

for (const platform of ["lark", "slack", "discord", "matrix"]) {
  test(`${platform} CLI composes mention, pure reply, model correlation and report cleanup`, async () => {
    const { exitCode, report, wire, calls, errors } = await runLoop(platform, "normal")
    assert.equal(exitCode, 0, errors.join("\n"))
    assert.equal(report.status, STATUS.PASS)
    assert.equal(wire.probes.length, 2)
    assert.equal(report.turns.length, 2)
    for (const turn of report.turns) {
      assert.equal(turn.modelRequestCount, 1)
      assert.equal(turn.matchingModelRequestCount, 1)
      assert.equal(turn.markerReplyCount, 1)
      assert.equal(turn.extraReplyCount, 0)
      assert.ok(turn.replies.every((reply) => reply.matchedMarker))
    }
    wire.verify(calls)
    assert.equal(report.cleanup.ok, true)
    assertCleanup({ platform, wire, report, calls })
  })

  test(`${platform} CLI catches a duplicate in the second reply, including later history pages`, async () => {
    const { exitCode, report, wire, calls } = await runLoop(platform, "duplicate")
    assert.equal(exitCode, 1)
    assert.equal(report.status, STATUS.FAIL)
    assert.equal(wire.probes.length, 2)
    assert.equal(report.turns.length, 2)
    assert.equal(report.turns[0].status, STATUS.PASS)
    assert.equal(report.turns[1].markerReplyCount, 2)
    assert.equal(report.turns[1].modelRequestCount, 1)
    wire.verify(calls)
  })

  test(`${platform} CLI rejects a marker reply that never reached the model`, async () => {
    const { exitCode, report } = await runLoop(platform, "bypass-model")
    assert.equal(exitCode, 1)
    assert.equal(report.status, STATUS.MODEL_NOT_INTERCEPTED)
    assert.equal(report.turns[0].fixture.hit, false)
    assert.equal(report.turns[0].markerReplyCount, 1)
    assert.equal(report.turns[0].modelRequestCount, 0)
  })

  test(`${platform} CLI rejects doctor permission failures before sending a probe`, async () => {
    const { exitCode, report, wire } = await runLoop(platform, "doctor-denied")
    assert.equal(exitCode, 1)
    assert.equal(report.status, STATUS.DOCTOR_FAILED)
    assert.deepEqual(report.turns, [])
    assert.deepEqual(wire.probes, [])
  })

  test(`${platform} CLI preserves cleanup refusals in evidence after successful turns`, async () => {
    const { exitCode, report, wire, calls } = await runLoop(platform, "cleanup-denied")
    assert.equal(exitCode, 0)
    assert.equal(report.status, STATUS.PASS)
    assert.equal(report.cleanup.ok, false)
    assert.equal(report.cleanup.deleted.length, 2)
    assert.equal(report.cleanup.retained.length, 2)
    assertCleanup({ platform, wire, report, calls, denied: true })
    assert.ok(
      report.cleanup.retained.every((item) => item.id && item.reason.includes(`«${platform}.`))
    )
  })
}

function assertCleanup({ platform, wire, report, calls, denied = false }) {
  const probeIds = wire.probes.map((probe) => probe.id)
  const createdIds = [
    ...new Set([
      ...probeIds,
      ...wire.messages.map(
        (message) => message.ts ?? message.id ?? message.message_id ?? message.event_id
      ),
    ]),
  ].sort()
  const attemptedIds = calls.flatMap((call) => {
    if (platform === "slack" && call.pathname === "/chat.delete") return [call.body.ts]
    if (call.method === "DELETE") return [decodeURIComponent(call.pathname.split("/").at(-1))]
    if (platform === "matrix" && call.pathname.includes("/redact/"))
      return [decodeURIComponent(call.pathname.split("/redact/")[1].split("/")[0])]
    return []
  })
  assert.deepEqual(
    attemptedIds.sort(),
    createdIds,
    "cleanup must address every actual created ID exactly once"
  )
  assert.deepEqual(report.cleanup.deleted.slice().sort(), denied ? probeIds.sort() : createdIds)
  assert.deepEqual(
    report.cleanup.retained.map((item) => item.id).sort(),
    denied ? createdIds.filter((id) => !probeIds.includes(id)) : []
  )
}

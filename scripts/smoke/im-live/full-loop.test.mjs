// The whole harness composed, with only the IM platform faked.
//
// Every other suite proves one piece. This one runs the real CLI over the real
// config, lock, driver, fixture client, diagnostic table and report writer, and
// the REAL model fixture — against a local server that plays both Telegram and
// the target bot. The stand-in bot behaves the way Cognia does: it calls the
// model, then posts what the model said. That makes the two failure modes the
// harness exists to catch reproducible on demand — a bot that answers WITHOUT
// consulting the model, and one that answers twice.

import test from "node:test"
import assert from "node:assert/strict"
import { createRequire } from "node:module"
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

globalThis.require ??= createRequire(import.meta.url)
const { createMockAnthropicServer } = await import("../../../tests/e2e/mocks/anthropic/server.ts")

import { STATUS } from "./diagnose.mjs"
import { main } from "./index.mjs"
import { withFakePlatform } from "./drivers/fake-platform.mjs"

const TOKEN = "8123456789:AAH1zQxYbCdEfGhIjKlMnOpQrStUvWxYz01"
const CHAT = "-1001234567890"
const scratch = () => mkdtempSync(path.join(tmpdir(), "cognia-im-loop-"))

/**
 * A Telegram-shaped server whose target bot answers by asking the model.
 *
 * `behaviour`:
 *   "normal"        — one reply per probe, produced from the fixture's answer
 *   "bypass-model"  — replies without ever calling the model
 *   "duplicate"     — calls the model once, replies twice
 *   "silent"        — never replies
 */
function telegramWithBot(fixtureBaseUrl, behaviour = "normal") {
  const updates = []
  let updateId = 1000
  let messageId = 500
  const ok = (result) => ({ json: { ok: true, result } })

  async function askModel(text) {
    const response = await fetch(`${fixtureBaseUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-opus-5",
        max_tokens: 64,
        messages: [{ role: "user", content: [{ type: "text", text }] }],
      }),
    })
    const body = await response.json()
    return body.content?.[0]?.text ?? ""
  }

  function postAsBot(text) {
    updates.push({
      update_id: ++updateId,
      message: {
        message_id: ++messageId,
        date: 1700,
        chat: { id: Number(CHAT) },
        from: { id: 222, is_bot: true, username: "cognia_target_bot" },
        text,
      },
    })
  }

  return {
    [`POST /bot${TOKEN}/getMe`]: () =>
      ok({
        id: 111,
        is_bot: true,
        username: "cognia_driver_bot",
        can_read_all_group_messages: true,
      }),
    [`POST /bot${TOKEN}/getWebhookInfo`]: () => ok({ url: "" }),
    [`POST /bot${TOKEN}/getChat`]: () => ok({ id: Number(CHAT), type: "supergroup", title: "QA" }),
    [`POST /bot${TOKEN}/getUpdates`]: ({ body }) => {
      const offset = Number(body.offset ?? 0)
      if (offset === -1) return ok(updates.slice(-1))
      return ok(updates.filter((u) => u.update_id >= offset))
    },
    [`POST /bot${TOKEN}/deleteMessage`]: () => ok(true),
    [`POST /bot${TOKEN}/sendMessage`]: ({ body }) => {
      const probeId = ++messageId
      if (behaviour !== "silent") {
        // The bot reacts asynchronously, exactly as a real one would.
        void (async () => {
          if (behaviour === "bypass-model") {
            postAsBot("Sure, happy to help!")
            return
          }
          const answer = await askModel(body.text)
          postAsBot(answer)
          if (behaviour === "duplicate") postAsBot(answer)
        })()
      }
      return ok({ message_id: probeId, date: 1700, chat: { id: Number(CHAT) }, text: body.text })
    },
  }
}

/** Boot the real fixture, then run the real CLI against the fake platform. */
async function runLoop(behaviour, { extraEnv = {} } = {}) {
  const outputDir = scratch()
  const previousToken = process.env.E2E_ANTHROPIC_CONTROL_TOKEN
  process.env.E2E_ANTHROPIC_CONTROL_TOKEN = "loop-control-token"
  const fixture = createMockAnthropicServer()
  await fixture.start(0)

  const out = { log: [], err: [] }
  try {
    return await withFakePlatform(
      telegramWithBot(fixture.baseUrl, behaviour),
      async ({ baseUrl }) => {
        const exitCode = await main({
          argv: ["--platform", "telegram"],
          env: {
            IM_LIVE_TELEGRAM_DRIVER_BOT_TOKEN: TOKEN,
            IM_LIVE_TELEGRAM_TARGET_CHAT_ID: CHAT,
            IM_LIVE_TELEGRAM_TARGET_BOT_USERNAME: "cognia_target_bot",
            IM_LIVE_TELEGRAM_API_BASE: baseUrl,
            IM_LIVE_OUTPUT_DIR: outputDir,
            IM_LIVE_FIXTURE_URL: fixture.baseUrl,
            IM_LIVE_FIXTURE_TOKEN: "loop-control-token",
            IM_LIVE_TURN_TIMEOUT_MS: "10000",
            IM_LIVE_DUPLICATE_WINDOW_MS: "600",
            ...extraEnv,
          },
          log: (m) => out.log.push(m),
          logError: (m) => out.err.push(m),
          loadEnv: () => ({ loaded: false }),
        })
        const runDir = readdirSync(outputDir).find((entry) => /^[0-9a-f]{16}$/.test(entry))
        const report = runDir
          ? JSON.parse(readFileSync(path.join(outputDir, runDir, "telegram.json"), "utf8"))
          : null
        return { exitCode, out, report, outputDir }
      }
    )
  } finally {
    await fixture.stop()
    if (previousToken === undefined) delete process.env.E2E_ANTHROPIC_CONTROL_TOKEN
    else process.env.E2E_ANTHROPIC_CONTROL_TOKEN = previousToken
  }
}

test("a well-behaved bot passes both turns and leaves clean evidence", async () => {
  const { exitCode, report, out } = await runLoop("normal")
  assert.equal(exitCode, 0, out.err.join("\n"))
  assert.equal(report.status, STATUS.PASS)
  assert.equal(report.turns.length, 2, "both admission paths must be exercised")

  for (const turn of report.turns) {
    assert.equal(turn.status, STATUS.PASS)
    assert.equal(turn.fixture.hit, true, `turn ${turn.turn} must have reached the model fixture`)
    assert.deepEqual(turn.fixture.markers, [turn.marker])
    assert.equal(turn.markerReplyCount, 1)
    assert.ok(turn.replies.every((reply) => reply.matchedMarker))
  }
  assert.match(report.turns[0].marker, /:turn-1$/)
  assert.match(report.turns[1].marker, /:turn-2$/)
  assert.notEqual(report.turns[0].marker, report.turns[1].marker)
  assert.equal(report.cleanup.ok, true)
  assert.ok(report.cleanup.deleted.length > 0)
})

test("the evidence file carries ids and timings but never message text", async () => {
  const { report } = await runLoop("normal")
  const serialized = JSON.stringify(report)
  assert.ok(!serialized.includes("mock-anthropic-echo"), "the reply body must not be recorded")
  assert.ok(!serialized.includes(TOKEN), "the driver token must never land on disk")
  assert.ok(report.turns[0].probeMessageId)
  assert.ok(report.turns[0].replies[0].messageId)
  assert.ok(report.phases.some((phase) => phase.name === "turn-1" && phase.ms >= 0))
  assert.equal(report.schema, "cognia.im-live.run/1")
})

test("a bot that answers WITHOUT the model is caught, not passed", async () => {
  // Short turn budget: the bot answers immediately, but the answer carries no
  // marker, so the reply wait always runs to the deadline. Nothing here needs
  // the production 120s.
  const { exitCode, report, out } = await runLoop("bypass-model", {
    extraEnv: { IM_LIVE_TURN_TIMEOUT_MS: "2500" },
  })
  assert.equal(exitCode, 1)
  assert.equal(report.status, STATUS.MODEL_NOT_INTERCEPTED)
  assert.equal(report.turns[0].fixture.hit, false)
  const printed = out.err.join("\n")
  assert.match(printed, /vault_provider_overrides_base_url/)
  assert.match(printed, /inject_provider_env/)
})

test("a bot that answers twice is caught by the duplicate window", async () => {
  const { exitCode, report, out } = await runLoop("duplicate")
  assert.equal(exitCode, 1)
  assert.equal(report.status, STATUS.FAIL)
  assert.equal(report.turns[0].markerReplyCount, 2)
  assert.match(out.err.join("\n"), /duplicate_consumption/)
})

test("a silent bot times out and names the inbound gates to check", async () => {
  // Nothing ever arrives, so the turn budget IS the test's runtime.
  const { exitCode, report, out } = await runLoop("silent", {
    extraEnv: { IM_LIVE_TURN_TIMEOUT_MS: "2500" },
  })
  assert.equal(exitCode, 1)
  assert.equal(report.status, STATUS.TIMEOUT)
  const printed = out.err.join("\n")
  assert.match(printed, /sibling_identity_unknown/)
  assert.match(printed, /bus\.ts step 9\.6/)
  assert.match(printed, /at_mention_required/)
})

test("IM_LIVE_KEEP leaves the conversation untouched", async () => {
  const { report } = await runLoop("normal", { extraEnv: { IM_LIVE_KEEP: "1" } })
  assert.deepEqual(report.cleanup, { skipped: true, reason: "IM_LIVE_KEEP=1" })
})

test("the lock is released, so a second run of the same conversation is not blocked", async () => {
  const first = await runLoop("normal")
  assert.equal(first.exitCode, 0)
  assert.deepEqual(readdirSync(path.join(first.outputDir, ".locks")), [])
  const second = await runLoop("normal")
  assert.equal(second.exitCode, 0)
})

// This composes the actual CLI, observer, fixture and evidence writer. QQ and
// its responding target are local stand-ins; this is not platform acceptance.
for (const kind of ["group", "c2c"]) {
  test(`QQ Official ${kind} text smoke composes both human turns and scoped evidence`, async () => {
    mkdirSync(".cache", { recursive: true })
    const outputDir = mkdtempSync(path.resolve(".cache/im-qq-loop-"))
    const previousToken = process.env.E2E_ANTHROPIC_CONTROL_TOKEN
    process.env.E2E_ANTHROPIC_CONTROL_TOKEN = "qq-loop-control-token"
    const fixture = createMockAnthropicServer()
    const messages = [],
      pending = []
    let failure
    let messageId = 1
    const message = (id, sender, text, segments = []) => ({
      message_id: id,
      user_id: sender,
      self_id: 654321,
      message_type: kind === "group" ? "group" : "private",
      ...(kind === "group"
        ? { group_id: 987654 }
        : { target_id: sender === 654321 ? 123456 : 654321 }),
      time: Math.floor(Date.now() / 1000),
      message: [...segments, { type: "text", data: { text } }],
    })
    await fixture.start(0)
    try {
      await withFakePlatform(
        {
          "POST /get_login_info": () => ({
            json: { status: "ok", retcode: 0, data: { user_id: 654321 } },
          }),
          [`POST /${kind === "group" ? "get_group_msg_history" : "get_friend_msg_history"}`]:
            () => ({ json: { status: "ok", retcode: 0, data: { messages: [...messages] } } }),
        },
        async ({ baseUrl, calls }) => {
          const code = await main({
            argv: ["--platform", "qq-official"],
            env: {
              IM_LIVE_QQ_OFFICIAL_OBSERVER_API_BASE: baseUrl,
              IM_LIVE_QQ_OFFICIAL_OBSERVER_BEARER_TOKEN: "qq-observer-secret",
              IM_LIVE_QQ_OFFICIAL_TARGET_CONVERSATION_ID: kind === "group" ? "987654" : "123456",
              IM_LIVE_QQ_OFFICIAL_TARGET_BOT_UIN: "123456",
              IM_LIVE_QQ_OFFICIAL_DRIVER_USER_UIN: "654321",
              IM_LIVE_QQ_OFFICIAL_CONVERSATION_KIND: kind,
              IM_LIVE_OUTPUT_DIR: outputDir,
              IM_LIVE_FIXTURE_URL: fixture.baseUrl,
              IM_LIVE_FIXTURE_TOKEN: "qq-loop-control-token",
              IM_LIVE_TURN_TIMEOUT_MS: "10000",
              IM_LIVE_DUPLICATE_WINDOW_MS: "20",
            },
            loadEnv: () => ({ loaded: false }),
            logError: (text) => {
              failure = text
            },
            log: (text) => {
              const marker = text.match(/cognia-e2e:qq-official:[a-f0-9]+:turn-\d+/)?.[0]
              if (!marker) return
              const second = marker.endsWith(":turn-2")
              const segments = [
                ...(kind === "group" ? [{ type: "at", data: { qq: "123456" } }] : []),
                ...(second ? [{ type: "reply", data: { id: String(messageId - 1) } }] : []),
              ]
              messages.push(message(messageId++, 654321, marker, segments))
              pending.push(
                (async () => {
                  const response = await fetch(`${fixture.baseUrl}/v1/messages`, {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({
                      model: "claude-opus-5",
                      max_tokens: 64,
                      messages: [{ role: "user", content: [{ type: "text", text: marker }] }],
                    }),
                  })
                  const body = await response.json()
                  messages.push(message(messageId++, 123456, body.content[0].text))
                })().catch((error) => {
                  failure = String(error)
                })
              )
            },
          })
          await Promise.all(pending)
          assert.equal(code, 0, failure)
          const runDir = readdirSync(outputDir).find((entry) => /^[0-9a-f]{16}$/.test(entry))
          const serialized = readFileSync(path.join(outputDir, runDir, "qq-official.json"), "utf8")
          const report = JSON.parse(serialized)
          assert.equal(report.status, STATUS.PASS)
          assert.equal(report.acceptanceScope.conversationKind, kind)
          assert.ok(report.acceptanceScope.excludes.includes("official-app-identity-mapping"))
          assert.deepEqual(
            report.turns.map((turn) => turn.action),
            kind === "group"
              ? ["group-mention", "group-quote-with-mention"]
              : ["c2c-text", "c2c-quote"]
          )
          assert.ok(
            report.turns.every(
              (turn) =>
                turn.modelRequestCount === 1 &&
                turn.matchingModelRequestCount === 1 &&
                turn.markerReplyCount === 1
            )
          )
          assert.ok(!serialized.includes("qq-observer-secret"))
          assert.ok(!serialized.includes("mock-anthropic-echo"))
          assert.ok(calls.every((call) => !/send_|delete_/.test(call.pathname)))
          assert.deepEqual(readdirSync(path.join(outputDir, ".locks")), [])
        }
      )
    } finally {
      await Promise.all(pending)
      await fixture.stop()
      rmSync(outputDir, { recursive: true, force: true })
      if (previousToken === undefined) delete process.env.E2E_ANTHROPIC_CONTROL_TOKEN
      else process.env.E2E_ANTHROPIC_CONTROL_TOKEN = previousToken
    }
  })
}

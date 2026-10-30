// Personal QQ needs a different human account to trigger Cognia. This driver
// only reads NapCat's HTTP API; Cognia still receives/sends over its configured
// forward or reverse WebSocket. Reuse the shared two-turn fixture/report flow.
import { pollUntil, requestJson, sleep } from "./http.mjs"
import { createLease, observedReply } from "./observe.mjs"

const PAGE_SIZE = 100
const validClientId = (value) =>
  (typeof value === "string" && /^[1-9]\d*$/.test(value)) ||
  (typeof value === "number" && Number.isSafeInteger(value) && value > 0)
const validMessageId = (value) =>
  (typeof value === "string" &&
    /^-?[1-9]\d*$/.test(value) &&
    Number.isSafeInteger(Number(value))) ||
  (typeof value === "number" && Number.isSafeInteger(value) && value !== 0)
const textOf = (message) =>
  message.message
    .filter((s) => s.type === "text")
    .map((s) => s.data?.text ?? "")
    .join("")

export function createOneBotDriver({ values, ...options }) {
  return createQQHistoryDriver({ ...options, values })
}

// Shared client-side observer, independent of Cognia's target adapter. The
// Official Bot lane uses a human observer; OneBot observes its target account.
export function createQQHistoryDriver({
  values,
  platform = "onebot",
  observerUin = values.targetBotUin,
  conversationKind = "group",
  conversationId = values.targetGroupId,
  quoteNeedsMention = false,
  fetchImpl = fetch,
  timeoutMs = 30000,
  humanTimeoutMs = 120000,
  now = Date.now,
  sleepImpl = sleep,
  log = console.log,
}) {
  const { apiBase, bearerToken, targetBotUin, driverUserUin } = values
  if (![targetBotUin, driverUserUin, observerUin, conversationId].every(validClientId))
    throw new Error("QQ client conversation ID and UIN values must be positive decimal integers")
  const group = conversationKind === "group"
  const leaseConversationId =
    platform === "onebot" ? String(conversationId) : `${conversationKind}:${conversationId}`
  const root = new URL(apiBase)
  // The extra observer API is local to the Mac. Never put bearer credentials
  // in URLs (which are included in HTTP diagnostics).
  if (
    !["http:", "https:"].includes(root.protocol) ||
    root.username ||
    root.password ||
    root.search ||
    root.hash
  )
    throw new Error("OneBot API base must be an HTTP URL without credentials, query or fragment")
  const base = root.href.replace(/\/+$/, "")
  const call = async (action, params = {}) => {
    const payload = await requestJson({
      url: `${base}/${action}`,
      method: "POST",
      body: params,
      headers: { authorization: `Bearer ${bearerToken}` },
      fetchImpl,
      timeoutMs,
    })
    if (payload?.status !== "ok" || payload.retcode !== 0)
      throw new Error(
        `onebot ${action} failed: ${payload?.message ?? payload?.wording ?? "unknown"} (${payload?.retcode})`
      )
    return payload.data
  }
  const page = async (cursor) => {
    const data = await call(group ? "get_group_msg_history" : "get_friend_msg_history", {
      [group ? "group_id" : "user_id"]: String(conversationId),
      count: PAGE_SIZE,
      ...(cursor ? { message_seq: cursor } : {}),
    })
    if (!Array.isArray(data?.messages)) throw new Error("OneBot history returned no messages array")
    for (const item of data.messages) {
      if (!Array.isArray(item.message))
        throw new Error("Set NapCat HTTP messagePostFormat to array")
      const sender = item.user_id ?? item.sender?.user_id
      if (
        !validMessageId(item.message_id) ||
        !validClientId(sender) ||
        !["number", "string"].includes(typeof item.time) ||
        String(item.time).trim() === "" ||
        !Number.isSafeInteger(Number(item.time)) ||
        Number(item.time) <= 0 ||
        Number(item.time) > Math.floor(now() / 1000) + 30
      )
        throw new Error("OneBot history returned a message without valid id/time/sender")
      if (group && item.group_id !== undefined && String(item.group_id) !== String(conversationId))
        throw new Error("OneBot history returned a different conversation")
      if (!group && item.group_id !== undefined && String(item.group_id) !== "0")
        throw new Error("OneBot C2C history returned a group conversation")
      if (
        (item.self_id !== undefined && String(item.self_id) !== String(observerUin)) ||
        (item.user_id !== undefined &&
          item.sender?.user_id !== undefined &&
          String(item.user_id) !== String(item.sender.user_id))
      )
        throw new Error("OneBot history returned conflicting observer or sender identity")
      if (
        (item.message_type !== undefined && item.message_type !== (group ? "group" : "private")) ||
        (item.post_type !== undefined && !["message", "message_sent"].includes(item.post_type)) ||
        (item.post_type === "message_sent" && String(sender) !== String(observerUin))
      )
        throw new Error("OneBot history returned a conflicting message type")
      if (!group) {
        const actors = [String(observerUin), String(targetBotUin)]
        const recipient =
          String(sender) === String(observerUin) ? String(targetBotUin) : String(observerUin)
        if (
          !actors.includes(String(sender)) ||
          (item.peer_id !== undefined && String(item.peer_id) !== String(conversationId)) ||
          (item.target_id !== undefined && String(item.target_id) !== recipient)
        )
          throw new Error("OneBot C2C history returned a different peer conversation")
      }
    }
    return data.messages
  }
  const history = async (lease) => {
    const all = new Map()
    const cursors = new Set()
    let cursor
    const deadline = now() + timeoutMs
    for (;;) {
      const messages = await page(cursor)
      for (const item of messages) all.set(String(item.message_id), item)
      const oldestTime = Math.min(...messages.map((m) => Number(m.time)))
      if (
        messages.length < PAGE_SIZE ||
        messages.some((m) => lease.baseline.has(String(m.message_id))) ||
        oldestTime < lease.startTimeSec
      )
        break
      const boundary = messages.filter((m) => Number(m.time) === oldestTime)
      // Native group sequences are chronological. Short OneBot message IDs
      // are hashes; C2C sequences are sender-local and cannot break a tie.
      if (
        boundary.length > 1 &&
        (!group || !boundary.every((m) => /^\d+$/.test(String(m.real_seq))))
      )
        throw new Error(
          "OneBot history pagination has an ambiguous same-second boundary; use a quiet test conversation"
        )
      const oldest = boundary.reduce((a, b) =>
        group &&
        b.real_seq !== undefined &&
        a.real_seq !== undefined &&
        BigInt(b.real_seq) < BigInt(a.real_seq)
          ? b
          : a
      )
      // NapCat resolves message_seq through its short message-id map.
      cursor = String(oldest.message_id)
      if (cursors.has(cursor) || now() >= deadline)
        throw new Error(
          "OneBot history pagination did not reach the run boundary; retry in a quiet test group"
        )
      cursors.add(cursor)
    }
    return [...all.values()]
      .filter(
        (m) => !lease.baseline.has(String(m.message_id)) && Number(m.time) >= lease.startTimeSec
      )
      .sort((a, b) => Number(a.time) - Number(b.time))
  }
  const waitHuman = async (lease, marker, replyId) => {
    const action = group
      ? replyId
        ? quoteNeedsMention
          ? "group-quote-with-mention"
          : "group-quote"
        : "group-mention"
      : replyId
        ? "c2c-quote"
        : "c2c-text"
    const address = group
      ? `group ${conversationId}`
      : `the private conversation with ${targetBotUin}`
    log(
      replyId
        ? `[im-live] ${platform}: as QQ ${driverUserUin}, quote reply ${replyId}${quoteNeedsMention ? ` and select @${targetBotUin}` : group ? " without mentioning the target" : ""} in ${address} with: ${marker}`
        : `[im-live] ${platform}: as QQ ${driverUserUin}, ${group ? `select @${targetBotUin} from QQ's mention picker in ${address} and send` : `send in ${address}`}: ${marker}`
    )
    const found = await pollUntil(
      async () => {
        const messages = await history(lease)
        return (
          messages.find(
            (m) =>
              String(m.user_id ?? m.sender?.user_id) === String(driverUserUin) &&
              textOf(m).includes(marker) &&
              (!replyId ||
                m.message.some(
                  (s) => s.type === "reply" && String(s.data?.id) === String(replyId)
                )) &&
              (!group ||
                m.message.some(
                  (s) => s.type === "at" && String(s.data?.qq) === String(targetBotUin)
                ) === (!replyId || quoteNeedsMention))
          ) ?? null
        )
      },
      { timeoutMs: humanTimeoutMs, now, sleepImpl }
    )
    if (!found)
      throw new Error(
        "OneBot human mention/quote timed out; no matching message from the configured driver user"
      )
    return { messageId: String(found.message_id), sentAt: Number(found.time) * 1000, action }
  }
  return {
    platform,
    conversationId: leaseConversationId,
    enforceReplyTiming: true,
    async doctor() {
      const checks = [
        {
          name: "human differs from target",
          ok: String(driverUserUin) !== String(targetBotUin),
          detail: "Use a second QQ account for mentions and quoted replies.",
        },
      ]
      try {
        const info = await call("get_login_info")
        checks.push({
          name: "observer identity",
          ok: validClientId(info?.user_id) && String(info.user_id) === String(observerUin),
          detail: `NapCat account ${info?.user_id}, expected ${observerUin}`,
        })
      } catch (error) {
        checks.push({ name: "observer identity", ok: false, detail: error.message })
      }
      try {
        await page()
        checks.push({
          name: `${conversationKind} history readable`,
          ok: true,
          detail:
            "HTTP observer ready; live turns verify client-visible text delivery, not stream completion or Host control.",
        })
      } catch (error) {
        checks.push({
          name: `${conversationKind} history readable`,
          ok: false,
          detail: error.message,
        })
      }
      return checks
    },
    async prepare() {
      const startTimeSec = Math.floor(now() / 1000)
      const existing = await page()
      return createLease({
        platform,
        conversationId: leaseConversationId,
        extra: {
          startTimeSec,
          baseline: new Set(existing.map((m) => String(m.message_id))),
          seen: new Set(),
        },
      })
    },
    injectMention: (lease, marker) => waitHuman(lease, marker),
    replyToTarget: (lease, target, marker) => waitHuman(lease, marker, target.messageId),
    async pollTargetMessages(lease) {
      const fresh = []
      for (const item of await history(lease)) {
        const id = String(item.message_id)
        if (lease.seen.has(id)) continue
        lease.seen.add(id)
        if (String(item.user_id ?? item.sender?.user_id) !== String(targetBotUin)) continue
        fresh.push(
          observedReply({
            messageId: id,
            text: textOf(item),
            at: Number(item.time) * 1000,
            threadId: item.message.find((s) => s.type === "reply")?.data?.id ?? null,
          })
        )
      }
      return fresh
    },
    async cleanup() {
      return {
        skipped: true,
        ok: true,
        reason: "Human-driven QQ test: retained messages for manual inspection and cleanup.",
      }
    },
  }
}

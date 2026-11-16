/** @jest-environment jsdom */

/**
 * Per-token cost of the local streaming path (chat-surface overhaul, step 2).
 *
 * Seeds a conversation of N settled messages, then streams one assistant reply
 * through `handleEvent` with the real SDK adapter: `message_start` followed by
 * text deltas. Two costs are reported per delta:
 *
 * - `handleMs`: the handler alone (adapter reduce, diffing, enrichment). This
 *   runs for every token, before the rAF coalescer.
 * - `commitMs`: one forced commit into the chat store (what each frame pays).
 *
 * Skipped unless CHAT_BENCHMARK=1; run with `pnpm benchmark:chat`.
 */

import "fake-indexeddb/auto"
import type { UIMessage } from "ai"
import { SessionCoalescingRegistry } from "@/lib/chat/stream-coalescing"
import { useChatStore } from "@/stores/chat"
import { handleEvent } from "./claude-chat-events"

jest.mock("sonner", () => ({ toast: Object.assign(jest.fn(), { success: jest.fn() }) }))
// Persistence is debounced away from the per-token path; keep Dexie out of it.
jest.mock("@/lib/db/messages", () => ({
  ...jest.requireActual("@/lib/db/messages"),
  persistMessages: async () => undefined,
  persistStreamingMessages: async () => undefined,
}))

const benchmarkEnabled = process.env.CHAT_BENCHMARK === "1"
const benchmarkDescribe = benchmarkEnabled ? describe : describe.skip
const SIZES = (process.env.CHAT_BENCHMARK_SIZES ?? "200,2000,5000").split(",").map(Number)
const DELTAS = Number(process.env.CHAT_BENCHMARK_DELTAS ?? 200)
const SESSION = "bench-session"

function seededConversation(size: number): UIMessage[] {
  return Array.from({ length: size }, (_, index) => ({
    id: `seed-${index}`,
    role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
    parts: [{ type: "text" as const, text: `Message ${index}: ${"lorem ipsum ".repeat(20)}` }],
    metadata: { createdAt: 1_000 + index },
  }))
}

function sdkFrame(event: Record<string, unknown>) {
  return {
    type: "event",
    sessionId: SESSION,
    event: { type: "stream_event", event, session_id: "sdk-bench", uuid: crypto.randomUUID() },
  } as never
}

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0
}

interface SizeResult {
  size: number
  handleP50: number
  handleP95: number
  commitP50: number
  commitP95: number
}

async function measure(size: number): Promise<SizeResult> {
  const seed = seededConversation(size)
  const chat = useChatStore.getState()
  chat.clear()
  chat.setActiveSession(SESSION)
  chat.replaceSessionMessages(SESSION, seed)
  const mirror = { current: new Map([[SESSION, seed]]) }
  const registry = new SessionCoalescingRegistry({
    onCommit: (id, messages) => useChatStore.getState().replaceSessionMessages(id, messages),
    onPersist: () => undefined,
    persistDelayMs: 60_000,
  })
  const coalescing = { messagesMirrorRef: mirror, registry, getExecutionHandle: () => undefined }
  const refs = [
    { current: SESSION },
    { current: [] as string[] },
    { current: new Map() },
    { current: new Map() },
    { current: null },
  ] as const
  const send = (frame: never) => handleEvent(frame, ...refs, coalescing)

  await send(sdkFrame({ type: "message_start", message: { id: "bench-reply", role: "assistant" } }))
  await send(sdkFrame({ type: "content_block_start", index: 0, content_block: { type: "text" } }))
  const handle: number[] = []
  const commit: number[] = []
  try {
    for (let i = 0; i < DELTAS; i++) {
      const frame = sdkFrame({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "token text " },
      })
      const t0 = performance.now()
      await send(frame)
      const t1 = performance.now()
      registry.get(SESSION).commit.flush()
      const t2 = performance.now()
      handle.push(t1 - t0)
      commit.push(t2 - t1)
    }
    const reply = useChatStore
      .getState()
      .sessions[SESSION]?.messages.find((message) => message.id === "bench-reply")
    // The stream must actually have landed, or the numbers measure nothing.
    expect(reply).toBeDefined()
  } finally {
    registry.clear()
  }
  return {
    size,
    handleP50: percentile(handle, 50),
    handleP95: percentile(handle, 95),
    commitP50: percentile(commit, 50),
    commitP95: percentile(commit, 95),
  }
}

benchmarkDescribe("local streaming per-token cost", () => {
  it("reports handleEvent and commit cost by conversation length", async () => {
    // Warm the module graph and JIT before measuring.
    await measure(50)
    const results: SizeResult[] = []
    for (const size of SIZES) results.push(await measure(size))
    const round = (value: number) => Math.round(value * 1000) / 1000
    console.info(
      `[chat-benchmark] handleEvent ${JSON.stringify(
        results.map((r) => ({
          size: r.size,
          handleP50: round(r.handleP50),
          handleP95: round(r.handleP95),
          commitP50: round(r.commitP50),
          commitP95: round(r.commitP95),
        }))
      )}`
    )
    expect(results).toHaveLength(SIZES.length)
  }, 600_000)
})

describe("seededConversation", () => {
  it("alternates roles with stable ids", () => {
    const messages = seededConversation(3)
    expect(messages.map((message) => [message.id, message.role])).toEqual([
      ["seed-0", "user"],
      ["seed-1", "assistant"],
      ["seed-2", "user"],
    ])
  })
})

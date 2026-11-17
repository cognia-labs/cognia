/**
 * Recover the ORIGINAL user prompt behind a trace.
 *
 * A {@link import("./trace-summary").TraceSummary}'s `preview` is a span's
 * `inputPreview`: PII-gated and truncated for display. Promoting a trace into
 * an eval case used it verbatim as the case input, so every case built from
 * real traffic was a clipped fragment of what the user actually asked — and
 * then the agent was evaluated against that fragment.
 *
 * The full text is still in the session's message log, so resolve from there
 * and keep the preview only as a fallback (a session whose messages were
 * cleared, or a trace with no session).
 *
 * A session holds many turns, each with its own trace, so the prompt is the
 * user message that STARTED that trace: the latest user message created no
 * later than the trace's first span. (Taking the session's first message gave
 * every later turn the opening question, so a failing third turn became an
 * eval case of the first, passing one.) Messages carry no run id, so time is
 * the join; when no user message precedes the trace, nothing is returned and
 * the caller keeps the preview rather than inventing an "original" prompt.
 *
 * Pure over an injected loader so it stays testable and Dexie-free;
 * {@link defaultPromptLoader} wires the real message store.
 */

import type { TraceSummary } from "./trace-summary"

/** A stored message as the loader returns it (`metadata.createdAt` is epoch ms). */
export interface SessionMessage {
  role?: string
  parts?: unknown[]
  metadata?: { createdAt?: unknown } | Record<string, unknown>
}

/** Loads a session's messages, oldest-first. */
export type SessionMessageLoader = (sessionId: string) => Promise<SessionMessage[]>

/**
 * Clock slack between the renderer that stamps a message and the runtime that
 * stamps the trace's first span. Smaller than any human gap between sending a
 * message and sending the next one.
 */
export const TRACE_PROMPT_CLOCK_SKEW_MS = 1_000

/** Concatenate the text parts of an AI-SDK UI message. */
function messageText(message: { parts?: unknown[] }): string {
  if (!Array.isArray(message.parts)) return ""
  return message.parts
    .map((part) =>
      part && typeof part === "object" && (part as { type?: string }).type === "text"
        ? ((part as { text?: unknown }).text ?? "")
        : ""
    )
    .filter((t): t is string => typeof t === "string" && t.length > 0)
    .join("\n")
    .trim()
}

function createdAtOf(message: SessionMessage): number | undefined {
  const value = (message.metadata as { createdAt?: unknown } | undefined)?.createdAt
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

/**
 * The prompt of the turn that started a trace, from already-loaded messages:
 * the latest user message with text created at or before `startTime`.
 */
export function promptForTrace(
  messages: readonly SessionMessage[],
  startTime: number
): string | undefined {
  if (!Number.isFinite(startTime) || startTime <= 0) return undefined
  let best: { at: number; text: string } | undefined
  for (const message of messages) {
    if (message.role !== "user") continue
    const at = createdAtOf(message)
    if (at === undefined || at > startTime + TRACE_PROMPT_CLOCK_SKEW_MS) continue
    const text = messageText(message)
    if (!text) continue
    if (!best || at >= best.at) best = { at, text }
  }
  return best?.text
}

/**
 * The prompt of the turn behind one trace, or `undefined` when it cannot be
 * recovered. Never throws — a missing session is a fallback, not a failure.
 */
export async function resolveTracePrompt(
  trace: Pick<TraceSummary, "sessionId" | "startTime">,
  load: SessionMessageLoader
): Promise<string | undefined> {
  if (!trace.sessionId) return undefined
  try {
    return promptForTrace(await load(trace.sessionId), trace.startTime)
  } catch {
    return undefined
  }
}

/**
 * Resolve prompts for many traces at once, keyed by trace id. Each session is
 * loaded once; each trace gets its own turn's prompt.
 */
export async function resolveTracePrompts(
  summaries: Pick<TraceSummary, "traceId" | "sessionId" | "startTime">[],
  load: SessionMessageLoader
): Promise<Record<string, string>> {
  const bySession = new Map<string, Pick<TraceSummary, "traceId" | "startTime">[]>()
  for (const s of summaries) {
    if (!s.sessionId) continue
    const list = bySession.get(s.sessionId) ?? []
    list.push(s)
    bySession.set(s.sessionId, list)
  }
  const out: Record<string, string> = {}
  await Promise.all(
    [...bySession].map(async ([sessionId, traces]) => {
      let messages: SessionMessage[]
      try {
        messages = await load(sessionId)
      } catch {
        return
      }
      for (const trace of traces) {
        const prompt = promptForTrace(messages, trace.startTime)
        if (prompt) out[trace.traceId] = prompt
      }
    })
  )
  return out
}

/** Wire the real message store. */
export function defaultPromptLoader(): SessionMessageLoader {
  return async (sessionId) => {
    const { listMessages } = await import("@/lib/db/messages")
    return (await listMessages(sessionId)) as SessionMessage[]
  }
}

// The nested calls of a `run_code` program, kept on its tool part (ADR-0117
// Phase 4, CM-12).
//
// A program's `cognia.*` calls are not tool calls the model made, so they
// never become tool parts of their own (history must not replay them as if
// the model had). The sidecar reports each one as a synthetic
// `system/code_run_call` event naming the `run_code` call it ran inside
// (`sidecar/src/tools/builtin/run-code/trace.ts`), and this module folds those
// events into that call's part as `codeRunCalls`, one entry per nested call in
// program order. The part is persisted with the message, so a reload, a paired
// device and the archive all read the same list.
//
// The event carries safe facts only: the tool, its state, the failure kind,
// the time it took and the size of what it returned.

import type { UIMessage } from "ai"

type Part = UIMessage["parts"][number]

/** The `system` subtype the sidecar emits each nested call's state as. */
export const CODE_RUN_CALL_SUBTYPE = "code_run_call"

export type CodeRunCallState = "running" | "succeeded" | "failed"

/** One nested call, as the `run_code` part keeps it. */
export interface CodeRunCall {
  /** `<run_code call id>/<ordinal>`: the id its approval and review used too. */
  id: string
  /** 1-based, in the order the program made its calls. */
  ordinal: number
  tool: string
  state: CodeRunCallState
  /** The failure kind (`not-found`, `permission-denied`, …) of a failed call. */
  failure?: string
  durationMs?: number
  resultBytes?: number
}

/** A part that carries nested calls. */
export interface ToolPartCodeRunCalls {
  codeRunCalls?: CodeRunCall[]
}

/**
 * More nested calls than one program can make. Refused calls take a place
 * too, so this sits well above the per-run call budget; anything past it is
 * malformed and dropped.
 */
const MAX_ORDINAL = 1024
const TOOL_NAME = /^[A-Za-z0-9_.-]{1,64}$/
const FAILURE_KIND = /^[a-z][a-z-]{0,39}$/
const MAX_ID_LENGTH = 512

function nonNegative(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined
}

/**
 * One nested call from its wire shape (`duration_ms`, `result_bytes`) or the
 * stored one (`durationMs`, `resultBytes`), or null when it is malformed.
 */
function readCall(value: unknown): CodeRunCall | null {
  if (!value || typeof value !== "object") return null
  const raw = value as Record<string, unknown>
  const { id, ordinal, tool, state, failure } = raw
  if (typeof id !== "string" || id.length === 0 || id.length > MAX_ID_LENGTH) return null
  if (typeof ordinal !== "number" || !Number.isInteger(ordinal)) return null
  if (ordinal < 1 || ordinal > MAX_ORDINAL) return null
  if (typeof tool !== "string" || !TOOL_NAME.test(tool)) return null
  if (state !== "running" && state !== "succeeded" && state !== "failed") return null
  const durationMs = nonNegative(raw.durationMs ?? raw.duration_ms)
  const resultBytes = nonNegative(raw.resultBytes ?? raw.result_bytes)
  return {
    id,
    ordinal,
    tool,
    state,
    ...(state === "failed" && typeof failure === "string" && FAILURE_KIND.test(failure)
      ? { failure }
      : {}),
    ...(durationMs !== undefined ? { durationMs: Math.round(durationMs) } : {}),
    ...(resultBytes !== undefined ? { resultBytes: Math.round(resultBytes) } : {}),
  }
}

/** A `system/code_run_call` event's parent call id and nested call, or null. */
export function parseCodeRunCallEvent(
  event: unknown
): { parentToolCallId: string; call: CodeRunCall } | null {
  if (!event || typeof event !== "object") return null
  const raw = event as Record<string, unknown>
  if (raw.type !== "system" || raw.subtype !== CODE_RUN_CALL_SUBTYPE) return null
  const parent = raw.parent_tool_use_id
  if (typeof parent !== "string" || parent.length === 0 || parent.length > MAX_ID_LENGTH) {
    return null
  }
  const call = readCall(raw.call)
  return call ? { parentToolCallId: parent, call } : null
}

/** The nested calls a part carries, validated, in program order; null when none. */
export function codeRunCallsOf(part: unknown): CodeRunCall[] | null {
  const stored = (part as ToolPartCodeRunCalls | null | undefined)?.codeRunCalls
  if (!Array.isArray(stored)) return null
  const calls = stored.map(readCall).filter((call): call is CodeRunCall => call !== null)
  return calls.length > 0 ? calls.sort((a, b) => a.ordinal - b.ordinal) : null
}

function isToolPart(part: Part): part is Part & { toolCallId: string } {
  const type = (part as { type?: unknown }).type
  return (
    typeof type === "string" &&
    (type.startsWith("tool-") || type === "dynamic-tool") &&
    typeof (part as { toolCallId?: unknown }).toolCallId === "string"
  )
}

/** Insert or replace one call; an ended call is never set back to running. */
function upsertCall(calls: readonly CodeRunCall[], next: CodeRunCall): CodeRunCall[] {
  const index = calls.findIndex((call) => call.ordinal === next.ordinal)
  if (index < 0) return [...calls, next].sort((a, b) => a.ordinal - b.ordinal)
  if (calls[index]!.state !== "running" && next.state === "running") return [...calls]
  const merged = calls.slice()
  merged[index] = next
  return merged
}

/**
 * Fold one `code_run_call` event into the part of the `run_code` call it
 * names. An event whose parent is not in the transcript changes nothing.
 */
export function applyCodeRunCall(messages: UIMessage[], event: unknown): UIMessage[] {
  const parsed = parseCodeRunCallEvent(event)
  if (!parsed) return messages
  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex--) {
    const message = messages[messageIndex]!
    if (message.role !== "assistant") continue
    const partIndex = message.parts.findIndex(
      (part) => isToolPart(part) && part.toolCallId === parsed.parentToolCallId
    )
    if (partIndex < 0) continue
    const part = message.parts[partIndex]!
    const calls = upsertCall(codeRunCallsOf(part) ?? [], parsed.call)
    const parts = message.parts.slice()
    parts[partIndex] = { ...part, codeRunCalls: calls } as unknown as Part
    const next = messages.slice()
    next[messageIndex] = { ...message, parts }
    return next
  }
  return messages
}

/**
 * Carry each part's nested calls onto the snapshot that replaces it.
 *
 * An assistant message is rebuilt from the provider's content blocks whenever
 * a newer snapshot of it arrives, and those blocks know nothing of the calls a
 * still-running `run_code` has made; without this every snapshot would empty
 * the list the program is filling.
 */
export function preserveCodeRunCalls(previous: UIMessage | undefined, parts: Part[]): Part[] {
  if (!previous) return parts
  const kept = new Map<string, CodeRunCall[]>()
  for (const part of previous.parts) {
    if (!isToolPart(part)) continue
    const calls = codeRunCallsOf(part)
    if (calls) kept.set(part.toolCallId, calls)
  }
  if (kept.size === 0) return parts
  return parts.map((part) => {
    if (!isToolPart(part)) return part
    const calls = kept.get(part.toolCallId)
    if (!calls) return part
    const own = codeRunCallsOf(part)
    const merged = own ? calls.reduce(upsertCall, own) : calls
    return { ...part, codeRunCalls: merged } as unknown as Part
  })
}

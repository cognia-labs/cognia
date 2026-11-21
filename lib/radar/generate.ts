/**
 * Radar report generation — thin wrapper around an injected `LlmClient`.
 * Mirrors `lib/ai/generation/title.ts`: the module owns the prompt + JSON
 * parsing/normalization, the client is injected so it unit-tests with a mock.
 */

import type { LlmClient } from "@/lib/twin/distill/llm"
import { extractJson } from "@/lib/twin/distill/llm"
import { resolvePromptAsync } from "@/lib/prompts/resolve"
import { RADAR_SYSTEM_PROMPT, buildRadarUserMessage } from "./prompts"
import type { RadarDataItem, RadarLlmOutput } from "@/types/radar"

export interface GenerateRadarArgs {
  items: readonly RadarDataItem[]
  locale?: string
  signal?: AbortSignal
}

/** Coerce arbitrary parsed JSON into a well-formed `RadarLlmOutput`. */
export function normalizeRadarOutput(raw: unknown, itemCount: number): RadarLlmOutput {
  const o = (raw ?? {}) as Record<string, unknown>
  const asStringArray = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []
  const actions = (Array.isArray(o.actions) ? o.actions : [])
    .flatMap((action) => {
      if (typeof action === "string") return [{ text: action, evidence: [] as number[] }]
      if (!action || typeof action !== "object" || typeof action.text !== "string") return []
      const evidence = Array.isArray(action.sourceIndexes)
        ? [
            ...new Set<number>(
              action.sourceIndexes.filter(
                (index: unknown): index is number =>
                  typeof index === "number" &&
                  Number.isInteger(index) &&
                  index >= 0 &&
                  index < itemCount
              )
            ),
          ]
        : []
      return [{ text: action.text, evidence }]
    })
    .filter((action) => action.text.trim())
  const graveyard = Array.isArray(o.graveyard)
    ? (o.graveyard as unknown[])
        .filter((g): g is Record<string, unknown> => !!g && typeof g === "object")
        .filter(
          (g) =>
            typeof g.index === "number" &&
            Number.isInteger(g.index) &&
            g.index >= 0 &&
            g.index < itemCount &&
            typeof g.reason === "string"
        )
        .map((g) => ({ index: g.index as number, reason: g.reason as string }))
    : []
  const topicCloud = Array.isArray(o.topicCloud)
    ? (o.topicCloud as unknown[])
        .filter((t): t is Record<string, unknown> => !!t && typeof t === "object")
        .filter((t) => typeof t.topic === "string")
        .map((t) => ({
          topic: t.topic as string,
          weight: typeof t.weight === "number" ? t.weight : 0,
        }))
    : []
  return {
    verdict: typeof o.verdict === "string" ? o.verdict : "",
    atAGlance: asStringArray(o.atAGlance),
    infoDiet: typeof o.infoDiet === "string" ? o.infoDiet : "",
    subconscious: typeof o.subconscious === "string" ? o.subconscious : "",
    graveyard,
    blindSpots: typeof o.blindSpots === "string" ? o.blindSpots : "",
    actions: actions.map((action) => action.text),
    ...(actions.some((action) => action.evidence.length)
      ? { actionEvidence: actions.map((action) => action.evidence) }
      : {}),
    topicCloud,
  }
}

/**
 * Lifecycle hooks: NOT covered by settings.json lifecycle hooks (ADR-0040 scope
 * decision). This path builds a renderer-side `LlmClient` and calls the
 * provider directly, so it never reaches the sidecar where SDK-native hooks
 * are registered — wiring it up would mean a fourth hook rail, not a fire
 * site. A hook author sees this in the Hooks settings coverage list.
 */
function abortReasonError(signal: AbortSignal): Error {
  const reason = signal.reason
  if (reason instanceof Error) return reason
  const err = new Error(typeof reason === "string" && reason ? reason : "Radar generation aborted")
  err.name = "AbortError"
  return err
}

function raceWithAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise
  if (signal.aborted) return Promise.reject(abortReasonError(signal))
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortReasonError(signal))
    signal.addEventListener("abort", onAbort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort)
        if (signal.aborted) reject(abortReasonError(signal))
        else resolve(value)
      },
      (error) => {
        signal.removeEventListener("abort", onAbort)
        reject(error)
      }
    )
  })
}

export async function generateRadarReport(
  client: LlmClient,
  { items, locale, signal }: GenerateRadarArgs
): Promise<RadarLlmOutput> {
  if (signal?.aborted) throw abortReasonError(signal)
  const prompt = buildRadarUserMessage(items, locale)
  const system = (await raceWithAbort(resolvePromptAsync(RADAR_SYSTEM_PROMPT), signal)).text
  if (signal?.aborted) throw abortReasonError(signal)
  const raw = await raceWithAbort(
    client.complete(prompt, {
      system,
      temperature: 0.4,
      maxTokens: 2048,
      ...(signal ? { abortSignal: signal } : {}),
    }),
    signal
  )
  if (signal?.aborted) throw abortReasonError(signal)
  const parsed = extractJson<unknown>(raw)
  return normalizeRadarOutput(parsed, items.length)
}

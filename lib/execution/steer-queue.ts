/**
 * The steer queue rule, people first (ADR-0252 §5, shared with ADR-0247 §6 and
 * ADR-0249).
 *
 *   - A person's message and any stop are delivered live and never coalesced.
 *   - Derived inputs (a review, a CI result, a job completion, a wakeup, an
 *     automation's message) wait while the run streams and drain at the turn
 *     boundary, merged into one brief.
 *   - In a session's queue a person's turn is always placed ahead of queued
 *     derived inputs.
 *
 * Pure functions over a queue the caller owns: the renderer's per-session
 * `steerQueue`, a headless host's own. Nothing here reads a store or sends.
 */

import type { SendOptions } from "@cognia/agent-config-types"
import type { AutomatedTurnProducer } from "@cognia/agent-config-types/automated-turn"
import type { AttachmentManifestEntry } from "@/lib/chat/attachments/dispatch"
import type { PromptPreambleSummary } from "@/lib/chat/prompt-preamble"
import type { ContextRef } from "@/lib/chat/mentions/types"
import type { LocalPersonRun } from "@/lib/execution/acting-authority"

/** Who an input to a running turn came from. */
export type SteerOrigin = "person" | "derived"

/**
 * Where a derived input came from. Names only: the text of the input is the
 * caller's, and the brief says which kind of update each line is.
 */
export type DerivedSteerSource = "review" | "ci" | "job" | "wakeup" | "completion" | "automation"

/** The fields of a queued entry the rule reads. */
export interface SteerQueueEntryShape {
  id: string
  /** Absent on entries written before origins existed: those are a person's. */
  origin?: SteerOrigin
  /** A newer derived entry with the same key replaces the older one. */
  dedupeKey?: string
}

/** What to do with an input that arrives while a run may be streaming. */
export type SteerDisposition =
  /** Hand it to the running turn now. */
  | "live"
  /** Hold it for the next turn boundary. */
  | "queue"
  /** Nothing is running: there is no turn to steer. */
  | "idle"

/**
 * The rule for one input. A stop and a person's message go live whenever a
 * turn runs (the caller keeps its own fallback when the live lane refuses);
 * a derived input queues behind a running turn. Neither has a turn to join
 * when nothing runs.
 */
export function steerDisposition(input: {
  origin: SteerOrigin | "stop"
  sessionBusy: boolean
}): SteerDisposition {
  if (!input.sessionBusy) return "idle"
  return input.origin === "derived" ? "queue" : "live"
}

export function isDerivedEntry(entry: SteerQueueEntryShape): boolean {
  return entry.origin === "derived"
}

/**
 * Add an entry to a session's queue under the rule: a person's entry goes
 * after the people already waiting and ahead of every derived entry; a derived
 * entry goes last, replacing an older one with the same `dedupeKey` (the newer
 * review supersedes the older one; it does not stack).
 */
export function insertSteerEntry<T extends SteerQueueEntryShape>(
  queue: readonly T[],
  entry: T
): T[] {
  if (isDerivedEntry(entry)) {
    const rest = entry.dedupeKey
      ? queue.filter((queued) => !(isDerivedEntry(queued) && queued.dedupeKey === entry.dedupeKey))
      : [...queue]
    return [...rest, entry]
  }
  const firstDerived = queue.findIndex(isDerivedEntry)
  if (firstDerived < 0) return [...queue, entry]
  return [...queue.slice(0, firstDerived), entry, ...queue.slice(firstDerived)]
}

/**
 * The entries one turn boundary takes. People go first: when any person's
 * entry waits, the boundary takes every person's entry and leaves the derived
 * ones for the boundary after that turn. Otherwise it takes every derived
 * entry, which become one brief.
 */
export function takeBoundaryBatch<T extends SteerQueueEntryShape>(
  queue: readonly T[]
): { batch: T[]; rest: T[]; origin: SteerOrigin } | null {
  if (queue.length === 0) return null
  const people = queue.filter((entry) => !isDerivedEntry(entry))
  if (people.length > 0) {
    return { batch: people, rest: queue.filter(isDerivedEntry), origin: "person" }
  }
  return { batch: [...queue], rest: [], origin: "derived" }
}

const SOURCE_LABEL: Record<DerivedSteerSource, string> = {
  review: "Review",
  ci: "CI",
  job: "Job",
  wakeup: "Wakeup",
  completion: "Completed",
  automation: "Update",
}

/**
 * One brief from several derived inputs, read by the model (not shown as the
 * person's words). Blank inputs are dropped; a single input is passed through
 * under its label so a lone update reads the same as one of several.
 */
export function frameDerivedBrief(
  inputs: readonly { source?: DerivedSteerSource; text: string }[]
): string {
  const lines = inputs
    .map((input) => ({ ...input, text: input.text.trim() }))
    .filter((input) => input.text.length > 0)
    .map((input) => `[${SOURCE_LABEL[input.source ?? "automation"]}] ${input.text}`)
  if (lines.length === 0) return ""
  return [
    "Updates that arrived while you were working (not from the person; read them as context):",
    ...lines,
  ].join("\n\n")
}

/** The producer a drained derived brief is stamped with (ADR-0239). */
export function derivedBriefProducer(
  entries: readonly { automatedTurn?: AutomatedTurnProducer }[]
): AutomatedTurnProducer {
  return entries.find((entry) => entry.automatedTurn)?.automatedTurn ?? "background-result"
}

type WebSearchContext = NonNullable<SendOptions["webSearchContext"]>

/** Merge sources from several pre-searched follow-ups without duplicating URLs. */
export function mergeSteerWebSearchContexts(
  contexts: Array<SendOptions["webSearchContext"]>
): SendOptions["webSearchContext"] {
  const available = contexts.filter((context): context is WebSearchContext => Boolean(context))
  if (available.length === 0) return undefined
  const byUrl = new Map<string, WebSearchContext["results"][number]>()
  for (const context of available) {
    for (const result of context.results) {
      if (!byUrl.has(result.url)) byUrl.set(result.url, result)
    }
  }
  // `provider` is a single provider id everywhere else that writes it — the UI
  // renders it as one ("via {provider}") and callers compare it to a known id.
  // Joining several into "tavily, brave" produced a value that is not an id at
  // all, so keep the first contributor's rather than inventing a compound one.
  return { provider: available[0].provider, results: [...byUrl.values()] }
}

/**
 * The reference fields a drained steer turn carries: every queued entry's
 * citations merged into one list, and their envelope summaries folded into
 * one — the drained payload is a single turn, so it claims every record any
 * of its entries cited.
 *
 * The replay needs these on a REMOTE lane (a companion's `room_send` drain),
 * where the host writes the persisted row from what the RPC carries. Locally
 * each entry's optimistic bubble already holds the same metadata.
 */
export interface SteerDrainReferences {
  localAuthorization?: LocalPersonRun
  attachmentManifest?: AttachmentManifestEntry[]
  citations?: ContextRef[]
  promptPreamble?: PromptPreambleSummary
  /** Set when the drained turn is a derived brief: it is not the person's instruction. */
  automatedTurn?: AutomatedTurnProducer
}

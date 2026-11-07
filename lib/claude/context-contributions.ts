/**
 * System-prompt sections that feature modules contribute to a run (ADR-0250
 * §14 `context` amendment).
 *
 * A module names a `context` file in its manifest; the generated registry
 * `lib/modules/generated/context.ts` lists those files lazily, so the resolver
 * imports no module. {@link collectContextContributions} runs every active
 * contribution concurrently, each under its own deadline, and returns the
 * sections already placed:
 *
 * - a `"turn"` section goes to the dynamic tail when cache optimization is on
 *   and to its slot when it is off; one without a slot always goes to the
 *   tail. A `"session"` section always goes to its slot.
 * - the tail lists turn sections in slot order, then the slot-less ones, each
 *   group in module id order and then manifest order, so a migrated section
 *   keeps the position its kernel branch gave it.
 * - every section passes the PII gate unless its contribution declares the
 *   text redacted at the source; one that leaks is dropped with its sources.
 * - context only adds: a contribution file that does not load, a throw, the
 *   deadline or a malformed section leaves that part out and is reported.
 *
 * The caller puts the slot sections into `systemPrompt`, the tail into the
 * dynamic tail, the sources into `SendOptions.contextSources` (read back with
 * `contextSourcesOf`, `./context-sources.ts`) and the session state into
 * `lib/claude/context-session-state.ts`.
 */

import { hasNoLeakingPii } from "@cognia/redact"
import { loggers } from "@cognia/logging"
import { MODULE_CONTEXT_CONTRIBUTIONS } from "@/lib/modules/generated/context"
import type {
  ContextContribution,
  ContextSlot,
  ContextTurnContext,
  ModuleContextEntry,
} from "@/lib/modules/manifest-types"

/** The slots, in the order `systemPrompt` holds them. */
export const CONTEXT_SLOTS: readonly ContextSlot[] = [
  "project-goal",
  "memory",
  "continuity",
  "project-knowledge",
  "agent-knowledge",
]

/** How long a contribution may take when it names no deadline of its own. */
export const CONTEXT_CONTRIBUTION_DEADLINE_MS = 2_000
/** The longest deadline a contribution may name. */
export const CONTEXT_CONTRIBUTION_MAX_DEADLINE_MS = 15_000

/** A contribution, a module or a section left out of a run, and why. */
export interface SkippedContextContribution {
  /** `<module>.<id>`, or the module id when its file did not load. */
  key: string
  error: unknown
}

export interface CollectedContext {
  /** Sections for each slot of `systemPrompt`, in module id and then manifest order. */
  slots: Partial<Record<ContextSlot, string[]>>
  /** Sections for the dynamic tail, in placement order. */
  tail: string[]
  /** What each contribution reported for the UI, by `<module>.<id>`. */
  sources: Record<string, unknown>
  /** What each contribution left for its module's tools, by `<module>.<id>`. */
  sessionState: Map<string, unknown>
  skipped: SkippedContextContribution[]
}

interface LoadedContribution {
  /** `<module>.<id>`. */
  key: string
  contribution: ContextContribution
}

const loaded = new Map<string, readonly LoadedContribution[]>()
const loading = new Map<string, Promise<readonly LoadedContribution[]>>()

function checkShape(module: string, list: unknown): readonly LoadedContribution[] {
  if (!Array.isArray(list)) throw new Error(`${module}: \`contributions\` is not a list`)
  const ids = new Set<string>()
  return list.map((item: ContextContribution) => {
    if (!item || typeof item.id !== "string" || item.id.length === 0)
      throw new Error(`${module}: a contribution has no id`)
    if (ids.has(item.id)) throw new Error(`${module}: contribution "${item.id}" is listed twice`)
    ids.add(item.id)
    const name = `${module}.${item.id}`
    if (item.cache !== "turn" && item.cache !== "session")
      throw new Error(`${name}: cache is "turn" or "session"`)
    if (item.slot !== undefined && !CONTEXT_SLOTS.includes(item.slot))
      throw new Error(`${name}: unknown slot "${String(item.slot)}"`)
    if (item.cache === "session" && item.slot === undefined)
      throw new Error(`${name}: a "session" section names its slot`)
    if (item.pii !== undefined && item.pii !== "gate" && item.pii !== "redacted-at-source")
      throw new Error(`${name}: pii is "gate" or "redacted-at-source"`)
    if (
      item.deadlineMs !== undefined &&
      !(typeof item.deadlineMs === "number" && item.deadlineMs > 0)
    )
      throw new Error(`${name}: deadlineMs is a positive number`)
    if (typeof item.produce !== "function") throw new Error(`${name}: produce is not a function`)
    return { key: name, contribution: item }
  })
}

/** A module's contributions, loaded once; a failed load is retried by the next resolution. */
function loadModule(entry: ModuleContextEntry): Promise<readonly LoadedContribution[]> {
  const known = loaded.get(entry.module)
  if (known) return Promise.resolve(known)
  let pending = loading.get(entry.module)
  if (!pending) {
    pending = entry
      .load()
      .then(({ contributions }) => {
        const list = checkShape(entry.module, contributions)
        loaded.set(entry.module, list)
        return list
      })
      .finally(() => loading.delete(entry.module))
    loading.set(entry.module, pending)
  }
  return pending
}

function withDeadline<T>(work: () => T | Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer within ${ms} ms`)), ms)
  })
  return Promise.race([Promise.resolve().then(work), deadline]).finally(() => {
    if (timer !== undefined) clearTimeout(timer)
  })
}

function deadlineOf(contribution: ContextContribution, fallbackMs: number): number {
  return Math.min(contribution.deadlineMs ?? fallbackMs, CONTEXT_CONTRIBUTION_MAX_DEADLINE_MS)
}

function report(result: CollectedContext, key: string, error: unknown): void {
  loggers.agent.warn("context contribution skipped", {
    contribution: key,
    error: error instanceof Error ? error.message : String(error),
  })
  result.skipped.push({ key, error })
}

/**
 * What every active module contributes to this run, already placed for the
 * run's cache optimization setting. Never throws.
 */
export async function collectContextContributions(
  ctx: ContextTurnContext,
  options: { cacheOptimization: boolean },
  entries: readonly ModuleContextEntry[] = MODULE_CONTEXT_CONTRIBUTIONS,
  deadlineMs: number = CONTEXT_CONTRIBUTION_DEADLINE_MS
): Promise<CollectedContext> {
  const result: CollectedContext = {
    slots: {},
    tail: [],
    sources: {},
    sessionState: new Map(),
    skipped: [],
  }
  const active = entries.filter((entry) => entry.stage !== "experimental")
  if (active.length === 0) return result

  const modules = await Promise.allSettled(
    active.map((entry) => withDeadline(() => loadModule(entry), deadlineMs))
  )
  const contributions: LoadedContribution[] = []
  modules.forEach((outcome, index) => {
    if (outcome.status === "fulfilled") contributions.push(...outcome.value)
    else report(result, active[index].module, outcome.reason)
  })

  const produced = await Promise.allSettled(
    contributions.map(({ contribution }) =>
      withDeadline(() => contribution.produce(ctx), deadlineOf(contribution, deadlineMs))
    )
  )
  const tail: { rank: number; text: string }[] = []
  produced.forEach((outcome, index) => {
    const { key, contribution } = contributions[index]
    if (outcome.status === "rejected") return report(result, key, outcome.reason)
    const section = outcome.value
    if (section === null || section === undefined) return
    if (typeof section !== "object" || typeof section.text !== "string")
      return report(result, key, new Error(`${key}: the section has no text`))
    if (section.sessionState !== undefined) result.sessionState.set(key, section.sessionState)
    const text = section.text.trim()
    if (contribution.pii !== "redacted-at-source" && text && !hasNoLeakingPii(text))
      return report(result, key, new Error(`${key}: the section leaks PII; left out`))
    if (section.sources !== undefined) result.sources[key] = section.sources
    if (!text) return
    const slot = contribution.slot
    if (contribution.cache === "turn" && (options.cacheOptimization || slot === undefined)) {
      tail.push({
        rank: slot === undefined ? CONTEXT_SLOTS.length : CONTEXT_SLOTS.indexOf(slot),
        text,
      })
      return
    }
    // A "session" section always names its slot (checked on load).
    const placed = slot as ContextSlot
    ;(result.slots[placed] ??= []).push(text)
  })
  // Stable: within one rank, module id and then manifest order.
  result.tail = tail.sort((a, b) => a.rank - b.rank).map((entry) => entry.text)
  return result
}

/** Test helper: forget every loaded contribution file. */
export function __resetContextContributionsForTests(): void {
  loaded.clear()
  loading.clear()
}

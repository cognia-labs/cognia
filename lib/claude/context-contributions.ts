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
 * - a contribution that names `after` runs once the one it waits for (same
 *   module, one level) settles, reading its `handoff` as `ctx.prior`; its own
 *   deadline starts then.
 * - an `identity` section (one module at most) runs before all the others and
 *   replaces the base system prompt: whole, or its stable part with the
 *   dynamic part at the head of the tail when cache optimization is on. The
 *   redacted texts it hands over reach every other contribution as
 *   `ctx.kernelRetrieval.identityTexts`; one that leaks PII hands over nothing.
 * - context only adds: a contribution file that does not load, a throw, the
 *   deadline or a malformed section leaves that part out and is reported.
 *
 * The caller puts the identity in place of the base system prompt (leaving
 * the persona section out), the slot sections into `systemPrompt`, the tail into the
 * dynamic tail, the sources into `SendOptions.contextSources` (read back with
 * `contextSourcesOf`, `./context-sources.ts`) and the session state into
 * `lib/claude/context-session-state.ts`.
 */

import { hasNoLeakingPii } from "@cognia/redact"
import { loggers } from "@cognia/logging"
import { MODULE_CONTEXT_CONTRIBUTIONS } from "@/lib/modules/generated/context"
import type {
  ContextContribution,
  ContextSection,
  ContextSlot,
  ContextTurnContext,
  ModuleContextEntry,
} from "@/lib/modules/manifest-types"

/** The slot that replaces the base system prompt rather than joining `systemPrompt`. */
export const IDENTITY_SLOT = "identity" satisfies ContextSlot

/** The slots placed in `systemPrompt`, in the order it holds them. */
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
  /**
   * What replaces the base system prompt (the persona section is left out
   * with it), already split for the cache setting; absent when no identity
   * section applied.
   */
  identity?: string
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
  const checked = list.map((item: ContextContribution): LoadedContribution => {
    if (!item || typeof item.id !== "string" || item.id.length === 0)
      throw new Error(`${module}: a contribution has no id`)
    if (ids.has(item.id)) throw new Error(`${module}: contribution "${item.id}" is listed twice`)
    ids.add(item.id)
    const name = `${module}.${item.id}`
    if (item.cache !== "turn" && item.cache !== "session")
      throw new Error(`${name}: cache is "turn" or "session"`)
    if (
      item.slot !== undefined &&
      item.slot !== IDENTITY_SLOT &&
      !CONTEXT_SLOTS.includes(item.slot)
    )
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
    if (item.after !== undefined && (typeof item.after !== "string" || item.after === item.id))
      throw new Error(`${name}: after names another contribution of the module`)
    if (item.slot === IDENTITY_SLOT && item.after !== undefined)
      throw new Error(`${name}: an identity section runs first and waits for nothing`)
    if (typeof item.produce !== "function") throw new Error(`${name}: produce is not a function`)
    return { key: name, contribution: item }
  })
  // `after` is one level within the module, so it can never form a cycle.
  const byId = new Map(checked.map((entry) => [entry.contribution.id, entry.contribution]))
  for (const { key, contribution } of checked) {
    if (contribution.after === undefined) continue
    const waited = byId.get(contribution.after)
    if (!waited)
      throw new Error(`${key}: after names "${contribution.after}", which the module does not list`)
    if (waited.after !== undefined)
      throw new Error(
        `${key}: after names "${contribution.after}", which waits itself; one level only`
      )
    if (waited.slot === IDENTITY_SLOT)
      throw new Error(
        `${key}: after names "${contribution.after}", an identity section; read ctx.kernelRetrieval`
      )
  }
  return checked
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

/** What a settled section handed over; nothing from a malformed one. */
function handoffOf(section: unknown): unknown {
  return section !== null &&
    typeof section === "object" &&
    typeof (section as ContextSection).text === "string"
    ? (section as ContextSection).handoff
    : undefined
}

/** The redacted texts an identity section handed over; nothing that is not a list of strings. */
function identityTextsOf(section: ContextSection): string[] {
  return Array.isArray(section.handoff)
    ? section.handoff.filter((text): text is string => typeof text === "string")
    : []
}

function leaks(contribution: ContextContribution, ...texts: string[]): boolean {
  return (
    contribution.pii !== "redacted-at-source" &&
    texts.some((text) => text.trim() !== "" && !hasNoLeakingPii(text))
  )
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

  // The identity section runs first: every other contribution may read what
  // it retrieved. One module at most declares it (the module gate checks);
  // should two load, the first in module id order stands.
  const identities = contributions.filter((entry) => entry.contribution.slot === IDENTITY_SLOT)
  for (const extra of identities.slice(1))
    report(result, extra.key, new Error(`${extra.key}: another module's identity section stands`))
  const others = contributions.filter((entry) => entry.contribution.slot !== IDENTITY_SLOT)
  let turnCtx = ctx
  let identityTail: string | undefined
  const identity = identities[0]
  if (identity) {
    const placed = await placeIdentity(identity, ctx, options, deadlineMs, result)
    if (placed) {
      if (placed.base !== undefined) result.identity = placed.base
      identityTail = placed.tail
      if (placed.texts.length > 0)
        turnCtx = {
          ...ctx,
          kernelRetrieval: {
            identityTexts: [...ctx.kernelRetrieval.identityTexts, ...placed.texts],
          },
        }
    }
  }

  // Independent contributions start together; one that names `after` starts
  // when the one it waits for settles, with that one's handoff as `prior`.
  const running = new Map<string, Promise<ContextSection | null>>()
  const start = ({ key, contribution }: LoadedContribution): Promise<ContextSection | null> => {
    const known = running.get(key)
    if (known) return known
    const run = (prior: unknown) =>
      withDeadline(
        () => contribution.produce(prior === undefined ? turnCtx : { ...turnCtx, prior }),
        deadlineOf(contribution, deadlineMs)
      )
    let pending: Promise<ContextSection | null>
    if (contribution.after === undefined) pending = run(undefined)
    else {
      const owner = key.slice(0, key.length - contribution.id.length - 1)
      const waited = others.find(
        (entry) => entry.key === `${owner}.${contribution.after}`
      ) as LoadedContribution
      pending = start(waited).then(
        (section) => run(handoffOf(section)),
        () => run(undefined)
      )
    }
    running.set(key, pending)
    return pending
  }
  const produced = await Promise.allSettled(others.map(start))
  const tail: { rank: number; text: string }[] = []
  produced.forEach((outcome, index) => {
    const { key, contribution } = others[index]
    if (outcome.status === "rejected") return report(result, key, outcome.reason)
    const section = outcome.value
    if (section === null || section === undefined) return
    if (typeof section !== "object" || typeof section.text !== "string")
      return report(result, key, new Error(`${key}: the section has no text`))
    if (section.sessionState !== undefined) result.sessionState.set(key, section.sessionState)
    const text = section.text.trim()
    if (leaks(contribution, text))
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
  // Stable: within one rank, module id and then manifest order. The
  // identity's dynamic part comes first, where the kernel's twin block put it.
  result.tail = [
    ...(identityTail ? [identityTail] : []),
    ...tail.sort((a, b) => a.rank - b.rank).map((entry) => entry.text),
  ]
  return result
}

/**
 * Run the identity section and place it: the base system prompt it replaces,
 * the part for the tail, and the redacted texts it retrieved. `null` when it
 * does not apply or is left out (reported); no `base` when it applied with
 * no text.
 */
async function placeIdentity(
  { key, contribution }: LoadedContribution,
  ctx: ContextTurnContext,
  options: { cacheOptimization: boolean },
  deadlineMs: number,
  result: CollectedContext
): Promise<{ base?: string; tail?: string; texts: string[] } | null> {
  let section: ContextSection | null
  try {
    section = await withDeadline(
      () => contribution.produce(ctx),
      deadlineOf(contribution, deadlineMs)
    )
  } catch (error) {
    report(result, key, error)
    return null
  }
  if (section === null || section === undefined) return null
  if (typeof section !== "object" || typeof section.text !== "string") {
    report(result, key, new Error(`${key}: the section has no text`))
    return null
  }
  if (section.sessionState !== undefined) result.sessionState.set(key, section.sessionState)
  const split =
    section.cacheSplit &&
    typeof section.cacheSplit.stable === "string" &&
    typeof section.cacheSplit.dynamic === "string"
      ? section.cacheSplit
      : undefined
  if (leaks(contribution, section.text, split?.stable ?? "", split?.dynamic ?? "")) {
    report(result, key, new Error(`${key}: the section leaks PII; left out`))
    return null
  }
  if (section.sources !== undefined) result.sources[key] = section.sources
  // What it retrieved counts even when it replaces nothing.
  const texts = identityTextsOf(section)
  if (!section.text.trim()) return { texts }
  if (options.cacheOptimization && split?.stable.trim() && split.dynamic.trim())
    return { base: split.stable, tail: split.dynamic.trim(), texts }
  return { base: section.text, texts }
}

/** Test helper: forget every loaded contribution file. */
export function __resetContextContributionsForTests(): void {
  loaded.clear()
  loading.clear()
}

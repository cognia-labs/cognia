/**
 * Plugin Agent SDK — context/memory provider runtime + guarded reads
 * (Package E).
 *
 * - `resolveContextContributions` runs every registered context provider for a
 *   turn and joins their non-empty outputs; the run runtime appends the result
 *   to the system prompt (channel-agnostic).
 * - `readSharedMemory` projects a team's ACL-readable shared-memory entries.
 * - `queryTwinMemory` retrieves RAG chunks from an employee twin (reusing the
 *   chat twin runtime; PII is vetted at ingest).
 *
 * Permission-agnostic: the read gates (agent:shared-memory:read / twin:read)
 * live in `context.ts`. Heavy deps are lazy-imported.
 */

import { loggers } from "@cognia/logging"
import { listContextProviderEntries } from "@/lib/plugin/registries/context-provider-registry"
import {
  preparePersonalHistory,
  withPersonalRerankerVisibility,
} from "@/lib/execution/personal-visibility"
import type { PersonalCredentialContext } from "@/lib/execution/personal-credential"
import type {
  PluginContextProviderInput,
  PluginSharedMemoryReadEntry,
  PluginSharedMemoryReadOptions,
  PluginTwinMemoryChunk,
  PluginTwinMemoryQueryOptions,
} from "@/types/plugin/plugin-context-provider"

/** How long one context provider may take before the run goes on without it. */
export const PLUGIN_CONTEXT_PROVIDER_DEADLINE_MS = 5_000
/** The longest contribution one provider may make, in characters (≈4k tokens). */
export const PLUGIN_CONTEXT_PROVIDER_MAX_CHARS = 16_000
/** The most all of a plugin's providers may add to one run, in characters. */
export const PLUGIN_CONTEXT_MAX_CHARS = 32_000

export interface ContextContributionLimits {
  /** The run's signal: once it aborts, preparation stops waiting and rejects with its reason. */
  signal?: AbortSignal
  deadlineMs?: number
  maxProviderChars?: number
  maxTotalChars?: number
}

/** Why one provider contributed nothing to this run. */
type Outcome = { text: string } | { skipped: "empty" | "failed" | "timed-out" | "too-large" }

function settleWithin(work: () => unknown, ms: number): Promise<Outcome> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<Outcome>((resolve) => {
    timer = setTimeout(() => resolve({ skipped: "timed-out" }), ms)
  })
  const produced = Promise.resolve()
    .then(work)
    .then(
      (out): Outcome =>
        typeof out === "string" && out.trim().length > 0
          ? { text: out.trim() }
          : { skipped: "empty" },
      (): Outcome => ({ skipped: "failed" })
    )
  return Promise.race([produced, deadline]).finally(() => clearTimeout(timer))
}

/** `work`, unless `signal` aborts first; then its reason. */
function unlessAborted<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return work
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason)
    if (signal.aborted) return abort()
    signal.addEventListener("abort", abort, { once: true })
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort))
  })
}

/**
 * Run the context providers the RUNNING plugin registered and join their
 * contributions. A provider feeds its own plugin's agent runs: this used to
 * run every plugin's providers for every run, so one plugin's ambient context
 * (its notes, its shared-memory projection, its twin chunks) was appended to
 * the system prompt of another plugin's model call. A run with no owning
 * plugin gets no provider context. Returns an empty string when nothing is
 * contributed.
 *
 * Providers run concurrently and the joined output keeps registration order.
 * Each one is bounded, because the run cannot start until this returns:
 *   - a provider that throws, or has not answered within
 *     {@link PLUGIN_CONTEXT_PROVIDER_DEADLINE_MS}, is left out (one bad
 *     provider never breaks or stalls the run; the contract passes it no
 *     signal, so a late answer is simply discarded);
 *   - a contribution longer than {@link PLUGIN_CONTEXT_PROVIDER_MAX_CHARS}, or
 *     one that no longer fits the run's {@link PLUGIN_CONTEXT_MAX_CHARS}, is
 *     left out whole: cut context reads as complete and misleads the model;
 *   - an aborted run signal (the caller's cancel, the run timeout, a Job
 *     Center stop) ends the wait at once and rejects with its reason, so the
 *     run settles instead of waiting on a provider that never answers.
 * Every omission is logged with the provider and the reason.
 */
export async function resolveContextContributions(
  input: PluginContextProviderInput,
  pluginId: string | undefined,
  {
    signal,
    deadlineMs = PLUGIN_CONTEXT_PROVIDER_DEADLINE_MS,
    maxProviderChars = PLUGIN_CONTEXT_PROVIDER_MAX_CHARS,
    maxTotalChars = PLUGIN_CONTEXT_MAX_CHARS,
  }: ContextContributionLimits = {}
): Promise<string> {
  if (!pluginId) return ""
  signal?.throwIfAborted()
  const entries = listContextProviderEntries().filter((entry) => entry.pluginId === pluginId)
  if (entries.length === 0) return ""
  const outcomes = await unlessAborted(
    Promise.all(entries.map(({ entry }) => settleWithin(() => entry.provide(input), deadlineMs))),
    signal
  )
  const parts: string[] = []
  let used = 0
  outcomes.forEach((outcome, index) => {
    let skipped = "skipped" in outcome ? outcome.skipped : undefined
    if ("text" in outcome) {
      const cost = outcome.text.length + (parts.length > 0 ? 2 : 0)
      if (outcome.text.length > maxProviderChars || used + cost > maxTotalChars)
        skipped = "too-large"
      else {
        parts.push(outcome.text)
        used += cost
      }
    }
    if (skipped && skipped !== "empty")
      loggers.plugin.warn("plugin context provider left out of the run", {
        pluginId,
        provider: entries[index]!.id,
        reason: skipped,
        ...(skipped === "too-large" && "text" in outcome ? { chars: outcome.text.length } : {}),
      })
  })
  return parts.join("\n\n")
}

/** Project a team's ACL-readable shared-memory entries (operator view). */
export async function readSharedMemory(
  teamId: string,
  options: PluginSharedMemoryReadOptions = {},
  host?: Pick<PersonalCredentialContext, "sessionId" | "executionRunId">
): Promise<PluginSharedMemoryReadEntry[]> {
  const [{ useAgentTeamStore }, selectors] = await Promise.all([
    import("@/stores/squads/agent-team-store/store"),
    import("@/stores/squads/agent-team-store/selectors"),
  ])
  const entries = selectors.selectSharedMemoryEntriesForReader(
    teamId,
    selectors.OPERATOR_READER_ID
  )(useAgentTeamStore.getState())
  const tagFilter = options.tags
  const selected = entries
    .filter((e) =>
      tagFilter && tagFilter.length > 0 ? (e.tags ?? []).some((t) => tagFilter.includes(t)) : true
    )
    .map((e) => ({
      key: e.key,
      value: e.value,
      writtenBy: e.writtenBy,
      ...(e.writerName ? { writerName: e.writerName } : {}),
      version: e.version,
      ...(e.tags ? { tags: e.tags } : {}),
    }))
  const { filterSharedMemoryEntriesForRun } =
    await import("@/lib/squads/memory/shared-memory-orchestrator")
  return filterSharedMemoryEntriesForRun(teamId, selected, host ?? {})
}

/**
 * Query the employee twin's RAG store for a character. Returns retrieved
 * chunks; degrades to `[]` when the character is not twin-bound or the twin
 * runtime is unavailable (never throws).
 */
export async function queryTwinMemory(
  characterId: string,
  query: string,
  options: PluginTwinMemoryQueryOptions = {},
  host?: Pick<PersonalCredentialContext, "sessionId" | "executionRunId">
): Promise<PluginTwinMemoryChunk[]> {
  if (typeof query !== "string" || !query.trim()) return []
  try {
    const projection = await preparePersonalHistory(
      host?.sessionId,
      [
        {
          id: "twin",
          metadata: {
            personalMarks: [
              { person: { kind: "local-person" }, source: "twin-history", markedAt: 0 },
            ],
          },
        },
      ],
      { executionRunId: host?.executionRunId }
    )
    if (projection.withheldMessageIds.length) return []
    const { getCharacter } = await import("@/lib/db/characters")
    const character = await getCharacter(characterId)
    if (!character?.twinId) return []
    const [{ tryBuildTwinDeps }, { applyTwinContext }] = await Promise.all([
      import("@/lib/twin/runtime/build-deps"),
      import("@/lib/twin/runtime/apply-twin-context"),
    ])
    const deps = await tryBuildTwinDeps()
    if (!deps) return []
    // Honor an explicit topK by overriding the character's ragTopK setting.
    const scoped =
      typeof options.topK === "number" && options.topK > 0
        ? {
            ...character,
            twinSettings: { ...(character.twinSettings ?? {}), ragTopK: options.topK },
          }
        : character
    const result = await applyTwinContext({
      character: scoped,
      userMessage: query,
      deps: {
        ...deps,
        reranker: withPersonalRerankerVisibility(deps.reranker, host ?? {}),
      } as unknown as Parameters<typeof applyTwinContext>[0]["deps"],
    })
    const current = await preparePersonalHistory(host?.sessionId, projection.messages, {
      executionRunId: host?.executionRunId,
    })
    if (current.withheldMessageIds.length) return []
    return result.retrievedChunks.map((c) => ({
      content: c.chunk.contentRedacted,
      score: c.score,
      ...(c.sourceTitle ? { sourceTitle: c.sourceTitle } : {}),
    }))
  } catch {
    return []
  }
}

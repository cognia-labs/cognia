// Cross-provider deferred tool discovery for the AI SDK dispatch path.
//
// The Anthropic Agent SDK natively understands `alwaysLoad` and ToolSearch.
// AI SDK providers instead receive one flat tool map, but AI SDK 6 exposes
// `prepareStep({ ... }) → { activeTools }`. This controller uses that seam to
// keep only essential tools resident, then activates permitted tools after the
// model discovers them through ToolSearch. It only sees the already-filtered,
// permission-gated tool map, so discovery cannot reintroduce denied tools.
//
// It is also how a session stays under a provider's per-request tool cap
// (`maxActiveTools`): the dispatcher forces the controller on when the session
// owns more tools than the cap allows, keeps the most important ones resident,
// and unloads the least recently discovered tool when discovery would cross it.

import { tool } from "ai"
import type { ToolSet } from "ai"
import { z } from "zod"
import { modelToolName, restoreToolName } from "../../policy/tool-catalog/model-names.ts"
import type { ConversationMessage } from "../../shared/wire/conversation.ts"

export const AI_SDK_TOOL_SEARCH_NAME = "ToolSearch"

/** Where one AI SDK tool came from, for deciding whether it stays resident. */
export interface AiSdkToolSource {
  serverName?: string | undefined
  alwaysLoad?: boolean | undefined
}

/** The send options the controller reads. */
export interface ToolSearchSendOptions {
  toolSearchEnabled?: unknown
  alwaysLoadServers?: unknown
  alwaysLoadTools?: unknown
}

export interface AiSdkToolSearchController {
  /** Every tool plus ToolSearch, in sorted-key order. */
  tools: ToolSet
  /** ToolSearch, the resident tools, and the tools discovery has activated. */
  activeToolNames(): string[]
  prepareStep(): { activeTools: string[] }
  /** Tools that start deferred (not resident), sorted; discoverable by ToolSearch. */
  deferredToolNames(): string[]
  /** Model-facing instructions naming the deferred tools, or null when none are. */
  deferredToolsPrompt(): string | null
  /** The cap on active tools (ToolSearch included), or null when uncapped. */
  maxActiveTools(): number | null
  /** Tighten the cap, demoting resident tools and unloading discoveries to fit. */
  setMaxActiveTools(limit: number): void
  /** Restore successful discoveries without executing tools or reviving denied tools. */
  restoreConversation(messages: ConversationMessage[]): void
}

const TOOL_SOURCE = new WeakMap<object, AiSdkToolSource>()

/** Attach non-serializing discovery metadata to one AI SDK tool object. */
export function markAiSdkToolSource<T>(aiTool: T, source: AiSdkToolSource): T {
  if (aiTool && (typeof aiTool === "object" || typeof aiTool === "function")) {
    TOOL_SOURCE.set(aiTool, { ...source })
  }
  return aiTool
}

function inferredServerName(toolName: string): string | undefined {
  const match = /^mcp__(.+?)__/.exec(toolName)
  return match?.[1]
}

function configuredToolMatches(
  configured: ReadonlySet<string>,
  name: string,
  source: AiSdkToolSource | undefined
): boolean {
  if (configured.has(name)) return true
  return source?.serverName ? configured.has(`mcp__${source.serverName}__${name}`) : false
}

const CJK_RUN_PATTERN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu

function tokenizeQueryTerms(normalized: string): string[] {
  const tokens = new Set<string>()
  for (const word of normalized.split(/[^\p{L}\p{N}_:-]+/u)) {
    if (!word) continue
    const cjkRuns = [...word.matchAll(CJK_RUN_PATTERN)].map((match) => match[0])
    if (cjkRuns.length === 0) {
      tokens.add(word)
      continue
    }
    // Keep non-CJK sub-segments (e.g. "v2订单" -> "v2" + CJK n-grams) and emit
    // character bigrams for unspaced CJK text (or single char for 1-char runs).
    for (const nonCjk of word.split(CJK_RUN_PATTERN)) {
      if (nonCjk) tokens.add(nonCjk)
    }
    for (const run of cjkRuns) {
      const chars = [...run]
      if (chars.length === 1) {
        tokens.add(chars[0]!)
      } else {
        for (let i = 0; i < chars.length - 1; i += 1) {
          tokens.add(`${chars[i]!}${chars[i + 1]!}`)
        }
      }
    }
  }
  return [...tokens]
}

function scoreCandidate(name: string, description: unknown, query: string): number {
  const normalized = query.trim().toLowerCase()
  if (!normalized) return 0
  const lowerName = name.toLowerCase()
  const lowerDesc = String(description ?? "").toLowerCase()
  const haystack = `${lowerName} ${lowerDesc}`
  if (lowerName === normalized) return 1_000
  if (lowerName.includes(normalized)) return 500

  const phraseBonus = lowerDesc.includes(normalized) ? 150 : 0
  const terms = tokenizeQueryTerms(normalized)
  const hits = terms.filter((term) => haystack.includes(term))
  if (hits.length === 0) return phraseBonus
  const nameHits = hits.filter((term) => lowerName.includes(term)).length
  return phraseBonus + hits.length * 20 + nameHits * 10 + (hits.length === terms.length ? 100 : 0)
}

/**
 * Discovery slots kept free under a cap, so a session whose resident tools
 * alone would fill it can still load a tool on demand.
 */
function discoveryHeadroom(cap: number): number {
  return Math.min(8, Math.floor((cap - 1) / 2))
}

function searchCandidates(
  tools: ToolSet,
  query: string,
  limit: number
): { name: string; description: string; score: number }[] {
  return Object.entries(tools)
    .filter(([name]) => name !== AI_SDK_TOOL_SEARCH_NAME)
    .map(([name, value]) => ({
      name,
      description: String(value?.description ?? ""),
      score: scoreCandidate(name, value?.description, query),
    }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, limit)
}

/**
 * Build one session-scoped ToolSearch controller, or null when the send has
 * not enabled deferred tool loading and `force` is not set.
 */
export function createAiSdkToolSearchController({
  tools,
  sendOptions = {},
  toolNameAliases = undefined,
  force = false,
  maxActiveTools = null,
  residentTools = [],
}: {
  tools?: ToolSet | null | undefined
  sendOptions?: ToolSearchSendOptions
  /** Model-facing name → cognia name, for tools renamed for the provider. */
  toolNameAliases?: ReadonlyMap<string, string> | null | undefined
  /** Build even though the send did not enable tool search (a tool cap needs it). */
  force?: boolean
  /** Most tools one request may carry, ToolSearch included; null for no cap. */
  maxActiveTools?: number | null
  /**
   * Tools to keep resident after the always-load ones, in priority order. A
   * cap that cannot hold every resident tool drops the end of this list first.
   */
  residentTools?: Iterable<string>
}): AiSdkToolSearchController | null {
  if (sendOptions.toolSearchEnabled !== true && !force) return null
  // Map keys are the provider-safe names the model will call; `alwaysLoadTools`
  // and `select:` requests may still use the cognia name they were written with.
  const aliases: ReadonlyMap<string, string> =
    toolNameAliases instanceof Map ? toolNameAliases : new Map()

  const available: ToolSet = { ...(tools ?? {}) }
  // ToolSearch is bridge infrastructure and intentionally replaces a same-name
  // contributed tool. The name is reserved by the Agent runtime when deferred
  // loading is enabled, matching Claude Code's canonical discovery surface.
  delete available[AI_SDK_TOOL_SEARCH_NAME]
  const availableNames = Object.keys(available).sort()
  const alwaysLoadServers = new Set<string>(
    Array.isArray(sendOptions.alwaysLoadServers) ? sendOptions.alwaysLoadServers : []
  )
  const alwaysLoadTools = new Set<string>(
    Array.isArray(sendOptions.alwaysLoadTools) ? sendOptions.alwaysLoadTools : []
  )
  // Resident candidates in priority order: always-load tools first, then the
  // caller's resident list. Under a cap only a prefix of this stays resident.
  const residentOrder: string[] = []
  for (const name of availableNames) {
    const value = available[name]!
    const source = TOOL_SOURCE.get(value) ?? { serverName: inferredServerName(name) }
    if (
      source.alwaysLoad === true ||
      (source.serverName && alwaysLoadServers.has(source.serverName)) ||
      configuredToolMatches(alwaysLoadTools, name, source) ||
      configuredToolMatches(alwaysLoadTools, restoreToolName(aliases, name), source)
    ) {
      residentOrder.push(name)
    }
  }
  const extraResident = new Set<string>()
  for (const requested of residentTools) {
    const name = Object.hasOwn(available, requested) ? requested : modelToolName(aliases, requested)
    if (Object.hasOwn(available, name) && !residentOrder.includes(name)) extraResident.add(name)
  }
  residentOrder.push(...extraResident)

  let cap: number | null = null
  let resident = new Set<string>(residentOrder)
  // Discovered tools, least recently activated first.
  const discovered: string[] = []

  const applyCap = (): string[] => {
    if (cap === null) return []
    const residentCap = cap <= 1 ? 0 : Math.max(0, cap - 1 - discoveryHeadroom(cap))
    if (resident.size > residentCap) resident = new Set(residentOrder.slice(0, residentCap))
    const unloaded: string[] = []
    // Under cap === 1, a discovered tool temporarily takes the single request
    // slot (yielding ToolSearch until reset); for cap >= 2, ToolSearch stays
    // active alongside resident + discovered tools.
    const maxDiscovered = cap === 1 ? 1 : Math.max(0, cap - 1 - resident.size)
    while (discovered.length > maxDiscovered) {
      unloaded.push(discovered.shift()!)
    }
    return unloaded
  }
  const setCap = (limit: number | null) => {
    if (limit === null) return
    const next = Math.max(1, Math.floor(limit))
    cap = cap === null ? next : Math.min(cap, next)
    applyCap()
  }
  setCap(maxActiveTools)

  const searchTool = tool({
    description:
      "Search tools that are available to this Agent session but deferred from the current prompt. Calling ToolSearch activates the returned tools for later steps in this session. Use select:<tool_name>[,<tool_name>] for exact activation, or a short capability query for ranked discovery.",
    inputSchema: z.object({
      query: z
        .string()
        .min(1)
        .describe('Capability query or exact selector such as "select:write,git_commit".'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(8)
        .optional()
        .describe("Maximum matches to activate and return (default 5, max 8)."),
    }),
    execute: async ({ query, limit = 5 }) => {
      const exact = /^select\s*:/i.test(query)
      let matches: { name: string; description: string }[]
      let missing: string[] = []
      if (exact) {
        const requested = [
          ...new Set(
            query
              .replace(/^select\s*:/i, "")
              .split(/[\s,]+/)
              .map((name) => name.trim())
              .filter(Boolean)
              .map((name) => (Object.hasOwn(available, name) ? name : modelToolName(aliases, name)))
          ),
        ]
        matches = requested
          .filter((name) => Object.hasOwn(available, name))
          .sort()
          .slice(0, limit)
          .map((name) => ({ name, description: String(available[name]?.description ?? "") }))
        missing = requested.filter((name) => !Object.hasOwn(available, name)).sort()
      } else {
        matches = searchCandidates(available, query, limit).map(
          ({ score: _score, ...entry }) => entry
        )
      }

      // Keep `requested` in `matches` order (ranked best-first for free-text,
      // sorted for `select:`). Insert in reverse so the highest-ranked match
      // lands at the MRU tail and survives `applyCap()` under tight caps.
      const requested = matches.map((entry) => entry.name)
      const previouslyActive = new Set(discovered)
      for (const name of [...requested].reverse()) {
        if (resident.has(name)) continue
        const at = discovered.indexOf(name)
        if (at >= 0) discovered.splice(at, 1)
        discovered.push(name)
      }
      const evicted = applyCap()
      const unloaded = evicted.filter((name) => previouslyActive.has(name))
      const activated = requested.filter((name) => resident.has(name) || discovered.includes(name))
      return JSON.stringify({
        query,
        matches,
        activated,
        ...(missing.length ? { missing } : {}),
        // Under a tool cap, loading these unloaded the least recently used ones;
        // ToolSearch loads them again when they are needed.
        ...(unloaded.length ? { unloaded: unloaded.sort() } : {}),
      })
    },
  })

  const allTools = Object.fromEntries(
    [[AI_SDK_TOOL_SEARCH_NAME, searchTool], ...Object.entries(available)].sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0
    )
  )
  const activeToolNames = () => {
    const keepToolSearch = cap !== 1 || (resident.size === 0 && discovered.length === 0)
    return Object.keys(allTools).filter(
      (name) =>
        (name === AI_SDK_TOOL_SEARCH_NAME && keepToolSearch) ||
        resident.has(name) ||
        discovered.includes(name)
    )
  }
  const deferredToolNames = () => availableNames.filter((name) => !resident.has(name))

  return {
    tools: allTools,
    restoreConversation(messages) {
      discovered.length = 0
      for (const message of messages) {
        if (message.role !== "tool" || !Array.isArray(message.content)) continue
        for (const part of message.content) {
          if (part.type !== "tool-result" || part.toolName !== AI_SDK_TOOL_SEARCH_NAME) continue
          if (part.output.type !== "text") continue
          let result: { activated?: unknown; unloaded?: unknown }
          try {
            result = JSON.parse(part.output.value)
          } catch {
            continue
          }
          if (!result || !Array.isArray(result.activated)) continue
          for (const requested of result.activated) {
            if (typeof requested !== "string") continue
            const name = Object.hasOwn(available, requested)
              ? requested
              : modelToolName(aliases, requested)
            if (!Object.hasOwn(available, name) || resident.has(name)) continue
            const at = discovered.indexOf(name)
            if (at >= 0) discovered.splice(at, 1)
            discovered.push(name)
          }
          if (Array.isArray(result.unloaded)) {
            for (const name of result.unloaded) {
              const at = discovered.indexOf(name)
              if (at >= 0) discovered.splice(at, 1)
            }
          }
          applyCap()
        }
      }
    },
    activeToolNames,
    prepareStep: () => ({ activeTools: activeToolNames() }),
    deferredToolNames,
    deferredToolsPrompt: () => {
      const names = deferredToolNames()
      if (names.length === 0) return null
      const why =
        cap === null
          ? "Some tools are not loaded into this conversation up front."
          : `This provider accepts at most ${cap} tool definitions per request, so some tools are not loaded up front.`
      return [
        why,
        `Before calling one of them, load it with ${AI_SDK_TOOL_SEARCH_NAME} using "select:<name>[,<name>]", or search by capability with a short query.`,
        `Tools available through ${AI_SDK_TOOL_SEARCH_NAME}: ${names.join(", ")}.`,
      ].join(" ")
    },
    maxActiveTools: () => cap,
    setMaxActiveTools: (limit) => setCap(limit),
  }
}

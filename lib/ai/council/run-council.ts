/**
 * Council — fan one prompt out to several models ("councillors") in parallel,
 * then have a synthesizer model merge their answers into a single consensus
 * response with an agreement/confidence summary.
 *
 * Ported from oh-my-opencode-slim (`src/council/council-manager.ts`,
 * `src/agents/council.ts`) and adapted to cognia: councillors and the
 * synthesizer are addressed by ROUTING ALIASES (ADR-0043), so each call reuses
 * the same provider-routing engine the chat path uses — `runRoutedPrompt`
 * handles fallback chains, circuit breakers, and usage/cost telemetry.
 *
 * Both the `/council` slash command and the `ai.council` workflow node call
 * this one function. The synthesizer step is injectable (`deps.runPrompt`) so
 * the suite runs without touching real providers.
 *
 * What counts as a councillor's answer is the rule every aggregating surface
 * shares (`@cognia/agent-orchestration/aggregate`). The agreement rating is
 * the synthesizer's own, parsed from its report: councillors answer in free
 * text, so there are no ballots to tally. Agreement needs at least two
 * answers, so a council with fewer reports `unknown` whatever the synthesis
 * says: when every councillor failed, the synthesizer still answers the
 * prompt itself (the single-model fallback), and that answer agrees with no
 * one.
 */

import { boundedFanOut, type FanOutOutcome } from "@cognia/primitives/bounded-fan-out"
import { answerText } from "@cognia/agent-orchestration/aggregate"
import type { RoutedPromptLedger } from "@/lib/workflow/nodes/ai/ai-prompt-routed"
import { resolvePromptAsync } from "@/lib/prompts/resolve"
import { definePrompt } from "@/lib/prompts/types"

export type CouncilConfidence = "unanimous" | "majority" | "split" | "unknown"

export interface CouncillorSpec {
  /** Display name for this councillor (e.g. "alpha", "reviewer"). */
  name: string
  /** Routing alias resolved through the model-mapping registry. */
  modelAlias: string
  /** Optional role/steering prompt prepended to the user prompt. */
  systemPrompt?: string
}

export interface CouncilOptions {
  prompt: string
  councillors: CouncillorSpec[]
  /** Routing alias for the synthesizer model. */
  synthesizerAlias: string
  /** Extra synthesis guidance appended to the built-in instructions. */
  synthesisInstructions?: string
  /** Per-councillor timeout (ms). Default 180000 (omo-slim default). */
  timeoutMs?: number
  /** `parallel` (default) launches all councillors at once; `serial` one at a time. */
  executionMode?: "parallel" | "serial"
  /** Max concurrent councillors in parallel mode. Default 4. */
  maxConcurrency?: number
  /** How long a stopped councillor may take to settle before its slot is given back. */
  stopGraceMs?: number
  /**
   * Stops the council: running councillors are aborted, no other one starts
   * and the synthesizer is never called.
   */
  signal?: AbortSignal
}

export interface CouncillorResult {
  name: string
  model: string
  status: "completed" | "failed"
  text?: string
  error?: string
  /** Stopped (timed out) and still running when its slot was given back. */
  stopUnconfirmed?: true
}

export interface CouncilResult {
  /** The synthesizer's full markdown report (Response / Details / Summary). */
  markdown: string
  /** Best-effort consensus rating parsed from the synthesis (never thrown on). */
  confidence: CouncilConfidence
  councillors: CouncillorResult[]
  respondedCount: number
  totalCount: number
  synthesizerModel?: string
  synthesizerProvider?: string
}

export interface RunPromptInput {
  modelAlias: string
  userPrompt: string
  systemPrompt?: string
  temperature?: number
  /** Aborts the call: a councillor's deadline, or the council being stopped. */
  signal?: AbortSignal
}

export interface RunPromptOutput {
  completion: string
  provider?: string
  model?: string
}

export interface RunCouncilDeps {
  /** Execute one routed prompt. Injected in tests; defaults to the routing engine. */
  runPrompt: (input: RunPromptInput) => Promise<RunPromptOutput>
  log?: (level: "info" | "warn", message: string) => void
}

const DEFAULT_TIMEOUT_MS = 180_000
const DEFAULT_CONCURRENCY = 4

/**
 * The synthesizer's system prompt — adapted from omo-slim's COUNCIL_AGENT_PROMPT.
 * Editable in the Prompt Center (ADR-0236); the confidence line
 * `parseConfidence` reads is a required fragment. A caller's
 * `synthesisInstructions` is its own data and is appended after the resolved
 * text, never folded into the template.
 */
export const COUNCIL_SYNTHESIS_PROMPT = definePrompt({
  id: "generation.council.synthesis",
  contractVersion: 1,
  kind: "feature-template",
  group: "generation",
  operation: "replace-template",
  scopes: ["account"],
  activation: "next-operation",
  // The confidence rating is parsed out of the report.
  risk: "protocol",
  hosts: ["app", "cli"],
  maxChars: 12_000,
  requiredFragments: ["Confidence:"],
  outputContract:
    'A markdown report; parseConfidence reads a "Confidence: unanimous|majority|split" line, and a missing one rates the council "unknown".',
  consumers: ["lib/ai/council/run-council.ts"],
  defaultBody: `You are the Council synthesizer. Several models ("councillors") \
independently answered the same prompt. Merge their answers into one superior response.

Synthesis process (follow in order):
1. Read the original prompt.
2. Review each councillor's response individually — note each one's key insight by name.
3. Identify agreements and contradictions between councillors.
4. Resolve contradictions with explicit reasoning — do not just average; choose the best approach and improve on it.
5. Produce the output in the required format below.

Required output format (use these exact section headings):

## Council Response
The best synthesized answer. Integrate the strongest points, resolve disagreements, give a clear final recommendation with concrete details / code where relevant.

## Councillor Details
Each councillor's response separately, under a "### <name>" heading, using the exact names provided. Note any that failed or timed out.

## Council Summary
Where councillors agreed, where they disagreed, why you chose the final answer, and remaining uncertainty. End with a consensus confidence rating on its own line: "Confidence: unanimous", "Confidence: majority", or "Confidence: split".`,
})

/** Prepend an optional role prompt to the user's question (omo-slim format). */
export function formatCouncillorPrompt(userPrompt: string, councillorPrompt?: string): string {
  if (!councillorPrompt) return userPrompt
  return `${councillorPrompt}\n\n---\n\n${userPrompt}`
}

/** Build the synthesizer's user message from councillor results. */
export function formatCouncillorResults(
  originalPrompt: string,
  results: CouncillorResult[]
): string {
  const completed = results.filter((r) => r.status === "completed" && answerText(r.text))
  const failed = results.filter((r) => r.status !== "completed")

  if (completed.length === 0) {
    const details = results
      .map((r) => `**${r.name}** (${r.model}): ${r.status} — ${r.error ?? "Unknown"}`)
      .join("\n")
    return `---\n\n**Original Prompt**:\n${originalPrompt}\n\n---\n\n**Councillor Responses**:\nAll councillors failed to produce output:\n${details}\n\nAnswer the original prompt directly.`
  }

  const section = completed.map((r) => `**${r.name}** (${r.model}):\n${r.text}`).join("\n\n")
  let prompt = `---\n\n**Original Prompt**:\n${originalPrompt}\n\n---\n\n**Councillor Responses**:\n${section}`
  if (failed.length > 0) {
    const failedSection = failed
      .map((r) => `**${r.name}**: ${r.status} — ${r.error ?? "Unknown"}`)
      .join("\n")
    prompt += `\n\n---\n\n**Failed/Timed-out Councillors**:\n${failedSection}`
  }
  return prompt
}

/** Best-effort parse of the consensus rating out of synthesized markdown. */
export function parseConfidence(markdown: string): CouncilConfidence {
  const m = /confidence[^\n]{0,40}?\b(unanimous|majority|split)\b/i.exec(markdown)
  return m ? (m[1].toLowerCase() as CouncilConfidence) : "unknown"
}

/** Fewest answers a consensus rating can describe: agreement is between answers. */
export const MIN_ANSWERS_FOR_CONSENSUS = 2

/** The council's rating: the synthesizer's, when there were enough answers to agree. */
export function councilConfidence(markdown: string, respondedCount: number): CouncilConfidence {
  return respondedCount < MIN_ANSWERS_FOR_CONSENSUS ? "unknown" : parseConfidence(markdown)
}

/** One councillor's result from its fan-out outcome. */
function councillorOf(
  spec: CouncillorSpec,
  outcome: FanOutOutcome<RunPromptOutput>,
  deps: RunCouncilDeps
): CouncillorResult {
  if (outcome.status === "fulfilled") {
    const model = outcome.value.model ?? spec.modelAlias
    const text = answerText(outcome.value.completion)
    if (!text) return { name: spec.name, model, status: "failed", error: "empty response" }
    return { name: spec.name, model, status: "completed", text }
  }
  const message =
    outcome.status === "skipped"
      ? "not started: the council was stopped"
      : outcome.error instanceof Error
        ? outcome.error.message
        : String(outcome.error ?? "aborted")
  const unconfirmed = outcome.status === "rejected" && !outcome.stopped
  deps.log?.(
    "warn",
    unconfirmed
      ? `councillor "${spec.name}" failed: ${message}; it had not stopped when its slot was released`
      : `councillor "${spec.name}" failed: ${message}`
  )
  return {
    name: spec.name,
    model: spec.modelAlias,
    status: "failed",
    error: message,
    ...(unconfirmed ? { stopUnconfirmed: true as const } : {}),
  }
}

/**
 * Run a full council: fan out councillors, then synthesize. Throws only on
 * invalid input or when the synthesizer call itself fails.
 */
export async function runCouncil(
  opts: CouncilOptions,
  deps: RunCouncilDeps
): Promise<CouncilResult> {
  const prompt = (opts.prompt ?? "").trim()
  if (!prompt) throw new Error("runCouncil: prompt is required")
  if (!Array.isArray(opts.councillors) || opts.councillors.length === 0) {
    throw new Error("runCouncil: at least one councillor is required")
  }
  if (!opts.synthesizerAlias) throw new Error("runCouncil: synthesizerAlias is required")

  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const concurrency =
    opts.executionMode === "serial" ? 1 : (opts.maxConcurrency ?? DEFAULT_CONCURRENCY)

  deps.log?.(
    "info",
    `council: ${opts.councillors.length} councillors (${opts.executionMode ?? "parallel"})`
  )

  const outcomes = await boundedFanOut(
    opts.councillors,
    (spec, _index, signal) =>
      deps.runPrompt({
        modelAlias: spec.modelAlias,
        userPrompt: formatCouncillorPrompt(prompt, spec.systemPrompt),
        signal,
      }),
    {
      concurrency,
      timeoutMs,
      timeoutLabel: "councillor",
      ...(opts.stopGraceMs !== undefined ? { stopGraceMs: opts.stopGraceMs } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
    }
  )
  // A stopped council starts nothing more: no synthesis over a cut-short panel.
  opts.signal?.throwIfAborted()
  const councillors = opts.councillors.map((spec, index) =>
    councillorOf(spec, outcomes[index], deps)
  )

  const respondedCount = councillors.filter((c) => c.status === "completed").length

  const synthesis = (await resolvePromptAsync(COUNCIL_SYNTHESIS_PROMPT)).text
  const synthSystem = opts.synthesisInstructions
    ? `${synthesis}\n\nAdditional guidance:\n${opts.synthesisInstructions}`
    : synthesis

  const synth = await deps.runPrompt({
    modelAlias: opts.synthesizerAlias,
    systemPrompt: synthSystem,
    userPrompt: formatCouncillorResults(prompt, councillors),
    temperature: 0.1,
    ...(opts.signal ? { signal: opts.signal } : {}),
  })

  const markdown = (synth.completion ?? "").trim()
  return {
    markdown,
    confidence: councilConfidence(markdown, respondedCount),
    councillors,
    respondedCount,
    totalCount: councillors.length,
    synthesizerModel: synth.model,
    synthesizerProvider: synth.provider,
  }
}

/**
 * Production `runPrompt` backed by the ADR-0043 routing engine. Built lazily so
 * importing this module never touches stores (mirrors `ai-prompt-routed`).
 *
 * `ledger` says whose calls these are (ADR-0188 D27): every councillor, the
 * synthesizer and each of their fallback attempts is its own reservation on
 * that surface. The `ai.council` / `ai.ensemble` nodes and Agent auto-compose
 * pass `agentsWorkflows`; the `/council` slash command passes `utilityLedger`.
 *
 * `executionRunId` is the run whose tree budget every one of those calls
 * reserves from (ADR-0243): a council inside a capped workflow spends from
 * that cap, never beside it.
 */
export async function defaultCouncilRunPrompt(
  ledger: RoutedPromptLedger,
  executionRunId?: string
): Promise<RunCouncilDeps["runPrompt"]> {
  const { runRoutedPrompt, defaultRoutedPromptDeps } =
    await import("@/lib/workflow/nodes/ai/ai-prompt-routed")
  const routedDeps = await defaultRoutedPromptDeps({
    routingSurface: "council",
    ledger,
    ...(executionRunId ? { executionRunId } : {}),
  })
  return async (input: RunPromptInput): Promise<RunPromptOutput> => {
    const out = await runRoutedPrompt(
      {
        modelAlias: input.modelAlias,
        userPrompt: input.userPrompt,
        systemPrompt: input.systemPrompt,
        temperature: input.temperature,
        ...(input.signal ? { signal: input.signal } : {}),
        log: () => {},
      },
      routedDeps
    )
    return { completion: out.completion, provider: out.provider, model: out.model }
  }
}

/** Render a compact chat-facing markdown report (used by the `/council` command). */
export function renderCouncilReport(result: CouncilResult): string {
  const footer =
    `\n\n---\n*Council: ${result.respondedCount}/${result.totalCount} councillors responded` +
    `${result.synthesizerModel ? ` · synthesized by ${result.synthesizerModel}` : ""}` +
    `${result.confidence !== "unknown" ? ` · ${result.confidence}` : ""}*`
  return `${result.markdown}${footer}`
}

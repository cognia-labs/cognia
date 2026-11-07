/**
 * Who sits on a council: the councillor and synthesizer model aliases for a
 * council run, from `/council` arguments or an objective and the configured
 * routing aliases (ADR-0043).
 *
 * Pure, so every surface that convenes a council picks the same roster: the
 * `/council` slash command, the CLI's council controller and an auto Squad
 * run whose executor is `council`.
 */

import type { CouncillorSpec } from "./run-council"

/** Max councillors auto-selected from configured aliases. */
const AUTO_COUNCILLOR_LIMIT = 3

export interface ParsedCouncilArgs {
  prompt: string
  models?: string[]
  synth?: string
}

/** Extract `--models a,b,c` and `--synth alias`; the remainder is the prompt. */
export function parseCouncilArgs(raw: string): ParsedCouncilArgs {
  let rest = raw ?? ""
  let models: string[] | undefined
  let synth: string | undefined

  const modelsMatch = /--models\s+(\S+)/.exec(rest)
  if (modelsMatch) {
    models = modelsMatch[1]
      .split(",")
      .map((m) => m.trim())
      .filter(Boolean)
    rest = rest.replace(modelsMatch[0], " ")
  }
  const synthMatch = /--synth\s+(\S+)/.exec(rest)
  if (synthMatch) {
    synth = synthMatch[1].trim()
    rest = rest.replace(synthMatch[0], " ")
  }
  return { prompt: rest.replace(/\s+/g, " ").trim(), models, synth }
}

/**
 * Resolve councillor specs + synthesizer alias from parsed args and the set of
 * available aliases. Returns null with a reason when there isn't enough to run.
 */
export function resolveCouncilRoster(
  parsed: ParsedCouncilArgs,
  availableAliases: string[]
): { councillors: CouncillorSpec[]; synthesizerAlias: string } | { error: string } {
  const available = availableAliases.filter(Boolean)
  let councillorAliases = parsed.models?.length
    ? parsed.models
    : available.slice(0, AUTO_COUNCILLOR_LIMIT)
  councillorAliases = Array.from(new Set(councillorAliases))

  if (councillorAliases.length === 0) {
    return {
      error:
        "No models to convene. Configure model-mapping aliases in Settings → Routing, or pass " +
        "`/council --models alias1,alias2 <prompt>`.",
    }
  }

  let synthesizerAlias = parsed.synth
  if (!synthesizerAlias) {
    // Prefer a configured alias not already a councillor; else reuse the first.
    synthesizerAlias = available.find((a) => !councillorAliases.includes(a)) ?? councillorAliases[0]
  }

  const councillors: CouncillorSpec[] = councillorAliases.map((alias) => ({
    name: alias,
    modelAlias: alias,
  }))
  return { councillors, synthesizerAlias }
}

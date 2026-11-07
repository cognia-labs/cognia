/**
 * `/council <prompt>` — run a multi-model consensus from the main chat.
 *
 * Fans the prompt out to several councillor models (routing aliases), then a
 * synthesizer model merges them into one answer with a confidence rating, and
 * drops the report into the transcript. Shares `runCouncil` with the
 * `ai.council` workflow node.
 *
 * Model selection (no new settings schema — reuses the configured routing
 * aliases, ADR-0043):
 *   - `--models a,b,c` picks councillor aliases explicitly;
 *   - `--synth alias` picks the synthesizer;
 *   - otherwise the enabled model-mapping aliases are used (first few as
 *     councillors, a distinct one as synthesizer).
 *
 * Output strings are plain English by repo convention (slash-command system
 * messages aren't next-intl-localized — see `actions/run-saved-workflow.ts`).
 */

import type { SlashContext } from "../builtin"
import {
  runCouncil,
  renderCouncilReport,
  defaultCouncilRunPrompt,
  type RunCouncilDeps,
} from "@/lib/ai/council/run-council"
import { parseCouncilArgs, resolveCouncilRoster } from "@/lib/ai/council/roster"
import type { RoutedPromptLedger } from "@/lib/workflow/nodes/ai/ai-prompt-routed"
import { sessionWorkspaceId } from "@/lib/workspace/session-workspace"

export interface CouncilCommandDeps {
  /** Enabled routing aliases available to convene as councillors. */
  loadAliases: () => Promise<string[]>
  /** Routed prompt runner (councillors + synthesizer). */
  runPrompt: RunCouncilDeps["runPrompt"]
}

/** Testable core. `handleCouncil` wraps this with production deps. */
export async function executeCouncilCommand(
  ctx: SlashContext,
  deps: CouncilCommandDeps
): Promise<void> {
  if (ctx.chatStatus === "streaming" || ctx.chatStatus === "awaiting_approval") {
    ctx.pushSystemMessage(
      "Can't run a council while a turn is in progress. Try again once it settles."
    )
    return
  }

  const parsed = parseCouncilArgs(ctx.args)
  if (!parsed.prompt) {
    ctx.pushSystemMessage(
      [
        "Usage: `/council <question>` — ask several models and synthesize a consensus.",
        "",
        "Optional flags:",
        "- `--models alias1,alias2,alias3` — councillor model aliases (defaults to your configured routing aliases)",
        "- `--synth alias` — synthesizer model alias",
      ].join("\n")
    )
    return
  }

  const aliases = await deps.loadAliases()
  const roster = resolveCouncilRoster(parsed, aliases)
  if ("error" in roster) {
    ctx.pushSystemMessage(roster.error)
    return
  }

  ctx.pushSystemMessage(
    `Convening a council of ${roster.councillors.length} (${roster.councillors
      .map((c) => c.modelAlias)
      .join(", ")}) → synthesized by ${roster.synthesizerAlias}…`
  )

  try {
    const result = await runCouncil(
      {
        prompt: parsed.prompt,
        councillors: roster.councillors,
        synthesizerAlias: roster.synthesizerAlias,
      },
      { runPrompt: deps.runPrompt }
    )
    ctx.pushSystemMessage(renderCouncilReport(result))
  } catch (err) {
    ctx.pushSystemMessage(`Council failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/**
 * Whose calls a `/council` run makes (ADR-0188 D27, D30).
 *
 * The surface is `utilityLedger`, origin `chat`. The command is typed in a chat
 * but is not a chat turn: it calls its models from the renderer, outside the
 * sidecar, with no assistant message a run card could attach to — and only a
 * sealed composer turn is a `chat` run. It is not Agent or workflow work either.
 * That is exactly the renderer-side, session-less generation `utilityLedger`
 * books, the same surface as a conversation title. The workspace is the active
 * conversation's own, so its data-class rules apply to what the councillors see.
 */
export async function councilLedgerFor(
  sessionId: string | null,
  loadSession: (id: string) => Promise<Parameters<typeof sessionWorkspaceId>[0]> = async (id) =>
    (await import("@/lib/db/sessions")).getSession(id)
): Promise<RoutedPromptLedger> {
  const session = sessionId ? await loadSession(sessionId).catch(() => undefined) : undefined
  return {
    surface: "utilityLedger",
    origin: "chat",
    featureId: "slash-council",
    workspaceId: sessionWorkspaceId(session),
  }
}

/** Production handler registered as the `/council` action command. */
export async function handleCouncil(ctx: SlashContext): Promise<void> {
  await executeCouncilCommand(ctx, {
    loadAliases: async () => {
      const { getSettings } = await import("@/lib/db/settings")
      const settings = await getSettings()
      const mappings = Array.isArray(settings.modelMappings) ? settings.modelMappings : []
      return mappings.filter((m) => m && m.enabled !== false && m.alias).map((m) => m.alias)
    },
    runPrompt: await defaultCouncilRunPrompt(await councilLedgerFor(ctx.activeSessionId)),
  })
}

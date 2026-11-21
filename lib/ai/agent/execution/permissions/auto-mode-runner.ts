/**
 * Renderer glue between a `permission_request` tool call and the Auto-mode
 * orchestrator (`auto-mode.ts`). Kept separate from the chat hook so it stays
 * pure (no React, no store reach-through) and unit-testable: the hook builds
 * the LLM client + reads settings, hands them here, and acts on the returned
 * decision.
 */

import type { AppSettings } from "@cognia/agent-config-types"
import type { LlmClient } from "@/lib/twin/distill/llm"
import { extractCommand } from "./command-from-tool"
import { evaluateAutoDecision, type AutoDecision, type AutoModeConfig } from "./auto-mode"
import type { Ruleset } from "@cognia/plugin-contract/lib/claude/permissions/ruleset"
import type { PromptResolutionContext } from "@/lib/prompts/types"

export interface RunAutoModeArgs {
  toolName: string
  input: unknown
  settings: AppSettings | null | undefined
  /** Background model client (already built by the caller); null disables the model tier. */
  client: LlmClient | null
  /**
   * Directory the command starts in. Anchors the rules' workspace check and
   * the classifier's `cd` tracking (both only ever tighten a verdict with it)
   * and is shown to the model judge.
   */
  cwd?: string
  /**
   * Resolve {@link cwd} lazily, only once the tool turns out to be a shell
   * command under Auto-mode — the session's effective working directory needs
   * a database read the other requests should not pay for. Ignored when `cwd`
   * is given; a failure leaves the directory unknown, which fails closed.
   */
  resolveCwd?: () => Promise<string | null | undefined>
  locale?: string
  /** Plugin-contributed command rulesets (lower precedence than user rules). */
  pluginRules?: Ruleset[]
  /**
   * Session the permission request belongs to — scopes the model judge's
   * verdict cache so a mid-turn steer invalidates verdicts reached under the
   * superseded instruction.
   */
  contextKey?: string
  /** Where the model judge's customized guidance is looked up. */
  promptContext?: PromptResolutionContext
}

/**
 * Evaluate Auto-mode for a tool call. Returns `null` when Auto-mode does not
 * apply (non-shell tool, or the master switch is off) so the caller proceeds
 * with the normal approval flow. Otherwise returns the allow/ask/deny
 * decision.
 */
export async function runAutoModeForTool({
  toolName,
  input,
  settings,
  client,
  cwd,
  resolveCwd,
  locale,
  pluginRules = [],
  contextKey,
  promptContext,
}: RunAutoModeArgs): Promise<AutoDecision | null> {
  const command = extractCommand(toolName, input)
  if (command == null) return null

  const auto = settings?.agentPermissions?.autoApprove
  if (!auto?.enabled) return null

  const config: AutoModeConfig = {
    enabled: true,
    mode: auto.mode ?? "rules",
    denyOnHighRisk: auto.denyOnHighRisk ?? true,
  }

  // User command rules outrank plugin rules (last in the low→high array wins).
  const userRules = settings?.agentPermissions?.commandRules
  const rules: Ruleset[] = [...pluginRules]
  if (userRules && Object.keys(userRules).length > 0) rules.push({ Bash: userRules })

  const startDir = cwd ?? ((await resolveCwd?.().catch(() => undefined)) || undefined)

  return evaluateAutoDecision({
    command,
    config,
    rules,
    client,
    cwd: startDir,
    locale,
    contextKey,
    promptContext,
  })
}

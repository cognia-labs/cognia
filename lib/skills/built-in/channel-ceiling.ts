/**
 * What a bound channel's rows allow the built-in skill tier (ADR-0026).
 *
 * A connector adapter row may cap the skills its conversations reach
 * (`builtInSkillCeiling`, exact ids or `family.*` selectors), and the
 * adapter or the conversation decides whether a write skill waits for a
 * person's confirmation. The manifest builder and the dispatcher apply both,
 * the same way as the conversation's own allowlist; the rows are host data
 * (`lib/db/connector-types.ts`), read by whoever runs the turn.
 */

import type { AdapterInstanceRow, ConversationOverrideRow } from "@/lib/db/connector-types"

/** Whether `selector` (an exact id or `family.*`) names the skill. */
export function matchesSkillSelector(skillId: string, family: string, selector: string): boolean {
  if (selector === skillId) return true
  if (!selector.endsWith(".*")) return false
  const prefix = selector.slice(0, -2)
  return family === prefix || skillId.startsWith(`${prefix}.`)
}

/** Undefined ceiling means the adapter imposes no additional restriction. */
export function adapterAllowsBuiltInSkill(
  adapter: Pick<AdapterInstanceRow, "builtInSkillCeiling"> | null | undefined,
  skill: { id: string; family: string }
): boolean {
  const ceiling = adapter?.builtInSkillCeiling
  if (ceiling === undefined) return true
  return ceiling.some((selector) => matchesSkillSelector(skill.id, skill.family, selector))
}

/** The conversation's choice, then the adapter's, then the secure default (confirm). */
export function resolveRequireHitlForWrites(
  adapter: Pick<AdapterInstanceRow, "requireHitlForWrites"> | null | undefined,
  override: Pick<ConversationOverrideRow, "requireHitlForWrites"> | null | undefined
): boolean {
  return override?.requireHitlForWrites ?? adapter?.requireHitlForWrites ?? true
}

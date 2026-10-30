import type {
  AdapterInstanceRow,
  ConversationOverrideRow,
  ImHostCapabilityId,
} from "@/lib/db/connector-types"

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

/** Undefined ceiling means the adapter imposes no additional restriction. */
export function adapterAllowsHostCapability(
  adapter: Pick<AdapterInstanceRow, "hostCapabilityCeiling"> | null | undefined,
  capability: ImHostCapabilityId
): boolean {
  const ceiling = adapter?.hostCapabilityCeiling
  return ceiling === undefined || ceiling.includes(capability)
}

export function resolveRequireHitlForWrites(
  adapter: Pick<AdapterInstanceRow, "requireHitlForWrites"> | null | undefined,
  override: Pick<ConversationOverrideRow, "requireHitlForWrites"> | null | undefined
): boolean {
  return override?.requireHitlForWrites ?? adapter?.requireHitlForWrites ?? true
}

export function resolveImHostCapabilities(input: {
  adapter: Pick<AdapterInstanceRow, "hostCapabilityCeiling"> | null | undefined
  override:
    | Pick<
        ConversationOverrideRow,
        "allowComputerUse" | "allowOcr" | "allowGoalDriving" | "allowScheduleTools"
      >
    | null
    | undefined
  characterComputerUseEnabled?: boolean
}): Record<ImHostCapabilityId, boolean> {
  const { adapter, override } = input
  return {
    computer_use:
      adapterAllowsHostCapability(adapter, "computer_use") &&
      input.characterComputerUseEnabled === true &&
      override?.allowComputerUse === true,
    ocr: adapterAllowsHostCapability(adapter, "ocr") && override?.allowOcr !== false,
    goal_driving:
      adapterAllowsHostCapability(adapter, "goal_driving") && override?.allowGoalDriving === true,
    schedule_tools:
      adapterAllowsHostCapability(adapter, "schedule_tools") &&
      override?.allowScheduleTools === true,
  }
}

/** Intersect selector ceilings, including the supported family.* shorthand. */
function intersectSelectors(a?: string[], b?: string[]): string[] | undefined {
  if (!a || !b) return a ?? b
  const contains = (outer: string, inner: string) =>
    outer === inner || (outer.endsWith(".*") && inner.startsWith(outer.slice(0, -1)))
  return [
    ...new Set(
      a.flatMap((left) =>
        b.flatMap((right) =>
          contains(left, right) ? [right] : contains(right, left) ? [left] : []
        )
      )
    ),
  ]
}

/** A queued source can lose grants while it waits, but cannot gain new ones. */
export function restrictQueuedImPermissions(
  acceptedAdapter: AdapterInstanceRow,
  acceptedOverride: ConversationOverrideRow | null,
  currentAdapter: AdapterInstanceRow,
  currentOverride: ConversationOverrideRow
): { adapter: AdapterInstanceRow; override: ConversationOverrideRow } {
  return {
    adapter: {
      ...currentAdapter,
      builtInSkillCeiling: intersectSelectors(
        acceptedAdapter.builtInSkillCeiling,
        currentAdapter.builtInSkillCeiling
      ),
      hostCapabilityCeiling: intersectSelectors(
        acceptedAdapter.hostCapabilityCeiling,
        currentAdapter.hostCapabilityCeiling
      ) as AdapterInstanceRow["hostCapabilityCeiling"],
      muted: acceptedAdapter.muted === true || currentAdapter.muted === true,
    },
    override: {
      ...currentOverride,
      allowedBuiltInSkillIds:
        acceptedOverride?.allowedBuiltInSkillIds === "all" &&
        currentOverride.allowedBuiltInSkillIds === "all"
          ? "all"
          : intersectSelectors(
              acceptedOverride?.allowedBuiltInSkillIds === "all"
                ? undefined
                : acceptedOverride?.allowedBuiltInSkillIds,
              currentOverride.allowedBuiltInSkillIds === "all"
                ? undefined
                : currentOverride.allowedBuiltInSkillIds
            ),
      allowComputerUse:
        acceptedOverride?.allowComputerUse === true && currentOverride.allowComputerUse === true,
      allowScheduleTools:
        acceptedOverride?.allowScheduleTools === true &&
        currentOverride.allowScheduleTools === true,
      allowGoalDriving:
        acceptedOverride?.allowGoalDriving === true && currentOverride.allowGoalDriving === true,
      allowOcr: acceptedOverride?.allowOcr !== false && currentOverride.allowOcr !== false,
      requireHitlForWrites:
        resolveRequireHitlForWrites(acceptedAdapter, acceptedOverride) ||
        resolveRequireHitlForWrites(currentAdapter, currentOverride),
      muted: acceptedOverride?.muted === true || currentOverride.muted === true,
    },
  }
}

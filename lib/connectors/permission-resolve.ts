import type {
  AdapterInstanceRow,
  ConversationOverrideRow,
  ImHostCapabilityId,
} from "@/lib/db/connector-types"
import { resolveRequireHitlForWrites } from "@/lib/skills/built-in/channel-ceiling"

/** Undefined ceiling means the adapter imposes no additional restriction. */
export function adapterAllowsHostCapability(
  adapter: Pick<AdapterInstanceRow, "hostCapabilityCeiling"> | null | undefined,
  capability: ImHostCapabilityId
): boolean {
  const ceiling = adapter?.hostCapabilityCeiling
  return ceiling === undefined || ceiling.includes(capability)
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

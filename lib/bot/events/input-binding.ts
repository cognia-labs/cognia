/** Pure input-account resolution shared by intake, execution and credential brokers. */
import type { BotInstallationRow } from "@/lib/db/bot-types"
import type { PluginBotRequirementsV1, PluginBotTriggerDef } from "@/types/plugin/plugin-bot"
import type { BotEventEnvelopeV1 } from "@/types/bot/event"

export type BotInputBinding =
  | { kind: "unscoped" }
  | { kind: "invalid" }
  | { kind: "bound"; slotId: string; adapterId?: string; integrationAccountId?: string }

export function resolveBotInputBinding(
  installation: Pick<BotInstallationRow, "credentialBindings" | "triggerInputSlots">,
  definition: { triggers: readonly PluginBotTriggerDef[]; requires?: PluginBotRequirementsV1 },
  trigger: PluginBotTriggerDef
): BotInputBinding {
  const source =
    trigger.kind === "interaction"
      ? "connector"
      : trigger.kind === "event"
        ? trigger.source
        : undefined
  if (source !== "connector" && source !== "integration") return { kind: "unscoped" }
  const slotId = installation.triggerInputSlots?.[trigger.id] ?? trigger.inputCredentialSlot
  const slots = definition.requires?.credentials
  const field = source === "connector" ? "adapterId" : "integrationAccountId"
  if (slotId !== undefined) {
    const slot = slots?.find((candidate) => candidate.id === slotId)
    const binding = installation.credentialBindings[slotId]
    if (!slot || !binding?.[field] || (binding.adapterId && binding.integrationAccountId))
      return { kind: "invalid" }
    return { kind: "bound", slotId, [field]: binding[field] }
  }
  // A mapping-aware definition never infers input from an output credential.
  if (definition.triggers.some((candidate) => candidate.inputCredentialSlot !== undefined))
    return { kind: "invalid" }
  const candidates = Object.entries(installation.credentialBindings).filter(
    ([id, binding]) =>
      (!slots?.length || slots.some((slot) => slot.id === id)) &&
      binding[field] &&
      !(binding.adapterId && binding.integrationAccountId)
  )
  if (new Set(candidates.map(([, binding]) => binding[field])).size > 1) return { kind: "invalid" }
  const candidate = candidates[0]
  if (candidate) return { kind: "bound", slotId: candidate[0], [field]: candidate[1][field] }
  // Credential-free legacy observers keep their explicitly supported wildcard behavior.
  return slots?.length ? { kind: "invalid" } : { kind: "unscoped" }
}

export function botInputStillMatches(
  installation: Pick<BotInstallationRow, "credentialBindings" | "triggerInputSlots">,
  definition: { triggers: readonly PluginBotTriggerDef[]; requires?: PluginBotRequirementsV1 },
  event: BotEventEnvelopeV1
): boolean {
  const trigger = definition.triggers.find((candidate) => candidate.id === event.triggerId)
  if (!trigger) return false
  const binding = resolveBotInputBinding(installation, definition, trigger)
  if (binding.kind === "invalid") return false
  if (binding.kind === "unscoped") return true
  return event.source === "connector"
    ? binding.adapterId === event.binding?.adapterId
    : event.source === "integration"
      ? binding.integrationAccountId === event.binding?.integrationAccountId
      : true
}

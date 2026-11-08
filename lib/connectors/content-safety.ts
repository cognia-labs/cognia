import {
  assessContentSafety,
  decideContentSafety,
  type ContentSource,
} from "@cognia/content-safety"
import { getAdapterInstance } from "@/lib/db/adapter-instances"
import type { NormalizedInboundEvent } from "@/types/connectors/event"

/** Read the actual execution host's row; old/missing rows keep the safe default. */
export async function connectorInjectionProtection(adapterId: string): Promise<boolean> {
  const adapter = await getAdapterInstance(adapterId)
  return adapter?.promptInjectionProtection !== false
}

/** Admission and context reuse one policy without applying outbound PII rules to ingress. */
export function inspectConnectorText(
  text: string,
  enabled: boolean,
  source: ContentSource = "user"
) {
  return decideContentSafety(
    assessContentSafety({
      text,
      source,
      stage: source === "user" ? "admission" : "model-input",
      inspectPrivacy: false,
      inspectInjection: enabled,
    }),
    { injectionProtection: enabled }
  )
}

/** Inspect extracted media and markdown as well as the transport's plain-text projection. */
export function inspectConnectorEvent(event: NormalizedInboundEvent, enabled: boolean) {
  const decisions = [inspectConnectorText(event.plainText, enabled)]
  for (const segment of event.segments) {
    const record = segment as unknown as Record<string, unknown>
    for (const key of ["text", "md", "ocrText", "transcript", "name"]) {
      if (typeof record[key] === "string")
        decisions.push(
          inspectConnectorText(
            record[key],
            enabled,
            key === "text" || key === "md" ? "user" : "external"
          )
        )
    }
  }
  if (event.sender.displayName)
    decisions.push(inspectConnectorText(event.sender.displayName, enabled, "external"))
  return decisions.find((d) => d.action !== "allow") ?? decisions[0]
}

// The connectors' built-in skill families (ADR-0026, ADR-0250 §14
// `builtinSkills`): the platform-neutral `im.*` chat-management family,
// which calls the running adapter, and each vendor's own families, which
// its contribution loads (`ConnectorVendorContribution.builtInSkills`; Lark's
// run lark-cli). The skill tier loads this file through the generated
// registry (`lib/skills/built-in/module-skills.ts`) and awaits `register`.
//
// A vendor's families may need something outside the host, so its gate
// joins the one this file hands over.

import "@/lib/skills/built-in/im"
import type { BuiltInSkillAvailability } from "@/lib/skills/built-in/types"
import { connectorVendors } from "./vendor-contribution"

export const builtInSkillFamilies: readonly string[] = [
  "im",
  ...connectorVendors().flatMap((vendor) => vendor.builtInSkills?.families ?? []),
]

let vendorGates: readonly BuiltInSkillAvailability[] = []

/** Register every vendor's families and collect their gates. */
export async function register(): Promise<void> {
  const loaded = await Promise.all(connectorVendors().map((vendor) => vendor.builtInSkills?.load()))
  vendorGates = loaded.flatMap((families) =>
    families?.availability ? [families.availability] : []
  )
}

export const availability: BuiltInSkillAvailability = {
  governs: (skillId) => vendorGates.some((gate) => gate.governs(skillId)),
  isAvailable: (skillId) =>
    vendorGates.every((gate) => !gate.governs(skillId) || gate.isAvailable(skillId)),
  async settle(scope) {
    const keys = await Promise.all(vendorGates.map((gate) => gate.settle(scope)))
    const settled = keys.filter((key): key is string => key !== null)
    return settled.length > 0 ? settled.join(";") : null
  },
}

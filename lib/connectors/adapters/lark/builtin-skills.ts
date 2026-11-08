// Lark's built-in skill families (ADR-0026) and their availability gate,
// loaded through the vendor contribution's `builtInSkills` hook
// (`./contribution.ts`). Importing this file registers the six families.
//
// The Lark skills need lark-cli at the certified version with every command
// and flag they use, so the gate reads the CLI capability probe
// (`lib/skills/built-in/lark/capabilities.ts`).

import "@/lib/skills/built-in/lark"
import {
  getCachedLarkCliCapabilityDiagnostics,
  isLarkSkillCapabilityAvailable,
  LARK_CLI_CAPABILITY_MANIFEST,
  probeLarkCliCapabilities,
} from "@/lib/skills/built-in/lark/capabilities"
import type { BuiltInSkillAvailability } from "@/lib/skills/built-in/types"

export const availability: BuiltInSkillAvailability = {
  governs: (skillId) => skillId in LARK_CLI_CAPABILITY_MANIFEST,

  isAvailable(skillId) {
    // The first manifest of a session asks before any probe ran: start one
    // and answer from nothing (unavailable), as the probe would until it
    // finishes.
    if (!getCachedLarkCliCapabilityDiagnostics()) void probeLarkCliCapabilities()
    return isLarkSkillCapabilityAvailable(skillId)
  },

  async settle({ platform }) {
    // Lark skills serve desktop chat and Lark conversations only.
    if (platform !== undefined && platform !== "lark") return null
    const diagnostics = await probeLarkCliCapabilities()
    return JSON.stringify({
      certifiedVersion: diagnostics.certifiedVersion,
      detectedVersion: diagnostics.detectedVersion,
      ready: diagnostics.ready,
      affectedSkillIds: [...diagnostics.affectedSkillIds].sort(),
    })
  },
}

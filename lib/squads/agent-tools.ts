/**
 * The squads module's tool family (ADR-0250 §14 amendment). A module has one
 * family, and the squads module offers two kinds of tools, each with its own
 * switch and its own runner:
 *
 * - the collaboration tools (`./collaboration-tools.ts`): a teammate talking
 *   to its team during its own dispatch turn, behind
 *   `selfInvokeTools.teamCollaboration`, with the messaging protocol as their
 *   instructions;
 * - the Squad template tools (`./template-tools.ts`): listing, applying and
 *   saving squad templates, behind `selfInvokeTools.templates` with the
 *   template platform's tools.
 *
 * This file offers whatever each half offers and routes a call to the half
 * that declares its name.
 */

import type { ModuleToolEntry, ModuleToolFamily } from "@/lib/modules/manifest-types"
import { isTeamTool, teamToolFamily } from "./collaboration-tools"
import { templateToolFamily } from "./template-tools"

export const toolFamily: ModuleToolFamily = {
  async surface(ctx) {
    const [team, template] = await Promise.all([
      teamToolFamily.surface(ctx),
      templateToolFamily.surface(ctx),
    ])
    const tools: ModuleToolEntry[] = [...(team?.tools ?? []), ...(template?.tools ?? [])]
    if (tools.length === 0) return null
    const instructions = [team?.instructions, template?.instructions].filter(Boolean).join("\n\n")
    return { tools, ...(instructions ? { instructions } : {}) }
  },
  run(name, args, call) {
    return isTeamTool(name)
      ? teamToolFamily.run(name, args, call)
      : templateToolFamily.run(name, args, call)
  },
}

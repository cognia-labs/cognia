/**
 * The squads module's tool family (ADR-0250 §14 amendment). A module has one
 * family, and the squads module offers three kinds of tools, each with its
 * own switch and its own runner:
 *
 * - the collaboration tools (`./collaboration-tools.ts`): a teammate talking
 *   to its team during its own dispatch turn, behind
 *   `selfInvokeTools.teamCollaboration`, with the messaging protocol as their
 *   instructions;
 * - the Squad template tools (`./template-tools.ts`): listing, applying and
 *   saving squad templates, behind `selfInvokeTools.templates` with the
 *   template platform's tools;
 * - the room hand-off (`./room-handoff/tool.ts`): a character-team room's
 *   member handing work to a Squad, offered in every room this host runs.
 *
 * This file offers whatever each half offers and routes a call to the half
 * that declares its name.
 */

import type { ModuleToolEntry, ModuleToolFamily } from "@/lib/modules/manifest-types"
import { isTeamTool, teamToolFamily } from "./collaboration-tools"
import { templateToolFamily } from "./template-tools"
import { isRoomHandoffTool, roomHandoffToolFamily } from "./room-handoff/tool"

export const toolFamily: ModuleToolFamily = {
  async surface(ctx) {
    const surfaces = await Promise.all([
      teamToolFamily.surface(ctx),
      templateToolFamily.surface(ctx),
      roomHandoffToolFamily.surface(ctx),
    ])
    const tools: ModuleToolEntry[] = surfaces.flatMap((surface) => surface?.tools ?? [])
    if (tools.length === 0) return null
    const instructions = surfaces
      .map((surface) => surface?.instructions)
      .filter(Boolean)
      .join("\n\n")
    return { tools, ...(instructions ? { instructions } : {}) }
  },
  run(name, args, call) {
    if (isTeamTool(name)) return teamToolFamily.run(name, args, call)
    if (isRoomHandoffTool(name)) return roomHandoffToolFamily.run(name, args, call)
    return templateToolFamily.run(name, args, call)
  },
}

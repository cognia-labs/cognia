/**
 * Desktop-pet workflow node executors.
 *
 * `action.pet.interact` emits a nurture interaction on the pet event bus
 * (`source: "workflow"`); the pet controller owns the whole progression path
 * (needs restore — incl. `meta.itemId` shop-item overrides — XP, coins,
 * achievements), so this executor is intentionally an emit-and-report.
 *
 * `trigger.pet.event` is a pass-through like `trigger.desktop.event`: real
 * firing lives in `./workflow-trigger.ts` (a PetEventBus
 * subscriber); this handler just round-trips the trigger payload when a
 * workflow runs manually.
 */

import type { ModuleWorkflowNodesModule } from "@/lib/modules/manifest-types"
import { emitPetEvent } from "@/lib/pet/events/pet-event-bus"
import type { PetEventKind } from "@/types/pet"
import { registerNodeExecutor } from "@/lib/workflow/nodes/registry"

const INTERACTION_KINDS = new Set([
  "fed",
  "played",
  "petted",
  "talked",
  "slept",
  "cleaned",
  "treated",
])

registerNodeExecutor({
  kind: "action.pet.interact",
  typeVersion: 1,
  execute: async (ctx) => {
    const kind = typeof ctx.params.kind === "string" ? ctx.params.kind : ""
    if (!INTERACTION_KINDS.has(kind)) {
      throw new Error(
        `action.pet.interact requires 'kind' ∈ {fed, played, petted, talked, slept, cleaned, treated}; got "${kind}"`
      )
    }
    const itemId =
      typeof ctx.params.itemId === "string" && ctx.params.itemId.length > 0
        ? ctx.params.itemId
        : undefined
    emitPetEvent({
      source: "workflow",
      kind: kind as PetEventKind,
      ...(itemId ? { meta: { itemId } } : {}),
    })
    return { output: { kind, ...(itemId ? { itemId } : {}), emittedAt: Date.now() } }
  },
})

registerNodeExecutor({
  kind: "trigger.pet.event",
  typeVersion: 1,
  execute: async (ctx) => {
    const kinds = (Array.isArray(ctx.params.kinds) ? ctx.params.kinds : []) as string[]
    return { output: { kinds, firedAt: ctx.trigger.originAt, payload: ctx.trigger.payload } }
  },
})

/**
 * The kinds this file registers, as the module's `workflowNodes`
 * contribution names them (ADR-0250 §14); the workflow engine checks them
 * once the import has run.
 */
export const workflowNodeKinds: ModuleWorkflowNodesModule["workflowNodeKinds"] = [
  "action.pet.interact",
  "trigger.pet.event",
]

/**
 * The built-in skill families feature modules contribute (ADR-0026,
 * ADR-0250 §14 `builtinSkills`). A module that owns a family declares it in
 * its manifest; the generated registry (`lib/modules/generated/builtin-skills.ts`)
 * lists one lazy import per module, and this loader runs them, so the skill
 * tier never imports a feature module's families itself.
 *
 * Importing a contribution registers its skills, as every family does
 * (`registerBuiltInSkill`); a file whose families need more code exports
 * `register`, awaited next. The file also names the families it registers
 * (`builtInSkillFamilies`), checked once both have run: a declared
 * family with no registered skill is logged. A contribution may hand over an
 * availability gate for skills that need something outside the host; the
 * manifest builder reads the loaded gates synchronously, and a manifest's
 * cache key asks each to settle first.
 *
 * Every reader of the registry awaits `whenBuiltInSkillsRegistered()`
 * (`./index.ts`) before it lists or runs a module's skill; importing the
 * index starts the load. Each module loads once; one that fails is left out
 * and tried again on the next call, and never keeps the others from loading.
 * An `experimental` module contributes nothing.
 */

import { loggers } from "@cognia/logging"
import type { ModuleBuiltinSkillsEntry } from "@/lib/modules/manifest-types"
import { MODULE_BUILTIN_SKILLS } from "@/lib/modules/generated/builtin-skills"
import type { PlatformKind } from "@/types/connectors/platform-kind"
import { getSharedBuiltInSkillRegistry } from "./registry"
import type { BuiltInSkillAvailability } from "./types"

interface LoadedGate {
  module: string
  gate: BuiltInSkillAvailability
}

const loaded = new Set<string>()
let gates: LoadedGate[] = []
let pending: Promise<void> | null = null
let entries: readonly ModuleBuiltinSkillsEntry[] = MODULE_BUILTIN_SKILLS

async function loadEntry(entry: ModuleBuiltinSkillsEntry): Promise<void> {
  try {
    const { builtInSkillFamilies, availability, register } = await entry.load()
    await register?.()
    loaded.add(entry.module)
    if (availability) gates.push({ module: entry.module, gate: availability })
    const registered = new Set(
      getSharedBuiltInSkillRegistry()
        .list()
        .map((skill) => skill.family)
    )
    const missing = builtInSkillFamilies.filter((family) => !registered.has(family))
    if (missing.length > 0)
      loggers.app.error("built-in skill families a module declares were not registered", {
        module: entry.module,
        missing,
      })
  } catch (error) {
    loggers.app.error("built-in skill contribution failed to load", {
      module: entry.module,
      error: String(error),
    })
  }
}

/** Load every contributing module's skill families that are not loaded yet. */
export function loadModuleBuiltInSkills(): Promise<void> {
  if (pending) return pending
  const due = entries.filter((entry) => entry.stage !== "experimental" && !loaded.has(entry.module))
  if (due.length === 0) return Promise.resolve()
  pending = Promise.all(due.map(loadEntry)).then(() => {
    pending = null
  })
  return pending
}

/** The availability gates of the modules loaded so far, in module order. */
export function builtInSkillAvailabilityGates(): readonly BuiltInSkillAvailability[] {
  return gates.map((entry) => entry.gate)
}

/**
 * Whether every loaded gate that governs the skill finds it available. A
 * skill no gate governs is available as far as the gates are concerned.
 */
export function isBuiltInSkillAvailable(skillId: string): boolean {
  return gates.every(({ gate }) => !gate.governs(skillId) || gate.isAvailable(skillId))
}

/**
 * Load the contributions, let each gate settle what a manifest for `scope`
 * depends on, and name the result: a key that changes whenever a verdict
 * could. A gate that fails to settle is logged and keyed as failed (a later
 * success changes the key); its skills keep the verdicts it last learned.
 */
export async function builtInSkillAvailabilityKey(scope: {
  platform?: PlatformKind
}): Promise<string> {
  await loadModuleBuiltInSkills()
  const parts = await Promise.all(
    gates.map(async ({ module, gate }) => {
      try {
        const key = await gate.settle(scope)
        return key === null ? null : `${module}=${key}`
      } catch (error) {
        loggers.app.error("built-in skill availability gate failed to settle", {
          module,
          error: String(error),
        })
        return `${module}=failed`
      }
    })
  )
  const settled = parts.filter((part): part is string => part !== null)
  return settled.length > 0 ? settled.join(";") : "not-applicable"
}

/** Replace the registry the loader reads, and forget what it loaded. */
export function __setModuleBuiltInSkillsForTesting(
  next: readonly ModuleBuiltinSkillsEntry[] | null
): void {
  entries = next ?? MODULE_BUILTIN_SKILLS
  loaded.clear()
  gates = []
  pending = null
}

/**
 * Built-in skill tier — public surface (ADR-0026).
 *
 * Importing this module registers the kernel's own families through the
 * side-effect imports below and starts loading the families feature modules
 * contribute through their manifests (`builtinSkills`, ADR-0250 §14: the IM
 * and Lark families are the connectors module's). Every reader of the
 * registry awaits `whenBuiltInSkillsRegistered()` before it lists or runs a
 * skill, so a module's family is never missing from a manifest or a call.
 *
 * A kernel family lives under `lib/skills/built-in/<family>/` and is
 * imported here; a module's family is its manifest's `builtinSkills`.
 */

// Re-exports — the only entry points consumers should use.
export {
  registerBuiltInSkill,
  getSharedBuiltInSkillRegistry,
  createBuiltInSkillRegistry,
  __resetSharedBuiltInSkillRegistry,
} from "./registry"
export type { BuiltInSkillRegistry } from "./registry"
export type {
  BuiltInSkill,
  BuiltInSkillContext,
  BuiltInSkillImAccess,
  BuiltInSkillMutation,
  BuiltInSkillResult,
  BilingualString,
  PlatformSkillCapability,
} from "./types"
export {
  buildBuiltInSkillManifest,
  summariseSkillCapabilities,
  BUILTIN_SKILLS_PLUGIN_ID,
} from "./manifest"
export type { BuildBuiltInSkillManifestInput, BuiltInSkillManifestEntry } from "./manifest"
export { runBuiltInSkill } from "./dispatcher"
import { loadModuleBuiltInSkills } from "./module-skills"

/**
 * Resolves once every family is registered: the kernel's (imported below,
 * so already) and every module's `builtinSkills` contribution.
 */
export function whenBuiltInSkillsRegistered(): Promise<void> {
  return loadModuleBuiltInSkills()
}

// ---- Module-load registration side-effects --------------------------------
//
// Each per-family module calls `registerBuiltInSkill()` at module load.
// Add new kernel families here as they ship. Order is irrelevant — the
// registry is map-backed. A module's families load from its manifest, started
// here so they register about as early as these do.
void loadModuleBuiltInSkills()

// Desktop-only, workspace-confined plugin conversion tools.
import "./plugin-conversion"
// Issue tracker (ADR-0132): read and work the board, its containers and its
// runs. Every write goes through the board's own capability and run guards.
import "./issues"
// Scheduler: read, author and amend the user's own schedule. Gated on the
// user's SchedulerPermissionPolicy as well as the dispatcher's HITL card.
import "./scheduler"

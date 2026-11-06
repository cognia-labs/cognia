/**
 * The only imports a feature module manifest may have (ADR-0250 §14).
 *
 * Both helpers return their argument unchanged. They exist so a manifest is
 * type-checked against the schema in `./manifest-types` and so the module
 * gate can recognise a manifest by the call it exports.
 */

import type { HostModuleManifest, UiModuleManifest } from "./manifest-types"

export type {
  BrainRuntimeAdapter,
  HostModuleManifest,
  LazyModule,
  ModuleAcceptance,
  ModuleComponentModule,
  ModuleContribution,
  ModuleEffect,
  ModuleFlag,
  ModuleHost,
  ModuleKind,
  ModuleNavEntry,
  ModulePortModule,
  ModulePortProvision,
  ModuleRuntime,
  ModuleRuntimeBoot,
  ModuleSearchProvidersModule,
  ModuleSettingsSection,
  ModuleSettingsSectionModule,
  ModuleSlotProps,
  ModuleSlashCommand,
  ModuleSlashCommandModule,
  ModuleStage,
  RendererRuntimeAdapter,
  RendererRuntimeContext,
  UiModuleManifest,
} from "./manifest-types"

/** Declare a module's host layer in `lib/<id>/module.ts`. */
export function defineHostModule<const M extends HostModuleManifest>(manifest: M): M {
  return manifest
}

/** Declare a module's UI layer in `components/<id>/module.ui.ts`. */
export function defineUiModule<const M extends UiModuleManifest>(manifest: M): M {
  return manifest
}

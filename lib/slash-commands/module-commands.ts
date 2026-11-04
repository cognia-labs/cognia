// Slash commands that feature modules contribute (ADR-0250 §14).
//
// A module lists its commands in `lib/<id>/module.ts` as data: name,
// description, argument hints and a lazy `load` for the handler. They join
// `BUILTIN_SLASH_COMMANDS` as `builtin` scope commands, so every surface that
// lists or runs built-ins (composer, `/help`, Settings, `/me/slash-commands`)
// sees them without a hand-written entry. The handler module loads only when
// the command runs.

import type { SlashCommand } from "@cognia/plugin-contract/lib/slash-commands/builtin"
import type { HostModuleManifest } from "@/lib/modules/manifest-types"
import { activeHostModules } from "@/lib/modules/registry"

/** The commands every active module contributes, in module id order. */
export function moduleSlashCommands(
  modules: readonly HostModuleManifest[] = activeHostModules()
): SlashCommand[] {
  return modules.flatMap((manifest) =>
    (manifest.slashCommands ?? []).map((entry): SlashCommand => ({
      name: entry.name,
      description: entry.description,
      scope: "builtin",
      category: entry.category,
      argumentHint: entry.argumentHint,
      argumentOptions: entry.argumentOptions ? [...entry.argumentOptions] : undefined,
      handler: async (ctx) => {
        const { run } = await entry.load()
        await run(ctx)
      },
    }))
  )
}
